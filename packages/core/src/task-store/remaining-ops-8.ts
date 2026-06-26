/**
 * remaining-ops-8 operations.
 *
 * FNXC:StoreModularization 2026-06-25-00:00:
 * Extracted from the monolithic packages/core/src/store.ts as a pure
 * behavior-preserving refactor. Each function receives the TaskStore
 * instance as its first parameter and performs byte-identical work.
 */

import { TaskStore } from "../store.js";
import { pruneAgentLogFiles as pruneAgentLogFileEntries, readAgentLogEntriesByTimeRange } from "../agent-log-file-store.js";
import { BUILTIN_CODING_WORKFLOW_IR } from "../builtin-coding-workflow-ir.js";
import { BUILTIN_WORKFLOWS, getBuiltinWorkflow, getRequiredPluginIdForBuiltinWorkflow, isBuiltinWorkflowEnabled, isBuiltinWorkflowId, isBuiltinWorkflowPluginGated } from "../builtin-workflows.js";
import { CentralCore } from "../central-core.js";
import { fromJson } from "../db.js";
import { type DistributedTaskIdAllocator, createDistributedTaskIdAllocator } from "../distributed-task-id.js";
import { ExperimentSessionStore } from "../experiment-session-store.js";
import { MasterKeyManager } from "../master-key.js";
import { MissionStore } from "../mission-store.js";
import { type PluginGateVerdict } from "../plugin-gate-verdict.js";
import { PluginStore } from "../plugin-store.js";
import { SecretsStore } from "../secrets-store.js";
import { type ActivityLogSnapshot, type TaskMetadataSnapshot, toTaskMetadataRecord, validateSnapshotEnvelope } from "../shared-mesh-state.js";
import { createAsyncDistributedTaskIdAllocator } from "./async-allocator.js";
import { compactTaskActivityLog } from "./comments.js";
import { type TaskRow } from "./persistence.js";
import { ActivityLogRow } from "./row-types.js";
import { ActivityEventType, ActivityLogEntry, AgentLogEntry, ArchivedTaskEntry, DEFAULT_SETTINGS, Settings, Task } from "../types.js";
import { eq } from "drizzle-orm";
import * as schema from "../postgres/schema/index.js";
import { compileWorkflowToSteps, isInterpreterDeferredWorkflowCompileError } from "../workflow-compiler.js";
import { WorkflowDefinition, WorkflowDefinitionInput, WorkflowNodeLayout } from "../workflow-definition-types.js";
import { WorkflowIr } from "../workflow-ir-types.js";
import { downgradeIrToV1IfPure, parseWorkflowIr, serializeWorkflowIr } from "../workflow-ir.js";
import { resolveDefaultOnOptionalGroupIds } from "../workflow-optional-steps.js";
import { resolveSwitchReconciliation } from "../workflow-reconciliation.js";
import { WORKFLOW_COMPILED_STEP_TEMPLATE_PREFIX } from "../store.js";

export async function getAgentLogsByTimeRangeImpl(store: TaskStore,
    taskId: string,
    startIso: string,
    endIso: string | null,
  ): Promise<AgentLogEntry[]> {
    // Ensure buffered entries are visible before reading.
    store.flushAgentLogBuffer();
    if (store.readTaskFromDb(taskId, { includeDeleted: true })?.deletedAt) {
      return [];
    }
    const end = endIso ?? new Date().toISOString();
    return readAgentLogEntriesByTimeRange(store.taskDir(taskId), startIso, end).map(
      ({ lineNo: _lineNo, sourceRef: _sourceRef, ...entry }) => entry,
    );
}

