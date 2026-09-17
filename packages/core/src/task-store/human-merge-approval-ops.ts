/*
FNXC:HumanMergeApproval 2026-09-17-18:09:
FN-514 — durable operator mutations for the per-card delivery lock.

Every mutation here is ONE decision over the live row: read, validate and write run inside a single
`transactionImmediate` holding the project-scoped task advisory lock, which is the SAME short
primitive every delivery door re-takes before it advances a ref (see
`engine/src/merge/human-merge-approval.ts`). That shared primitive is what orders the two races the
spec names:

  • LOCK WINS  — the mutation commits first, so a queued/leased merge owner re-reads under the same
                 lock and defers without burning a retry budget.
  • MERGE WINS — the owner has already taken the card, so the mutation observes the taken state and
                 returns a conflict having changed nothing.

A pre-read followed by a separate `updateTask` would leave a window between the two, so no path in
this module does that. The compute work is synchronous and performs no nested store calls: the
transaction owns a non-reentrant lock, and the model, push and provider calls happen OUTSIDE it
(the graph owner processes the persisted intent afterwards).
*/

import { and, eq, isNull } from "drizzle-orm";

import { toJson } from "../db/db.js";
import * as schema from "../postgres/schema/index.js";
import { acquireTaskAdvisoryXactLock } from "./task-advisory-lock.js";
import { readTaskRowInTransaction } from "./async/async-persistence.js";
import { getTaskActivityLogEntryLimit } from "./comments.js";
import type { TaskStore } from "../store.js";
import type { Task, TaskLogEntry } from "../types.js";
import {
  clearHumanMergeApprovalDecision,
  encodeHumanMergeCandidateToken,
  isValidHumanMergeCandidate,
  nextHumanMergeRemediationGeneration,
  resolvePendingHumanMergeRejection,
  toggleHumanMergeApprovalState,
  type HumanMergeApprovalState,
  type HumanMergeCandidateIdentity,
  type HumanMergeDecisionAction,
  type HumanMergeDecisionReceipt,
  type HumanMergeDeliveryAction,
} from "../merge/human-merge-approval.js";

/** Why a mutation refused. Each maps to exactly one HTTP status at the route boundary. */
export type HumanMergeMutationRefusal =
  | "unavailable"
  | "task-missing"
  | "task-deleted"
  | "revision-mismatch"
  | "merge-taken"
  | "terminal"
  | "candidate-superseded"
  | "request-conflict"
  | "not-armed";

export type HumanMergeMutationResult =
  | { applied: true; task: Task; replayed: boolean }
  | { applied: false; reason: HumanMergeMutationRefusal; detail?: string };

/*
FNXC:HumanMergeApproval 2026-09-17-18:09:
"A merge owner has TAKEN this card" — the single definition shared by the lock mutation and the
decision mutation. Merely sitting in a merge queue is NOT a take (the spec is explicit: a queued card
must still be lockable); an owner in one of these states has already begun, or provably completed,
delivery.

`mergeConfirmed` is included because a landed branch cannot be un-landed by a button, and the
workspace partial-land state is included because some repositories are already published.
*/
const MERGE_TAKEN_STATUSES: ReadonlySet<string> = new Set(["merging", "merging-pr", "merging-fix"]);

export interface HumanMergeTakenEvidence {
  /** Columns whose workflow trait marks them terminal (Complete). Resolved by the caller. */
  terminalColumns?: ReadonlySet<string>;
  /** True when an in-process or durable merge lease is held for this task right now. */
  mergeLeaseHeld?: boolean;
}

export function describeHumanMergeTaken(
  task: Task,
  evidence: HumanMergeTakenEvidence = {},
): HumanMergeMutationRefusal | undefined {
  if (task.mergeDetails?.mergeConfirmed === true) return "merge-taken";
  if (typeof task.status === "string" && MERGE_TAKEN_STATUSES.has(task.status)) return "merge-taken";
  if (evidence.mergeLeaseHeld === true) return "merge-taken";
  /*
  A workspace card whose first repository has already landed is mid-delivery: the remaining
  repositories are a continuation of an act that started, not a fresh decision point.
  */
  const worktrees = task.workspaceWorktrees ?? {};
  const landed = Object.values(worktrees).filter((entry) => (entry as { landedAt?: string })?.landedAt);
  if (landed.length > 0 && landed.length < Object.keys(worktrees).length) return "merge-taken";
  if (evidence.terminalColumns?.has(task.column)) return "terminal";
  if (evidence.terminalColumns === undefined && task.column === "done") return "terminal";
  return undefined;
}

