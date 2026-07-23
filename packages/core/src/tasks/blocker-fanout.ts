import {
  HIGH_FANOUT_BLOCKER_TODO_THRESHOLD,
  STALE_HIGH_FANOUT_BLOCKER_AGE_THRESHOLD_MS,
  type Task,
} from "../types.js";

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
}

export const BLOCKER_ESCALATION_COLUMNS = new Set<Task["column"]>(["in-progress", "in-review"]);

const ACTIVE_COLUMNS = new Set<Task["column"]>(["triage", "todo", "in-progress", "in-review"]);

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
    const active = ACTIVE_COLUMNS.has(task.column);
    const isTodo = task.column === "todo";

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