export async function importLegacyAgentLogsOnceImpl(store: TaskStore): Promise<void> {
    const migrationKey = "agentLogLegacyFileImportVersion";
    const migrationVersion = "1";
    const row = store.db.prepare("SELECT value FROM __meta WHERE key = ?").get(migrationKey) as
      | { value: string }
      | undefined;

    if (row?.value === migrationVersion) {
      return;
    }

    await store.importLegacyAgentLogs();
    store.db.prepare(`
      INSERT INTO __meta (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(migrationKey, migrationVersion);
    store.db.bumpLastModified();
}

export function readRawProjectSettingsImpl(store: TaskStore): Record<string, unknown> {
    try {
      const row = store.db.prepare("SELECT settings FROM config WHERE id = 1").get() as
        | { settings: string }
        | undefined;
      if (!row) return {};
      const parsed = JSON.parse(row.settings) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
}

export function migrateLegacyArchiveEntriesToArchiveDbImpl(store: TaskStore): void {
    const rows = store.db.prepare("SELECT id, data FROM archivedTasks").all() as Array<{ id: string; data: string }>;
    if (rows.length === 0) {
      return;
    }

    for (const row of rows) {
      const entry = JSON.parse(row.data) as ArchivedTaskEntry;
      store._archiveDb?.upsert({
        ...entry,
        log: compactTaskActivityLog(entry.log ?? []),
      });
    }

    store.db.prepare("DELETE FROM archivedTasks").run();
    store.db.bumpLastModified();
}

export async function migrateActiveArchivedTasksToArchiveDbImpl(store: TaskStore): Promise<void> {
    const rows = store.db.prepare(`SELECT * FROM tasks WHERE "column" = 'archived'`).all() as unknown as TaskRow[];
    if (rows.length === 0) {
      return;
    }

    const { rm } = await import("node:fs/promises");
    for (const row of rows) {
      const task = store.rowToTask(row);
      const archivedAt = task.columnMovedAt ?? task.updatedAt ?? new Date().toISOString();
      const entry = await store.taskToArchiveEntry(task, archivedAt);
      store.archiveDb.upsert(entry);
      store.purgeTaskWorkflowSelectionRows(task.id);
      store.db.prepare("DELETE FROM tasks WHERE id = ?").run(task.id);
      await rm(store.taskDir(task.id), { recursive: true, force: true });
      if (store.isWatching) {
        store.taskCache.delete(task.id);
      }
    }

    store.db.bumpLastModified();
}

export function resolvePluginWorkflowStepImpl(store: TaskStore, id: string): import("../types.js").WorkflowStep | undefined {
    const match = id.match(/^plugin:([^:]+):(.+)$/);
    if (!match) return undefined;

    const [, pluginId, stepId] = match;
    const entry = store._pluginWorkflowStepTemplates.find(
      ({ pluginId: candidatePluginId, template }) => candidatePluginId === pluginId && template.id === id,
    );
    if (!entry) return undefined;

    const now = new Date().toISOString();
    return {
      id,
      templateId: stepId,
      name: entry.template.name,
      description: entry.template.description,
      mode: entry.template.mode ?? "prompt",
      phase: entry.template.phase ?? "pre-merge",
      gateMode: entry.template.gateMode ?? "advisory",
      prompt: entry.template.prompt ?? "",
      scriptName: entry.template.scriptName,
      toolMode: entry.template.toolMode,
      enabled: entry.template.enabled ?? true,
      defaultOn: entry.template.defaultOn,
      modelProvider: entry.template.modelProvider,
      modelId: entry.template.modelId,
      createdAt: now,
      updatedAt: now,
    };
}

export function nextWorkflowDefinitionIdImpl(store: TaskStore): string {
    // Serialize the read+increment in one write transaction so two TaskStore
    // instances cannot both observe the same counter and allocate the same
    // WF-id (which would collide on the workflows primary key).
    return store.db.transactionImmediate(() => {
      const row = store.db.prepare("SELECT value FROM __meta WHERE key = 'nextWorkflowDefinitionId'").get() as
        | { value: string }
        | undefined;
      const next = row ? parseInt(row.value, 10) || 1 : 1;
      store.db
        .prepare(
          "INSERT INTO __meta (key, value) VALUES ('nextWorkflowDefinitionId', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .run(String(next + 1));
      return `WF-${String(next).padStart(3, "0")}`;
    });
}

export function parseWorkflowLayoutImpl(store: TaskStore,
    raw: string,
  ): Record<string, WorkflowNodeLayout> {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, WorkflowNodeLayout>;
      }
    } catch {
      // Corrupt layout JSON falls back to empty (auto-layout) rather than failing the read.
    }
    return {};
}

export async function listWorkflowDefinitionsImpl(store: TaskStore,
    options?: { kind?: WorkflowDefinition["kind"]; includeDisabledBuiltins?: boolean },
  ): Promise<WorkflowDefinition[]> {
    const all = await store.readAllWorkflowDefinitions();
    let enabledBuiltinWorkflowIds: readonly string[] | undefined;
    if (!options?.includeDisabledBuiltins) {
      try {
        const settings = await store.getSettings();
        enabledBuiltinWorkflowIds = Array.isArray(settings.enabledBuiltinWorkflowIds)
          ? settings.enabledBuiltinWorkflowIds
          : undefined;
      } catch {
        enabledBuiltinWorkflowIds = undefined;
      }
    }
    const enabledVisible = options?.includeDisabledBuiltins
      ? all
      : all.filter((wf) => isBuiltinWorkflowEnabled(wf.id, enabledBuiltinWorkflowIds));
    const visible = await Promise.all(
      enabledVisible.map(async (wf) => {
        const requiredPluginId = getRequiredPluginIdForBuiltinWorkflow(wf.id);
        if (!requiredPluginId) return wf;
        return (await store.isPluginInstalled(requiredPluginId)) ? wf : undefined;
      }),
    );
    const pluginFiltered = visible.filter((wf): wf is WorkflowDefinition => Boolean(wf));
    if (options?.kind) return pluginFiltered.filter((wf) => wf.kind === options.kind);
    return pluginFiltered;
}

export async function readAllWorkflowDefinitionsImpl(store: TaskStore): Promise<WorkflowDefinition[]> {
    if (store.workflowDefinitionsCache) return store.workflowDefinitionsCache;
    const rows = store.db.prepare("SELECT * FROM workflows ORDER BY createdAt ASC").all() as Array<{
      id: string;
      name: string;
      description: string;
      ir: string;
      layout: string;
      kind?: string | null;
      createdAt: string;
      updatedAt: string;
    }>;
    store.workflowDefinitionsCache = [...BUILTIN_WORKFLOWS, ...rows.map((row) => store.toWorkflowDefinition(row))];
    return store.workflowDefinitionsCache;
}

export async function getWorkflowDefinitionImpl(store: TaskStore,
    id: string,
  ): Promise<WorkflowDefinition | undefined> {
    const builtin = getBuiltinWorkflow(id);
    if (builtin) {
      if (isBuiltinWorkflowPluginGated(id)) {
        const requiredPluginId = getRequiredPluginIdForBuiltinWorkflow(id);
        if (!requiredPluginId || !(await store.isPluginInstalled(requiredPluginId))) return undefined;
      }
      return { ...builtin, ir: store.applyBuiltInPromptOverridesSync(id, builtin.ir) };
    }
    const row = store.db.prepare("SELECT * FROM workflows WHERE id = ?").get(id) as
      | {
          id: string;
          name: string;
          description: string;
          ir: string;
          layout: string;
          kind?: string | null;
          createdAt: string;
          updatedAt: string;
        }
      | undefined;
    return row ? store.toWorkflowDefinition(row) : undefined;
}

export function occupantsByColumnForWorkflowImpl(store: TaskStore,
    workflowId: string,
    includeNullSelection: boolean,
  ): Map<string, number> {
    const counts = new Map<string, number>();
    for (const taskId of store.listWorkflowOccupantTaskIds(workflowId, includeNullSelection)) {
      const row = store.db.prepare(`SELECT "column" AS column FROM tasks WHERE id = ?`).get(taskId) as
        | { column: string }
        | undefined;
      if (!row) continue;
      counts.set(row.column, (counts.get(row.column) ?? 0) + 1);
    }
    return counts;
}

export function insertWorkflowDefinitionSyncImpl(store: TaskStore,
    input: WorkflowDefinitionInput,
    flagOn: boolean,
  ): WorkflowDefinition {
    const name = input.name?.trim();
    if (!name) throw new Error("Workflow name is required");
    const ir = parseWorkflowIr(input.ir);
    store.assertWorkflowIrTraitsValid(ir);
    const layout = input.layout ?? {};
    const now = new Date().toISOString();
    const id = store.nextWorkflowDefinitionId();
    const definition: WorkflowDefinition = {
      id,
      name,
      description: input.description ?? "",
      kind: input.kind === "fragment" ? "fragment" : "workflow",
      ir,
      layout,
      createdAt: now,
      updatedAt: now,
    };
    store.db
      .prepare(
        `INSERT INTO workflows (id, name, description, ir, layout, kind, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        definition.id,
        definition.name,
        definition.description,
        serializeWorkflowIr(flagOn ? definition.ir : downgradeIrToV1IfPure(definition.ir)),
        JSON.stringify(definition.layout),
        definition.kind,
        definition.createdAt,
        definition.updatedAt,
      );
    store.workflowDefinitionsCache = null;
    return definition;
}

export async function isWorkflowCliCommandApprovedImpl(store: TaskStore, command: string): Promise<boolean> {
    const trimmed = command.trim();
    if (!trimmed) return false;
    const settings = await store.getSettings();
    const approved = (settings as { approvedWorkflowCliCommands?: string[] }).approvedWorkflowCliCommands;
    return Array.isArray(approved) && approved.includes(trimmed);
}

export async function approveWorkflowCliCommandImpl(store: TaskStore, command: string): Promise<void> {
    const trimmed = command.trim();
    if (!trimmed) throw new Error("CLI command is required");
    const settings = await store.getSettings();
    const approved = (settings as { approvedWorkflowCliCommands?: string[] }).approvedWorkflowCliCommands ?? [];
    if (approved.includes(trimmed)) return;
    await store.updateSettings({
      approvedWorkflowCliCommands: [...approved, trimmed],
    } as unknown as Partial<Settings>);
}

export async function isCliAutonomyApprovedImpl(store: TaskStore, adapterId: string): Promise<boolean> {
    const trimmed = adapterId.trim();
    if (!trimmed) return false;
    const settings = await store.getSettings();
    const approved = (settings as { approvedCliAutonomyAdapters?: string[] }).approvedCliAutonomyAdapters;
    return Array.isArray(approved) && approved.includes(trimmed);
}

export async function approveCliAutonomyImpl(store: TaskStore, adapterId: string): Promise<void> {
    const trimmed = adapterId.trim();
    if (!trimmed) throw new Error("Adapter id is required");
    const settings = await store.getSettings();
    const approved = (settings as { approvedCliAutonomyAdapters?: string[] }).approvedCliAutonomyAdapters ?? [];
    if (approved.includes(trimmed)) return;
    await store.updateSettings({
      approvedCliAutonomyAdapters: [...approved, trimmed],
    } as unknown as Partial<Settings>);
}

export async function revokeCliAutonomyImpl(store: TaskStore, adapterId: string): Promise<void> {
    const trimmed = adapterId.trim();
    if (!trimmed) return;
    const settings = await store.getSettings();
    const approved = (settings as { approvedCliAutonomyAdapters?: string[] }).approvedCliAutonomyAdapters ?? [];
    if (!approved.includes(trimmed)) return;
    await store.updateSettings({
      approvedCliAutonomyAdapters: approved.filter((a) => a !== trimmed),
    } as unknown as Partial<Settings>);
}

export function recordPluginGateVerdictImpl(store: TaskStore,
    taskId: string,
    toColumn: string,
    verdict: Omit<PluginGateVerdict, "recordedAt"> & { recordedAt?: number },
  ): void {
    let byColumn = store.pluginGateVerdicts.get(taskId);
    if (!byColumn) {
      byColumn = new Map();
      store.pluginGateVerdicts.set(taskId, byColumn);
    }
    const list = byColumn.get(toColumn) ?? [];
    // Replace any prior verdict for the same trait (latest evaluation wins).
    const filtered = list.filter((v) => v.traitId !== verdict.traitId);
    filtered.push({ ...verdict, recordedAt: verdict.recordedAt ?? Date.now() });
    byColumn.set(toColumn, filtered);
}

export function consumePluginGateVerdictsImpl(store: TaskStore, taskId: string, toColumn: string): PluginGateVerdict[] {
    const byColumn = store.pluginGateVerdicts.get(taskId);
    if (!byColumn) return [];
    const list = byColumn.get(toColumn) ?? [];
    byColumn.delete(toColumn);
    if (byColumn.size === 0) store.pluginGateVerdicts.delete(taskId);
    return list;
}

export function resolveTaskWorkflowIrSyncImpl(store: TaskStore, taskId: string): WorkflowIr {
    const selection = store.getTaskWorkflowSelection(taskId);
    const workflowId = selection?.workflowId;
    if (!workflowId) return store.applyBuiltInPromptOverridesSync("builtin:coding", BUILTIN_CODING_WORKFLOW_IR);
    if (isBuiltinWorkflowId(workflowId)) {
      const builtin = getBuiltinWorkflow(workflowId);
      return store.applyBuiltInPromptOverridesSync(workflowId, builtin?.ir ?? BUILTIN_CODING_WORKFLOW_IR);
    }
    try {
      const row = store.db
        .prepare("SELECT ir FROM workflows WHERE id = ?")
        .get(workflowId) as { ir: string } | undefined;
      if (!row) return BUILTIN_CODING_WORKFLOW_IR;
      return parseWorkflowIr(row.ir);
    } catch {
      return BUILTIN_CODING_WORKFLOW_IR;
    }
}

export function getTaskWorkflowSelectionImpl(store: TaskStore, taskId: string): { workflowId: string; stepIds: string[] } | undefined {
    const row = store.db
      .prepare("SELECT workflowId, stepIds FROM task_workflow_selection WHERE taskId = ?")
      .get(taskId) as { workflowId: string; stepIds: string } | undefined;
    if (!row) return undefined;
    let stepIds: string[] = [];
    try {
      const parsed = JSON.parse(row.stepIds) as unknown;
      if (Array.isArray(parsed)) stepIds = parsed.filter((s): s is string => typeof s === "string");
    } catch {
      // Corrupt list falls back to empty.
    }
    return { workflowId: row.workflowId, stepIds };
}

export function writeTaskWorkflowSelectionImpl(store: TaskStore, taskId: string, workflowId: string, stepIds: string[]): void {
    store.db
      .prepare(
        `INSERT INTO task_workflow_selection (taskId, workflowId, stepIds, updatedAt)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(taskId) DO UPDATE SET
           workflowId = excluded.workflowId,
           stepIds = excluded.stepIds,
           updatedAt = excluded.updatedAt`,
      )
      .run(taskId, workflowId, JSON.stringify(stepIds), new Date().toISOString());
}

export function removeMaterializedSelectionImpl(store: TaskStore, taskId: string): void {
    const existing = store.getTaskWorkflowSelection(taskId);
    if (existing) {
      for (const stepId of existing.stepIds) {
        store.db.prepare("DELETE FROM workflow_steps WHERE id = ?").run(stepId);
      }
      store.workflowStepsCache = null;
    }
    store.db.prepare("DELETE FROM task_workflow_selection WHERE taskId = ?").run(taskId);
}

export function purgeTaskWorkflowSelectionRowsImpl(store: TaskStore, taskId: string): void {
    /*
     * FNXC:FixPgTestsAndCi 2026-06-26-09:30:
     * Backend-mode branch for the tombstone-resurrection hard-delete path
     * (maybeResolveTombstonedTaskId → purgeTaskWorkflowSelectionRows). The
     * sync SQLite path read the task_workflow_selection row, deleted its
     * workflow_steps children, then deleted the selection row. The backend
     * branch mirrors that against the async Drizzle layer so forceResurrect
     * recreation works in PG mode (FN-5233 soft-delete-stickiness invariant,
     * VAL-DATA-005/006).
     */
    if (store.backendMode) {
      // Drizzle queries are async; synchronously schedule the purge and let
      // the awaiting caller (maybeResolveTombstonedTaskId, already async)
      // observe completion. We cannot await here without changing the return
      // type, so we throw-and-rethrow via a microtask is not viable. Instead
      // the async caller must use purgeTaskWorkflowSelectionRowsAsync below.
      // To preserve the existing synchronous call sites that ignore the result,
      // we fire-and-forget ONLY in the non-critical path. The resurrection
      // path uses the async variant directly.
      void purgeTaskWorkflowSelectionRowsAsyncImpl(store, taskId);
      return;
    }
    const row = store.db
      .prepare("SELECT stepIds FROM task_workflow_selection WHERE taskId = ?")
      .get(taskId) as { stepIds: string } | undefined;
    if (!row) return;
    try {
      const parsed = JSON.parse(row.stepIds) as unknown;
      if (Array.isArray(parsed)) {
        for (const stepId of parsed) {
          if (typeof stepId === "string") {
            store.db.prepare("DELETE FROM workflow_steps WHERE id = ?").run(stepId);
          }
        }
      }
    } catch {
      // Corrupt stepIds list — still remove the selection row below.
    }
    store.db.prepare("DELETE FROM task_workflow_selection WHERE taskId = ?").run(taskId);
    store.workflowStepsCache = null;
}

/**
 * FNXC:FixPgTestsAndCi 2026-06-26-09:30:
 * Async backend implementation of purgeTaskWorkflowSelectionRows for PG mode.
 * Reads the task_workflow_selection row, deletes its workflow_steps children,
 * then deletes the selection row — all against the async Drizzle layer.
 * Called by maybeResolveTombstonedTaskId on the resurrection hard-delete path.
 */
export async function purgeTaskWorkflowSelectionRowsAsyncImpl(store: TaskStore, taskId: string): Promise<void> {
  if (!store.backendMode) {
    purgeTaskWorkflowSelectionRowsImpl(store, taskId);
    return;
  }
  const layer = store.asyncLayer!;
  const rows = await layer.db
    .select({ stepIds: schema.project.taskWorkflowSelection.stepIds })
    .from(schema.project.taskWorkflowSelection)
    .where(eq(schema.project.taskWorkflowSelection.taskId, taskId))
    .limit(1);
  if (rows.length === 0) return;
  try {
    const parsed = rows[0]?.stepIds as unknown;
    if (Array.isArray(parsed)) {
      for (const stepId of parsed) {
        if (typeof stepId === "string") {
          await layer.db.delete(schema.project.workflowSteps).where(eq(schema.project.workflowSteps.id, stepId));
        }
      }
    }
  } catch {
    // Corrupt stepIds list — still remove the selection row below.
  }
  await layer.db.delete(schema.project.taskWorkflowSelection).where(eq(schema.project.taskWorkflowSelection.taskId, taskId));
  store.workflowStepsCache = null;
}

export function cleanupOrphanedMaterializedStepsImpl(store: TaskStore, stepIds: string[] | undefined): void {
    if (!stepIds || stepIds.length === 0) return;
    for (const stepId of stepIds) {
      try {
        store.db.prepare("DELETE FROM workflow_steps WHERE id = ?").run(stepId);
      } catch {
        // Best-effort cleanup.
      }
    }
    store.workflowStepsCache = null;
}

export async function materializeWorkflowStepsImpl(store: TaskStore,
    workflowId: string,
    inputs: import("../types.js").WorkflowStepInput[],
  ): Promise<string[]> {
    const ids: string[] = [];
    for (const input of inputs) {
      const step = await store.createWorkflowStep({
        ...input,
        templateId: `${WORKFLOW_COMPILED_STEP_TEMPLATE_PREFIX}${workflowId}`,
        enabled: true,
      });
      ids.push(step.id);
    }
    return ids;
}

export async function materializeExplicitWorkflowStepsImpl(store: TaskStore,
    workflowId: string,
  ): Promise<{ workflowId: string; stepIds: string[] }> {
    const def = await store.getWorkflowDefinition(workflowId);
    if (!def) throw new Error(`Workflow '${workflowId}' not found`);
    if (def.kind === "fragment") {
      throw new Error(`Workflow '${workflowId}' is a fragment and cannot be selected for a task`);
    }
    let inputs: import("../types.js").WorkflowStepInput[];
    try {
      inputs = compileWorkflowToSteps(def.ir);
    } catch (err) {
      if (isBuiltinWorkflowId(workflowId) && isInterpreterDeferredWorkflowCompileError(err))
        return { workflowId, stepIds: resolveDefaultOnOptionalGroupIds(def.ir) };
      throw err;
    }
    // FNXC:WorkflowOptionalGroup 2026-06-21-14:20: same defaultOn-group seeding as
    // the default-workflow path, for an explicitly requested create-time workflow.
    const defaultGroupIds = resolveDefaultOnOptionalGroupIds(def.ir);
    const stepIds = await store.materializeWorkflowSteps(workflowId, inputs);
    return { workflowId, stepIds: [...stepIds, ...defaultGroupIds] };
}

export async function selectTaskWorkflowAndReconcileImpl(store: TaskStore,
    taskId: string,
    workflowId: string,
  ): Promise<{
    enabledWorkflowSteps: string[];
    reconciliation?: { preserved: boolean; fromColumn: string; toColumn: string };
  }> {
    const enabledWorkflowSteps = await store.selectTaskWorkflow(taskId, workflowId);
    if (!(await store.workflowColumnsFlagOn())) {
      return { enabledWorkflowSteps };
    }
    const newIr = store.resolveTaskWorkflowIrSync(taskId);
    const current = store.readTaskFromDb(taskId, { includeDeleted: false });
    if (!current) return { enabledWorkflowSteps };
    const fromColumn = current.column;
    const decision = resolveSwitchReconciliation(newIr, fromColumn);
    if (!decision.preserved && decision.targetColumn !== fromColumn) {
      await store.rehomeOccupant(taskId, decision.targetColumn, "workflow-switch", { workflowId });
    }
    return {
      enabledWorkflowSteps,
      reconciliation: {
        preserved: decision.preserved,
        fromColumn,
        toColumn: decision.targetColumn,
      },
    };
}

export function pruneAgentLogFilesImpl(store: TaskStore, retentionDays: number): { prunedFiles: number; prunedEntries: number; freedBytes: number } {
    if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
      return { prunedFiles: 0, prunedEntries: 0, freedBytes: 0 };
    }
    // Only prune JSONL files for tasks that are no longer active (soft-deleted or archived)
    const inactiveTaskIds = new Set(
      (
        store.db
          .prepare(`SELECT id FROM tasks WHERE deletedAt IS NOT NULL OR "column" = 'archived'`)
          .all() as Array<{ id: string }>
      ).map((row) => row.id),
    );
    return pruneAgentLogFileEntries(store.tasksDir, retentionDays, inactiveTaskIds);
}