function appendLog(current: Task, entry: TaskLogEntry): TaskLogEntry[] {
  const log = [...(current.log ?? []), entry];
  const limit = getTaskActivityLogEntryLimit();
  if (log.length > limit) log.splice(0, log.length - limit);
  return log;
}

/*
Shared advisory-locked writer. `compute` is synchronous and pure, runs with the transaction open, and
returns either the field-bounded patch or a typed refusal.
*/
async function withHumanMergeApprovalTransaction(
  store: TaskStore,
  id: string,
  compute: (current: Task) => { state: HumanMergeApprovalState | null; logEntry: TaskLogEntry; replayed?: boolean }
    | { refusal: HumanMergeMutationRefusal; detail?: string }
    | { replayOnly: true },
): Promise<HumanMergeMutationResult> {
  const layer = store.asyncLayer;
  if (!layer) return { applied: false, reason: "unavailable" };

  return store.withTaskLock(id, async () => {
    const outcome = await layer.transactionImmediate(async (tx): Promise<HumanMergeMutationResult> => {
      await acquireTaskAdvisoryXactLock(tx, layer.projectId, id);
      const row = await readTaskRowInTransaction(tx, id, { includeDeleted: true }, layer.projectId);
      if (!row) return { applied: false, reason: "task-missing" };
      if (row.deletedAt) return { applied: false, reason: "task-deleted" };

      const current = store.rowToTask(store.pgRowToTaskRow(row));
      const computed = compute(current);
      if ("refusal" in computed) return { applied: false, reason: computed.refusal, detail: computed.detail };
      if ("replayOnly" in computed) return { applied: true, task: current, replayed: true };

      const [updatedRow] = await tx.update(schema.project.tasks).set({
        humanMergeApproval: computed.state === null ? null : toJson(computed.state),
        log: toJson(appendLog(current, computed.logEntry)),
        updatedAt: new Date().toISOString(),
      }).where(and(
        eq(schema.project.tasks.id, id),
        eq(schema.project.tasks.projectId, layer.projectId ?? schema.project.tasks.projectId),
        isNull(schema.project.tasks.deletedAt),
      )).returning();
      if (!updatedRow) return { applied: false, reason: "task-missing" };
      return {
        applied: true,
        task: store.rowToTask(store.pgRowToTaskRow(updatedRow)),
        replayed: computed.replayed === true,
      };
    });

    /*
    Projections are published only AFTER the transaction commits, so no observer can see a wake-up
    for a decision that did not persist.
    */
    if (outcome.applied && !outcome.replayed) {
      await store.writeTaskJsonFile(store.taskDir(id), outcome.task);
      if (store.isWatching) store.taskCache.set(id, { ...outcome.task });
      store.emitTaskLifecycleEventSafely("task:updated", [outcome.task]);
    }
    return outcome;
  });
}

export interface SetHumanMergeApprovalLockInput {
  enabled: boolean;
  requestId: string;
  /** `task.updatedAt` the client last saw. Omitted means "no optimistic precondition". */
  expectedRevision?: string;
  actor: string;
  evidence?: HumanMergeTakenEvidence;
}

/*
FNXC:HumanMergeApproval 2026-09-17-18:09:
Arm/disarm the lock. The take test lives INSIDE the same transaction as the write, which is what
makes the two orderings total: an owner that has begun delivery yields `merge-taken` (409) and this
mutation changes nothing, while a mutation that commits first is necessarily seen by the owner's own
re-read under the same advisory lock.

Note the take test runs even for a card that is NOT currently locked: otherwise a lock could be added
in the window between the owner claiming the card and its first `merging` status landing.
*/
export async function setHumanMergeApprovalLockImpl(
  store: TaskStore,
  id: string,
  input: SetHumanMergeApprovalLockInput,
): Promise<HumanMergeMutationResult> {
  return withHumanMergeApprovalTransaction(store, id, (current) => {
    if (input.expectedRevision !== undefined && input.expectedRevision !== current.updatedAt) {
      return { refusal: "revision-mismatch" as const };
    }
    const taken = describeHumanMergeTaken(current, input.evidence);
    if (taken) return { refusal: taken };

    const state = current.humanMergeApproval;
    // Idempotent replay: already in the requested position, nothing to change.
    if ((state?.enabled === true) === input.enabled) return { replayOnly: true as const };

    const next = toggleHumanMergeApprovalState(state, input.enabled);
    return {
      state: next,
      logEntry: {
        timestamp: new Date().toISOString(),
        action: input.enabled ? "Delivery lock enabled" : "Delivery lock removed",
        outcome: input.enabled
          ? `${input.actor} requires an explicit delivery decision before this task is merged`
          : `${input.actor} removed the delivery requirement; any accepted rejection still stands`,
      },
    };
  });
}

