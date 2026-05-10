import { useMemo } from "react";
import type { Task } from "@fusion/core";

export interface BlockerFanoutEntry {
  totalCount: number;
  activeTodoCount: number;
  dependentIds: string[];
  staleBlockedByDependentIds: string[];
}

// Keep in sync with packages/engine/src/self-healing.ts
export const MAX_AUTO_MERGE_RETRIES = 3;

const ACTIVE_COLUMNS = new Set<Task["column"]>(["triage", "todo", "in-progress", "in-review"]);

function isStaleBlockedByBlocker(blocker: Task | undefined): boolean {
  if (!blocker) {
    return true;
  }

  if (blocker.column === "done" || blocker.column === "archived") {
    return true;
  }

  if (blocker.column === "in-review" && blocker.paused === true) {
    return true;
  }

  if (
    blocker.column === "in-review" &&
    blocker.status === "failed" &&
    (blocker.mergeRetries ?? 0) >= MAX_AUTO_MERGE_RETRIES
  ) {
    return true;
  }

  return false;
}

interface MutableEntry {
  dependentIds: string[];
  blockedByDependentIds: string[];
  activeCount: number;
  activeTodoCount: number;
}

export function computeBlockerFanoutMap(tasks: Task[]): Map<string, BlockerFanoutEntry> {
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const fanout = new Map<string, MutableEntry>();

  const ensureEntry = (blockerId: string): MutableEntry => {
    let entry = fanout.get(blockerId);
    if (!entry) {
      entry = { dependentIds: [], blockedByDependentIds: [], activeCount: 0, activeTodoCount: 0 };
      fanout.set(blockerId, entry);
    }
    return entry;
  };

  for (const task of tasks) {
    const active = ACTIVE_COLUMNS.has(task.column);
    const isTodo = task.column === "todo";

    const dependencyIds = task.dependencies ?? [];
    for (const depId of dependencyIds) {
      if (!depId) continue;
      const entry = ensureEntry(depId);
      entry.dependentIds.push(task.id);
      if (active) entry.activeCount += 1;
      if (isTodo) entry.activeTodoCount += 1;
    }

    if (task.blockedBy) {
      const entry = ensureEntry(task.blockedBy);
      entry.dependentIds.push(task.id);
      entry.blockedByDependentIds.push(task.id);
      if (active) entry.activeCount += 1;
      if (isTodo) entry.activeTodoCount += 1;
    }
  }

  const result = new Map<string, BlockerFanoutEntry>();
  for (const [blockerId, entry] of fanout) {
    const blocker = taskById.get(blockerId);
    const staleBlockedByDependentIds = isStaleBlockedByBlocker(blocker)
      ? [...entry.blockedByDependentIds]
      : [];

    result.set(blockerId, {
      totalCount: entry.activeCount,
      activeTodoCount: entry.activeTodoCount,
      dependentIds: entry.dependentIds,
      staleBlockedByDependentIds,
    });
  }

  return result;
}

export function useBlockerFanout(tasks: Task[]): Map<string, BlockerFanoutEntry> {
  return useMemo(() => computeBlockerFanoutMap(tasks), [tasks]);
}
