/**
 * remaining-ops-4 operations.
 *
 * FNXC:StoreModularization 2026-06-25-00:00:
 * Extracted from the monolithic packages/core/src/store.ts as a pure
 * behavior-preserving refactor. Each function receives the TaskStore
 * instance as its first parameter and performs byte-identical work.
 */
import {TaskStore, isWorkflowColumnsCompatibilityFlagEnabled} from "../store.js";
import {resolveEntryColumnId} from "../workflow-reconciliation.js";
import * as schema from "../postgres/schema/index.js";
import type {MoveTaskOptions, MoveTaskInternalOptions} from "../store.js";
import {TASK_BRANCH_CONTEXT_METADATA_KEY} from "../store.js";
import {randomUUID} from "node:crypto";
import {and, eq, inArray} from "drizzle-orm";
import type {Task, TaskCreateInput, Column, ColumnId, TaskDocumentWithTask, RunMutationContext, TaskCommitAssociation, GoalCitation, GoalCitationInput, TaskBranchAssignmentMode, WorkflowWorkItem, WorkflowWorkItemDueFilter, WorkflowWorkItemKind} from "../types.js";
import {COLUMNS} from "../types.js";
import {parseWorkflowIr, serializeWorkflowIr} from "../workflow-ir.js";
import {resolveAllowedColumns, workflowHasColumn} from "../workflow-transitions.js";
import type {WorkflowFieldDefinition} from "../workflow-ir-types.js";
import {validateCustomFieldPatch, applyFieldDefaults, reconcileFieldsOnWorkflowChange, type CustomFieldRejection} from "../task-fields.js";
import "../builtin-traits.js";
import type {WorkflowDefinition} from "../workflow-definition-types.js";
import {resolveDefaultOnOptionalGroupIds} from "../workflow-optional-steps.js";
import {isBuiltinWorkflowId} from "../builtin-workflows.js";
import {toJson} from "../db.js";
import {GoalStore} from "../goal-store.js";
import {AsyncGoalStore} from "../async-goal-store.js";
import {normalizeTaskCommitAssociation} from "../task-lineage.js";
import {type TaskRow} from "../task-store/persistence.js";
import {__setTaskActivityLogLimitsForTesting} from "../task-store/comments.js";
import {withTaskBranchContextInSourceMetadata} from "../task-store/branch-context.js";
import {upsertTaskRowInTransaction, readTaskRowInTransaction, buildTaskInsertValues} from "../task-store/async-persistence.js";
import {listDueWorkflowWorkItems as listDueWorkflowWorkItemsAsync} from "../task-store/async-workflow-workitems.js";
import {getTaskMovedCountsByDay as getTaskMovedCountsByDayAsync} from "../task-store/async-audit.js";
import {getAllDocuments as getAllDocumentsAsync} from "../task-store/async-comments-attachments.js";
import {recordGoalCitations as recordGoalCitationsAsync} from "../task-store/async-events.js";
import type {TaskDocumentRow, GoalCitationRow, WorkflowWorkItemRow} from "../task-store/row-types.js";

