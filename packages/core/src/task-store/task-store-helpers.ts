/**
 * Task-store helper operations (DB row, merge request, workflow IR).
 *
 * FNXC:StoreModularization 2026-06-25-00:00:
 * Extracted from the monolithic packages/core/src/store.ts as a pure
 * behavior-preserving refactor. Each function receives the TaskStore
 * instance as its first parameter and performs byte-identical work.
 *
 * FNXC:CodeOrganization 2026-07-16-20:00:
 * Renamed from project-store-ops0.ts (domain: task-store helper ops).
 */

import { TaskStore } from "../store.js";
import {
  isBuiltinWorkflowEnabled,
  isBuiltinWorkflowId,
  isBuiltinWorkflowToggleEligible,
  resolveEffectiveDefaultWorkflowId,
} from "../workflows/builtin-workflows.js";
import { InsightStore } from "../insights/insight-store.js";
import { ResearchStore } from "../research/research-store.js";
import { parseWorkflowIr } from "../workflows/workflow-ir.js";
import { columnsWithFlag } from "../workflows/workflow-lifecycle-traits.js";
import { type TaskRow } from "./persistence.js";
import { eq, inArray } from "drizzle-orm";
import * as schema from "../postgres/schema/index.js";
import { MergeRequestRow, WorkflowWorkItemRow } from "./row-types.js";
import { TodoStore } from "../stores/todo-store.js";
import { AsyncTodoStore } from "../async-stores/async-todo-store.js";
import { AsyncInsightStore } from "../async-stores/async-insight-store.js";
import { AsyncResearchStore } from "../async-stores/async-research-store.js";
import { createRecallCaptureWriter } from "../memory/recall-capture.js";
import { createLogger } from "../process/logger.js";
import { assertColumnTraitsValid } from "../workflows/trait-registry.js";
import { BoardConfig, BranchGroup, MergeRequestRecord, Task, WorkflowStepTemplate, WorkflowWorkItem, WorkflowWorkItemKind } from "../types.js";
import { WorkflowFieldDefinition, WorkflowIr, WorkflowIrColumn } from "../workflows/workflow-ir-types.js";
import { applyPromptOverridesToIr } from "../workflows/workflow-prompt-overrides.js";
import { MoveTaskOptions } from "../store.js";
import { activityProjectPartition } from "./async/async-audit.js";

export function readTaskRowFromDbImpl(store: TaskStore, id: string, options?: { includeDeleted?: boolean }): TaskRow | undefined {
    const whereClause = options?.includeDeleted ? "id = ?" : `id = ? AND ${TaskStore.ACTIVE_TASKS_WHERE}`;
    return store.db.prepare(`SELECT * FROM tasks WHERE ${whereClause}`).get(id) as TaskRow | undefined;
}

export function isTaskIdConflictErrorImpl(store: TaskStore, error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /SQLITE_CONSTRAINT|UNIQUE constraint failed: tasks\.id|PRIMARY KEY constraint failed: tasks\.id/i.test(message);
}

export function upsertTaskWithFtsRecoveryImpl(store: TaskStore, task: Task): void {
    store.runTaskFtsWriteWithRecovery(task.id, "upsert", () => {
      store.upsertTask(task);
    });
}

export function getMergeQueuedTaskIdsImpl(store: TaskStore): Set<string> {
    const rows = store.db.prepare("SELECT taskId FROM mergeQueue").all() as Array<{ taskId: string }>;
    return new Set(rows.map((row) => row.taskId));
}

export function getTaskIdFromDirImpl(store: TaskStore, dir: string): string {
    const parts = dir.replace(/\\/g, "/").split("/");
    return parts[parts.length - 1];
}

export function serializeConfigForDiskImpl(store: TaskStore, config: BoardConfig): string {
    const { nextId: _deprecatedNextId, ...configForDisk } = config as BoardConfig & { nextId?: number };
    return JSON.stringify(configForDisk, null, 2);
}

export function artifactStoredNameImpl(id: string, title: string): string {
    const sanitized = (title.trim() || "artifact").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "artifact";
    return `${Date.now()}-${id}-${sanitized}`;
}

