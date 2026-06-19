import { Router, type Request } from "express";
import type { PrEntity, PrThreadState, TaskStore } from "@fusion/core";
import {
  isPrEntityActive,
  isPrEntityActionable,
  isPrEntityAutoMergeReady,
  autoMergeGateReason,
  summarizePrThreadActivity,
} from "@fusion/core";
import { badRequest, notFound, ApiError } from "../api-error.js";

/**
 * Injected engine capabilities for the user-controlled PR actions (U7, R13).
 *
 * Each action maps to a manual hold-release (the workflow's user-controlled
 * release edges own the real GitHub side effects): approve/merge/retry/close all
 * fire the same release authority the scheduler's hold-release sweep uses. The
 * router never imports the engine directly (FN-3049) — capabilities arrive as
 * option callbacks wired in register-integrated-routers.ts. When a capability is
 * omitted the corresponding action 400s ("unavailable") rather than no-op'ing
 * silently.
 *
 * All side-effecting callbacks receive the AUTHORITATIVE entity the route just
 * re-read from the store — never a client-supplied copy. Acting on a stale
 * client copy is the bug class documented in
 * docs/solutions/logic-errors/queued-chat-message-flush-trusts-stale-isgenerating.md.
 */
export interface PullRequestsRouterOptions {
  /** Release the PR's source task to advance toward merge (approve / force-merge). */
  approvePr?: (input: { entity: PrEntity; projectId?: string }) => Promise<Record<string, unknown>>;
  /** Merge the PR via the workflow's merge release (force-merge). */
  mergePr?: (input: { entity: PrEntity; projectId?: string }) => Promise<Record<string, unknown>>;
  /** Request another review-response round (rework release). */
  retryPr?: (input: { entity: PrEntity; projectId?: string }) => Promise<Record<string, unknown>>;
  /** Close the PR terminally and reconcile the entity. */
  closePr?: (input: { entity: PrEntity; projectId?: string }) => Promise<Record<string, unknown>>;
  /** Retry a failed PR creation (state === "failed", R4). */
  retryCreate?: (input: { entity: PrEntity; projectId?: string }) => Promise<Record<string, unknown>>;
}

