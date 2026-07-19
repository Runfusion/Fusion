/*
FNXC:LegacyAdoption 2026-07-19-12:00 (U9 / R10 / KTD-8):
Every pre-cutover task row must wake OWNED — no silently frozen rows. Because
`task.status` is an OPEN string (not a closed enum), the adoption contract is
derived from a WRITE-SITE CENSUS: the completeness assertion in
legacy-adoption.test.ts greps every task.status write literal in every non-test .ts
source under core/engine/dashboard src (recursive scan, PR #2341 review) and
fails the build if any lacks an adoption row here. So a status added during the
cutover window fails the build instead of mass-parking rows `paused` at upgrade.

Adoption action per legacy status (KTD-8), for the FOUNDATIONAL targets (U9 scope A):
  - resume-graph   : clear the legacy triage-owned status so the graph re-enters
                     cleanly at the owning node (planning → planning node,
                     needs-replan → plan-replan, plan-review-unavailable →
                     plan-review retry, queued/triaged → scheduler re-pickup).
  - preserve       : a live human/terminal gate the graph must NOT disturb
                     (awaiting-approval, awaiting-user-input, failed, error,
                     blocked, done, cancelled). Pausing is NOT a status: it is
                     the boolean `task.paused` field, which no adoption action
                     touches except the explicit park-paused write — so there
                     is deliberately no "paused" adoption row.
  - clear          : a transient in-flight status with no durable meaning post-
                     restart — clear to null and let normal dispatch resume.
  - park-paused    : UNMAPPABLE — an unknown status parks `paused` with a
                     `task:reconcile-legacy-adoption-unmappable` audit for a human.

The execute-seam (in-progress + live steps) and in-review merge-substate
(merging/merging-pr/merging-fix) adoption rows are marked `resume-graph`.

FNXC:LegacyAdoption 2026-07-19-05:20 (U9b resolution):
U9 deferred these to U9b "to refine the exact node". U9b's finding: `resume-graph` is the
CORRECT final answer, not a placeholder. Naming an exact re-entry node here would require
resolving the task's workflow IR, which this module deliberately cannot do — it is pure and
storage-agnostic so both consumers (store-open reconcile and the self-healing startup
sweep) can share one decision. Clearing the legacy substate hands the row back to the graph
runner, which resolves its own owning node from the task's actual IR. That is strictly more
correct than a hard-coded node id, which would go stale the moment a workflow is edited —
exactly the drift KTD-3's IR pin exists to catch. Keep them `resume-graph`.
*/

/** What store-open adoption does with a legacy task.status value. */
export type LegacyAdoptionKind = "resume-graph" | "preserve" | "clear" | "park-paused";

export interface LegacyAdoptionAction {
  kind: LegacyAdoptionKind;
  /** Human-facing note (audit metadata; ids/outcomes-only elsewhere). */
  note: string;
}

/**
 * The KTD-8 adoption table: every task.status literal a pre-cutover row can carry
 * maps to an adoption action. The census test (legacy-adoption.test.ts) asserts
 * this covers every task.status WRITE literal in core/engine — a new one fails the
 * build. `null`/`undefined` (no status) needs no row (nothing to adopt).
 */
export const LEGACY_STATUS_ADOPTION: Readonly<Record<string, LegacyAdoptionAction>> = {
  // ── Triage plan-review statuses whose writers U3 deleted → graph re-entry ──
  "planning": { kind: "resume-graph", note: "re-enter planning node" },
  "needs-replan": { kind: "resume-graph", note: "re-enter plan-replan node" },
  "plan-review-unavailable": { kind: "resume-graph", note: "plan-review retry (leased)" },
  // ── Scheduler / dispatch transient states → re-pickup ─────────────────────
  "queued": { kind: "resume-graph", note: "scheduler re-queue" },
  "triaged": { kind: "resume-graph", note: "scheduler re-pickup" },
  // ── Merge substates (execute-seam/merge refinement DEFERRED to U9b) ───────
  "merging": { kind: "resume-graph", note: "resume merge node (U9b refines)" },
  "merging-pr": { kind: "resume-graph", note: "resume merge-pr node (U9b refines)" },
  "merging-fix": { kind: "resume-graph", note: "resume merge-fix node (U9b refines)" },
  // ── Live human / terminal gates — do NOT disturb ──────────────────────────
  "awaiting-approval": { kind: "preserve", note: "manual plan approval gate" },
  "awaiting-user-input": { kind: "preserve", note: "awaiting operator input" },
  "awaiting-user-review": { kind: "preserve", note: "awaiting operator review" },
  "awaiting-cli-approval": { kind: "preserve", note: "awaiting CLI operator approval" },
  "failed": { kind: "preserve", note: "terminal failure park" },
  "error": { kind: "preserve", note: "durable error park" },
  "blocked": { kind: "preserve", note: "dependency-blocked" },
  "done": { kind: "preserve", note: "terminal complete" },
  "cancelled": { kind: "preserve", note: "operator-cancelled" },
  // ── Transient in-flight → clear so normal dispatch resumes ────────────────
  "cancelling": { kind: "clear", note: "transient cancel — clear on restart" },
  "stuck-killed": { kind: "resume-graph", note: "stuck-detector kill — clear and re-dispatch" },
};

