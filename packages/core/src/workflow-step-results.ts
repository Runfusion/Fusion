import type { WorkflowStepResult } from "./types.js";

/*
FNXC:WorkflowStepResults 2026-07-09-00:20:
FN-7727: both engine `WorkflowStepResult` recorders (the executor graph adapter's
`recordWorkflowStepResult` and triage's `recordPlanReviewWorkflowResult`) used to
upsert by `workflowStepId` with a bare `existing[idx] = result` replace-in-place.
When self-healing (`recoverFailedPreMergeWorkflowStep` /
`recoverReviewTasksWithFailedPreMergeSteps`) sends a failed pre-merge review step
back for fix and the graph re-runs that same node, the new attempt silently
overwrote the prior `status:"failed"` record — losing its `output`/`notes`/
`verdict`/timestamps forever. This shared, PURE helper is the single upsert path
for every recorder: it snapshots a replaced `failed`/`advisory_failure` entry into
the new entry's `priorAttempts` (bounded, oldest-dropped, single-level — snapshots
never carry their own nested `priorAttempts`), and carries forward already-
accumulated history across successive re-runs. `priorAttempts` is read-only
history: callers that select "the current failed step" (self-healing selection,
`getTaskMergeBlocker`, progress/timing) must keep reading the top-level array
entries only and never flatten/inspect `priorAttempts` for that purpose.
*/

/** Default cap on the number of prior terminal-failure attempts retained per step. */
export const MAX_WORKFLOW_STEP_PRIOR_ATTEMPTS = 5;

const TERMINAL_FAILURE_STATUSES: ReadonlySet<WorkflowStepResult["status"]> = new Set([
  "failed",
  "advisory_failure",
]);

function isTerminalFailure(result: WorkflowStepResult): boolean {
  return TERMINAL_FAILURE_STATUSES.has(result.status);
}

/**
 * Strip a result down to a single-level history snapshot: its own
 * `priorAttempts` are dropped so nesting never grows beyond one level deep.
 */
function toSnapshot(result: WorkflowStepResult): WorkflowStepResult {
  if (!result.priorAttempts || result.priorAttempts.length === 0) return result;
  const { priorAttempts: _drop, ...rest } = result;
  return rest as WorkflowStepResult;
}

/**
 * Pure upsert of a `WorkflowStepResult` by `workflowStepId`, preserving a
 * bounded history of prior terminal-failure attempts on the surviving entry.
 *
 * - Absent → the incoming result is appended.
 * - Present → the existing entry is replaced IN PLACE (array position
 *   preserved). The existing entry's already-accumulated `priorAttempts` are
 *   carried forward onto the incoming result. If the existing entry represents
 *   a DIFFERENT attempt (deduped by `startedAt` — a same-run `pending`→`failed`
 *   transition of the same attempt is not a new attempt) and its status is a
 *   terminal failure (`failed` | `advisory_failure`), a single-level snapshot
 *   of it is pushed onto the incoming result's `priorAttempts`.
 * - `priorAttempts` is bounded to `opts.maxPriorAttempts` (default
 *   `MAX_WORKFLOW_STEP_PRIOR_ATTEMPTS`), newest-first, oldest dropped.
 *
 * Never mutates `existing` or `incoming`; always returns a new array.
 */
export function upsertWorkflowStepResult(
  existing: WorkflowStepResult[] | undefined,
  incoming: WorkflowStepResult,
  opts?: { maxPriorAttempts?: number },
): WorkflowStepResult[] {
  const maxPriorAttempts = opts?.maxPriorAttempts ?? MAX_WORKFLOW_STEP_PRIOR_ATTEMPTS;
  const source = existing ?? [];
  const idx = source.findIndex((r) => r.workflowStepId === incoming.workflowStepId);

  if (idx < 0) {
    const next = [...source];
    next.push({ ...incoming });
    return next;
  }

  const previous = source[idx];
  const isSameAttempt = previous.startedAt !== undefined
    && incoming.startedAt !== undefined
    && previous.startedAt === incoming.startedAt;

  let priorAttempts = previous.priorAttempts ? [...previous.priorAttempts] : [];
  if (!isSameAttempt && isTerminalFailure(previous)) {
    priorAttempts = [toSnapshot(previous), ...priorAttempts];
  }
  if (priorAttempts.length > maxPriorAttempts) {
    priorAttempts = priorAttempts.slice(0, maxPriorAttempts);
  }

  const replacement: WorkflowStepResult = { ...incoming };
  if (priorAttempts.length > 0) {
    replacement.priorAttempts = priorAttempts;
  } else {
    delete replacement.priorAttempts;
  }

  const next = [...source];
  next[idx] = replacement;
  return next;
}

