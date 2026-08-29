/**
 * workflow-ops operations.
 *
 * FNXC:StoreModularization 2026-06-25-00:00:
 * Extracted from the monolithic packages/core/src/store.ts as a pure
 * behavior-preserving refactor. Each function receives the TaskStore
 * instance as its first parameter and performs byte-identical work.
 */
import {TaskStore} from "../store.js";
import type {Settings} from "../types.js";
import { parseWorkflowIr, downgradeIrToV1IfPure } from "../workflows/workflow-ir.js";
import {OccupiedColumnsError, assertRehomeTargetValid, computeRemovedOccupiedColumns, computeIncompatibleFieldChanges, IncompatibleFieldChangeError, resolveEntryColumnId} from "../workflows/workflow-reconciliation.js";
import type {WorkflowFieldDefinition} from "../workflows/workflow-ir-types.js";
import {resolveDefaultWorkflowIr} from "../workflows/builtin-workflows.js";
import "../builtin-traits.js";
import {normalizeWorkflowIcon, type WorkflowDefinition, type WorkflowDefinitionUpdate} from "../workflows/workflow-definition-types.js";
import {resolveDefaultOnOptionalGroupIds} from "../workflows/workflow-optional-steps.js";
import {isBuiltinWorkflowId} from "../workflows/builtin-workflows.js";
import {fromJson} from "../db/db.js";
import {__setTaskActivityLogLimitsForTesting} from "../task-store/comments.js";
import * as schema from "../postgres/schema/index.js";
import {readProjectConfig, writeProjectConfig} from "../task-store/async/async-settings.js";
import {and, eq, inArray} from "drizzle-orm";
import {projectScopeFor, type AsyncDataLayer} from "../postgres/data-layer.js";

export async function createWorkflowStepImpl(store: TaskStore, input: import("../types.js").WorkflowStepInput): Promise<import("../types.js").WorkflowStep> {
    return store.withConfigLock(async () => {
      /*
       * FNXC:SqliteFinalRemoval 2026-06-26:
       * P1 fix: no backendMode branch existed, so workflow-step creation threw
       * in PG mode (store.db on the counter read + workflow_steps INSERT). In
       * backend mode, read the counter via readProjectConfig, insert the row
       * via Drizzle, and bump the counter via writeProjectConfig.
       */
      /*
      FNXC:SqliteDualPathCleanup 2026-07-26-13:35:
      Workflow step creation is PostgreSQL-only after dual-path collapse; reuse one AsyncDataLayer binding for counter read + insert.
      */
      const layer = store.asyncLayer!;
      const configRow = await readProjectConfig(layer);
      const nextWsId = configRow.nextWorkflowStepId ?? 1;

      const id = `WS-${String(nextWsId).padStart(3, "0")}`;

      const mode = input.mode || "prompt";
      const gateMode = input.gateMode || "advisory";

      // Validate: script mode requires scriptName
      if (mode === "script" && !input.scriptName?.trim()) {
        throw new Error("Script mode requires a scriptName");
      }

      const now = new Date().toISOString();
      const step: import("../types.js").WorkflowStep = {
        id,
        templateId: input.templateId,
        name: input.name,
        description: input.description,
        mode,
        phase: input.phase || "pre-merge",
        gateMode,
        prompt: mode === "prompt" ? (input.prompt || "") : "",
        toolMode: mode === "prompt" ? (input.toolMode || "readonly") : undefined,
        scriptName: mode === "script" ? input.scriptName : undefined,
        enabled: input.enabled !== undefined ? input.enabled : true,
        defaultOn: input.defaultOn !== undefined ? input.defaultOn : undefined,
        modelProvider: mode === "prompt" ? input.modelProvider : undefined,
        modelId: mode === "prompt" ? input.modelId : undefined,
        migratedFragmentId: input.migratedFragmentId,
        createdAt: now,
        updatedAt: now,
      };

      await layer.db.insert(schema.project.workflowSteps).values({
        projectId: layer.projectId?.trim() ?? "",
        id: step.id,
        templateId: step.templateId ?? null,
        name: step.name,
        description: step.description,
        mode: step.mode,
        phase: step.phase || "pre-merge",
        gateMode: step.gateMode,
        prompt: step.prompt,
        toolMode: step.toolMode ?? null,
        scriptName: step.scriptName ?? null,
        enabled: step.enabled ? 1 : 0,
        defaultOn: step.defaultOn === undefined ? null : step.defaultOn ? 1 : 0,
        modelProvider: step.modelProvider ?? null,
        modelId: step.modelId ?? null,
        migratedFragmentId: step.migratedFragmentId ?? null,
        createdAt: step.createdAt,
        updatedAt: step.updatedAt,
      });
      /*
      FNXC:SqliteDualPathCleanup 2026-07-26-15:00:
      writeProjectConfig replaces the settings jsonb wholesale — pass the existing settings so bumping nextWorkflowStepId cannot wipe project config to {}.
      */
      await writeProjectConfig(layer, (configRow.settings ?? {}) as Record<string, unknown>, { nextWorkflowStepId: nextWsId + 1 });
      store.workflowStepsCache = null;
      return step;
});
  }