export async function getSecretsStoreImpl(store: TaskStore): Promise<SecretsStore> {
    if (store.secretsStore) {
      return store.secretsStore;
    }

    const masterKeyManager = new MasterKeyManager();
    const masterKeyProvider = () => masterKeyManager.getOrCreateKey();

    // FNXC:SecretsStore 2026-06-24-21:10:
    // In backend mode, pass the AsyncDataLayer so SecretsStore delegates to
    // the async helpers. The sync projectDb/centralDb are still required by
    // the constructor signature but are unused when asyncLayer is set.
    if (store.backendMode) {
      const layer = store.asyncLayer!;
      // CentralCore is not needed in backend mode; the async layer serves both
      // project and central schemas. We pass dummy stubs for the sync DBs since
      // they are never used when asyncLayer is present.
      const noopDb = { prepare: () => { throw new Error("sync DB not available in backend mode"); }, bumpLastModified: () => {} } as unknown as import("../db.js").Database;
      const noopCentral = noopDb as unknown as import("../central-db.js").CentralDatabase;
      store.secretsStore = new SecretsStore(noopDb, noopCentral, masterKeyProvider, { asyncLayer: layer });
      return store.secretsStore;
    }

    const central = new CentralCore(store.getFusionDir());
    await central.init();
    store.secretsCentralCore = central;
    const centralDb = (central as unknown as { db: import("../central-db.js").CentralDatabase | null }).db;
    if (!centralDb) {
      throw new Error("Central database unavailable for secrets store");
    }
    store.secretsStore = new SecretsStore(store.db, centralDb, masterKeyProvider);
    return store.secretsStore;
}

