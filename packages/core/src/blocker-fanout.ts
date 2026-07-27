import {
  HIGH_FANOUT_BLOCKER_TODO_THRESHOLD,
  STALE_HIGH_FANOUT_BLOCKER_AGE_THRESHOLD_MS,
  type Task,
} from "./types.js";

export interface BlockerEscalation {
  blockerId: string;
  activeTodoCount: number;
  totalActiveCount: number;
  blockingAgeMs: number;
}

export interface BlockerFanoutEntry {
  totalCount: number;
  activeTodoCount: number;
  dependentIds: string[];
  dependencyDependentIds: string[];
  overlapBlockedDependentIds: string[];
  overlapBlockedActiveCount: number;
  overlapBlockedTodoCount: number;
  staleBlockedByDependentIds: string[];
  isHighFanout: boolean;
  escalation?: BlockerEscalation;
}

export interface ComputeBlockerFanoutOptions {
  nowMs?: number;
  highFanoutTodoThreshold?: number;
  staleHighFanoutAgeThresholdMs?: number;
  /*
  FNXC:WorkflowLifecycleColumns 2026-07-27-21:50 (Phase B / U6):
  The workflow's TERMINAL columns (complete + archived). "Active" is defined by
  exclusion — not complete, not archived — which is what the concept always
  meant; the old `ACTIVE_COLUMNS` enumeration was a default-workflow-shaped
  stand-in that silently scored 0 active dependents for every column a custom
  workflow adds. Under-counting, not erroring: a blocker with real blocked
  dependents looked unblocking, and no test failed.
  Defaults to the legacy `{done, archived}` so existing callers are unchanged.
  Callers resolving the IR pass `[complete, archived]` from
  `resolveLifecycleColumns`.
  */
  terminalColumns?: ReadonlySet<string>;
  /** The workflow's HOLD (capacity-wait) column. The fan-out metric counts cards
   *  waiting for capacity, which is the hold role — `todo` is only the id the
   *  built-in coding workflow gives it. Defaults to `"todo"`. */
  holdColumn?: string;
  /*
  FNXC:WorkflowLifecycleColumns 2026-07-28-03:05 (PR #2470 review, P1):
  PLURAL form, for callers computing over a board that spans MORE THAN ONE
  workflow. `holdColumn` assumes a single vocabulary, which is wrong for the
  board-wide backlog-health reporter: a project running two workflows has two
  hold columns, and collapsing them to one silently drops every card held by the
  other. Takes precedence over `holdColumn` when supplied; when neither is given
  the legacy `"todo"` applies, so existing callers are byte-identical.
  */
  holdColumns?: ReadonlySet<string>;
}

export const BLOCKER_ESCALATION_COLUMNS = new Set<Task["column"]>(["in-progress", "in-review"]);

/** Legacy default: the built-in coding workflow's terminal columns. Retained as
 *  the fallback so an un-resolved caller keeps byte-identical behavior (R11). */
const DEFAULT_TERMINAL_COLUMNS: ReadonlySet<string> = new Set(["done", "archived"]);

interface MutableEntry {
  dependentIds: string[];
  dependencyDependentIds: string[];
  blockedByDependentIds: string[];
  activeCount: number;
  activeTodoCount: number;
  overlapBlockedActiveCount: number;
  overlapBlockedTodoCount: number;
}

export function isStaleBlockedByBlocker(blocker: Task | undefined, maxAutoMergeRetries: number): boolean {
  if (!blocker) return true;
  if (blocker.column === "done" || blocker.column === "archived") return true;
  if (blocker.column === "in-review" && blocker.paused === true) return true;
  if (blocker.column === "in-review" && blocker.status === "failed" && (blocker.mergeRetries ?? 0) >= maxAutoMergeRetries) {
    return true;
  }
  return false;
}

function getBlockingAgeMs(blocker: Task, nowMs: number): number {
  const startedAt = Date.parse(blocker.columnMovedAt ?? blocker.updatedAt);
  if (!Number.isFinite(startedAt)) return 0;
  return Math.max(0, nowMs - startedAt);
}