export async function recordBranchGroupMemberLandedImpl(store: TaskStore,
    groupId: string,
    patch: { worktreePath?: string | null; status?: BranchGroup["status"] },
  ): Promise<BranchGroup> {
    return store.updateBranchGroup(groupId, {
      ...(patch.worktreePath !== undefined ? { worktreePath: patch.worktreePath } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
    });
}

/*
FNXC:WorkflowLifecycleColumns 2026-08-02-17:45:
A dependency is satisfied only in its own workflow Complete column. This helper accepts the caller's
pre-resolved columns for batch use and falls back to built-in `done` when workflow metadata is absent.
*/
export function areAllDependenciesDoneImpl(
  store: TaskStore,
  dependencies: string[],
  tasksById: Map<string, Task>,
  satisfiedColumns?: ReadonlySet<string>,
): boolean {
    const satisfied = satisfiedColumns ?? BUILTIN_SATISFIED_COLUMNS;
    return dependencies.every((dependencyId) => {
      const dependency = tasksById.get(dependencyId);
      return dependency !== undefined && satisfied.has(dependency.column);
    });
}

/** Built-in Complete fallback for callers without workflow metadata. */
const BUILTIN_SATISFIED_COLUMNS: ReadonlySet<string> = new Set(["done"]);

export function resolveWorkflowBypassGuardsImpl(store: TaskStore,
    moveSource: NonNullable<MoveTaskOptions["moveSource"]>,
    options?: MoveTaskOptions,
  ): boolean {
  /*
  FNXC:WorkflowColumns 2026-07-30-11:00 (PR #2655 review — BOTH findings are right, and they are
  the same defect seen from two sides. REVERTED to reading `options?.moveSource`.)

  Round 1 said an optionless `moveTask(id, target)` LOSES bypass, because the call site resolves
  `moveSource` to "engine" while this read the absent option. I switched to the resolved value.
  Round 2 said that grants privileged bypass to PUBLIC callers. Both are correct, because an absent
  `moveSource` is genuinely ambiguous — measured on this tree:

    18 optionless calls in packages/engine (self-healing, project-engine) — genuine engine moves
     8 optionless calls in packages/dashboard HTTP routes (reset, rebound, respecify, unassign)
       — operator-initiated, and they must NOT skip merge blockers or plugin gates

  Reading the resolved value hands bypass to those eight routes. Reading the option leaves the
  eighteen engine calls unbypassed, which is what has shipped all along.

  So this reverts to the shipped read. A flag-resolution PR is the wrong place to change who gets to
  skip merge blockers: it is a behaviour change with a security shape, it is not required by the
  flip, and "the tests pass" is not evidence for it. The real fix is to make `moveSource` EXPLICIT at
  those 26 call sites so the default never has to be guessed — filed as follow-up work, not smuggled
  in here.

  The `void moveSource;` below is kept for the same reason it existed: the parameter is part of the
  signature and deliberately unused until that follow-up lands.

  `void moveSource;` discarded the parameter and re-read the raw option, so an OPTIONLESS call —
  `moveTask(id, target)` — resolved `moveSource` to "engine" at every call site and then computed
  `bypassGuards === false`, because `options` was undefined. The two disagreed about what kind of
  move it was.

  Harmless while the move-path flag gated validation, because nothing consumed the answer. The flag
  is gone, so seam 2's guards now run for these calls and an internal executor/merger/recovery move
  made without an options object would be judged as if a user had made it.

  The `void` was a deliberate unused-parameter suppression, i.e. someone noticed the argument was
  unused and silenced the lint instead of wiring it up. Using it aligns bypass with the `moveSource`
  every caller already resolves the same way.
  */
    void moveSource;
    return options?.recoveryRehome === true ||
      (options?.bypassGuards ??
        (options?.moveSource === "engine" || options?.moveSource === "scheduler" || options?.skipMergeBlocker === true));
}

export function shouldSkipWorkflowMovePoliciesImpl(store: TaskStore,
params: {
    fromColumn: string;
    toColumn: string;
    moveSource: NonNullable<MoveTaskOptions["moveSource"]>;
    bypassGuards: boolean;
    options?: MoveTaskOptions;
  }): boolean {
    if (params.bypassGuards) return true;
    if (params.options?.recoveryRehome === true) return true;
    /*
    FNXC:WorkflowLifecycleColumns 2026-08-02-17:55 (fleet):
    THE HARD-CANCEL SHAPE — a USER dragging a card from the wip lane back to the hold lane — is what
    AGENTS.md's Move-Task contract calls a hard cancel, and it is the one move allowed to bypass workflow
    transition guards. Spelled as literals, the bypass never applied on a renamed board: the operator's drag
    was rejected by the transition validator, so a card could not be cancelled from the board at all.

    FLAGGED, NOT CONVERTED: this function is SYNCHRONOUS and receives only column strings — no task id, no
    store — so there is nothing to resolve from and no caller-injected set today. Converting it means adding
    lanes to `MoveTaskOptions` (the moves path already resolves them; see moves.ts) and threading them here.
    That is a moves-path change, and moves.ts is owned by another worker's PR, so this is a deliberate hand-off
    rather than a literal nobody noticed. DELIBERATE-LITERAL until the moves path passes its snapshot down.
    */
    return params.moveSource === "user" && params.fromColumn === "in-progress" && params.toColumn === "todo";
}

export function getMergeRequestRecordImpl(_store: TaskStore, _taskId: string): MergeRequestRecord | null {
    /*
    FNXC:PostgresCutover 2026-07-04:
    Synchronous read of merge_requests cannot run against PostgreSQL (Drizzle
    is async). This sync entry point is consumed directly by the merger,
    scheduler, and executor (~12 sites) which call it without await; converting
    the signature would require coordinated edits across packages/engine and
    refactoring the SQLite-path sync-transaction read in
    projectMergeRequestToWorkflowWorkItemImpl. In backend mode we therefore
    return null (graceful, mirrors the getTaskWorkflowSelection sync→backend
    degradation) instead of throwing. Callers that need the real record in PG
    must use getMergeRequestRecordAsync below.
    */
    /* FNXC:SqliteDualPathCleanup 2026-07-26-14:20: sync merge-request reader is incomplete-PG; use getMergeRequestRecordAsync. */
    return null;
}

/**
 * FNXC:PostgresCutover 2026-07-04:
 * Async backend-mode read of a merge_request record via Drizzle. This is the
 * PostgreSQL-capable counterpart of getMergeRequestRecordImpl — the Drizzle
 * select returns camelCase columns (schema-mapped), cast to MergeRequestRow,
 * then converted through the shared rowToMergeRequestRecord. Mirrors the
 * upsertMergeRequestRecordImpl backend branch's select-back shape. In SQLite
 * mode it delegates to the sync impl.
 */
export async function getMergeRequestRecordAsyncImpl(store: TaskStore, taskId: string): Promise<MergeRequestRecord | null> {
    /* FNXC:SqliteDualPathCleanup 2026-07-26-14:15: always PostgreSQL path below. */
    const layer = store.asyncLayer!;
    const rows = await layer.db
      .select()
      .from(schema.project.mergeRequests)
      .where(eq(schema.project.mergeRequests.taskId, taskId))
      .limit(1);
    const row = rows[0] as MergeRequestRow | undefined;
    return row ? store.rowToMergeRequestRecord(row) : null;
}

/*
FNXC:MergeAuthority 2026-08-23-20:05 (review finding #10):
BATCHED sibling of `getMergeRequestRecordAsyncImpl` for the in-review merge sweep, which needs one
merge-request state per review-lane card per poll. One `inArray` replaces N single-row selects.
*/
export async function getMergeRequestRecordsAsyncImpl(
  store: TaskStore,
  taskIds: readonly string[],
): Promise<Map<string, MergeRequestRecord>> {
    const byTask = new Map<string, MergeRequestRecord>();
    if (taskIds.length === 0) return byTask;
    const layer = store.asyncLayer!;
    const rows = await layer.db
      .select()
      .from(schema.project.mergeRequests)
      .where(inArray(schema.project.mergeRequests.taskId, [...taskIds]));
    for (const row of rows as MergeRequestRow[]) {
      const record = store.rowToMergeRequestRecord(row);
      byTask.set(record.taskId, record);
    }
    return byTask;
}

export function getWorkflowWorkItemByIdentityImpl(store: TaskStore,
    runId: string,
    taskId: string,
    nodeId: string,
    kind: WorkflowWorkItemKind,
  ): WorkflowWorkItem | null {
    const row = store.db
      .prepare("SELECT * FROM workflow_work_items WHERE runId = ? AND taskId = ? AND nodeId = ? AND kind = ?")
      .get(runId, taskId, nodeId, kind) as WorkflowWorkItemRow | undefined;
    return row ? store.rowToWorkflowWorkItem(row) : null;
}

/*
FNXC:WorkflowLifecycleColumns 2026-07-31-13:00:
THE QUERY WAS THE DEFECT, not the predicate below it.

`isLegacyAutoMergeStampCandidate` gained an optional resolved `reviewColumns` and no caller passed
it. Wiring that parameter here would have changed NOTHING, because the read above it asked
`listTasks({ column: "in-review" })` — a QUERY filter with the literal. On a renamed board that query
returns zero rows, so the backfill iterated an empty list and reported success over nothing; the
predicate was never reached.

This is the third unwired parameter in this sweep whose caller held the larger defect
(`blocker-fanout` emitted no warning at all; the analytics routes reported a silent zero). An
optional parameter nobody fills is worth reading as a SYMPTOM of an unexamined caller rather than as
a cosmetic gap.

WHY A UNION ACROSS DEFINITIONS: there is no task to resolve from before the read, which is what makes
the query class hard. The project's declared workflows are the only lane vocabulary available at this
point, so every review-bearing column any of them declares is queried, unioned with the legacy id so
a board mid-rename (rows still stored under the old id) is not skipped. Over-inclusion costs one
extra query and is filtered by the predicate; under-inclusion silently backfills nothing, which is
the failure being fixed.
*/
/**
 * The review-lane vocabulary for the legacy auto-merge stamp backfill, resolved from the PROJECT's
 * declared workflows because there is no task to resolve from before the read.
 *
 * Exported so the candidate query and the two re-checks that follow it share ONE answer. Deriving it
 * separately per site is how a read and its re-check end up disagreeing.
 */
export async function resolveLegacyStampReviewColumns(store: TaskStore): Promise<ReadonlySet<string>> {
    /* DELIBERATE-LITERAL — unioned, not replaced: a board mid-rename still has rows stored under the
       old id, and skipping them is the failure this fixes. Reviewed 2026-07-31-13:00. */
    const reviewColumns = new Set<string>(["in-review"]);
    try {
      for (const definition of await store.listWorkflowDefinitions()) {
        const ir = typeof definition.ir === "string" ? parseWorkflowIr(definition.ir) : definition.ir;
        if (!ir) continue;
        for (const id of columnsWithFlag(ir, "mergeOrchestration")) reviewColumns.add(id);
        for (const id of columnsWithFlag(ir, "mergeBlocker")) reviewColumns.add(id);
        for (const id of columnsWithFlag(ir, "humanReview")) reviewColumns.add(id);
      }
    } catch {
      /* Unreadable definitions leave the legacy id alone — exactly the previous behaviour. */
    }
    return reviewColumns;
}

export async function listLegacyAutoMergeStampCandidatesImpl(store: TaskStore): Promise<Task[]> {
    const reviewColumns = await resolveLegacyStampReviewColumns(store);
    const byId = new Map<string, Task>();
    for (const column of reviewColumns) {
      for (const task of await store.listTasks({ column })) byId.set(task.id, task);
    }
    return [...byId.values()].filter((task) => store.isLegacyAutoMergeStampCandidate(task, reviewColumns));
}

export function deleteTaskByIdImpl(store: TaskStore, taskId: string): void {
    store.clearLinkedAgentTaskIds(taskId);
    store.purgeTaskWorkflowSelectionRows(taskId);
    store.db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);
    store.db.bumpLastModified();
}