export async function recordGoalCitationsImpl(store: TaskStore, inputs: GoalCitationInput[]): Promise<GoalCitation[]> {
    if (store.backendMode) {
      const layer = store.asyncLayer!;
      return recordGoalCitationsAsync(layer.db, inputs);
    }
    if (inputs.length === 0) {
      return [];
    }

    const now = new Date().toISOString();
    const stmt = store.db.prepare(`
      INSERT OR IGNORE INTO goal_citations (goalId, agentId, taskId, surface, sourceRef, snippet, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      RETURNING *
    `);

    const inserted: GoalCitation[] = [];
    store.db.transaction(() => {
      for (const input of inputs) {
        const row = stmt.get(
          input.goalId,
          input.agentId,
          input.taskId ?? null,
          input.surface,
          input.sourceRef,
          input.snippet,
          input.timestamp ?? now,
        ) as GoalCitationRow | undefined;
        if (row) {
          inserted.push(store.rowToGoalCitation(row));
        }
      }
      if (inserted.length > 0) {
        store.db.bumpLastModified();
      }
    });

    return inserted;
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
    if (store.backendMode) {
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
        const pgRow = await readTaskRowInTransaction(tx, id, { includeDeleted: true });
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
        await tx
          .update(schema.project.tasks)
          .set(setValues as never)
          .where(eq(schema.project.tasks.id, id));
      });
      await store.writeTaskJsonFile(dir, task);
      return;
    }
    let result: { deletedAt?: string; current?: Task } | undefined;
    store.db.transactionImmediate(() => {
      const existingRow = store.readTaskRowFromDb(id, { includeDeleted: true });
      const changedColumns = existingRow && existingRow.deletedAt == null
        ? store.getChangedTaskColumns(existingRow, task)
        : new Set<keyof TaskRow>();
      result = store.patchTaskRowInTransaction(id, task, changedColumns, existingRow);
    });
    if (result?.deletedAt) {
      store.throwSoftDeletedWriteBlocked(id, result.deletedAt, "atomicWriteTaskJson");
    }
    await store.writeTaskJsonFile(dir, result?.current ?? task);
  }

export async function createTaskWithDistributedReservationImpl(store: TaskStore, input: TaskCreateInput, options?: { onSummarize?: (description: string) => Promise<string | null>; settings?: { autoSummarizeTitles?: boolean }; createTaskWithId?: (taskId: string) => Promise<Task>; },): Promise<Task> {
    const settings = await store.getSettingsFast();
    const prefix = (settings.taskPrefix || "FN").trim().toUpperCase();
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
    const placeholders = uniqueIds.map(() => "?").join(",");
    const rows = store.db
      .prepare(`SELECT id, "column" FROM tasks WHERE id IN (${placeholders}) AND ${TaskStore.ACTIVE_TASKS_WHERE}`)
      .all(...uniqueIds) as Array<{ id: string; column: Column }>;

    const activeById = new Map<string, Column>();
    for (const row of rows) {
      activeById.set(row.id, row.column);
    }

    const missingIds: string[] = [];
    for (const id of uniqueIds) {
      if (!activeById.has(id)) {
        missingIds.push(id);
      }
    }

    const archivedSet = missingIds.length > 0 ? store.archiveDb.filterArchived(missingIds) : new Set<string>();

    const result = new Map<string, Column>();
    for (const id of uniqueIds) {
      const activeColumn = activeById.get(id);
      if (activeColumn !== undefined) {
        result.set(id, activeColumn);
      } else if (archivedSet.has(id)) {
        result.set(id, "archived");
      }
    }

    return result;
  }

