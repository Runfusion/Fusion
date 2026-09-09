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
import {resolveEntryColumnId, WorkflowSwitchRehomeFailedError, buildSwitchReconciliation} from "../workflows/workflow-reconciliation.js";
import { pruneAgentLogFiles as pruneAgentLogFileEntries, readAgentLogEntriesByTimeRange } from "../agents/agent-log-file-store.js";
import { BUILTIN_WORKFLOWS, DEFAULT_WORKFLOW_ID, resolveDefaultWorkflowIr, getBuiltinWorkflow, getRequiredPluginIdForBuiltinWorkflow, isBuiltinWorkflowDeprecated, isBuiltinWorkflowEnabled, isBuiltinWorkflowId, isBuiltinWorkflowPluginGated, resolveRetiredBuiltinWorkflowId } from "../workflows/builtin-workflows.js";
import { CentralCore } from "../central/central-core.js";
import { type DistributedTaskIdAllocator } from "../tasks/distributed-task-id.js";
import { ExperimentSessionStore } from "../eval/experiment-session-store.js";
import { MasterKeyManager } from "../secrets/master-key.js";
import { MissionStore } from "../missions/mission-store.js";
import { AsyncMissionStore } from "../async-stores/async-mission-store.js";
import { AsyncIdeationStore } from "../async-stores/async-ideation-store.js";
import { type PluginGateVerdict } from "../plugins/plugin-gate-verdict.js";
import { PluginStore } from "../stores/plugin-store.js";
import { SecretsStore } from "../secrets/secrets-store.js";
import { createAsyncDistributedTaskIdAllocator } from "./async/async-allocator.js";
import { getWorkflowRow, listWorkflowIdsAcrossProjects, listWorkflowRows } from "../async-stores/async-workflow-store.js";
import { isPostgresUniqueError } from "../db/postgres-errors.js";
import {resolveColumnCapacity, resolveCapacityPoolId} from "../workflows/workflow-capacity.js";
import {readTaskRow as readTaskRowAsync} from "./async/async-persistence.js";
import { projectOwnershipPartition, projectScopeFor, taskProjectScope } from "../postgres/data-layer.js";
import { getInReviewDurationEvents as getInReviewDurationEventsAsync, getTaskMergedTaskIds as getTaskMergedTaskIdsAsync } from "./async/async-audit.js";
import { readProjectConfig, writeProjectConfig } from "./async/async-settings.js";
import { ActivityLogEntry, AgentLogEntry, DEFAULT_SETTINGS, Settings } from "../types.js";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import * as schema from "../postgres/schema/index.js";
import { normalizeWorkflowIcon, type WorkflowDefinition, type WorkflowDefinitionInput, type WorkflowNodeLayout } from "../workflows/workflow-definition-types.js";
import { WorkflowIr } from "../workflows/workflow-ir-types.js";
import { downgradeIrToV1IfPure, parseWorkflowIr, serializeWorkflowIr } from "../workflows/workflow-ir.js";
import { resolveDefaultOnOptionalGroupIds } from "../workflows/workflow-optional-steps.js";
import { resolveSwitchReconciliation } from "../workflows/workflow-reconciliation.js";
import { WORKFLOW_COMPILED_STEP_TEMPLATE_PREFIX } from "../store.js";
import { resolveWorkflowIrForTask } from "../workflows/workflow-ir-resolver.js";
import { acquireTaskAdvisoryXactLock } from "./task-advisory-lock.js";
import { resolveProjectColumnsForRoles, REVIEW_ROLES } from "../project-lane-vocabulary.js";
import type { InReviewDurationLanes } from "./async/async-audit.js";
import { createLogger } from "../process/logger.js";
import { emitBoundedRunAuditWithOutcome } from "../run-audit/emit-bounded-run-audit.js";

const workflowDefinitionLog = createLogger("workflow-definitions");

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
    /*
    FNXC:SqliteDualPathCleanup 2026-07-26-14:07:
    Raw project settings are read from PostgreSQL project config only. The SQLite config-row arm is deleted.
    FNXC:PostgresOnlyDataAccess 2026-07-16-12:35: never hide settings behind an empty {} when the layer is present.
    */
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