function parseProjectId(req: Request): string | undefined {
  const value = req.query.projectId ?? req.body?.projectId;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

// `autoMergeGateReason` is the single R13-shared definition in @fusion/core
// (consumed here and by the `fn pr` CLI); re-exported so existing dashboard
// importers keep working.
export { autoMergeGateReason };

/** Whether the entity is in a hard conflict (Merge must be disabled, R11). */
export function isPrConflicting(entity: PrEntity): boolean {
  return entity.mergeable === "conflicting";
}

/** Structured rejection message for the R16 column-move-backward block. */
export const PR_OPEN_BLOCKS_MOVE_BACK_MESSAGE =
  "This task has an open PR. Merge or close the PR before moving it back.";

/**
 * R16: should a column move be blocked because the task has an open PR?
 *
 * A "backward" move (lower column index) of a task that still has an ACTIVE
 * (non-terminal) PR entity is rejected — the PR's lifecycle is workflow-owned and
 * dragging the card back would orphan the open GitHub PR. Forward moves and moves
 * of tasks whose PR is terminal (merged/closed/failed → no active entity) pass.
 *
 * Pure so the move route and tests consult one definition.
 */
export function isBackwardMoveBlockedByOpenPr(input: {
  fromIndex: number;
  toIndex: number;
  activePrEntity: Pick<PrEntity, "state"> | null | undefined;
}): boolean {
  const { fromIndex, toIndex, activePrEntity } = input;
  if (fromIndex < 0 || toIndex < 0) return false;
  if (toIndex >= fromIndex) return false; // not backward
  return Boolean(activePrEntity && isPrEntityActive(activePrEntity));
}

/**
 * Build the merge-readiness summary the view renders above the checks list.
 * Pure derivation from authoritative entity state.
 */
export function buildPrSummary(entity: PrEntity, threads: PrThreadState[]) {
  // U18 (R15): single-source the Review-response activity counts from @fusion/core
  // so the dashboard, the CLI, and the Command Center never derive divergent numbers.
  const activity = summarizePrThreadActivity(threads);
  return {
    mergeable: entity.mergeable ?? "unknown",
    reviewDecision: entity.reviewDecision ?? null,
    checksRollup: entity.checksRollup ?? "none",
    conflicting: isPrConflicting(entity),
    autoMerge: entity.autoMerge,
    autoMergeReason: autoMergeGateReason(entity),
    autoMergeReady: isPrEntityAutoMergeReady(entity),
    actionable: isPrEntityActionable(entity),
    active: isPrEntityActive(entity),
    pendingThreads: activity.pending,
    disagreedThreads: activity.disagreed,
    // U18: threads the loop fixed, and the total it acted on (fixed + disagreed),
    // exposed so the Command Center / Mission Control can read resolution activity.
    fixedThreads: activity.fixed,
    actedThreads: activity.acted,
  };
}

function serializePr(entity: PrEntity, threads: PrThreadState[]) {
  return {
    ...entity,
    threads,
    summary: buildPrSummary(entity, threads),
  };
}

export function createPullRequestsRouter(store: TaskStore, options?: PullRequestsRouterOptions): Router {
  const router = Router();

  // GET /api/pull-requests — list active entities, optional repo/status filter.
  router.get("/", async (_req, res) => {
    const repoRaw = _req.query.repo;
    const statusRaw = _req.query.status;
    const repo = typeof repoRaw === "string" && repoRaw.trim() ? repoRaw.trim() : undefined;
    const status = typeof statusRaw === "string" && statusRaw.trim() ? statusRaw.trim() : undefined;
    if (
      status &&
      !["creating", "open", "responding", "merged", "closed", "failed"].includes(status)
    ) {
      throw badRequest(
        "status must be one of: creating, open, responding, merged, closed, failed",
      );
    }

    let entities = store.listActivePrEntities();
    if (repo) entities = entities.filter((e) => e.repo === repo);
    if (status) entities = entities.filter((e) => e.state === status);

    const pullRequests = entities.map((entity) =>
      serializePr(entity, store.listPrThreadStates(entity.id)),
    );
    res.json({ pullRequests });
  });

  // GET /api/pull-requests/:id — entity + thread states + checks/merge/conflict summary.
  router.get("/:id", async (req, res) => {
    const id = String(req.params.id ?? "").trim();
    if (!id) throw badRequest("id is required");
    const entity = store.getPrEntity(id);
    if (!entity) throw notFound("PR entity not found");
    res.json({ pullRequest: serializePr(entity, store.listPrThreadStates(id)) });
  });

  /**
   * Shared action handler: re-read the AUTHORITATIVE entity (never trust a client
   * copy), gate it, then dispatch to the injected capability. Returns the freshly
   * re-read serialized entity so the client replaces its stale copy.
   */
  function makeAction(
    name: string,
    capability: ((input: { entity: PrEntity; projectId?: string }) => Promise<Record<string, unknown>>) | undefined,
    opts: { requireActive?: boolean; requireState?: PrEntity["state"]; rejectConflict?: boolean } = {},
  ) {
    return async (req: Request, res: import("express").Response) => {
      const id = String(req.params.id ?? "").trim();
      if (!id) throw badRequest("id is required");

      // Re-fetch authoritative state — the side effect must never gate on a
      // stale client/SSE-delivered copy.
      const entity = store.getPrEntity(id);
      if (!entity) throw notFound("PR entity not found");

      if (opts.requireState && entity.state !== opts.requireState) {
        throw new ApiError(409, `PR is not in '${opts.requireState}' state`, {
          code: "pr-wrong-state",
          retryable: false,
        });
      }
      if (opts.requireActive && !isPrEntityActive(entity)) {
        throw new ApiError(409, "PR is already terminal (merged/closed/failed)", {
          code: "pr-terminal",
          retryable: false,
        });
      }
      if (opts.rejectConflict && isPrConflicting(entity)) {
        throw new ApiError(409, "Resolve conflicts on GitHub before merging", {
          code: "pr-conflict",
          retryable: false,
        });
      }

      if (!capability) {
        throw badRequest(`${name} is unavailable`);
      }

      const result = await capability({ entity, projectId: parseProjectId(req) });
      // Re-read after the action so the response reflects authoritative state.
      const fresh = store.getPrEntity(id) ?? entity;
      res.json({
        ...result,
        pullRequest: serializePr(fresh, store.listPrThreadStates(id)),
      });
    };
  }

  router.post("/:id/approve", makeAction("Approve", options?.approvePr, { requireActive: true }));
  router.post(
    "/:id/merge",
    makeAction("Merge", options?.mergePr, { requireActive: true, rejectConflict: true }),
  );
  router.post("/:id/retry", makeAction("Retry", options?.retryPr, { requireActive: true }));
  router.post("/:id/close", makeAction("Close", options?.closePr, { requireActive: true }));
  router.post(
    "/:id/retry-create",
    makeAction("Retry PR creation", options?.retryCreate, { requireState: "failed" }),
  );

  // Toggle auto-merge. Re-reads authoritative state then persists the flip.
  router.post("/:id/automerge", async (req, res) => {
    const id = String(req.params.id ?? "").trim();
    if (!id) throw badRequest("id is required");
    const entity = store.getPrEntity(id);
    if (!entity) throw notFound("PR entity not found");
    if (!isPrEntityActive(entity)) {
      throw new ApiError(409, "PR is already terminal (merged/closed/failed)", {
        code: "pr-terminal",
        retryable: false,
      });
    }
    const enabled =
      typeof req.body?.enabled === "boolean" ? req.body.enabled : !entity.autoMerge;
    const updated = store.updatePrEntity(id, { autoMerge: enabled });
    res.json({ pullRequest: serializePr(updated, store.listPrThreadStates(id)) });
  });

  return router;
}
