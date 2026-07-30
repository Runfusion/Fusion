import type { Task, TaskStore } from "@fusion/core";
import { resolveWorkflowIrForTask, workflowHasColumn } from "@fusion/core";

/*
FNXC:WorkflowReplan 2026-07-12-23:15:
Engine rebounds that send a task back for (re)planning — Plan Review REVISE, stale-spec
enforcement, filesystem-validation failures — used to hardcode moveTask(id, "triage").
Workflows without a "triage" column (Coding (Ideas) merges the planner into "todo") ended up
with a column-orphaned card: the board rendered it back in the intake lane ("Ideas") and the
aggregate All-workflows view dropped it entirely. The replan target must be resolved against
the task's OWN workflow: "triage" when declared, otherwise the plan-in-place planner column
("todo"). Triage's todo-discovery picks up `needs-replan` todo cards so plan-in-place replans
still run.

FNXC:WorkflowReplan 2026-07-13-11:30:
The final fallback is "triage", NEVER the workflow's entry column. Workflows that declare
neither "triage" nor "todo" (builtin marketing, arbitrary customs) have no column the triage
service scans, so parking a needs-replan card in their custom entry column strands it forever
— and the legacy move path throws on custom targets, aborting the replan before the status
write. "triage" preserves the pre-workflow-aware behavior for these workflows: the move is
legal from every legacy column and eligibleTriageTasks re-specifies unconditionally.

FNXC:WorkflowLifecycleColumns 2026-07-28-00:20 (Phase B / slice B2) DELIBERATE-LITERAL:
Reviewed as a U5 conversion candidate and deliberately NOT converted. The value of this
fallback is precisely that it is NOT trait-resolved: it fires only when the workflow
declares neither planner column, and the whole point (documented above) is that resolving
it against the workflow — to that workflow's entry column — is the bug it was written to
fix. Converting it would reintroduce the stranded-card behavior.

Recorded here for the U12 literal ratchet's allowlist. That ratchet does not exist in the
tree yet; grep `DELIBERATE-LITERAL` to enumerate the sites it must admit, with the reason
attached at the site rather than in a separate list that can drift from it.
*/
/*
 * FNXC:WorkflowReplan 2026-07-15-13:15:
 * FN-7977: a planning/provider recovery may finish after another engine lane has
 * started execution. Recovery callers must prove the live row is still planning
 * before writing planning state; worktrees and execution or terminal columns are
 * durable evidence that the task has advanced.
 *
 * FNXC:WorkflowReplan 2026-07-16-05:35:
 * Materialized steps are NOT advancement evidence for a card still parked in a planner
 * lane. Triage materializes steps when it finalizes a spec, so every replan (Plan Review
 * REVISE -> needs-replan) legitimately carries the steps of its previous planning pass.
 * Counting steps>0 as "advanced" made the primary triage claim in specifyTask() skip its
 * status:"planning" write on every poll: the card was re-claimed forever, never planned,
 * and — because wedged cards keep occupying planning admission slots — starved every
 * healthy card queued behind them. Both planner surfaces must stay plannable: the "triage"
 * column, and plan-in-place workflows (Coding (Ideas)) that park needs-replan cards in
 * "todo" carrying a real spec. A planned-and-queued "todo" card with no planning status is
 * still genuinely advanced, so steps remain the deciding signal there.
 */

/** Statuses that explicitly park a card for (re)planning, whichever column holds it. */
const PLANNING_STAGE_STATUSES = new Set(["planning", "needs-replan", "plan-review-unavailable"]);

/**
 * The TRANSIENT planning-stage status: a planner is writing PROMPT.md right now. Everything else in
 * {@link PLANNING_STAGE_STATUSES} is a durable park.
 */
const TRANSIENT_PLANNING_STATUS = "planning";

/*
FNXC:WorkflowReplan 2026-07-26-07:40:
The DURABLE subset of PLANNING_STAGE_STATUSES: a card parked here was deliberately sent back by Plan
Review (or by a reviewer outage) and stays parked until a planner re-specifies it. Only these
outrank the execution timestamps below. `planning` is deliberately excluded — it is the TRANSIENT
in-flight planner claim, and a fresh execution stamp on a `planning` row means execution won the
race that FN-8361 guards (recovery must not clear the status out from under the claiming executor).

DERIVED, not re-listed: a new durable park status added to PLANNING_STAGE_STATUSES must automatically
join this set, or it reproduces the FN-8594 strand this file already fixed once (a park status that
lost to a sticky stamp, so the card was never re-planned). Only the transient status is subtracted.
*/
const REPLAN_PARK_STATUSES = new Set(
  [...PLANNING_STAGE_STATUSES].filter((status) => status !== TRANSIENT_PLANNING_STATUS),
);