export interface RecordHumanMergeDecisionInput {
  action: HumanMergeDecisionAction;
  /** Optional for positive actions; mandatory and pre-validated for `reject`. */
  message?: string;
  requestId: string;
  expectedRevision?: string;
  /** Token of the candidate the operator was shown. */
  candidateToken: string;
  /** Server-derived candidate; the client never supplies its fields. */
  candidate: HumanMergeCandidateIdentity;
  actor: string;
  evidence?: HumanMergeTakenEvidence;
}

/*
FNXC:HumanMergeApproval 2026-09-17-18:09:
Record ONE explicit operator command. Ordering inside the transaction is deliberate:

 1. optimistic revision precondition — a stale tab never decides;
 2. the shared take test — a started delivery refuses without side effects;
 3. idempotent replay — the same requestId with the same action AND the same candidate returns the
    stored receipt, even after its processing began;
 4. conflict — the same requestId with a different action or candidate, or a decision whose presented
    candidate no longer matches the live one, is refused rather than silently re-decided.

`deliveryAction` is DERIVED here from the action; the client cannot send a second contradictory
destination, and a rejection carries none at all.
*/
export async function recordHumanMergeDecisionImpl(
  store: TaskStore,
  id: string,
  input: RecordHumanMergeDecisionInput,
): Promise<HumanMergeMutationResult> {
  return withHumanMergeApprovalTransaction(store, id, (current) => {
    if (input.expectedRevision !== undefined && input.expectedRevision !== current.updatedAt) {
      return { refusal: "revision-mismatch" as const };
    }
    const taken = describeHumanMergeTaken(current, input.evidence);
    if (taken) return { refusal: taken };

    const state = current.humanMergeApproval;
    if (state?.enabled !== true) return { refusal: "not-armed" as const };
    if (!isValidHumanMergeCandidate(input.candidate)) {
      return { refusal: "candidate-superseded" as const, detail: "candidate identity is incomplete" };
    }
    if (encodeHumanMergeCandidateToken(input.candidate) !== input.candidateToken) {
      return { refusal: "candidate-superseded" as const };
    }
    if (input.candidate.lockGeneration !== (state.generation ?? 0)) {
      return { refusal: "candidate-superseded" as const };
    }

    const now = new Date().toISOString();

    // --- Idempotent replay / request conflict, across BOTH decision families. ---
    const priorDecision = state.decision;
    if (priorDecision?.requestId === input.requestId) {
      if (priorDecision.action !== input.action
        || encodeHumanMergeCandidateToken(priorDecision.candidate) !== input.candidateToken) {
        return { refusal: "request-conflict" as const };
      }
      return { replayOnly: true as const };
    }
    const priorRejection = state.rejection;
    if (priorRejection?.requestId === input.requestId) {
      if (input.action !== "reject"
        || encodeHumanMergeCandidateToken(priorRejection.candidate) !== input.candidateToken) {
        return { refusal: "request-conflict" as const };
      }
      return { replayOnly: true as const };
    }

    /*
    A pending rejection is a correction obligation, so no second command may be accepted against the
    candidate it refused: the work must change first.
    */
    const pendingRejection = resolvePendingHumanMergeRejection(current);
    if (pendingRejection) return { refusal: "request-conflict" as const, detail: "a rejection is already being processed" };

    /*
    A different concurrent command already resolved this candidate. Overwriting it would let a second
    operator silently redirect a destination that may already have produced an external effect.
    */
    if (priorDecision && encodeHumanMergeCandidateToken(priorDecision.candidate) === input.candidateToken) {
      return { refusal: "request-conflict" as const, detail: "this candidate was already decided" };
    }

    if (input.action === "reject") {
      const remediationGeneration = nextHumanMergeRemediationGeneration(state);
      return {
        state: {
          enabled: true,
          generation: state.generation,
          remediationGeneration,
          rejection: {
            requestId: input.requestId,
            instruction: input.message ?? "",
            rejectedBy: input.actor,
            rejectedAt: now,
            candidate: input.candidate,
            remediationGeneration,
            state: "pending",
          },
        },
        logEntry: {
          timestamp: now,
          action: "Delivery rejected by operator",
          outcome: `${input.actor} refused this delivery and requested corrections`,
        },
      };
    }

    const deliveryAction: HumanMergeDeliveryAction = input.action;
    const receipt: HumanMergeDecisionReceipt = { state: "pending", at: now };
    return {
      state: {
        enabled: true,
        generation: state.generation,
        ...(state.remediationGeneration !== undefined ? { remediationGeneration: state.remediationGeneration } : {}),
        decision: {
          requestId: input.requestId,
          action: input.action,
          deliveryAction,
          ...(input.message ? { message: input.message } : {}),
          decidedBy: input.actor,
          decidedAt: now,
          candidate: input.candidate,
          receipt,
        },
      },
      logEntry: {
        timestamp: now,
        action: deliveryAction === "merge" ? "Delivery approved for merge" : "Delivery approved for pull request",
        outcome: deliveryAction === "merge"
          ? `${input.actor} commanded a merge of the reviewed content`
          : `${input.actor} commanded a pull request without merging`,
      },
    };
  });
}

