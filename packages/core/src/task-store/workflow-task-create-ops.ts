/**
 * FNXC:CodeOrganization 2026-07-21-12:00:
 * Domain rename from remaining-ops-4: distributed task create, workflow step materialization,
 * custom fields, work items, and goal-citation helpers.
 *
 * FNXC:StoreModularization 2026-06-25-00:00:
 * Extracted from the monolithic packages/core/src/store.ts as a pure
 * behavior-preserving refactor. Each function receives the TaskStore
 * instance as its first parameter and performs byte-identical work.
 */
import {TaskStore} from "../store.js";
import {resolveEntryColumnId} from "../workflows/workflow-reconciliation.js";
import {resolveWorkflowIrForTask} from "../workflows/workflow-ir-resolver.js";
import * as schema from "../postgres/schema/index.js";
import type {MoveTaskOptions, MoveTaskInternalOptions} from "../store.js";
import {TASK_BRANCH_CONTEXT_METADATA_KEY} from "../store.js";
import {randomUUID} from "node:crypto";
import {and, eq, inArray, isNull} from "drizzle-orm";
import {filterArchived as filterArchivedAsync} from "../async-stores/async-archive-db.js";
import type {Task, TaskCreateInput, Column, ColumnId, TaskDocumentWithTask, RunMutationContext, TaskCommitAssociation, GoalCitation, GoalCitationInput, TaskBranchAssignmentMode, WorkflowWorkItem, WorkflowWorkItemDueFilter, WorkflowWorkItemKind} from "../types.js";
import { resolveTaskPrefix } from "./task-prefix.js";
import {COLUMNS} from "../types.js";
import {parseWorkflowIr, serializeWorkflowIr} from "../workflows/workflow-ir.js";
import {resolveAllowedColumns, workflowHasColumn} from "../workflows/workflow-transitions.js";
import type {WorkflowFieldDefinition} from "../workflows/workflow-ir-types.js";
import {validateCustomFieldPatch, applyFieldDefaults, reconcileFieldsOnWorkflowChange, type CustomFieldRejection} from "../tasks/task-fields.js";
import "../builtin-traits.js";
import type {StoredWorkflowRow, WorkflowDefinition} from "../workflows/workflow-definition-types.js";
import {resolveDefaultOnOptionalGroupIds} from "../workflows/workflow-optional-steps.js";
import {toJson} from "../db/db.js";
import {GoalStore} from "../goals/goal-store.js";
import {AsyncGoalStore} from "../async-stores/async-goal-store.js";
import {normalizeTaskCommitAssociation} from "../tasks/task-lineage.js";
import {__setTaskActivityLogLimitsForTesting} from "../task-store/comments.js";
import {withTaskBranchContextInSourceMetadata} from "../task-store/branch-context.js";
import {upsertTaskRowInTransaction, readTaskRowInTransaction, buildTaskInsertValues} from "../task-store/async/async-persistence.js";
import {preserveDurableTaskWedgeInvariants} from "../task-store/persistence.js";
import {isPlanReviewSatisfied} from "../planner/plan-approval.js";
import {listDueWorkflowWorkItems as listDueWorkflowWorkItemsAsync, withTaskWorkflowSerialization} from "../task-store/async/async-workflow-workitems.js";
import {getTaskMovedCountsByDay as getTaskMovedCountsByDayAsync} from "../task-store/async/async-audit.js";
import {getAllDocuments as getAllDocumentsAsync} from "../task-store/async/async-comments-attachments.js";
import {recordGoalCitations as recordGoalCitationsAsync} from "../task-store/async/async-events.js";
import type { WorkflowWorkItemRow } from "../task-store/row-types.js";
import { projectScopeFor } from "../postgres/data-layer.js";

export async function recordGoalCitationsImpl(store: TaskStore, inputs: GoalCitationInput[]): Promise<GoalCitation[]> {
        const layer = store.asyncLayer!;
    return recordGoalCitationsAsync(layer.db, inputs);
}

