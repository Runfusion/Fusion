import { ACTIVE_MERGE_PIPELINE_STATUSES } from "../merge/active-merge-status.js";
import type { TraitFlags } from "../workflows/trait-types.js";
import type { Task } from "../types.js";
import type { WorkflowIr } from "../workflows/workflow-ir-types.js";
import { columnHasFlag } from "../workflows/workflow-lifecycle-traits.js";
import { isTaskExternallyBlocked } from "../tasks/task-external-block.js";

export type RunningAgentCountSource = (projectIds: readonly string[]) => Promise<Record<string, number>> | Record<string, number>;

/** Terminal classification supplied by a workflow-IR or board-flags enricher. */
export type ColumnTerminalKind = "none" | "complete";

/**
 * The deliberately small, pure shape used by all top-level live-agent counts.
 * Store- and board-backed callers must attach trait-derived fields first.
 */
export type RunningAgentTaskShape = Pick<Task, "column" | "status" | "paused" | "userPaused" | "sessionFile" | "checkedOutBy"> & Partial<Pick<Task, "workflowStepResults" | "externalBlock">> & {
  columnTerminalKind?: ColumnTerminalKind;
  /** Trait-derived intake/hold membership, used by {@link isWaitingAgentTask}. */
  columnIsIntakeOrHold?: boolean;
  /** Trait-derived WIP membership; legacy fixtures fall back to in-progress. */
  columnCountsTowardWip?: boolean;
  /** Trait-derived review/merge membership; active merge statuses are live only here. */
  columnIsReviewOrMerge?: boolean;
};

/*
FNXC:ConcurrencyIndicators 2026-08-03-12:00:
FN-8453 / GitHub #2359 defines Running as a live top-level working agent, not a
board-column or worktree-holder count. Every production store- or board-backed
consumer enriches this pure shape from workflow traits before it counts; the
literal terminal fallback exists only for legacy fixtures while no IR is loaded.

FNXC:ConcurrencyIndicators 2026-07-21-19:00:
Unpaused WIP membership is sufficient for execute Running. sessionFile is not a
persisted task column (absent from TaskRow, listTasks slim, and board payloads),
so requiring sessionFile/checkedOutBy undercounted footer Running (e.g. 1 of 23)
and under-claimed admission capacity. Pause/user-pause and terminal traits still
exclude parked shells; durable session/checkout remain optional positive signals
but are not required for WIP.
*/
const ACTIVE_IN_REVIEW_AGENT_STATUSES = new Set([
  ...ACTIVE_MERGE_PIPELINE_STATUSES,
  "fixing",
]);

let runningAgentCountSource: RunningAgentCountSource | undefined;

export function setRunningAgentCountSource(fn: RunningAgentCountSource | undefined): void {
  runningAgentCountSource = fn;
}

export function getRunningAgentCountSource(): RunningAgentCountSource | undefined {
  return runningAgentCountSource;
}

export interface RunningAgentCounts {
  currentlyActive: number;
  projectsActive: Record<string, number>;
}

/** Resolve the terminal classification of one column from its workflow IR. */
export function resolveColumnTerminalKind(columnId: string, ir: WorkflowIr): ColumnTerminalKind {
  if (columnHasFlag(ir, columnId, "complete")) return "complete";
  return "none";
}

/*
FNXC:WorkflowLifecycleColumns 2026-07-30-10:20 (Phase C convergence — live-agent-count.ts):

THE PRE-IMPLEMENTATION FALLBACK, named once instead of spelled out at two call sites.

DELIBERATE-LITERAL, and the reason is not "we ran out of time": this is the answer used when
the caller supplies NO trait flags at all. There is nothing to resolve from. `enrich...FromFlags`
exists precisely for callers that have board-column flags rather than an IR (the dashboard
footer), and a column missing from that flag map is the renamed-or-undeclared case.

Converting it would mean deciding what an ABSENT flag set means, and "not intake" is as much a
guess as "todo is intake" — either choice silently moves an operator-visible count. The two
counts this feeds (Running and Waiting) are complements over the same rows, so a card matching
neither arm is reported as neither running nor waiting and the footer's queued total
under-reports it. Guessing here is worse than the known legacy answer.

The real fix for a renamed board is at the CALLER: supply flags (or use
`enrichRunningAgentTaskShape`, which takes the IR and resolves every role by trait). This
fallback only has to keep behaving exactly as it did for legacy rows.

Both former literal sites now share this function, so the pair cannot drift apart — they were
two hand-written copies of one rule, and line 84 answering differently from line 143 would put
a card in both counts or neither.
*/
const LEGACY_PRE_IMPLEMENTATION_COLUMN_IDS: ReadonlySet<string> = new Set(["triage", "todo"]);
const LEGACY_WIP_COLUMN_ID = "in-progress";