export function computeBlockerFanoutMap(
  tasks: Task[],
  maxAutoMergeRetries: number,
  options: ComputeBlockerFanoutOptions = {},
): Map<string, BlockerFanoutEntry> {
  const nowMs = options.nowMs ?? Date.now();
  const highFanoutTodoThreshold =
    options.highFanoutTodoThreshold ?? HIGH_FANOUT_BLOCKER_TODO_THRESHOLD;
  const staleHighFanoutAgeThresholdMs =
    options.staleHighFanoutAgeThresholdMs ?? STALE_HIGH_FANOUT_BLOCKER_AGE_THRESHOLD_MS;

  const terminalColumns = options.terminalColumns ?? DEFAULT_TERMINAL_COLUMNS;
  /* Plural wins; else the singular; else the legacy id. One resolved set so the
     two spellings cannot disagree downstream. */
  const holdColumns: ReadonlySet<string> =
    options.holdColumns ?? new Set([options.holdColumn ?? "todo"]);

  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const fanout = new Map<string, MutableEntry>();

  const ensureEntry = (blockerId: string): MutableEntry => {
    let entry = fanout.get(blockerId);
    if (!entry) {
      entry = {
        dependentIds: [],
        dependencyDependentIds: [],
        blockedByDependentIds: [],
        activeCount: 0,
        activeTodoCount: 0,
        overlapBlockedActiveCount: 0,
        overlapBlockedTodoCount: 0,
      };
      fanout.set(blockerId, entry);
    }
    return entry;
  };

  for (const task of tasks) {
    // Active by EXCLUSION (see terminalColumns above), not by enumeration.
    const active = !terminalColumns.has(task.column);
    const isTodo = holdColumns.has(task.column);

    for (const depId of task.dependencies ?? []) {
      if (!depId) continue;
      const entry = ensureEntry(depId);
      entry.dependentIds.push(task.id);
      entry.dependencyDependentIds.push(task.id);
      if (active) entry.activeCount += 1;
      if (isTodo) entry.activeTodoCount += 1;
    }

    if (task.blockedBy) {
      const entry = ensureEntry(task.blockedBy);
      entry.dependentIds.push(task.id);
      entry.blockedByDependentIds.push(task.id);
      if (active) {
        entry.activeCount += 1;
        entry.overlapBlockedActiveCount += 1;
      }
      if (isTodo) {
        entry.activeTodoCount += 1;
        entry.overlapBlockedTodoCount += 1;
      }
    }
  }

  const result = new Map<string, BlockerFanoutEntry>();
  for (const [blockerId, entry] of fanout) {
    const blocker = taskById.get(blockerId);
    const staleBlockedByDependentIds = isStaleBlockedByBlocker(blocker, maxAutoMergeRetries)
      ? [...entry.blockedByDependentIds]
      : [];

    const isHighFanout = entry.overlapBlockedTodoCount >= highFanoutTodoThreshold;
    const blockingAgeMs = blocker ? getBlockingAgeMs(blocker, nowMs) : 0;
    const blockerColumn = blocker?.column;
    const shouldEscalate =
      blockerColumn !== undefined &&
      isHighFanout &&
      BLOCKER_ESCALATION_COLUMNS.has(blockerColumn) &&
      blockingAgeMs >= staleHighFanoutAgeThresholdMs;

    result.set(blockerId, {
      totalCount: entry.activeCount,
      activeTodoCount: entry.activeTodoCount,
      dependentIds: entry.dependentIds,
      dependencyDependentIds: entry.dependencyDependentIds,
      overlapBlockedDependentIds: entry.blockedByDependentIds,
      overlapBlockedActiveCount: entry.overlapBlockedActiveCount,
      overlapBlockedTodoCount: entry.overlapBlockedTodoCount,
      staleBlockedByDependentIds,
      isHighFanout,
      escalation: shouldEscalate
        ? {
            blockerId,
            activeTodoCount: entry.overlapBlockedTodoCount,
            totalActiveCount: entry.overlapBlockedActiveCount,
            blockingAgeMs,
          }
        : undefined,
    });
  }

  return result;
}
