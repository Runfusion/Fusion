/**
 * reads operations.
 *
 * FNXC:StoreModularization 2026-06-25-00:00:
 * Extracted from the monolithic packages/core/src/store.ts as a pure
 * behavior-preserving refactor. Each function receives the TaskStore
 * instance as its first parameter and performs byte-identical work.
 */
import {TaskStore, storeLog} from "../store.js";
import {readFile} from "node:fs/promises";
import {join} from "node:path";
import {existsSync, statSync} from "node:fs";
import type {Task, TaskDetail, ColumnId, ArchivedTaskEntry, TaskVerificationRequest, TaskVerificationResultSummary, TaskVerificationStatus} from "../types.js";
import * as schema from "../postgres/schema/index.js";
import { and, eq } from "drizzle-orm";
import "../builtin-traits.js";
import {allowsAutoMergeProcessing} from "../task-merge.js";
import {getInReviewStallReason, DEFAULT_STALE_MERGING_MIN_AGE_MS} from "../in-review-stall.js";
import {getAgentLogFilePath} from "../agent-log-file-store.js";
import {getInReviewStalledSignal} from "../in-review-stalled.js";
import {getStalePausedReviewSignal} from "../stale-paused-review.js";
import {getStalePausedTodoSignal} from "../stale-paused-todo.js";
import {resolveLifecycleColumns} from "../workflow-lifecycle-traits.js";
import {resolveWorkflowIrForTask} from "../workflow-ir-resolver.js";
import type {WorkflowIr} from "../workflow-ir-types.js";

import {getTaskAgeStalenessSignal, type TaskAgeStalenessThresholds} from "../task-age-staleness.js";
import {detectStalledReview} from "../stalled-review-detector.js";
import {computeRetrySummary} from "../retry-summary.js";
// FNXC:TaskLookup404 2026-07-26-11:20: typed miss signal so API boundaries can
// answer 404 instead of 500 (see TaskNotFoundError in task-store/errors.ts).
import {TaskNotFoundError} from "../task-store/errors.js";

/** Merge storage tiers while preserving primary-source authority and order. */
function mergePrimaryById<T extends { id: string }>(primary: T[], secondary: T[]): T[] {
  const byId = new Map(primary.map((entry) => [entry.id, entry]));
  for (const entry of secondary) {
    if (!byId.has(entry.id)) byId.set(entry.id, entry);
  }
  return [...byId.values()];
}

/**
 * Latest agent-log activity for a task: newest matching in-memory buffer entry
 * or the on-disk agent-log.jsonl mtime, whichever is fresher. Mirrors main's
 * TaskStore.getLatestAgentLogActivityMs (FNXC:WorkflowLifecycle 2026-07-01-23:27).
 */