/** Return the greatest numeric WF sequence while ignoring unrelated custom ids. */
export function maxWorkflowDefinitionSequence(ids: readonly string[]): number {
  let max = 0;
  for (const id of ids) {
    const match = /^WF-(\d+)$/.exec(id);
    if (!match) continue;
    const value = Number.parseInt(match[1], 10);
    if (Number.isSafeInteger(value)) max = Math.max(max, value);
  }
  return max;
}

function errorMessages(error: unknown): string {
  const messages: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth += 1) {
    const value = current as { message?: unknown; constraint?: unknown; detail?: unknown; cause?: unknown };
    for (const candidate of [value.message, value.constraint, value.detail]) {
      if (typeof candidate === "string") messages.push(candidate);
    }
    current = value.cause;
  }
  return messages.join(" ");
}

/**
 * Return true only for the `workflows` primary-key target. A bare unique
 * violation is deliberately insufficient because future workflow-table unique
 * constraints must still reach callers unchanged.
 */
export function isWorkflowDefinitionIdPrimaryKeyCollision(error: unknown): boolean {
  const message = errorMessages(error);
  const targetsWorkflowId = /(?:project\.)?workflows_pkey\b|(?:project\.)?workflows\.id\b|(?:UNIQUE|PRIMARY KEY) constraint failed:\s*(?:project\.)?workflows\.id\b/i.test(message);
  return targetsWorkflowId && (isPostgresUniqueError(error) || /SQLITE_CONSTRAINT|UNIQUE constraint failed|PRIMARY KEY constraint failed/i.test(message));
}

/**
 * FNXC:WorkflowDefinitionIdAllocator 2026-08-12-03:02:
 * `project.workflows` now has project-local composite identity while
 * `config.next_workflow_definition_id` remains per-project. Allocate above the
 * full unscoped table as well as the local counter: legacy __legacy_unscoped__
 * rows and stale counters can still reissue an ID held by another partition.
 * Burning an ID is harmless; reusing one is not. The create path separately
 * retries a same-project PK race because this scan and withConfigLock are
 * process-local.
 */
export async function nextWorkflowDefinitionIdAsyncImpl(store: TaskStore): Promise<string> {
  const layer = store.asyncLayer!;
  const [configRow, workflows] = await Promise.all([
    readProjectConfig(layer),
    listWorkflowIdsAcrossProjects(layer),
  ]);
  const counter = configRow.nextWorkflowDefinitionId ?? 1;
  const next = Math.max(counter, maxWorkflowDefinitionSequence(workflows.map(({ id }) => id)) + 1);
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
      const counter = row ? parseInt(row.value, 10) || 1 : 1;
      const workflowRows = store.db.prepare("SELECT id FROM workflows").all() as Array<{ id: string }>;
      const next = Math.max(counter, maxWorkflowDefinitionSequence(workflowRows.map(({ id }) => id)) + 1);
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
    /*
    FNXC:WorkflowDefinitions 2026-09-01-06:06:
    Listing and getWorkflowDefinitionImpl must never disagree about stored workflow fields.
    A process-lifetime per-instance snapshot survives commits from other TaskStore instances,
    so list rows read through on every call. Hot callers own a per-pass cache when measured
    necessary; see docs/solutions/workflow-selection-per-tick-cache.md.
    */
    const layer = store.getAsyncLayer();
    if (!layer) {
      throw new Error("workflow definitions: AsyncDataLayer not initialized in backend mode");
    }
    const rows = await listWorkflowRows(layer);
    return [...BUILTIN_WORKFLOWS, ...rows.map((row) => store.toWorkflowDefinition(row))];
}

export async function getWorkflowDefinitionImpl(store: TaskStore,
    id: string,
  ): Promise<WorkflowDefinition | undefined> {
    const builtin = getBuiltinWorkflow(id);
    if (builtin) {
      /*
      FNXC:WorkflowSuccession 2026-09-06-02:15:
      A retired alias resolves the successor's plugin policy and prompt overrides under the successor's canonical key. The requested alias must not create a second configuration namespace.
      */
      if (isBuiltinWorkflowPluginGated(builtin.id)) {
        const requiredPluginId = getRequiredPluginIdForBuiltinWorkflow(builtin.id);
        if (!requiredPluginId || !(await store.isPluginInstalled(requiredPluginId))) return undefined;
      }
      const ir = await store.applyBuiltInPromptOverridesAsync(builtin.id, builtin.ir);
      return { ...builtin, ir };
    }
    // FNXC:WorkflowDefinitions 2026-06-27-06:00: PG backend reads the custom row
    // from project.workflows via the AsyncDataLayer; sync store.db otherwise.
        const layer = store.getAsyncLayer();
    if (!layer) {
      throw new Error("workflow definition: AsyncDataLayer not initialized in backend mode");
    }
    const asyncRow = await getWorkflowRow(layer, id);
    return asyncRow ? store.toWorkflowDefinition(asyncRow) : undefined;
}

