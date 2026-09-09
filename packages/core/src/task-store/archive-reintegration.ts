import type { TaskStore } from "../store.js";
import { createLogger } from "../process/logger.js";
import type { Column } from "../types.js";
import {
  listArchivedTaskEntriesPageTolerant,
  restoreTaskFromArchive,
} from "./async/async-archive-lineage.js";
import { resolveWorkflowIrForTask } from "../workflows/workflow-ir-resolver.js";
import { resolveCompleteColumn } from "../workflows/workflow-lifecycle-traits.js";
import { readTaskRow } from "./async/async-persistence.js";

export const ARCHIVE_REINTEGRATION_PAGE_SIZE = 200;
const DEFAULT_ARCHIVE_REINTEGRATION_MAX_FAILURE_ATTEMPTS = 3;
const archiveReintegrationLog = createLogger("core-archive-reintegration");

interface ArchivedTaskReintegrationCursor {
  liveOffset: number;
  coldOffset: number;
  singleSource: ArchivedTaskReintegrationSource;
  failureAttempts: Map<string, number>;
}

const archiveReintegrationCursors = new WeakMap<TaskStore, ArchivedTaskReintegrationCursor>();

function getArchiveReintegrationCursor(store: TaskStore): ArchivedTaskReintegrationCursor {
  const existing = archiveReintegrationCursors.get(store);
  if (existing) return existing;
  const created: ArchivedTaskReintegrationCursor = {
    liveOffset: 0,
    coldOffset: 0,
    singleSource: "live-column",
    failureAttempts: new Map(),
  };
  archiveReintegrationCursors.set(store, created);
  return created;
}

async function readCursorPage<T>(
  offset: number,
  limit: number,
  readPage: (offset: number, limit: number) => Promise<T[]>,
): Promise<{ items: T[]; offset: number }> {
  if (limit <= 0) return { items: [], offset };
  const items = await readPage(offset, limit);
  /*
  FNXC:TaskArchiveReintegration 2026-09-06-08:00:
  Reaching the end of a survivor cursor closes this drain cycle instead of immediately wrapping and
  retrying paused or permanently failing rows forever. A later maintenance cycle starts at zero.
  */
  return items.length === 0 && offset > 0 ? { items: [], offset: 0 } : { items, offset };
}

function shouldAttemptReintegration(
  cursor: ArchivedTaskReintegrationCursor,
  key: string,
  maxFailureAttempts: number,
): boolean {
  const attempts = cursor.failureAttempts.get(key) ?? 0;
  if (attempts < maxFailureAttempts) return true;
  // One traversal is deliberately yielded after the shared starvation budget is exhausted. A later
  // traversal retries in case the failure was transient, while the cursor continues past this row.
  cursor.failureAttempts.delete(key);
  return false;
}

export type ArchivedTaskReintegrationSource = "live-column" | "cold-storage";
export type ArchivedTaskReintegrationOutcome = "moved" | "restored" | "live-won" | "failed" | "retained";
export type ArchivedTaskReintegrationRetainedReason = "user-paused" | "failure-budget" | "malformed-snapshot";

export interface ArchivedTaskReintegrationItem {
  taskId: string;
  source: ArchivedTaskReintegrationSource;
  outcome: ArchivedTaskReintegrationOutcome;
  reason?: ArchivedTaskReintegrationRetainedReason;
}

export interface ArchivedTaskReintegrationResult {
  movedCount: number;
  restoredCount: number;
  outcomes: ArchivedTaskReintegrationItem[];
  hasMore: boolean;
}

export interface ArchivedTaskHistoryInspection {
  liveSentinels: import("../types.js").Task[];
  coldEntries: import("../types.js").ArchivedTaskEntry[];
  malformedColdEntryIds: string[];
}

/** Read every historical carrier without mutating either source. */
export async function inspectArchivedTaskHistory(store: TaskStore): Promise<ArchivedTaskHistoryInspection> {
  const layer = store.asyncLayer;
  if (!layer?.projectId?.trim()) throw new Error("Archive history inspection requires an exact project identity");
  const liveSentinels: import("../types.js").Task[] = [];
  const coldEntries: import("../types.js").ArchivedTaskEntry[] = [];
  const malformedColdEntryIds: string[] = [];
  for (let offset = 0; ; offset += ARCHIVE_REINTEGRATION_PAGE_SIZE) {
    const page = await store.listTasks({
      column: "archived",
      includeArchived: false,
      includeDeleted: false,
      limit: ARCHIVE_REINTEGRATION_PAGE_SIZE,
      offset,
      slim: false,
      startupMemo: false,
    });
    liveSentinels.push(...page);
    if (page.length < ARCHIVE_REINTEGRATION_PAGE_SIZE) break;
  }
  for (let offset = 0; ; offset += ARCHIVE_REINTEGRATION_PAGE_SIZE) {
    const page = await listArchivedTaskEntriesPageTolerant(
      layer.db,
      ARCHIVE_REINTEGRATION_PAGE_SIZE,
      offset,
      layer.projectId,
    );
    coldEntries.push(...page.flatMap((row) => row.entry ? [row.entry] : []));
    malformedColdEntryIds.push(...page.filter((row) => row.malformed).map((row) => row.id));
    if (page.length < ARCHIVE_REINTEGRATION_PAGE_SIZE) break;
  }
  return { liveSentinels, coldEntries, malformedColdEntryIds };
}