export function getDatabaseHealthImpl(store: TaskStore): {
    healthy: boolean;
    corruptionDetected: boolean;
    corruptionErrors: string[];
    lastCheckedAt: Date | null;
    isRunning: boolean;
  } {
    /*
     * FNXC:SqliteFinalRemoval 2026-06-25-16:30:
     * In backend mode, SQLite-specific corruption detection (PRAGMA
     * integrity_check) is not applicable. PostgreSQL health is checked via
     * the async layer. Return a healthy sentinel so synchronous callers do
     * not block; the real health signal comes from /api/health.
     */
    if (store.backendMode) {
      return {
        healthy: true,
        corruptionDetected: false,
        corruptionErrors: [],
        lastCheckedAt: null,
        isRunning: false,
      };
    }
    const corruptionDetected = store.db.corruptionDetected;
    return {
      healthy: !corruptionDetected,
      corruptionDetected,
      corruptionErrors: store.db.integrityCheckErrors.slice(0, 5),
      lastCheckedAt: store.db.integrityCheckLastRunAt ? new Date(store.db.integrityCheckLastRunAt) : null,
      isRunning: store.db.integrityCheckPending,
    };
}

export function getDistributedTaskIdAllocatorImpl(store: TaskStore): DistributedTaskIdAllocator {
    // FNXC:RuntimeTaskOrchestrationAsync 2026-06-24-12:50:
    // In backend mode, the sync DistributedTaskIdAllocator (which wraps sync
    // SQLite db.prepare calls) cannot operate against async PostgreSQL. Instead,
    // we create an async allocator backed by the AsyncDataLayer. The allocator
    // reconciliation (bumping sequences to the high-water mark) is handled by
    // reconcileTaskIdStateAsync() during init(). The async allocator handles
    // the reserve/commit/abort lifecycle against the PostgreSQL
    // distributed_task_id_state and distributed_task_id_reservations tables.
    if (store.backendMode) {
      if (!store.asyncDistributedTaskIdAllocator) {
        store.asyncDistributedTaskIdAllocator = createAsyncDistributedTaskIdAllocator(store.asyncLayer!);
      }
      return store.asyncDistributedTaskIdAllocator;
    }
    if (!store.distributedTaskIdAllocator) {
      store.distributedTaskIdAllocator = createDistributedTaskIdAllocator(store.db);
    }
    return store.distributedTaskIdAllocator;
}