function getLatestAgentLogActivityMs(store: TaskStore, taskId: string): number | undefined {
  let latest = Number.NEGATIVE_INFINITY;
  for (let index = store.agentLogBuffer.length - 1; index >= 0; index -= 1) {
    const entry = store.agentLogBuffer[index];
    if (entry?.taskId !== taskId) continue;
    const parsed = Date.parse(entry.timestamp);
    if (Number.isFinite(parsed)) {
      latest = Math.max(latest, parsed);
      break;
    }
  }

  try {
    const filePath = getAgentLogFilePath(store.taskDir(taskId));
    if (existsSync(filePath)) {
      const fileMtimeMs = statSync(filePath).mtimeMs;
      if (Number.isFinite(fileMtimeMs)) {
        latest = Math.max(latest, fileMtimeMs);
      }
    }
  } catch (error) {
    storeLog.warn("Skipping agent-log freshness check for stalled badge hydration", {
      taskId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return Number.isFinite(latest) ? latest : undefined;
}

/**
 * FNXC:WorkflowLifecycle 2026-07-05-15:40:
 * True when an in-review task has agent-log writes newer than its own row
 * update and within the stale-merging window — a merge/review agent is
 * actively streaming, so stall badges must be suppressed. Ported from main's
 * TaskStore.hasFreshAgentLogActivitySinceTaskUpdate, which the PostgreSQL
 * cutover's store split predated.
 */
function hasFreshAgentLogActivitySinceTaskUpdate(
  store: TaskStore,
  task: Pick<Task, "id" | "column" | "updatedAt">,
  now: number,
): boolean {
  if (task.column !== "in-review") return false;
  const latestAgentLogMs = getLatestAgentLogActivityMs(store, task.id);
  if (latestAgentLogMs == null) return false;

  const updatedAtMs = Date.parse(task.updatedAt);
  if (Number.isFinite(updatedAtMs) && latestAgentLogMs <= updatedAtMs) {
    return false;
  }

  return Math.max(0, now - latestAgentLogMs) < DEFAULT_STALE_MERGING_MIN_AGE_MS;
}

import {__setTaskActivityLogLimitsForTesting} from "../task-store/comments.js";
import {readTaskRow, readLiveTaskRows} from "../task-store/async-persistence.js";
import {searchTasksTsvector, searchTasksLike} from "../task-store/async-search.js";
import {
  getArchivedTask,
  listArchivedTasks as listArchivedTaskEntries,
  listArchivedTasksByCreatedOrder,
  searchArchivedTasks,
} from "../async-archive-db.js";

/*
FNXC:WorkflowLifecycleColumns 2026-07-28-04:00 (PR #2470 review, P1):
Resolve a task's HOLD column for the stalePausedTodo badge. B1 gave
`getStalePausedTodoSignal` a `holdColumn` parameter, but both hydration sites
here omitted it — so the guard still compared against the literal "todo" and the
dashboard badge was silent for a paused card in a renamed hold column.

Fail-soft to "todo": this is read-path badge hydration, so a workflow lookup
failure must degrade to today's behavior, never break a board list. The cache is
caller-owned so a list hydration reads one IR per workflow rather than per card.
*/
async function resolveHoldColumnForTask(
  store: TaskStore,
  taskId: string,
  cache?: Map<string, WorkflowIr>,
): Promise<string> {
  try {
    const lifecycle = resolveLifecycleColumns(await resolveWorkflowIrForTask(store, taskId, cache));
    return lifecycle?.hold ?? "todo";
  } catch {
    return "todo";
  }
}

export async function getTaskImpl(store: TaskStore, id: string, options?: { activityLogLimit?: number; includeDeleted?: boolean }): Promise<TaskDetail> {
    return store.withTaskLock(id, async () => {
      // FNXC:RuntimePersistenceAsync 2026-06-24-10:50:
      // Backend-mode getTask: read the task row via async helper, convert to
      // Task via pgRowToTaskRow + rowToTask, and hydrate derived fields.
            const layer = store.asyncLayer!;
      const pgRow = await readTaskRow(layer, id, {
        includeDeleted: options?.includeDeleted,
      });
      if (!pgRow) {
        /*
        FNXC:PostgresArchiveReads 2026-07-14-17:09:
        Archive is cold storage, not deletion from the public read model. Task detail must fall back to the project-scoped archive snapshot so an archived card remains inspectable after its live row is tombstoned.
        */
        const archived = await getArchivedTask(layer.db, id, layer.projectId);
        if (!archived) {
          /*
          FNXC:TaskLookup404 2026-07-26-11:20:
          Backend/Postgres miss. Throw the typed TaskNotFoundError (message kept
          byte-identical to the legacy `Task ${id} not found` string) so route
          catches can map it to 404. Nothing on this path sets an errno `code`,
          so the routes' legacy ENOENT check never fired and every unknown task
          id 500'd.
          */
          throw new TaskNotFoundError(id);
        }
        const archivedTask = store.archiveEntryToTask(archived, false);
        return {
          ...archivedTask,
          prompt: archived.prompt ?? store.generatePromptFromArchiveEntry(archived),
        };
      }
      const task = store.rowToTask(store.pgRowToTaskRow(pgRow));
      const now = Date.now();
      const settings = await store.getSettingsFast();
      const mergeQueuedTaskIds = await store.getMergeQueuedTaskIdsAsync();
      /*
      FNXC:WorkflowLifecycle 2026-07-05-15:40:
      In-review merge/review agents stream progress to agent-log JSONL without
      necessarily mutating the task row. Treat fresh agent-log writes as active
      ownership for stall-badge hydration so the board does not show
      Stalled/Merge stalled while a merger is visibly making progress. Restores
      main's FNXC:WorkflowLifecycle 2026-07-01-23:27 behavior, which the
      PostgreSQL cutover's store split predated.
      */
      const hasFreshAgentLogActivity = hasFreshAgentLogActivitySinceTaskUpdate(store, task, now);
      const executingTaskIds = hasFreshAgentLogActivity ? new Set<string>([task.id]) : undefined;
      task.inReviewStall = mergeQueuedTaskIds.has(task.id)
        ? undefined
        : getInReviewStallReason(task, {
          now,
          executingTaskIds,
          autoMerge: allowsAutoMergeProcessing(task, settings),
          engineActiveSinceMs: settings.engineActiveSinceMs,
          engineActivationGraceMs: settings.engineActivationGraceMs,
        });
      task.inReviewStalled = mergeQueuedTaskIds.has(task.id)
        ? undefined
        : getInReviewStalledSignal(task, {
          now,
          executingTaskIds,
          thresholdMs: settings.inReviewStalledThresholdMs,
          autoMerge: allowsAutoMergeProcessing(task, settings),
          engineActiveSinceMs: settings.engineActiveSinceMs,
          engineActivationGraceMs: settings.engineActivationGraceMs,
        });
      task.stalledReview = mergeQueuedTaskIds.has(task.id) || hasFreshAgentLogActivity ? undefined : detectStalledReview(task, { now });
      task.retrySummary = computeRetrySummary(task);
      /*
      FNXC:TaskDetailPromptResilience 2026-07-10-15:00 (merge port from main):
      PROMPT.md is enrichment for the task detail — NOT essential row data.
      getTask is the shared load for the entire per-task API, so an unguarded
      read/parse throw here turned every per-task operation into a 500 while
      the PROMPT.md-free board list kept working. A read can fail for reasons
      unrelated to the row (EACCES from a root-owned file, EISDIR, symlink
      loop, transient FS error). Degrade to empty prompt / unsynced steps.
      */
      if (task.steps.length === 0) {
        try {
          task.steps = await store.parseStepsFromPrompt(id);
        } catch (err) {
          storeLog.warn(`[task-detail] failed to sync steps from PROMPT.md for ${id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      let prompt = "";
      try {
        const promptPath = join(store.taskDir(id), "PROMPT.md");
        if (existsSync(promptPath)) {
          prompt = await readFile(promptPath, "utf-8");
        }
      } catch (err) {
        storeLog.warn(`[task-detail] failed to read PROMPT.md for ${id}: ${err instanceof Error ? err.message : String(err)}`);
      }
      return { ...task, prompt };
});
  }

export async function listTasksImpl(store: TaskStore, options?: { limit?: number; offset?: number; /** When false, exclude tasks in the `archived` column. Default: true (backward compatible). */ includeArchived?: boolean; /** When true, omit heavy fields (log, comments, steps, workflowStepResults, steeringComments) * from each row to make list responses cheap for board-style consumers. Detail fields default * to empty arrays in the returned Task objects; use `getTask(id)` to load full data. */ slim?: boolean; /** Restrict to a single column (e.g. 'in-review' for the auto-merge sweep). * Widened to {@link ColumnId} (#1403) so custom-column filters are accepted. */ column?: ColumnId; /** Opt-in startup-only memo for repeated slim reads during boot choreography. */ startupMemo?: boolean; /** Forensic read: surface soft-deleted tasks (deletedAt IS NOT NULL). * VAL-DATA-006 — only admin/forensic surfaces should set this; live readers * must leave it unset so tombstoned tasks stay off the board (VAL-DATA-005). */ includeDeleted?: boolean; }): Promise<Task[]> {
    const includeArchived = options?.includeArchived ?? true;
    const slim = options?.slim ?? false;
    const columnFilter = options?.column;
    const startupMemoEnabled = options?.startupMemo ?? (!store.isWatching && slim);

    if (startupMemoEnabled && slim && options?.limit === undefined && options?.offset === undefined) {
      const memoKey = `${includeArchived ? "all" : "active"}:${columnFilter ?? "*"}`;
      const now = Date.now();
      const cached = store.startupSlimListMemo.get(memoKey);
      if (cached && cached.expiresAt > now) {
        const memoTasks = await cached.promise;
        return JSON.parse(JSON.stringify(memoTasks)) as Task[];
      }

      const fetchPromise = store.listTasks({ ...options, startupMemo: false });
      store.startupSlimListMemo.set(memoKey, {
        expiresAt: now + TaskStore.STARTUP_SLIM_LIST_MEMO_TTL_MS,
        promise: fetchPromise,
      });
      try {
        const memoTasks = await fetchPromise;
        return JSON.parse(JSON.stringify(memoTasks)) as Task[];
      } catch (error) {
        store.startupSlimListMemo.delete(memoKey);
        throw error;
      }
    }

    // FNXC:RuntimePersistenceAsync 2026-06-24-10:55:
    // Backend-mode listTasks: read live task rows via async helper, convert to
    // Tasks, and hydrate derived fields.
        const layer = store.asyncLayer!;
    /*
    FNXC:TaskStoreReads 2026-07-05-15:30:
    The `log` column must be fetched even in slim mode: the server derives
    `stalledReview` (reenqueue-churn / invalid-transition heuristics) and
    `timedExecutionMs` from log entries BEFORE stripping the log from the
    wire response, exactly like the SQLite path's slim projection (which
    also selected `log` for this reason). The earlier `excludeLog: slim`
    optimization silently disabled both signals on board listings.
    Pass `includeDeleted` through for forensic reads (VAL-DATA-006).

    FNXC:TaskStoreReadsPerf 2026-07-11 (PR #1793 review):
    The column filter and pagination are pushed into SQL (readLiveTaskRows
    WHERE + ORDER BY + LIMIT/OFFSET) instead of fetching the whole table and
    filtering/slicing here — out-of-page rows no longer pay wire transfer or
    per-task hydration (stall signals, PROMPT.md step sync). The SQL order
    (created_at, numeric id suffix) matches the JS comparator below, so the
    page content is identical to the old client-side slice.
    */
    const paginationOffset = Math.max(0, options?.offset ?? 0);
    const paginationLimit = options?.limit !== undefined ? Math.max(0, options.limit) : undefined;
    /*
    FNXC:PostgresArchiveReads 2026-07-14-17:09:
    Pagination belongs to the composed active-plus-archive result. When cold storage participates, fetch both sources before sorting, deduplicating, and slicing; paginating only project.tasks can make archived rows unreachable or shift them onto the wrong page.
    */
    const includeColdStorage = includeArchived && (!columnFilter || columnFilter === "archived");
    const boundedMergedPrefix = includeColdStorage && paginationLimit !== undefined
      ? paginationOffset + paginationLimit
      : undefined;
    const sqlPaginated = (!includeColdStorage && (paginationLimit !== undefined || paginationOffset > 0))
      || boundedMergedPrefix !== undefined;
    const filteredRows = await readLiveTaskRows(layer, {
      includeDeleted: options?.includeDeleted,
      column: columnFilter ?? undefined,
      excludeColumn: !columnFilter && !includeArchived ? "archived" : undefined,
      ...(boundedMergedPrefix !== undefined
        ? { limit: boundedMergedPrefix, offset: 0 }
        : sqlPaginated
          ? { limit: paginationLimit, offset: paginationOffset }
          : {}),
    });
    const now = Date.now();
    const settings = await store.getSettingsFast();
    const mergeQueuedTaskIds = await store.getMergeQueuedTaskIdsAsync();
    /*
    FNXC:WorkflowLifecycleColumns 2026-07-28-18:05 (PR #2479 review, P2):
    ONE IR cache for the whole list pass. Without it, every paused row resolved
    its workflow independently, repeating workflow-definition and prompt-override
    reads for a board with many paused cards on the same workflow. Caller-owned by
    design (U1's `resolveTaskLifecycleColumns` takes the cache for exactly this),
    so reads scale with the number of WORKFLOWS, not the number of cards.
    */
    const listPassIrCache = new Map<string, WorkflowIr>();
    /*
     * FNXC:SqliteFinalRemoval 2026-06-26-10:30:
     * Compute staleness thresholds once for the whole list pass, mirroring
     * the SQLite path. The ageStaleness/stalePausedReview/stalePausedTodo
     * signals are derived at read time and must be hydrated in backend mode
     * too (VAL-CROSS-001 board parity).
     */
    const staleThresholds: TaskAgeStalenessThresholds = {
      inProgressWarningMs: settings.staleInProgressWarningMs,
      inProgressCriticalMs: settings.staleInProgressCriticalMs,
      inReviewWarningMs: settings.staleInReviewWarningMs,
      inReviewCriticalMs: settings.staleInReviewCriticalMs,
    };
    const tasks = await Promise.all(filteredRows.map(async (pgRow) => {
      const row = store.pgRowToTaskRow(pgRow);
      const task = store.rowToTask(row);
      const isMergeQueued = mergeQueuedTaskIds.has(task.id);
      /*
      FNXC:WorkflowLifecycle 2026-07-05-15:40:
      In-review merge/review agents stream progress to agent-log JSONL without
      necessarily mutating the task row. Treat fresh agent-log writes as active
      ownership for stall-badge hydration so the board does not show
      Stalled/Merge stalled while a merger is visibly making progress. Restores
      main's FNXC:WorkflowLifecycle 2026-07-01-23:27 behavior, which the
      PostgreSQL cutover's store split predated.
      */
      const hasFreshAgentLogActivity = hasFreshAgentLogActivitySinceTaskUpdate(store, task, now);
      const executingTaskIds = hasFreshAgentLogActivity ? new Set<string>([task.id]) : undefined;
      task.inReviewStall = isMergeQueued ? undefined : getInReviewStallReason(task, {
        now,
        executingTaskIds,
        autoMerge: allowsAutoMergeProcessing(task, settings),
        engineActiveSinceMs: settings.engineActiveSinceMs,
        engineActivationGraceMs: settings.engineActivationGraceMs,
      });
      task.stalePausedReview = getStalePausedReviewSignal(task, {
        now,
        thresholdMs: settings.stalePausedReviewThresholdMs,
        engineActiveSinceMs: settings.engineActiveSinceMs,
        engineActivationGraceMs: settings.engineActivationGraceMs,
      });
      task.inReviewStalled = isMergeQueued ? undefined : getInReviewStalledSignal(task, {
        now,
        executingTaskIds,
        thresholdMs: settings.inReviewStalledThresholdMs,
        autoMerge: allowsAutoMergeProcessing(task, settings),
        engineActiveSinceMs: settings.engineActiveSinceMs,
        engineActivationGraceMs: settings.engineActivationGraceMs,
      });
      task.stalePausedTodo = getStalePausedTodoSignal(task, {
        now,
        thresholdMs: settings.stalePausedTodoThresholdMs,
        // Paused-only (the signal is a no-op otherwise), sharing the list-pass
        // IR cache so one workflow is read once per pass, not once per card.
        holdColumn:
          task.paused === true ? await resolveHoldColumnForTask(store, task.id, listPassIrCache) : undefined,
        engineActiveSinceMs: settings.engineActiveSinceMs,
        engineActivationGraceMs: settings.engineActivationGraceMs,
      });
      /*
      FNXC:SqliteDualPathCleanup 2026-07-26-15:00:
      Guard age-staleness: invalid threshold pairs throw RangeError — swallow so one bad setting cannot 500 the whole board list.
      */
      try {
        task.ageStaleness = getTaskAgeStalenessSignal(task, {
          now,
          thresholds: staleThresholds,
          engineActiveSinceMs: settings.engineActiveSinceMs,
          engineActivationGraceMs: settings.engineActivationGraceMs,
        });
      } catch (err) {
        if (!(err instanceof RangeError)) throw err;
        task.ageStaleness = undefined;
      }
      task.stalledReview = isMergeQueued || hasFreshAgentLogActivity ? undefined : detectStalledReview(task, { now });
      task.retrySummary = computeRetrySummary(task);
      if (slim) {
        task.timedExecutionMs = store.computeTimedExecutionMs(task.log);
        task.log = [];
      }
      if (!slim || task.steps.length > 0) {
        return task;
      }
      // FNXC:TaskDetailPromptResilience 2026-07-10-16:00 (merge port from main):
      // an unreadable PROMPT.md must not reject this Promise.all and 500 the
      // entire board list — degrade to the persisted (empty) steps and log.
      try {
        const steps = await store.parseStepsFromPrompt(task.id);
        return steps.length > 0 ? { ...task, steps } : task;
      } catch (err) {
        storeLog.warn(`[task-detail] failed to sync steps from PROMPT.md for ${task.id} during listTasks: ${err instanceof Error ? err.message : String(err)}`);
        return task;
      }
    }));
    // Sort by createdAt, then by numeric ID suffix for tie-breaking
    /*
    FNXC:PostgresArchiveReadPerformance 2026-07-14-17:50:
    A global page ending at K can only contain rows from each source's first K entries. Bound both SQL reads to K, then apply live-ID authority and the exact shared comparator before slicing. Unbounded callers retain the complete-result contract.
    */
    const archiveEntries = includeColdStorage
      ? boundedMergedPrefix !== undefined
        ? await listArchivedTasksByCreatedOrder(layer.db, boundedMergedPrefix, layer.projectId)
        : await listArchivedTaskEntries(layer.db, layer.projectId)
      : [];
    const archivedTasks = archiveEntries.map((entry) => store.archiveEntryToTask(entry, slim));
    // Match the legacy merge invariant: a forensic live row is authoritative
    // when the same id also has an archive snapshot.
    const sorted = mergePrimaryById(tasks, archivedTasks).sort((a, b) => {
      const cmp = a.createdAt.localeCompare(b.createdAt);
      if (cmp !== 0) return cmp;
      const aNum = parseInt(a.id.slice(a.id.lastIndexOf("-") + 1), 10) || 0;
      const bNum = parseInt(b.id.slice(b.id.lastIndexOf("-") + 1), 10) || 0;
      return aNum - bNum;
    });
    // Active-only pages were already bounded in SQL. Merged pages are sliced
    // here after composition so cold-storage rows share the same cursor.
    if (!includeColdStorage) return sorted;
    if (paginationLimit === undefined) return sorted.slice(paginationOffset);
    return sorted.slice(paginationOffset, paginationOffset + paginationLimit);
}

export async function listTasksModifiedSinceImpl(store: TaskStore, since: string, limit?: number, opts?: { includeArchived?: boolean },): Promise<{ tasks: Task[]; hasMore: boolean }> {
    if (Number.isNaN(Date.parse(since))) {
      throw new TypeError("listTasksModifiedSince: invalid since cursor");
    }

    const defaultLimit = 50;
    const resolvedLimit = typeof limit !== "number" || !Number.isFinite(limit)
      ? defaultLimit
      : Math.max(1, Math.min(200, Math.floor(limit)));
    const includeArchived = opts?.includeArchived ?? false;

    /*
    FNXC:SqliteFinalRemoval 2026-06-25-10:55:
    Backend-mode listTasksModifiedSince: query the PG tasks table via Drizzle
    with the same cursor pagination semantics as the SQLite path (strict
    greater-than updatedAt, ASC order, LIMIT+1 to detect hasMore). Active-task
    filtering (deleted_at IS NULL) and optional archived-column exclusion are
    applied. The result rows are converted via pgRowToTaskRow + rowToTask and
    hydrated with the same derived signals as the SQLite path.
    */
    const now = Date.now();
    const settings = await store.getSettingsFast();
    const staleThresholds: TaskAgeStalenessThresholds = {
      inProgressWarningMs: settings.staleInProgressWarningMs,
      inProgressCriticalMs: settings.staleInProgressCriticalMs,
      inReviewWarningMs: settings.staleInReviewWarningMs,
      inReviewCriticalMs: settings.staleInReviewCriticalMs,
    };
    let disableAgeStalenessHydration = false;

        const { and, asc, eq, gt, sql } = await import("drizzle-orm");
    const schema = await import("../postgres/schema/index.js");
    const conditions = [
      sql`(${schema.project.tasks.deletedAt} IS NULL)`,
      gt(schema.project.tasks.updatedAt, since),
    ];
    if (!includeArchived) {
      conditions.push(sql`${schema.project.tasks.column} != 'archived'`);
    }
    const layer = store.asyncLayer!;
    // FNXC:MultiProjectIsolation 2026-07-10: scope the incremental-sync scan
    // (backs the SSE watcher / modified-since polling) to the bound project so
    // one project's dashboard never receives another project's task updates.
    if (layer.projectId) {
      conditions.push(eq(schema.project.tasks.projectId, layer.projectId));
    }
    const pgRows = await layer.db
      .select()
      .from(schema.project.tasks)
      .where(and(...conditions))
      .orderBy(asc(schema.project.tasks.updatedAt))
      .limit(resolvedLimit + 1);
    const hasMore = pgRows.length > resolvedLimit;
    const mergeQueuedTaskIds = await store.getMergeQueuedTaskIdsAsync();
    /*
    FNXC:WorkflowLifecycleColumns 2026-07-28-04:00 (PR #2470 review, P1):
    Pre-resolve hold columns for the PAUSED rows only, before the synchronous
    hydration map below.

    Two constraints shape this. The map is sync, so an await cannot go inside it
    without converting a hot board-list path to Promise.all — a restructure this
    fix does not need. And `getStalePausedTodoSignal` is a no-op for a card that
    is not paused, so resolving for every row would buy nothing at real cost:
    paused cards are a small minority of a board, and the shared `irCache` means
    those few resolve one IR per workflow. A board with no paused cards does zero
    extra work.
    */
    const pageRows = pgRows.slice(0, resolvedLimit);
    const holdColumnByTaskId = new Map<string, string>();
    {
      const irCache = new Map<string, WorkflowIr>();
      for (const pgRow of pageRows) {
        const row = store.pgRowToTaskRow(pgRow);
        if (store.rowToTask(row).paused !== true) continue;
        holdColumnByTaskId.set(row.id, await resolveHoldColumnForTask(store, row.id, irCache));
      }
    }
    const tasks = pageRows.map((pgRow) => {
      const task = store.rowToTask(store.pgRowToTaskRow(pgRow));
      const isMergeQueued = mergeQueuedTaskIds.has(task.id);
      /*
      FNXC:WorkflowLifecycle 2026-07-05-15:40:
      In-review merge/review agents stream progress to agent-log JSONL without
      necessarily mutating the task row. Treat fresh agent-log writes as active
      ownership for stall-badge hydration so the board does not show
      Stalled/Merge stalled while a merger is visibly making progress. Restores
      main's FNXC:WorkflowLifecycle 2026-07-01-23:27 behavior, which the
      PostgreSQL cutover's store split predated.
      */
      const hasFreshAgentLogActivity = hasFreshAgentLogActivitySinceTaskUpdate(store, task, now);
      const executingTaskIds = hasFreshAgentLogActivity ? new Set<string>([task.id]) : undefined;
      task.inReviewStall = isMergeQueued ? undefined : getInReviewStallReason(task, {
        now,
        executingTaskIds,
        autoMerge: allowsAutoMergeProcessing(task, settings),
        engineActiveSinceMs: settings.engineActiveSinceMs,
        engineActivationGraceMs: settings.engineActivationGraceMs,
      });
      task.stalePausedReview = getStalePausedReviewSignal(task, {
        now,
        thresholdMs: settings.stalePausedReviewThresholdMs,
        engineActiveSinceMs: settings.engineActiveSinceMs,
        engineActivationGraceMs: settings.engineActivationGraceMs,
      });
      task.inReviewStalled = isMergeQueued ? undefined : getInReviewStalledSignal(task, {
        now,
        executingTaskIds,
        thresholdMs: settings.inReviewStalledThresholdMs,
        autoMerge: allowsAutoMergeProcessing(task, settings),
        engineActiveSinceMs: settings.engineActiveSinceMs,
        engineActivationGraceMs: settings.engineActivationGraceMs,
      });
      task.stalePausedTodo = getStalePausedTodoSignal(task, {
        now,
        thresholdMs: settings.stalePausedTodoThresholdMs,
        holdColumn: holdColumnByTaskId.get(task.id),
        engineActiveSinceMs: settings.engineActiveSinceMs,
        engineActivationGraceMs: settings.engineActivationGraceMs,
      });
      if (!disableAgeStalenessHydration) {
        try {
          task.ageStaleness = getTaskAgeStalenessSignal(task, {
            now,
            thresholds: staleThresholds,
            engineActiveSinceMs: settings.engineActiveSinceMs,
            engineActivationGraceMs: settings.engineActivationGraceMs,
          });
        } catch (error) {
          if (error instanceof RangeError) {
            disableAgeStalenessHydration = true;
            storeLog.warn("Invalid stale task thresholds; skipping age staleness hydration for this modified-since pass", {
              error: error.message,
            });
          } else {
            throw error;
          }
        }
      }
      task.timedExecutionMs = store.computeTimedExecutionMs(task.log);
      task.stalledReview = isMergeQueued || hasFreshAgentLogActivity ? undefined : detectStalledReview(task, { now });
      task.retrySummary = computeRetrySummary(task);
      task.log = [];
      return task;
    });
    return { tasks, hasMore };
}

export async function searchTasksImpl(store: TaskStore, query: string, options?: { limit?: number; offset?: number; slim?: boolean; includeArchived?: boolean }): Promise<Task[]> {
    // FNXC:RuntimePersistenceAsync 2026-06-24-11:00:
    // Backend-mode searchTasks delegates live rows to the generated tsvector
    // index and composes cold-storage matches when requested.
        const trimmedQuery = query?.trim();
    if (!trimmedQuery) {
      return store.listTasks(options);
    }
    const layer = store.asyncLayer!;
    const limit = options?.limit;
    const offset = options?.offset ?? 0;
    if (limit !== undefined && Math.max(0, limit) === 0) return [];
    const includeArchived = options?.includeArchived ?? true;
    const slim = options?.slim ?? false;
    // The tsvector path is the primary search (GIN-backed). The LIKE path is
    // a fallback if the tsvector query returns no results (e.g., if the search
    // index is cold).
    const mergedPrefixLimit = includeArchived && limit !== undefined
      ? Math.max(0, offset) + Math.max(0, limit)
      : undefined;
    const sourceLimit = includeArchived ? mergedPrefixLimit : limit;
    const sourceOffset = includeArchived ? 0 : offset;
    let pgRows = await searchTasksTsvector(layer.db, trimmedQuery, {
      limit: sourceLimit,
      offset: sourceOffset,
      includeArchived,
      // FNXC:MultiProjectIsolation 2026-07-10: scope search to the bound project
      // (load-bearing for the CREATE-time near-duplicate check via searchTasks).
      projectId: layer.projectId,
    });
    if (pgRows.length === 0) {
      pgRows = await searchTasksLike(layer.db, trimmedQuery, {
        limit: sourceLimit,
        offset: sourceOffset,
        includeArchived,
        projectId: layer.projectId,
      });
    }
    const now = Date.now();
    const settings = await store.getSettingsFast();
    const mergeQueuedTaskIds = await store.getMergeQueuedTaskIdsAsync();
    const tasks = await Promise.all(pgRows.map(async (pgRow) => {
      const task = store.rowToTask(store.pgRowToTaskRow(pgRow));
      const isMergeQueued = mergeQueuedTaskIds.has(task.id);
      /*
      FNXC:WorkflowLifecycle 2026-07-05-15:40:
      In-review merge/review agents stream progress to agent-log JSONL without
      necessarily mutating the task row. Treat fresh agent-log writes as active
      ownership for stall-badge hydration so the board does not show
      Stalled/Merge stalled while a merger is visibly making progress. Restores
      main's FNXC:WorkflowLifecycle 2026-07-01-23:27 behavior, which the
      PostgreSQL cutover's store split predated.
      */
      const hasFreshAgentLogActivity = hasFreshAgentLogActivitySinceTaskUpdate(store, task, now);
      const executingTaskIds = hasFreshAgentLogActivity ? new Set<string>([task.id]) : undefined;
      task.inReviewStall = isMergeQueued ? undefined : getInReviewStallReason(task, {
        now,
        executingTaskIds,
        autoMerge: allowsAutoMergeProcessing(task, settings),
        engineActiveSinceMs: settings.engineActiveSinceMs,
        engineActivationGraceMs: settings.engineActivationGraceMs,
      });
      task.inReviewStalled = isMergeQueued ? undefined : getInReviewStalledSignal(task, {
        now,
        executingTaskIds,
        thresholdMs: settings.inReviewStalledThresholdMs,
        autoMerge: allowsAutoMergeProcessing(task, settings),
        engineActiveSinceMs: settings.engineActiveSinceMs,
        engineActivationGraceMs: settings.engineActivationGraceMs,
      });
      task.stalledReview = isMergeQueued || hasFreshAgentLogActivity ? undefined : detectStalledReview(task, { now });
      task.retrySummary = computeRetrySummary(task);
      if (slim) {
        task.timedExecutionMs = store.computeTimedExecutionMs(task.log);
        task.log = [];
      }
      if (task.steps.length > 0) {
        return task;
      }
      // FNXC:TaskDetailPromptResilience 2026-07-10-16:00 (merge port from main):
      // an unreadable PROMPT.md must not reject this Promise.all and 500 the
      // entire search — degrade to the persisted (empty) steps and log.
      try {
        const steps = await store.parseStepsFromPrompt(task.id);
        return steps.length > 0 ? { ...task, steps } : task;
      } catch (err) {
        storeLog.warn(`[task-detail] failed to sync steps from PROMPT.md for ${task.id} during searchTasks: ${err instanceof Error ? err.message : String(err)}`);
        return task;
      }
    }));
    if (!includeArchived) return tasks;
    /*
    FNXC:PostgresArchiveReads 2026-07-14-17:09:
    Search pagination is global across live and archived matches. Query both project-scoped sources without per-source offsets, keep the established live-then-archive ordering, deduplicate by task id, then apply the requested page.
    */
    /*
    FNXC:PostgresArchiveReadPerformance 2026-07-14-17:50:
    Search preserves its live-results-first contract. For a finite page only the first offset+limit live matches can contribute; cold matches are fetched in bounded chunks until deduplication against authoritative live IDs fills the requested prefix or cold storage is exhausted.
    */
    const target = mergedPrefixLimit;
    const archiveEntries: ArchivedTaskEntry[] = [];
    if (target === undefined || tasks.length < target) {
      const chunkSize = target === undefined ? undefined : Math.max(1, target - tasks.length);
      let archiveOffset = 0;
      while (true) {
        const chunk = await searchArchivedTasks(layer.db, trimmedQuery, chunkSize, layer.projectId, archiveOffset);
        archiveEntries.push(...chunk);
        if (chunkSize === undefined || chunk.length < chunkSize) break;
        const uniqueCount = mergePrimaryById(tasks, archiveEntries.map((entry) => store.archiveEntryToTask(entry, slim))).length;
        if (target !== undefined && uniqueCount >= target) break;
        archiveOffset += chunk.length;
      }
    }
    const matches = mergePrimaryById(tasks, archiveEntries.map((entry) => store.archiveEntryToTask(entry, slim)));
    if (limit === undefined) return matches.slice(offset);
    return matches.slice(offset, offset + Math.max(0, limit));
}

/* FNXC:TaskVerificationRequest 2026-07-30-00:00: status reads are project-scoped so chat never observes another project's request. */
export async function getTaskVerificationRequestAsyncImpl(store: TaskStore, taskId: string): Promise<TaskVerificationRequest | null> {
  /*
  FNXC:SqliteDualPathCleanup 2026-07-26-13:30:
  PostgreSQL is the only runtime authority; the former non-backend early-return null path is gone.
  */
  const layer = store.asyncLayer!;
  const projectFilter = layer.projectId ? eq(schema.project.taskVerificationRequests.projectId, layer.projectId) : undefined;
  const rows = await layer.db.select().from(schema.project.taskVerificationRequests).where(and(eq(schema.project.taskVerificationRequests.taskId, taskId), ...(projectFilter ? [projectFilter] : []))).limit(1);
  const row = rows[0];
  return row ? { taskId: row.taskId, requestId: row.requestId, status: row.status as TaskVerificationStatus, profile: row.profile as TaskVerificationRequest["profile"], command: row.command, scope: row.scope as TaskVerificationRequest["scope"], requestedBy: row.requestedBy, requestedAt: row.requestedAt, ...(row.startedAt ? { startedAt: row.startedAt } : {}), ...(row.completedAt ? { completedAt: row.completedAt } : {}), ...(row.result ? { result: row.result as TaskVerificationResultSummary } : {}), ...(row.rejectionReason ? { rejectionReason: row.rejectionReason } : {}) } : null;
}