async function resolveDoneColumn(store: TaskStore, taskId: string): Promise<Column> {
  try {
    const workflow = await resolveWorkflowIrForTask(store, taskId);
    return (resolveCompleteColumn(workflow) ?? "done") as Column;
  } catch {
    return "done" as Column;
  }
}

async function mirrorReintegratedTask(store: TaskStore, taskId: string): Promise<void> {
  await store.logEntry(taskId, "Archived task reintegrated into Done");
  const task = await store.getTask(taskId);
  await store.atomicWriteTaskJson(store.taskDir(taskId), task);
}

/**
 * Reintegrate one bounded page of historical archive state into workflow completion lanes.
 *
 * FNXC:TaskArchiveRemoval 2026-09-04-19:28:
 * Self-healing repeatedly calls this bounded pass. Live `archived` rows move through the normal
 * engine recovery path, preserving task progress and attachments. Cold snapshots restore under a
 * project/task advisory transaction; a concurrent or pre-existing live row wins and the duplicate
 * snapshot is drained without replacing that row. User-paused rows are never mutated.
 *
 * FNXC:TaskArchiveRemoval 2026-09-04-20:10:
 * Live and cold sources receive independent shares of every pass, and each source retains a cursor
 * across maintenance cycles. Paused or repeatedly failing rows therefore consume neither every live
 * page nor the cold-storage opportunity forever. Failed rows yield after the caller's shared
 * starvation budget, then retry on a later traversal so transient repairs remain recoverable.
 */
