import type { Task, TaskStore } from "@fusion/core";
import {
  classifyLifecycleRole,
  resolveColumnFlags,
  resolveLifecycleColumns,
  resolveWorkflowIrForTask,
  workflowHasColumn,
} from "@fusion/core";
import type { WorkflowIr } from "@fusion/core";
import { schedulerLog } from "../logger.js";
import { moveTaskWithLifecycleReason } from "./lifecycle-move.js";

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
FNXC:WorkflowLifecycleColumns 2026-07-30-09:20 (Phase C convergence — shared planner lanes):

MOVED, NOT CHANGED. This is triage.ts's private `resolvePlannerLanes` verbatim, lifted here
so the executor can ask the same question with the same answer. triage.ts now delegates to
it; every returned value, the fail-soft legacy pair, and the synchronous shape are
unchanged, because the executor sites that need it sit in a `task:moved` listener where
introducing an `await` would reorder handlers relative to a synchronous emitter.

Its original note, preserved because it is still the reason for every property:
  Triage's column decisions are all one of two questions — "is this card in a planner
  lane?" (hold or intake) and "where does a finished plan get released to?" (hold). Under a
  renamed workflow every literal answer silently stops matching; after U11 deletes `triage`
  from the builtins they stop matching everywhere. Fail-soft to the legacy pair so an
  unresolvable or column-less workflow behaves exactly as before.
*/
/*
FNXC:WorkflowLifecycleColumns 2026-07-30-09:35 (Phase C convergence):
`wip` is returned alongside the two planner lanes because a caller that PROMOTES a card out
of planning needs both halves at once. Resolving the planner lane and then moving to a
literal `in-progress` is the half-conversion this program has already been burned by twice:
the guard starts admitting cards on a renamed board and the move then sends them to a column
that board does not declare — strictly worse than refusing, because the refusal was visible.
*/
export interface PlannerLanes {
  hold: string;
  intake: string;
  /*
  FNXC:WorkflowLifecycleColumns 2026-07-30-16:40 (PR #2628 review — greptile P1 x2):
  `wip`, `review` and `complete` are OPTIONAL, and that is the whole correction. The first
  version substituted the legacy id whenever a role was missing, so a workflow that declares
  columns but no WIP role got `moveTask(..., "in-progress")` — a column that board does not
  declare. The move is rejected, the caller reports failure, and the card can be left half-moved.
  A MISSING ROLE IS NOT A LICENCE TO INVENT A COLUMN; the caller must refuse instead.

  `resolvedFromWorkflow` distinguishes the two cases a single `?? legacy` collapsed:
    - false: no column vocabulary at all (v1 IR, unresolvable store). No basis to decide, so the
      legacy names ARE the answer and every role is populated.
    - true: the workflow speaks columns. Roles it does not declare stay undefined, because
      substituting there is the invention above.
  */
  wip: string | undefined;
  review: string | undefined;
  complete: string | undefined;
  /** True when the answer came from the task's workflow rather than the legacy fallback. */
  resolvedFromWorkflow: boolean;
}

const LEGACY_PLANNER_LANES: PlannerLanes = {
  hold: "todo",
  intake: "triage",
  wip: "in-progress",
  review: "in-review",
  complete: "done",
  resolvedFromWorkflow: false,
};

export function resolvePlannerLanes(store: TaskStore, taskId: string): PlannerLanes {
  try {
    const ir = (store as unknown as { resolveTaskWorkflowIrSync?: (id: string) => WorkflowIr }).resolveTaskWorkflowIrSync?.(taskId);
    const lifecycle = ir ? resolveLifecycleColumns(ir) : undefined;
    if (!lifecycle) return LEGACY_PLANNER_LANES;
    return {
      /*
      hold and intake still fall back INDIVIDUALLY: a workflow that declares columns but no hold
      column has its planning work rest in intake (and vice versa), which is a real shape rather
      than an invented column — both are planner lanes for the callers that ask. The forward
      lanes are different: a move needs a column that exists.
      */
      hold: lifecycle.hold ?? lifecycle.intake ?? "todo",
      intake: lifecycle.intake ?? lifecycle.hold ?? "triage",
      wip: lifecycle.wip,
      review: lifecycle.review,
      complete: lifecycle.complete,
      resolvedFromWorkflow: true,
    };
  } catch {
    return LEGACY_PLANNER_LANES;
  }
}