export function hasAdvancedPastPlanning(
  task: Pick<Task, "column" | "worktree" | "steps" | "status">
    // FNXC:WorkflowReplan 2026-07-26-18:30: `columnMovedAt` is the stale-stamp discriminator (see
    // the execution-stamp branch). Optional so existing narrowed callers still compile; absent, the
    // branch keeps its prior "stamps mean advanced" answer.
    & Partial<Pick<Task, "firstExecutionAt" | "executionStartedAt" | "columnMovedAt">>,
  /*
  FNXC:WorkflowLifecycleColumns 2026-07-29-10:20 (U11):
  The workflow's PLANNER column. `triage` is only what the builtin coding workflow
  calls it, and reading a renamed planner column as "advanced" is the dangerous
  direction: the replan guards stop protecting a card that is still mid-plan, so
  planning writes are skipped and it is never re-specified.

  Defaults to the legacy id so every unconverted caller is byte-identical — which
  includes the three call sites in self-healing.ts, deliberately left alone
  because that file belongs to another worker's slice.
  */
  plannerColumn: string = "triage",
  /*
  FNXC:WorkflowLifecycleColumns 2026-07-29-15:10 (U11 — post-#2515 P0 audit):
  The workflow's MERGED planning column: a lane that is the planner AND the hold
  column at once. #2515 made that the default lineage's shape (one
  pre-implementation column, id `todo`, display "Planning"), so this defaults to
  `todo` rather than being absent — that default is what closes the stall for
  every caller at once, with no call-site change.

  Deliberately SEPARATE from `plannerColumn`, because the two rules below are not
  the same rule. A merged column participates in the FN-8596 arrival-order rescue
  but NOT in the "planner column is never advanced" shortcut: on a merged lineage
  the same id also means "released, awaiting capacity", and a released card with
  steps must keep reading as advanced or `hasAdvancedPastPlanning(t) ||
  releasedToTodo` stops distinguishing anything.
  */
  roles: { mergedPlanningColumn?: string } = { mergedPlanningColumn: "todo" },
): boolean {
  if (
    task.column === "in-progress"
    || task.column === "in-review"
    || task.column === "done"
    || task.column === "archived"
  ) {
    return true;
  }
  /*
  FNXC:WorkflowReplan 2026-07-26-06:10:
  A DURABLE parked-for-replan status outranks execution evidence, because that evidence is STICKY
  while a replan is a legitimate BACKWARD move. `firstExecutionAt`/`executionStartedAt` are never
  cleared once implementation starts, so a card that executed, failed Plan Review, and was rebounded
  to a planner lane (`needs-replan`) read as "advanced past planning" forever: triage's discovery
  filter (intake column plus `isTaskStillInPlanningStage`) never re-admitted it and the card sat
  in triage/needs-replan permanently — "stuck in planning" on the board (FN-8594). It hit every
  triage-column workflow (builtin:coding, the default); plan-in-place Ideas cards escaped only
  because todo discovery admits `needs-replan` without consulting this guard.
  This check covers BOTH planner lanes — the "triage" column and the plan-in-place "todo" lane.
  */
  if (task.status != null && REPLAN_PARK_STATUSES.has(task.status)) {
    return false;
  }
  /*
  FNXC:NodeWorktreeIsolation 2026-07-25-22:40:
  A worktree NO LONGER proves an executor claimed the card. Planning acquires the task's own
  worktree up front (so no lane runs in the shared checkout), which means a card being planned right
  now carries `worktree` — and reading that as "advanced" would make every planning write skip:
  `status:"planning"` never lands, the spec finalization is refused, and the card is re-claimed
  forever while occupying a planning admission slot. Execution TIMESTAMPS are the durable evidence
  instead; they are written when implementation actually starts, never by worktree acquisition.

  A triage card carrying a timestamp with NO planning status is the stranded-advanced class that
  self-healing's advanced recovery owns (PR #2360): planning must exclude it so it cannot burn a
  planning admission slot in a claim/skip loop.
  */
  if (task.firstExecutionAt != null || task.executionStartedAt != null) {
    /*
    FNXC:WorkflowReplan 2026-07-26-18:30 (FN-8596 strand):
    Distinguish a STALE stamp from a LIVE claim before treating the stamps as proof of advancement.
    Both look identical in the fields above, and conflating them is what stranded FN-8596: Plan
    Review returned REVISE, the graph rebounded the card to `triage` with `needs-replan`, triage
    claimed it and overwrote the status to the TRANSIENT `"planning"` (so the durable-park escape
    above no longer applied), and the stamps from the card's FIRST pass — never cleared — made the
    replanning card read as "advanced past planning" for the rest of the session. Every guarded
    planner write then silently no-opped, so the revision wrote PROMPT.md and the finalize never
    handed the card off. It sat in triage until an engine restart.

    The discriminator is arrival order: a stamp written BEFORE the card arrived in the planner
    column belongs to a previous pass, while a stamp written AFTER it arrived means execution
    genuinely won the FN-8361 race and recovery must not clear the status out from under it.
    Requiring a planning-stage status too keeps the PR #2360 stranded-advanced class (triage card
    with stamps and NO planning status) reading as advanced, so self-healing still owns it.
    Missing/unparseable `columnMovedAt` falls through to the prior behavior (advanced), so this can
    only ever narrow the strand, never widen the race.
    */
    const arrivedAtMs = Date.parse(task.columnMovedAt ?? "");
    const newestStampMs = Math.max(
      Date.parse(task.executionStartedAt ?? "") || Number.NEGATIVE_INFINITY,
      Date.parse(task.firstExecutionAt ?? "") || Number.NEGATIVE_INFINITY,
    );
    const stampPredatesArrival = Number.isFinite(arrivedAtMs)
      && Number.isFinite(newestStampMs)
      && newestStampMs < arrivedAtMs;
    /*
    FNXC:WorkflowReplan 2026-07-26-20:30 (FN-8596, second strand):
    The planner-lane test is the COLUMN, deliberately not the status. Requiring a planning-stage
    status left a hole that stranded the same card a second time: after the stale-status sweep
    cleared `planning` to null, the card had stale stamps and NO status, so planning excluded it
    (stamps read as advanced) AND `recoverAdvancedTriageTasks` — the designated owner of that
    "stranded-advanced" class — also excluded it, because it bails on
    `workflowIrPinColumnId === "triage"` (it cannot resume a card into the column it already sits
    in). Nobody owned the card and it sat indefinitely.
    Arrival order alone is the honest signal: a stamp written BEFORE the card reached the planner
    column belongs to a previous pass, whatever the status is now. A card that genuinely advanced
    out of triage is caught by the column check at the top, and one that was claimed by execution
    AFTER landing here has a stamp NEWER than its arrival, so it still reads advanced and stays with
    the advanced-recovery sweep.
    */
    /* Merged lanes participate HERE — the rescue is already gated on the stamp
       predating arrival, so a released card later claimed by execution (newer
       stamp) still reads as advanced and stays with the advanced-recovery sweep. */
    const inPlannerLane = task.column === plannerColumn
      || (roles.mergedPlanningColumn != null && task.column === roles.mergedPlanningColumn);
    if (!(stampPredatesArrival && inPlannerLane)) {
      return true;
    }
    return false;
  }
  // The planner column itself is never "advanced" — nothing executes out of triage, and the steps
  // below belong to the card's previous planning pass.
  if (task.column === plannerColumn) {
    return false;
  }
  // Plan-in-place planner lane ("todo"): a card explicitly parked for planning has not advanced.
  // Reached only by `planning` here — the durable park statuses already returned above.
  if (task.status != null && PLANNING_STAGE_STATUSES.has(task.status)) {
    return false;
  }
  return (task.steps?.length ?? 0) > 0;
}