export async function updateWorkflowStepImpl(store: TaskStore, id: string, updates: Partial<import("../types.js").WorkflowStepInput>): Promise<import("../types.js").WorkflowStep> {
    // FNXC:PostgresCutover 2026-06-28-10:00:
    // Backend-mode branch: read the step row via Drizzle, apply updates, write back.
        const layer = store.asyncLayer!;
    const rows = await layer.db.select().from(schema.project.workflowSteps).where(and(eq(schema.project.workflowSteps.id, id), projectScopeFor(schema.project.workflowSteps.projectId, layer.projectId))).limit(1);
    const pgRow = rows[0];
    if (!pgRow) throw new Error(`Workflow step '${id}' not found`);

    const step = store.toStoredWorkflowStep({
      id: pgRow.id,
      templateId: pgRow.templateId,
      name: pgRow.name,
      description: pgRow.description,
      mode: pgRow.mode,
      phase: pgRow.phase,
      gateMode: pgRow.gateMode,
      prompt: pgRow.prompt,
      toolMode: pgRow.toolMode,
      scriptName: pgRow.scriptName,
      enabled: pgRow.enabled,
      defaultOn: pgRow.defaultOn,
      modelProvider: pgRow.modelProvider,
      modelId: pgRow.modelId,
      migrated_fragment_id: pgRow.migratedFragmentId,
      createdAt: pgRow.createdAt,
      updatedAt: pgRow.updatedAt,
    });

    if (updates.mode !== undefined) {
      const newMode = updates.mode;
      if (newMode === "script" && !updates.scriptName?.trim() && !step.scriptName?.trim()) {
        throw new Error("Script mode requires a scriptName");
      }
      step.mode = newMode;
      if (newMode === "script") { step.prompt = ""; step.gateMode = step.gateMode || "gate"; step.toolMode = undefined; step.modelProvider = undefined; step.modelId = undefined; }
      if (newMode === "prompt") { step.scriptName = undefined; step.gateMode = step.gateMode || "advisory"; step.toolMode = step.toolMode || "readonly"; }
    }
    if (updates.name !== undefined) step.name = updates.name;
    if (updates.description !== undefined) step.description = updates.description;
    if (updates.phase !== undefined) step.phase = updates.phase;
    if (updates.gateMode !== undefined) step.gateMode = updates.gateMode;
    if (updates.prompt !== undefined && step.mode === "prompt") step.prompt = updates.prompt;
    if (updates.toolMode !== undefined && step.mode === "prompt") step.toolMode = updates.toolMode;
    if (updates.scriptName !== undefined && step.mode === "script") step.scriptName = updates.scriptName;
    if (updates.enabled !== undefined) step.enabled = updates.enabled;
    if (updates.defaultOn !== undefined) step.defaultOn = updates.defaultOn;
    if (step.mode === "script" && !step.scriptName?.trim()) throw new Error("Script mode requires a scriptName");
    if (step.mode === "prompt") { if ("modelProvider" in updates) step.modelProvider = updates.modelProvider; if ("modelId" in updates) step.modelId = updates.modelId; }
    if ("migratedFragmentId" in updates) step.migratedFragmentId = updates.migratedFragmentId;
    step.updatedAt = new Date().toISOString();

    await layer.db.update(schema.project.workflowSteps).set({
      templateId: step.templateId ?? null,
      name: step.name,
      description: step.description,
      mode: step.mode,
      phase: step.phase || "pre-merge",
      gateMode: step.gateMode,
      prompt: step.prompt,
      toolMode: step.toolMode ?? null,
      scriptName: step.scriptName ?? null,
      enabled: step.enabled ? 1 : 0,
      defaultOn: step.defaultOn === undefined ? null : step.defaultOn ? 1 : 0,
      modelProvider: step.modelProvider ?? null,
      modelId: step.modelId ?? null,
      migratedFragmentId: step.migratedFragmentId ?? null,
      updatedAt: step.updatedAt,
    }).where(and(eq(schema.project.workflowSteps.id, id), projectScopeFor(schema.project.workflowSteps.projectId, layer.projectId)));

    store.workflowStepsCache = null;
    return step;
}

