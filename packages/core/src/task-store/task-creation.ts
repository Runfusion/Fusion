/**
 * task-creation operations.
 *
 * FNXC:StoreModularization 2026-06-25-00:00:
 * Extracted from the monolithic packages/core/src/store.ts as a pure
 * behavior-preserving refactor. Each function receives the TaskStore
 * instance as its first parameter and performs byte-identical work.
 */
import {TaskStore, storeLog} from "../store.js";
import {InvalidFileScopeError, SelfDefeatingDependencyError, detectSelfDefeatingDependency, TombstonedTaskResurrectionError} from "./errors.js";
import {mkdir, rm, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {existsSync} from "node:fs";
import type {Task, TaskCreateInput, Column, Settings} from "../types.js";
import "../builtin-traits.js";
import {applyReviewLevelPreset} from "../review-level-preset.js";
import {normalizeTaskPriority} from "../task-priority.js";
import {sanitizeTitle, summarizeTitle} from "../ai-summarize.js";
import {extractTaskIdTokens, normalizeTitleForTaskId} from "../task-title-id-drift.js";
import {resolveTitleSummarizerSettingsModel} from "../model-resolution.js";
import {resolveEffectiveSettingsById} from "../workflow-settings-resolver.js";
import {getErrorMessage} from "../error-message.js";
import {generateTaskLineageId} from "../task-lineage.js";
import {archiveAsSameAgentDuplicate, findSameAgentDuplicates, flagSameAgentDuplicate} from "../duplicate-intake.js";
import {buildBootstrapPrompt} from "../mesh-task-replication.js";
import {validateFileScopeInPromptContent} from "../task-store/file-scope.js";
import {__setTaskActivityLogLimitsForTesting} from "../task-store/comments.js";
import {withTaskBranchContextInSourceMetadata} from "../task-store/branch-context.js";
import {softDeleteTaskRow as softDeleteTaskRowAsync, insertTaskRowInTransaction, isTaskIdConflictError} from "../task-store/async-persistence.js";

function ensureSqliteProposalClaimUniqueness(store: TaskStore): void {
  /*
  FNXC:EphemeralAgentTaskCreation 2026-07-30-19:10:
  The legacy SQLite store remains a supported MessageStore/task-materialization
  backend. Its durable partial unique index is the same at-most-once anchor as
  PostgreSQL: release/reclaim reuses one stable key, so concurrent creators can
  only insert one task and the loser returns that persisted task.
  */
  const columns = store.db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "proposalClaimId")) {
    store.db.exec("ALTER TABLE tasks ADD COLUMN proposalClaimId TEXT");
  }
  store.db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS uq_tasks_proposal_claim_id ON tasks(proposalClaimId) WHERE proposalClaimId IS NOT NULL",
  );
}

