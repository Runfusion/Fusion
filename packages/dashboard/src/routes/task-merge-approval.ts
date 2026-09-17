/*
FNXC:HumanMergeApproval 2026-09-17-18:09:
FN-514 — operator surface for the per-card delivery lock, mounted as a sub-registration of the task
workflow registrar so it inherits the existing project resolution and operator authentication.

Three endpoints, and exactly one authority rule: THE SERVER decides. The client sends a single
explicit command plus optimistic preconditions; it never sends `decidedBy`, a delivery target, an
approval object, or a second contradictory destination. The destination is DERIVED from the action,
capabilities are resolved server-side, and an action the server cannot carry out is refused even if
the client enabled its button.

  GET  /tasks/:id/merge-approval            availability, candidate token, per-action capabilities
  PUT  /tasks/:id/merge-approval            { enabled, requestId, expectedRevision }
  POST /tasks/:id/merge-approval/decision   { action, message, requestId, expectedRevision, candidateToken }

No model call, push, or provider request happens inside the HTTP transaction: the decision and its
destination INTENT are persisted first, and the graph owner processes them afterwards. That ordering
is what makes a crash between "decided" and "dispatched" recoverable from the durable row alone.
*/

import { randomUUID } from "node:crypto";

import {
  HumanMergeApprovalMessageError,
  parseHumanMergeDecisionAction,
  sanitizeHumanMergeInstruction,
  sanitizeHumanMergeNote,
  type HumanMergeDecisionAction,
  type Task,
} from "@fusion/core";
import { resolveHumanMergeDecisionPoint, type HumanMergeDecisionPointDeps } from "@fusion/engine";

import { badRequest, conflict, notFound } from "../api-error.js";
import type { ApiRoutesContext } from "./types.js";

export interface TaskMergeApprovalRouteDeps {
  /** Injected GitHub capability probe — the engine never imports the dashboard's GitHub surface. */
  isGithubAuthenticated: () => boolean | Promise<boolean>;
  /*
  Resolves the delivery remote for the PROJECT the request resolved to, never a process-wide default:
  a request scoped to project B must not inherit project A's remote as a capability.
  */
  resolveRemote?: (task: Parameters<NonNullable<HumanMergeDecisionPointDeps["resolveRemote"]>>[0], rootDir: string) => string | undefined | Promise<string | undefined>;
  resolveHeadBranch?: HumanMergeDecisionPointDeps["resolveHeadBranch"];
  /** Injectable content-capture seam; production omits it and uses the real Git probe. */
  captureContent?: HumanMergeDecisionPointDeps["captureContent"];
  /** Wakes the graph owner after a decision is durably persisted. Best-effort. */
  onDecisionPersisted?: (task: Task, action: HumanMergeDecisionAction) => void | Promise<void>;
}

/** The single operator identity recorded on a dashboard decision. Never client-supplied. */
const DASHBOARD_OPERATOR = "dashboard-operator";