export async function updateWorkflowDefinitionImpl(store: TaskStore, id: string, updates: WorkflowDefinitionUpdate,): Promise<WorkflowDefinition> {
    if (isBuiltinWorkflowId(id)) throw new Error("Built-in workflows cannot be edited");
    /* FNXC:SqliteDualPathCleanup 2026-07-26-14:08: workflow definition deletes require AsyncDataLayer. */
    const layer: AsyncDataLayer = store.asyncLayer!;
    /*
    U5 (R20): an edit that removes an OCCUPIED column blocks with a typed
    OccupiedColumnsError unless `rehomeTo` is supplied. Computed before taking the
    config lock (pure DB reads) so the lock body stays focused.

    FNXC:WorkflowColumns 2026-07-28-00:00 (U12 — R9, USER-VISIBLE):
    The `flagOn` conjunct is DELETED. It read the RAW
    `experimentalFeatures.workflowColumns` key, which no production writer sets, so
    this guard has NEVER fired for a real project: removing a column with cards in it
    silently succeeded and left those cards in a column their workflow no longer
    declares. The typed rejection and the `rehomeTo` re-home are the whole point of
    the guard; gating them on a retired flag made the API contract a fiction.

    Operator-visible consequence, deliberate: saving a workflow edit that drops an
    occupied column now FAILS with OccupiedColumnsError instead of succeeding. The
    dashboard editor's re-home flow (which passes `rehomeTo`) becomes reachable for
    the first time. Cards are moved by the editor's explicit choice rather than
    stranded silently.
    */
    let pendingRehome: { rehomeTo: string; occupantTaskIds: string[] } | undefined;
    if (updates.ir !== undefined) {
      const existingForCheck = await store.getWorkflowDefinition(id);
      if (!existingForCheck) throw new Error(`Workflow '${id}' not found`);
      const nextIrForCheck = parseWorkflowIr(updates.ir);
      const occupantsByColumn = await store.occupantsByColumnForWorkflow(id, false);
      const removed = computeRemovedOccupiedColumns(
        existingForCheck.ir,
        nextIrForCheck,
        occupantsByColumn,
      );
      if (removed.length > 0) {
        if (updates.rehomeTo === undefined) {
          throw new OccupiedColumnsError(id, removed);
        }
        assertRehomeTargetValid(nextIrForCheck, updates.rehomeTo);
        // Collect the occupant task ids of the removed columns to re-home AFTER
        // the IR save commits, so the cards land in a column the new IR defines.
        const removedSet = new Set(removed.map((r) => r.columnId));
        const allOccupantTaskIds = await store.listWorkflowOccupantTaskIds(id, false);
        // FNXC:PostgresCutover 2026-06-28: async read for column check
        // FNXC:SqliteDualPathCleanup 2026-07-26-15:00: prefer-const after dual-path collapse; project-scope occupant column lookup.
        const occupantConds = [inArray(schema.project.tasks.id, allOccupantTaskIds)];
        if (layer.projectId) occupantConds.push(eq(schema.project.tasks.projectId, layer.projectId));
        const taskRows = await layer.db.select({id: schema.project.tasks.id, column: schema.project.tasks.column}).from(schema.project.tasks).where(and(...occupantConds));
        const colMap = new Map(taskRows.map(r => [r.id, r.column]));
        const occupantTaskIds = allOccupantTaskIds.filter(tid => {
          const col = colMap.get(tid);
          return col ? removedSet.has(col) : false;
        });
        pendingRehome = { rehomeTo: updates.rehomeTo, occupantTaskIds };
      }
    }

    // U11/KTD-13: when the IR changes custom field types incompatibly for tasks
    // that already hold values, block with a typed IncompatibleFieldChangeError
    // unless `coerce` is supplied. Removed/added fields never block (removal
    // orphans). Flag-independent: fields are orthogonal to the columns flag.
    // Reconciliation runs per occupant task AFTER the IR save commits.
    let pendingFieldReconcile:
      | { oldFields: WorkflowFieldDefinition[]; newFields: WorkflowFieldDefinition[]; occupantTaskIds: string[]; coerce?: "drop" | "keep-orphaned" }
      | undefined;
    if (updates.ir !== undefined) {
      const existingForFields = await store.getWorkflowDefinition(id);
      if (!existingForFields) throw new Error(`Workflow '${id}' not found`);
      const nextIrForFields = parseWorkflowIr(updates.ir);
      const oldFields: WorkflowFieldDefinition[] =
        existingForFields.ir.version === "v2" ? (existingForFields.ir.fields ?? []) : [];
      const newFields: WorkflowFieldDefinition[] =
        nextIrForFields.version === "v2" ? (nextIrForFields.fields ?? []) : [];
      const fieldsChanged =
        JSON.stringify(oldFields) !== JSON.stringify(newFields);
      if (fieldsChanged) {
        const occupantTaskIds = await store.listWorkflowOccupantTaskIds(id, false);
        const occupantsByField = new Map<string, number>();
        for (const taskId of occupantTaskIds) {
          let values: Record<string, unknown> = {};
          
          const taskRows = await layer.db.select({customFields: schema.project.tasks.customFields}).from(schema.project.tasks).where(eq(schema.project.tasks.id, taskId)).limit(1);
          const cf = taskRows[0]?.customFields;
          if (cf && typeof cf === "object") values = cf as Record<string, unknown>;
          else if (typeof cf === "string") values = fromJson(cf) ?? {};
        
          // Incompatible-change detection only blocks on occupants that already
          // HOLD a value for a field, so count only those. Reconciliation itself
          // must still touch every occupant so new required+default fields get
          // backfilled onto tasks that currently have no custom field values.
          if (Object.keys(values).length === 0) continue;
          for (const key of Object.keys(values)) {
            occupantsByField.set(key, (occupantsByField.get(key) ?? 0) + 1);
          }
        }
        const incompatible = computeIncompatibleFieldChanges(
          existingForFields.ir,
          nextIrForFields,
          occupantsByField,
        );
        if (incompatible.length > 0 && updates.coerce === undefined) {
          throw new IncompatibleFieldChangeError(id, incompatible);
        }
        pendingFieldReconcile = {
          oldFields,
          newFields,
          occupantTaskIds,
          coerce: updates.coerce,
        };
      }
    }
    const saved = await store.withConfigLock(async () => {
      const existing = await store.getWorkflowDefinition(id);
      if (!existing) throw new Error(`Workflow '${id}' not found`);

      const name = updates.name !== undefined ? updates.name.trim() : existing.name;
      if (!name) throw new Error("Workflow name is required");
      const ir = updates.ir !== undefined ? parseWorkflowIr(updates.ir) : existing.ir;
      // Residual A: reject save-blocking trait composition conflicts server-side
      // when the IR is being changed.
      if (updates.ir !== undefined) store.assertWorkflowIrTraitsValid(ir);
      const next: WorkflowDefinition = {
        ...existing,
        name,
        description: updates.description !== undefined ? updates.description : existing.description,
        icon: updates.icon !== undefined ? normalizeWorkflowIcon(updates.icon) : existing.icon,
        ir,
        layout: updates.layout !== undefined ? updates.layout : existing.layout,
        updatedAt: new Date().toISOString(),
      };

      
      // FNXC:PostgresCutover 2026-06-28: async UPDATE for workflows row
      await layer.db.update(schema.project.workflows).set({
        name: next.name,
        description: next.description,
        icon: next.icon ?? null,
        /*
        FNXC:WorkflowColumns 2026-07-28-00:00 (U12 — R9, BEHAVIOUR-PRESERVING):
        v1-IR rollback-compat persistence (#1405), now unconditional — which is what it
        already was. The flag read it used to branch on is retired and always false, so
        every real project has always taken the downgrade arm. See the fuller note on
        the create path in `project-store-ops.ts`; the downgrade is kept on purpose.
        */
        ir: downgradeIrToV1IfPure(next.ir),
        layout: next.layout,
        updatedAt: next.updatedAt,
      }).where(and(
        eq(schema.project.workflows.id, id),
        projectScopeFor(schema.project.workflows.projectId, layer.projectId),
      ));
    
      store.workflowDefinitionsCache = null;
      return next;
    });

    // U5 (R20): now that the new IR is committed, re-home the occupants of the
    // removed columns into `rehomeTo` (one audit event per card). Done outside
    // the config lock; each rehome takes its own task lock via moveTask.
    if (pendingRehome) {
      for (const taskId of pendingRehome.occupantTaskIds) {
        await store.rehomeOccupant(taskId, pendingRehome.rehomeTo, "workflow-edit-rehome", {
          workflowId: id,
        });
      }
    }

    // U11/KTD-13: now that the new field schema is committed, reconcile each
    // occupant task's stored values against it (orphan-not-delete by default;
    // coerce:"drop" discards orphans). Each runs under its own task lock.
    if (pendingFieldReconcile) {
      const dropOrphans = pendingFieldReconcile.coerce === "drop";
      for (const taskId of pendingFieldReconcile.occupantTaskIds) {
        await store.withTaskLock(taskId, () =>
          store.reconcileTaskCustomFieldsForSchema(
            taskId,
            pendingFieldReconcile!.oldFields,
            pendingFieldReconcile!.newFields,
            dropOrphans,
          ),
        );
      }
    }
    return saved;
  }