export function healthCheckImpl(store: TaskStore): boolean {
    // FNXC:RuntimePersistenceAsync 2026-06-24-11:08:
    // In backend mode, the sync SQLite health check is not applicable.
    // PostgreSQL health is checked via the async ping() method on the
    // AsyncDataLayer (wired by postgres-health.ts). Return true here so
    // synchronous callers do not block; the real health signal comes from
    // the /api/health endpoint which uses the async path.
    if (store.backendMode) {
      return true;
    }
    try {
      // Simple query to verify database responsiveness
      store.db.prepare("SELECT 1").get();
      return store.db.checkFts5Integrity();
    } catch {
      return false;
    }
}

export function getSettingsSyncImpl(store: TaskStore): Settings {
    // FNXC:RuntimePersistenceAsync 2026-06-24-10:30:
    // In backend mode, no synchronous DB read is possible (PostgreSQL is async).
    // This method is only used by generateSpecifiedPrompt for ntfy settings.
    // Return DEFAULT_SETTINGS; the async getSettings() path is the authoritative
    // settings read in backend mode. Callers needing live settings must use the
    // async path (getSettings/getSettingsFast).
    if (store.backendMode) {
      return DEFAULT_SETTINGS;
    }
    try {
      const row = store.db.prepare("SELECT settings FROM config WHERE id = 1").get() as { settings: string | null } | undefined;
      if (!row) return DEFAULT_SETTINGS;
      const settings = fromJson<Settings>(row.settings);
      return { ...DEFAULT_SETTINGS, ...settings };
    } catch {
      return DEFAULT_SETTINGS;
    }
}