export interface UpdateHumanMergeReceiptInput {
  /** Fences the write to the decision that requested it; a superseded one is refused. */
  requestId: string;
  receipt: HumanMergeDecisionReceipt;
  logEntry?: TaskLogEntry;
}

/*
FNXC:HumanMergeApproval 2026-09-17-18:09:
Record the DESTINATION dispatch outcome (created PR link, merge progress, technical failure) without
widening or narrowing the authorization. Fenced on `requestId` so a late response from a superseded
attempt can never overwrite a newer decision's receipt.
*/
export async function updateHumanMergeDecisionReceiptImpl(
  store: TaskStore,
  id: string,
  input: UpdateHumanMergeReceiptInput,
): Promise<HumanMergeMutationResult> {
  return withHumanMergeApprovalTransaction(store, id, (current) => {
    const state = current.humanMergeApproval;
    const decision = state?.decision;
    if (!state || !decision || decision.requestId !== input.requestId) {
      return { refusal: "candidate-superseded" as const };
    }
    return {
      state: { ...state, decision: { ...decision, receipt: input.receipt } },
      logEntry: input.logEntry ?? {
        timestamp: new Date().toISOString(),
        action: `Delivery ${decision.deliveryAction === "create-pr" ? "pull request" : "merge"} ${input.receipt.state}`,
        ...(input.receipt.prUrl ? { outcome: input.receipt.prUrl } : {}),
        ...(input.receipt.error ? { outcome: input.receipt.error } : {}),
      },
    };
  });
}

export interface UpdateHumanMergeRejectionInput {
  requestId: string;
  patch: Partial<Pick<NonNullable<HumanMergeApprovalState["rejection"]>, "state" | "analysis" | "attemptCount" | "lastError" | "publishedAt">>;
  logEntry?: TaskLogEntry;
}

/*
Advance the correction episode (analysis started, analysis result, published, failed-and-retryable).
Fenced on `requestId` AND the remediation generation carried by the live row, so a late planner
response cannot resurrect a cancelled episode or overwrite a newer one.
*/
export async function updateHumanMergeRejectionStateImpl(
  store: TaskStore,
  id: string,
  input: UpdateHumanMergeRejectionInput,
): Promise<HumanMergeMutationResult> {
  return withHumanMergeApprovalTransaction(store, id, (current) => {
    const state = current.humanMergeApproval;
    const rejection = state?.rejection;
    if (!state || !rejection || rejection.requestId !== input.requestId) {
      return { refusal: "candidate-superseded" as const };
    }
    return {
      state: { ...state, rejection: { ...rejection, ...input.patch } },
      logEntry: input.logEntry ?? {
        timestamp: new Date().toISOString(),
        action: `Delivery rejection ${input.patch.state ?? rejection.state}`,
        ...(input.patch.lastError ? { outcome: input.patch.lastError } : {}),
      },
    };
  });
}

/*
Duplication helper kept beside the mutations so the "keep intent, drop every accord" rule has one
home. Reset reuses `clearHumanMergeApprovalDecision` through `buildResetTask`.
*/
export function humanMergeApprovalStateForReset(
  state: HumanMergeApprovalState | undefined,
): HumanMergeApprovalState | undefined {
  return clearHumanMergeApprovalDecision(state) ?? undefined;
}