export async function deleteWorkflowDefinitionImpl(store: TaskStore, id: string): Promise<void> {
    if (isBuiltinWorkflowId(id)) throw new Error("Built-in workflows cannot be deleted");
    /* FNXC:SqliteDualPathCleanup 2026-07-26-14:08: workflow definition deletes require AsyncDataLayer. */
    const layer: AsyncDataLayer = store.asyncLayer!;
    /*
    U5 (R20): capture the occupant task ids BEFORE the cascade clears their selection
    rows, so we can re-home them to the DEFAULT workflow's entry column once their
    selection resolves back to the default (KTD-1).

    FNXC:WorkflowColumns 2026-07-28-00:00 (U12 — R9, USER-VISIBLE):
    The `flagOn ? … : []` gate is DELETED. Reading the retired raw flag meant the
    capture returned an empty list for every real project, so the re-home below was
    dead: deleting a workflow left its cards sitting in that workflow's columns with
    their selection cleared, resolving to the default workflow which does not declare
    those columns. The startup sweep `reconcileUndeclaredTaskColumns` would eventually
    re-home them, but only on the next engine start — until then the cards sat in
    lanes the board could not draw.

    Operator-visible consequence, deliberate: deleting a workflow now moves its cards
    to the default workflow's entry column immediately, instead of at next startup.
    */
    const occupantTaskIds = await store.listWorkflowOccupantTaskIds(id, false);

    
    /*
    FNXC:WorkflowDefinitionProjectPartition 2026-08-12-03:02:
    Before project ownership predicates, deleting a colliding workflow ID removed a foreign
    workflow and its settings/prompt overrides under owner connections that bypass RLS. Keep
    every delete in this transaction on the same bound partition.
    */
    const deleted = await layer.db.delete(schema.project.workflows).where(and(
      eq(schema.project.workflows.id, id),
      projectScopeFor(schema.project.workflows.projectId, layer.projectId),
    )).returning();
    if (deleted.length === 0) throw new Error(`Workflow '${id}' not found`);
    store.workflowDefinitionsCache = null;
    await layer.db.delete(schema.project.workflowSettings).where(and(
      eq(schema.project.workflowSettings.workflowId, id),
      projectScopeFor(schema.project.workflowSettings.projectId, layer.projectId),
    ));
    await layer.db.delete(schema.project.workflowPromptOverrides).where(and(
      eq(schema.project.workflowPromptOverrides.workflowId, id),
      projectScopeFor(schema.project.workflowPromptOverrides.projectId, layer.projectId),
    ));
  

    // Cascade: clear the project default when it pointed at this workflow.
    try {
      if ((await store.getDefaultWorkflowId()) === id) {
        await store.setDefaultWorkflowId(null);
      }
    } catch {
      // Best-effort: a dangling default falls back gracefully at task creation.
    }

    // Cascade: drop selections referencing this workflow, their materialized
    // step rows, and reset the affected tasks' enabled steps.
    const selRows = await layer.db.select().from(schema.project.taskWorkflowSelection).where(eq(schema.project.taskWorkflowSelection.workflowId, id));
    const selections = selRows.map(r => ({ taskId: r.taskId, stepIds: typeof r.stepIds === "string" ? r.stepIds : JSON.stringify(r.stepIds ?? []) }));

    for (const row of selections) {
      try {
        const stepIds = JSON.parse(row.stepIds) as unknown;
        if (Array.isArray(stepIds)) {
          for (const stepId of stepIds) {
            if (typeof stepId === "string") {
               await layer.db.delete(schema.project.workflowSteps).where(and(eq(schema.project.workflowSteps.id, stepId), projectScopeFor(schema.project.workflowSteps.projectId, layer.projectId)));
            }
          }
        }
      } catch {
        // Corrupt stepIds list — still remove the selection row below.
      }
       await layer.db.delete(schema.project.taskWorkflowSelection).where(eq(schema.project.taskWorkflowSelection.taskId, row.taskId)); 
      try {
        await store.updateTask(row.taskId, { enabledWorkflowSteps: [] });
      } catch {
        // Task may be deleted/archived; dangling step ids resolve to undefined
        // at execution time and are skipped.
      }
    }
    if (selections.length > 0) store.workflowStepsCache = null;
    
    // U5 (R20) delete reconciliation: re-home each occupant to the default
    // workflow's entry column. Their selection rows are already cleared above,
    // so they now resolve to the built-in default workflow (KTD-1); the re-home
    // move preserves task fields (preserveProgress) and emits one audit per card.
    if (occupantTaskIds.length > 0) {
      /*
      FNXC:WorkflowResolvedColumns 2026-07-31-23:59 (the #3178 drift, in the delete path):
      THE DEFAULT WORKFLOW, NOT THE LEGACY ONE. `BUILTIN_CODING_WORKFLOW_IR` is
      `builtin:legacy-coding`; the catalog's actual default is `resolveDefaultWorkflowIr()`. Post-U11
      they differ by exactly the column this line reads:

          default  todo, in-progress, in-review, done, archived
          legacy   triage, todo, in-progress, in-review, done, archived

      so `resolveEntryColumnId` answered `triage` for the legacy IR and `todo` for the default —
      measured, not inferred. The comment above already says "re-home each occupant to the DEFAULT
      workflow's entry column"; the code read the legacy one.

      CONSEQUENCE: deleting a workflow re-homed every occupant into `triage`, a column the default
      board does not declare. `moveTask` rejects an undeclared target EXCEPT under `recoveryRehome`
      with a legacy id — and `triage` IS a legacy id — so this slipped through the guard that exists
      to stop exactly this, and left the card in a lane its workflow has no node for.

      Same drift #3178 fixed in the TUI board and `builtin-workflows.ts` records as already fixed for
      the move-path resolvers. This is the third door into it.
      */
      const defaultEntry = resolveEntryColumnId(resolveDefaultWorkflowIr());
      if (defaultEntry) {
        for (const taskId of occupantTaskIds) {
          await store.rehomeOccupant(taskId, defaultEntry, "workflow-delete", { workflowId: id });
        }
      }
    }
  }

