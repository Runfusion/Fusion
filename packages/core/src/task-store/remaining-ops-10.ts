/**
 * remaining-ops-10 operations.
 *
 * FNXC:StoreModularization 2026-06-25-00:00:
 * Extracted from the monolithic packages/core/src/store.ts as a pure
 * behavior-preserving refactor. Each function receives the TaskStore
 * instance as its first parameter and performs byte-identical work.
 */

import { TaskStore } from "../store.js";
import { isBuiltinWorkflowId } from "../builtin-workflows.js";
import { InsightStore } from "../insight-store.js";
import { ResearchStore } from "../research-store.js";
import { type ActivityLogSnapshot, type TaskMetadataSnapshot, createActivityLogSnapshot, createTaskMetadataSnapshot } from "../shared-mesh-state.js";
import { type TaskRow } from "./persistence.js";
import * as schema from "../postgres/schema/index.js";
import { MergeRequestRow, WorkflowWorkItemRow } from "./row-types.js";
import { TodoStore } from "../todo-store.js";
import { assertColumnTraitsValid } from "../trait-registry.js";
import { BoardConfig, BranchGroup, MergeRequestRecord, Task, WorkflowStepTemplate, WorkflowWorkItem, WorkflowWorkItemKind } from "../types.js";
import { WorkflowFieldDefinition, WorkflowIr, WorkflowIrColumn } from "../workflow-ir-types.js";
import { applyPromptOverridesToIr } from "../workflow-prompt-overrides.js";
import { MoveTaskOptions } from "../store.js";

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

export function areAllDependenciesDoneImpl(store: TaskStore, dependencies: string[], tasksById: Map<string, Task>): boolean {
    return dependencies.every((dependencyId) => {
      const dependency = tasksById.get(dependencyId);
      return dependency?.column === "done" || dependency?.column === "archived";
    });
}

export function resolveWorkflowBypassGuardsImpl(store: TaskStore,
    moveSource: NonNullable<MoveTaskOptions["moveSource"]>,
    options?: MoveTaskOptions,
  ): boolean {
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
    return params.moveSource === "user" && params.fromColumn === "in-progress" && params.toColumn === "todo";
}

export function getMergeRequestRecordImpl(store: TaskStore, taskId: string): MergeRequestRecord | null {
    const row = store.db.prepare("SELECT * FROM merge_requests WHERE taskId = ?").get(taskId) as MergeRequestRow | undefined;
    return row ? store.rowToMergeRequestRecord(row) : null;
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

export async function listLegacyAutoMergeStampCandidatesImpl(store: TaskStore): Promise<Task[]> {
    const inReview = await store.listTasks({ column: "in-review" });
    return inReview.filter((task) => store.isLegacyAutoMergeStampCandidate(task));
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

export async function getDefaultWorkflowIdImpl(store: TaskStore): Promise<string | undefined> {
    const settings = await store.getSettingsFast();
    const id = (settings as { defaultWorkflowId?: string }).defaultWorkflowId;
    return id && id.trim() ? id : undefined;
}

export function resolveTaskCustomFieldDefsSyncImpl(store: TaskStore, taskId: string): WorkflowFieldDefinition[] {
    const ir = store.resolveTaskWorkflowIrSync(taskId);
    return ir.version === "v2" ? (ir.fields ?? []) : [];
}

export function resolveEffectiveWorkflowIdSyncImpl(store: TaskStore, taskId: string): string {
    const selection = store.getTaskWorkflowSelection(taskId);
    return selection?.workflowId ?? TaskStore.DEFAULT_WORKFLOW_POOL_ID;
}

export async function clearTaskWorkflowSelectionImpl(store: TaskStore, taskId: string): Promise<void> {
    await store.withTaskLock(taskId, async () => {
      store.removeMaterializedSelection(taskId);
      await store.updateTaskUnlocked(taskId, { enabledWorkflowSteps: [] });
    });
}

export function refreshDatabaseHealthImpl(store: TaskStore): ReturnType<TaskStore["getDatabaseHealth"]> {
    /*
     * FNXC:SqliteFinalRemoval 2026-06-25-16:30:
     * In backend mode, the SQLite integrity_check refresh path is not
     * applicable (PostgreSQL manages its own integrity). Delegate to
     * getDatabaseHealth() which returns the healthy sentinel.
     */
    if (store.backendMode) {
      return store.getDatabaseHealth();
    }
    store.db.refreshIntegrityCheck();
    return store.getDatabaseHealth();
}

export async function clearActivityLogImpl(store: TaskStore): Promise<void> {
    /*
     * FNXC:SqliteFinalRemoval 2026-06-25-16:35:
     * In backend mode, use the async layer to clear the activity log via
     * Drizzle instead of the SQLite-specific db.prepare() path.
     */
    if (store.backendMode) {
      await store.asyncLayer!.db.delete(schema.project.activityLog);
      return;
    }
    store.db.prepare("DELETE FROM activityLog").run();
    store.db.bumpLastModified();
}

export function getInsightStoreImpl(store: TaskStore): InsightStore {
    if (!store.insightStore) {
      store.insightStore = new InsightStore(store.db);
    }
    return store.insightStore;
}

export function getResearchStoreImpl(store: TaskStore): ResearchStore {
    if (!store.researchStore) {
      store.researchStore = new ResearchStore(store.db);
    }
    return store.researchStore;
}

export function getTodoStoreImpl(store: TaskStore): TodoStore {
    if (!store.todoStore) {
      store.todoStore = new TodoStore(store.db);
    }
    return store.todoStore;
}

export async function getTaskMetadataSnapshotImpl(store: TaskStore): Promise<TaskMetadataSnapshot> {
    const tasks = await store.listTasks({ slim: false, includeArchived: true });
    return createTaskMetadataSnapshot(tasks as unknown as TaskMetadataSnapshot["payload"]["tasks"]);
}

export async function getActivityLogSnapshotImpl(store: TaskStore, limit = 10_000): Promise<ActivityLogSnapshot> {
    const entries = await store.getActivityLog({ limit });
    return createActivityLogSnapshot([...entries].reverse());
}