export async function getInReviewDurationEventsImpl(store: TaskStore, options: { since: string; until: string }): Promise<ActivityLogEntry[]> {
    const rows = store.db
      .prepare(
        `SELECT * FROM activityLog
         WHERE type = 'task:moved'
           AND timestamp > ?
           AND timestamp <= ?
           AND (
             json_extract(metadata, '$.to') = 'in-review'
             OR (
               json_extract(metadata, '$.from') = 'in-review'
               AND json_extract(metadata, '$.to') = 'done'
             )
           )
         ORDER BY timestamp ASC
         LIMIT ?`,
      )
      .all(options.since, options.until, 200_000) as unknown as ActivityLogRow[];

    return rows.map((row) => ({
      id: row.id,
      timestamp: row.timestamp,
      type: row.type as ActivityEventType,
      taskId: row.taskId || undefined,
      taskTitle: row.taskTitle || undefined,
      details: row.details,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    }));
}

export async function getTaskMergedTaskIdsImpl(store: TaskStore, options: { since: string; until: string }): Promise<Set<string>> {
    const rows = store.db
      .prepare(
        `SELECT DISTINCT taskId FROM activityLog
         WHERE type = 'task:merged'
           AND timestamp > ?
           AND timestamp <= ?
           AND taskId IS NOT NULL`,
      )
      .all(options.since, options.until) as Array<{ taskId: string }>;

    return new Set(rows.map((row) => row.taskId));
}

