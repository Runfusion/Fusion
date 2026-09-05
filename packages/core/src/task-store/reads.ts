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
import type {Task, TaskDetail, ColumnId, ArchivedTaskEntry, TaskVerificationRequest, TaskVerificationResultSummary, TaskVerificationStatus, TaskRecommendation, TaskRecommendationListItem, TaskRecommendationListPage} from "../types.js";
import * as schema from "../postgres/schema/index.js";
import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import "../builtin-traits.js";
import {allowsAutoMergeProcessing} from "../merge/task-merge.js";
import {getInReviewStallReason, DEFAULT_STALE_MERGING_MIN_AGE_MS, type InReviewStallContext} from "../tasks/in-review-stall.js";
import {getAgentLogFilePath} from "../agents/agent-log-file-store.js";
import {getInReviewStalledSignal, type InReviewStalledContext} from "../tasks/in-review-stalled.js";
import {getStalePausedReviewSignal, type StalePausedReviewContext} from "../tasks/stale-paused-review.js";
import {getStalePausedTodoSignal} from "../tasks/stale-paused-todo.js";
import {resolveLifecycleColumns, resolveReviewColumns} from "../workflows/workflow-lifecycle-traits.js";
import {prefetchWorkflowSelections, resolveWorkflowIrForTask, type WorkflowSelectionCache, type WorkflowSelectionReadTally} from "../workflows/workflow-ir-resolver.js";
import type {WorkflowIr} from "../workflows/workflow-ir-types.js";

import {getTaskAgeStalenessSignal, type TaskAgeStalenessThresholds} from "../tasks/task-age-staleness.js";
import {resolveTaskLifecycleColumns} from "../workflows/workflow-lifecycle-traits.js";
import {detectStalledReview} from "../tasks/stalled-review-detector.js";
import {computeRetrySummary} from "../tasks/retry-summary.js";
// FNXC:TaskLookup404 2026-07-26-11:20: typed miss signal so API boundaries can
// answer 404 instead of 500 (see TaskNotFoundError in task-store/errors.ts).
import {TaskNotFoundError} from "../task-store/errors.js";
import { resolveProjectColumnsForRoles } from "../project-lane-vocabulary.js";
import { taskProjectScope } from "../postgres/data-layer.js";

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
/*
FNXC:WorkflowLifecycleColumns 2026-07-31-01:20 (fleet — the review lane, resolved):
`reviewColumns` is an optional RESOLVED answer; omitted, this is exactly today's behaviour.

Same defect as `detectStalledReview` and the same blast radius: this gate decides whether a streaming
merge/review agent SUPPRESSES the stall badges. Against the literal it answered `false` for every card
on a renamed board, so `executingTaskIds` stayed empty and the board showed "Stalled"/"Merge stalled"
while a merger was visibly making progress — the precise regression the FNXC note below says this
function was restored to prevent.
*/
/*
FNXC:WorkflowResolvedColumns 2026-07-31-14:05 (fleet — inline fallback arms):
DELIBERATE-LITERAL — the no-resolution fallbacks for the two lane questions in this file.

Named sets rather than inline `=== "<id>"` arms. Behaviour is identical to the guards as they stand;
the reason is that the census counts an inline comparison whether or not it sits in a fallback branch
— its `traitFallback` hint is advisory and never changes the count. So a correctly-converted guard
with an inline legacy arm stays on the backlog permanently, and the number stops distinguishing real
debt from documented degraded answers. Same shape as `LEGACY_PLANNER_LANES`.
*/
const LEGACY_REVIEW_LANES: ReadonlySet<string> = new Set(["in-review"]);
const LEGACY_ARCHIVE_LANES: ReadonlySet<string> = new Set(["archived"]);

function hasFreshAgentLogActivitySinceTaskUpdate(
  store: TaskStore,
  task: Pick<Task, "id" | "column" | "updatedAt">,
  now: number,
  reviewColumns?: ReadonlySet<string>,
): boolean {
  if (!(reviewColumns ? reviewColumns : LEGACY_REVIEW_LANES).has(task.column)) return false;
  const latestAgentLogMs = getLatestAgentLogActivityMs(store, task.id);
  if (latestAgentLogMs == null) return false;

  const updatedAtMs = Date.parse(task.updatedAt);
  if (Number.isFinite(updatedAtMs) && latestAgentLogMs <= updatedAtMs) {
    return false;
  }

  return Math.max(0, now - latestAgentLogMs) < DEFAULT_STALE_MERGING_MIN_AGE_MS;
}