export function suppressWatcherImpl(store: TaskStore, filePath: string): void {
    store.recentlyWritten.add(filePath);
    setTimeout(() => {
      store.recentlyWritten.delete(filePath);
    }, store.debounceMs + 100);
}

export async function addTaskCommentImpl(store: TaskStore, id: string, text: string, author: string): Promise<Task> {
    // Delegate to unified addComment method
    return store.addComment(id, text, author);
}

export function hasActiveTaskImpl(store: TaskStore, taskId: string): boolean {
    const row = store.db.prepare(`SELECT id FROM tasks WHERE id = ? AND ${TaskStore.ACTIVE_TASKS_WHERE}`).get(taskId) as
      | { id: string }
      | undefined;
    return Boolean(row);
}

export function invalidateConfigCacheAfterMigrationImpl(_store: TaskStore): void {
    // The project config is read fresh from SQLite each call (readConfigFast),
    // so there is no project-settings cache to invalidate. The global store does
    // cache; updateSettings() above already refreshed it. This hook exists as a
    // documented seam in case a config cache is added later.
}

export function setPluginWorkflowStepTemplatesImpl(store: TaskStore, templates: Array<{ pluginId: string; template: WorkflowStepTemplate }>): void {
    store._pluginWorkflowStepTemplates = [...templates];
    store.workflowStepsCache = null;
}