export async function prepareWorkflowMovePolicyPreflightImpl(store: TaskStore, id: string, toColumn: ColumnId, options: MoveTaskOptions | undefined, internal: MoveTaskInternalOptions,): Promise<MoveTaskInternalOptions["movePolicyPreflight"]> {
    const task = await store.readTaskForMove(id);
    const moveSource = options?.moveSource ?? "engine";
    const mergedSettingsForMove = await store.getSettingsFast();
    if (!isWorkflowColumnsCompatibilityFlagEnabled(mergedSettingsForMove)) return undefined;
    if (task.column === toColumn) return undefined;

    const workflowIr = store.resolveTaskWorkflowIrSync(id);
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

export function listWorkflowPromptOverridesForProjectImpl(store: TaskStore): Record<string, Record<string, string>> {
    const projectId = store.getWorkflowSettingsProjectId();
    const rows = store.db
      .prepare("SELECT workflowId, overrides FROM workflow_prompt_overrides WHERE projectId = ?")
      .all(projectId) as Array<{ workflowId: string; overrides: string }>;
    const out: Record<string, Record<string, string>> = {};
    for (const row of rows) {
      out[row.workflowId] = store.parseWorkflowPromptOverrideJson(row.overrides);
    }
    return out;
  }

export async function listWorkflowWorkItemsForTaskImpl(store: TaskStore, taskId: string, opts: { kinds?: WorkflowWorkItemKind[] } = {}): Promise<WorkflowWorkItem[]> {
    // No dedicated async helper; use a raw Drizzle query in backend mode.
    if (store.backendMode) {
      const layer = store.asyncLayer!;
      const q = layer.db
        .select()
        .from(schema.project.workflowWorkItems)
        .where(eq(schema.project.workflowWorkItems.taskId, taskId));
      const rows = opts.kinds?.length
        ? await layer.db
            .select()
            .from(schema.project.workflowWorkItems)
            .where(and(eq(schema.project.workflowWorkItems.taskId, taskId), inArray(schema.project.workflowWorkItems.kind, opts.kinds)))
        : await q;
      return (rows as WorkflowWorkItemRow[]).map((row) => store.rowToWorkflowWorkItem(row));
    }
    const conditions = ["taskId = ?"];
    const params: unknown[] = [taskId];
    if (opts.kinds?.length) {
      conditions.push(`kind IN (${opts.kinds.map(() => "?").join(", ")})`);
      params.push(...opts.kinds);
    }
    const rows = store.db
      .prepare(
        `SELECT *
           FROM workflow_work_items
          WHERE ${conditions.join(" AND ")}
          ORDER BY createdAt ASC, id ASC`,
      )
      .all(...params) as WorkflowWorkItemRow[];
    return rows.map((row) => store.rowToWorkflowWorkItem(row));
  }

export async function listDueWorkflowWorkItemsImpl(store: TaskStore, filter: WorkflowWorkItemDueFilter = {}): Promise<WorkflowWorkItem[]> {
    if (store.backendMode) {
      const layer = store.asyncLayer!;
      return listDueWorkflowWorkItemsAsync(layer.db, filter);
    }
    const now = filter.now ?? new Date().toISOString();
    const includeExpiredRunning = !filter.states || filter.states.includes("running");
    const states = filter.states?.length ? filter.states : ["runnable", "retrying"];
    const stateConditions = [`(state IN (${states.map(() => "?").join(", ")}) AND (leaseExpiresAt IS NULL OR leaseExpiresAt <= ?))`];
    const params: unknown[] = [...states, now];
    if (includeExpiredRunning) {
      stateConditions.push("(state = 'running' AND leaseExpiresAt IS NOT NULL AND leaseExpiresAt <= ?)");
      params.push(now);
    }
    const conditions = [
      `(${stateConditions.join(" OR ")})`,
      "(retryAfter IS NULL OR retryAfter <= ?)",
    ];
    params.push(now);
    if (filter.kinds?.length) {
      conditions.push(`kind IN (${filter.kinds.map(() => "?").join(", ")})`);
      params.push(...filter.kinds);
    }
    params.push(filter.limit ?? 100);

    const rows = store.db
      .prepare(
        `SELECT *
           FROM workflow_work_items
          WHERE ${conditions.join(" AND ")}
          ORDER BY retryAfter IS NOT NULL, retryAfter ASC, createdAt ASC
          LIMIT ?`,
      )
      .all(...params) as WorkflowWorkItemRow[];
    return rows.map((row) => store.rowToWorkflowWorkItem(row));
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
    if (store.backendMode) {
      return getAllDocumentsAsync(store.asyncLayer!.db, options);
    }
    const limit = Math.min(Math.max(1, options?.limit ?? 200), 1000);
    const offset = Math.max(0, options?.offset ?? 0);

    let sql = `
      SELECT td.*, t.title as taskTitle, t.description as taskDescription, t.column as taskColumn
      FROM task_documents td
      JOIN tasks t ON td.taskId = t.id
      WHERE t.${TaskStore.ACTIVE_TASKS_WHERE}
    `;
    const params: (string | number)[] = [];

    if (options?.searchQuery && options.searchQuery.trim() !== "") {
      const query = `%${options.searchQuery.trim()}%`;
      sql += ` AND (td.key LIKE ? OR td.content LIKE ? OR t.title LIKE ?)`;
      params.push(query, query, query);
    }

    sql += ` ORDER BY td.updatedAt DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const rows = store.db.prepare(sql).all(...params) as unknown as (TaskDocumentRow & { taskTitle: string; taskDescription: string; taskColumn: string })[];
    return rows.map((row) => {
      const doc = store.rowToTaskDocument(row);
      return {
        ...doc,
        taskTitle: row.taskTitle,
        taskDescription: row.taskDescription,
        taskColumn: row.taskColumn,
      };
    });
  }

export async function deleteWorkflowStepImpl(store: TaskStore, id: string): Promise<void> {
    const deleted = store.db.prepare("DELETE FROM workflow_steps WHERE id = ?").run(id) as {
      changes?: number;
    };

    if ((deleted.changes || 0) === 0) {
      throw new Error(`Workflow step '${id}' not found`);
    }

    store.db.bumpLastModified();
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

export function toWorkflowDefinitionImpl(store: TaskStore, row: { id: string; name: string; description: string; ir: string; layout: string; kind?: string | null; createdAt: string; updatedAt: string; }): WorkflowDefinition {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
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
    if (store.backendMode) {
      const layer = store.asyncLayer!;
      return getTaskMovedCountsByDayAsync(layer.db, options);
    }
    let sql =
      "SELECT substr(timestamp, 1, 10) AS day, COUNT(*) AS count FROM activityLog WHERE type = 'task:moved' AND timestamp > ? AND timestamp <= ?";
    const params: (string | number)[] = [options.since, options.until];

    if (options.fromColumn) {
      sql += " AND json_extract(metadata, '$.from') = ?";
      params.push(options.fromColumn);
    }

    if (options.toColumn) {
      sql += " AND json_extract(metadata, '$.to') = ?";
      params.push(options.toColumn);
    }

    sql += " GROUP BY substr(timestamp, 1, 10)";

    const rows = store.db.prepare(sql).all(...params) as Array<{ day: string; count: number }>;
    const countsByDay: Record<string, number> = {};
    for (const row of rows) {
      countsByDay[row.day] = row.count;
    }
    return countsByDay;
  }

export function getGoalStoreImpl(store: TaskStore): GoalStore | AsyncGoalStore {
    if (!store.goalStore) {
      // FNXC:GoalStore 2026-06-27-18:05:
      // PG backend mode returns the AsyncDataLayer-backed AsyncGoalStore (goal CRUD
      // + ACTIVE_GOAL_LIMIT enforcement over project.goals). The sync SQLite
      // GoalStore (store.db) is used only in legacy SQLite mode. Both expose the
      // same method names; the dashboard goals routes, mission goal-resolution
      // helpers, and CLI/agent goal tools await the result so either backend works.
      if (store.backendMode) {
        const layer = store.getAsyncLayer();
        if (!layer) {
          throw new Error("GoalStore is not available: AsyncDataLayer not initialized in backend mode");
        }
        store.goalStore = new AsyncGoalStore(layer);
      } else {
        store.goalStore = new GoalStore(store.fusionDir, store.db);
      }
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
    if (store.backendMode) {
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
    store.db.prepare(
      `INSERT INTO task_commit_associations
       (id, taskLineageId, taskIdSnapshot, commitSha, commitSubject, authoredAt, matchedBy, confidence, note, additions, deletions, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(taskLineageId, commitSha, matchedBy) DO UPDATE SET
         taskIdSnapshot = excluded.taskIdSnapshot,
         commitSubject = excluded.commitSubject,
         authoredAt = excluded.authoredAt,
         confidence = excluded.confidence,
         note = excluded.note,
         additions = excluded.additions,
         deletions = excluded.deletions,
         updatedAt = excluded.updatedAt`,
    ).run(
      association.id,
      association.taskLineageId,
      association.taskIdSnapshot,
      association.commitSha,
      association.commitSubject,
      association.authoredAt,
      association.matchedBy,
      association.confidence,
      association.note ?? null,
      association.additions ?? null,
      association.deletions ?? null,
      association.createdAt,
      association.updatedAt,
    );
    return association;
  }

