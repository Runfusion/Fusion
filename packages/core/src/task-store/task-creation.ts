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
import {and, eq, inArray, isNull, sql} from "drizzle-orm";
import {mkdir, readFile, rename, rm} from "node:fs/promises";
import {join} from "node:path";
import {existsSync} from "node:fs";
import {randomUUID} from "node:crypto";
import type {Task, TaskCreateInput, Settings} from "../types.js";
import "../builtin-traits.js";
import {applyReviewLevelPreset} from "../tasks/review-level-preset.js";
import {normalizeTaskPriority} from "../tasks/task-priority.js";
import {sanitizeTitle, summarizeTitle} from "../ai/ai-summarize.js";
import {resolveTaskOutputLanguage} from "../ai/ai-output-language.js";
import {extractTaskIdTokens, normalizeTitleForTaskId} from "../tasks/task-title-id-drift.js";
import {resolveTitleSummarizerSettingsModel} from "../ai/model-resolution.js";
import {resolveEffectiveSettingsById} from "../workflows/workflow-settings-resolver.js";
import {getErrorMessage} from "../process/error-message.js";
import {generateTaskLineageId} from "../tasks/task-lineage.js";
import {findSameAgentDuplicates, flagSameAgentDuplicate, type SameAgentDuplicateCandidate} from "../duplicates/duplicate-intake.js";
import {buildBootstrapPrompt} from "../mesh/mesh-task-replication.js";
import {resolveWorkflowIrById, resolveWorkflowIrForTask} from "../workflows/workflow-ir-resolver.js";
import {resolveTaskLifecycleColumns, toTaskMoveLanes} from "../workflows/workflow-lifecycle-traits.js";
import type {WorkflowIr} from "../workflows/workflow-ir-types.js";
import {DEFAULT_WORKFLOW_ID, getBuiltinWorkflow, isBuiltinWorkflowId} from "../workflows/builtin-workflows.js";
import {columnsWithFlag} from "../workflows/workflow-lifecycle-traits.js";
import {validateFileScopeInPromptContent} from "../task-store/file-scope.js";
import {__setTaskActivityLogLimitsForTesting, rewriteHeadingLine} from "../task-store/comments.js";
import {withTaskBranchContextInSourceMetadata} from "../task-store/branch-context.js";
import {resolveCreateDeclaredSymbols} from "../tasks/task-symbol-resolution.js";
import {softDeleteTaskRow as softDeleteTaskRowAsync, insertTaskRowInTransaction, isTaskIdConflictError} from "../task-store/async/async-persistence.js";
import {recordRunAuditEvent as recordRunAuditEventAsync} from "../task-store/async/async-audit.js";
import {projectScopeFor, recordRunAuditEventWithinTransaction, taskProjectScope} from "../postgres/data-layer.js";
import {withTaskWorkflowSerialization} from "./async/async-workflow-workitems.js";
import * as schema from "../postgres/schema/index.js";
import type {DbTransaction} from "../postgres/data-layer.js";
import { resolveTaskPrefix } from "./task-prefix.js";
import {assertValidProviderInstanceId} from "../provider-instance.js";
import {writePromptFileAtomic} from "./prompt-file.js";
import {BranchWriteProvenanceError, validateTaskBranchName} from "../branch/branch-assignment.js";
import {loadWorkspaceConfig} from "../git/git-repository.js";
import {
  getInternalIntakeOwnershipExemptionReason,
  resolveTaskIntakeOwner,
  type IntakeOwnershipExemption,
} from "../tasks/task-intake-owner-resolver.js";

/*
FNXC:BranchNaming 2026-08-20-03:40:
Creation is a branch-write boundary too: require an explicit origin so ownership is
never inferred from a prefix, and preserve an operator's `fusion/...` branch marker.
*/
function normalizeCreateBranchProvenance(input: TaskCreateInput): TaskCreateInput {
  if (input.branch === undefined) return input;
  if (input.branchWriteOrigin !== "operator" && input.branchWriteOrigin !== "engine") {
    throw new BranchWriteProvenanceError();
  }
  validateTaskBranchName(input.branch);
  if (input.branchWriteOrigin === "operator") {
    const existing = input.branchContext?.branchOverride;
    if (existing?.branch === input.branch) return input;
    return {
      ...input,
      branchContext: {
        ...(input.branchContext ?? {}),
        branchOverride: {by: "operator", at: new Date().toISOString(), branch: input.branch},
      },
    };
  }
  const {branchOverride: _override, ...branchContext} = input.branchContext ?? {};
  return {...input, branchContext: Object.keys(branchContext).length > 0 ? branchContext : undefined};
}