export async function createTaskBackendImpl(store: TaskStore, input: TaskCreateInput, options?: { onSummarize?: (description: string) => Promise<string | null>; settings?: { autoSummarizeTitles?: boolean }; invokeTaskCreatedHook?: boolean; onProposalClaimConflict?: (task: Task) => void; },): Promise<Task> {
    // U8/R6: apply the reviewLevel creation-time preset (maps level -> enabledWorkflowSteps; explicit wins).
    input = applyReviewLevelPreset(input);
    if (!input.description?.trim()) {
      throw new Error("Description is required and cannot be empty");
    }

    const selfDefeatingDep = detectSelfDefeatingDependency(input.title, input.dependencies ?? []);
    if (selfDefeatingDep) {
      throw new SelfDefeatingDependencyError(
        input.title?.trim() ?? "",
        selfDefeatingDep.matchedVerb,
        selfDefeatingDep.operandTaskId,
      );
    }

    // Resolve settings (same logic as the SQLite path).
    let resolvedSettings = options?.settings;
    if (!resolvedSettings) {
      try {
        resolvedSettings = await store.getSettings();
      } catch {
        resolvedSettings = {};
      }
    }

    // Resolve title summarizer (same logic as the SQLite path).
    let onSummarize = options?.onSummarize;
    if (!onSummarize && (resolvedSettings?.autoSummarizeTitles === true || input.summarize === true)) {
      let summarizerSettings: Partial<Settings> = resolvedSettings ?? {};
      try {
        const defaultWorkflowId = (await store.getDefaultWorkflowId()) ?? "builtin:coding";
        const effective = await resolveEffectiveSettingsById(
          store,
          defaultWorkflowId,
          store.getWorkflowSettingsProjectId(),
        );
        summarizerSettings = { ...summarizerSettings, ...(effective as Partial<Settings>) };
      } catch {
        // Never-throw: fall back to the base settings (global lane only).
      }
      const summarizerModel = resolveTitleSummarizerSettingsModel(summarizerSettings);
      if (summarizerModel.provider && summarizerModel.modelId) {
        onSummarize = async (description: string) => {
          try {
            return await summarizeTitle(
              description,
              store.getRootDir(),
              summarizerModel.provider,
              summarizerModel.modelId,
            );
          } catch {
            return null;
          }
        };
      }
    }

    const title = input.title?.trim() || undefined;
    const shouldSummarize =
      !title &&
      input.description.length > 200 &&
      (input.summarize === true || resolvedSettings?.autoSummarizeTitles === true);
    const hasPendingSummarization = shouldSummarize && typeof onSummarize === "function";
    const shouldInvokeTaskCreatedHook = options?.invokeTaskCreatedHook !== false;

    // Resolve enabledWorkflowSteps (same logic as the SQLite path).
    let resolvedWorkflowSteps: string[] | undefined = input.enabledWorkflowSteps?.length
      ? await store.resolveEnabledWorkflowSteps(input.enabledWorkflowSteps)
      : undefined;

    let pendingWorkflowSelection: { workflowId: string; stepIds: string[] } | undefined;
    let resolvedEntryColumn: string | undefined;
    /*
    FNXC:WorkflowCreation 2026-07-05-14:30:
    User-facing task creation can submit a selected workflowId and optional-group
    toggles together. The visible workflow selection is operator intent and must
    persist as task_workflow_selection; enabledWorkflowSteps only overrides that
    workflow's default optional-group seed. Mirrors the SQLite-path fix
    (FNXC:WorkflowCreation 2026-06-28-23:09) that these PostgreSQL-cutover copies
    predated: previously a create submitting BOTH workflowId and
    enabledWorkflowSteps silently skipped the selection row.
    */
    const explicitWorkflowId = input.workflowId;
    if (explicitWorkflowId !== undefined) {
      if (explicitWorkflowId === null) {
        // Explicit "No workflow": skip default materialization entirely.
        resolvedWorkflowSteps = undefined;
      } else {
        // Compile + materialize up front so unknown/fragment ids throw BEFORE
        // the task row is created (no orphaned steps, no half-created task).
        const selected = await store.materializeExplicitWorkflowSteps(explicitWorkflowId);
        const explicitStepIds = input.enabledWorkflowSteps !== undefined
          ? (resolvedWorkflowSteps ?? [])
          : undefined;
        resolvedWorkflowSteps = explicitStepIds ?? selected.stepIds;
        resolvedEntryColumn = selected.entryColumnId;
        pendingWorkflowSelection = {
          workflowId: selected.workflowId,
          stepIds: explicitStepIds ?? selected.stepIds,
        };
      }
    } else if (input.enabledWorkflowSteps === undefined) {
      try {
        const inherited = await store.materializeDefaultWorkflowSteps();
        if (inherited) {
          resolvedWorkflowSteps = inherited.stepIds;
          resolvedEntryColumn = inherited.entryColumnId;
          pendingWorkflowSelection = inherited;
        }
      } catch (err) {
        storeLog.warn("Failed to apply default workflow during task creation; falling back to default-on steps", {
          phase: "createTaskBackend:default-workflow",
          error: err instanceof Error ? err.message : String(err),
        });
      }

      if (resolvedWorkflowSteps === undefined) {
        try {
          const allSteps = await store.listWorkflowSteps();
          const defaultOnSteps = allSteps
            .filter((ws) => ws.enabled && ws.defaultOn)
            .map((ws) => ws.id);
          if (defaultOnSteps.length > 0) {
            resolvedWorkflowSteps = defaultOnSteps;
          }
        } catch (err) {
          storeLog.warn("Failed to auto-apply default workflow steps during task creation; auto-defaulting skipped", {
            phase: "createTaskBackend:workflow-auto-default",
            skippedAutoDefaulting: true,
            error: err instanceof Error ? err.message : String(err),
            descriptionLength: input.description.length,
          });
        }
      }
    } else if (input.enabledWorkflowSteps.length === 0) {
      // FNXC:WorkflowOptionalSteps 2026-06-29-02:55: an explicit empty
      // optional-step selection must hydrate back as [], not undefined.
      resolvedWorkflowSteps = [];
    }

    // FNXC:RuntimeTaskOrchestrationAsync 2026-06-24-13:20:
    // Allocator reservation: use the async DistributedTaskIdAllocator which
    // is now wired for backend mode. It reserves the next task ID against
    // PostgreSQL's distributed_task_id tables. On success it commits; on
    // failure it aborts the reservation so the sequence is not wasted.
    const allocator = store.getDistributedTaskIdAllocator();
    const settings = await store.getSettingsFast();
    const prefix = (settings.taskPrefix || "KB").trim().toUpperCase();
    const nodeId = await store.resolveLocalNodeIdForTaskAllocation();
    const reservation = await allocator.reserveDistributedTaskId({
      prefix,
      nodeId,
    });

    let task: Task;
    try {
      await store.assertNoDependencyCycle(reservation.taskId, input.dependencies ?? [], "createTask");
      task = await store._createTaskInternalBackend(
        input,
        title,
        resolvedWorkflowSteps,
        reservation.taskId,
        { invokeTaskCreatedHook: shouldInvokeTaskCreatedHook && !hasPendingSummarization, resolvedEntryColumn, onProposalClaimConflict: options?.onProposalClaimConflict },
      );
      await allocator.commitDistributedTaskIdReservation({
        reservationId: reservation.reservationId,
        nodeId,
      });
    } catch (err) {
      await allocator.abortDistributedTaskIdReservation({
        reservationId: reservation.reservationId,
        nodeId,
        reason: "failed-create",
      }).catch(() => undefined);
      throw err;
    }

    // Record the inherited workflow selection now that the task row exists.
    if (pendingWorkflowSelection) {
      try {
        await store.writeTaskWorkflowSelection(task.id, pendingWorkflowSelection.workflowId, pendingWorkflowSelection.stepIds);
      } catch (err) {
        storeLog.warn("Failed to record inherited workflow selection", {
          taskId: task.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Deferred title summarization (same fire-and-forget pattern as SQLite path).
    if (hasPendingSummarization && shouldInvokeTaskCreatedHook) {
      const id = task.id;
      Promise.resolve().then(async () => {
        try {
          const generatedTitle = await onSummarize!(input.description);
          const sanitizedTitle = sanitizeTitle(generatedTitle);
          if (sanitizedTitle) {
            await store.trackDeferredTaskCreatedWork(async () => {
              if (store.closing) return;
              const currentTask = await store.getTask(id);
              if (currentTask && !currentTask.title) {
                const normalizedTitle = normalizeTitleForTaskId(sanitizedTitle, id);
                if (normalizedTitle.title && !store.closing) {
                  await store.updateTask(id, { title: normalizedTitle.title });
                }
              }
            });
          }
        } catch (err) {
          storeLog.warn(
            `Title summarization failed for task ${id}: ${err instanceof Error ? err.message : String(err)}`,
            { taskId: id, descriptionLength: input.description.length },
          );
        }

        await store.trackDeferredTaskCreatedWork(async () => {
          if (store.closing) return;
          let latestTask = task;
          try {
            const refreshed = await store.getTask(id);
            if (refreshed) latestTask = refreshed;
          } catch {
            // Best-effort refresh; fall back to original task snapshot.
          }
          if (store.closing) return;
          try {
            await store.invokeTaskCreatedHook(latestTask);
          } catch (err) {
            storeLog.warn("Deferred task-created hook failed", {
              taskId: id,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        });
      }).catch((err) => {
        storeLog.error("Unexpected title summarization promise-chain failure", {
          taskId: id,
          descriptionLength: input.description.length,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }

    return task;
  }

export async function _createTaskInternalBackendImpl(store: TaskStore, input: TaskCreateInput, title: string | undefined, resolvedWorkflowSteps: string[] | undefined, id: string, options?: { createdAt?: string; updatedAt?: string; promptOverride?: string; invokeTaskCreatedHook?: boolean; resolvedEntryColumn?: string; onProposalClaimConflict?: (task: Task) => void; },): Promise<Task> {
    const layer = store.asyncLayer!;
    const now = options?.createdAt ?? new Date().toISOString();
    const normalizedTitle = normalizeTitleForTaskId(title, id);
    const task: Task = {
      id,
      lineageId: input.lineageId ?? generateTaskLineageId(),
      proposalClaimId: input.proposalClaimId,
      title: normalizedTitle.title ?? undefined,
      description: input.description,
      priority: normalizeTaskPriority(input.priority),
      tokenUsage: input.tokenUsage,
      sourceIssue: input.sourceIssue,
      githubTracking: input.githubTracking,
      gitlabTracking: input.gitlabTracking,
      sourceType: input.source?.sourceType ?? "unknown",
      sourceAgentId: input.source?.sourceAgentId,
      sourceRunId: input.source?.sourceRunId,
      sourceSessionId: input.source?.sourceSessionId,
      sourceMessageId: input.source?.sourceMessageId,
      sourceParentTaskId: input.source?.sourceParentTaskId,
      sourceMetadata: withTaskBranchContextInSourceMetadata(input.source?.sourceMetadata, input.branchContext),
      branchContext: input.branchContext,
      autoMerge: input.autoMerge,
      autoMergeProvenance: input.autoMerge === undefined ? undefined : "user",
      // FNXC:CodingIdeasWorkflow 2026-07-05-19:45: land the task in its
      // workflow's manual intake column (e.g. Coding (Ideas) → "ideas") when
      // no explicit column is given (main FN-7591 parity).
      column: input.column || options?.resolvedEntryColumn || "triage",
      dependencies: input.dependencies || [],
      breakIntoSubtasks: input.breakIntoSubtasks === true ? true : undefined,
      noCommitsExpected: input.noCommitsExpected === true ? true : undefined,
      enabledWorkflowSteps: resolvedWorkflowSteps,
      modelPresetId: input.modelPresetId,
      assignedAgentId: input.assignedAgentId,
      assigneeUserId: input.assigneeUserId,
      scopeOverride: input.scopeOverride === true ? true : undefined,
      scopeOverrideReason: input.scopeOverrideReason,
      nodeId: input.nodeId,
      modelProvider: input.modelProvider,
      modelId: input.modelId,
      validatorModelProvider: input.validatorModelProvider,
      validatorModelId: input.validatorModelId,
      planningModelProvider: input.planningModelProvider,
      planningModelId: input.planningModelId,
      mergerModelProvider: input.mergerModelProvider,
      mergerModelId: input.mergerModelId,
      thinkingLevel: input.thinkingLevel,
      validatorThinkingLevel: input.validatorThinkingLevel,
      planningThinkingLevel: input.planningThinkingLevel,
      mergerThinkingLevel: input.mergerThinkingLevel,
      reviewLevel: input.reviewLevel,
      executionMode: input.executionMode,
      // FNXC:PlannerOversight 2026-07-14-18:11: only set when create input is explicit boolean.
      sessionAdvisorEnabled: typeof input.sessionAdvisorEnabled === "boolean" ? input.sessionAdvisorEnabled : undefined,
      baseBranch: input.baseBranch,
      branch: input.branch,
      missionId: input.missionId,
      sliceId: input.sliceId,
      steps: [],
      currentStep: 0,
      log: [{ timestamp: now, action: "Task created" }],
      columnMovedAt: now,
      createdAt: now,
      updatedAt: options?.updatedAt ?? now,
    };

    if (normalizedTitle.changed) {
      task.log.push({
        timestamp: now,
        action: "Title normalized: stripped legacy task-id reference",
      });
    }

    const dir = store.taskDir(id);

    // FNXC:RuntimeTaskOrchestrationAsync 2026-06-24-13:30:
    // Insert the task row via async Drizzle insert inside a transaction.
    // A duplicate-ID collision raises a unique_violation (23505) which we
    // catch and surface as "Task ID already exists" (matching the SQLite path).
    const context = store.createTaskPersistSerializationContext(task);
    try {
      await layer.transactionImmediate(async (tx) => {
        // FNXC:MultiProjectIsolation 2026-07-10: stamp the bound projectId so the
        // new task row is attributed to (and later filtered under) this project.
        await insertTaskRowInTransaction(tx, task as unknown as Record<string, unknown>, context, layer.projectId);
      });
    } catch (error) {
      /*
      FNXC:EphemeralAgentTaskCreation 2026-07-30-18:30:
      Proposal creation retries can race after a creation lease is released while
      the original creator is still inserting. Both attempts deliberately use the
      same stable proposalClaimId, so the partial unique index is the at-most-once
      authority. A 23505 for that key returns the committed winner instead of
      treating it as an ID collision; no loser may continue into task-file or
      workflow materialization. Other unique violations remain task-ID errors.
      */
      if (input.proposalClaimId && isTaskIdConflictError(error)) {
        const existing = (await store.listTasks()).find((candidate) => candidate.proposalClaimId === input.proposalClaimId);
        if (existing) {
          options?.onProposalClaimConflict?.(existing);
          return existing;
        }
      }
      if (isTaskIdConflictError(error)) {
        throw new Error(`Task ID already exists: ${task.id}`);
      }
      throw error;
    }

    // FNXC:ReservationAtomicity 2026-07-12-00:00:
    // Wrap post-insert filesystem/prompt work so any failure rolls back the
    // inserted row. Without this, a writeTaskJsonFile or prompt-validation throw
    // leaves a live row paired with an aborted reservation (FN-7074 invariant).
    try {
      // Write task.json for backward compatibility and debugging.
      if (store.isWatching) store.taskCache.set(id, { ...task });
      await store.writeTaskJsonFile(dir, task);

      // Write PROMPT.md (same logic as SQLite path).
      /*
      FNXC:CodingIdeasWorkflow 2026-07-05-19:45:
      A freshly created task needs the bootstrap stub only when it lands in a
      column the triage service will plan from — the legacy "triage" intake or a
      workflow's resolved manual intake (e.g. Coding (Ideas) → "ideas"). Direct
      creates into other columns keep generateSpecifiedPrompt (main parity).
      */
      const isIntakeColumn = task.column === "triage"
        || (options?.resolvedEntryColumn !== undefined && task.column === options.resolvedEntryColumn);
      const prompt = options?.promptOverride
        ?? (isIntakeColumn
          ? buildBootstrapPrompt(id, task.title, task.description)
          : store.generateSpecifiedPrompt(task));
      const validation = validateFileScopeInPromptContent(prompt);
      if (validation.invalid.length > 0) {
        throw new InvalidFileScopeError(id, validation.invalid);
      }
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "PROMPT.md"), prompt);
    } catch (error) {
      // Rollback: soft-delete the inserted row and remove the directory.
      await softDeleteTaskRowAsync(layer, id, new Date().toISOString());
      if (store.isWatching) store.taskCache.delete(id);
      if (existsSync(dir)) {
        await rm(dir, { recursive: true, force: true });
      }
      throw error;
    }

    // Auto-archive dedup (best-effort, same as SQLite path but using async reads).
    await store._maybeAutoArchiveSameAgentDuplicateBackend(task, input);

    store.emitTaskLifecycleEventSafely("task:created", [task]);
    if (options?.invokeTaskCreatedHook !== false) {
      await store.invokeTaskCreatedHook(task);
    }
    return task;
  }

export async function createTaskImpl(store: TaskStore, input: TaskCreateInput, options?: { onSummarize?: (description: string) => Promise<string | null>; settings?: { autoSummarizeTitles?: boolean }; invokeTaskCreatedHook?: boolean; onProposalClaimConflict?: (task: Task) => void; }): Promise<Task> {
    // U8/R6: apply the reviewLevel creation-time preset (maps level -> enabledWorkflowSteps; explicit wins).
    input = applyReviewLevelPreset(input);
    // FNXC:RuntimeTaskOrchestrationAsync 2026-06-24-13:10:
    // Backend-mode createTask: delegates to createTaskBackend which uses the
    // async DistributedTaskIdAllocator (now wired for backend mode) and the
    // async insert helper (insertTaskRowInTransaction) to persist the task row
    // against PostgreSQL. The file-system operations (PROMPT.md, task.json)
    // remain the same. The allocator reservation + commit/abort lifecycle is
    // handled by the async allocator against the distributed_task_id tables.
    if (store.backendMode) {
      return store.createTaskBackend(input, options);
    }
    if (!input.description?.trim()) {
      throw new Error("Description is required and cannot be empty");
    }
    if (input.proposalClaimId) {
      ensureSqliteProposalClaimUniqueness(store);
      const existing = (await store.listTasks()).find((task) => task.proposalClaimId === input.proposalClaimId);
      if (existing) {
        options?.onProposalClaimConflict?.(existing);
        return existing;
      }
    }

    const selfDefeatingDep = detectSelfDefeatingDependency(input.title, input.dependencies ?? []);
    if (selfDefeatingDep) {
      throw new SelfDefeatingDependencyError(
        input.title?.trim() ?? "",
        selfDefeatingDep.matchedVerb,
        selfDefeatingDep.operandTaskId,
      );
    }

    let resolvedSettings = options?.settings;
    if (!resolvedSettings) {
      try {
        resolvedSettings = await store.getSettings();
      } catch {
        resolvedSettings = {};
      }
    }

    let onSummarize = options?.onSummarize;
    if (!onSummarize && (resolvedSettings?.autoSummarizeTitles === true || input.summarize === true)) {
      // Resolve a store-managed summarizer whenever title summarization is explicitly
      // requested on this create call (agent tools set `summarize: true`) or globally
      // enabled via autoSummarizeTitles. The title-summarizer model lanes MOVED to
      // workflow settings (U4/KTD-7).
      // At task-creation time there is no task/workflow yet, so resolve the
      // project DEFAULT workflow's effective settings (unset default normalizes to
      // builtin:coding) and overlay them so the moved lane reads from its new home;
      // the global `titleSummarizerGlobal*` lane in `resolvedSettings` remains the
      // fallback below.
      let summarizerSettings: Partial<Settings> = resolvedSettings ?? {};
      try {
        const defaultWorkflowId = (await store.getDefaultWorkflowId()) ?? "builtin:coding";
        const effective = await resolveEffectiveSettingsById(
          store,
          defaultWorkflowId,
          store.getWorkflowSettingsProjectId(),
        );
        summarizerSettings = { ...summarizerSettings, ...(effective as Partial<Settings>) };
      } catch {
        // Never-throw: fall back to the base settings (global lane only).
      }
      const summarizerModel = resolveTitleSummarizerSettingsModel(summarizerSettings);
      if (summarizerModel.provider && summarizerModel.modelId) {
        onSummarize = async (description: string) => {
          try {
            return await summarizeTitle(
              description,
              store.getRootDir(),
              summarizerModel.provider,
              summarizerModel.modelId,
            );
          } catch {
            return null;
          }
        };
      }
    }

    // Determine if we should try to summarize the title
    const title = input.title?.trim() || undefined;
    const shouldSummarize =
      !title &&
      input.description.length > 200 &&
      (input.summarize === true || resolvedSettings?.autoSummarizeTitles === true);
    const hasPendingSummarization = shouldSummarize && typeof onSummarize === "function";
    const shouldInvokeTaskCreatedHook = options?.invokeTaskCreatedHook !== false;

    // Determine enabledWorkflowSteps: explicit input takes precedence, otherwise auto-apply default-on steps
    let resolvedWorkflowSteps: string[] | undefined = input.enabledWorkflowSteps?.length
      ? await store.resolveEnabledWorkflowSteps(
          input.enabledWorkflowSteps,
          await store.optionalGroupIdSet(input.workflowId),
        )
      : undefined;

    // When a project default workflow is configured, new tasks inherit it
    // (compiled to steps) ahead of the legacy default-on step behavior.
    let pendingWorkflowSelection: { workflowId: string; stepIds: string[] } | undefined;
    let resolvedEntryColumn: string | undefined;
    // U6/R3/KTD-4: an explicit create-time workflowId beats the project default.
    // `null` is an explicit opt-out (no workflow), `string` materializes that
    // workflow, `undefined` falls through to the default-workflow behavior below.
    // Explicit enabledWorkflowSteps still wins over workflowId for trusted callers.
    /*
    FNXC:WorkflowCreation 2026-07-05-14:30:
    User-facing task creation can submit a selected workflowId and optional-group
    toggles together. The visible workflow selection is operator intent and must
    persist as task_workflow_selection; enabledWorkflowSteps only overrides that
    workflow's default optional-group seed. Mirrors the SQLite-path fix
    (FNXC:WorkflowCreation 2026-06-28-23:09) that these PostgreSQL-cutover copies
    predated: previously a create submitting BOTH workflowId and
    enabledWorkflowSteps silently skipped the selection row.
    */
    const explicitWorkflowId = input.workflowId;
    if (explicitWorkflowId !== undefined) {
      if (explicitWorkflowId === null) {
        // Explicit "No workflow": skip default materialization entirely.
        resolvedWorkflowSteps = undefined;
      } else {
        // Compile + materialize up front so unknown/fragment ids throw BEFORE
        // the task row is created (no orphaned steps, no half-created task).
        const selected = await store.materializeExplicitWorkflowSteps(explicitWorkflowId);
        const explicitStepIds = input.enabledWorkflowSteps !== undefined
          ? (resolvedWorkflowSteps ?? [])
          : undefined;
        resolvedWorkflowSteps = explicitStepIds ?? selected.stepIds;
        resolvedEntryColumn = selected.entryColumnId;
        pendingWorkflowSelection = {
          workflowId: selected.workflowId,
          stepIds: explicitStepIds ?? selected.stepIds,
        };
      }
    } else if (input.enabledWorkflowSteps === undefined) {
      try {
        const inherited = await store.materializeDefaultWorkflowSteps();
        if (inherited) {
          resolvedWorkflowSteps = inherited.stepIds;
          resolvedEntryColumn = inherited.entryColumnId;
          pendingWorkflowSelection = inherited;
        }
      } catch (err) {
        storeLog.warn("Failed to apply default workflow during task creation; falling back to default-on steps", {
          phase: "createTask:default-workflow",
          error: err instanceof Error ? err.message : String(err),
        });
      }

      if (resolvedWorkflowSteps === undefined) {
        try {
          const allSteps = await store.listWorkflowSteps();
          const defaultOnSteps = allSteps
            .filter((ws) => ws.enabled && ws.defaultOn)
            .map((ws) => ws.id);
          if (defaultOnSteps.length > 0) {
            resolvedWorkflowSteps = defaultOnSteps;
          }
        } catch (err) {
          storeLog.warn("Failed to auto-apply default workflow steps during task creation; auto-defaulting skipped", {
            phase: "createTask:workflow-auto-default",
            skippedAutoDefaulting: true,
            error: err instanceof Error ? err.message : String(err),
            descriptionLength: input.description.length,
          });
        }
      }
    } else if (input.enabledWorkflowSteps.length === 0) {
      // FNXC:WorkflowOptionalSteps 2026-06-29-02:55: an explicit empty
      // optional-step selection must hydrate back as [], not undefined.
      resolvedWorkflowSteps = [];
    }

    let task: Task;
    try {
      task = await store.createTaskWithDistributedReservation(input, {
        createTaskWithId: async (taskId) => {
          await store.assertNoDependencyCycle(taskId, input.dependencies ?? [], "createTask");
          return store._createTaskInternal(
            input,
            title,
            resolvedWorkflowSteps,
            taskId,
            { invokeTaskCreatedHook: shouldInvokeTaskCreatedHook && !hasPendingSummarization, resolvedEntryColumn, onProposalClaimConflict: options?.onProposalClaimConflict },
          );
        },
      });
    } catch (err) {
      // The task row was never created, so any default-workflow steps we
      // materialized above would orphan with no task/selection pointing at them.
      await store.cleanupOrphanedMaterializedSteps(pendingWorkflowSelection?.stepIds);
      if (input.proposalClaimId && isTaskIdConflictError(err)) {
        const existing = (await store.listTasks()).find((candidate) => candidate.proposalClaimId === input.proposalClaimId);
        if (existing) {
          options?.onProposalClaimConflict?.(existing);
          return existing;
        }
      }
      throw err;
    }

    // Record the inherited workflow selection now that the task row exists.
    if (pendingWorkflowSelection) {
      try {
        await store.writeTaskWorkflowSelection(task.id, pendingWorkflowSelection.workflowId, pendingWorkflowSelection.stepIds);
      } catch (err) {
        storeLog.warn("Failed to record inherited workflow selection", {
          taskId: task.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (hasPendingSummarization && shouldInvokeTaskCreatedHook) {
      const id = task.id;
      Promise.resolve().then(async () => {
        try {
          const generatedTitle = await onSummarize!(input.description);
          const sanitizedTitle = sanitizeTitle(generatedTitle);
          if (sanitizedTitle) {
            await store.trackDeferredTaskCreatedWork(async () => {
              if (store.closing) return;
              const currentTask = store.readTaskFromDb(id);
              if (currentTask && !currentTask.title) {
                // FN-5077: normalizeTitleForTaskId may return null for dangling fragments; only persist usable titles.
                const normalizedTitle = normalizeTitleForTaskId(sanitizedTitle, id);
                if (normalizedTitle.title && !store.closing) {
                  await store.updateTask(id, { title: normalizedTitle.title });
                }
              }
            });
          }
        } catch (err) {
          const autoEnabled = resolvedSettings?.autoSummarizeTitles === true;
          const errorMessage = err instanceof Error ? err.message : String(err);
          storeLog.warn(
            `Title summarization failed for task ${id}: ${errorMessage} (desc length: ${input.description.length}, auto-summarize: ${autoEnabled})`,
            {
              taskId: id,
              descriptionLength: input.description.length,
              autoSummarizeEnabled: autoEnabled,
              error: errorMessage,
            },
          );
        }

        await store.trackDeferredTaskCreatedWork(async () => {
          if (store.closing) return;
          let latestTask = task;
          try {
            const refreshed = store.readTaskFromDb(id);
            if (refreshed) latestTask = refreshed;
          } catch {
            // Best-effort refresh; fall back to original task snapshot.
          }

          if (store.closing) return;
          try {
            await store.invokeTaskCreatedHook(latestTask);
          } catch (err) {
            storeLog.warn("Deferred task-created hook failed", {
              taskId: id,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        });
      }).catch((err) => {
        const autoEnabled = resolvedSettings?.autoSummarizeTitles === true;
        storeLog.error("Unexpected title summarization promise-chain failure", {
          taskId: id,
          descriptionLength: input.description.length,
          autoSummarizeEnabled: autoEnabled,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }

    return task;
  }

export async function createTaskWithReservedIdImpl(store: TaskStore, input: TaskCreateInput, options: { taskId: string; createdAt?: string; updatedAt?: string; prompt?: string; applyDefaultWorkflowSteps?: boolean; invokeTaskCreatedHook?: boolean; },): Promise<Task> {
    // U8/R6: apply the reviewLevel creation-time preset (maps level -> enabledWorkflowSteps; explicit wins).
    input = applyReviewLevelPreset(input);
    if (!input.description?.trim()) {
      throw new Error("Description is required and cannot be empty");
    }

    const selfDefeatingDep = detectSelfDefeatingDependency(input.title, input.dependencies ?? []);
    if (selfDefeatingDep) {
      throw new SelfDefeatingDependencyError(
        input.title?.trim() ?? "",
        selfDefeatingDep.matchedVerb,
        selfDefeatingDep.operandTaskId,
      );
    }

    if (input.proposalClaimId) {
      ensureSqliteProposalClaimUniqueness(store);
      const existing = (await store.listTasks()).find((task) => task.proposalClaimId === input.proposalClaimId);
      if (existing) return existing;
    }

    const id = options.taskId.trim();
    if (!id) {
      throw new Error("taskId is required");
    }

    await store.assertNoDependencyCycle(id, input.dependencies ?? [], "createTaskWithReservedId");

    await store.maybeResolveTombstonedTaskId(id, input, "createTask");
    await store.assertTaskIdAvailable(id);

    const title = input.title?.trim() || undefined;
    let resolvedWorkflowSteps: string[] | undefined = input.enabledWorkflowSteps?.length
      ? await store.resolveEnabledWorkflowSteps(
          input.enabledWorkflowSteps,
          await store.optionalGroupIdSet(input.workflowId),
        )
      : undefined;

    let pendingWorkflowSelection: { workflowId: string; stepIds: string[] } | undefined;
    let resolvedEntryColumn: string | undefined;
    // U6/R3/KTD-4: an explicit create-time workflowId beats the project default,
    // mirroring createTask(). `null` is an explicit opt-out, `string` materializes
    // that workflow, `undefined` falls through to the default-workflow behavior.
    // Explicit enabledWorkflowSteps still wins over workflowId for trusted callers.
    /*
    FNXC:WorkflowCreation 2026-07-05-14:30:
    User-facing task creation can submit a selected workflowId and optional-group
    toggles together. The visible workflow selection is operator intent and must
    persist as task_workflow_selection; enabledWorkflowSteps only overrides that
    workflow's default optional-group seed. Mirrors the SQLite-path fix
    (FNXC:WorkflowCreation 2026-06-28-23:09) that these PostgreSQL-cutover copies
    predated: previously a create submitting BOTH workflowId and
    enabledWorkflowSteps silently skipped the selection row.
    */
    const explicitWorkflowId = input.workflowId;
    if (explicitWorkflowId !== undefined) {
      if (explicitWorkflowId === null) {
        // Explicit "No workflow": skip default materialization entirely.
        resolvedWorkflowSteps = undefined;
      } else {
        // Compile + materialize up front so unknown/fragment ids throw BEFORE
        // the task row is created (no orphaned steps, no half-created task).
        const selected = await store.materializeExplicitWorkflowSteps(explicitWorkflowId);
        const explicitStepIds = input.enabledWorkflowSteps !== undefined
          ? (resolvedWorkflowSteps ?? [])
          : undefined;
        resolvedWorkflowSteps = explicitStepIds ?? selected.stepIds;
        resolvedEntryColumn = selected.entryColumnId;
        pendingWorkflowSelection = {
          workflowId: selected.workflowId,
          stepIds: explicitStepIds ?? selected.stepIds,
        };
      }
    } else if (input.enabledWorkflowSteps === undefined && options.applyDefaultWorkflowSteps !== false) {
      // Mirror createTask: a configured project default workflow takes
      // precedence over legacy default-on steps on this creation path too.
      try {
        const inherited = await store.materializeDefaultWorkflowSteps();
        if (inherited) {
          resolvedWorkflowSteps = inherited.stepIds;
          resolvedEntryColumn = inherited.entryColumnId;
          pendingWorkflowSelection = inherited;
        }
      } catch (err) {
        storeLog.warn("Failed to apply default workflow during reserved task creation; falling back to default-on steps", {
          phase: "createTaskWithReservedId:default-workflow",
          error: err instanceof Error ? err.message : String(err),
        });
      }

      if (resolvedWorkflowSteps === undefined) {
        try {
          const allSteps = await store.listWorkflowSteps();
          const defaultOnSteps = allSteps
            .filter((ws) => ws.enabled && ws.defaultOn)
            .map((ws) => ws.id);
          if (defaultOnSteps.length > 0) {
            resolvedWorkflowSteps = defaultOnSteps;
          }
        } catch (err) {
          storeLog.warn("Failed to auto-apply default workflow steps during reserved task creation; auto-defaulting skipped", {
            phase: "createTaskWithReservedId:workflow-auto-default",
            skippedAutoDefaulting: true,
            error: err instanceof Error ? err.message : String(err),
            descriptionLength: input.description.length,
          });
        }
      }
    } else if (Array.isArray(input.enabledWorkflowSteps) && input.enabledWorkflowSteps.length === 0) {
      // FNXC:WorkflowOptionalSteps 2026-06-29-02:55: an explicit empty
      // optional-step selection must hydrate back as [], not undefined.
      resolvedWorkflowSteps = [];
    }

    let createdTask: Task;
    try {
      createdTask = await store._createTaskInternal(input, title, resolvedWorkflowSteps, id, {
        createdAt: options.createdAt,
        updatedAt: options.updatedAt,
        promptOverride: options.prompt,
        invokeTaskCreatedHook: options.invokeTaskCreatedHook,
        resolvedEntryColumn,
      });
    } catch (err) {
      // The task row was never created, so any default-workflow steps we
      // materialized above would orphan with no task/selection pointing at them.
      await store.cleanupOrphanedMaterializedSteps(pendingWorkflowSelection?.stepIds);
      if (input.proposalClaimId && isTaskIdConflictError(err)) {
        const existing = (await store.listTasks()).find((candidate) => candidate.proposalClaimId === input.proposalClaimId);
        if (existing) return existing;
      }
      throw err;
    }

    // Record the inherited workflow selection now that the task row exists.
    if (pendingWorkflowSelection) {
      try {
        await store.writeTaskWorkflowSelection(createdTask.id, pendingWorkflowSelection.workflowId, pendingWorkflowSelection.stepIds);
      } catch (err) {
        storeLog.warn("Failed to record inherited workflow selection", {
          taskId: createdTask.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return createdTask;
  }

export async function _createTaskInternalImpl(store: TaskStore, input: TaskCreateInput, title: string | undefined, resolvedWorkflowSteps: string[] | undefined, id: string, options?: { createdAt?: string; updatedAt?: string; promptOverride?: string; invokeTaskCreatedHook?: boolean; resolvedEntryColumn?: string; onProposalClaimConflict?: (task: Task) => void; },): Promise<Task> {
    const now = options?.createdAt ?? new Date().toISOString();
    // FN-5077: null normalized titles are treated as "no title" and allow standard fallback/summarization behavior.
    const normalizedTitle = normalizeTitleForTaskId(title, id);
    const task: Task = {
      id,
      lineageId: input.lineageId ?? generateTaskLineageId(),
      proposalClaimId: input.proposalClaimId,
      title: normalizedTitle.title ?? undefined,
      description: input.description,
      priority: normalizeTaskPriority(input.priority),
      tokenUsage: input.tokenUsage,
      sourceIssue: input.sourceIssue,
      githubTracking: input.githubTracking,
      gitlabTracking: input.gitlabTracking,
      sourceType: input.source?.sourceType ?? "unknown",
      sourceAgentId: input.source?.sourceAgentId,
      sourceRunId: input.source?.sourceRunId,
      sourceSessionId: input.source?.sourceSessionId,
      sourceMessageId: input.source?.sourceMessageId,
      sourceParentTaskId: input.source?.sourceParentTaskId,
      sourceMetadata: withTaskBranchContextInSourceMetadata(input.source?.sourceMetadata, input.branchContext),
      branchContext: input.branchContext,
      autoMerge: input.autoMerge,
      autoMergeProvenance: input.autoMerge === undefined ? undefined : "user",
      // FNXC:CodingIdeasWorkflow 2026-07-05-19:45: land the task in its
      // workflow's manual intake column (e.g. Coding (Ideas) → "ideas") when
      // no explicit column is given (main FN-7591 parity).
      column: input.column || options?.resolvedEntryColumn || "triage",
      dependencies: input.dependencies || [],
      breakIntoSubtasks: input.breakIntoSubtasks === true ? true : undefined,
      noCommitsExpected: input.noCommitsExpected === true ? true : undefined,
      enabledWorkflowSteps: resolvedWorkflowSteps,
      modelPresetId: input.modelPresetId,
      assignedAgentId: input.assignedAgentId,
      assigneeUserId: input.assigneeUserId,
      scopeOverride: input.scopeOverride === true ? true : undefined,
      scopeOverrideReason: input.scopeOverrideReason,
      nodeId: input.nodeId,
      modelProvider: input.modelProvider,
      modelId: input.modelId,
      validatorModelProvider: input.validatorModelProvider,
      validatorModelId: input.validatorModelId,
      planningModelProvider: input.planningModelProvider,
      planningModelId: input.planningModelId,
      mergerModelProvider: input.mergerModelProvider,
      mergerModelId: input.mergerModelId,
      thinkingLevel: input.thinkingLevel,
      validatorThinkingLevel: input.validatorThinkingLevel,
      planningThinkingLevel: input.planningThinkingLevel,
      mergerThinkingLevel: input.mergerThinkingLevel,
      reviewLevel: input.reviewLevel,
      executionMode: input.executionMode,
      // FNXC:PlannerOversight 2026-07-14-18:11: only set when create input is explicit boolean.
      sessionAdvisorEnabled: typeof input.sessionAdvisorEnabled === "boolean" ? input.sessionAdvisorEnabled : undefined,
      baseBranch: input.baseBranch,
      branch: input.branch,
      missionId: input.missionId,
      sliceId: input.sliceId,
      steps: [],
      currentStep: 0,
      log: [{ timestamp: now, action: "Task created" }],
      columnMovedAt: now,
      createdAt: now,
      updatedAt: options?.updatedAt ?? now,
    };

    if (normalizedTitle.changed) {
      task.log.push({
        timestamp: now,
        action: "Title normalized: stripped legacy task-id reference",
      });
      const removed = extractTaskIdTokens(title ?? "").filter((token) => token !== id.toUpperCase());
      storeLog.log(`[title-id-drift] normalized title for ${id}: removed=[${removed.join(",")}]`);
    }

    await store.maybeResolveTombstonedTaskId(id, input, "createTask");
    await store.assertTaskIdAvailable(id);

    const dir = store.taskDir(id);
    await store.atomicCreateTaskJson(dir, task, "createTask");

    // Update cache if watcher is active
    if (store.isWatching) store.taskCache.set(id, { ...task });

    /*
    FNXC:CodingIdeasWorkflow 2026-07-05-19:45:
    A freshly created task needs the bootstrap stub only when it lands in a
    column the triage service will plan from — the legacy "triage" intake or a
    workflow's resolved manual intake (e.g. Coding (Ideas) → "ideas"). Direct
    creates into other columns keep generateSpecifiedPrompt (main parity).
    */
    const isIntakeColumn = task.column === "triage"
      || (options?.resolvedEntryColumn !== undefined && task.column === options.resolvedEntryColumn);
    const prompt = options?.promptOverride
      ?? (isIntakeColumn
        ? buildBootstrapPrompt(id, task.title, task.description)
        : store.generateSpecifiedPrompt(task));
    const validation = validateFileScopeInPromptContent(prompt);
    if (validation.invalid.length > 0) {
      if (store.isWatching) store.taskCache.delete(id);
      store.deleteTaskById(id);
      const { rm } = await import("node:fs/promises");
      if (existsSync(dir)) {
        await rm(dir, { recursive: true, force: true });
      }
      throw new InvalidFileScopeError(id, validation.invalid);
    }
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "PROMPT.md"), prompt);

    await store._maybeAutoArchiveSameAgentDuplicate(task, input);

    store.emitTaskLifecycleEventSafely("task:created", [task]);
    if (options?.invokeTaskCreatedHook !== false) {
      await store.invokeTaskCreatedHook(task);
    }
    return task;
  }

export async function _maybeAutoArchiveSameAgentDuplicateImpl(store: TaskStore, task: Task, input: TaskCreateInput): Promise<void> {
    const sourceAgentId = task.sourceAgentId ?? null;
    const sourceParentTaskId = task.sourceParentTaskId ?? null;
    // Need at least one provenance handle to scope the dedup check.
    if (!sourceAgentId && !sourceParentTaskId) return;

    try {
      const nowMs = Date.now();
      const recent = (await store.listTasks({ slim: true, includeArchived: false })).filter((candidate) => {
        if (candidate.id === task.id) return false;
        const createdMs = Date.parse(candidate.createdAt);
        if (Number.isNaN(createdMs)) return false;
        if (createdMs < nowMs - 24 * 60 * 60 * 1000) return false;
        const agentMatch = sourceAgentId != null && candidate.sourceAgentId === sourceAgentId;
        const parentMatch = sourceParentTaskId != null && candidate.sourceParentTaskId === sourceParentTaskId;
        return agentMatch || parentMatch;
      });

      const settings = await store.getSettings();
      const stickyWindowDays = Math.max(0, settings.tombstoneStickyWindowDays ?? 7);
      let tombstonedCandidates: Array<{
        id: string;
        title: string | null;
        description: string;
        column: Column;
        createdAt: string;
        sourceAgentId: string | null;
        deletedAt: string;
        allowResurrection: number | null;
      }> = [];

      if (stickyWindowDays > 0) {
        try {
          const cutoffIso = new Date(nowMs - stickyWindowDays * 24 * 60 * 60 * 1000).toISOString();
          tombstonedCandidates = store.db.prepare(`
            SELECT id, title, description, "column", createdAt, sourceAgentId, deletedAt, allowResurrection
              FROM tasks
             WHERE deletedAt IS NOT NULL
               AND deletedAt >= ?
               AND sourceAgentId = ?
               AND id != ?
          `).all(cutoffIso, sourceAgentId, task.id) as typeof tombstonedCandidates;
        } catch (error) {
          storeLog.warn(`FN-5233 tombstone candidate widening failed open for ${task.id}: ${getErrorMessage(error)}`);
        }
      }

      const matches = findSameAgentDuplicates(
        {
          title: input.title ?? task.title,
          description: input.description,
          sourceParentTaskId,
        },
        [
          ...recent.map((candidate) => ({
            id: candidate.id,
            title: candidate.title ?? "",
            description: candidate.description,
            column: candidate.column,
            createdAt: Date.parse(candidate.createdAt),
            sourceAgentId: candidate.sourceAgentId ?? null,
            sourceParentTaskId: candidate.sourceParentTaskId ?? null,
            tombstoned: false,
          })),
          ...tombstonedCandidates.map((candidate) => ({
            id: candidate.id,
            title: candidate.title ?? "",
            description: candidate.description,
            column: "todo",
            createdAt: Date.parse(candidate.createdAt),
            sourceAgentId: candidate.sourceAgentId,
            sourceParentTaskId: null,
            tombstoned: true,
            deletedAt: candidate.deletedAt,
            allowResurrection: candidate.allowResurrection === 1,
          })),
        ],
        { nowMs, sourceAgentId },
      );

      if (matches.length === 0) return;

      const tombstonedMatch = matches.find((match) => match.tombstoned && match.allowResurrection !== true);
      if (tombstonedMatch?.deletedAt) {
        store.insertRunAuditEventRow({
          taskId: task.id,
          domain: "database",
          mutationType: "intake:resurrection-blocked",
          target: task.id,
          metadata: {
            matchedTaskId: tombstonedMatch.id,
            score: tombstonedMatch.score,
            tombstoneDeletedAt: tombstonedMatch.deletedAt,
            stickyWindowDays,
          },
        });
        if (store.isWatching) store.taskCache.delete(task.id);
        store.deleteTaskById(task.id);
        const { rm } = await import("node:fs/promises");
        const taskDir = store.taskDir(task.id);
        if (existsSync(taskDir)) {
          await rm(taskDir, { recursive: true, force: true });
        }
        throw new TombstonedTaskResurrectionError(
          tombstonedMatch.id,
          tombstonedMatch.deletedAt,
          tombstonedMatch.allowResurrection === true,
        );
      }

      const siblingTaskIds = matches.filter((match) => !match.tombstoned).map((match) => match.id);
      if (siblingTaskIds.length === 0) return;
      const scores = Object.fromEntries(matches.filter((match) => !match.tombstoned).map((match) => [match.id, match.score]));
      /*
      FNXC:DuplicateIntake 2026-07-07-00:00 (FN-7658):
      Operators do not want same-agent duplicates silently vanishing into `archived`
      during intake. Default (`autoArchiveDuplicateTasksEnabled` falsey) flags the
      duplicate in place via the near-duplicate marker so a human decides (Keep/Archive
      chip). Only an explicit `true` restores the pre-FN-7658 auto-archive behavior.
      NOTE: the tombstone-resurrection block above (`TombstonedTaskResurrectionError`)
      is a distinct safety mechanism and is intentionally NOT gated by this setting —
      it always fires regardless of `autoArchiveDuplicateTasksEnabled`.
      */
      if (settings.autoArchiveDuplicateTasksEnabled === true) {
        await archiveAsSameAgentDuplicate(store, task.id, siblingTaskIds, scores);
        task.column = "archived";
      } else {
        const appliedPatch = await flagSameAgentDuplicate(store, task.id, siblingTaskIds, scores);
        if (appliedPatch) {
          task.sourceMetadata = { ...(task.sourceMetadata ?? {}), ...appliedPatch };
        }
      }
    } catch (error) {
      if (error instanceof TombstonedTaskResurrectionError) {
        throw error;
      }
      storeLog.warn(`FN-4892 same-agent duplicate intake failed open for ${task.id}: ${getErrorMessage(error)}`);
    }
  }