export function insertTaskWithFtsRecoveryImpl2(store: TaskStore, task: Task, operation: string): void {
    const normalizeConflict = (error: unknown): never => {
      store.logTaskCreateConflict(task, operation, error);
      throw new Error(`Task ID already exists: ${task.id}`);
    };

    try {
      store.insertTask(task);
      return;
    } catch (error) {
      if (store.isTaskIdConflictError(error)) {
        normalizeConflict(error);
      }
      throw error;
    }
  }

export async function assertTaskIdAvailableImpl(store: TaskStore, id: string): Promise<void> {
    if (await store.taskIdExistsAnywhere(id)) {
      throw new Error(`Task ID already exists: ${id}`);
    }
  }

export async function atomicWriteTaskJsonImpl2(store: TaskStore, dir: string, task: Task): Promise<void> {
    const id = store.getTaskIdFromDir(dir);
    // FNXC:RuntimeTaskOrchestrationAsync 2026-06-24-14:05:
    // Backend mode: upsert the task row via async Drizzle instead of sync SQLite.
    // The upsert (INSERT ... ON CONFLICT DO UPDATE) updates the existing row in
    // place. This is an update-only path (never create); create paths use
    // insertTaskRowInTransaction (non-destructive plain insert).
        const layer = store.asyncLayer!;
    /*
    FNXC:PostgresCutover 2026-07-10:
    Parity with the SQLite branch below: write ONLY the columns this update
    actually changed (getChangedTaskColumns against the row read inside the
    transaction), never a full-row upsert from the caller's snapshot. The
    previous full-row upsert silently clobbered any column another writer
    committed between this caller's read and its write — the lost-update
    class behind triage's `status: "planning"` clear never taking effect
    (a card then reads as "unplanned" forever and the scheduler refuses to
    dispatch it). SQLite never had this bug because patchTaskRowInTransaction
    always wrote the changed-column subset.
    */
    await layer.transactionImmediate(async (tx) => {
      const persist = async () => {
      const pgRow = await readTaskRowInTransaction(tx, id, { includeDeleted: true }, layer.projectId);
      if (!pgRow || pgRow.deletedAt != null) {
        // Update-only path: never resurrect a soft-deleted row; a missing row
        // falls through to the legacy full upsert (matches sqlite's
        // upsertTaskWithFtsRecovery fallback for vanished rows).
        // FNXC:MultiProjectIsolation 2026-07-10: preserve the bound projectId partition key.
        if (!pgRow) {
          const context = store.createTaskPersistSerializationContext(task);
          await upsertTaskRowInTransaction(tx, task as unknown as Record<string, unknown>, context, layer.projectId);
        }
        return;
      }
      const existingRow = store.pgRowToTaskRow(pgRow);
      preserveDurableTaskWedgeInvariants(existingRow, task);
      const deletedAt = store.getSoftDeletedWriteConflict(id, task, existingRow);
      if (deletedAt) {
        store.throwSoftDeletedWriteBlocked(id, deletedAt, "atomicWriteTaskJson");
      }
      const changedColumns = store.getChangedTaskColumns(existingRow, task);
      if (changedColumns.size === 0) {
        return;
      }
      const context = store.createTaskPersistSerializationContext(task, existingRow);
      const allValues = buildTaskInsertValues(task as unknown as Record<string, unknown>, context);
      const setValues: Record<string, unknown> = { updatedAt: task.updatedAt };
      for (const column of changedColumns) {
        if (column === "id") continue;
        setValues[column as string] = allValues[column as string];
      }
      /*
      FNXC:SqliteDualPathCleanup 2026-07-26-15:00:
      Project-scope the changed-column update so a matching task id in another project cannot be rewritten.
      */
      const updateConds = [eq(schema.project.tasks.id, id)];
      if (layer.projectId) updateConds.push(eq(schema.project.tasks.projectId, layer.projectId));
      await tx
        .update(schema.project.tasks)
        .set(setValues as never)
        .where(and(...updateConds));
      };
      /*
      FNXC:WorkflowSerialization 2026-07-26-15:30:
      FN-8592's conditional continuation seed checks for a passed plan-review
      under its task advisory lock. The generic task persistence path is the
      sole terminal result writer, so a plan-review pass must take that same
      lock as the first transaction lock before its row write can commit.
      */
      if (task.workflowStepResults?.some(isPlanReviewSatisfied)) {
        await withTaskWorkflowSerialization(tx, layer.projectId, id, persist);
      } else {
        await persist();
      }
    });
    await store.writeTaskJsonFile(dir, task);
    return;
}