export function getMissionStoreImpl(store: TaskStore): MissionStore {
    if (!store.missionStore) {
      /*
       * FNXC:SqliteFinalRemoval 2026-06-24-15:50:
       * In backend mode (PostgreSQL), the MissionStore has not been converted to
       * use the AsyncDataLayer yet — it requires a sync SQLite Database handle.
       * The InProcessRuntime catches the resulting error from store.db access and
       * degrades gracefully (mission autopilot disabled). This is the expected
       * boundary until the MissionStore is fully converted to async in a future
       * session.
       */
      store.missionStore = new MissionStore(store.fusionDir, store.db, store);
    }
    return store.missionStore;
}

export function getPluginStoreImpl(store: TaskStore): PluginStore {
    if (!store.pluginStore) {
      // PluginStore persists install/state rows in central DB, so it must use
      // the same resolved global settings directory as TaskStore.
      // FNXC:SqliteFinalRemoval 2026-06-26-11:10:
      // In backend mode, pass the AsyncDataLayer so PluginStore delegates to
      // async helpers instead of constructing a SQLite Database.
      const pluginLayer = store.getAsyncLayer();
      store.pluginStore = new PluginStore(
        store.rootDir,
        {
          centralGlobalDir: store.globalSettingsDir,
          ...(pluginLayer ? { asyncLayer: pluginLayer } : {}),
        },
      );
      const clearWorkflowDefinitionCache = () => {
        store.workflowDefinitionsCache = null;
      };
      store.pluginStore.on("plugin:registered", clearWorkflowDefinitionCache);
      store.pluginStore.on("plugin:unregistered", clearWorkflowDefinitionCache);
    }
    return store.pluginStore;
}