export function assertWorkflowIrTraitsValidImpl(store: TaskStore, ir: WorkflowIr): void {
    const columns = (ir as { columns?: WorkflowIrColumn[] }).columns;
    if (Array.isArray(columns) && columns.length > 0) {
      assertColumnTraitsValid(columns);
    }
}

export function applyBuiltInPromptOverridesSyncImpl(store: TaskStore, workflowId: string, ir: WorkflowIr): WorkflowIr {
    if (!isBuiltinWorkflowId(workflowId)) return ir;
    const projectId = store.getWorkflowSettingsProjectId();
    const overrides = store.getWorkflowPromptOverrides(workflowId, projectId);
    return applyPromptOverridesToIr(ir, overrides);
}

/*
FNXC:IncompletePgPorts 2026-07-26-20:40:
Async sibling for applyBuiltInPromptOverridesSyncImpl. Backend mode must load
workflow_prompt_overrides via Drizzle; the sync reader returns {} on PG and
silently dropped operator customizations from getWorkflowDefinition / move IR.
*/
export async function applyBuiltInPromptOverridesAsyncImpl(store: TaskStore, workflowId: string, ir: WorkflowIr): Promise<WorkflowIr> {
    if (!isBuiltinWorkflowId(workflowId)) return ir;
    const projectId = store.getWorkflowSettingsProjectId();
    const overrides = await store.getWorkflowPromptOverridesAsync(workflowId, projectId);
    return applyPromptOverridesToIr(ir, overrides);
}