/*
FNXC:WorkflowReplan 2026-07-26-08:35:
The parameter type must mirror hasAdvancedPastPlanning's, including the execution stamps the
implementation reads. When it omitted them, a caller passing a narrowed object (rather than a whole
Task) type-checked while silently dropping the stamps — the guard then read them as absent, which is
the "not advanced" answer, and TypeScript could not flag it.
*/
export function isTaskStillInPlanningStage(
  task: Pick<Task, "column" | "worktree" | "steps" | "status">
    & Partial<Pick<Task, "firstExecutionAt" | "executionStartedAt" | "columnMovedAt">>,
  plannerColumn: string = "triage",
  roles: { mergedPlanningColumn?: string } = { mergedPlanningColumn: "todo" },
): boolean {
  return !hasAdvancedPastPlanning(task, plannerColumn, roles);
}

export async function resolveReplanTargetColumn(store: TaskStore, taskId: string): Promise<string> {
  try {
    const ir = await resolveWorkflowIrForTask(store, taskId);
    /*
    FNXC:WorkflowLifecycleColumns 2026-07-29-10:40 (U11 — NOT CONVERTED, and why):
    These two lookups look like `intake ?? hold` but they are not, and swapping
    them for roles is WRONG. Coding (Ideas) declares `ideas` as its intake column
    with `autoTriage: false` and does its planning in `todo` (the hold column,
    plan-in-place). A role swap therefore sends its replans to the raw-ideas
    column instead of the planning lane — caught here by the pre-existing
    "targets todo for Coding (Ideas)" test rather than in production.

    The real discriminator is which lane the triage service SCANS, which depends
    on the intake column's `autoTriage` config, not on the intake/hold roles
    alone. Resolving that correctly is its own change with its own evidence; it is
    deliberately not smuggled into a conversion PR.

    U11 IMPACT, flagged rather than assumed: the second lookup asks for `"todo"`,
    which U11 deletes. For builtin coding the first lookup still matches `triage`
    (which U11 keeps), so the builtins stay correct — but a workflow relying on the
    `todo` branch loses it. That is a real follow-up, not a blocker for this PR.
    */
    if (workflowHasColumn(ir, "triage")) return "triage";
    if (workflowHasColumn(ir, "todo")) return "todo";
    return "triage";
  } catch {
    return "triage";
  }
}