export async function occupantsByColumnForWorkflowImpl(store: TaskStore,
    workflowId: string,
    includeNullSelection: boolean,
  ): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    const taskIds = await store.listWorkflowOccupantTaskIds(workflowId, includeNullSelection);
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

export function insertWorkflowDefinitionSyncImpl(store: TaskStore,
    input: WorkflowDefinitionInput,
  ): WorkflowDefinition {
    const name = input.name?.trim();
    if (!name) throw new Error("Workflow name is required");
    const ir = parseWorkflowIr(input.ir);
    store.assertWorkflowIrTraitsValid(ir);
    const layout = input.layout ?? {};
    const now = new Date().toISOString();
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const definition: WorkflowDefinition = {
        id: store.nextWorkflowDefinitionId(),
        name,
        description: input.description ?? "",
        icon: normalizeWorkflowIcon(input.icon),
        kind: input.kind === "fragment" ? "fragment" : "workflow",
        ir,
        layout,
        createdAt: now,
        updatedAt: now,
      };
      try {
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
            serializeWorkflowIr(downgradeIrToV1IfPure(definition.ir)),
            JSON.stringify(definition.layout),
            definition.kind,
            definition.createdAt,
            definition.updatedAt,
          );
      } catch (error) {
        if (!isWorkflowDefinitionIdPrimaryKeyCollision(error)) throw error;
        continue;
      }
      return definition;
    }
    throw new Error("Unable to allocate a free workflow definition id after repeated id collisions");
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
      /*
      FNXC:WorkflowSuccession 2026-09-06-02:15:
      Sync resolution shares the successor's prompt-override key with async definition reads, preventing a retired request alias from reviving stale configuration.
      */
      return store.applyBuiltInPromptOverridesSync(builtin?.id ?? workflowId, ir === undefined ? resolveDefaultWorkflowIr() : typeof ir === "string" ? parseWorkflowIr(ir) : ir);
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

export function getTaskWorkflowSelectionImpl(_store: TaskStore, _taskId: string): { workflowId: string; stepIds: string[] } | undefined {
    /*
    FNXC:PostgresCutover 2026-07-04-00:00:
    Backend mode cannot synchronously read PostgreSQL, so return undefined and let the sync reader (resolveTaskWorkflowIrSync) fall back to its default. The authoritative read is getTaskWorkflowSelectionAsync; this also converts the prior PG-mode throw into a graceful default.
    */
    /* FNXC:SqliteDualPathCleanup 2026-07-26-14:20: sync selection reader is incomplete-PG; use getTaskWorkflowSelectionAsync. */
    return undefined;
}

/*
FNXC:PostgresCutover 2026-07-04-00:00:
Async backend-mode read of a task's workflow selection (PostgreSQL). stepIds is a JSONB array, returned by Drizzle already parsed. Returns undefined when no row exists. SQLite mode delegates to the sync impl.
*/
/*
FNXC:WorkflowScheduling 2026-08-09-06:07:
Issue #3364 measured a 23-second prefetch from sequential per-task workflow-selection reads against an external PostgreSQL pool capped at three connections. Keep this project-scoped batch reader as the scheduler-pass primitive so board size does not multiply round trips.
*/
export async function getTaskWorkflowSelectionsAsyncImpl(
  store: TaskStore,
  taskIds: string[],
): Promise<Map<string, { workflowId: string; stepIds: string[] }>> {
  const ids = [...new Set(taskIds)];
  if (ids.length === 0) return new Map();
  const layer = store.asyncLayer!;
  const projectId = layer.projectId?.trim() || "__legacy_unscoped__";
  const rows = await layer.db
    .select({ taskId: schema.project.taskWorkflowSelection.taskId, workflowId: schema.project.taskWorkflowSelection.workflowId, stepIds: schema.project.taskWorkflowSelection.stepIds })
    .from(schema.project.taskWorkflowSelection)
    .where(and(
      eq(schema.project.taskWorkflowSelection.projectId, projectId),
      inArray(schema.project.taskWorkflowSelection.taskId, ids),
    ));
  /*
  FNXC:WorkflowSuccession 2026-09-06-02:15:
  Canonicalize authoritative batch reads instead of migrating stored rows. Scheduler capacity and board readers then share one successor identity while older binaries retain database compatibility.
  */
  return new Map(rows.map((row) => [row.taskId, {
    workflowId: resolveRetiredBuiltinWorkflowId(row.workflowId),
    stepIds: Array.isArray(row.stepIds) ? row.stepIds.filter((stepId): stepId is string => typeof stepId === "string") : [],
  }]));
}

