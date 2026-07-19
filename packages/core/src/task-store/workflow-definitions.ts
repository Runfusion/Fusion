/**
 * FNXC:CodeOrganization 2026-07-18-14:00:
 * Domain rename from remaining-ops-8: workflow definition CRUD, selection
 * materialization, plugin gate verdicts, CLI autonomy approvals, and related store ops.
 *
 * FNXC:StoreModularization 2026-06-25-00:00:
 * Extracted from the monolithic packages/core/src/store.ts as a pure
 * behavior-preserving refactor. Each function receives the TaskStore
 * instance as its first parameter and performs byte-identical work.
 */

import { TaskStore } from "../store.js";
import {resolveEntryColumnId} from "../workflow-reconciliation.js";
import { pruneAgentLogFiles as pruneAgentLogFileEntries, readAgentLogEntriesByTimeRange } from "../agent-log-file-store.js";
import { BUILTIN_WORKFLOWS, DEFAULT_WORKFLOW_ID, resolveDefaultWorkflowIr, getBuiltinWorkflow, getRequiredPluginIdForBuiltinWorkflow, isBuiltinWorkflowDeprecated, isBuiltinWorkflowEnabled, isBuiltinWorkflowId, isBuiltinWorkflowPluginGated } from "../builtin-workflows.js";
import { CentralCore } from "../central-core.js";
import { fromJson } from "../db.js";
import { type DistributedTaskIdAllocator, createDistributedTaskIdAllocator } from "../distributed-task-id.js";
import { ExperimentSessionStore } from "../experiment-session-store.js";
import { MasterKeyManager } from "../master-key.js";
import { MissionStore } from "../mission-store.js";
import { AsyncMissionStore } from "../async-mission-store.js";
import { AsyncIdeationStore } from "../async-ideation-store.js";
import { type PluginGateVerdict } from "../plugin-gate-verdict.js";
import { PluginStore } from "../plugin-store.js";
import { SecretsStore } from "../secrets-store.js";
import { createAsyncDistributedTaskIdAllocator } from "./async-allocator.js";
import { getWorkflowRow, listWorkflowRows } from "../async-workflow-store.js";
import { projectOwnershipPartition, projectScopeFor, taskProjectScope } from "../postgres/data-layer.js";
import { getInReviewDurationEvents as getInReviewDurationEventsAsync, getTaskMergedTaskIds as getTaskMergedTaskIdsAsync } from "./async-audit.js";
import { readProjectConfig, writeProjectConfig } from "./async-settings.js";
import { compactTaskActivityLog } from "./comments.js";
import { type TaskRow } from "./persistence.js";
import { ActivityLogRow } from "./row-types.js";
import { ActivityEventType, ActivityLogEntry, AgentLogEntry, ArchivedTaskEntry, DEFAULT_SETTINGS, Settings } from "../types.js";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import * as schema from "../postgres/schema/index.js";
import { normalizeWorkflowIcon, type StoredWorkflowRow, type WorkflowDefinition, type WorkflowDefinitionInput, type WorkflowNodeLayout } from "../workflow-definition-types.js";
import { WorkflowIr } from "../workflow-ir-types.js";
import { downgradeIrToV1IfPure, parseWorkflowIr, serializeWorkflowIr } from "../workflow-ir.js";
import { resolveDefaultOnOptionalGroupIds } from "../workflow-optional-steps.js";
import { resolveSwitchReconciliation } from "../workflow-reconciliation.js";
import { WORKFLOW_COMPILED_STEP_TEMPLATE_PREFIX } from "../store.js";
import { resolveWorkflowIrForTask } from "../workflow-ir-resolver.js";

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

export async function readRawProjectSettingsImpl(store: TaskStore): Promise<Record<string, unknown>> {
    // FNXC:PostgresOnlyDataAccess 2026-07-16-12:35: backend mode previously
    // returned {} from the catch below, hiding raw persisted project settings
    // on PostgreSQL. Read the config row via the async layer instead.
    if (store.backendMode) {
      try {
        const config = await readProjectConfig(store.asyncLayer!);
        const settings = config.settings;
        return settings && typeof settings === "object" && !Array.isArray(settings)
          ? (settings as Record<string, unknown>)
          : {};
      } catch {
        return {};
      }
    }
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
      thinkingLevel: entry.template.thinkingLevel,
      createdAt: now,
      updatedAt: now,
    };
}