export async function getDefaultWorkflowIdImpl(store: TaskStore): Promise<string | undefined> {
    const settings = await store.getSettingsFast();
    const typedSettings = settings as { defaultWorkflowId?: string; enabledBuiltinWorkflowIds?: string[] };
    /*
    FNXC:DisabledBuiltinWorkflows 2026-08-19-00:18:
    All no-selection callers share this effective resolver. A disabled built-in
    configured as the project default falls through to the first enabled catalog
    workflow, while custom defaults retain their explicit identity.
    */
    return resolveEffectiveDefaultWorkflowId(typedSettings.defaultWorkflowId, typedSettings.enabledBuiltinWorkflowIds);
}

/**
 * FNXC:OriginWorkflowSelection 2026-07-26-19:40:
 * Resolves the workflow OVERRIDE for a programmatic task origin — `fn task create`
 * (CLI + `fn_task_create` tool) and refinement tasks.
 *
 * Returns `undefined` to mean "no override, inherit the existing default path".
 * That is deliberate: the callers' existing behavior when no workflow is passed is
 * already `materializeDefaultWorkflowSteps()`, so falling through to `undefined`
 * reproduces it exactly rather than re-implementing it. Only a pinned setting or
 * the mirrored Board lane produces a concrete id.
 *
 * Precedence: pinned per-origin setting -> mirrored Board lane -> inherit (undefined).
 *
 * A configured id that no longer resolves — deleted workflow, or a fragment, which
 * is never independently selectable — degrades to inherit rather than throwing.
 * Task creation must not be breakable by a stale settings value; this mirrors the
 * same tolerance `aiUndoTaskWorkflowId`'s route applies.
 */