/** Legacy-vocabulary "is this column a planner lane?", for callers that supply no traits. */
function isLegacyPreImplementationColumn(columnId: string): boolean {
  return LEGACY_PRE_IMPLEMENTATION_COLUMN_IDS.has(columnId);
}

/** Attach the workflow traits required by the pure Running and Waiting predicates. */
export function enrichRunningAgentTaskShape<T extends RunningAgentTaskShape>(task: T, ir: WorkflowIr): T & Required<Pick<RunningAgentTaskShape, "columnTerminalKind" | "columnIsIntakeOrHold" | "columnCountsTowardWip" | "columnIsReviewOrMerge">> {
  return {
    ...task,
    columnTerminalKind: resolveColumnTerminalKind(task.column, ir),
    columnIsIntakeOrHold: columnHasFlag(ir, task.column, "intake") || columnHasFlag(ir, task.column, "hold"),
    columnCountsTowardWip: columnHasFlag(ir, task.column, "countsTowardWip"),
    columnIsReviewOrMerge: columnHasFlag(ir, task.column, "mergeOrchestration") || columnHasFlag(ir, task.column, "mergeBlocker"),
  };
}

/** Attach the same traits from dashboard board-column flags without loading an IR. */
/*
FNXC:ConcurrencyIndicators 2026-07-30-03:40 DELIBERATE-LITERAL: the no-enrichment fallback only.
Every literal below sits after a `??` or a `flags ? … :` — it is reached ONLY when the caller
supplied no trait flags and no enriched shape, which is the case the enrichers exist to remove.
There is nothing to resolve from in that state, so converting is not possible; the choice is only
between the known legacy answer and a different guess.

That choice is not neutral here. Running and Waiting are COMPLEMENTS over the same rows, so a card
matching neither arm is reported as neither running nor waiting and the footer's queued total
silently under-reports it. Guessing "not WIP" or "not review" is therefore worse than the legacy id,
which at least matches every pre-rename board.

The fix for a renamed board is at the CALLER — pass flags, or use `enrichRunningAgentTaskShape`,
which takes the IR and resolves every role by trait. Same reasoning as the marker above
`isLegacyPreImplementationColumn`, which this file already records.
*/
export function enrichRunningAgentTaskShapeFromFlags<T extends RunningAgentTaskShape>(task: T, flags?: Pick<TraitFlags, "complete" | "intake" | "hold" | "countsTowardWip" | "mergeOrchestration" | "mergeBlocker">): T & Required<Pick<RunningAgentTaskShape, "columnTerminalKind" | "columnIsIntakeOrHold" | "columnCountsTowardWip" | "columnIsReviewOrMerge">> {
  return {
    ...task,
    columnTerminalKind: flags?.complete ? "complete" : "none",
    columnIsIntakeOrHold: flags ? flags.intake === true || flags.hold === true : isLegacyPreImplementationColumn(task.column),
    columnCountsTowardWip: flags ? flags.countsTowardWip === true : task.column === LEGACY_WIP_COLUMN_ID,
    /*
    FNXC:WorkflowLifecycleColumns 2026-07-29-23:10 (reason now at
    `isLegacyPreImplementationColumn`): these id fallbacks are REACHABLE, not fixture-only —
    a column absent from the board's flag map is the renamed-or-undeclared case. Supply flags
    rather than relying on them.
    */
    columnIsReviewOrMerge: flags ? flags.mergeOrchestration === true || flags.mergeBlocker === true : task.column === "in-review",
  };
}

/*
FNXC:ConcurrencyIndicators 2026-07-22-05:45:
Lane-owned optional gates (Code Review / Browser Verification / Plan Review) run their reviewer
session with task.status left null — the durable live signal is the step's `pending`
workflow-step-result lease (U3/KTD-4; FN-8492 fails orphaned leases, so pending ≈ live).
Without counting it, an In Review column with one MERGING task and one live CODE REVIEW task
showed 1/2 processing, and admission under-counted the live reviewer. A pending lease on an
unpaused, non-terminal row counts as Running everywhere the shared predicate is used.
*/
function hasLiveWorkflowStepLease(task: RunningAgentTaskShape): boolean {
  return task.workflowStepResults?.some((result) => result.status === "pending") === true;
}