export async function getTaskWorkflowSelectionAsyncImpl(store: TaskStore, taskId: string): Promise<{ workflowId: string; stepIds: string[] } | undefined> {
    /* FNXC:SqliteDualPathCleanup 2026-07-26-14:15: always PostgreSQL path below. */
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
    /*
    FNXC:WorkflowSuccession 2026-09-06-02:15:
    Canonicalize the authoritative per-task read so legacy rows join the successor's single board lane without a schema migration. A later selection write converges storage naturally.
    */
    return { workflowId: resolveRetiredBuiltinWorkflowId(row.workflowId), stepIds };
}

export async function writeTaskWorkflowSelectionImpl(store: TaskStore, taskId: string, workflowId: string, stepIds: string[]): Promise<void> {
  const updatedAt = new Date().toISOString();
  /* FNXC:PostgresCutover 2026-07-04-00:00: backend selection writes use async Drizzle. */
  const layer = store.asyncLayer!;
  /* FNXC:SqliteDualPathCleanup 2026-07-26-15:00: selection identity is project-scoped. */
  const projectId = layer.projectId?.trim() || "__legacy_unscoped__";
  /* FNXC:WorkflowCapacity 2026-07-28-18:05: take the cross-node advisory lock before the selection write. */
  await layer.transactionImmediate(async (tx) => {
    await acquireTaskAdvisoryXactLock(tx, projectId, taskId);
    await tx
      .insert(schema.project.taskWorkflowSelection)
      .values({ projectId, taskId, workflowId, stepIds, updatedAt })
      .onConflictDoUpdate({
        target: [
          schema.project.taskWorkflowSelection.projectId,
          schema.project.taskWorkflowSelection.taskId,
        ],
        set: { workflowId, stepIds, updatedAt },
      });
  });
  store.laneCache.invalidate(taskId);
}

export async function removeMaterializedSelectionImpl(store: TaskStore, taskId: string): Promise<void> {
  /* FNXC:PostgresCutover 2026-07-04-00:00: materialized selection deletion also removes child steps. */
  await purgeTaskWorkflowSelectionRowsAsyncImpl(store, taskId);
  store.laneCache.invalidate(taskId);
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

/**
 * FNXC:FixPgTestsAndCi 2026-06-26-09:30:
 * Async backend implementation of purgeTaskWorkflowSelectionRows for PG mode.
 * Reads the task_workflow_selection row, deletes its workflow_steps children,
 * then deletes the selection row — all against the async Drizzle layer.
 * Called by maybeResolveTombstonedTaskId on the resurrection hard-delete path.
 */
export async function purgeTaskWorkflowSelectionRowsAsyncImpl(store: TaskStore, taskId: string): Promise<void> {
  
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
          await layer.db.delete(schema.project.workflowSteps).where(and(eq(schema.project.workflowSteps.id, stepId), projectScopeFor(schema.project.workflowSteps.projectId, layer.projectId)));
        }
      }
    }
  } catch {
    // Corrupt stepIds list — still remove the selection row below.
  }
  await layer.db.delete(schema.project.taskWorkflowSelection).where(eq(schema.project.taskWorkflowSelection.taskId, taskId));
  store.workflowStepsCache = null;
  store.laneCache.invalidate(taskId);
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
        await layer.db.delete(schema.project.workflowSteps).where(and(inArray(schema.project.workflowSteps.id, stepIds), projectScopeFor(schema.project.workflowSteps.projectId, layer.projectId)));
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
    /* The resolved definition owns the canonical identity persisted by all materialization consumers. */
    return { workflowId: def.id, stepIds: resolveDefaultOnOptionalGroupIds(def.ir), entryColumnId: resolveEntryColumnId(def.ir) };
}