export type TaskOriginWorkflowKind = "task-create" | "refinement";

export async function resolveOriginWorkflowOverrideIdImpl(
  store: TaskStore,
  origin: TaskOriginWorkflowKind,
): Promise<string | undefined> {
  let candidate: string | undefined;
  let enabledBuiltinWorkflowIds: string[] | undefined;
  try {
    const settings = (await store.getSettingsFast()) as {
      taskCreateWorkflowId?: string;
      refinementTaskWorkflowId?: string;
      boardSelectedWorkflowId?: string;
      enabledBuiltinWorkflowIds?: string[];
    };
    const pinned = origin === "refinement"
      ? settings.refinementTaskWorkflowId
      : settings.taskCreateWorkflowId;
    candidate = pinned?.trim() || settings.boardSelectedWorkflowId?.trim() || undefined;
    enabledBuiltinWorkflowIds = settings.enabledBuiltinWorkflowIds;
  } catch {
    return undefined;
  }
  if (!candidate) return undefined;

  /*
  FNXC:DisabledBuiltinWorkflows 2026-08-19-00:18:
  Origin pins are new-selection settings, not compatibility assignments. A pinned
  built-in that was disabled must inherit the effective project default; existing
  tasks still resolve their stored workflow id through the direct definition path.
  */
  if (
    isBuiltinWorkflowId(candidate)
    && (!isBuiltinWorkflowToggleEligible(candidate) || !isBuiltinWorkflowEnabled(candidate, enabledBuiltinWorkflowIds))
  ) {
    return undefined;
  }

  try {
    const def = await store.getWorkflowDefinition(candidate);
    if (!def || def.kind === "fragment") return undefined;
    return candidate;
  } catch {
    return undefined;
  }
}

export function resolveTaskCustomFieldDefsSyncImpl(store: TaskStore, taskId: string): WorkflowFieldDefinition[] {
    const ir = store.resolveTaskWorkflowIrSync(taskId);
    return ir.version === "v2" ? (ir.fields ?? []) : [];
}

export async function clearTaskWorkflowSelectionImpl(store: TaskStore, taskId: string): Promise<void> {
    await store.withTaskLock(taskId, async () => {
      await store.removeMaterializedSelection(taskId);
      await store.updateTaskUnlocked(taskId, { enabledWorkflowSteps: [] });
    });
}

export function refreshDatabaseHealthImpl(store: TaskStore): ReturnType<TaskStore["getDatabaseHealth"]> {
    /*
    FNXC:IncompletePgPorts 2026-07-26-20:40:
    Sync refresh cannot await PostgreSQL. Kick a background async refresh when
    a layer is present, then return the last snapshot (or optimistic healthy
    until the first probe completes). Prefer refreshDatabaseHealthAsync from
    async callers (self-healing surfaceDbCorruption).

    FNXC:SqliteDualPathCleanup 2026-07-27-06:15:
    Only schedule the async probe when asyncLayer exists. Without a layer,
    refreshDatabaseHealthAsyncImpl used to call back into this sync entry and
    re-schedule forever (unbounded health-refresh microtask recursion).
    */
    if (store.asyncLayer) {
      void refreshDatabaseHealthAsyncImpl(store).catch(() => undefined);
    }
    return store.getDatabaseHealth();
}

/*
FNXC:IncompletePgPorts 2026-07-26-20:40:
Probe AsyncDataLayer.ping + pg_stat_database via checkPostgresHealth and store
the result on TaskStore.postgresHealthSnapshot for sync getDatabaseHealth /
healthCheck readers.
*/
export async function refreshDatabaseHealthAsyncImpl(store: TaskStore): Promise<ReturnType<TaskStore["getDatabaseHealth"]>> {
    if (!store.asyncLayer) {
      /*
      FNXC:SqliteDualPathCleanup 2026-07-27-06:15:
      No AsyncDataLayer: return the cached/safe incomplete-PG snapshot. Do not call
      refreshDatabaseHealthImpl here — that path re-schedules this function and would recurse.
      */
      return store.getDatabaseHealth();
    }
    store.postgresHealthSnapshot = {
      healthy: store.postgresHealthSnapshot?.healthy ?? true,
      corruptionDetected: store.postgresHealthSnapshot?.corruptionDetected ?? false,
      corruptionErrors: store.postgresHealthSnapshot?.corruptionErrors ?? [],
      lastCheckedAt: store.postgresHealthSnapshot?.lastCheckedAt ?? null,
      isRunning: true,
    };
    const { checkPostgresHealth } = await import("../postgres/postgres-health.js");
    const errors = await checkPostgresHealth(store.asyncLayer);
    const now = new Date();
    store.postgresHealthSnapshot = {
      healthy: errors.length === 0,
      corruptionDetected: errors.length > 0,
      corruptionErrors: errors.slice(0, 5),
      lastCheckedAt: now,
      isRunning: false,
    };
    return store.postgresHealthSnapshot;
}

