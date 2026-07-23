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
  - resume-graph   : clear a legacy status whose writers the cutover DELETED so the
                     graph re-enters cleanly at the owning node
                     (plan-review-unavailable → plan-review retry,
                     triaged → scheduler re-pickup). NEVER a status with a live
                     post-cutover writer — those are `preserve` (see the FN-8504
                     incident note on the table).
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
  /*
  FNXC:LegacyAdoption 2026-07-22-18:20 (FN-8504 incident — generalizes FN-8498):
  A status with a LIVE post-cutover writer is NOT legacy and must be `preserve`, never
  resume-graph/clear. The adoption sweep runs on EVERY store open (a DB with any active
  task never records the drained marker — a mutating cycle withholds it), so a clearing
  action races live lanes: FN-8504's replan planner wrote status:"planning" and ~100ms
  later a store-open adoption cleared it (audit: task:reconcile-legacy-adoption,
  priorStatus "planning"), leaving a live planner rendered as an idle "Ready" card and
  invisible to every Running count. Live-writer statuses each have their own crash-
  recovery owner, so preserve loses nothing:
    - planning        → triage's startup stale-planning sweep clears crashed planners
    - queued          → the scheduler re-evaluates queued rows every poll
    - merging/-pr/-fix→ self-healing recoverInterruptedMergingTasks / stale-merge recovery
    - stuck-killed    → restart-recovery-coordinator owns kill-park resume
  Only statuses with NO live task-row writer may keep a clearing action
  (plan-review-unavailable, triaged).
  */
  "planning": { kind: "preserve", note: "live triage planner status — triage's stale-planning sweep owns crash recovery" },
  // ── Triage plan-review statuses whose writers U3 deleted → graph re-entry ──
  "plan-review-unavailable": { kind: "resume-graph", note: "plan-review retry (leased)" },
  // ── Live graph signals with post-cutover writers — preserve, never clear ───
  /*
  FNXC:LegacyAdoption 2026-07-22-15:55 (FN-8498 incident):
  `needs-replan` is NOT legacy — post-U3 it is written live by the graph's own plan-replan
  seam (executor.ts / scheduler.ts) and CONSUMED by triage's todo-rediscovery, which only
  re-admits a planned todo task when status === "needs-replan". The original resume-graph
  mapping cleared it on every engine restart, deleting the exact signal its consumer keys
  on and stranding replan-loop tasks in `todo` forever (FN-8498 sat "ready" for 80 minutes
  after a restart). Preserve it: the status is self-resuming — triage picks it up as-is.
  */
  "needs-replan": { kind: "preserve", note: "live graph replan signal — triage todo-rediscovery consumes it" },
  // ── Scheduler / dispatch states — queued has live writers → preserve ──────
  "queued": { kind: "preserve", note: "live scheduler capacity/dependency marker — scheduler re-evaluates each poll" },
  "triaged": { kind: "resume-graph", note: "scheduler re-pickup" },
  // ── Merge substates — live merger writers → preserve (FN-8504 incident) ───
  "merging": { kind: "preserve", note: "live merge-active status — self-healing owns stale-merge recovery" },
  "merging-pr": { kind: "preserve", note: "live merge-active status — self-healing owns stale-merge recovery" },
  "merging-fix": { kind: "preserve", note: "live merge-active status — self-healing owns stale-merge recovery" },
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
  // stuck-killed has live writers (self-healing kill, restart-recovery-coordinator) → preserve.
  "stuck-killed": { kind: "preserve", note: "live stuck-detector kill park — restart-recovery owns re-dispatch" },
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

import { resolveReviewLevelSteps } from "../tasks/review-level-preset.js";

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
Orphaned `pending` workflow-step results. A crash/restart can leave a step result
`pending` with no live session behind it; the graph will wait on it forever. Act only
when the caller proves no live session holds the step — a leased/live one is real work
in flight and must survive. Pure: the caller supplies liveness and the orphan mark.

FNXC:OrphanedPendingSteps 2026-07-22-16:35 (FN-8492 review follow-up):
The original U9b shape DELETED the orphaned entry. Review of the shipped consumer proved
deletion is a severity inversion: the merge gate blocks on pending/failed results, not on
an enabled step with NO result, so deleting a dead Code Review's pending entry silently
SATISFIED the gate and the task merged with its review skipped (FN-8492 landed unreviewed
minutes after an equivalent manual clear). Orphans are now REWRITTEN to status:"failed"
instead — the merge gate stays closed and the existing failed-pre-merge-steps recovery /
FN-7720 operator-bypass paths own the re-run-or-bypass decision. Never delete.
*/
export function resolveOrphanedPendingStepResults<T extends { stepIndex?: number; status?: string }>(
  results: readonly T[] | null | undefined,
  isLive: (result: T) => boolean,
  orphanMark?: { output?: string; completedAt?: string },
): { results: T[]; orphanedCount: number } {
  if (!results || results.length === 0) return { results: [], orphanedCount: 0 };
  let orphanedCount = 0;
  const next = results.map((result) => {
    if (result.status !== "pending") return result;
    if (isLive(result)) return result;
    orphanedCount++;
    return { ...result, status: "failed", ...(orphanMark ?? {}) } as T;
  });
  return { results: next, orphanedCount };
}