export async function selectTaskWorkflowAndReconcileImpl(store: TaskStore,
    taskId: string,
    requestedWorkflowId: string,
  ): Promise<{
    enabledWorkflowSteps: string[];
    reconciliation?: { preserved: boolean; fromColumn: string; toColumn: string };
  }> {
    /*
    FNXC:WorkflowSuccession 2026-09-06-02:15:
    Normalize before preflight so definition lookup, capacity pooling, errors, audit metadata, re-homing and the selection writer all use the successor identity. Retired ids stay requestable but are never persisted.
    */
    const workflowId = resolveRetiredBuiltinWorkflowId(requestedWorkflowId);
    /*
    FNXC:WorkflowColumns 2026-07-28-00:00 (U12 — PR #2512 review, greptile P1):
    PRE-FLIGHT BEFORE COMMITTING. The ordering, not the message, is the fix.

    `selectTaskWorkflow` COMMITS the new selection. If the re-home that follows is then
    rejected, the card's selection says one thing and its column says another, and
    self-healing later has to GUESS which is authoritative. So the deterministic
    rejection cause — the destination column being at its WIP limit — is checked HERE,
    before anything is written. On that path nothing commits: the task keeps its old
    workflow AND its old column, which is a consistent card, and the operator gets a
    typed error naming the full column.

    The target IR is resolved straight from `workflowId` rather than through the task's
    selection, which is precisely what let this move ahead of the commit.
    */
    const preRow = await readTaskRowAsync(store.asyncLayer!, taskId, { includeDeleted: false });
    if (preRow) {
      const fromColumnPre = String(preRow.column);
      const targetDef = await store.getWorkflowDefinition(workflowId);
      if (targetDef) {
        const targetIr = parseWorkflowIr(targetDef.ir);
        const pre = resolveSwitchReconciliation(targetIr, fromColumnPre);
        if (!pre.preserved && pre.targetColumn !== fromColumnPre) {
          const settingsForCapacity = await store.getSettingsFast();
          const capacity = resolveColumnCapacity(targetIr, pre.targetColumn, settingsForCapacity);
          if (capacity.limit !== undefined && Number.isFinite(capacity.limit)) {
            const occupied = await store.asyncLayer!.transactionImmediate(async (tx) =>
              store.countActiveInCapacitySlotAsync({
                tx,
                targetColumn: pre.targetColumn,
                workflowId: resolveCapacityPoolId(workflowId),
                countPending: capacity.countPending === true,
                excludeTaskId: taskId,
              }),
            );
            if (occupied >= capacity.limit) {
              throw new WorkflowSwitchRehomeFailedError({
                taskId,
                workflowId,
                fromColumn: fromColumnPre,
                intendedColumn: pre.targetColumn,
                reason: `target column is at its limit (${occupied}/${capacity.limit})`,
                committed: false,
              });
            }
          }
        }
      }
    }

    const enabledWorkflowSteps = await store.selectTaskWorkflow(taskId, workflowId);
    /*
    FNXC:WorkflowColumns 2026-07-28-00:00 (U12 — R9, USER-VISIBLE):
    The early return on the raw `workflowColumns` flag is DELETED. It read a key no
    production writer sets, so switching a task's workflow NEVER reconciled its
    column: the card kept sitting in its old column even when the new workflow does
    not declare that column, and the `reconciliation` field this function promises in
    its return type was never populated for a real project.

    Operator-visible consequence, deliberate: switching a task to a workflow that does
    not declare its current column now moves the card into that workflow's resolved
    target column (`resolveSwitchReconciliation`), and API/dashboard callers start
    receiving the `reconciliation` summary they already have handling for. A card whose
    column IS declared by the new workflow is preserved in place, unchanged.
    */
    const newIr = await resolveWorkflowIrForTask(store, taskId);
    /*
    FNXC:PostgresCutover 2026-07-28-00:00 (U12):
    ASYNC read, not `store.readTaskFromDb`. The synchronous reader resolves through
    `TaskStore.db`, which THROWS under the PostgreSQL runtime ("SQLite Database is not
    available in backend mode"). The old flag gate returned before ever reaching this
    line, so un-gating the switch reconciliation surfaced a path that could not run at
    all in the production backend — the flag was hiding an unported read, not just a
    disabled feature. Caught by the production-shape tests in
    `__tests__/postgres/workflow-reconciliation-production-shape.pg.test.ts`.

    NOT a missing SQLite fallback (PR #2513 review — CodeRabbit). `backendMode` is
    defined as "the mandatory production AsyncDataLayer was injected", this module
    already dereferences `store.asyncLayer!` in 15 other places, and the sibling
    workflow-definition operations carry FNXC:SqliteDualPathCleanup notes stating they
    require an AsyncDataLayer. Re-adding the synchronous reader as a fallback would
    reintroduce exactly the throw this line fixes.
    */
    const currentRow = await readTaskRowAsync(store.asyncLayer!, taskId, { includeDeleted: false });
    if (!currentRow) return { enabledWorkflowSteps };
    const fromColumn = String(currentRow.column);
    const decision = resolveSwitchReconciliation(newIr, fromColumn);
    if (!decision.preserved && decision.targetColumn !== fromColumn) {
      const outcome = await store.rehomeOccupant(taskId, decision.targetColumn, "workflow-switch", { workflowId });
      /*
      FNXC:WorkflowColumns 2026-07-28-00:00 (U12 — PR #2513 review):
      FAIL LOUDLY. `rehomeOccupant` swallows a rejected move by design, which is right
      for the best-effort sweep callers but wrong here: the new selection has ALREADY
      committed, so a swallowed rejection is a torn write — selection and column
      disagree and nobody is told. Throw instead, leaving the recoverable state in
      place (the R7 startup sweep re-homes an undeclared column) rather than rolling
      back a committed selection.
      */
      if (!outcome.moved) {
        /*
        RESIDUAL RACE ONLY. The capacity pre-flight above already rejects the
        deterministic case before any commit, so reaching here means the destination
        filled up (or the move was otherwise rejected) between the pre-flight and the
        move. The selection IS committed at this point, so this IS a torn card — and it
        is RECORDED, not merely thrown, so self-healing and an operator both find the
        divergence in run-audit instead of having to infer it from a card in a lane the
        board cannot draw. Metadata stays ids/columns/outcomes-only.
        */
        /*
        AWAITED, not fire-and-forget (PR #2512 review — CodeRabbit). The whole claim of
        this branch is that the divergence is a fact on disk; `void`-ing the write and
        throwing on the next line meant the one artifact self-healing is meant to find
        could silently be absent. The bounded outcome is still awaited before throwing,
        but a hostile sink cannot stall the switch forever.

        NO ERROR PROSE (PR #2512 review — CodeRabbit). `outcome.error` is a propagated
        `err.message`; persisting it would contradict this file's own "ids/columns/
        outcomes-only" claim and the project rule that run-audit never stores error
        prose. The bounded outcome code goes here; the human-readable reason travels on
        the thrown error, which is not persisted.

        FNXC:RunAudit 2026-08-20-07:14:
        FN-9182 bounds the awaited forensic emission and reports its outcome without
        changing this branch's typed rejection. A timeout is observable in logs rather
        than indefinitely hiding a torn workflow switch from its caller.
        */
        const auditResult = await emitBoundedRunAuditWithOutcome(store, {
          taskId,
          agentId: "system",
          runId: `workflow-switch-torn-${taskId}`,
          domain: "database",
          mutationType: "task:workflow-switch-torn",
          target: taskId,
          metadata: {
            workflowId,
            fromColumn,
            intendedColumn: decision.targetColumn,
            selectionCommitted: true,
            outcome: "rehome-rejected",
          },
        });
        if (auditResult.outcome !== "recorded") {
          workflowDefinitionLog.warn(`[workflow-switch] audit ${auditResult.outcome} task=${taskId} workflow=${workflowId}`);
        }
        throw new WorkflowSwitchRehomeFailedError({
          taskId,
          workflowId,
          fromColumn,
          intendedColumn: decision.targetColumn,
          committed: true,
          ...(outcome.error !== undefined ? { reason: outcome.error } : {}),
        });
      }
    }
    /*
    FNXC:WorkflowColumns 2026-07-28-00:00 (U12 — PR #2512 review, greptile P1):
    Report the column the task ACTUALLY has, not the one we asked for.
    `rehomeOccupant` deliberately swallows a rejected move — "a full target column
    rejects, which we audit and skip" — and returns void, so reporting
    `decision.targetColumn` claimed a move that may never have happened. A caller
    (dashboard switch, `fn_task_set_workflow`) would then show the card in a column it
    is not in.

    Re-reading also makes the reported result honest under the concurrency windows
    raised in the same review: this call resolves the IR and re-homes AFTER
    `selectTaskWorkflow` released its task lock, so a racing move can land in between.
    Re-reading cannot close that window — it makes the response describe the outcome
    rather than the intention, so a caller is never told a move succeeded when the
    card sits elsewhere. Closing the window itself needs the switch to hold the task
    lock across selection + reconciliation, which changes the locking contract and is
    left as a separate, testable change rather than smuggled into a flag flip.
    */
    /*
    FNXC:WorkflowColumns 2026-07-28-00:00 (U12 — PR #2512 review, greptile P1):
    ABSENT IS ABSENT, decided by the pure `buildSwitchReconciliation` seam. An earlier
    version fell back to `fromColumn`, so a task SOFT-DELETED between the first read
    and this one was reported as having its old column PRESERVED — a live column
    fabricated for a row that is gone.
    */
    const afterRow = await readTaskRowAsync(store.asyncLayer!, taskId, { includeDeleted: false });
    const reconciliation = buildSwitchReconciliation(
      fromColumn,
      afterRow ? String(afterRow.column) : undefined,
    );
    return { enabledWorkflowSteps, ...(reconciliation ? { reconciliation } : {}) };
}