function readString(raw: Record<string, unknown>, key: string): string | undefined {
  const value = raw[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw badRequest(`${key} must be a string`);
  return value;
}

/** Map a typed store refusal onto its HTTP status. Nothing here invents an outcome. */
function refusalToError(reason: string, detail?: string): Error {
  switch (reason) {
    case "task-missing":
    case "task-deleted":
      return notFound("Task not found");
    case "unavailable":
      return conflict("The task backend is unavailable — retry in a moment");
    case "revision-mismatch":
      return conflict("This task changed since the page was loaded — reload and decide again");
    case "merge-taken":
      return conflict("A merge of this task has already started and can no longer be changed");
    case "terminal":
      return conflict("This task is already complete");
    case "candidate-superseded":
      return conflict(detail ?? "The reviewed content changed since this decision was opened — reload and decide again");
    case "request-conflict":
      return conflict(detail ?? "This decision request was already resolved differently");
    case "not-armed":
      return conflict("This task does not require a delivery decision");
    default:
      return conflict(detail ?? "The decision could not be recorded");
  }
}

export function registerTaskMergeApprovalRoutes(
  ctx: ApiRoutesContext,
  deps: TaskMergeApprovalRouteDeps,
): void {
  const { router, getProjectContext, rethrowAsApiError } = ctx;

  const decisionPointDepsFor = async (store: unknown): Promise<HumanMergeDecisionPointDeps> => {
    const scoped = store as HumanMergeDecisionPointDeps["store"];
    const rootDir = scoped.getRootDir();
    return {
      store: scoped,
      workspaceRootDir: rootDir,
      settings: (await (store as { getSettings: () => Promise<Record<string, unknown>> }).getSettings()) ?? {},
      isGithubAuthenticated: deps.isGithubAuthenticated,
      ...(deps.resolveRemote ? { resolveRemote: (task) => deps.resolveRemote!(task, rootDir) } : {}),
      resolveHeadBranch: deps.resolveHeadBranch,
      ...(deps.captureContent ? { captureContent: deps.captureContent } : {}),
    };
  };

  /*
  A pure READ. It never records a decision and never presets one: each button names its own command,
  so no destination pre-selection is needed or offered.
  */
  router.get("/tasks/:id/merge-approval", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const task = await scopedStore.getTask(req.params.id);
      if (!task) throw notFound("Task not found");
      const point = await resolveHumanMergeDecisionPoint(task, await decisionPointDepsFor(scopedStore));
      res.json(point);
    } catch (err) {
      rethrowAsApiError(err);
    }
  });

  /*
  Arm / disarm. The store mutation performs the take test INSIDE its own transaction, so a merge that
  has already begun refuses here with 409 having changed nothing, and a lock that commits first is
  necessarily observed by the owner's re-read under the same advisory lock.
  */
  router.put("/tasks/:id/merge-approval", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const raw = (req.body ?? {}) as Record<string, unknown>;
      if (typeof raw.enabled !== "boolean") throw badRequest("enabled must be a boolean");
      const expectedRevision = readString(raw, "expectedRevision");
      const requestId = readString(raw, "requestId")?.trim() || randomUUID();

      const outcome = await scopedStore.setHumanMergeApprovalLock(req.params.id, {
        enabled: raw.enabled,
        requestId,
        ...(expectedRevision ? { expectedRevision } : {}),
        actor: DASHBOARD_OPERATOR,
      });
      if (!outcome.applied) throw refusalToError(outcome.reason, outcome.detail);
      res.json({ task: outcome.task, replayed: outcome.replayed });
    } catch (err) {
      rethrowAsApiError(err);
    }
  });

  /*
  ONE explicit command. The action is narrowed to the three legal values, the message is validated by
  family (optional note for a positive action, MANDATORY instruction for a rejection), and the server
  re-resolves the decision point so a client-enabled button for an action the server cannot carry out
  is still refused.
  */
  router.post("/tasks/:id/merge-approval/decision", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const raw = (req.body ?? {}) as Record<string, unknown>;

      let action: HumanMergeDecisionAction;
      try {
        action = parseHumanMergeDecisionAction(raw.action);
      } catch (error) {
        throw badRequest(error instanceof Error ? error.message : "invalid action");
      }
      /*
      A generic approval object, a caller-supplied identity, or a second destination are not inputs.
      Refusing them explicitly is cheaper than silently ignoring a field an integration believes in.
      */
      for (const forbidden of ["decidedBy", "deliveryAction", "candidate", "decision", "approval", "target"]) {
        if (raw[forbidden] !== undefined) throw badRequest(`${forbidden} is derived by the server and must not be sent`);
      }

      let message: string | undefined;
      try {
        message = action === "reject"
          ? sanitizeHumanMergeInstruction(raw.message)
          : sanitizeHumanMergeNote(raw.message);
      } catch (error) {
        if (error instanceof HumanMergeApprovalMessageError) throw badRequest(error.message);
        throw error;
      }

      const expectedRevision = readString(raw, "expectedRevision");
      const candidateToken = readString(raw, "candidateToken")?.trim();
      if (!candidateToken) throw badRequest("candidateToken is required");
      const requestId = readString(raw, "requestId")?.trim() || randomUUID();

      const task = await scopedStore.getTask(req.params.id);
      if (!task) throw notFound("Task not found");

      /*
      Re-resolve server-side. This is the authority for BOTH the candidate identity (the client's
      token is only an echo used to detect a stale tab) and the per-action capability.
      */
      const point = await resolveHumanMergeDecisionPoint(task, await decisionPointDepsFor(scopedStore));
      if (!point.candidate || !point.candidateToken) {
        throw conflict(
          point.unavailableReason === "blocked" && point.blocker
            ? `This task is not ready for a delivery decision: ${point.blocker}`
            : "This task is not ready for a delivery decision",
        );
      }
      const capability = point.capabilities.find((entry) => entry.action === action);
      if (capability && !capability.enabled && capability.reason !== "already-decided") {
        throw conflict(`This action is not available for this task (${capability.reason})`);
      }

      const outcome = await scopedStore.recordHumanMergeDecision(req.params.id, {
        action,
        ...(message !== undefined ? { message } : {}),
        requestId,
        ...(expectedRevision ? { expectedRevision } : {}),
        candidateToken,
        candidate: point.candidate,
        actor: DASHBOARD_OPERATOR,
      });
      if (!outcome.applied) throw refusalToError(outcome.reason, outcome.detail);

      /*
      The wake-up happens AFTER the commit and is best-effort: a failure here leaves a durable,
      recoverable intent rather than a lost decision.
      */
      if (!outcome.replayed) {
        try {
          await deps.onDecisionPersisted?.(outcome.task, action);
        } catch {
          // Recovery owns the re-dispatch; the decision itself is already durable.
        }
      }
      res.json({ task: outcome.task, action, replayed: outcome.replayed });
    } catch (err) {
      rethrowAsApiError(err);
    }
  });
}