export async function reconcileArchivedTasksIntoDonePass(
  store: TaskStore,
  options: { limit?: number; maxFailureAttempts?: number } = {},
): Promise<ArchivedTaskReintegrationResult> {
  const layer = store.asyncLayer;
  if (!layer) throw new Error("Archived task reintegration requires the async task backend");
  const limit = Math.min(500, Math.max(1, Math.trunc(options.limit ?? ARCHIVE_REINTEGRATION_PAGE_SIZE) || ARCHIVE_REINTEGRATION_PAGE_SIZE));
  const maxFailureAttempts = Math.max(1, Math.trunc(options.maxFailureAttempts ?? DEFAULT_ARCHIVE_REINTEGRATION_MAX_FAILURE_ATTEMPTS) || DEFAULT_ARCHIVE_REINTEGRATION_MAX_FAILURE_ATTEMPTS);
  const cursor = getArchiveReintegrationCursor(store);
  let liveLimit = Math.ceil(limit / 2);
  let coldLimit = limit - liveLimit;
  if (limit === 1) {
    liveLimit = cursor.singleSource === "live-column" ? 1 : 0;
    coldLimit = cursor.singleSource === "cold-storage" ? 1 : 0;
    cursor.singleSource = cursor.singleSource === "live-column" ? "cold-storage" : "live-column";
  }
  const outcomes: ArchivedTaskReintegrationItem[] = [];
  let movedCount = 0;
  let restoredCount = 0;

  const livePage = await readCursorPage(cursor.liveOffset, liveLimit, async (offset, pageLimit) => await store.listTasks({
    column: "archived",
    includeArchived: false,
    includeDeleted: false,
    limit: pageLimit,
    offset,
    slim: false,
    startupMemo: false,
  }));
  let liveSurvivors = 0;

  for (const task of livePage.items) {
    const failureKey = `live:${task.id}`;
    if (task.userPaused || !shouldAttemptReintegration(cursor, failureKey, maxFailureAttempts)) {
      liveSurvivors += 1;
      outcomes.push({
        taskId: task.id,
        source: "live-column",
        outcome: "retained",
        reason: task.userPaused ? "user-paused" : "failure-budget",
      });
      continue;
    }
    let leftArchivedColumn = false;
    try {
      const doneColumn = await resolveDoneColumn(store, task.id);
      const moved = await store.moveTaskIf(
        task.id,
        doneColumn,
        (live) => live.column === "archived" && !live.userPaused,
        { moveSource: "engine", recoveryRehome: true, preserveProgress: true },
      );
      if (!moved.moved) {
        if (moved.task?.column === "archived") liveSurvivors += 1;
        continue;
      }
      leftArchivedColumn = true;
      await mirrorReintegratedTask(store, task.id);
      cursor.failureAttempts.delete(failureKey);
      movedCount += 1;
      outcomes.push({ taskId: task.id, source: "live-column", outcome: "moved" });
    } catch (error) {
      if (!leftArchivedColumn) liveSurvivors += 1;
      cursor.failureAttempts.set(failureKey, (cursor.failureAttempts.get(failureKey) ?? 0) + 1);
      outcomes.push({ taskId: task.id, source: "live-column", outcome: "failed" });
      archiveReintegrationLog.warn("Live archived task reintegration failed", {
        taskId: task.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  cursor.liveOffset = livePage.offset + liveSurvivors;

  const coldPage = await readCursorPage(cursor.coldOffset, coldLimit, async (offset, pageLimit) =>
    await listArchivedTaskEntriesPageTolerant(layer.db, pageLimit, offset, layer.projectId));
  let coldSurvivors = 0;
  for (const archivedRow of coldPage.items) {
    if (archivedRow.malformed || !archivedRow.entry) {
      coldSurvivors += 1;
      outcomes.push({
        taskId: archivedRow.id,
        source: "cold-storage",
        outcome: "retained",
        reason: "malformed-snapshot",
      });
      continue;
    }
    const entry = archivedRow.entry;
    const failureKey = `cold:${entry.id}`;
    if (!shouldAttemptReintegration(cursor, failureKey, maxFailureAttempts)) {
      coldSurvivors += 1;
      outcomes.push({ taskId: entry.id, source: "cold-storage", outcome: "retained", reason: "failure-budget" });
      continue;
    }
    let drainedColdSnapshot = false;
    try {
      /*
      FNXC:TaskArchiveRemoval 2026-09-04-19:28:
      Read the authoritative row directly: TaskStore.getTask may still cache a row that a legacy
      cleanup physically removed before the cold snapshot was published.
      */
      const existingRow = await readTaskRow(layer, entry.id, { includeDeleted: true });
      if (existingRow?.userPaused === true) {
        coldSurvivors += 1;
        outcomes.push({ taskId: entry.id, source: "cold-storage", outcome: "retained", reason: "user-paused" });
        continue;
      }
      const doneColumn = await resolveDoneColumn(store, entry.id);
      const now = entry.executionCompletedAt ?? entry.columnMovedAt ?? entry.archivedAt;
      const taskRecord = existingRow && !existingRow.deletedAt
        ? undefined
        : { ...store.archiveEntryToTask(entry), column: doneColumn, columnMovedAt: now, updatedAt: now };
      const restoration = await restoreTaskFromArchive(layer, entry, {
        targetColumn: doneColumn,
        now,
        ...(taskRecord ? { taskRecord } : {}),
      });
      if (restoration.outcome === "user-paused") {
        coldSurvivors += 1;
        outcomes.push({ taskId: entry.id, source: "cold-storage", outcome: "retained", reason: "user-paused" });
        continue;
      }
      drainedColdSnapshot = true;
      if (restoration.outcome === "restored") {
        const authoritativeTask = await store.getTask(entry.id);
        await store.restoreFromArchive(entry, { targetColumn: doneColumn, now, authoritativeTask });
      }
      await mirrorReintegratedTask(store, entry.id);
      cursor.failureAttempts.delete(failureKey);
      if (restoration.outcome === "restored") restoredCount += 1;
      outcomes.push({
        taskId: entry.id,
        source: "cold-storage",
        outcome: restoration.outcome,
      });
    } catch (error) {
      if (!drainedColdSnapshot) coldSurvivors += 1;
      cursor.failureAttempts.set(failureKey, (cursor.failureAttempts.get(failureKey) ?? 0) + 1);
      outcomes.push({ taskId: entry.id, source: "cold-storage", outcome: "failed" });
      archiveReintegrationLog.warn("Archived cold snapshot reintegration failed", {
        taskId: entry.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  cursor.coldOffset = coldPage.offset + coldSurvivors;

  return {
    movedCount,
    restoredCount,
    outcomes,
    hasMore: cursor.liveOffset > 0
      || cursor.coldOffset > 0
      || (liveLimit > 0 && livePage.items.length >= liveLimit)
      || (coldLimit > 0 && coldPage.items.length >= coldLimit),
  };
}

/** Drain every currently reachable page while yielding between bounded transactions. */
export async function drainArchivedTasksIntoDone(
  store: TaskStore,
  options: { limit?: number; maxFailureAttempts?: number } = {},
): Promise<ArchivedTaskReintegrationResult> {
  const aggregate: ArchivedTaskReintegrationResult = {
    movedCount: 0,
    restoredCount: 0,
    outcomes: [],
    hasMore: false,
  };
  do {
    const page = await reconcileArchivedTasksIntoDonePass(store, options);
    aggregate.movedCount += page.movedCount;
    aggregate.restoredCount += page.restoredCount;
    aggregate.outcomes.push(...page.outcomes);
    aggregate.hasMore = page.hasMore;
    if (page.hasMore) await new Promise<void>((resolve) => setImmediate(resolve));
  } while (aggregate.hasMore);
  return aggregate;
}

/** Store-open compatibility drain for hosts that do not run the engine. */
export async function reintegrateArchivedTasksIntoDoneOnOpen(store: TaskStore): Promise<number> {
  const result = await drainArchivedTasksIntoDone(store);
  return result.movedCount + result.restoredCount;
}
