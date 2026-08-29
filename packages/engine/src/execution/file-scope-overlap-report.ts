import type { Settings, Task } from "@fusion/core";
import {
  filterPathsByIgnoreList,
  findFileScopeOverlaps,
  type FileScopeOverlapMatch,
} from "../scheduler.js";

export type FileScopeOverlapBlockerReason = "ok" | "no-overlap-blocker" | "blocker-not-found" | "no-overlap";

export interface FileScopeOverlapBlockerReport {
  taskId: string;
  blockerId: string | null;
  blockerColumn: string | null;
  reason: FileScopeOverlapBlockerReason;
  taskScopeCount: number;
  blockerScopeCount: number;
  overlaps: FileScopeOverlapMatch[];
}

export interface FileScopeOverlapBlockerStore {
  getTask(taskId: string): Promise<Task | undefined>;
  getSettings(): Promise<Settings>;
  parseFileScopeFromPrompt(taskId: string): Promise<string[]>;
}

/**
 * Explain an existing scheduler overlap blocker using the same prompt scopes and project ignore
 * policy used during scheduling. This is read-only reporting, never a blocker repair path.
 */
export async function describeFileScopeOverlapBlocker(
  store: FileScopeOverlapBlockerStore,
  taskId: string,
): Promise<FileScopeOverlapBlockerReport> {
  const task = await store.getTask(taskId);
  if (!task?.overlapBlockedBy) {
    return {
      taskId,
      blockerId: null,
      blockerColumn: null,
      reason: "no-overlap-blocker",
      taskScopeCount: 0,
      blockerScopeCount: 0,
      overlaps: [],
    };
  }

  const blocker = await store.getTask(task.overlapBlockedBy);
  if (!blocker) {
    return {
      taskId,
      blockerId: task.overlapBlockedBy,
      blockerColumn: null,
      reason: "blocker-not-found",
      taskScopeCount: 0,
      blockerScopeCount: 0,
      overlaps: [],
    };
  }

  const settings = await store.getSettings();
  const options = { ignoreHiddenOverlapPaths: settings.ignoreHiddenOverlapPaths };
  const [taskScope, blockerScope] = await Promise.all([
    store.parseFileScopeFromPrompt(task.id),
    store.parseFileScopeFromPrompt(blocker.id),
  ]);
  const filteredTaskScope = filterPathsByIgnoreList(taskScope, settings.overlapIgnorePaths ?? [], options);
  const filteredBlockerScope = filterPathsByIgnoreList(blockerScope, settings.overlapIgnorePaths ?? [], options);
  const overlaps = findFileScopeOverlaps(filteredTaskScope, filteredBlockerScope);

  return {
    taskId: task.id,
    blockerId: blocker.id,
    blockerColumn: blocker.column,
    reason: overlaps.length > 0 ? "ok" : "no-overlap",
    taskScopeCount: filteredTaskScope.length,
    blockerScopeCount: filteredBlockerScope.length,
    overlaps,
  };
}