export async function clearActivityLogImpl(store: TaskStore): Promise<void> {
    /*
     * FNXC:SqliteFinalRemoval 2026-06-25-16:35:
     * In backend mode, use the async layer to clear the activity log via
     * Drizzle instead of the SQLite-specific db.prepare() path.
     */
        const layer = store.asyncLayer!;
    await layer.db
      .delete(schema.project.activityLog)
      .where(eq(schema.project.activityLog.projectId, activityProjectPartition(layer.projectId ?? "")));
    return;
}

export function getInsightStoreImpl(store: TaskStore): InsightStore | AsyncInsightStore {
    if (!store.insightStore) {
      // FNXC:InsightStore 2026-06-27-09:15:
      // PG backend mode returns the AsyncDataLayer-backed AsyncInsightStore (CRUD
      // + run lifecycle over project.project_insights / project_insight_runs /
      // project_insight_run_events). The sync SQLite InsightStore (store.db) is
      // used only in legacy SQLite mode. Both expose the same method names; the
      // dashboard insights routes await the result so either works.
            const layer = store.getAsyncLayer();
      if (!layer) {
        throw new Error("InsightStore is not available: AsyncDataLayer not initialized in backend mode");
      }
      /*
       * FNXC:InsightRecallCapture 2026-08-11-10:56:
       * This lazy factory is the sole backend AsyncInsightStore composition root. Supplying the
       * live writer here keeps every upsert origin automatic while standalone constructors retain
       * the writer's no-op default.
       */
      store.insightStore = new AsyncInsightStore(layer, createRecallCaptureWriter({
        layer,
        logger: createLogger("insight-recall-capture"),
      }));

    }
    return store.insightStore;
}

export function getResearchStoreImpl(store: TaskStore): ResearchStore | AsyncResearchStore {
    if (!store.researchStore) {
      // FNXC:ResearchStore 2026-06-27-12:15:
      // PG backend mode returns the AsyncDataLayer-backed AsyncResearchStore (run CRUD
      // + lifecycle/retry machines over project.research_runs / research_run_events /
      // research_exports). The sync SQLite ResearchStore (store.db) is used only in
      // legacy SQLite mode. Both expose the same method names; the dashboard research
      // routes await the result so either works. AI research EXECUTION (the engine
      // ResearchOrchestrator/ResearchRunDispatcher) stays degraded in PG mode — those
      // are coupled to the sync EventEmitter ResearchStore and are out of scope here.
            const layer = store.getAsyncLayer();
      if (!layer) {
        throw new Error("ResearchStore is not available: AsyncDataLayer not initialized in backend mode");
      }
      store.researchStore = new AsyncResearchStore(layer);

    }
    return store.researchStore;
}

export function getTodoStoreImpl(store: TaskStore): TodoStore | AsyncTodoStore {
    if (!store.todoStore) {
      // FNXC:TodoStore 2026-06-27-04:00:
      // PG backend mode returns the AsyncDataLayer-backed AsyncTodoStore (CRUD
      // over project.todo_lists / project.todo_items). The sync SQLite TodoStore
      // (store.db) is used only in legacy SQLite mode. Both expose the same
      // method names; the dashboard todo routes await the result so either works.
            const layer = store.getAsyncLayer();
      if (!layer) {
        throw new Error("TodoStore is not available: AsyncDataLayer not initialized in backend mode");
      }
      store.todoStore = new AsyncTodoStore(layer);

    }
    return store.todoStore;
}

