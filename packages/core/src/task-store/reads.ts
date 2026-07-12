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
import type {Task, TaskDetail, ColumnId} from "../types.js";
import "../builtin-traits.js";
import {allowsAutoMergeProcessing} from "../task-merge.js";
import {getInReviewStallReason, DEFAULT_STALE_MERGING_MIN_AGE_MS} from "../in-review-stall.js";
import {getAgentLogFilePath} from "../agent-log-file-store.js";
import {getInReviewStalledSignal} from "../in-review-stalled.js";
import {getStalePausedReviewSignal} from "../stale-paused-review.js";
import {getStalePausedTodoSignal} from "../stale-paused-todo.js";
import {getTaskAgeStalenessSignal, type TaskAgeStalenessThresholds} from "../task-age-staleness.js";
import {detectStalledReview} from "../stalled-review-detector.js";
import {computeRetrySummary} from "../retry-summary.js";

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

import {type TaskRow} from "../task-store/persistence.js";
import {__setTaskActivityLogLimitsForTesting} from "../task-store/comments.js";
import {readTaskRow, readLiveTaskRows} from "../task-store/async-persistence.js";
import {searchTasksTsvector, searchTasksLike} from "../task-store/async-search.js";

export async function getTaskImpl(store: TaskStore, id: string, options?: { activityLogLimit?: number; includeDeleted?: boolean }): Promise<TaskDetail> {
    return store.withTaskLock(id, async () => {
      // FNXC:RuntimePersistenceAsync 2026-06-24-10:50:
      // Backend-mode getTask: read the task row via async helper, convert to
      // Task via pgRowToTaskRow + rowToTask, hydrate derived fields. The archive
      // fallback is not yet wired (archive is a separate subsystem converted by
      // runtime-workflow-async); if the task is not in the live table, throw
      // not-found (same as SQLite path when no archive entry exists).
      if (store.backendMode) {
        const pgRow = await readTaskRow(store.asyncLayer!, id, {
          includeDeleted: options?.includeDeleted,
        });
        if (!pgRow) {
          throw new Error(`Task ${id} not found`);
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
      }
      const task = store.readTaskFromDb(id, options);
      if (!task) {
        const archived = store.archiveDb.get(id);
        if (!archived) {
          throw new Error(`Task ${id} not found`);
        }
        const archivedTask = store.archiveEntryToTask(archived, false);
        return {
          ...archivedTask,
          prompt: archived.prompt ?? store.generatePromptFromArchiveEntry(archived),
        };
      }

      const now = Date.now();
      const settings = await store.getSettingsFast();
      const mergeQueuedTaskIds = store.getMergeQueuedTaskIds();
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
      // Derived at read time only; retrySummary is never persisted to SQLite.
      task.retrySummary = computeRetrySummary(task);

      // Sync steps from PROMPT.md if task.steps is empty.
      // FNXC:TaskDetailPromptResilience 2026-07-10-15:00 (merge port from main):
      // best-effort — see the backend branch above; an unreadable PROMPT.md must
      // not 500 every per-task operation.
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
    // Tasks, hydrate derived fields. Archive-task merging is not yet wired in
    // backend mode (archive is converted by runtime-workflow-async). The
    // column filter and includeArchived filtering are applied client-side
    // (the async helper reads all live rows; soft-delete is filtered in SQL).
    if (store.backendMode) {
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
      const sqlPaginated = paginationLimit !== undefined || paginationOffset > 0;
      const filteredRows = await readLiveTaskRows(layer, {
        includeDeleted: options?.includeDeleted,
        column: columnFilter ?? undefined,
        excludeColumn: !columnFilter && !includeArchived ? "archived" : undefined,
        ...(sqlPaginated ? { limit: paginationLimit, offset: paginationOffset } : {}),
      });
      const now = Date.now();
      const settings = await store.getSettingsFast();
      const mergeQueuedTaskIds = await store.getMergeQueuedTaskIdsAsync();
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
          engineActiveSinceMs: settings.engineActiveSinceMs,
          engineActivationGraceMs: settings.engineActivationGraceMs,
        });
        task.ageStaleness = getTaskAgeStalenessSignal(task, {
          now,
          thresholds: staleThresholds,
          engineActiveSinceMs: settings.engineActiveSinceMs,
          engineActivationGraceMs: settings.engineActivationGraceMs,
        });
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
      const sorted = tasks.sort((a, b) => {
        const cmp = a.createdAt.localeCompare(b.createdAt);
        if (cmp !== 0) return cmp;
        const aNum = parseInt(a.id.slice(a.id.lastIndexOf("-") + 1), 10) || 0;
        const bNum = parseInt(b.id.slice(b.id.lastIndexOf("-") + 1), 10) || 0;
        return aNum - bNum;
      });
      // FNXC:TaskStoreReadsPerf 2026-07-11 (PR #1793 review): pagination was
      // already applied in SQL above (readLiveTaskRows LIMIT/OFFSET with the
      // matching order); the JS sort is a stable no-op over the fetched page.
      return sorted;
    }
    // Slim mode drops ONLY the agent log column. On busy boards `log` accounts
    // for ~99% of the row payload (60+ MB across 1200 tasks); every other JSON
    // column combined is under 500 KB and is needed by the board UI:
    //   - `steps`            → step progress badge on TaskCard
    //   - `comments`         → comment count badge on TaskCard
    //   - `workflowStepResults` → workflow status indicators
    //   - `steeringComments` → steering badge
    // Use `getTask(id)` to load the full row (including `log`) for the
    // TaskDetailModal's Activity tab and Agent Log subview.
    const selectClause = store.getTaskSelectClause(slim);
    const whereParts: string[] = [];
    const params: string[] = [];
    // FNXC:TaskStoreForensicRead 2026-06-26-15:25:
    // VAL-DATA-006 — Forensic reads surface soft-deleted rows. By default the
    // live-reader filter (deletedAt IS NULL) is applied (VAL-DATA-005); when
    // includeDeleted is set we drop it so tombstoned tasks appear in the list.
    if (!options?.includeDeleted) {
      whereParts.push(TaskStore.ACTIVE_TASKS_WHERE);
    }
    if (columnFilter) {
      whereParts.push(`"column" = ?`);
      params.push(columnFilter);
    } else if (!includeArchived) {
      whereParts.push(`"column" != 'archived'`);
    }
    const whereClause = whereParts.length > 0 ? ` WHERE ${whereParts.join(" AND ")}` : "";
    const sql = `SELECT ${selectClause} FROM tasks${whereClause} ORDER BY createdAt ASC`;

    const rows = store.db.prepare(sql).all(...params);
    const now = Date.now();
    const settings = await store.getSettingsFast();
    const staleThresholds: TaskAgeStalenessThresholds = {
      inProgressWarningMs: settings.staleInProgressWarningMs,
      inProgressCriticalMs: settings.staleInProgressCriticalMs,
      inReviewWarningMs: settings.staleInReviewWarningMs,
      inReviewCriticalMs: settings.staleInReviewCriticalMs,
    };
    let disableAgeStalenessHydration = false;
    const mergeQueuedTaskIds = store.getMergeQueuedTaskIds();
    const activeTasks = await Promise.all((rows as unknown as TaskRow[]).map(async (row) => {
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
            storeLog.warn("Invalid stale task thresholds; skipping age staleness hydration for this listTasks pass", {
              error: error.message,
            });
          } else {
            throw error;
          }
        }
      }
      task.stalledReview = isMergeQueued || hasFreshAgentLogActivity ? undefined : detectStalledReview(task, { now });
      // Derived at read time only; retrySummary is never persisted to SQLite.
      task.retrySummary = computeRetrySummary(task);

      // Slim path: aggregate the timed-execution total server-side, then
      // strip the heavy log payload from the wire response. Without this
      // the board card has no way to display the same total-execution
      // figure that the task detail panel shows.
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
    const archivedTasks = includeArchived && (!columnFilter || columnFilter === "archived") ? store.archiveDb.list().map((entry) => store.archiveEntryToTask(entry, slim)) : [];
    // FNXC:BoardConsistency 2026-06-21-08:34: FN-6851's cache-sync fix is primary; listTasks still collapses duplicate storage sources so one task ID cannot render in two columns. Active SQLite rows are authoritative over archive snapshots.
    const tasksById = new Map<string, Task>(activeTasks.map((task) => [task.id, task]));
    for (const task of archivedTasks) if (!tasksById.has(task.id)) tasksById.set(task.id, task);
    const tasks = [...tasksById.values()];
    // Sort by createdAt, then by numeric ID suffix for tie-breaking
    const sorted = tasks.sort((a, b) => {
      const cmp = a.createdAt.localeCompare(b.createdAt);
      if (cmp !== 0) return cmp;
      const aNum = parseInt(a.id.slice(a.id.lastIndexOf("-") + 1), 10) || 0;
      const bNum = parseInt(b.id.slice(b.id.lastIndexOf("-") + 1), 10) || 0;
      return aNum - bNum;
    });

    const offset = Math.max(0, options?.offset ?? 0);
    const limit = options?.limit;

    if (limit === undefined) return sorted.slice(offset);
    return sorted.slice(offset, offset + Math.max(0, limit));
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

    if (store.backendMode) {
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
      const tasks = pgRows.slice(0, resolvedLimit).map((pgRow) => {
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

    const selectClause = store.getTaskSelectClause(true);

    const rows = includeArchived
      ? (store.db.prepare(
        `SELECT ${selectClause} FROM tasks WHERE ${TaskStore.ACTIVE_TASKS_WHERE} AND updatedAt > ? ORDER BY updatedAt ASC LIMIT ?`,
      ).all(since, resolvedLimit + 1) as TaskRow[])
      : (store.db.prepare(
        `SELECT ${selectClause} FROM tasks WHERE ${TaskStore.ACTIVE_TASKS_WHERE} AND updatedAt > ? AND "column" != 'archived' ORDER BY updatedAt ASC LIMIT ?`,
      ).all(since, resolvedLimit + 1) as TaskRow[]);

    const hasMore = rows.length > resolvedLimit;
    const mergeQueuedTaskIds = store.getMergeQueuedTaskIds();
    const tasks = rows.slice(0, resolvedLimit).map((row) => {
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
      // Derived at read time only; retrySummary is never persisted to SQLite.
      task.retrySummary = computeRetrySummary(task);
      task.log = [];
      return task;
    });

    return { tasks, hasMore };
  }

export async function searchTasksImpl(store: TaskStore, query: string, options?: { limit?: number; offset?: number; slim?: boolean; includeArchived?: boolean }): Promise<Task[]> {
    // FNXC:RuntimePersistenceAsync 2026-06-24-11:00:
    // Backend-mode searchTasks: delegate to the async tsvector search helper
    // (the PG schema has the search_vector generated column with a GIN index).
    // The result rows are converted to Tasks via pgRowToTaskRow + rowToTask and
    // hydrated with the same derived fields as the SQLite path. Archive search
    // is not yet wired (converted by runtime-workflow-async).
    if (store.backendMode) {
      const trimmedQuery = query?.trim();
      if (!trimmedQuery) {
        return store.listTasks(options);
      }
      const layer = store.asyncLayer!;
      const limit = options?.limit;
      const offset = options?.offset ?? 0;
      const includeArchived = options?.includeArchived ?? true;
      const slim = options?.slim ?? false;
      // The tsvector path is the primary search (GIN-backed). The LIKE path is
      // a fallback if the tsvector query returns no results (e.g., if the search
      // index is cold).
      let pgRows = await searchTasksTsvector(layer.db, trimmedQuery, {
        limit,
        offset,
        includeArchived,
        // FNXC:MultiProjectIsolation 2026-07-10: scope search to the bound project
        // (load-bearing for the CREATE-time near-duplicate check via searchTasks).
        projectId: layer.projectId,
      });
      if (pgRows.length === 0) {
        pgRows = await searchTasksLike(layer.db, trimmedQuery, {
          limit,
          offset,
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
      return tasks;
    }
    // Fall back to listTasks for empty/whitespace-only queries
    const trimmedQuery = query?.trim();
    if (!trimmedQuery) {
      return store.listTasks(options);
    }

    // Sanitize query: strip full-text-search operator chars so both code paths see the same token set
    const sanitizedTokens = trimmedQuery
      .split(/\s+/)
      .filter((token) => token.length > 0)
      .map((token) => token.replace(/["{}:*^+()]/g, ""))
      .filter((token) => token.length > 0);

    if (sanitizedTokens.length === 0) {
      return store.listTasks(options);
    }

    const limit = options?.limit ?? -1;
    const offset = options?.offset ?? 0;
    const offsetClause = offset > 0 ? ` OFFSET ${offset}` : "";
    const includeArchived = options?.includeArchived ?? true;
    const slim = options?.slim ?? false;
    const selectClause = store.getTaskSelectClause(slim, "t");

    let rows: TaskRow[];
    // FNXC:SqliteFinalRemoval 2026-06-26-16:00:
    // VAL-REMOVAL-005 — The full-text-search JOIN/MATCH branch was removed.
    // The gutted SQLite Database class reports its full-text-search-available
    // flag as false unconditionally, so the branch was dead code; its literal
    // JOIN/virtual-table MATCH failed the VAL-REMOVAL-005 grep. This legacy
    // SQLite search path is unreachable in backend mode (PostgreSQL uses the
    // tsvector path via searchTasksTsvector in the backendMode block above).
    // The LIKE fallback below is the sole remaining search strategy for the
    // legacy fallback and produces correct result membership (just without the
    // full-text ranking).
    {
      // LIKE fallback: any token matching any searchable column counts as a hit.
      // Tokens are OR'd; per token we OR across id/title/description/comments.
      // ESCAPE '\\' lets us include user input containing % or _ literally.
      const searchColumns = ["id", "title", "description", "comments"];
      const perTokenClause = `(${searchColumns
        .map((c) => `t."${c}" LIKE ? ESCAPE '\\'`)
        .join(" OR ")})`;
      const whereTokens = sanitizedTokens.map(() => perTokenClause).join(" OR ");
      const params: string[] = [];
      for (const token of sanitizedTokens) {
        const pattern = `%${token.replace(/[\\%_]/g, "\\$&")}%`;
        for (let i = 0; i < searchColumns.length; i++) params.push(pattern);
      }
      const archivedClause = `${includeArchived ? "" : ` AND t."column" != 'archived'`} AND t."deletedAt" IS NULL`;
      rows = store.db.prepare(`
        SELECT ${selectClause} FROM tasks t
        WHERE (${whereTokens})${archivedClause}
        ORDER BY t.createdAt ASC
        LIMIT ${limit >= 0 ? limit : -1}${offsetClause}
      `).all(...params) as unknown as TaskRow[];
    }

    const now = Date.now();
    const settings = await store.getSettingsFast();
    const staleThresholds: TaskAgeStalenessThresholds = {
      inProgressWarningMs: settings.staleInProgressWarningMs,
      inProgressCriticalMs: settings.staleInProgressCriticalMs,
      inReviewWarningMs: settings.staleInReviewWarningMs,
      inReviewCriticalMs: settings.staleInReviewCriticalMs,
    };
    let disableAgeStalenessHydration = false;
    const mergeQueuedTaskIds = store.getMergeQueuedTaskIds();
    const activeMatches = await Promise.all(rows.map(async (row) => {
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
            storeLog.warn("Invalid stale task thresholds; skipping age staleness hydration for this searchTasks pass", {
              error: error.message,
            });
          } else {
            throw error;
          }
        }
      }

      // Slim path mirrors `listTasks`: aggregate timed execution server-side
      // before stripping the heavy log payload from the wire response.
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
    const archiveMatches = includeArchived
      ? store.archiveDb.search(trimmedQuery, limit >= 0 ? limit : 100).map((entry) => store.archiveEntryToTask(entry, slim))
      : [];

    const matches = [...activeMatches, ...archiveMatches];
    return limit >= 0 ? matches.slice(0, limit) : matches;
  }