export function pruneAgentLogFilesImpl(store: TaskStore, retentionDays: number): { prunedFiles: number; prunedEntries: number; freedBytes: number } {
    if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
      return { prunedFiles: 0, prunedEntries: 0, freedBytes: 0 };
    }
    /*
    FNXC:TaskArchiveRemoval 2026-09-04-18:25 DELIBERATE-LITERAL:
    The `archived` column value is a historical persistence sentinel, not a workflow role. Agent-log
    pruning includes that sentinel and soft-deleted rows only; live workflow tasks keep their logs.
    */
    // Only prune JSONL files for tasks that are no longer active.
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
      const noopDb = { prepare: () => { throw new Error("sync DB not available in backend mode"); }, bumpLastModified: () => {} } as unknown as import("../db/db.js").Database;
      const noopCentral = noopDb as unknown as import("../central/central-db.js").CentralDatabase;
      store.secretsStore = new SecretsStore(noopDb, noopCentral, masterKeyProvider, { asyncLayer: layer });
      return store.secretsStore;
    }

    const central = new CentralCore(store.getFusionDir());
    await central.init();
    store.secretsCentralCore = central;
    const centralDb = (central as unknown as { db: import("../central/central-db.js").CentralDatabase | null }).db;
    if (!centralDb) {
      throw new Error("Central database unavailable for secrets store");
    }
    store.secretsStore = new SecretsStore(store.db, centralDb, masterKeyProvider);
    const noopDb = { prepare: () => { throw new Error("sync DB not available in backend mode"); }, bumpLastModified: () => {} } as unknown as import("../db/db.js").Database;
    const _noopCentral = noopDb as unknown as import("../central/central-db.js").CentralDatabase;
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
    FNXC:IncompletePgPorts 2026-07-26-20:40:
    Backend mode returns the last refreshDatabaseHealthAsync snapshot. Until the
    first probe runs, report healthy with lastCheckedAt null (unknown, not a
    lie about a successful integrity check).
    */
        return store.postgresHealthSnapshot ?? {
      healthy: true,
      corruptionDetected: false,
      corruptionErrors: [],
      lastCheckedAt: null,
      isRunning: false,
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
        if (!store.asyncDistributedTaskIdAllocator) {
      store.asyncDistributedTaskIdAllocator = createAsyncDistributedTaskIdAllocator(store.asyncLayer!);
    }
    return store.asyncDistributedTaskIdAllocator;
}