/*
FNXC:ConcurrencyIndicators 2026-07-30-03:40 DELIBERATE-LITERAL: the no-enrichment fallback only.
Full rationale at the first marker of this name above (enrichRunningAgentTaskShapeFromFlags): these
legacy-id literals are the flag-less fallback the enrichers exist to remove; converting here would
guess, and a wrong guess under-reports the queued total. Fix at the CALLER by passing flags/IR.
*/
function terminalKind(task: RunningAgentTaskShape): ColumnTerminalKind {
  // Legacy literals are intentionally fixture-only degradation when workflow IR is unavailable.
  return task.columnTerminalKind ?? (task.column === "done" ? "complete" : "none");
}

/**
 * Returns true only for a live, unpaused top-level agent.
 * Planning may run in any non-terminal workflow column. Unpaused WIP columns
 * count as execute holders (sessionFile is not on the board/DB row path).
 * Active review/merge statuses count only in review/merge columns.
 * A live `pending` workflow-step lease (e.g. an in-flight Code Review gate)
 * counts in any non-terminal column, since gate sessions run with null status.
 * A parked `failed` row never counts, even in WIP — failed WIP is operator-
 * visible debris, not a live agent (must not consume maxWorktrees/maxConcurrent).
 */
/*
FNXC:ConcurrencyIndicators 2026-07-30-03:40 DELIBERATE-LITERAL: the no-enrichment fallback only.
Full rationale at the first marker of this name above (enrichRunningAgentTaskShapeFromFlags): these
legacy-id literals are the flag-less fallback the enrichers exist to remove; converting here would
guess, and a wrong guess under-reports the queued total. Fix at the CALLER by passing flags/IR.
*/
export function isRunningAgentTask(task: RunningAgentTaskShape): boolean {
  if (terminalKind(task) !== "none") return false;
  /*
  FNXC:ExternalBlock 2026-08-28-04:01:
  A non-terminal external block deliberately remains a capacity holder even though its durable
  pause fence prevents execution. Keeping maxConcurrent and maxWorktrees occupied ensures another
  card cannot take the worktree slot the operator expects Retry to resume onto.
  */
  if (isTaskExternallyBlocked(task)) return true;
  if (task.paused || task.userPaused) return false;
  /*
  FNXC:ConcurrencyIndicators 2026-08-01-19:22:
  Failed WIP parks (honest-blocked, graph parse failure, exhausted recovery) remain in the
  WIP column until an operator or rebound moves them, but they are not live agents. Counting
  them filled maxWorktrees/maxConcurrent and blocked ready work (e.g. FN-8704 sitting
  in-progress/failed while todos waited on capacity). Match review-lane semantics, which
  already exclude status:"failed" from active merge holders.
  */
  if (task.status === "failed") return false;
  if (task.status === "planning") return true;
  // Review statuses are not globally live: a stale status in intake/WIP must not consume capacity.
  if (ACTIVE_IN_REVIEW_AGENT_STATUSES.has(String(task.status ?? ""))) {
    return task.columnIsReviewOrMerge ?? task.column === "in-review";
  }
  // A live gate-session lease (pending step result) is Running even with a null status.
  if (hasLiveWorkflowStepLease(task)) return true;
  const isWip = task.columnCountsTowardWip ?? task.column === LEGACY_WIP_COLUMN_ID;
  return isWip;
}

/** Exact footer waiting membership: unpaused, non-terminal intake/hold work that is not live. */
export function isWaitingAgentTask(task: RunningAgentTaskShape): boolean {
  if (isTaskExternallyBlocked(task) || task.paused || task.userPaused || terminalKind(task) !== "none" || isRunningAgentTask(task)) return false;
  return task.columnIsIntakeOrHold ?? isLegacyPreImplementationColumn(task.column);
}

export function countRunningAgentTasks(tasks: readonly RunningAgentTaskShape[]): number {
  return tasks.filter(isRunningAgentTask).length;
}

export function deriveRunningAgentCounts(perProject: Record<string, number>): RunningAgentCounts {
  const projectsActive: Record<string, number> = {};
  let currentlyActive = 0;
  for (const [projectId, rawCount] of Object.entries(perProject)) {
    const count = Number.isFinite(rawCount) ? Math.max(0, Math.trunc(rawCount)) : 0;
    currentlyActive += count;
    if (count > 0) projectsActive[projectId] = count;
  }
  return { currentlyActive, projectsActive };
}