export async function createTaskWithDistributedReservationImpl(store: TaskStore, input: TaskCreateInput, options?: { onSummarize?: (description: string) => Promise<string | null>; settings?: { autoSummarizeTitles?: boolean }; createTaskWithId?: (taskId: string) => Promise<Task>; },): Promise<Task> {
    const settings = await store.getSettingsFast();
    // FNXC:MissionTaskPrefix 2026-07-26-12:00: prefer TaskCreateInput.taskPrefix (mission triage minting hint) over the project-wide settings.taskPrefix so a single mission can use e.g. ERR- while the board stays FN-.
    const prefix = resolveTaskPrefix(input.taskPrefix, settings.taskPrefix, "FN");
    const allocator = store.getDistributedTaskIdAllocator();
    const nodeId = await store.resolveLocalNodeIdForTaskAllocation();
    const reservation = await allocator.reserveDistributedTaskId({
      prefix,
      nodeId,
    });

    let createdTask: Task | null = null;
    try {
      createdTask = options?.createTaskWithId
        ? await options.createTaskWithId(reservation.taskId)
        : await store.createTaskWithReservedId(input, { taskId: reservation.taskId });
      await allocator.commitDistributedTaskIdReservation({
        reservationId: reservation.reservationId,
        nodeId,
      });
      return createdTask;
    } catch (error) {
      await allocator.abortDistributedTaskIdReservation({
        reservationId: reservation.reservationId,
        nodeId,
        reason: "failed-create",
      }).catch(() => undefined);
      throw error;
    }
  }