export function healthCheckImpl(store: TaskStore): boolean {
    /*
    FNXC:IncompletePgPorts 2026-07-26-20:40:
    Backend mode: report last postgresHealthSnapshot.healthy and schedule a
    background refresh so CLI/daemon probes converge on real connectivity.
    */
        void store.refreshDatabaseHealthAsync().catch(() => undefined);
    return store.getDatabaseHealth().healthy;
}

export function getSettingsSyncImpl(store: TaskStore): Settings {
    /*
    FNXC:IncompletePgPorts 2026-07-26-20:40:
    Backend mode returns settingsSyncCache populated by getSettings/getSettingsFast.
    Before the first async load, DEFAULT_SETTINGS is the only safe sync value.
    */
        return store.settingsSyncCache ?? DEFAULT_SETTINGS;
}

/*
FNXC:WorkflowLifecycleColumns 2026-07-30-22:15:
Resolve the two roles the duration query reads, ONCE per call, and hand them to the SQL.

The predicate had `in-review` and `done` baked into a `sql` template — the one place neither the
lifecycle census nor the unwired-lane-parameter guard can see them — so the Reliability panel's
duration metric stayed blind on a renamed board after #2861 fixed the two counts beside it.

This impl is where the store is available, which is why the resolution lives here rather than in
`async-audit.ts`: that function takes a `db` handle and cannot resolve anything. Best-effort — a
failed resolve leaves the query on its documented legacy lanes rather than failing the panel.
*/
export async function getInReviewDurationEventsImpl(store: TaskStore, options: { since: string; until: string }): Promise<ActivityLogEntry[]> {
        const layer = store.asyncLayer!;
    /*
    FNXC:WorkflowLifecycleColumns 2026-07-31-06:20:
    Named type, not an inferred literal, and the reason is a tool contract rather than style.

    `scripts/lib/unwired-lane-parameter.mjs` decides a lane parameter is WIRED when some other file
    mentions both the parameter name and its declaring symbol. For an interface passed as an inferred
    object literal there is no mention of the type anywhere, so this call site — which does supply
    both lanes — was reported as unwired, and #2875 landed two false entries into a guard written to
    catch the opposite mistake.

    Annotating the local is the smallest honest fix. I tried three variations of the heuristic first;
    each traded the false positive for false NEGATIVES (the widest hid twelve genuine entries), which
    is the usual sign that a co-occurrence check has reached its limit. Naming the type costs one
    word, makes the wiring visible to both the reader and the tool, and leaves the guard's rule alone.
    */
    let lanes: InReviewDurationLanes | undefined;
    try {
      const [review, complete] = await Promise.all([
        resolveProjectColumnsForRoles(store, REVIEW_ROLES),
        resolveProjectColumnsForRoles(store, ["complete"]),
      ]);
      lanes = { reviewColumns: [...review], completeColumns: [...complete] };
    } catch {
      lanes = undefined;
    }
    return getInReviewDurationEventsAsync(layer.db, layer.projectId ?? "", options, lanes);
}