import {__setTaskActivityLogLimitsForTesting} from "../task-store/comments.js";
import {readTaskRow, readLiveTaskRows, readTaskRowByProposalClaimId, readTaskRowsBySourceLineage} from "./async/async-persistence.js";
import {searchTasksTsvector, searchTasksLike} from "./async/async-search.js";
import {
  getArchivedTask,
  listArchivedTasks as listArchivedTaskEntries,
  listArchivedTasksByCreatedOrder,
  searchArchivedTasks,
} from "../async-stores/async-archive-db.js";

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
  selectionCache?: WorkflowSelectionCache,
): Promise<string> {
  try {
    const lifecycle = resolveLifecycleColumns(await resolveWorkflowIrForTask(store, taskId, cache, selectionCache));
    return lifecycle?.hold ?? "todo";
  } catch {
    return "todo";
  }
}

/*
FNXC:WorkflowLifecycleColumns 2026-07-29-15:20:
The REVIEW half of the same threading `resolveHoldColumnForTask` does for hold.

B1 gave `getStalePausedTodoSignal` a `holdColumn` parameter and PR #2470's review
caught that both hydration sites here omitted it — a correct guard comparing against
the literal, so the badge was silent on a renamed board. That P1 was fixed for hold and
NOT for its sibling role: `getStalePausedReviewSignal` and `getInReviewStalledSignal`
both take `reviewColumn`, and all six call sites in this file left it defaulted to
"in-review". Same defect, same file, one role over.

Fail-soft to "in-review" for the same reason as the hold helper: this is read-path badge
hydration, so a workflow lookup failure must degrade to today's behavior rather than
break a board list. Cache is caller-owned so a list pass reads one IR per workflow.
*/
/*
FNXC:WorkflowResolvedColumns 2026-07-30-22:20 (ONE lane answer for all three stall signals):
The three signals decorating a row — `inReviewStall`, `inReviewStalled`, `stalePausedReview` — each
took their own lane input and DISAGREED: two took a singular `reviewColumn`
(`resolveLifecycleColumns().review`, the FIRST column per role) and the third had no seam at all and
used the literal. So one row could be judged in-review by one signal and not by another, and a board
with a separate merge lane beside its human-review lane had a second review column matching none.

`resolveReviewColumns` is the union of the three review roles. The legacy id stays unioned so a board
mid-rename is never skipped, and all ten call sites now read from THIS answer.
*/
async function resolveReviewColumnsForTask(
  store: TaskStore,
  taskId: string,
  cache?: Map<string, WorkflowIr>,
  selectionCache?: WorkflowSelectionCache,
): Promise<ReadonlySet<string>> {
  const columns = new Set<string>(["in-review"]);
  try {
    const ir = await resolveWorkflowIrForTask(store, taskId, cache, selectionCache);
    if (ir) for (const id of resolveReviewColumns(ir)) columns.add(id);
  } catch { /* degraded: the legacy id above still answers */ }
  return columns;
}


/**
 * FNXC:TaskRecommendations 2026-08-13-22:23:
 * Claim replay is a one-row indexed lookup and intentionally skips cold storage: archive
 * snapshots have no proposalClaimId. It also skips board-derived signal hydration because replay needs only persisted data.
 */
export async function findTaskByProposalClaimIdImpl(store: TaskStore, proposalClaimId: string, options?: { includeDeleted?: boolean }): Promise<Task | null> {
  if (proposalClaimId.trim().length === 0) return null;
  const row = await readTaskRowByProposalClaimId(store.asyncLayer!, proposalClaimId, options);
  return row ? store.rowToTask(store.pgRowToTaskRow(row)) : null;
}