export function toStoredWorkflowStepImpl(store: TaskStore, row: { id: string; templateId: string | null; name: string; description: string; mode: string; phase: string | null; gateMode: string | null; prompt: string; toolMode: string | null; scriptName: string | null; enabled: number; defaultOn: number | null; modelProvider: string | null; modelId: string | null; migrated_fragment_id?: string | null; createdAt: string; updatedAt: string; }): import("../types.js").WorkflowStep {
    return {
      id: row.id,
      templateId: row.templateId ?? undefined,
      name: row.name,
      description: row.description,
      mode: row.mode === "script" ? "script" : "prompt",
      phase: row.phase === "post-merge" ? "post-merge" : "pre-merge",
      gateMode: row.gateMode === "advisory" || row.gateMode === "gate"
        ? row.gateMode
        : "advisory",
      prompt: row.prompt || "",
      toolMode: row.toolMode === "coding" || row.toolMode === "readonly" ? row.toolMode : undefined,
      scriptName: row.scriptName ?? undefined,
      enabled: Boolean(row.enabled),
      defaultOn: row.defaultOn === null || row.defaultOn === undefined ? undefined : Boolean(row.defaultOn),
      modelProvider: row.modelProvider ?? undefined,
      modelId: row.modelId ?? undefined,
      migratedFragmentId: row.migrated_fragment_id ?? undefined,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

export async function ensureWorkflowStepForTemplateImpl(store: TaskStore, templateId: string): Promise<import("../types.js").WorkflowStep> {
    const template = store.getBuiltInWorkflowTemplate(templateId);
    if (!template) {
      throw new Error(`Workflow step template '${templateId}' not found`);
    }

    const existing = await store.getWorkflowStep(templateId);
    if (existing && existing.id !== templateId) {
      return existing;
    }

    const allSteps = await store.listWorkflowSteps();
    const byName = allSteps.find((step) => step.name.toLowerCase() === template.name.toLowerCase());
    if (byName) {
      return byName;
    }

    return store.createWorkflowStep({
      templateId: template.id,
      name: template.name,
      description: template.description,
      mode: "prompt",
      phase: "pre-merge",
      prompt: template.prompt,
      gateMode: "advisory",
      toolMode: template.toolMode || "readonly",
      enabled: true,
    });
  }

export async function resolveEnabledWorkflowStepsImpl(store: TaskStore, stepIds?: string[], optionalGroupIds?: Set<string>,): Promise<string[] | undefined> {
    if (!stepIds?.length) return undefined;

    const resolved: string[] = [];
    const seen = new Set<string>();

    for (const rawId of stepIds) {
      const stepId = rawId.trim();
      if (!stepId) continue;

      if (stepId.startsWith("plugin:")) {
        if (!seen.has(stepId)) {
          seen.add(stepId);
          resolved.push(stepId);
        }
        continue;
      }

      // Optional-group toggle ids pass through raw — never materialized as legacy step rows.
      const template = optionalGroupIds?.has(stepId)
        ? undefined
        : store.getBuiltInWorkflowTemplate(stepId);
      const resolvedId = template
        ? (await store.ensureWorkflowStepForTemplate(stepId)).id
        : stepId;

      if (!seen.has(resolvedId)) {
        seen.add(resolvedId);
        resolved.push(resolvedId);
      }
    }

    return resolved.length > 0 ? resolved : undefined;
  }

export async function setTaskBranchGroupImpl(store: TaskStore, taskId: string, branchGroupId: string | null, options?: { assignmentMode?: TaskBranchAssignmentMode },): Promise<void> {
    await store.withTaskLock(taskId, async () => {
      const dir = store.taskDir(taskId);
      const task = await store.readTaskJson(dir);
      let branchContext: Task["branchContext"];

      if (branchGroupId) {
        const group = await store.getBranchGroup(branchGroupId);
        if (!group) {
          throw new Error(`Branch group ${branchGroupId} not found`);
        }
        // Carry the group's actual assignment intent. The BranchGroup row does not
        // persist an assignment mode, so prefer an explicit caller-provided mode,
        // then preserve any existing branchContext.assignmentMode, and only fall
        // back to "shared" when nothing else is known.
        branchContext = {
          groupId: group.id,
          source: group.sourceType,
          assignmentMode: options?.assignmentMode ?? task.branchContext?.assignmentMode ?? "shared",
        };
      }

      task.branchContext = branchContext;
      task.sourceMetadata = withTaskBranchContextInSourceMetadata(task.sourceMetadata, branchContext);
      if (!branchContext && task.sourceMetadata) {
        const nextSourceMetadata = { ...task.sourceMetadata };
        delete nextSourceMetadata[TASK_BRANCH_CONTEXT_METADATA_KEY];
        task.sourceMetadata = Object.keys(nextSourceMetadata).length > 0 ? nextSourceMetadata : undefined;
      }
      task.updatedAt = new Date().toISOString();

      await store.atomicWriteTaskJson(dir, task);
      if (store.isWatching) store.taskCache.set(taskId, { ...task });
      store.emit("task:updated", task);
    });
  }

export async function getTaskColumnsImpl(store: TaskStore, ids: string[]): Promise<Map<string, Column>> {
    if (ids.length === 0) {
      return new Map();
    }

    const uniqueIds = [...new Set(ids)];
    /*
    FNXC:PostgresOnlyDataAccess 2026-07-16-12:25:
    Backend mode previously threw here (dashboard's caller swallowed it, so
    every agent-linked task read as non-terminal on PostgreSQL). Async reads:
    live columns from project.tasks, then archive membership for the misses.
    */
        const layer = store.asyncLayer!;
    /*
    FNXC:SqliteDualPathCleanup 2026-07-26-15:00:
    Project-scope getTaskColumns so a shared task id from another project cannot populate the map.
    */
    const colConds = [inArray(schema.project.tasks.id, uniqueIds), isNull(schema.project.tasks.deletedAt)];
    if (layer.projectId) colConds.push(eq(schema.project.tasks.projectId, layer.projectId));
    const rows = await layer.db
      .select({ id: schema.project.tasks.id, column: schema.project.tasks.column })
      .from(schema.project.tasks)
      .where(and(...colConds));
    const activeByIdPg = new Map<string, Column>();
    for (const row of rows) {
      activeByIdPg.set(row.id, row.column as Column);
    }
    const missingPg = uniqueIds.filter((id) => !activeByIdPg.has(id));
    const archivedPg = missingPg.length > 0
      ? await filterArchivedAsync(layer.db, missingPg, layer.projectId)
      : new Set<string>();
    const resultPg = new Map<string, Column>();
    for (const id of uniqueIds) {
      const activeColumn = activeByIdPg.get(id);
      if (activeColumn !== undefined) {
        resultPg.set(id, activeColumn);
      } else if (archivedPg.has(id)) {
        resultPg.set(id, "archived");
      }
    }
    return resultPg;
}

export async function prepareWorkflowMovePolicyPreflightImpl(store: TaskStore, id: string, toColumn: ColumnId, options: MoveTaskOptions | undefined, internal: MoveTaskInternalOptions,): Promise<MoveTaskInternalOptions["movePolicyPreflight"]> {
    const task = await store.readTaskForMove(id);
    const moveSource = options?.moveSource ?? "engine";
    /*
    FNXC:WorkflowColumns 2026-07-30-04:00 (U12 — flipped ATOMICALLY with moves.ts):
    The compatibility-flag gate is DELETED. This preflight computes the `movePolicyPreflight` that
    `moves.ts` consumes and validates, so the two could never be flipped independently: un-gating
    this alone would evaluate workflow move policies — with their plugin-gate side effects — while
    the branch consuming the result stayed off, and un-gating `moves.ts` alone would validate against
    a preflight that was never computed. Both readers go in the same commit for that reason.
    */
    if (task.column === toColumn) return undefined;

    /* FNXC:WorkflowModelLanes 2026-07-14-16:31: PostgreSQL move preflight must validate against the task's migrated workflow selection, not the synchronous builtin:coding fallback. */
    const workflowIr = store.backendMode
      ? await resolveWorkflowIrForTask(store, id)
      : store.resolveTaskWorkflowIrSync(id);
    const workflowSignature = serializeWorkflowIr(workflowIr);
    const bypassGuards = store.resolveWorkflowBypassGuards(moveSource, options);
    const fromColumn = task.column;
    if (store.shouldSkipWorkflowMovePolicies({ fromColumn, toColumn, moveSource, bypassGuards, options })) {
      return undefined;
    }

    const recoveryToLegacy =
      options?.recoveryRehome === true && (COLUMNS as readonly string[]).includes(toColumn);
    if (!workflowHasColumn(workflowIr, toColumn) && !recoveryToLegacy) return undefined;

    const allowed = resolveAllowedColumns(workflowIr, fromColumn);
    if (options?.recoveryRehome !== true && !allowed.includes(toColumn)) return undefined;

    await store.evaluateWorkflowMovePolicies({
      task,
      workflow: workflowIr,
      fromColumn,
      toColumn,
      actor: store.resolveWorkflowMoveActor(moveSource, internal, options),
      source: options?.workflowMoveSource ?? moveSource,
      metadata: options?.workflowMoveMetadata,
    });
    return { fromColumn, toColumn, workflowSignature };
  }

export async function updateTaskCustomFieldsImpl(store: TaskStore, taskId: string, patch: Record<string, unknown>, runContext?: RunMutationContext,): Promise<{ ok: true; task: Task } | { ok: false; rejection: CustomFieldRejection }> {
    return store.withTaskLock(taskId, async () => {
      const defs = store.resolveTaskCustomFieldDefsSync(taskId);
      const result = validateCustomFieldPatch(defs, patch);
      if (!result.ok) {
        return { ok: false as const, rejection: result.rejection };
      }
      // Pass the validated PATCH through (with null delete-sentinels) — the
      // merge-with-delete happens once, inside updateTaskUnlocked, against the
      // freshly-read task. Pre-merging here would lose the delete semantics on
      // the second merge.
      const task = await store.updateTaskUnlocked(taskId, { customFields: result.normalized }, runContext);
      return { ok: true as const, task };
    });
  }

export async function listWorkflowPromptOverridesForProjectImpl(store: TaskStore): Promise<Record<string, Record<string, string>>> {
    const projectId = store.getWorkflowSettingsProjectId();
    // FNXC:PostgresOnlyDataAccess 2026-07-16-12:25: backend branch added so
    // this public method cannot throw the sync-SQLite error on PostgreSQL.
        const table = schema.project.workflowPromptOverrides;
    const pgRows = await store.asyncLayer!.db
      .select({ workflowId: table.workflowId, overrides: table.overrides })
      .from(table)
      .where(eq(table.projectId, projectId));
    const outPg: Record<string, Record<string, string>> = {};
    for (const row of pgRows) {
      // jsonb column: drizzle returns the parsed object (getWorkflowPromptOverridesAsyncImpl parity).
      const overrides = row.overrides;
      if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) continue;
      const entry: Record<string, string> = {};
      for (const [nodeId, value] of Object.entries(overrides as Record<string, unknown>)) {
        if (typeof value === "string" && value.trim()) entry[nodeId] = value;
      }
      outPg[row.workflowId] = entry;
    }
    return outPg;
}

export async function listWorkflowWorkItemsForTaskImpl(store: TaskStore, taskId: string, opts: { kinds?: WorkflowWorkItemKind[] } = {}): Promise<WorkflowWorkItem[]> {
    // No dedicated async helper; use a raw Drizzle query in backend mode.
        const layer = store.asyncLayer!;
    const scope = projectScopeFor(schema.project.workflowWorkItems.projectId, layer.projectId);
    const q = layer.db
      .select()
      .from(schema.project.workflowWorkItems)
      .where(and(scope, eq(schema.project.workflowWorkItems.taskId, taskId)));
    const rows = opts.kinds?.length
      ? await layer.db
          .select()
          .from(schema.project.workflowWorkItems)
          .where(and(scope, eq(schema.project.workflowWorkItems.taskId, taskId), inArray(schema.project.workflowWorkItems.kind, opts.kinds)))
      : await q;
    return (rows as WorkflowWorkItemRow[]).map((row) => store.rowToWorkflowWorkItem(row));
}

export async function listDueWorkflowWorkItemsImpl(store: TaskStore, filter: WorkflowWorkItemDueFilter = {}): Promise<WorkflowWorkItem[]> {
        const layer = store.asyncLayer!;
    return listDueWorkflowWorkItemsAsync(layer.db, filter);
}

export function rewriteBlockedByResidueDependentsForRemovalImpl(store: TaskStore, taskId: string, excludedDependentIds: Set<string>): Task[] {
    const rewrittenDependents: Task[] = [];
    const candidates = store.db
      .prepare(`SELECT id FROM tasks WHERE ${TaskStore.ACTIVE_TASKS_WHERE} AND blockedBy = ?`)
      .all(taskId) as Array<{ id: string }>;

    for (const candidate of candidates) {
      if (excludedDependentIds.has(candidate.id)) continue;
      const dependentTask = store.readTaskFromDb(candidate.id);
      if (!dependentTask || dependentTask.blockedBy !== taskId) continue;

      const updatedDependent: Task = {
        ...dependentTask,
        blockedBy: undefined,
        status: undefined,
        log: [
          ...(dependentTask.log ?? []),
          {
            timestamp: new Date().toISOString(),
            action: `Auto-unblocked: blocker ${taskId} was soft-deleted`,
          },
        ],
        updatedAt: new Date().toISOString(),
      };

      store.db.prepare("UPDATE tasks SET blockedBy = NULL, status = NULL, log = ?, updatedAt = ? WHERE id = ?").run(
        toJson(updatedDependent.log ?? []),
        updatedDependent.updatedAt,
        updatedDependent.id,
      );

      if (store.isWatching) {
        store.taskCache.set(updatedDependent.id, updatedDependent);
      }
      rewrittenDependents.push(updatedDependent);
    }

    return rewrittenDependents;
  }

export async function getAllDocumentsImpl(store: TaskStore, options?: { searchQuery?: string; limit?: number; offset?: number; }): Promise<TaskDocumentWithTask[]> {
    // FNXC:Documents 2026-06-27-12:15:
    // PG backend mode: delegate to the AsyncDataLayer helper. The sync JOIN
    // below dereferences store.db (no SQLite handle in backend mode) and 500'd
    // the dashboard /api/documents list.
        return getAllDocumentsAsync(store.asyncLayer!.db, options);
}

export async function deleteWorkflowStepImpl(store: TaskStore, id: string): Promise<void> {
    /*
    FNXC:PostgresOnlyDataAccess 2026-07-17-15:10:
    Backend mode deletes the workflow_steps row via the AsyncDataLayer (mirrors the
    async workflow_steps deletes in workflow-ops.ts). The `.returning()` clause lets
    us preserve the sync path's "not found" contract. `bumpLastModified` is a
    SQLite-only mtime touch with no PostgreSQL analogue. The task-reference cleanup
    below is already async and backend-safe, so it runs in both modes.
    */
        const layer = store.asyncLayer!;
    const deletedRows = await layer.db
      .delete(schema.project.workflowSteps)
      .where(eq(schema.project.workflowSteps.id, id))
      .returning({ id: schema.project.workflowSteps.id });
    if (deletedRows.length === 0) {
      throw new Error(`Workflow step '${id}' not found`);
    }
    store.workflowStepsCache = null;

    // Clean up references from existing tasks (best-effort, outside config lock)
    try {
      const tasks = await store.listTasks({ slim: true });
      for (const task of tasks) {
        if (task.enabledWorkflowSteps?.includes(id)) {
          const updated = task.enabledWorkflowSteps.filter((wsId) => wsId !== id);
          // Direct task.json mutation for enabledWorkflowSteps cleanup
          await store.withTaskLock(task.id, async () => {
            const dir = store.taskDir(task.id);
            const t = await store.readTaskJson(dir);
            t.enabledWorkflowSteps = updated.length > 0 ? updated : undefined;
            t.updatedAt = new Date().toISOString();
            await store.atomicWriteTaskJson(dir, t);
          });
        }
      }
    } catch {
      // Best-effort: task cleanup is non-critical
    }
  }

export function toWorkflowDefinitionImpl(store: TaskStore, row: StoredWorkflowRow): WorkflowDefinition {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      icon: row.icon || undefined,
      // Legacy rows (pre-migration-109) have no kind column; default to "workflow".
      kind: row.kind === "fragment" ? "fragment" : "workflow",
      ir: parseWorkflowIr(row.ir),
      layout: store.parseWorkflowLayout(row.layout),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

export async function materializeDefaultWorkflowStepsImpl(store: TaskStore): Promise<{ workflowId: string; stepIds: string[]; entryColumnId?: string } | undefined> {
    const workflowId = await store.getDefaultWorkflowId();
    if (!workflowId) return undefined;
    const def = await store.getWorkflowDefinition(workflowId);
    if (!def) return undefined;
    // KTD-1/R6: a fragment must never act as a project default (it is not a
    // selectable workflow); fall back to no default rather than materializing it.
    if (def.kind === "fragment") return undefined;
    // FNXC:LegacyWorkflowEngineRemoval 2026-07-02-00:00:
    // FN-7360 removed the legacy linear workflow step compiler; the graph
    // interpreter is the sole executor. Validation is now parseWorkflowIr
    // (accepts branching graphs). Interpreter-deferred tolerance is no longer
    // needed since branching is a valid shape.
    parseWorkflowIr(def.ir);
    // FNXC:CodingIdeasWorkflow 2026-07-05-19:45: surface the workflow's manual
    // intake column (main FN-7591 parity).
    return { workflowId, stepIds: resolveDefaultOnOptionalGroupIds(def.ir), entryColumnId: resolveEntryColumnId(def.ir) };
  }

export async function reconcileTaskCustomFieldsForSchemaImpl(store: TaskStore, taskId: string, oldFieldDefs: WorkflowFieldDefinition[], newFieldDefs: WorkflowFieldDefinition[], dropOrphans = false,): Promise<void> {
    const dir = store.taskDir(taskId);
    const task = await store.readTaskJson(dir);
    const current = task.customFields ?? {};
    const { kept, orphaned } = reconcileFieldsOnWorkflowChange(oldFieldDefs, newFieldDefs, current);
    // Default (keep-orphaned): storage keeps everything (kept ∪ orphaned).
    // coerce:"drop" discards the orphaned values entirely.
    const base = dropOrphans ? { ...kept } : { ...kept, ...orphaned };
    const reconciled = applyFieldDefaults(newFieldDefs, base);
    // Skip the write when nothing changed (no defaults added, same keys/values).
    const unchanged =
      Object.keys(reconciled).length === Object.keys(current).length &&
      Object.entries(reconciled).every(([k, v]) => current[k] === v);
    if (unchanged) return;
    task.customFields = reconciled;
    task.updatedAt = new Date().toISOString();
    await store.atomicWriteTaskJson(dir, task);
    if (store.isWatching) store.taskCache.set(taskId, { ...task });
    store.emitTaskLifecycleEventSafely("task:updated", [task]);
  }

export async function getTaskMovedCountsByDayImpl(store: TaskStore, options: { since: string; until: string; fromColumn?: string; toColumn?: string; }): Promise<Record<string, number>> {
    // FNXC:RuntimeWorkflowAsync 2026-06-24-16:05:
    // Backend-mode: delegate to the async audit helper.
        const layer = store.asyncLayer!;
    return getTaskMovedCountsByDayAsync(layer.db, layer.projectId ?? "", options);
}

export function getGoalStoreImpl(store: TaskStore): GoalStore | AsyncGoalStore {
    if (!store.goalStore) {
      // FNXC:GoalStore 2026-06-27-18:05:
      // PG backend mode returns the AsyncDataLayer-backed AsyncGoalStore (goal CRUD
      // + ACTIVE_GOAL_LIMIT enforcement over project.goals). The sync SQLite
      // GoalStore (store.db) is used only in legacy SQLite mode. Both expose the
      // same method names; the dashboard goals routes, mission goal-resolution
      // helpers, and CLI/agent goal tools await the result so either backend works.
            const layer = store.getAsyncLayer();
      if (!layer) {
        throw new Error("GoalStore is not available: AsyncDataLayer not initialized in backend mode");
      }
      store.goalStore = new AsyncGoalStore(layer);

    }
    return store.goalStore;
  }

export async function upsertTaskCommitAssociationImpl(store: TaskStore, input: Omit<TaskCommitAssociation, "id" | "createdAt" | "updatedAt"> & { id?: string },): Promise<TaskCommitAssociation> {
    const now = new Date().toISOString();
    const association: TaskCommitAssociation = normalizeTaskCommitAssociation({
      id: input.id ?? randomUUID(),
      createdAt: now,
      updatedAt: now,
      ...input,
    });
    /*
    FNXC:PostgresCutover 2026-07-04:
    Backend-mode upsert of a task_commit_associations row via async Drizzle.
    Mirrors the SQLite ON CONFLICT(taskLineageId, commitSha, matchedBy) DO
    UPDATE — the unique index task_commit_associations_task_lineage_id_commit_sha_matched_by_unique
    is the conflict target. id is excluded from the update set (SQLite path
    keeps the existing id on conflict too). Reached from the merger.
    */
        const layer = store.asyncLayer!;
    await layer.db
      .insert(schema.project.taskCommitAssociations)
      .values({
        id: association.id,
        taskLineageId: association.taskLineageId,
        taskIdSnapshot: association.taskIdSnapshot,
        commitSha: association.commitSha,
        commitSubject: association.commitSubject,
        authoredAt: association.authoredAt,
        matchedBy: association.matchedBy,
        confidence: association.confidence,
        note: association.note ?? null,
        additions: association.additions ?? null,
        deletions: association.deletions ?? null,
        createdAt: association.createdAt,
        updatedAt: association.updatedAt,
      })
      .onConflictDoUpdate({
        target: [
          schema.project.taskCommitAssociations.projectId,
          schema.project.taskCommitAssociations.taskLineageId,
          schema.project.taskCommitAssociations.commitSha,
          schema.project.taskCommitAssociations.matchedBy,
        ],
        set: {
          taskIdSnapshot: association.taskIdSnapshot,
          commitSubject: association.commitSubject,
          authoredAt: association.authoredAt,
          confidence: association.confidence,
          note: association.note ?? null,
          additions: association.additions ?? null,
          deletions: association.deletions ?? null,
          updatedAt: association.updatedAt,
        },
      });
    return association;
}