/*
FNXC:RepositoryScope 2026-08-29-08:50:
FN-258 gives every workspace task the complete configured repository set at creation. The workspace
configuration, rather than a task description or caller input, confirms that scope so subsequent
acquisition, review, and landing share one unambiguous membership snapshot.
*/
async function resolveInitialRepositoryScope(store: TaskStore, now: string): Promise<Task["repositoryScope"]> {
  const repositories = [...new Set(((await loadWorkspaceConfig(store.getRootDir()))?.repos ?? [])
    .map((repo) => repo.trim())
    .filter(Boolean))].sort();
  if (repositories.length === 0) return undefined;
  return {
    repositories,
    state: "confirmed",
    revision: 1,
    confirmedAt: now,
    confirmedBy: "workspace",
  };
}

type CreateTaskWithAfterInsert = TaskCreateInput & {
  /** Internal transaction hook; never persisted in task source metadata. */
  afterTaskInsert?: (tx: DbTransaction, task: Task) => Promise<void>;
  /**
   * Internal bootstrap escape hatch. The caller supplies an equivalent
   * transactionally-safe duplicate reconciliation after the feature claim.
   */
  skipSameAgentDuplicateIntake?: boolean;
};

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
/*
FNXC:MergedPlanningColumn 2026-07-31-22:30 (missed creation surfaces):
Exported so refine (`update-task-deps.ts`) and duplicate (`project-store-ops.ts`) resolve the same
intake lane as the main create. Both built Task rows directly inside `createTaskWithId` callbacks
with a hardcoded `column: "triage"` — a column the merged coding workflow no longer declares — so a
refined/duplicated card landed in an UNDECLARED column: rendered with the legacy amber badge,
invisible to trait-driven sweeps until the undeclared-column re-home rescued it. #2589/#2603 fixed
the main create; these two surfaces were the enumeration gap (found via a two-tone Planning badge on
the live board).
*/
export async function resolveWorkflowIntakeFacts(
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

/*
FNXC:TitleSummarization 2026-08-19-14:29:
The deferred writer uses a fast preflight read for the common deleted/already-titled case, but the
PostgreSQL UPDATE predicate is the authority. A title supplied by another process after that read
must make the generated write a no-op rather than being overwritten by a later full-row update.
*/
async function persistDeferredTaskTitleIfUntitled(
  store: TaskStore,
  taskId: string,
  title: string,
): Promise<boolean> {
  const observed = await store.getTask(taskId).catch(() => undefined);
  if (!observed || observed.title?.trim()) return false;

  const layer = store.asyncLayer!;
  const updated = await layer.transactionImmediate(async (tx) => {
    const scope = taskProjectScope(layer);
    const conditions = [
      eq(schema.project.tasks.id, taskId),
      isNull(schema.project.tasks.deletedAt),
      sql`btrim(coalesce(${schema.project.tasks.title}, '')) = ''`,
      ...(scope ? [scope] : []),
    ];
    const [row] = await tx
      .update(schema.project.tasks)
      .set({ title, updatedAt: new Date().toISOString() })
      .where(and(...conditions))
      .returning();
    return row ? store.rowToTask(store.pgRowToTaskRow(row)) : undefined;
  });

  if (!updated) return false;
  await store.writeTaskJsonFile(store.taskDir(taskId), updated);
  if (store.isWatching) store.taskCache.set(taskId, { ...updated });

  // FNXC:TitleSummarization 2026-08-19-14:29: Keep the operator-visible prompt heading aligned without a second title mutation.
  try {
    const promptPath = join(store.taskDir(taskId), "PROMPT.md");
    if (existsSync(promptPath)) {
      const existingPrompt = await readFile(promptPath, "utf-8");
      const triageStyle = /^#\s+Task:\s+[A-Z]+-\d+\s+-\s+/m.test(existingPrompt);
      const heading = triageStyle
        ? `Task: ${updated.id} - ${updated.title}`
        : `${updated.id}: ${updated.title}`;
      const nextPrompt = rewriteHeadingLine(existingPrompt, heading);
      if (nextPrompt !== existingPrompt) await writePromptFileAtomic(promptPath, nextPrompt);
    }
  } catch (err) {
    storeLog.warn(`[title-summarization] failed to sync PROMPT.md heading for ${taskId}`, {
      taskId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  store.emitTaskLifecycleEventSafely("task:updated", [updated]);
  return true;
}

export async function createTaskBackendImpl(store: TaskStore, input: TaskCreateInput, options?: {
 onSummarize?: (description: string) => Promise<string | null>; settings?: { autoSummarizeTitles?: boolean }; invokeTaskCreatedHook?: boolean; onProposalClaimConflict?: (task: Task) => void; ownershipExemption?: IntakeOwnershipExemption; },): Promise<Task> {
  /* FNXC:CredentialInstanceSelection 2026-08-01-05:43: validate task authoring input before persistence; ids are stored but runtime credential resolution remains unchanged. */
  input = normalizeCreateBranchProvenance(input);
  for (const key of ["credentialInstanceId", "validatorCredentialInstanceId", "planningCredentialInstanceId", "mergerCredentialInstanceId"] as const) {
    const value = (input as unknown as Record<string, unknown>)[key];
    if (value !== undefined && value !== null) assertValidProviderInstanceId(value);
  }

    // U8/R6: apply the reviewLevel creation-time preset (maps level -> enabledWorkflowSteps; explicit wins).
    input = applyReviewLevelPreset(input);
    if (!input.description?.trim()) {
      throw new Error("Description is required and cannot be empty");
    }

    /*
    FNXC:IntakeOwnership 2026-08-09-18:57:
    A proposal-claim replay is an idempotent read of its canonical row, not a
    new intake. Return before workflow or owner resolution so a later invalid
    assignee, unavailable agent backend, or changed executor pool cannot turn a
    successful prior proposal into a failed retry or emit a second owner signal.
    */
    if (input.proposalClaimId) {
      const existing = await store.findTaskByProposalClaimId(input.proposalClaimId);
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
      /* FNXC:TaskOutputLanguage 2026-08-19-14:56: Capture the target before the deferred title call; its late writer must not observe a later settings change. */
      const titleLanguageTarget = resolveTaskOutputLanguage(summarizerSettings, input.description);
      if (summarizerModel.provider && summarizerModel.modelId) {
        onSummarize = async (description: string) => {
          try {
            return await summarizeTitle(
              description,
              store.getRootDir(),
              summarizerModel.provider,
              summarizerModel.modelId,
              titleLanguageTarget,
            );
          } catch {
            return null;
          }
        };
      }
    }

    const title = input.title?.trim() || undefined;
    /*
    FNXC:TitleSummarization 2026-08-19-13:43:
    The project-scoped autoSummarizeTitles snapshot is the sole automatic eligibility policy.
    Do not reintroduce a description-length branch: every non-empty untitled create follows the
    same setting, while summarize:true remains an explicit per-create force request.
    */
    const shouldSummarize =
      !title &&
      input.description.trim().length > 0 &&
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
        try {
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
        } catch {
          /*
          FNXC:IntakeOwnership 2026-08-09-19:51:
          Explicit workflow materialization is an optimization, not a second ownership authority.
          Let the one shared pre-insert boundary compile this id and return its typed
          `workflow-unresolvable` rejection, preserving a zero-row create failure for both gateways.
          */
        }
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
    // FNXC:MissionTaskPrefix 2026-07-26-12:00: backend task creation must honor the transient mission prefix hint before project settings and the KB fallback.
    const prefix = resolveTaskPrefix(input.taskPrefix, settings.taskPrefix, "KB");
    const nodeId = await store.resolveLocalNodeIdForTaskAllocation();
    const reservation = await allocator.reserveDistributedTaskId({
      prefix,
      nodeId,
    });

    let task: Task;
    let insertedTask = false;
    try {
      await store.assertNoDependencyCycle(reservation.taskId, input.dependencies ?? [], "createTask");
      task = await store._createTaskInternalBackend(
        input,
        title,
        resolvedWorkflowSteps,
        reservation.taskId,
        {
          deferTaskCreatedEvent: true,
          invokeTaskCreatedHook: shouldInvokeTaskCreatedHook && !hasPendingSummarization,
          onProposalClaimConflict: options?.onProposalClaimConflict,
          onTaskInserted: () => { insertedTask = true; },
          resolvedEntryColumn,
          resolvedWorkflowIdForOwnership: pendingWorkflowSelection?.workflowId,
          ownershipExemption: options?.ownershipExemption,
        },
      );
      if (!insertedTask) {
        /*
        FNXC:IntakeOwnership 2026-08-09-20:04:
        A concurrent proposal-claim winner returns its canonical task through the
        shared boundary. Abort this attempt's unused distributed ID and discard
        its unreferenced materialized steps; only the winning insertion may
        commit an ID, persist a workflow selection, or publish task:created.
        */
        await allocator.abortDistributedTaskIdReservation({
          reservationId: reservation.reservationId,
          nodeId,
          reason: "failed-create",
        });
        await store.cleanupOrphanedMaterializedSteps(pendingWorkflowSelection?.stepIds);
        return task;
      }
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
      // FNXC:IntakeOwnership 2026-08-09-17:10: Owner resolution can reject after
      // workflow materialization but before insertion. Remove those unreferenced
      // step rows just as the reserved-ID gateway does, so rejected creates leave
      // neither a task nor orphaned workflow state.
      await store.cleanupOrphanedMaterializedSteps(pendingWorkflowSelection?.stepIds);
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

    /*
    FNXC:PlanningModeScheduling 2026-08-03-09:44:
    A task:created listener runs synchronously and is the authoritative wake for triage admission.
    Planning Mode creates through a project-scoped TaskStore, so emitting before the selected
    workflow row exists leaves a custom intake lane indistinguishable from an unknown legacy lane.
    Persist selection first, then publish the resolved lanes through the shared store event; the
    listener only requests its normal poll, preserving pause, dependency, and capacity gates.

    Proposal-claim replays return an existing row from the internal create path. They deliberately
    do not re-emit task:created, so idempotent Planning Mode retries cannot schedule duplicate work.
    */
    if (insertedTask) {
      const lanes = toTaskMoveLanes(await resolveWorkflowIrForTask(store, task.id).catch(() => undefined));
      store.laneCache.set(task.id, lanes);
      store.emitTaskLifecycleEventSafely("task:created", [task, { lanes }]);
      if (shouldInvokeTaskCreatedHook && !hasPendingSummarization) {
        await store.invokeTaskCreatedHook(task);
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
              const normalizedTitle = normalizeTitleForTaskId(sanitizedTitle, id);
              if (normalizedTitle.title && !store.closing) {
                await persistDeferredTaskTitleIfUntitled(store, id, normalizedTitle.title);
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

export class TaskIntakeOwnerResolutionError extends Error {
  readonly code = "task-intake-owner-resolution" as const;
  constructor(readonly reason: "explicit-assignee-ineligible" | "named-execute-binding-unavailable" | "workflow-unresolvable" | "agent-backend-unavailable") {
    super(`Task intake owner resolution failed: ${reason}`);
    this.name = "TaskIntakeOwnerResolutionError";
  }
}

export async function _createTaskInternalBackendImpl(store: TaskStore, input: TaskCreateInput, title: string | undefined, resolvedWorkflowSteps: string[] | undefined, id: string, options?: { createdAt?: string; updatedAt?: string; promptOverride?: string; invokeTaskCreatedHook?: boolean; resolvedEntryColumn?: string; resolvedWorkflowIdForOwnership?: string; onProposalClaimConflict?: (task: Task) => void; deferTaskCreatedEvent?: boolean; onTaskInserted?: (task: Task) => void; ownershipExemption?: IntakeOwnershipExemption; },): Promise<Task> {
    input = normalizeCreateBranchProvenance(input);
    const layer = store.asyncLayer!;
    const now = options?.createdAt ?? new Date().toISOString();
    /*
    FNXC:IntakeOwnership 2026-08-09-08:49:
    This is the sole shared pre-insert boundary for ordinary and reserved-ID creates. `workflowId: null`
    suppresses workflow routing only; it still selects an executor from the pool. Exemption is options-only.

    FNXC:IntakeOwnership 2026-08-09-18:45:
    Options may carry only an opaque in-process exemption capability, never a public string or body field.
    The runtime symbol check below ignores forged payload-shaped values so normal creators cannot silently
    bypass durable executor selection.
    */
    let workflow: WorkflowIr | "no-workflow-context" | "unresolvable";
    /*
    FNXC:IntakeOwnership 2026-08-09-16:28:
    Materialization can canonicalize the selected workflow before the row exists.
    Forward that exact selection so ownership binding and the later selection row
    cannot diverge; public `workflowId: null` remains the pool-only path.
    */
    let effectiveWorkflowIdForOwnership: string | undefined;
    if (input.workflowId === null) {
      workflow = "no-workflow-context";
    } else {
      try {
        const workflowId = options?.resolvedWorkflowIdForOwnership
          ?? input.workflowId
          ?? (await store.getDefaultWorkflowId())
          ?? DEFAULT_WORKFLOW_ID;
        effectiveWorkflowIdForOwnership = workflowId;
        /*
        FNXC:IntakeOwnership 2026-08-09-19:51:
        General workflow readers intentionally fall back to builtin:coding for a missing definition.
        Intake may not turn a client-named missing workflow into an owned default-workflow task, so
        prove the requested definition exists before compiling it at this universal insert boundary.
        */
        const exists = isBuiltinWorkflowId(workflowId)
          ? getBuiltinWorkflow(workflowId) !== undefined
          : (await store.getWorkflowDefinition(workflowId)) !== undefined;
        workflow = exists ? await resolveWorkflowIrById(store, workflowId) : "unresolvable";
      } catch {
        workflow = "unresolvable";
      }
    }
    let agents;
    try {
      /*
      FNXC:IntakeOwnership 2026-08-09-18:04:
      The TaskStore owns this project-scoped reader. Reusing it prevents each intake row
      from opening a fresh durable-agent backend while preserving a visible rejected
      outcome if that backend cannot be constructed or read.
      */
      agents = await store.getIntakeOwnerAgentStore().listAgents();
    } catch {
      agents = undefined;
    }
    // `taskId` is the durable active-session link. It orders equally eligible pool
    // agents without treating a temporary session load as an eligibility failure.
    const activeSessions = new Map(
      (agents ?? []).flatMap((agent) => agent.taskId ? [[agent.id, 1] as const] : []),
    );
    const ownership = resolveTaskIntakeOwner({
      workflow,
      // Runtime callers predating the public type may pass null to mean "no
      // explicit owner". Normalize it to omission so it follows pool/binding
      // resolution rather than becoming an ineligible named assignee.
      explicitAssigneeId: input.assignedAgentId ?? undefined,
      /*
      FNXC:IntakeOwnership 2026-08-11-02:04:
      sourceMetadata.executorRoleOverride is the only create-time role override channel. Explicit operator/tool
      override:true writes it (CLI extension.ts and engine agent-tools.ts), so intake honors the same contract as
      every binding surface without exposing a public create-input opt-out.
      */
      explicitAssigneeRoleOverride: input.source?.sourceMetadata?.executorRoleOverride === true,
      agents,
      enabledWorkflowSteps: resolvedWorkflowSteps,
      activeSessions,
      ownershipExemptionReason: getInternalIntakeOwnershipExemptionReason(options?.ownershipExemption),
      ownModelProvider: input.modelProvider,
      ownModelId: input.modelId,
    });
    if (ownership.status === "rejected") throw new TaskIntakeOwnerResolutionError(ownership.reason);
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
    const repositoryScope = await resolveInitialRepositoryScope(store, now);
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
      // FNXC:SharedBranchMemberHold 2026-08-05-22:50: trusted mission creation
      // preserves policy provenance; operator/API create requests retain user provenance.
      autoMergeProvenance: input.autoMerge === undefined ? undefined : input.autoMergeProvenance ?? "user",
      // FNXC:CodingIdeasWorkflow 2026-07-05-19:45: land the task in its
      // workflow's manual intake column (e.g. Coding (Ideas) → "ideas") when
      // no explicit column is given (main FN-7591 parity).
      column: input.column || options?.resolvedEntryColumn || fallbackIntakeColumn || "triage",
      dependencies: input.dependencies || [],
      noCommitsExpected: input.noCommitsExpected === true ? true : undefined,
      repositoryScope,
      enabledWorkflowSteps: resolvedWorkflowSteps,
      modelPresetId: input.modelPresetId,
      assignedAgentId: ownership.status === "selected" ? ownership.agentId : undefined,
      assigneeUserId: input.assigneeUserId,
      scopeOverride: input.scopeOverride === true ? true : undefined,
      scopeOverrideReason: input.scopeOverrideReason,
      nodeId: input.nodeId,
      modelProvider: input.modelProvider,
      credentialInstanceId: input.credentialInstanceId,
      modelId: input.modelId,
      validatorModelProvider: input.validatorModelProvider,
      validatorCredentialInstanceId: input.validatorCredentialInstanceId,
      validatorModelId: input.validatorModelId,
      planningModelProvider: input.planningModelProvider,
      planningCredentialInstanceId: input.planningCredentialInstanceId,
      planningModelId: input.planningModelId,
      mergerModelProvider: input.mergerModelProvider,
      mergerCredentialInstanceId: input.mergerCredentialInstanceId,
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
      await writePromptFileAtomic(join(stagingDir, "PROMPT.md"), prompt);
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
    const dependencyIds = [...new Set((task.dependencies ?? []).map((dependencyId) => dependencyId.trim()))]
      .filter((dependencyId) => dependencyId.length > 0)
      .sort();
    try {
      await layer.transactionImmediate(async (tx) => {
        /*
        FNXC:DependencyIntegrity 2026-08-20-18:03:
        Creation is a dependency writer too. Lock each normalized prerequisite in deterministic order
        and revalidate its live row in this insertion transaction, so a missing, soft-deleted, or
        concurrently forced-deleted task can never become a durable dependency edge.
        */
        const insertAfterDependencyValidation = async (): Promise<void> => {
          await (store as unknown as { __afterDependencyTargetLocksForTest?: () => void | Promise<void> }).__afterDependencyTargetLocksForTest?.();
          if (dependencyIds.length > 0) {
            const liveDependencies = await tx.select({ id: schema.project.tasks.id })
              .from(schema.project.tasks)
              .where(and(
                projectScopeFor(schema.project.tasks.projectId, layer.projectId),
                isNull(schema.project.tasks.deletedAt),
                inArray(schema.project.tasks.id, dependencyIds),
              ));
            if (liveDependencies.length !== dependencyIds.length) {
              const liveIds = new Set(liveDependencies.map((row) => row.id));
              const missingDependencyId = dependencyIds.find((dependencyId) => !liveIds.has(dependencyId));
              throw new Error(`Dependency task ${missingDependencyId} not found`);
            }
          }
          // FNXC:MultiProjectIsolation 2026-07-10: stamp the bound projectId so the
          // new task row is attributed to (and later filtered under) this project.
          await insertTaskRowInTransaction(tx, task as unknown as Record<string, unknown>, context, layer.projectId);
        };
        const serializeDependencyTargets = async (index: number): Promise<void> => {
          if (index >= dependencyIds.length) return insertAfterDependencyValidation();
          return withTaskWorkflowSerialization(tx, layer.projectId, dependencyIds[index], () =>
            serializeDependencyTargets(index + 1));
        };
        await serializeDependencyTargets(0);
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
        if (ownership.status === "unowned") {
          /*
          FNXC:IntakeOwnership 2026-08-09-09:30:
          The successful no-executor outcome is observable evidence, not a best-effort
          post-insert side effect. Write its audit row in this transaction so an audit
          failure rolls back the null-owner task and its staged artifacts together.
          */
          await recordRunAuditEventWithinTransaction(tx, {
            taskId: task.id, agentId: "system", runId: `store:intake-owner:${task.id}`,
            domain: "database", mutationType: "task:intake-owner-unresolved", target: task.id,
            metadata: { reason: ownership.reason, workflowId: effectiveWorkflowIdForOwnership, source: "intake" },
          });
        }
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
        const existing = await store.findTaskByProposalClaimId(input.proposalClaimId);
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
      // Same-agent duplicate marking is best-effort and uses async project-scoped reads.
      await store._resolveSameAgentDuplicateIntakeBackend(task, input);
    }

    if (!options?.deferTaskCreatedEvent) {
      store.emitTaskLifecycleEventSafely("task:created", [task]);
      if (options?.invokeTaskCreatedHook !== false) {
        await store.invokeTaskCreatedHook(task);
      }
    }
    options?.onTaskInserted?.(task);
    return task;
  }

export async function createTaskImpl(store: TaskStore, input: TaskCreateInput, options?: { onSummarize?: (description: string) => Promise<string | null>; settings?: { autoSummarizeTitles?: boolean }; invokeTaskCreatedHook?: boolean; onProposalClaimConflict?: (task: Task) => void; ownershipExemption?: IntakeOwnershipExemption; }): Promise<Task> {
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

export async function createTaskWithReservedIdImpl(store: TaskStore, input: TaskCreateInput, options: { taskId: string; createdAt?: string; updatedAt?: string; prompt?: string; applyDefaultWorkflowSteps?: boolean; invokeTaskCreatedHook?: boolean; ownershipExemption?: IntakeOwnershipExemption; },): Promise<Task> {
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
      /*
      FNXC:IntakeOwnership 2026-08-09-20:18:
      Reserved-ID creation is PostgreSQL-only. Proposal-claim uniqueness belongs
      to its project-scoped partial index, so this replay read must not touch the
      removed SQLite backend before the shared insert boundary handles a race.
      */
      const existing = await store.findTaskByProposalClaimId(input.proposalClaimId);
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
        try {
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
        } catch {
          /*
          FNXC:IntakeOwnership 2026-08-09-19:51:
          Reserved-ID creation must reach the same typed owner-resolution rejection as ordinary
          creation when an explicit workflow cannot compile; materialization may not bypass it.
          */
        }
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
    let proposalReplay = false;
    try {
      createdTask = await store._createTaskInternal(input, title, resolvedWorkflowSteps, id, {
        createdAt: options.createdAt,
        updatedAt: options.updatedAt,
        promptOverride: options.prompt,
        invokeTaskCreatedHook: options.invokeTaskCreatedHook,
        resolvedEntryColumn,
        resolvedWorkflowIdForOwnership: pendingWorkflowSelection?.workflowId,
        ownershipExemption: options.ownershipExemption,
        onProposalClaimConflict: () => { proposalReplay = true; },
      });
    } catch (err) {
      // The task row was never created, so any default-workflow steps we
      // materialized above would orphan with no task/selection pointing at them.
      await store.cleanupOrphanedMaterializedSteps(pendingWorkflowSelection?.stepIds);
      if (input.proposalClaimId && isTaskIdConflictError(err)) {
        const existing = await store.findTaskByProposalClaimId(input.proposalClaimId);
        if (existing) return existing;
      }
      throw err;
    }

    if (proposalReplay) {
      /*
      FNXC:IntakeOwnership 2026-08-09-20:04:
      The reserved-ID gateway can race after its preflight replay lookup. The
      shared boundary reports the winner through this callback, so never attach
      this loser's materialized selection to the canonical task or leave its
      generated step rows behind.
      */
      await store.cleanupOrphanedMaterializedSteps(pendingWorkflowSelection?.stepIds);
      return createdTask;
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
    input = normalizeCreateBranchProvenance(input);
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
    const repositoryScope = await resolveInitialRepositoryScope(store, now);
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
      // FNXC:SharedBranchMemberHold 2026-08-05-22:50: trusted mission creation
      // preserves policy provenance; operator/API create requests retain user provenance.
      autoMergeProvenance: input.autoMerge === undefined ? undefined : input.autoMergeProvenance ?? "user",
      // FNXC:CodingIdeasWorkflow 2026-07-05-19:45: land the task in its
      // workflow's manual intake column (e.g. Coding (Ideas) → "ideas") when
      // no explicit column is given (main FN-7591 parity).
      column: input.column || options?.resolvedEntryColumn || fallbackIntakeColumn || "triage",
      dependencies: input.dependencies || [],
      noCommitsExpected: input.noCommitsExpected === true ? true : undefined,
      repositoryScope,
      enabledWorkflowSteps: resolvedWorkflowSteps,
      modelPresetId: input.modelPresetId,
      assignedAgentId: input.assignedAgentId,
      assigneeUserId: input.assigneeUserId,
      scopeOverride: input.scopeOverride === true ? true : undefined,
      scopeOverrideReason: input.scopeOverrideReason,
      nodeId: input.nodeId,
      modelProvider: input.modelProvider,
      credentialInstanceId: input.credentialInstanceId,
      modelId: input.modelId,
      validatorModelProvider: input.validatorModelProvider,
      validatorCredentialInstanceId: input.validatorCredentialInstanceId,
      validatorModelId: input.validatorModelId,
      planningModelProvider: input.planningModelProvider,
      planningCredentialInstanceId: input.planningCredentialInstanceId,
      planningModelId: input.planningModelId,
      mergerModelProvider: input.mergerModelProvider,
      mergerCredentialInstanceId: input.mergerCredentialInstanceId,
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
    await writePromptFileAtomic(join(dir, "PROMPT.md"), prompt);

    await store._resolveSameAgentDuplicateIntake(task, input);

    store.emitTaskLifecycleEventSafely("task:created", [task]);
    if (options?.invokeTaskCreatedHook !== false) {
      await store.invokeTaskCreatedHook(task);
    }
    return task;
  }

/*
FNXC:SameAgentDuplicateIntake 2026-07-19-16:24:
FN-8401 requires PostgreSQL backendMode to use the FN-7658 flag-in-place policy,
not its former delete-on-match cleanup. One resolver reads tombstones through internal
historical options, so sticky near-duplicate blocking includes soft-deletes without a
synchronous SQLite dependency.
*/
/*
FNXC:WorkflowLifecycleColumns 2026-07-31-14:20:
Column trait flags for the intake duplicate guard, resolved from the candidates' OWN workflows.

WHY THIS PATH MATTERS MORE THAN THE OTHER TWO. `findSameAgentDuplicates` gained
`columnFlagsByColumnId` so a FINISHED sibling cannot be reused as the canonical for new work, and no
caller passed it. A completed sibling must not become the canonical for new work. The current policy
keeps the new task visible and records near-duplicate metadata; it never deletes or archives the card.

Resolution is scoped to the columns the candidate set actually occupies — a handful of distinct ids,
not one read per card — and shares one IR cache.
*/
async function resolveIntakeDuplicateColumnFlags(
  store: TaskStore,
  candidates: ReadonlyArray<{ id: string; column: string }>,
): Promise<ReadonlyMap<string, { complete?: boolean }>> {
  const byColumn = new Map<string, { complete?: boolean }>();
  const irCache = new Map<string, WorkflowIr>();
  const seenColumns = new Set<string>();
  for (const candidate of candidates) {
    if (seenColumns.has(candidate.column)) continue;
    seenColumns.add(candidate.column);
    const lanes = await resolveTaskLifecycleColumns(store, candidate.id, irCache).catch(() => undefined);
    if (!lanes) continue;
    if (lanes.complete !== undefined) byColumn.set(lanes.complete, { ...byColumn.get(lanes.complete), complete: true });
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
    const allCandidates = await store.listTasksBySourceLineage({ sourceAgentId, sourceParentTaskId });
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
    const appliedPatch = await flagSameAgentDuplicate(store, task.id, siblingTaskIds, scores);
    if (appliedPatch) task.sourceMetadata = { ...(task.sourceMetadata ?? {}), ...appliedPatch };
  } catch (error) {
    if (error instanceof TombstonedTaskResurrectionError) throw error;
    storeLog.warn(`FN-4892 same-agent duplicate intake failed open for ${task.id}: ${getErrorMessage(error)}`);
  }
}

export async function _resolveSameAgentDuplicateIntakeImpl(store: TaskStore, task: Task, input: TaskCreateInput): Promise<void> {
  return resolveSameAgentDuplicateIntake(store, task, input);
}