/**
 * Resolve the adoption action for a legacy task.status value. A `null`/empty
 * status needs no adoption (returns undefined — nothing to do). An UNKNOWN status
 * (no table row) resolves to `park-paused` so it surfaces to a human rather than
 * silently freezing or mass-parking every row.
 */
export function resolveLegacyStatusAdoption(
  status: string | null | undefined,
): LegacyAdoptionAction | undefined {
  if (status === null || status === undefined || status === "") return undefined;
  return (
    LEGACY_STATUS_ADOPTION[status] ?? {
      kind: "park-paused",
      note: `unmappable legacy status '${status}'`,
    }
  );
}

// ── reviewLevel backfill (U9 / R6 follow-through of U8) ────────────────────────

import { resolveReviewLevelSteps } from "./review-level-preset.js";

/**
 * One-time backfill decision for a pre-cutover task carrying a `reviewLevel`.
 * NEVER writes both fields: a task that already has `enabledWorkflowSteps` keeps
 * it (explicit steps win) and is only warned; a `reviewLevel`-only task gains the
 * preset step set derived by the same U8 mapper; a task with neither is a no-op.
 */
export type ReviewLevelBackfillDecision =
  | { kind: "backfill"; enabledWorkflowSteps: string[] }
  | { kind: "both-set-warn" }
  | { kind: "no-op" };

export function resolveReviewLevelBackfill(
  task: { reviewLevel?: number | null; enabledWorkflowSteps?: string[] | null },
): ReviewLevelBackfillDecision {
  if (typeof task.reviewLevel !== "number") return { kind: "no-op" };
  // Explicit steps ALWAYS win — never overwrite, never set both. Warn only.
  if (task.enabledWorkflowSteps !== undefined && task.enabledWorkflowSteps !== null) {
    return { kind: "both-set-warn" };
  }
  return { kind: "backfill", enabledWorkflowSteps: resolveReviewLevelSteps(task.reviewLevel) };
}

// ── The adoption PLAN: one brain, two consumers (U9b) ─────────────────────────

/*
FNXC:LegacyAdoption 2026-07-19-04:00 (U9b / R10 / KTD-8):
U9 landed the adoption TABLE but shipped no consumer — `resolveLegacyStatusAdoption` was
exported and never called, so no pre-cutover row was actually adopted. This closes that
gap with a single pure planner that both consumers (store-open reconcile and the
self-healing STARTUP sweep) share, so the two can never drift into disagreeing about what
a legacy row means.

Idempotency rule: only a plan that MUTATES stamps `legacyAdoptedAt`. `preserve` is a
deliberate no-op (a live human/terminal gate), and stamping it would mean mass-writing
every `done` row on first boot after upgrade. Re-evaluating a preserve row each boot is
free and idempotent by construction.
*/

/** A concrete, ready-to-apply adoption decision for one legacy row. */
export interface LegacyAdoptionPlan {
  /** `skip` means nothing to do (already adopted, nothing legacy, or a preserve gate). */
  action: LegacyAdoptionKind | "skip";
  /** Why — audit metadata and operator-facing logs. Never row prose. */
  reason: string;
  /** The patch to apply through updateTask. Absent for `skip`. */
  patch?: {
    status?: null;
    paused?: boolean;
    pausedReason?: string;
    enabledWorkflowSteps?: string[];
    legacyAdoptedAt: string;
  };
  /** Run-audit mutation type for this adoption, when it mutates. */
  auditType?: "task:reconcile-legacy-adoption" | "task:reconcile-legacy-adoption-unmappable";
}