/**
 * FNXC:SqliteFinalRemoval 2026-06-28:
 * Backend-mode (PG) sibling of nextWorkflowDefinitionIdImpl. SQLite stored the
 * WF-id counter in a __meta row read+incremented inside a transactionImmediate;
 * PG has no __meta table so the counter lives in project.config
 * (next_workflow_definition_id). The read+increment is serialized by the
 * caller's withConfigLock (mirrors createWorkflowStepImpl's WS-id counter port),
 * preserving the WF-### format and the never-reuse-across-deletes intent. The
 * existing settings are passed back through writeProjectConfig so bumping the
 * counter never clobbers the project settings object.
 */
export async function nextWorkflowDefinitionIdAsyncImpl(store: TaskStore): Promise<string> {
  const layer = store.asyncLayer!;
  const configRow = await readProjectConfig(layer);
  const next = configRow.nextWorkflowDefinitionId ?? 1;
  await writeProjectConfig(layer, configRow.settings ?? {}, {
    nextWorkflowDefinitionId: next + 1,
  });
  return `WF-${String(next).padStart(3, "0")}`;
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
    // FNXC:WorkflowBrainstorming 2026-07-15-15:49:
    // FN-7970 removes deprecated built-ins only from new-selection listings.
    // Management listings retain them, and direct id resolution remains unconditional.
    const selectionVisible = options?.includeDisabledBuiltins
      ? enabledVisible
      : enabledVisible.filter((wf) => !isBuiltinWorkflowDeprecated(wf.id));
    const visible = await Promise.all(
      selectionVisible.map(async (wf) => {
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
    // FNXC:WorkflowDefinitions 2026-06-27-06:00:
    // PG backend mode reads custom workflow rows from project.workflows via the
    // AsyncDataLayer (the sync store.db SELECT throws). Builtins are merged the
    // same way in both backends. Every caller already awaits this method.
    if (store.backendMode) {
      const layer = store.getAsyncLayer();
      if (!layer) {
        throw new Error("workflow definitions: AsyncDataLayer not initialized in backend mode");
      }
      const rows = await listWorkflowRows(layer);
      store.workflowDefinitionsCache = [...BUILTIN_WORKFLOWS, ...rows.map((row) => store.toWorkflowDefinition(row))];
      return store.workflowDefinitionsCache;
    }
    const rows = store.db.prepare("SELECT * FROM workflows ORDER BY createdAt ASC").all() as StoredWorkflowRow[];
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
    // FNXC:WorkflowDefinitions 2026-06-27-06:00: PG backend reads the custom row
    // from project.workflows via the AsyncDataLayer; sync store.db otherwise.
    if (store.backendMode) {
      const layer = store.getAsyncLayer();
      if (!layer) {
        throw new Error("workflow definition: AsyncDataLayer not initialized in backend mode");
      }
      const asyncRow = await getWorkflowRow(layer, id);
      return asyncRow ? store.toWorkflowDefinition(asyncRow) : undefined;
    }
    const row = store.db.prepare("SELECT * FROM workflows WHERE id = ?").get(id) as
      | StoredWorkflowRow
      | undefined;
    return row ? store.toWorkflowDefinition(row) : undefined;
}

export async function occupantsByColumnForWorkflowImpl(store: TaskStore,
    workflowId: string,
    includeNullSelection: boolean,
  ): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    const taskIds = await store.listWorkflowOccupantTaskIds(workflowId, includeNullSelection);
    if (store.backendMode) {
      if (taskIds.length === 0) return counts;
      const rows = await store.asyncLayer!.db
        .select({ column: schema.project.tasks.column })
        .from(schema.project.tasks)
        .where(and(
          inArray(schema.project.tasks.id, taskIds),
          isNull(schema.project.tasks.deletedAt),
          taskProjectScope(store.asyncLayer!),
        ));
      for (const row of rows) counts.set(row.column, (counts.get(row.column) ?? 0) + 1);
      return counts;
    }
    for (const taskId of taskIds) {
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
      icon: normalizeWorkflowIcon(input.icon),
      kind: input.kind === "fragment" ? "fragment" : "workflow",
      ir,
      layout,
      createdAt: now,
      updatedAt: now,
    };
    store.db
      .prepare(
        `INSERT INTO workflows (id, name, description, icon, ir, layout, kind, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        definition.id,
        definition.name,
        definition.description,
        definition.icon ?? null,
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
    /* FNXC:WorkflowBuiltins 2026-07-19-10:26: shares resolveDefaultWorkflowIr() with the async move resolver so sync and async paths cannot disagree on the no-selection default. */
    if (!workflowId) return store.applyBuiltInPromptOverridesSync(DEFAULT_WORKFLOW_ID, resolveDefaultWorkflowIr());
    if (isBuiltinWorkflowId(workflowId)) {
      const builtin = getBuiltinWorkflow(workflowId);
      const ir = builtin?.ir;
      return store.applyBuiltInPromptOverridesSync(workflowId, ir === undefined ? resolveDefaultWorkflowIr() : typeof ir === "string" ? parseWorkflowIr(ir) : ir);
    }
    try {
      const row = store.db
        .prepare("SELECT ir FROM workflows WHERE id = ?")
        .get(workflowId) as { ir: string } | undefined;
      /* FNXC:WorkflowBuiltins 2026-07-19-12:20 (PR #2341 review): the deleted-workflow and
         read-error fallbacks must apply built-in prompt overrides exactly like the
         no-selection branch above — otherwise a task whose custom workflow was deleted
         silently loses the project's default-workflow prompt customizations. */
      if (!row) return store.applyBuiltInPromptOverridesSync(DEFAULT_WORKFLOW_ID, resolveDefaultWorkflowIr());
      return parseWorkflowIr(row.ir);
    } catch {
      return store.applyBuiltInPromptOverridesSync(DEFAULT_WORKFLOW_ID, resolveDefaultWorkflowIr());
    }
}

export function getTaskWorkflowSelectionImpl(store: TaskStore, taskId: string): { workflowId: string; stepIds: string[] } | undefined {
    /*
    FNXC:PostgresCutover 2026-07-04-00:00:
    Backend mode cannot synchronously read PostgreSQL, so return undefined and let the sync readers (resolveEffectiveWorkflowIdSync / resolveTaskWorkflowIrSync) fall back to their defaults. The authoritative read is getTaskWorkflowSelectionAsync; this also converts the prior PG-mode throw into a graceful default.
    */
    if (store.backendMode) return undefined;
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

/*
FNXC:PostgresCutover 2026-07-04-00:00:
Async backend-mode read of a task's workflow selection (PostgreSQL). stepIds is a JSONB array, returned by Drizzle already parsed. Returns undefined when no row exists. SQLite mode delegates to the sync impl.
*/
export async function getTaskWorkflowSelectionAsyncImpl(store: TaskStore, taskId: string): Promise<{ workflowId: string; stepIds: string[] } | undefined> {
    if (!store.backendMode) return store.getTaskWorkflowSelection(taskId);
    const layer = store.asyncLayer!;
    /*
    FNXC:WorkflowModelLanes 2026-07-14-16:34:
    A task workflow selection is project-owned. Shared PostgreSQL deployments may reuse task ids across projects, so every authoritative selection read must include the bound central project id instead of relying on taskId or connection state alone.
    */
    const projectId = layer.projectId?.trim() || "__legacy_unscoped__";
    const rows = await layer.db
      .select({ workflowId: schema.project.taskWorkflowSelection.workflowId, stepIds: schema.project.taskWorkflowSelection.stepIds })
      .from(schema.project.taskWorkflowSelection)
      .where(and(
        eq(schema.project.taskWorkflowSelection.projectId, projectId),
        eq(schema.project.taskWorkflowSelection.taskId, taskId),
      ))
      .limit(1);
    if (rows.length === 0) return undefined;
    const row = rows[0]!;
    let stepIds: string[] = [];
    const parsed = row.stepIds as unknown;
    if (Array.isArray(parsed)) stepIds = parsed.filter((s): s is string => typeof s === "string");
    return { workflowId: row.workflowId, stepIds };
}

export async function writeTaskWorkflowSelectionImpl(store: TaskStore, taskId: string, workflowId: string, stepIds: string[]): Promise<void> {
    const updatedAt = new Date().toISOString();
    /*
    FNXC:PostgresCutover 2026-07-04-00:00:
    Backend-mode upsert of the task_workflow_selection row via async Drizzle (taskId is the primary key). stepIds is stored as a JSONB array.
    */
    if (store.backendMode) {
      const layer = store.asyncLayer!;
      await layer.db
        .insert(schema.project.taskWorkflowSelection)
        .values({ taskId, workflowId, stepIds, updatedAt })
        .onConflictDoUpdate({
          target: [
            schema.project.taskWorkflowSelection.projectId,
            schema.project.taskWorkflowSelection.taskId,
          ],
          set: { workflowId, stepIds, updatedAt },
        });
      return;
    }
    store.db
      .prepare(
        `INSERT INTO task_workflow_selection (taskId, workflowId, stepIds, updatedAt)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(taskId) DO UPDATE SET
           workflowId = excluded.workflowId,
           stepIds = excluded.stepIds,
           updatedAt = excluded.updatedAt`,
      )
      .run(taskId, workflowId, JSON.stringify(stepIds), updatedAt);
}

export async function removeMaterializedSelectionImpl(store: TaskStore, taskId: string): Promise<void> {
    /*
    FNXC:PostgresCutover 2026-07-04-00:00:
    Backend-mode delete reuses purgeTaskWorkflowSelectionRowsAsyncImpl (read stepIds, delete workflow_steps children, delete the selection row) so PG stays in lockstep with the SQLite path.
    */
    if (store.backendMode) {
      await purgeTaskWorkflowSelectionRowsAsyncImpl(store, taskId);
      return;
    }
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

export async function cleanupOrphanedMaterializedStepsImpl(store: TaskStore, stepIds: string[] | undefined): Promise<void> {
    if (!stepIds || stepIds.length === 0) return;
    /*
    FNXC:PostgresOnlyDataAccess 2026-07-17-14:20:
    Backend mode deletes the orphaned workflow_steps rows via the AsyncDataLayer.
    The former sync `store.db.prepare(DELETE...)` threw the removed-SQLite stub in
    backend mode and was swallowed by the best-effort catch, silently leaking every
    materialized workflow_steps row created before a failed task-create (the callers
    are the task-creation failure catches). Mirrors removeMaterializedSelectionImpl.
    */
    const layer = store.getAsyncLayer();
    if (layer) {
      try {
        await layer.db.delete(schema.project.workflowSteps).where(inArray(schema.project.workflowSteps.id, stepIds));
      } catch {
        // Best-effort cleanup.
      }
      store.workflowStepsCache = null;
      return;
    }
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
  ): Promise<{ workflowId: string; stepIds: string[]; entryColumnId?: string }> {
    const def = await store.getWorkflowDefinition(workflowId);
    if (!def) throw new Error(`Workflow '${workflowId}' not found`);
    if (def.kind === "fragment") {
      throw new Error(`Workflow '${workflowId}' is a fragment and cannot be selected for a task`);
    }
    // FNXC:LegacyWorkflowEngineRemoval 2026-07-02-00:00:
    // FN-7360 removed the legacy linear compiler; validation is now parseWorkflowIr.
    parseWorkflowIr(def.ir);
    // FNXC:CodingIdeasWorkflow 2026-07-05-19:45: surface the workflow's manual
    // intake column so create paths can land the task there instead of the
    // hard-coded "triage" (main FN-7591 parity; the cutover copies predated it).
    return { workflowId, stepIds: resolveDefaultOnOptionalGroupIds(def.ir), entryColumnId: resolveEntryColumnId(def.ir) };
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
    const newIr = store.backendMode
      ? await resolveWorkflowIrForTask(store, taskId)
      : store.resolveTaskWorkflowIrSync(taskId);
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
    if (store.backendMode) {
      const layer = store.asyncLayer!;
      return getInReviewDurationEventsAsync(layer.db, layer.projectId ?? "", options);
    }
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
    if (store.backendMode) {
      const layer = store.asyncLayer!;
      return getTaskMergedTaskIdsAsync(layer.db, layer.projectId ?? "", options);
    }
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

export function getMissionStoreImpl(store: TaskStore): MissionStore | AsyncMissionStore {
    if (!store.missionStore) {
      // FNXC:MissionStore 2026-06-27-15:20:
      // PG backend mode returns the AsyncDataLayer-backed AsyncMissionStore (mission
      // hierarchy CRUD + status/validation rollups + triage over the project.* mission
      // tables). The sync SQLite MissionStore (store.db) is used only in legacy SQLite
      // mode. Both expose the same method names; the dashboard mission routes + goal→
      // mission routes + CLI mission tools await the result so either works. The store
      // reference is passed so triage can create/link tasks. Mission AUTOPILOT and live
      // SSE mission events stay degraded in PG mode — the engine MissionAutopilot +
      // dashboard SSE are coupled to the sync EventEmitter MissionStore and guard their
      // init with `instanceof MissionStore`.
      if (store.backendMode) {
        const layer = store.getAsyncLayer();
        if (!layer) {
          throw new Error("MissionStore is not available: AsyncDataLayer not initialized in backend mode");
        }
        store.missionStore = new AsyncMissionStore(layer, store);
      } else {
        store.missionStore = new MissionStore(store.fusionDir, store.db, store);
      }
    }
    return store.missionStore;
}

export function getIdeationStoreImpl(store: TaskStore): AsyncIdeationStore {
  if (!store.ideationStore) {
    const layer = store.getAsyncLayer();
    if (!layer) throw new Error("IdeationStore is only available with the PostgreSQL AsyncDataLayer");
    const missionStore = store.getMissionStore();
    if (!(missionStore instanceof AsyncMissionStore)) {
      throw new Error("IdeationStore requires the PostgreSQL AsyncMissionStore");
    }
    store.ideationStore = new AsyncIdeationStore(layer, missionStore);
  }
  return store.ideationStore;
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

/*
FNXC:PostgresOnlyDataAccess 2026-07-16-11:40:
The merger's deterministic-verification cache read at merger.ts ran the sync
SQLite branch unguarded, so every backend-mode merge with a resolvable tree sha
threw "SQLite Database is not available". Both cache ops are now async and route
to the project-schema verification_cache table in backend mode.
*/
export async function getVerificationCacheHitImpl(store: TaskStore,
    treeSha: string,
    testCommand: string,
    buildCommand: string,
  ): Promise<{ recordedAt: string; taskId: string | null } | null> {
    const normalizedTest = testCommand ?? "";
    const normalizedBuild = buildCommand ?? "";
    if (store.backendMode) {
      const table = schema.project.verificationCache;
      const rows = await store.asyncLayer!.db
        .select({ recordedAt: table.recordedAt, taskId: table.taskId })
        .from(table)
        .where(and(
          eq(table.treeSha, treeSha),
          eq(table.testCommand, normalizedTest),
          eq(table.buildCommand, normalizedBuild),
        ))
        .limit(1);
      return rows[0] ?? null;
    }
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

export async function recordVerificationCachePassImpl(store: TaskStore,
    treeSha: string,
    testCommand: string,
    buildCommand: string,
    taskId: string,
  ): Promise<void> {
    const normalizedTest = testCommand ?? "";
    const normalizedBuild = buildCommand ?? "";
    const recordedAt = new Date().toISOString();
    if (store.backendMode) {
      /*
      FNXC:PostgresOnlyDataAccess 2026-07-16-11:55:
      Target the PK by constraint name: migration 0006_project_ownership
      rebuilds every project-schema PK to lead with project_id, so a
      column-list ON CONFLICT on the three logical key columns cannot infer
      the arbiter index (42P10). project_id itself comes from the column's
      current_setting('fusion.project_id') default under RLS.
      */
      await store.asyncLayer!.db.execute(sql`
        INSERT INTO project.verification_cache (tree_sha, test_command, build_command, recorded_at, task_id)
        VALUES (${treeSha}, ${normalizedTest}, ${normalizedBuild}, ${recordedAt}, ${taskId})
        ON CONFLICT ON CONSTRAINT verification_cache_pkey
        DO UPDATE SET recorded_at = EXCLUDED.recorded_at, task_id = EXCLUDED.task_id
      `);
      return;
    }
    store.db
      .prepare(
        `INSERT OR REPLACE INTO verification_cache (treeSha, testCommand, buildCommand, recordedAt, taskId)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(treeSha, normalizedTest, normalizedBuild, recordedAt, taskId);
}

/*
FNXC:GitHubImportTranslate 2026-07-15-09:30:
Import auto-translation persists translations so an issue is translated at most once per target locale — reopening the Import Tasks panel or reloading the dashboard must never re-bill the AI helper.
These are PostgreSQL-only async ops. Unlike the legacy sync `verification_cache` helpers above (which still use SQLite `db.prepare`), they go through `asyncLayer` and always carry an explicit `project_id` predicate: every project shares one flat `project` schema, so an unscoped read would serve another project's translations.
*/

export interface ImportTranslationCacheEntry {
  translatedTitle: string;
  translatedBody: string;
  detectedLocale: string | null;
  recordedAt: string;
}

export interface ImportTranslationCacheKey {
  provider: string;
  repoKey: string;
  issueNumber: number;
  targetLocale: string;
  /** Hash of the ORIGINAL title+body; a mismatch means the issue was edited. */
  sourceHash: string;
}

/*
FNXC:GitHubImportTranslate 2026-07-16-23:30:
The cache write, read, and prune paths must resolve the identical ownership
partition. In particular, compatibility layers without a project binding write
to `__legacy_unscoped__`; querying with an omitted/blank predicate afterwards
made those durable rows look like cache misses after a restart.
*/
function importTranslationScope(store: TaskStore) {
  return projectScopeFor(
    schema.project.importTranslationCache.projectId,
    projectOwnershipPartition(store.asyncLayer?.projectId),
  );
}

/**
 * Read a cached translation. Returns null on miss, and also on a `sourceHash`
 * mismatch — an edited issue must re-translate rather than serve stale prose.
 */
export async function getImportTranslationImpl(
  store: TaskStore,
  key: ImportTranslationCacheKey,
): Promise<ImportTranslationCacheEntry | null> {
  if (!store.asyncLayer) return null;
  const table = schema.project.importTranslationCache;
  const rows = await store.asyncLayer.db
    .select({
      translatedTitle: table.translatedTitle,
      translatedBody: table.translatedBody,
      detectedLocale: table.detectedLocale,
      recordedAt: table.recordedAt,
      sourceHash: table.sourceHash,
    })
    .from(table)
    .where(
      and(
        importTranslationScope(store),
        eq(table.provider, key.provider),
        eq(table.repoKey, key.repoKey),
        eq(table.issueNumber, key.issueNumber),
        eq(table.targetLocale, key.targetLocale),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  // Stale-content guard: the issue body changed since we translated it.
  if (row.sourceHash !== key.sourceHash) return null;
  return {
    translatedTitle: row.translatedTitle,
    translatedBody: row.translatedBody,
    detectedLocale: row.detectedLocale ?? null,
    recordedAt: row.recordedAt,
  };
}

/**
 * Upsert a translation. Re-translating the same issue (after an edit) replaces
 * the row rather than accumulating one row per revision.
 */
export async function recordImportTranslationImpl(
  store: TaskStore,
  key: ImportTranslationCacheKey,
  value: { translatedTitle: string; translatedBody: string; detectedLocale?: string | null },
  recordedAt: string,
): Promise<void> {
  if (!store.asyncLayer) return;
  const table = schema.project.importTranslationCache;
  const projectId = projectOwnershipPartition(store.asyncLayer.projectId);
  await store.asyncLayer.db
    .insert(table)
    .values({
      projectId,
      provider: key.provider,
      repoKey: key.repoKey,
      issueNumber: key.issueNumber,
      targetLocale: key.targetLocale,
      sourceHash: key.sourceHash,
      translatedTitle: value.translatedTitle,
      translatedBody: value.translatedBody,
      detectedLocale: value.detectedLocale ?? null,
      recordedAt,
    })
    .onConflictDoUpdate({
      target: [table.projectId, table.provider, table.repoKey, table.issueNumber, table.targetLocale],
      set: {
        sourceHash: key.sourceHash,
        translatedTitle: value.translatedTitle,
        translatedBody: value.translatedBody,
        detectedLocale: value.detectedLocale ?? null,
        recordedAt,
      },
    });
}

/**
 * Drop cached translations for issues that are no longer open. This is the
 * requirement's expiry rule — a translation persists "until the issue is
 * closed". No-ops on an empty list so a fully-open page costs no query.
 */
export async function pruneImportTranslationsImpl(
  store: TaskStore,
  provider: string,
  repoKey: string,
  closedIssueNumbers: number[],
): Promise<number> {
  if (!store.asyncLayer || closedIssueNumbers.length === 0) return 0;
  const table = schema.project.importTranslationCache;
  await store.asyncLayer.db
    .delete(table)
    .where(
      and(
        importTranslationScope(store),
        eq(table.provider, provider),
        eq(table.repoKey, repoKey),
        inArray(table.issueNumber, closedIssueNumbers),
      ),
    );
  return closedIssueNumbers.length;
}