export async function getTaskMergedTaskIdsImpl(store: TaskStore, options: { since: string; until: string }): Promise<Set<string>> {
        const layer = store.asyncLayer!;
    return getTaskMergedTaskIdsAsync(layer.db, layer.projectId ?? "", options);
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
            const layer = store.getAsyncLayer();
      if (!layer) {
        throw new Error("MissionStore is not available: AsyncDataLayer not initialized in backend mode");
      }
      store.missionStore = new AsyncMissionStore(layer, store);

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
      /*
      FNXC:WorkflowDefinitions 2026-09-01-06:06:
      Plugin-gated builtins are checked by listWorkflowDefinitionsImpl on every call.
      Plugin registration therefore needs no store-local invalidation signal.
      */
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
            store.experimentSessionStore = new ExperimentSessionStore(null, { asyncLayer: store.asyncLayer });

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
        const table = schema.project.verificationCache;
    const rows = await store.asyncLayer!.db
      .select({ recordedAt: table.recordedAt, taskId: table.taskId })
      .from(table)
      /*
      FNXC:ProjectSchemaOwnership 2026-08-12-14:14:
      Verification cache keys are only unique within their project partition.
      Read through the owning layer's project scope so an identical tree and
      command tuple from another project cannot skip this project's verification.
      */
      .where(and(
        projectScopeFor(table.projectId, store.asyncLayer!.projectId),
        eq(table.treeSha, treeSha),
        eq(table.testCommand, normalizedTest),
        eq(table.buildCommand, normalizedBuild),
      ))
      .limit(1);
    return rows[0] ?? null;
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