/*
FNXC:PlanReviewLease 2026-07-18-23:25:
U3 / KTD-4 — pending review-gate results are LEASES. A `pending` result whose
`leaseOwner` is set and whose `startedAt` is within the staleness floor is a LIVE
lease: a re-entering graph run must adopt it (skip re-dispatch), never launch a
second reviewer. Only past the staleness floor may another run RECLAIM the gate
by compare-and-set (write its own owner). This is the FN-6736 stale-lease pattern
applied to the plan-review dedup site, and it is what makes the FN-1315 duplicate
"Starting workflow step: Plan Review" interleaving impossible by construction.

These helpers are PURE (no store, no clock beyond the injected `now`) so the
graph executor and unit tests share one lease implementation.
*/

/** Default staleness floor for a review-gate lease (ms). A lease older than this
 *  with no terminal result is presumed crashed and may be reclaimed. Mirrors the
 *  FN-6736 staleness-floor standard for durable single-owner leases. */
export const PLAN_REVIEW_LEASE_STALENESS_MS = 15 * 60 * 1000;

/** Classification of a review-gate's current lease state for a re-entering run. */
export type ReviewLeaseDisposition =
  /** No prior result — this run should claim the lease and dispatch the reviewer. */
  | { kind: "claim" }
  /** A terminal result already exists (passed/failed/…): satisfied, do not dispatch. */
  | { kind: "settled"; result: WorkflowStepResult }
  /** A LIVE lease owned by another run within the staleness floor: adopt, do NOT dispatch. */
  | { kind: "adopt"; owner: string }
  /** A stale lease (past the floor, or ownerless): this run may reclaim by CAS and dispatch. */
  | { kind: "reclaim"; priorOwner?: string };

/** Terminal statuses a leased pending result can settle into. */
const TERMINAL_STEP_STATUSES: ReadonlySet<WorkflowStepResult["status"]> = new Set([
  "passed",
  "failed",
  "advisory_failure",
  "skipped",
]);

/** Is a stored result a terminal (settled) record rather than a live/stale lease? */
export function isTerminalStepResult(result: WorkflowStepResult): boolean {
  return TERMINAL_STEP_STATUSES.has(result.status);
}

/**
 * Decide what a re-entering run should do about a review gate, given the current
 * results for the gate's step id. Pure and clock-injected. The staleness floor
 * (not owner identity) governs honor-vs-reclaim, so a crash/restart that re-enters
 * with the SAME deterministic run id still honors a live lease within the floor
 * (never double-dispatches) and only reclaims once the lease is presumed dead.
 *
 * - No existing result → `claim` (dispatch the reviewer, writing a lease).
 * - Existing terminal result → `settled` (dedup: do not re-dispatch).
 * - Existing `pending` lease within the staleness floor → `adopt` (do NOT dispatch).
 * - Existing `pending` lease past the floor (or ownerless/undated) → `reclaim`.
 */
export function classifyReviewLease(
  results: readonly WorkflowStepResult[] | undefined,
  stepId: string,
  now: number,
  stalenessMs: number = PLAN_REVIEW_LEASE_STALENESS_MS,
): ReviewLeaseDisposition {
  const existing = results?.find((r) => r.workflowStepId === stepId);
  if (!existing) return { kind: "claim" };
  if (isTerminalStepResult(existing)) return { kind: "settled", result: existing };
  // existing.status === "pending": it is a lease.
  const startedMs = existing.startedAt ? Date.parse(existing.startedAt) : Number.NaN;
  const ageMs = Number.isFinite(startedMs) ? now - startedMs : Number.POSITIVE_INFINITY;
  const stale = !existing.leaseOwner || !Number.isFinite(startedMs) || ageMs >= stalenessMs;
  if (stale) return { kind: "reclaim", priorOwner: existing.leaseOwner };
  // Not stale ⇒ `leaseOwner` is guaranteed set (the stale check requires it).
  return { kind: "adopt", owner: existing.leaseOwner as string };
}

/**
 * Build the `pending` lease record a run writes when it claims/reclaims a review
 * gate. `startedAt` is the lease clock; `leaseOwner` is this run's identity.
 */
export function makeReviewLeaseRecord(args: {
  stepId: string;
  stepName: string;
  owner: string;
  startedAt: string;
  phase?: WorkflowStepResult["phase"];
  source?: WorkflowStepResult["source"];
}): WorkflowStepResult {
  return {
    workflowStepId: args.stepId,
    workflowStepName: args.stepName,
    ...(args.phase ? { phase: args.phase } : {}),
    ...(args.source ? { source: args.source } : {}),
    status: "pending",
    startedAt: args.startedAt,
    leaseOwner: args.owner,
  };
}