/**
 * Move `task` to its workflow-aware replan column unless it is already there.
 * Pass `target` when the caller already resolved it (e.g. to log the target
 * first) so the resolve/compare/move contract still lives in one place.
 *
 * FNXC:WorkflowReplan 2026-07-26-11:05:
 * A replan bounce KEEPS the task worktree (`preserveWorktree: true`). `moveTask`'s
 * reopen-to-todo/triage block clears `task.worktree` but deliberately leaves `task.branch`
 * intact, so an unguarded replan move produced a split-brain row: no worktree pointer, but
 * still owning `fusion/<id>`, which is still checked out in the worktree that was just
 * orphaned. The next planning entry (`ensureTaskWorktreeForPlanning` ->
 * `ensureGraphCustomNodeWorktree` -> `acquireTaskWorktree`) therefore skipped its resume
 * branch (gated on `task.worktree`), tried to create the SAME branch fresh, collided, and
 * fell into `cleanupConflictingWorktree` — force-removing the previous worktree and
 * `git branch -D`-ing `fusion/<id>` before re-cutting it off the integration branch.
 * Observed on FN-8603: two Plan Review REVISE bounces burned two full teardown +
 * `git worktree add` + init-command cycles (~10s each) and two branch delete/recreate rounds
 * for zero benefit — planning writes its spec to the task store, not the worktree, so the
 * tree it is handed is the tree it should keep.
 *
 * Preserving is safe for every caller because acquisition still re-validates: a preserved
 * pointer to a removed or unusable checkout is caught by `classifyTaskWorktree` in
 * `acquireTaskWorktree`, which clears the metadata and creates a fresh worktree. The rest of
 * the replan contract (steps reset to pending, status/error cleared, `executionStartedAt`
 * dropped) is unchanged — only the checkout survives.
 */
export async function moveTaskToReplanColumn(
  store: TaskStore,
  task: Pick<Task, "id" | "column">,
  target?: string,
): Promise<string> {
  const replanColumn = target ?? await resolveReplanTargetColumn(store, task.id);
  if (task.column !== replanColumn) {
    await store.moveTask(task.id, replanColumn, { preserveWorktree: true });
  }
  return replanColumn;
}