export async function setDefaultWorkflowIdImpl(store: TaskStore, workflowId: string | null): Promise<void> {
    if (workflowId) {
      const exists = await store.getWorkflowDefinition(workflowId);
      if (!exists) throw new Error(`Workflow '${workflowId}' not found`);
      // KTD-1/R6: a fragment is a reusable palette piece, not a selectable
      // workflow. Reject it at the write boundary so a fragment can never be
      // persisted as the project default (the read-side skip in
      // materializeDefaultWorkflowSteps remains as defense in depth).
      if (exists.kind === "fragment") {
        throw new Error(`Workflow '${workflowId}' is a fragment and cannot be set as the project default`);
      }
    }
    // null is updateSettings' explicit-delete sentinel for project keys.
    await store.updateSettings({ defaultWorkflowId: workflowId } as unknown as Partial<Settings>);
  }

export async function selectTaskWorkflowImpl(store: TaskStore, taskId: string, workflowId: string): Promise<string[]> {
    /* FNXC:SqliteDualPathCleanup 2026-07-26-14:08: workflow definition deletes require AsyncDataLayer. */
    const layer: AsyncDataLayer = store.asyncLayer!;
    // Hold the task lock across the whole sequence (materialize → owner write →
    // prior-step cleanup) so it can't interleave with a concurrent select/clear
    // or executor updateTask on the same task. updateTaskUnlocked is used inside
    // because the per-task lock is non-reentrant.
    return store.withTaskLock(taskId, async () => {
      const def = await store.getWorkflowDefinition(workflowId);
      if (!def) throw new Error(`Workflow '${workflowId}' not found`);
      // KTD-1/R6: fragments are reusable single-node palette templates, not
      // selectable workflows. Reject them from task selection with a clear error
      // rather than materializing a degenerate single-step task.
      if (def.kind === "fragment") {
        throw new Error(`Workflow '${workflowId}' is a fragment and cannot be selected for a task`);
      }
      // FNXC:LegacyWorkflowEngineRemoval 2026-07-02-00:00:
      // FN-7360 removed the legacy linear compiler; the graph interpreter is
      // the sole executor. Validation is now parseWorkflowIr (accepts branching
      // graphs). No step materialization is needed.
      parseWorkflowIr(def.ir);
      const ids: string[] = resolveDefaultOnOptionalGroupIds(def.ir);

      // Materialize the new steps and point the task at them BEFORE deleting the
      // prior selection's rows, so a mid-flight failure never leaves the task
      // referencing already-deleted step ids.
      const priorSelection = await store.getTaskWorkflowSelectionAsync(taskId);
      // U11/KTD-13: capture the OLD field schema (from the prior selection's IR)
      // before the selection row flips, so we can reconcile existing field values
      // against the NEW workflow's schema below.
      const oldFieldDefs = store.resolveTaskCustomFieldDefsSync(taskId);
      const newFieldDefs: WorkflowFieldDefinition[] =
        def.ir.version === "v2" ? (def.ir.fields ?? []) : [];
      try {
        await store.updateTaskUnlocked(taskId, { enabledWorkflowSteps: ids });
        await store.writeTaskWorkflowSelection(taskId, workflowId, ids);
      } catch (err) {
        // The owner write (updateTask / selection upsert) failed, so the steps we
        // just materialized would orphan with no selection row pointing at them.
        // Delete them before propagating; the prior selection is left untouched.
        for (const stepId of ids) {
          try {
             await layer.db.delete(schema.project.workflowSteps).where(and(eq(schema.project.workflowSteps.id, stepId), projectScopeFor(schema.project.workflowSteps.projectId, layer.projectId)));
          } catch {
            // Best-effort cleanup; surface the original error below.
          }
        }
        store.workflowStepsCache = null;
        throw err;
      }

      if (priorSelection) {
        for (const stepId of priorSelection.stepIds) {
           await layer.db.delete(schema.project.workflowSteps).where(and(eq(schema.project.workflowSteps.id, stepId), projectScopeFor(schema.project.workflowSteps.projectId, layer.projectId)));
        }
        store.workflowStepsCache = null;
      }

      // U11/KTD-13: reconcile custom field values against the NEW workflow's
      // schema. Same-id, type-compatible values are kept; incompatible/removed
      // ids are orphaned — but RETAINED in storage (orphan-not-delete) so a later
      // switch back, or the orphaned-fields disclosure, can still surface them.
      // Then fill defaults for the new workflow's required+default fields that
      // are absent. The merged object is written DIRECTLY (bypassing the
      // validating patch path) because orphaned ids are by definition unknown to
      // the new schema and would otherwise be rejected.
      await store.reconcileTaskCustomFieldsForSchema(taskId, oldFieldDefs, newFieldDefs);

      return ids;
    });
  }