/**
 * The ASYNC twin of {@link resolvePlannerLanes}, and the one that actually resolves.
 *
 * FNXC:WorkflowLifecycleColumns 2026-07-31-23:10 (fleet — the sync resolver is a no-op):
 * `resolvePlannerLanes` reads `store.resolveTaskWorkflowIrSync`, whose selection reader returns
 * `undefined` unconditionally in PostgreSQL mode — the shipped backend. So it resolves the DEFAULT
 * workflow for every task and answers with the legacy ids no matter what board the card is on, while
 * reporting `resolvedFromWorkflow: true` because an IR did come back. A caller branching on that flag
 * is told the lanes are workflow-resolved and handed the defaults. Proven in
 * `core/src/__tests__/postgres/sync-workflow-ir-is-always-default.pg.test.ts`.
 *
 * Identical logic and identical fallbacks — the ONLY difference is awaiting the authoritative
 * resolver — so a caller in an async method can switch to this and get the same answers on the
 * default lineage and correct ones everywhere else.
 *
 * `cache` is caller-owned, matching `resolveTaskLifecycleColumns`: a sweep over many cards spanning
 * three workflows reads three IRs, not one per card.
 */
export async function resolvePlannerLanesForTaskAsync(
  store: TaskStore,
  taskId: string,
  cache?: Map<string, WorkflowIr>,
): Promise<PlannerLanes> {
  try {
    const ir = await resolveWorkflowIrForTask(store, taskId, cache);
    const lifecycle = ir ? resolveLifecycleColumns(ir) : undefined;
    if (!lifecycle) return LEGACY_PLANNER_LANES;
    return {
      /* Same individual hold/intake fallback as the sync twin — see the note there for why the
         forward lanes deliberately do NOT fall back. */
      hold: lifecycle.hold ?? lifecycle.intake ?? "todo",
      intake: lifecycle.intake ?? lifecycle.hold ?? "triage",
      wip: lifecycle.wip,
      review: lifecycle.review,
      complete: lifecycle.complete,
      resolvedFromWorkflow: true,
    };
  } catch {
    return LEGACY_PLANNER_LANES;
  }
}

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
  /*
  FNXC:WorkflowResolvedColumns 2026-07-31-11:45 (fleet — the four forward arms below):
  `lanes` carries the task's RESOLVED forward roles so the advancement test is a role question.

  CALLER-RESOLVED, deliberately. The sync twin `resolvePlannerLanes` reads
  `store.resolveTaskWorkflowIrSync`, which returns the DEFAULT workflow IR for every task under
  PostgreSQL — converting through it would score as progress while answering about a board the card
  is not on. The only caller is already `async`, so it resolves with
  `resolvePlannerLanesForTaskAsync` and passes the answer in.

  The default is `LEGACY_PLANNER_LANES`, which populates all four roles, so a caller that passes
  nothing preserves the built-in planning vocabulary.
  */
  roles: { mergedPlanningColumn?: string; lanes?: PlannerLanes } = { mergedPlanningColumn: "todo" },
): boolean {
  const lanes = roles.lanes ?? LEGACY_PLANNER_LANES;
  const advanced = [lanes.wip, lanes.review, lanes.complete];
  if (advanced.some((column) => column !== undefined && column === task.column)) {
    return true;
  }
  /*
  FNXC:WorkflowReplan 2026-07-26-06:10:
  A DURABLE parked-for-replan status outranks execution evidence, because that evidence is STICKY
  while a replan is a legitimate BACKWARD move. `firstExecutionAt`/`executionStartedAt` are never
  cleared once implementation starts, so a card that executed, failed Plan Review, and was rebounded
  to a planner lane (`needs-replan`) read as "advanced past planning" forever: triage's discovery
  filter (intake column AND `isTaskStillInPlanningStage`) never re-admitted it and the card sat
  parked in the intake lane with `needs-replan` permanently — "stuck in planning" on the board
  (FN-8594). It hit every workflow with a SEPARATE intake column (builtin:coding, the default at
  the time); plan-in-place cards escaped only because hold-lane discovery admits `needs-replan`
  without consulting this guard.
  This check covers BOTH planner lanes — the intake column and the plan-in-place hold lane.
  FNXC:WorkflowLifecycleColumns 2026-07-30-10:40: the column names in this note were the census
  pattern's only hits in this file; they were always prose about a filter that lives in triage.ts,
  never a guard here. Restated by ROLE so the history stays readable after a rename.
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
    "stranded-advanced" class — also excluded it, because it bails when the pinned column IS the
    card's own intake column (it cannot resume a card into the column it already sits in). Nobody
    owned the card and it sat indefinitely.
    Arrival order alone is the honest signal: a stamp written BEFORE the card reached the planner
    column belongs to a previous pass, whatever the status is now. A card that genuinely advanced
    out of the planner lane is caught by the column check at the top, and one that was claimed by execution
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

export async function resolveReplanTargetColumn(store: TaskStore, taskId: string): Promise<string | undefined> {
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

    U11 IMPACT — CORRECTED 2026-07-29-23:59. The note here previously said U11 deletes `todo` and
    keeps `triage`. It is the other way round: U11 chose "keep the id `todo`, delete `triage`" so
    that the ~120 `column === "todo"` guards kept their meaning and no data migration shipped. The
    default lineage now declares `todo, in-progress, in-review, done, archived` and NO `triage`.

    The lookups below are therefore correct today, but for the opposite reason to the one recorded:
    the default lineage FALLS THROUGH the `triage` lookup and lands on `todo`, which is its merged
    planning column and the right replan target. `triage` still matches for the workflows that
    genuinely declare it (Lead generation, PR review — where it is the intake/planning lane).

    FOLLOW-UP DONE (#2598), and this note is kept only so the history reads straight: the
    `return "triage"` fallbacks it flagged are gone. The no-match path now resolves the
    workflow's own planner lane and the throw path returns `undefined` rather than guessing a
    column, which is the stronger answer — an unresolvable workflow is a case callers must
    handle, not one to paper over with a plausible id. See the two blocks below.
    */
    if (workflowHasColumn(ir, "triage")) return "triage";
    if (workflowHasColumn(ir, "todo")) return "todo";
    /*
    FNXC:WorkflowReplan 2026-07-31-13:35 (U11 — the flagged fallback, now converted):
    Was `return "triage"`, naming a column this workflow does not declare AND that the
    DEFAULT lineage stopped declaring at #2515. A workflow with neither legacy planner
    id was therefore handed a nonexistent target, so the replan move either failed or
    put the card somewhere no sweep owns.

    `resolveReboundTarget` is the KTD-10 helper every other rebound path already uses
    (hold -> intake -> first declared), so the card lands in a column its own workflow
    declares and the replan lanes stay consistent with the rebound lanes.
    */
    /*
    FNXC:ReplanTargetR7 2026-07-31-15:30 (CORRECTS my own #2659, superseded by #2598):
    PREFER HOLD, THEN INTAKE, THEN NOTHING — never an arbitrary column.

    #2659 (mine) used `resolveReboundTarget`, whose third fallback is "first declared
    column". For a wip-only workflow that returns the WIP column, so a needs-replan
    card would be moved INTO an execution lane where the scheduler can pick it up
    against the spec that was just rejected. That is worse than the literal it
    replaced, and #2598's review surfaced it.

    Hold before intake is deliberate: Coding (Ideas) declares `ideas` as its intake
    and `ideas` is manual capture with NO AI, so a rejected plan sent there stops
    being replanned at all. The old literal got Ideas right by accident — it never
    recognised `ideas` as intake and fell through to `todo`.

    `undefined` means "this workflow declares nowhere to replan"; callers park the
    card visibly rather than reporting a move that did not happen.
    */
    const roles = resolveLifecycleColumns(ir);
    return roles?.hold ?? roles?.intake;
  } catch {
    /*
    Unreachable in practice: `resolveWorkflowIrForTask` is TOTAL — every failure path
    returns the default coding IR rather than throwing. Kept as belt-and-braces and
    documented so nobody writes a test for a state that cannot occur.
    */
    return undefined;
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
 * orphaned. Planning now preserves this metadata without acquiring or touching the checkout;
 * the next write-capable execution node resumes through `ensureGraphCustomNodeWorktree` ->
 * `acquireTaskWorktree`. Clearing the pointer would make that execution entry skip its resume
 * branch, collide with the still-checked-out task branch, and destructively recreate the checkout.
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
export type ReplanMoveContainedResult = {
  moved: false;
  reason: "review-lane-source";
  column: string;
};

export async function moveTaskToReplanColumn(
  store: TaskStore,
  task: Pick<Task, "id" | "column">,
  reason: "plan-review-revise-replan",
  target?: string,
  options?: { workflowMoveSource?: string },
): Promise<string | undefined | ReplanMoveContainedResult> {
  const liveTask = typeof store.getTask === "function"
    ? await Promise.resolve(store.getTask(task.id)).catch(() => task as Task)
    : task;
  const liveColumn = liveTask.column;
  const workflowIr = await resolveWorkflowIrForTask(store, task.id).catch(() => undefined);
  const sourceColumn = workflowIr?.version === "v2"
    ? workflowIr.columns.find((column) => column.id === liveColumn)
    : undefined;

  /*
  FNXC:LifecycleContainment 2026-08-28-01:53:
  FN-207 contains replanning inside its owning stage. A live review card cannot jump to Planning;
  Code Review repairs route through WIP, while review-convergence and blocked-exit callers keep their
  human-visible park in review. The live row is re-read here so a stale caller snapshot cannot bypass
  containment. Legal WIP-to-hold replans are explicitly engine-sourced and carry a registered reason.
  */
  if (sourceColumn && classifyLifecycleRole(resolveColumnFlags(sourceColumn)) === "review") {
    const message = `Replan requested while in '${liveColumn}' — contained in place; the review lane repairs forward through the implementation lane`;
    schedulerLog.warn(`${task.id}: ${message}`);
    if (typeof store.logEntry === "function") {
      await store.logEntry(task.id, message).catch(() => undefined);
    }
    return { moved: false, reason: "review-lane-source", column: liveColumn };
  }

  const replanColumn = target ?? await resolveReplanTargetColumn(store, task.id);
  /*
  FNXC:ReplanTargetR7 2026-07-31-15:35 (PR #2598):
  NO DECLARED REPLAN COLUMN: do NOT move, and say so. Every caller treats the return
  value as "where the card now is", so a silent no-op would be a lie — returning
  `undefined` forces the caller to state the outcome instead of assuming one.
  */
  if (!replanColumn) {
    schedulerLog.warn(
      `${task.id}: replan rebound skipped — the task's workflow declares no intake or hold `
      + `column to replan in; card left in ${liveColumn}`,
    );
    return undefined;
  }
  if (liveColumn !== replanColumn) {
    const result = await moveTaskWithLifecycleReason(store, task.id, replanColumn as Task["column"], reason, {
      preserveWorktree: true,
      moveSource: "engine",
      ...(options?.workflowMoveSource ? { workflowMoveSource: options.workflowMoveSource } : {}),
    });
    if (!result.moved) return undefined;
  }
  return replanColumn;
}
