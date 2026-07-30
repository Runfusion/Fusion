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
import {mkdir, rename, rm, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {existsSync} from "node:fs";
import {randomUUID} from "node:crypto";
import type {Task, TaskCreateInput, Settings} from "../types.js";
import "../builtin-traits.js";
import {applyReviewLevelPreset} from "../review-level-preset.js";
import {normalizeTaskPriority} from "../task-priority.js";
import {sanitizeTitle, summarizeTitle} from "../ai-summarize.js";
import {extractTaskIdTokens, normalizeTitleForTaskId} from "../task-title-id-drift.js";
import {resolveTitleSummarizerSettingsModel} from "../model-resolution.js";
import {resolveEffectiveSettingsById} from "../workflow-settings-resolver.js";
import {getErrorMessage} from "../error-message.js";
import {generateTaskLineageId} from "../task-lineage.js";
import {archiveAsSameAgentDuplicate, findSameAgentDuplicates, flagSameAgentDuplicate, type SameAgentDuplicateCandidate} from "../duplicate-intake.js";
import {buildBootstrapPrompt} from "../mesh-task-replication.js";
import {resolveWorkflowIrById} from "../workflow-ir-resolver.js";
import {resolveTaskLifecycleColumns} from "../workflow-lifecycle-traits.js";
import type {WorkflowIr} from "../workflow-ir-types.js";
import {DEFAULT_WORKFLOW_ID} from "../builtin-workflows.js";
import {columnsWithFlag} from "../workflow-lifecycle-traits.js";
import {validateFileScopeInPromptContent} from "../task-store/file-scope.js";
import {__setTaskActivityLogLimitsForTesting} from "../task-store/comments.js";
import {withTaskBranchContextInSourceMetadata} from "../task-store/branch-context.js";
import {resolveCreateDeclaredSymbols} from "../task-symbol-resolution.js";
import {softDeleteTaskRow as softDeleteTaskRowAsync, insertTaskRowInTransaction, isTaskIdConflictError} from "../task-store/async-persistence.js";
import {recordRunAuditEvent as recordRunAuditEventAsync} from "../task-store/async-audit.js";
import type {DbTransaction} from "../postgres/data-layer.js";

type CreateTaskWithAfterInsert = TaskCreateInput & {
  /** Internal transaction hook; never persisted in task source metadata. */
  afterTaskInsert?: (tx: DbTransaction, task: Task) => Promise<void>;
  /**
   * Internal bootstrap escape hatch. The caller supplies an equivalent
   * transactionally-safe duplicate reconciliation after the feature claim.
   */
  skipSameAgentDuplicateIntake?: boolean;
};

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


/*
FNXC:MergedPlanningColumn 2026-07-28-12:55 (U11 precondition):
The intake column used to be resolved ONLY as a by-product of materializing workflow steps, so a
create that supplied `enabledWorkflowSteps` without an explicit `workflowId` took neither
materialization branch and fell through to the hard-coded `|| "triage"`. On Coding (Ideas) that
lands the card in a column the workflow does not declare — a phantom lane, today.

U11 makes it the DEFAULT workflow's problem: once `triage` is deleted, every create down this path
lands in an undeclared column AND (because `isIntakeColumn` keys on the same literal) gets
`generateSpecifiedPrompt` instead of the bootstrap seed. Triage admits a card for planning only
when its PROMPT.md reads as a seed, so the card would sit in Planning forever with no log line in
any lane — FN-8587's failure mode, for every new card.

Resolution is deliberately SIDE-EFFECT-FREE: it reads the default workflow's IR and asks which
column carries `intake`. It must not call `materializeDefaultWorkflowSteps`, which persists step
rows the caller explicitly opted out of by supplying its own `enabledWorkflowSteps`.
Unresolvable workflow returns undefined and the caller keeps its existing legacy fallback.
*/
/*
FNXC:MergedPlanningColumn 2026-07-30-10:20 (Phase B — task-creation.ts to zero column literals):
The two facts intake classification actually needs, resolved from the IR instead of compared against
`"triage"`:

  intake   — which column this workflow intakes into
  manual   — whether that intake carries `autoTriage: false`, i.e. an operator must promote the card

`manual` is what the `!== "triage"` comparison was really reaching for. It distinguished
"manual-intake workflow" (Coding (Ideas)) from "the legacy default" by naming the default's column
id — which stops meaning anything once the default's intake IS `todo`. The trait config states it
directly and survives any rename or merge.

Unresolvable workflow returns `{ manual: false }` with no intake, so callers keep their existing
conservative behavior rather than acting on a guess.
*/
async function resolveWorkflowIntakeFacts(
  store: TaskStore,
  workflowIdOverride?: string,
): Promise<{ intake?: string; hold?: string; manual: boolean }> {
  try {
    const workflowId = workflowIdOverride ?? (await store.getDefaultWorkflowId()) ?? DEFAULT_WORKFLOW_ID;
    const ir = await resolveWorkflowIrById(store, workflowId);
    const intake = columnsWithFlag(ir, "intake")[0];
    // The PLANNING column a quick-add Start create lands in — the workflow's hold column, which for
    // a merged Planning lane is the same column as intake and is then excluded by the `!==` below.
    const hold = columnsWithFlag(ir, "hold")[0];
    if (!intake) return { hold, manual: false };
    const declared = (ir as { columns?: Array<{ id: string; traits?: Array<{ trait: string; config?: Record<string, unknown> }> }> })
      .columns?.find((column) => column.id === intake);
    const intakeTrait = declared?.traits?.find((trait) => trait.trait === "intake");
    return { intake, hold, manual: intakeTrait?.config?.autoTriage === false };
  } catch {
    return { manual: false };
  }
}

async function resolveDefaultWorkflowIntakeColumn(store: TaskStore): Promise<string | undefined> {
  try {
    /*
    FNXC:MergedPlanningColumn 2026-07-29-14:40 (U11 post-merge audit):
    Fall back to DEFAULT_WORKFLOW_ID when no default row is persisted. A fresh project has none —
    `builtin:coding` is the IMPLICIT default that every other resolver already uses — so returning
    undefined here sent the create to the hard-coded `"triage"` literal, a column the merged
    default workflow does not declare.
    */
    const workflowId = (await store.getDefaultWorkflowId()) ?? DEFAULT_WORKFLOW_ID;
    const ir = await resolveWorkflowIrById(store, workflowId);
    return columnsWithFlag(ir, "intake")[0];
  } catch {
    return undefined;
  }
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
    } else {
      // Caller supplied its own optional-step toggles, so no materialization branch ran and
      // `resolvedEntryColumn` was left undefined — the gap that dropped the card into the
      // hard-coded `|| "triage"`. The toggles are the caller's; the INTAKE COLUMN is still the
      // project default workflow's, so resolve it without materializing steps.
      resolvedEntryColumn = await resolveDefaultWorkflowIntakeColumn(store);
      if (input.enabledWorkflowSteps.length === 0) {
        // FNXC:WorkflowOptionalSteps 2026-06-29-02:55: an explicit empty
        // optional-step selection must hydrate back as [], not undefined.
        resolvedWorkflowSteps = [];
      }
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
    /*
    FNXC:MergedPlanningColumn 2026-07-29-14:30 (U11 post-merge audit):
    A project that has never explicitly set a default workflow has no persisted default row, so
    `materializeDefaultWorkflowSteps()` returns nothing, `resolvedEntryColumn` stays undefined, and
    the row below fell through to the hard-coded `|| "triage"`. That column no longer exists in the
    default workflow, so the card landed in a lane its own workflow does not declare: triage
    discovery resolves intake BY TRAIT and never admits it, hold-release ignores it, and only
    `reconcileUndeclaredTaskColumns` eventually re-homes it.

    This is the OUT-OF-THE-BOX shape — `builtin:coding` is the IMPLICIT default via
    DEFAULT_WORKFLOW_ID and nothing writes a default-workflow row until an operator picks one — so
    it affected every new task on a fresh project rather than an edge case.

    Resolved side-effect-free and ONLY as a last resort before the literal, so every path that
    already has an explicit column or a resolved entry column is untouched. The literal survives as
    the final fallback for a store that cannot resolve any workflow at all.
    */
    // `workflowId: null` is an explicit "No workflow" opt-out — there is no workflow whose intake
    // column could be resolved, so that path keeps the legacy literal.
    const fallbackIntakeColumn = (input.column || options?.resolvedEntryColumn || input.workflowId === null)
      ? undefined
      : await resolveDefaultWorkflowIntakeColumn(store);
    /* Intake column + whether that intake is MANUAL (autoTriage:false), resolved from the IR. */
    const intakeFacts = input.workflowId === null
      ? { manual: false as boolean, intake: undefined as string | undefined, hold: undefined as string | undefined }
      : await resolveWorkflowIntakeFacts(store, input.workflowId ?? undefined);
    const declaredSymbols = resolveCreateDeclaredSymbols(input, options?.promptOverride);
    const task: Task = {
      id,
      lineageId: input.lineageId ?? generateTaskLineageId(),
      proposalClaimId: input.proposalClaimId,
      title: normalizedTitle.title ?? undefined,
      description: input.description,
      priority: normalizeTaskPriority(input.priority),
      tokenUsage: input.tokenUsage,
      declaredSymbols,
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
      column: input.column || options?.resolvedEntryColumn || fallbackIntakeColumn || "triage",
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
    const stagingDir = `${dir}.creating-${randomUUID()}`;
    let ownsStagingDirectory = false;
    let ownsPromotedTaskDirectory = false;
    const cleanupPreparedTaskFiles = async () => {
      if (store.isWatching) store.taskCache.delete(id);
      if (ownsStagingDirectory && existsSync(stagingDir)) {
        await rm(stagingDir, { recursive: true, force: true });
      }
      // A rollback after promotion removes only this create's final directory.
      // A conflicting existing row never reaches promotion, so its files survive.
      if (ownsPromotedTaskDirectory && existsSync(dir)) {
        await rm(dir, { recursive: true, force: true });
      }
    };

    /*
    FNXC:MissionAdmission 2026-07-23-17:10:
    Materialize task files before the transaction that inserts and claims a
    defined feature. Filesystem writes cannot join PostgreSQL; this ordering
    means a write failure cannot commit a triaged feature pointing at a deleted
    task, while the database transaction still makes task insert + feature claim
    indivisible.
    */
    try {
      /*
      FNXC:MissionAdmission 2026-07-23-19:00:
      PostgreSQL ID/proposal collisions are discovered at row insert, while a
      defined-feature bootstrap needs all task artifacts to be writable before
      its transaction can commit. Materialize into a unique staging directory;
      only the successful insert atomically promotes it to the task directory.
      A losing proposal therefore cannot overwrite its winner's task files.
      */
      await mkdir(stagingDir, { recursive: true });
      ownsStagingDirectory = true;

      // Write task.json for backward compatibility and debugging.
      if (store.isWatching) store.taskCache.set(id, { ...task });
      await store.writeTaskJsonFile(stagingDir, task);

      // Write PROMPT.md (same logic as SQLite path).
      /*
      FNXC:CodingIdeasWorkflow 2026-07-05-19:45:
      A freshly created task needs the bootstrap stub only when it lands in a
      column the triage service will plan from — the legacy "triage" intake or a
      workflow's resolved manual intake (e.g. Coding (Ideas) → "ideas"). Direct
      creates into other columns keep generateSpecifiedPrompt (main parity).
      */
      /*
      FNXC:CodingIdeasWorkflow 2026-07-25-14:20:
      Quick-add "Start" collapses create+promote into ONE request: it submits the workflow id AND
      the post-intake destination column together, so the card lands in `todo` having never sat in
      the workflow's manual intake column. It is still UNPLANNED — nothing has written a spec — but
      the intake test above only matched `triage` or the resolved intake column, so the card got
      `generateSpecifiedPrompt` instead of the bootstrap seed.

      That stranded the card permanently: triage's todo-discovery admits a card only when its
      PROMPT.md reads as a seed, so a placeholder spec is classified "already planned" and never
      planned, while `generateSpecifiedPrompt` emits hard-coded boilerplate steps ("Implement the
      required changes") that no planner ever produced. The card sat in Todo forever with no log
      line in any lane. Observed on FN-8587.

      Guarded to manual-intake workflows (resolved intake is not the legacy `triage`) landing in the
      plan-in-place `todo` column, so the pinned contract for a plain direct create into todo on the
      default workflow — which intentionally keeps generateSpecifiedPrompt — is untouched.
      */
      /*
      FNXC:MergedPlanningColumn 2026-07-30-10:25 (Phase B — task-creation.ts to zero column literals):
      Was `resolvedEntryColumn !== "triage"` — naming the DEFAULT workflow's intake id to mean "this
      workflow has a MANUAL intake". Post-U11 the default's intake IS `todo`, so that comparison
      became vacuously true for the default workflow and the guard stopped distinguishing the two
      shapes it exists to separate.

      The real fact is the intake trait's `autoTriage: false`, and the real shape is "the card landed
      PAST its workflow's manual intake" — which is what quick-add Start does by submitting the
      workflow id and the post-intake column together. Both now come from the IR, so the pinned
      contract for a plain direct create on a default (auto-triage) workflow is preserved by the
      `manual` test rather than by an id coincidence.
      */
      const isUnplannedStartCreate = intakeFacts.manual
        && intakeFacts.intake !== undefined
        && intakeFacts.hold !== undefined
        && task.column !== intakeFacts.intake
        && task.column === intakeFacts.hold;
      /*
      FNXC:MergedPlanningColumn 2026-07-29-14:50 (U11 post-merge audit):
      `fallbackIntakeColumn` must be honoured here too. Without it the card lands in the resolved
      intake column (correct) but is classified NOT-intake and receives `generateSpecifiedPrompt`
      instead of the bootstrap seed — and triage admits a card for planning only when its PROMPT.md
      reads as a seed, so it would sit in Planning already looking "planned". That is FN-8587's
      failure mode, reached by a different route.
      */
      /*
      FNXC:MergedPlanningColumn 2026-07-30-10:25 (Phase B):
      The leading `task.column === "triage"` was the last-resort clause for a card whose workflow
      could not be resolved. `intakeFacts.intake` covers that properly — it falls back to
      DEFAULT_WORKFLOW_ID rather than to a bare id — so the literal is gone and an explicit
      `column: "triage"` create on a workflow that still declares `triage` is matched through the
      resolved intake rather than a coincidence of naming.
      */
      const isIntakeColumn = (intakeFacts.intake !== undefined && task.column === intakeFacts.intake)
        || (options?.resolvedEntryColumn !== undefined && task.column === options.resolvedEntryColumn)
        || (fallbackIntakeColumn !== undefined && task.column === fallbackIntakeColumn)
        || isUnplannedStartCreate;
      const usedBootstrapPrompt = !options?.promptOverride && isIntakeColumn;
      const prompt = options?.promptOverride
        ?? (isIntakeColumn
          ? buildBootstrapPrompt(id, task.title, task.description)
          : store.generateSpecifiedPrompt(task));
      /*
      FNXC:FileScopeClassification 2026-07-21-18:05:
      Bootstrap intake prompts are freeform descriptions (GitHub issue bodies, paste dumps).
      Do not hard-fail create on incidental `## File Scope` tokens in that prose — triage
      will write a real planned PROMPT.md later. Strict validation still applies to
      promptOverride and generateSpecifiedPrompt paths.
      */
      if (!usedBootstrapPrompt) {
        const validation = validateFileScopeInPromptContent(prompt);
        if (validation.invalid.length > 0) {
          throw new InvalidFileScopeError(id, validation.invalid);
        }
      }
      await writeFile(join(stagingDir, "PROMPT.md"), prompt);
    } catch (error) {
      await cleanupPreparedTaskFiles();
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(`Task ID already exists: ${task.id}`);
      }
      throw error;
    }

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
        /*
        FNXC:MissionAdmission 2026-07-23-19:00:
        The row insert establishes this task as the sole winner before its staged
        artifacts replace any stale directory. Promotion remains inside the same
        transaction as the defined-feature claim, so a filesystem or claim
        failure rolls back the row and cleans only this attempt's files.
        */
        if (existsSync(dir)) await rm(dir, { recursive: true, force: true });
        await rename(stagingDir, dir);
        ownsStagingDirectory = false;
        ownsPromotedTaskDirectory = true;
        await (input as CreateTaskWithAfterInsert).afterTaskInsert?.(tx, task);
      });
    } catch (error) {
      await cleanupPreparedTaskFiles();
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

    /*
    FNXC:MissionAdmission 2026-07-23-20:00:
    A defined-feature first task has already claimed feature.taskId in the insert
    transaction. The ordinary same-agent intake may archive that claimed row
    after commit, so this narrow internal opt-out delegates duplicate resolution
    to the bootstrap caller, which preserves the claimed canonical atomically.
    */
    if (!(input as CreateTaskWithAfterInsert).skipSameAgentDuplicateIntake) {
      // Auto-archive dedup (best-effort, same as SQLite path but using async reads).
      await store._maybeAutoArchiveSameAgentDuplicateBackend(task, input);
    }

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
    /* FNXC:SqliteDualPathCleanup 2026-07-26-14:08: createTask is PostgreSQL-only. */
    return store.createTaskBackend(input, options);
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
    } else if (input.enabledWorkflowSteps !== undefined) {
      // Mirror of the backend path: the caller owns the optional-step toggles, so no
      // materialization branch ran and `resolvedEntryColumn` was left undefined. The INTAKE
      // COLUMN is still the project default workflow's — resolve it without materializing steps.
      resolvedEntryColumn = await resolveDefaultWorkflowIntakeColumn(store);
      if (input.enabledWorkflowSteps.length === 0) {
        // FNXC:WorkflowOptionalSteps 2026-06-29-02:55: an explicit empty
        // optional-step selection must hydrate back as [], not undefined.
        resolvedWorkflowSteps = [];
      }
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
    /*
    FNXC:MergedPlanningColumn 2026-07-29-14:30 (U11 post-merge audit):
    A project that has never explicitly set a default workflow has no persisted default row, so
    `materializeDefaultWorkflowSteps()` returns nothing, `resolvedEntryColumn` stays undefined, and
    the row below fell through to the hard-coded `|| "triage"`. That column no longer exists in the
    default workflow, so the card landed in a lane its own workflow does not declare: triage
    discovery resolves intake BY TRAIT and never admits it, hold-release ignores it, and only
    `reconcileUndeclaredTaskColumns` eventually re-homes it.

    This is the OUT-OF-THE-BOX shape — `builtin:coding` is the IMPLICIT default via
    DEFAULT_WORKFLOW_ID and nothing writes a default-workflow row until an operator picks one — so
    it affected every new task on a fresh project rather than an edge case.

    Resolved side-effect-free and ONLY as a last resort before the literal, so every path that
    already has an explicit column or a resolved entry column is untouched. The literal survives as
    the final fallback for a store that cannot resolve any workflow at all.
    */
    // `workflowId: null` is an explicit "No workflow" opt-out — there is no workflow whose intake
    // column could be resolved, so that path keeps the legacy literal.
    const fallbackIntakeColumn = (input.column || options?.resolvedEntryColumn || input.workflowId === null)
      ? undefined
      : await resolveDefaultWorkflowIntakeColumn(store);
    /* Intake column + whether that intake is MANUAL (autoTriage:false), resolved from the IR. */
    const intakeFacts = input.workflowId === null
      ? { manual: false as boolean, intake: undefined as string | undefined, hold: undefined as string | undefined }
      : await resolveWorkflowIntakeFacts(store, input.workflowId ?? undefined);
    const declaredSymbols = resolveCreateDeclaredSymbols(input, options?.promptOverride);
    const task: Task = {
      id,
      lineageId: input.lineageId ?? generateTaskLineageId(),
      proposalClaimId: input.proposalClaimId,
      title: normalizedTitle.title ?? undefined,
      description: input.description,
      priority: normalizeTaskPriority(input.priority),
      tokenUsage: input.tokenUsage,
      declaredSymbols,
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
      column: input.column || options?.resolvedEntryColumn || fallbackIntakeColumn || "triage",
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
    /*
    FNXC:CodingIdeasWorkflow 2026-07-25-14:20:
    Mirror of the backend path above — quick-add "Start" submits workflow id + post-intake column in
    one request, so the card is unplanned despite not landing in the intake column. See the fuller
    rationale there; keeping both copies in step is the whole point (this pair has drifted before).
    */
    /*
      FNXC:MergedPlanningColumn 2026-07-30-10:25 (Phase B — task-creation.ts to zero column literals):
      Was `resolvedEntryColumn !== "triage"` — naming the DEFAULT workflow's intake id to mean "this
      workflow has a MANUAL intake". Post-U11 the default's intake IS `todo`, so that comparison
      became vacuously true for the default workflow and the guard stopped distinguishing the two
      shapes it exists to separate.

      The real fact is the intake trait's `autoTriage: false`, and the real shape is "the card landed
      PAST its workflow's manual intake" — which is what quick-add Start does by submitting the
      workflow id and the post-intake column together. Both now come from the IR, so the pinned
      contract for a plain direct create on a default (auto-triage) workflow is preserved by the
      `manual` test rather than by an id coincidence.
      */
    const isUnplannedStartCreate = intakeFacts.manual
      && intakeFacts.intake !== undefined
      && intakeFacts.hold !== undefined
      && task.column !== intakeFacts.intake
      && task.column === intakeFacts.hold;
    /*
    FNXC:MergedPlanningColumn 2026-07-29-17:15 (PR #2589 review — greptile):
    `fallbackIntakeColumn` must appear here, not only in the `column:` assignment above. Otherwise
    this path lands the card in the resolved intake column and then classifies it NOT-intake,
    writing `generateSpecifiedPrompt` instead of the bootstrap seed — and triage admits a card for
    planning only when its PROMPT.md reads as a seed, so the card would rest in Planning already
    looking "planned" and never be planned.

    HONEST SCOPE: I could not construct a failing test for this through a public API. The only
    in-tree caller of `_createTaskInternal` is `createTaskWithReservedIdImpl`, which passes its own
    `resolvedEntryColumn` through options, so the second disjunct already matches and this path's
    own fallback never decides. The fix is for the DIVERGENCE, which is a latent bug: two copies of
    one predicate that disagree, where the backend copy needed exactly this clause. A direct
    `_createTaskInternal` call — which the signature invites — would hit it.
    */
    /*
    FNXC:MergedPlanningColumn 2026-07-30-10:25 (Phase B):
    The leading `task.column === "triage"` was the last-resort clause for a card whose workflow
    could not be resolved. `intakeFacts.intake` covers that properly — it falls back to
    DEFAULT_WORKFLOW_ID rather than to a bare id — so the literal is gone and an explicit
    `column: "triage"` create on a workflow that still declares `triage` is matched through the
    resolved intake rather than a coincidence of naming.
    */
    const isIntakeColumn = (intakeFacts.intake !== undefined && task.column === intakeFacts.intake)
      || (options?.resolvedEntryColumn !== undefined && task.column === options.resolvedEntryColumn)
      || (fallbackIntakeColumn !== undefined && task.column === fallbackIntakeColumn)
      || isUnplannedStartCreate;
    const usedBootstrapPrompt = !options?.promptOverride && isIntakeColumn;
    const prompt = options?.promptOverride
      ?? (isIntakeColumn
        ? buildBootstrapPrompt(id, task.title, task.description)
        : store.generateSpecifiedPrompt(task));
    /*
    FNXC:FileScopeClassification 2026-07-21-18:05:
    Bootstrap intake prompts are freeform descriptions (GitHub issue bodies, paste dumps).
    Do not hard-fail create on incidental `## File Scope` tokens in that prose — triage
    will write a real planned PROMPT.md later. Strict validation still applies to
    promptOverride and generateSpecifiedPrompt paths.
    */
    if (!usedBootstrapPrompt) {
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

/*
FNXC:SameAgentDuplicateIntake 2026-07-19-16:24:
FN-8401 requires PostgreSQL backendMode to use the FN-7658 flag-in-place policy,
not its former delete-on-match cleanup. One resolver reads tombstones through
listTasks(includeDeleted, includeArchived), so FN-5233 sticky near-duplicate blocking
includes soft-deletes whose delete lifecycle puts them in `archived` on both
persistence backends without a synchronous SQLite dependency.
*/
/*
FNXC:WorkflowLifecycleColumns 2026-07-31-14:20:
Column trait flags for the intake duplicate guard, resolved from the candidates' OWN workflows.

WHY THIS PATH MATTERS MORE THAN THE OTHER TWO. `findSameAgentDuplicates` gained
`columnFlagsByColumnId` so a FINISHED sibling cannot be reused as the canonical for new work, and no
caller passed it. On the agent-tools paths the cost is a bad suggestion. Here it is DESTRUCTIVE: a
match either auto-archives the newly created task or, on the tombstoned branch, soft-deletes it and
removes its directory. So on a renamed board a new task could be archived or deleted as a duplicate
of work that had already finished.

Resolution is scoped to the columns the candidate set actually occupies — a handful of distinct ids,
not one read per card — and shares one IR cache.
*/
async function resolveIntakeDuplicateColumnFlags(
  store: TaskStore,
  candidates: ReadonlyArray<{ id: string; column: string }>,
): Promise<ReadonlyMap<string, { complete?: boolean; archived?: boolean }>> {
  const byColumn = new Map<string, { complete?: boolean; archived?: boolean }>();
  const irCache = new Map<string, WorkflowIr>();
  const seenColumns = new Set<string>();
  for (const candidate of candidates) {
    if (seenColumns.has(candidate.column)) continue;
    seenColumns.add(candidate.column);
    const lanes = await resolveTaskLifecycleColumns(store, candidate.id, irCache).catch(() => undefined);
    if (!lanes) continue;
    if (lanes.complete !== undefined) byColumn.set(lanes.complete, { ...byColumn.get(lanes.complete), complete: true });
    if (lanes.archived !== undefined) byColumn.set(lanes.archived, { ...byColumn.get(lanes.archived), archived: true });
  }
  return byColumn;
}

export async function resolveSameAgentDuplicateIntake(store: TaskStore, task: Task, input: TaskCreateInput): Promise<void> {
  const sourceAgentId = task.sourceAgentId ?? null;
  const sourceParentTaskId = task.sourceParentTaskId ?? null;
  if (!sourceAgentId && !sourceParentTaskId) return;

  try {
    const nowMs = Date.now();
    const settings = await store.getSettings();
    const stickyWindowDays = Math.max(0, settings.tombstoneStickyWindowDays ?? 7);
    const allCandidates = await store.listTasks({ slim: true, includeArchived: true, includeDeleted: true });
    const matches = findSameAgentDuplicates(
      { title: input.title ?? task.title, description: input.description, sourceParentTaskId },
      allCandidates.flatMap<SameAgentDuplicateCandidate>((candidate) => {
        if (candidate.id === task.id) return [];
        const createdAt = Date.parse(candidate.createdAt);
        if (Number.isNaN(createdAt)) return [];
        if (candidate.deletedAt) {
          const deletedAtMs = Date.parse(candidate.deletedAt);
          if (sourceAgentId == null
            || candidate.sourceAgentId !== sourceAgentId
            || Number.isNaN(deletedAtMs)
            || stickyWindowDays <= 0
            || deletedAtMs < nowMs - stickyWindowDays * 24 * 60 * 60 * 1000) return [];
          return [{
            id: candidate.id, title: candidate.title ?? "", description: candidate.description,
            column: candidate.column, createdAt, sourceAgentId: candidate.sourceAgentId ?? null,
            sourceParentTaskId: candidate.sourceParentTaskId ?? null, tombstoned: true,
            deletedAt: candidate.deletedAt, allowResurrection: candidate.allowResurrection === true,
          }];
        }
        const agentMatch = sourceAgentId != null && candidate.sourceAgentId === sourceAgentId;
        const parentMatch = sourceParentTaskId != null && candidate.sourceParentTaskId === sourceParentTaskId;
        if (!agentMatch && !parentMatch) return [];
        return [{
          id: candidate.id, title: candidate.title ?? "", description: candidate.description,
          column: candidate.column, createdAt, sourceAgentId: candidate.sourceAgentId ?? null,
          sourceParentTaskId: candidate.sourceParentTaskId ?? null, tombstoned: false,
        }];
      }),
      { nowMs, sourceAgentId, columnFlagsByColumnId: await resolveIntakeDuplicateColumnFlags(store, allCandidates) },
    );
    if (matches.length === 0) return;

    const tombstonedMatch = matches.find((match) => match.tombstoned && match.allowResurrection !== true);
    if (tombstonedMatch?.deletedAt) {
      const metadata = {
        matchedTaskId: tombstonedMatch.id, score: tombstonedMatch.score,
        tombstoneDeletedAt: tombstonedMatch.deletedAt, stickyWindowDays,
      };
            await recordRunAuditEventAsync(store.asyncLayer!, {
        taskId: task.id, agentId: "system", runId: `store:intake:resurrection-blocked:${task.id}`,
        domain: "database", mutationType: "intake:resurrection-blocked", target: task.id, metadata,
      });
      await softDeleteTaskRowAsync(store.asyncLayer!, task.id, new Date().toISOString());

      if (store.isWatching) store.taskCache.delete(task.id);
      const taskDir = store.taskDir(task.id);
      if (existsSync(taskDir)) await rm(taskDir, { recursive: true, force: true });
      throw new TombstonedTaskResurrectionError(tombstonedMatch.id, tombstonedMatch.deletedAt, false);
    }

    const siblingTaskIds = matches.filter((match) => !match.tombstoned).map((match) => match.id);
    if (siblingTaskIds.length === 0) return;
    const scores = Object.fromEntries(matches.filter((match) => !match.tombstoned).map((match) => [match.id, match.score]));
    if (settings.autoArchiveDuplicateTasksEnabled === true) {
      await archiveAsSameAgentDuplicate(store, task.id, siblingTaskIds, scores);
      /*
      FNXC:WorkflowLifecycleColumns 2026-07-31-14:20:
      Mirror the archive into the in-memory row using the board's OWN archived lane. Writing the
      literal here made the returned object disagree with what the archive actually did on a renamed
      board — the caller then saw a task claiming a column its workflow does not declare, the same
      shape as the `"triage"` write fixed earlier in this program.
      */
      const archivedLane = (await resolveTaskLifecycleColumns(store, task.id).catch(() => undefined))?.archived;
      /* DELIBERATE-LITERAL — the unresolvable-workflow default, reviewed 2026-07-31-14:20. */
      task.column = archivedLane ?? "archived";
    } else {
      const appliedPatch = await flagSameAgentDuplicate(store, task.id, siblingTaskIds, scores);
      if (appliedPatch) task.sourceMetadata = { ...(task.sourceMetadata ?? {}), ...appliedPatch };
    }
  } catch (error) {
    if (error instanceof TombstonedTaskResurrectionError) throw error;
    storeLog.warn(`FN-4892 same-agent duplicate intake failed open for ${task.id}: ${getErrorMessage(error)}`);
  }
}

export async function _maybeAutoArchiveSameAgentDuplicateImpl(store: TaskStore, task: Task, input: TaskCreateInput): Promise<void> {
  return resolveSameAgentDuplicateIntake(store, task, input);
}