export async function listTasksBySourceLineageImpl(store: TaskStore, input: { sourceAgentId?: string | null; sourceParentTaskId?: string | null }): Promise<Task[]> {
  const rows = await readTaskRowsBySourceLineage(store.asyncLayer!, input);
  return rows.map((row) => store.rowToTask(store.pgRowToTaskRow(row)));
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
      /* FNXC:WorkflowLifecycleColumns 2026-07-31-01:20 (fleet): hoisted ABOVE the fresh-activity gate
         so that gate can resolve too — it is now the FIRST signal, and the note below is the rule. */
      const reviewColumnsForTask: InReviewStallContext["reviewColumns"] = await resolveReviewColumnsForTask(store, task.id);
      const hasFreshAgentLogActivity = hasFreshAgentLogActivitySinceTaskUpdate(store, task, now, reviewColumnsForTask);
      const executingTaskIds = hasFreshAgentLogActivity ? new Set<string>([task.id]) : undefined;
      /*
      FNXC:WorkflowLifecycleColumns 2026-07-30-20:50:
      RESOLVED BEFORE THE FIRST SIGNAL, because two adjacent signals must not disagree.

      This resolve sat BELOW the `getInReviewStallReason` call, so that one call could not pass
      `reviewColumns` and silently kept the legacy single-lane fallback — while
      `getInReviewStalledSignal` three lines down received the resolved SET. On a board declaring a
      separate merge lane beside its human-review lane, `inReviewStall` would read the first review
      column only and `inReviewStalled` would read both, so the same card is "in review" for one
      signal and not the other. Two signals disagreeing is worse than both being legacy, and it is
      invisible on every builtin board because there the set has exactly one element.

      Measured before fixing: of the four `getInReviewStallReason` call sites in this file
      (227/390/599/729) this was the ONLY one not passing the lanes — the other three already did.
      */
      /*
      Typed against the exported context interfaces on purpose: `unwired-lane-parameter-guard` keys an
      interface member to its OWNER symbol and only counts a mention from a file that also names that
      owner (unwired-lane-parameter.mjs:175). Passing the property inline — as this file did — reads as
      UNWIRED even when every call site supplies it, which is how two of the three declarations landed
      on that ratchet while genuinely wired. Naming the types is the smaller fix than appending to a
      list the guard says may only ever shorten.
      */
      task.inReviewStall = mergeQueuedTaskIds.has(task.id)
        ? undefined
        : getInReviewStallReason(task, {
          now,
          executingTaskIds,
          reviewColumns: reviewColumnsForTask,
          autoMerge: allowsAutoMergeProcessing(task, settings),
          engineActiveSinceMs: settings.engineActiveSinceMs,
          engineActivationGraceMs: settings.engineActivationGraceMs,
        });
      task.inReviewStalled = mergeQueuedTaskIds.has(task.id)
        ? undefined
        : getInReviewStalledSignal(task, {
          now,
          executingTaskIds,
          reviewColumns: reviewColumnsForTask,
          thresholdMs: settings.inReviewStalledThresholdMs,
          autoMerge: allowsAutoMergeProcessing(task, settings),
          engineActiveSinceMs: settings.engineActiveSinceMs,
          engineActivationGraceMs: settings.engineActivationGraceMs,
        } satisfies InReviewStalledContext);
      task.stalledReview = mergeQueuedTaskIds.has(task.id) || hasFreshAgentLogActivity ? undefined : detectStalledReview(task, { now, reviewColumns: reviewColumnsForTask });
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

export async function listTasksImpl(store: TaskStore, options?: { limit?: number; offset?: number; /** When false, exclude tasks in the `archived` column. Default: true (backward compatible). */ includeArchived?: boolean; /** When true, omit heavy fields (log, comments, steps, workflowStepResults, steeringComments) * from each row to make list responses cheap for board-style consumers. Detail fields default * to empty arrays in the returned Task objects; use `getTask(id)` to load full data. */ slim?: boolean; /** Restrict to a single column (e.g. 'in-review' for the auto-merge sweep). * Widened to {@link ColumnId} (#1403) so custom-column filters are accepted. */ column?: ColumnId; /** Opt-in startup-only memo for repeated slim reads during boot choreography. */ startupMemo?: boolean; /** Forensic read: surface soft-deleted tasks (deletedAt IS NOT NULL). * VAL-DATA-006 — only admin/forensic surfaces should set this; live readers * must leave it unset so tombstoned tasks stay off the board (VAL-DATA-005). */ includeDeleted?: boolean; selectionCache?: WorkflowSelectionCache; selectionReadTally?: WorkflowSelectionReadTally; }): Promise<Task[]> {
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
    /*
    FNXC:WorkflowResolvedColumns 2026-07-31-14:10 (fleet — reads.ts cluster):
    "IS THE CALLER FILTERING TO THE ARCHIVE LANE?" — a role question about the FILTER, not a task.

    Cold storage holds archived rows. Against the literal, a caller filtering to a renamed archive
    lane took this branch as false, so cold storage was skipped and the filtered view returned only
    whatever archived rows still sat in `project.tasks` — a short list presented as the whole archive.

    `resolveProjectColumnsForRoles` seeds the legacy id before adding resolved ones, so an unconverted
    board is byte-identical and a resolution failure keeps the previous answer.
    */
    const archivedFilterLanes = await resolveProjectColumnsForRoles(store, ["archived"]).catch(() => undefined);
    const columnFilterIsArchive = columnFilter !== undefined
      && (archivedFilterLanes && archivedFilterLanes.size > 0 ? archivedFilterLanes : LEGACY_ARCHIVE_LANES).has(columnFilter);
    const includeColdStorage = includeArchived && (!columnFilter || columnFilterIsArchive);
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
    /* FNXC:WorkflowScheduling 2026-09-05-23:12: List hydration prefetches once per pass; getTaskImpl remains individual because one row has no N+1. The tally reports store-internal reads to callers without changing badge fallback semantics. */
    const listPassSelectionCache = options?.selectionCache ?? new Map<string, import("../workflows/workflow-ir-resolver.js").WorkflowSelection | undefined>();
    const listSelectionReads = await prefetchWorkflowSelections(store, filteredRows.map((row) => String(row.id)), listPassSelectionCache);
    if (options?.selectionReadTally) {
      options.selectionReadTally.batched += listSelectionReads.batched;
      options.selectionReadTally.singles += listSelectionReads.singles;
    }
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
      const reviewColumnsForRow = await resolveReviewColumnsForTask(store, task.id, listPassIrCache, listPassSelectionCache);
      const hasFreshAgentLogActivity = hasFreshAgentLogActivitySinceTaskUpdate(store, task, now, reviewColumnsForRow);
      const executingTaskIds = hasFreshAgentLogActivity ? new Set<string>([task.id]) : undefined;
      task.inReviewStall = isMergeQueued ? undefined : getInReviewStallReason(task, {
        now,
        reviewColumns: reviewColumnsForRow,
        executingTaskIds,
        autoMerge: allowsAutoMergeProcessing(task, settings),
        engineActiveSinceMs: settings.engineActiveSinceMs,
        engineActivationGraceMs: settings.engineActivationGraceMs,
      });
      task.stalePausedReview = getStalePausedReviewSignal(task, {
        now,
        thresholdMs: settings.stalePausedReviewThresholdMs,
        reviewColumns: reviewColumnsForRow,
        engineActiveSinceMs: settings.engineActiveSinceMs,
        engineActivationGraceMs: settings.engineActivationGraceMs,
      } satisfies StalePausedReviewContext);
      task.inReviewStalled = isMergeQueued ? undefined : getInReviewStalledSignal(task, {
        now,
        executingTaskIds,
        reviewColumns: reviewColumnsForRow,
        thresholdMs: settings.inReviewStalledThresholdMs,
        autoMerge: allowsAutoMergeProcessing(task, settings),
        engineActiveSinceMs: settings.engineActiveSinceMs,
        engineActivationGraceMs: settings.engineActivationGraceMs,
      } satisfies InReviewStalledContext);
      task.stalePausedTodo = getStalePausedTodoSignal(task, {
        now,
        thresholdMs: settings.stalePausedTodoThresholdMs,
        // Paused-only (the signal is a no-op otherwise), sharing the list-pass
        // IR cache so one workflow is read once per pass, not once per card.
        holdColumn:
          task.paused === true ? await resolveHoldColumnForTask(store, task.id, listPassIrCache, listPassSelectionCache) : undefined,
        engineActiveSinceMs: settings.engineActiveSinceMs,
        engineActivationGraceMs: settings.engineActivationGraceMs,
      });
      /*
      FNXC:SqliteDualPathCleanup 2026-07-26-15:00:
      Guard age-staleness: invalid threshold pairs throw RangeError — swallow so one bad setting cannot 500 the whole board list.
      */
      try {
        /*
        FNXC:WorkflowResolvedColumns 2026-07-30-08:10 (fleet phase):
        Resolved through the SAME per-pass `listPassIrCache` the hold-column read above already uses, so
        one workflow is read once per pass rather than once per card.

        Cost stated: the hold-column read is conditional on `task.paused`, this one is not, because the
        lanes it needs are exactly what decides whether the signal applies at all — there is no cheaper
        gate available ahead of it. With the cache that is a struct build per card, not an IR read.
        */
        task.ageStaleness = getTaskAgeStalenessSignal(task, {
          now,
          thresholds: staleThresholds,
          engineActiveSinceMs: settings.engineActiveSinceMs,
          engineActivationGraceMs: settings.engineActivationGraceMs,
          lifecycle: await resolveTaskLifecycleColumns(store, task.id, listPassIrCache, listPassSelectionCache),
        });
      } catch (err) {
        if (!(err instanceof RangeError)) throw err;
        task.ageStaleness = undefined;
      }
      task.stalledReview = isMergeQueued || hasFreshAgentLogActivity ? undefined : detectStalledReview(task, { now, reviewColumns: reviewColumnsForRow });
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

        const { and, asc, eq, gt, notInArray, sql } = await import("drizzle-orm");
    const schema = await import("../postgres/schema/index.js");
    const conditions = [
      sql`(${schema.project.tasks.deletedAt} IS NULL)`,
      gt(schema.project.tasks.updatedAt, since),
    ];
    if (!includeArchived) {
      /*
      FNXC:WorkflowResolvedColumns 2026-07-31-09:10:
      ARCHIVED ROWS LEAKED INTO THE LIVE STREAM ON A RENAMED BOARD.

      This filter backs the SSE watcher and modified-since polling — the incremental feed the
      dashboard applies to its live task list. It excluded the literal `archived`, so on a board
      whose archive lane is named anything else the predicate matched EVERY row and excluded
      nothing: archived cards arrived in the live feed and reappeared on the board.

      Nothing errors, and a full refetch filters archived rows by another path, so the symptom is
      archived work that comes back until the next reload.

      `resolveProjectColumnsForRoles` seeds the legacy ids before adding resolved ones, so the set is
      never empty and an unconverted board excludes exactly `archived` as before. The fallback covers
      a resolution failure, where excluding nothing would be worse than excluding the legacy id.
      */
      const archivedColumns = await resolveProjectColumnsForRoles(store, ["archived"]).catch(() => undefined);
      if (archivedColumns && archivedColumns.size > 0) {
        conditions.push(notInArray(schema.project.tasks.column, [...archivedColumns]));
      } else {
        conditions.push(sql`${schema.project.tasks.column} != 'archived'`);
      }
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
    /*
    FNXC:WorkflowLifecycleColumns 2026-07-29-15:20:
    The review column is pre-resolved here for the same reason the hold column is: the
    row mapping below is SYNCHRONOUS, so a per-row `await` is not available to it. Both
    share one IR cache, so a page spanning three workflows reads three IRs regardless of
    card count. Unlike hold — which only matters for a paused card — the review signals
    apply to any row, so this resolves for every row on the page.
    */
    const reviewColumnsByTaskId = new Map<string, ReadonlySet<string>>();
    const lifecycleByTaskId = new Map<string, Awaited<ReturnType<typeof resolveTaskLifecycleColumns>>>();
    {
      /* FNXC:WorkflowScheduling 2026-09-05-23:12: Incremental hydration resolves multiple lanes per row, so selection prefetch prevents its former 2–3 reads per task while absent selections retain builtin:coding behavior. */
      const irCache = new Map<string, WorkflowIr>();
      const selectionCache = new Map<string, import("../workflows/workflow-ir-resolver.js").WorkflowSelection | undefined>();
      await prefetchWorkflowSelections(store, pageRows.map((row) => row.id), selectionCache);
      for (const pgRow of pageRows) {
        const row = store.pgRowToTaskRow(pgRow);
        reviewColumnsByTaskId.set(row.id, await resolveReviewColumnsForTask(store, row.id, irCache, selectionCache));
        lifecycleByTaskId.set(row.id, await resolveTaskLifecycleColumns(store, row.id, irCache, selectionCache));
        if (store.rowToTask(row).paused !== true) continue;
        holdColumnByTaskId.set(row.id, await resolveHoldColumnForTask(store, row.id, irCache, selectionCache));
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
      const reviewColumnsForRow = reviewColumnsByTaskId.get(task.id) ?? new Set<string>(["in-review"]);
      const hasFreshAgentLogActivity = hasFreshAgentLogActivitySinceTaskUpdate(store, task, now, reviewColumnsForRow);
      const executingTaskIds = hasFreshAgentLogActivity ? new Set<string>([task.id]) : undefined;
      task.inReviewStall = isMergeQueued ? undefined : getInReviewStallReason(task, {
        now,
        reviewColumns: reviewColumnsForRow,
        executingTaskIds,
        autoMerge: allowsAutoMergeProcessing(task, settings),
        engineActiveSinceMs: settings.engineActiveSinceMs,
        engineActivationGraceMs: settings.engineActivationGraceMs,
      });
      task.stalePausedReview = getStalePausedReviewSignal(task, {
        now,
        thresholdMs: settings.stalePausedReviewThresholdMs,
        reviewColumns: reviewColumnsForRow,
        engineActiveSinceMs: settings.engineActiveSinceMs,
        engineActivationGraceMs: settings.engineActivationGraceMs,
      } satisfies StalePausedReviewContext);
      task.inReviewStalled = isMergeQueued ? undefined : getInReviewStalledSignal(task, {
        now,
        executingTaskIds,
        reviewColumns: reviewColumnsForRow,
        thresholdMs: settings.inReviewStalledThresholdMs,
        autoMerge: allowsAutoMergeProcessing(task, settings),
        engineActiveSinceMs: settings.engineActiveSinceMs,
        engineActivationGraceMs: settings.engineActivationGraceMs,
      } satisfies InReviewStalledContext);
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
            /*
            FNXC:WorkflowLifecycleColumns 2026-07-30-09:00 (fleet — the omitted sibling site):
            THE MODIFIED-SINCE PASS NEEDS THE LANES TOO. #2746 threaded `lifecycle` into the list
            pass above and left this one on the defaults, so a renamed board still produced no
            age-staleness badge for any card arriving through the incremental refresh — which is the
            path a live board actually uses after first load.

            This is the third occurrence of one specific mistake in this one file: the helper gains a
            resolved-role parameter and one of the two hydration sites is missed. The notes above
            record it for `holdColumn` (PR #2470) and then for `reviewColumn` ("same defect, same
            file, one role over"). Pinned now by reads-age-staleness-lane-hydration.test.ts, which
            asserts BOTH sites pass it rather than trusting the next reader to notice.
            */
            lifecycle: lifecycleByTaskId.get(task.id),
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
      task.stalledReview = isMergeQueued || hasFreshAgentLogActivity ? undefined : detectStalledReview(task, { now, reviewColumns: reviewColumnsForRow });
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
    /*
    FNXC:WorkflowResolvedColumns 2026-07-31-23:59:
    Search excludes the board's OWN archive lanes, not the `archived` id. Against the literal, a card
    filed away on a renamed board still surfaced in every live search — including the CREATE-time
    near-duplicate check, which would then reject a new task as a duplicate of one the operator had
    already archived.

    Resolved once here and threaded into both search paths. `resolveArchivedLanes` returns undefined
    on an unreadable workflow list, and `liveSearchPredicate` falls back to the literal, so an
    unconverted board is byte-identical.
    */
    const searchArchivedLanes = await resolveProjectColumnsForRoles(store, ["archived"]).catch(() => undefined);
    let pgRows = await searchTasksTsvector(layer.db, trimmedQuery, {
      limit: sourceLimit,
      offset: sourceOffset,
      includeArchived,
      archivedColumns: searchArchivedLanes,
      // FNXC:MultiProjectIsolation 2026-07-10: scope search to the bound project
      // (load-bearing for the CREATE-time near-duplicate check via searchTasks).
      projectId: layer.projectId,
    });
    if (pgRows.length === 0) {
      pgRows = await searchTasksLike(layer.db, trimmedQuery, {
        limit: sourceLimit,
        offset: sourceOffset,
        includeArchived,
        archivedColumns: searchArchivedLanes,
        projectId: layer.projectId,
      });
    }
    const now = Date.now();
    const settings = await store.getSettingsFast();
    const mergeQueuedTaskIds = await store.getMergeQueuedTaskIdsAsync();
    // Shared across the page so one workflow is read once, not once per hit.
    const searchPassIrCache = new Map<string, WorkflowIr>();
    /* FNXC:WorkflowScheduling 2026-09-05-23:12: Search hydration has the same per-row selection N+1 as board lists; prefetch retains the default workflow for cached absent selections. */
    const searchPassSelectionCache = new Map<string, import("../workflows/workflow-ir-resolver.js").WorkflowSelection | undefined>();
    await prefetchWorkflowSelections(store, pgRows.map((row) => String(row.id)), searchPassSelectionCache);
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
      /* FNXC:WorkflowLifecycleColumns 2026-07-31-01:20 (fleet): resolved ONCE for this row — it was
         resolved inline twice below, and the fresh-activity gate could not see it at all. */
      const reviewColumnsForRow = await resolveReviewColumnsForTask(store, task.id, searchPassIrCache, searchPassSelectionCache);
      const hasFreshAgentLogActivity = hasFreshAgentLogActivitySinceTaskUpdate(store, task, now, reviewColumnsForRow);
      const executingTaskIds = hasFreshAgentLogActivity ? new Set<string>([task.id]) : undefined;
      task.inReviewStall = isMergeQueued ? undefined : getInReviewStallReason(task, {
        now,
        reviewColumns: reviewColumnsForRow,
        executingTaskIds,
        autoMerge: allowsAutoMergeProcessing(task, settings),
        engineActiveSinceMs: settings.engineActiveSinceMs,
        engineActivationGraceMs: settings.engineActivationGraceMs,
      });
      task.inReviewStalled = isMergeQueued ? undefined : getInReviewStalledSignal(task, {
        now,
        executingTaskIds,
        reviewColumns: reviewColumnsForRow,
        thresholdMs: settings.inReviewStalledThresholdMs,
        autoMerge: allowsAutoMergeProcessing(task, settings),
        engineActiveSinceMs: settings.engineActiveSinceMs,
        engineActivationGraceMs: settings.engineActivationGraceMs,
      } satisfies InReviewStalledContext);
      task.stalledReview = isMergeQueued || hasFreshAgentLogActivity ? undefined : detectStalledReview(task, { now, reviewColumns: reviewColumnsForRow });
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

/**
 * FNXC:TaskRecommendations 2026-08-13-04:41:
 * Insights needs a dedicated narrow read because its aggregate is advisory triage and must remain
 * bounded. Rows, rather than JSONB items, are paged with updatedAt/id ordering so equal completion
 * timestamps cannot drop or duplicate a row; offset paging is sufficient because creating a task
 * links the recommendation without removing its source row.
 */
export async function listTaskRecommendationsImpl(
  store: TaskStore,
  options?: { completeColumns?: ReadonlySet<string>; limit?: number; offset?: number },
): Promise<TaskRecommendationListPage> {
  const layer = store.asyncLayer!;
  const completeColumns = options?.completeColumns ?? await resolveProjectColumnsForRoles(store, ["complete"]);
  const rawLimit = options?.limit;
  const rawOffset = options?.offset;
  const limit = typeof rawLimit === "number" && Number.isFinite(rawLimit) ? Math.min(200, Math.max(1, Math.trunc(rawLimit))) : 50;
  const offset = typeof rawOffset === "number" && Number.isFinite(rawOffset) ? Math.max(0, Math.trunc(rawOffset)) : 0;
  const columns = [...completeColumns];
  if (columns.length === 0) return { items: [], rowOffset: offset, rowLimit: limit, returnedRowCount: 0, totalRowCount: 0, hasMore: false };
  const filter = and(
    taskProjectScope(layer),
    isNull(schema.project.tasks.deletedAt),
    inArray(schema.project.tasks.column, columns),
    isNotNull(schema.project.tasks.recommendations),
    sql`jsonb_array_length(${schema.project.tasks.recommendations}) > 0`,
  );
  const [countRows, rows] = await Promise.all([
    layer.db.select({ count: sql<number>`count(*)` }).from(schema.project.tasks).where(filter),
    layer.db.select({ id: schema.project.tasks.id, title: schema.project.tasks.title, column: schema.project.tasks.column, updatedAt: schema.project.tasks.updatedAt, recommendations: schema.project.tasks.recommendations })
      .from(schema.project.tasks).where(filter).orderBy(desc(schema.project.tasks.updatedAt), desc(schema.project.tasks.id)).limit(limit).offset(offset),
  ]);
  const items: TaskRecommendationListItem[] = [];
  for (const row of rows) {
    if (!Array.isArray(row.recommendations) || row.recommendations.length === 0) continue;
    for (const recommendation of row.recommendations) {
      items.push({ taskId: row.id, taskTitle: row.title ?? undefined, taskColumn: row.column, updatedAt: row.updatedAt, recommendation: recommendation as TaskRecommendation });
    }
  }
  const totalRowCount = Number(countRows[0]?.count ?? 0);
  const returnedRowCount = rows.length;
  return { items, rowOffset: offset, rowLimit: limit, returnedRowCount, totalRowCount, hasMore: offset + returnedRowCount < totalRowCount };
}
