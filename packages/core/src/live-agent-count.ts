import { ACTIVE_MERGE_PIPELINE_STATUSES } from "./active-merge-status.js";
import type { TraitFlags } from "./trait-types.js";
import type { Task } from "./types.js";
import type { WorkflowIr } from "./workflow-ir-types.js";
import { columnHasFlag } from "./workflow-lifecycle-traits.js";

export type RunningAgentCountSource = (projectIds: readonly string[]) => Promise<Record<string, number>> | Record<string, number>;

/** Terminal classification supplied by a workflow-IR or board-flags enricher. */
export type ColumnTerminalKind = "none" | "complete" | "archived";

/**
 * The deliberately small, pure shape used by all top-level live-agent counts.
 * Store- and board-backed callers must attach trait-derived fields first.
 */
export type RunningAgentTaskShape = Pick<Task, "column" | "status" | "paused" | "userPaused" | "sessionFile" | "checkedOutBy"> & Partial<Pick<Task, "workflowStepResults">> & {
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
  if (columnHasFlag(ir, columnId, "archived")) return "archived";
  if (columnHasFlag(ir, columnId, "complete")) return "complete";
  return "none";
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
export function enrichRunningAgentTaskShapeFromFlags<T extends RunningAgentTaskShape>(task: T, flags?: Pick<TraitFlags, "complete" | "archived" | "intake" | "hold" | "countsTowardWip" | "mergeOrchestration" | "mergeBlocker">): T & Required<Pick<RunningAgentTaskShape, "columnTerminalKind" | "columnIsIntakeOrHold" | "columnCountsTowardWip" | "columnIsReviewOrMerge">> {
  return {
    ...task,
    columnTerminalKind: flags?.archived ? "archived" : flags?.complete ? "complete" : "none",
    columnIsIntakeOrHold: flags ? flags.intake === true || flags.hold === true : task.column === "triage" || task.column === "todo",
    columnCountsTowardWip: flags ? flags.countsTowardWip === true : task.column === "in-progress",
    /*
    FNXC:WorkflowLifecycleColumns 2026-07-30-05:00 (triage-guard census — DO NOT converge these to zero):
    THE LITERAL FALLBACKS ARE REACHABLE IN PRODUCTION. An earlier note claimed they were
    "fixture-only; board/store callers always supply flags/IR". Measured, that is false on two counts:
      - `cli/src/commands/project.ts` calls `countRunningAgentTasks(tasks)` on UNENRICHED rows — it
        never calls an enrich helper at all;
      - both dashboard callers pass a possibly-undefined lookup
        (`columnFlagsByTaskId?.get(id) ?? columnFlagsById?.get(column)` in useExecutorStats,
        `columnFlags` in Column.tsx), so a board mid-load, or a column id absent from the map, lands
        here — the renamed or undeclared column case.

    WHY `"triage"` STAYS despite the census. This branch runs precisely when NO role information is
    available, so it cannot resolve by trait; a literal is the only thing expressible. It must
    therefore cover BOTH vocabularies: the merged default column (`todo`, post-#2515) AND a legacy or
    custom workflow that still declares `triage` (a legal column id per KTD-8). Deleting the `triage`
    half to drive the census to zero would make every legacy-board card silently stop counting as
    waiting — the exact silent-non-firing failure the census exists to eliminate, introduced in the
    name of closing it.

    Nor is narrowing it safe in the other direction: with an absent flag set, "not intake" is as much
    a guess as "todo is intake", and either choice moves an operator-visible count (a card matching no
    arm is counted as neither running nor waiting, so the footer under-reports it).

    The right way to remove these is to make role information MANDATORY at the call sites — a
    dashboard-loading change, not a vocabulary change. Supply flags rather than relying on these.
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

function terminalKind(task: RunningAgentTaskShape): ColumnTerminalKind {
  // FNXC:WorkflowColumns 2026-07-29-20:30: not fixture-only — see the note in
  // enrichRunningAgentTaskShapeFromFlags. This is the no-role-information fallback and
  // it is reached by the CLI's unenriched count and by dashboard boards mid-load.
  return task.columnTerminalKind ?? (task.column === "done" ? "complete" : task.column === "archived" ? "archived" : "none");
}

/**
 * Returns true only for a live, unpaused top-level agent.
 * Planning may run in any non-terminal workflow column. Unpaused WIP columns
 * count as execute holders (sessionFile is not on the board/DB row path).
 * Active review/merge statuses count only in review/merge columns.
 * A live `pending` workflow-step lease (e.g. an in-flight Code Review gate)
 * counts in any non-terminal column, since gate sessions run with null status.
 */
export function isRunningAgentTask(task: RunningAgentTaskShape): boolean {
  if (task.paused || task.userPaused || terminalKind(task) !== "none") return false;
  if (task.status === "planning") return true;
  // Review statuses are not globally live: a stale status in intake/WIP must not consume capacity.
  if (ACTIVE_IN_REVIEW_AGENT_STATUSES.has(String(task.status ?? ""))) {
    return task.columnIsReviewOrMerge ?? task.column === "in-review";
  }
  // A live gate-session lease (pending step result) is Running even with a null status.
  if (hasLiveWorkflowStepLease(task)) return true;
  const isWip = task.columnCountsTowardWip ?? task.column === "in-progress";
  return isWip;
}

/** Exact footer waiting membership: unpaused, non-terminal intake/hold work that is not live. */
export function isWaitingAgentTask(task: RunningAgentTaskShape): boolean {
  if (task.paused || task.userPaused || terminalKind(task) !== "none" || isRunningAgentTask(task)) return false;
  return task.columnIsIntakeOrHold ?? (task.column === "triage" || task.column === "todo");
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