export async function isPluginInstalledImpl(store: TaskStore, pluginId: string): Promise<boolean> {
    try {
      const plugins = await store.getPluginStore().listPlugins();
      return plugins.some((plugin) => plugin.id === pluginId);
    } catch {
      return false;
    }
}

export function getExperimentSessionStoreImpl(store: TaskStore): ExperimentSessionStore {
    if (!store.experimentSessionStore) {
      // FNXC:RuntimeSatelliteAsync 2026-06-24-15:00:
      // In backend mode, pass the AsyncDataLayer so the store delegates to
      // async helpers; otherwise pass the sync SQLite Database.
      if (store.backendMode) {
        store.experimentSessionStore = new ExperimentSessionStore(null, { asyncLayer: store.asyncLayer });
      } else {
        store.experimentSessionStore = new ExperimentSessionStore(store.db);
      }
    }
    return store.experimentSessionStore;
}

export function getVerificationCacheHitImpl(store: TaskStore,
    treeSha: string,
    testCommand: string,
    buildCommand: string,
  ): { recordedAt: string; taskId: string | null } | null {
    const normalizedTest = testCommand ?? "";
    const normalizedBuild = buildCommand ?? "";
    const row = store.db
      .prepare(
        `SELECT recordedAt, taskId FROM verification_cache
         WHERE treeSha = ? AND testCommand = ? AND buildCommand = ?`,
      )
      .get(treeSha, normalizedTest, normalizedBuild) as
      | { recordedAt: string; taskId: string | null }
      | undefined;
    return row ?? null;
}

export function recordVerificationCachePassImpl(store: TaskStore,
    treeSha: string,
    testCommand: string,
    buildCommand: string,
    taskId: string,
  ): void {
    const normalizedTest = testCommand ?? "";
    const normalizedBuild = buildCommand ?? "";
    const recordedAt = new Date().toISOString();
    store.db
      .prepare(
        `INSERT OR REPLACE INTO verification_cache (treeSha, testCommand, buildCommand, recordedAt, taskId)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(treeSha, normalizedTest, normalizedBuild, recordedAt, taskId);
}

export async function applyTaskMetadataSnapshotImpl(store: TaskStore, snapshot: TaskMetadataSnapshot): Promise<{ applied: number; skipped: number }> {
    validateSnapshotEnvelope(snapshot);
    const existingTasks = new Map((await store.listTasks({ slim: false, includeArchived: true })).map((task) => [task.id, task]));
    let applied = 0;
    let skipped = 0;

    for (const incoming of snapshot.payload.tasks) {
      const current = existingTasks.get(incoming.id);
      const currentMetadata = current ? toTaskMetadataRecord(current) : undefined;
      if (currentMetadata && JSON.stringify(currentMetadata) === JSON.stringify(incoming)) {
        skipped++;
        continue;
      }
      const toUpsert: Task = {
        ...(incoming as unknown as Task),
        worktree: current?.worktree,
        executionStartBranch: current?.executionStartBranch,
        sessionFile: current?.sessionFile,
      };
      store.upsertTaskWithFtsRecovery(toUpsert);
      applied++;
    }

    return { applied, skipped };
}

export function applyActivityLogSnapshotImpl(store: TaskStore, snapshot: ActivityLogSnapshot): { applied: number; skipped: number } {
    validateSnapshotEnvelope(snapshot);
    let applied = 0;
    let skipped = 0;

    for (const entry of snapshot.payload.entries) {
      const exists = store.db.prepare("SELECT 1 FROM activityLog WHERE id = ?").get(entry.id);
      if (exists) {
        skipped++;
        continue;
      }
      store.db.prepare(
        `INSERT INTO activityLog (id, timestamp, type, taskId, taskTitle, details, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        entry.id,
        entry.timestamp,
        entry.type,
        entry.taskId ?? null,
        entry.taskTitle ?? null,
        entry.details,
        entry.metadata ? JSON.stringify(entry.metadata) : null,
      );
      applied++;
    }

    return { applied, skipped };
}