/** The subset of a task the planner needs. Keeps the planner storage-agnostic. */
export interface LegacyAdoptionCandidate {
  status?: string | null;
  reviewLevel?: number | null;
  enabledWorkflowSteps?: string[] | null;
  legacyAdoptedAt?: string | null;
}

/**
 * Decide how to adopt one pre-cutover row. Pure — the caller performs the write and the
 * run-audit emit, so store-open and self-healing apply byte-identical semantics.
 *
 * @param now ISO timestamp used for the adoption stamp (injected so the decision is
 *            deterministic and testable).
 */
export function planLegacyAdoption(
  task: LegacyAdoptionCandidate,
  now: string,
): LegacyAdoptionPlan {
  // Already adopted — never re-clear a status a human has since re-set, and never re-park
  // a row an operator already un-parked.
  if (task.legacyAdoptedAt) {
    return { action: "skip", reason: "already-adopted" };
  }

  const statusAction = resolveLegacyStatusAdoption(task.status);
  const backfill = resolveReviewLevelBackfill(task);

  // A preserve gate is untouchable, but a reviewLevel backfill is orthogonal metadata and
  // is still safe to land on it.
  if (statusAction?.kind === "preserve" && backfill.kind !== "backfill") {
    return { action: "skip", reason: `preserve: ${statusAction.note}` };
  }

  if (!statusAction && backfill.kind !== "backfill") {
    return {
      action: "skip",
      reason: backfill.kind === "both-set-warn"
        ? "review-level-and-steps-both-set (left untouched, warned)"
        : "nothing-to-adopt",
    };
  }

  const patch: NonNullable<LegacyAdoptionPlan["patch"]> = { legacyAdoptedAt: now };
  if (backfill.kind === "backfill") patch.enabledWorkflowSteps = backfill.enabledWorkflowSteps;

  // UNMAPPABLE: surface to a human rather than guessing. The status is deliberately LEFT IN
  // PLACE so the operator can see what the row actually carried.
  if (statusAction?.kind === "park-paused") {
    patch.paused = true;
    patch.pausedReason = `legacy-adoption-unmappable: ${task.status}`;
    return {
      action: "park-paused",
      reason: statusAction.note,
      patch,
      auditType: "task:reconcile-legacy-adoption-unmappable",
    };
  }

  // resume-graph / clear both clear the legacy status so the graph re-enters at its owning
  // node (resume-graph) or normal dispatch resumes (clear).
  if (statusAction?.kind === "resume-graph" || statusAction?.kind === "clear") {
    patch.status = null;
    return {
      action: statusAction.kind,
      reason: statusAction.note,
      patch,
      auditType: "task:reconcile-legacy-adoption",
    };
  }

  // Backfill-only (no legacy status, or a preserve gate carrying a reviewLevel).
  return {
    action: statusAction?.kind ?? "clear",
    reason: statusAction ? `${statusAction.note} + reviewLevel backfill` : "reviewLevel backfill",
    patch,
    auditType: "task:reconcile-legacy-adoption",
  };
}

/*
FNXC:LegacyAdoption 2026-07-19-04:00 (U9b / KTD-8):
Orphaned `pending` workflow-step results. A pre-cutover crash can leave a step result
`pending` with no live session behind it; the graph will wait on it forever. Clear those,
but ONLY when the caller proves no live session holds the step — a leased/live one is real
work in flight and must survive. Pure: the caller supplies liveness.
*/
export function resolveOrphanedPendingStepResults<T extends { stepIndex?: number; status?: string }>(
  results: readonly T[] | null | undefined,
  isLive: (result: T) => boolean,
): { cleared: T[]; clearedCount: number } {
  if (!results || results.length === 0) return { cleared: [], clearedCount: 0 };
  let clearedCount = 0;
  const cleared = results.filter((result) => {
    if (result.status !== "pending") return true;
    if (isLive(result)) return true;
    clearedCount++;
    return false;
  });
  return { cleared, clearedCount };
}
