/**
 * task-update operations.
 *
 * FNXC:StoreModularization 2026-06-25-00:00:
 * Extracted from the monolithic packages/core/src/store.ts as a pure
 * behavior-preserving refactor. Each function receives the TaskStore
 * instance as its first parameter and performs byte-identical work.
 */
import {type TaskStore, storeLog} from "../store.js";
import {InvalidFileScopeError} from "./errors.js";
import {mkdir, readFile, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {existsSync} from "node:fs";
import type {Task, Column, TaskLogEntry, RunMutationContext} from "../types.js";
import {validateCustomFieldPatch, CustomFieldRejectionError} from "../task-fields.js";
import "../builtin-traits.js";
import {normalizeTaskPriority} from "../task-priority.js";
import {validateNodeOverrideChange} from "../node-override-guard.js";
import {extractTaskIdTokens, normalizeTitleForTaskId} from "../task-title-id-drift.js";
import {buildBootstrapPrompt} from "../mesh-task-replication.js";
import {validateFileScopeInPromptContent} from "../task-store/file-scope.js";
import {__setTaskActivityLogLimitsForTesting, isBootstrapPromptStub, rewriteHeadingLine, rewriteMissionSection} from "../task-store/comments.js";
import {applyOriginalDescription} from "../original-description-policy.js";
import {normalizeTaskReviewState} from "../task-store/review-state.js";
import {hasOwnDeclaredSymbols, normalizeDeclaredSymbols, extractDeclaredSymbolsFromPrompt, resolveTaskSymbolsForTask} from "../task-symbol-resolution.js";

export async function updateTaskUnlockedImpl(store: TaskStore, id: string, updates: Parameters<TaskStore["updateTask"]>[1], runContext?: RunMutationContext,): Promise<Task> {
    {
      if (updates.dependencies !== undefined) {
        await store.assertNoDependencyCycle(
          id,
          updates.dependencies,
          "updateTask",
          new Map([[id, updates.dependencies]]),
        );
      }

      const dir = store.taskDir(id);
      const task = await store.readTaskJson(dir);
      const wasFailed = task.status === "failed";

      // Capture title/description before mutation so the PROMPT.md stub
      // detector below can compare against the exact wrapper bytes that the
      // pre-edit task would have produced. This is what makes detection
      // robust to descriptions that contain `##` headings or `**Created:**`
      // text (e.g. imported GitHub issue bodies) — we never inspect the
      // description content, only the wrapper shape.
      const preUpdateTitle = task.title;
      const preUpdateDescription = task.description;

      if (updates.nodeId !== undefined) {
        const validation = validateNodeOverrideChange(task, updates.nodeId ?? null);
        if (!validation.allowed) {
          throw new Error(validation.message);
        }
      }

      // Initialize log array if missing (for legacy tasks)
      if (!task.log) {
        task.log = [];
      }

      let titleNormalized = false;
      if (updates.title !== undefined) {
        task.title = updates.title;
        // FN-5077: load-time repair tolerates null normalized titles (title cleared instead of fragment persisted).
        const normalizedTitle = normalizeTitleForTaskId(task.title, id);
        if (normalizedTitle.changed) {
          titleNormalized = true;
          const removed = extractTaskIdTokens(task.title ?? "").filter((token) => token !== id.toUpperCase());
          task.title = normalizedTitle.title ?? undefined;
          task.log.push({
            timestamp: new Date().toISOString(),
            action: "Title normalized: stripped legacy task-id reference",
            ...(runContext ? { runContext } : {}),
          });
          storeLog.log(`[title-id-drift] normalized title for ${id}: removed=[${removed.join(",")}]`);
        }
      }
      if (updates.description !== undefined) task.description = updates.description;
      if (updates.sourceMetadataPatch === null) {
        task.sourceMetadata = undefined;
      } else if (updates.sourceMetadataPatch !== undefined) {
        task.sourceMetadata = {
          ...(task.sourceMetadata ?? {}),
          ...updates.sourceMetadataPatch,
        };
      }
      if (updates.priority === null) {
        task.priority = normalizeTaskPriority(undefined);
      } else if (updates.priority !== undefined) {
        task.priority = normalizeTaskPriority(updates.priority);
      }
      if (updates.worktree === null) {
        task.worktree = undefined;
      } else if (updates.worktree !== undefined) {
        task.worktree = updates.worktree;
      }
      if (updates.workspaceWorktrees !== undefined) {
        task.workspaceWorktrees = updates.workspaceWorktrees;
      }
      // Detect new dependencies being added to a todo task → auto-move to triage
      let movedToTriage = false;
      if (updates.dependencies !== undefined) {
        const oldDeps = new Set((task.dependencies ?? []).map((dependency) => dependency.trim()).filter(Boolean));
        const normalizedDependencies = updates.dependencies.map((dependency) => dependency.trim()).filter(Boolean);
        const hasNewDeps = normalizedDependencies.some((d) => !oldDeps.has(d));
        task.dependencies = normalizedDependencies;

        if (hasNewDeps && task.column === "todo") {
          task.column = "triage";
          task.status = undefined;
          task.columnMovedAt = new Date().toISOString();
          const depLogEntry: TaskLogEntry = {
            timestamp: new Date().toISOString(),
            action: "Moved to triage for re-specification — new dependency added",
          };
          if (runContext) {
            depLogEntry.runContext = runContext;
          }
          task.log.push(depLogEntry);
          movedToTriage = true;
        }
      }
      if (updates.steps !== undefined) task.steps = updates.steps;
      // U11/KTD-13: customFields writes are validated against the task's workflow
      // field schema through the single authority (task-fields.ts). The patch is
      // merged into the existing values (delete-on-null), mirroring
      // updateTaskCustomFields. Backward-compat note: U4 round-tripped the object
      // opaquely; the field system now enforces type/enum/unknown-id rules, so a
      // write against a workflow with no fields (the default) is rejected with a
      // typed CustomFieldRejectionError rather than silently persisted.
      if (updates.customFields !== undefined) {
        const defs = store.resolveTaskCustomFieldDefsSync(id);
        const result = validateCustomFieldPatch(defs, updates.customFields);
        if (!result.ok) throw new CustomFieldRejectionError(result.rejection);
        task.customFields = store.mergeCustomFieldPatch(task.customFields, result.normalized);
      }
      if (updates.currentStep !== undefined) task.currentStep = updates.currentStep;
      if (updates.status === null) {
        task.status = undefined;
      } else if (updates.status !== undefined) {
        task.status = updates.status;
      }
      if (updates.blockedBy === null) {
        task.blockedBy = undefined;
      } else if (updates.blockedBy !== undefined) {
        task.blockedBy = updates.blockedBy;
      }
      if (updates.overlapBlockedBy === null) {
        task.overlapBlockedBy = undefined;
      } else if (updates.overlapBlockedBy !== undefined) {
        task.overlapBlockedBy = updates.overlapBlockedBy;
      }
      const previousAssignedAgentId = task.assignedAgentId;
      if (updates.assignedAgentId === null) {
        task.assignedAgentId = undefined;
      } else if (updates.assignedAgentId !== undefined) {
        task.assignedAgentId = updates.assignedAgentId;
      }
      // If the agent that paused this task is being unassigned (or replaced),
      // auto-unpause: the pause was tied to that agent's lifecycle, and now
      // there's no longer a relationship that justifies keeping the task paused.
      const assignmentChanged =
        updates.assignedAgentId !== undefined && task.assignedAgentId !== previousAssignedAgentId;
      if (
        assignmentChanged &&
        task.paused &&
        task.pausedByAgentId &&
        task.pausedByAgentId === previousAssignedAgentId
      ) {
        task.paused = undefined;
        task.pausedByAgentId = undefined;
        if (task.column === "in-progress" || task.column === "in-review") {
          if (task.status === "paused") {
            task.status = undefined;
          }
        }
        task.log.push({
          timestamp: new Date().toISOString(),
          action: `Task unpaused (agent ${previousAssignedAgentId} unassigned)`,
          ...(runContext ? { runContext } : {}),
        });
      }
      if (assignmentChanged) {
        await store.syncAgentTaskLinkOnReassignment(id, previousAssignedAgentId, task.assignedAgentId);

        if (task.checkedOutBy === previousAssignedAgentId) {
          task.checkedOutBy = undefined;
          task.checkedOutAt = undefined;
        }

        task.log.push({
          timestamp: new Date().toISOString(),
          action: `Agent task link synced: ${previousAssignedAgentId ?? "none"} → ${task.assignedAgentId ?? "none"}`,
          ...(runContext ? { runContext } : {}),
        });
      }
      if (updates.pausedByAgentId === null) {
        task.pausedByAgentId = undefined;
      } else if (updates.pausedByAgentId !== undefined) {
        task.pausedByAgentId = updates.pausedByAgentId;
      }
      if (updates.pausedReason === null) {
        task.pausedReason = undefined;
      } else if (updates.pausedReason !== undefined) {
        task.pausedReason = updates.pausedReason;
      }
      if (updates.tokenBudgetSoftAlertedAt === null) {
        task.tokenBudgetSoftAlertedAt = undefined;
      } else if (updates.tokenBudgetSoftAlertedAt !== undefined) {
        task.tokenBudgetSoftAlertedAt = updates.tokenBudgetSoftAlertedAt;
      }
      if (updates.worktrunkFallbackAlertedAt === null) {
        task.worktrunkFallbackAlertedAt = undefined;
      } else if (updates.worktrunkFallbackAlertedAt !== undefined) {
        task.worktrunkFallbackAlertedAt = updates.worktrunkFallbackAlertedAt;
      }
      if (updates.worktrunkFailure === null) {
        task.worktrunkFailure = undefined;
      } else if (updates.worktrunkFailure !== undefined) {
        task.worktrunkFailure = updates.worktrunkFailure;
      }
      if (updates.tokenBudgetHardAlertedAt === null) {
        task.tokenBudgetHardAlertedAt = undefined;
      } else if (updates.tokenBudgetHardAlertedAt !== undefined) {
        task.tokenBudgetHardAlertedAt = updates.tokenBudgetHardAlertedAt;
      }
      if (updates.tokenBudgetOverride === null) {
        task.tokenBudgetOverride = undefined;
      } else if (updates.tokenBudgetOverride !== undefined) {
        task.tokenBudgetOverride = updates.tokenBudgetOverride;
      }
      if (updates.dispatchStormCount === null) {
        task.dispatchStormCount = undefined;
      } else if (updates.dispatchStormCount !== undefined) {
        task.dispatchStormCount = updates.dispatchStormCount;
      }
      if (updates.lastDispatchAt === null) {
        task.lastDispatchAt = undefined;
      } else if (updates.lastDispatchAt !== undefined) {
        task.lastDispatchAt = updates.lastDispatchAt;
      }
      if (updates.assigneeUserId === null) {
        task.assigneeUserId = undefined;
      } else if (updates.assigneeUserId !== undefined) {
        task.assigneeUserId = updates.assigneeUserId;
      }
      if (updates.scopeOverride === null) {
        task.scopeOverride = undefined;
      } else if (updates.scopeOverride !== undefined) {
        task.scopeOverride = updates.scopeOverride || undefined;
      }
      if (updates.scopeOverrideReason === null) {
        task.scopeOverrideReason = undefined;
      } else if (updates.scopeOverrideReason !== undefined) {
        task.scopeOverrideReason = updates.scopeOverrideReason;
      }
      if (updates.scopeAutoWiden === null) {
        task.scopeAutoWiden = undefined;
      } else if (updates.scopeAutoWiden !== undefined) {
        task.scopeAutoWiden = [...updates.scopeAutoWiden];
      }
      if (updates.nodeId === null) {
        task.nodeId = undefined;
      } else if (updates.nodeId !== undefined) {
        task.nodeId = updates.nodeId;
      }
      if (updates.effectiveNodeId === null) {
        task.effectiveNodeId = undefined;
      } else if (updates.effectiveNodeId !== undefined) {
        task.effectiveNodeId = updates.effectiveNodeId;
      }
      if (updates.effectiveNodeSource === null) {
        task.effectiveNodeSource = undefined;
      } else if (updates.effectiveNodeSource !== undefined) {
        task.effectiveNodeSource = updates.effectiveNodeSource as Task["effectiveNodeSource"];
      }
      if (updates.checkedOutBy === null) {
        task.checkedOutBy = undefined;
        task.checkedOutAt = undefined;
        task.checkoutNodeId = undefined;
        task.checkoutRunId = undefined;
        task.checkoutLeaseRenewedAt = undefined;
      } else if (updates.checkedOutBy !== undefined) {
        task.checkedOutBy = updates.checkedOutBy;
        task.checkedOutAt = updates.checkedOutAt ?? task.checkedOutAt ?? new Date().toISOString();
        task.checkoutNodeId = updates.checkoutNodeId ?? task.checkoutNodeId;
        task.checkoutRunId = updates.checkoutRunId ?? task.checkoutRunId;
        task.checkoutLeaseRenewedAt = updates.checkoutLeaseRenewedAt ?? task.checkoutLeaseRenewedAt ?? task.checkedOutAt;
      }
      if (updates.checkoutNodeId === null) {
        task.checkoutNodeId = undefined;
      } else if (updates.checkoutNodeId !== undefined && updates.checkedOutBy === undefined) {
        task.checkoutNodeId = updates.checkoutNodeId;
      }
      if (updates.checkoutRunId === null) {
        task.checkoutRunId = undefined;
      } else if (updates.checkoutRunId !== undefined && updates.checkedOutBy === undefined) {
        task.checkoutRunId = updates.checkoutRunId;
      }
      if (updates.checkoutLeaseRenewedAt === null) {
        task.checkoutLeaseRenewedAt = undefined;
      } else if (updates.checkoutLeaseRenewedAt !== undefined && updates.checkedOutBy === undefined) {
        task.checkoutLeaseRenewedAt = updates.checkoutLeaseRenewedAt;
      }
      if (updates.checkoutLeaseEpoch === null) {
        task.checkoutLeaseEpoch = undefined;
      } else if (updates.checkoutLeaseEpoch !== undefined) {
        task.checkoutLeaseEpoch = updates.checkoutLeaseEpoch;
      }
      if (updates.paused !== undefined) task.paused = updates.paused || undefined;
      if (updates.baseBranch === null) {
        task.baseBranch = undefined;
      } else if (updates.baseBranch !== undefined) {
        task.baseBranch = updates.baseBranch;
      }
      // Explicit task-level auto-merge overrides written through updateTask are
      // user provenance. Task creation mirrors this for create-time overrides.
      if (updates.autoMerge === null) {
        task.autoMerge = undefined;
        task.autoMergeProvenance = undefined;
      } else if (updates.autoMerge !== undefined) {
        task.autoMerge = updates.autoMerge;
        task.autoMergeProvenance = "user";
      }
      if (updates.branch === null) {
        task.branch = undefined;
      } else if (updates.branch !== undefined) {
        task.branch = updates.branch;
      }
      // Keep in sync with the first autoMerge block above; both legacy update
      // paths may run before persistence.
      if (updates.autoMerge === null) {
        task.autoMerge = undefined;
        task.autoMergeProvenance = undefined;
      } else if (updates.autoMerge !== undefined) {
        task.autoMerge = updates.autoMerge;
        task.autoMergeProvenance = "user";
      }
      if (updates.executionStartBranch === null) {
        task.executionStartBranch = undefined;
      } else if (updates.executionStartBranch !== undefined) {
        task.executionStartBranch = updates.executionStartBranch;
      }
      if (updates.baseCommitSha === null) {
        task.baseCommitSha = undefined;
      } else if (updates.baseCommitSha !== undefined) {
        task.baseCommitSha = updates.baseCommitSha;
      }
      if (updates.size !== undefined) task.size = updates.size;
      if (updates.reviewLevel !== undefined) task.reviewLevel = updates.reviewLevel;
      if (updates.mergeRetries !== undefined) task.mergeRetries = updates.mergeRetries;
      if (updates.workflowStepRetries !== undefined) task.workflowStepRetries = updates.workflowStepRetries;
      if (updates.stuckKillCount === null) {
        task.stuckKillCount = undefined;
      } else if (updates.stuckKillCount !== undefined) {
        task.stuckKillCount = updates.stuckKillCount;
      }
      if (updates.resumeLimboCount === null) {
        task.resumeLimboCount = undefined;
      } else if (updates.resumeLimboCount !== undefined) {
        task.resumeLimboCount = updates.resumeLimboCount;
      }
      if (updates.graphResumeRetryCount === null) {
        task.graphResumeRetryCount = null;
      } else if (updates.graphResumeRetryCount !== undefined) {
        task.graphResumeRetryCount = updates.graphResumeRetryCount;
      }
      if (updates.consecutiveToolFailureRetryCount === null) task.consecutiveToolFailureRetryCount = null;
      else if (updates.consecutiveToolFailureRetryCount !== undefined) task.consecutiveToolFailureRetryCount = updates.consecutiveToolFailureRetryCount;
      if (updates.executorEscalationAttempted === null) task.executorEscalationAttempted = null;
      else if (updates.executorEscalationAttempted !== undefined) task.executorEscalationAttempted = updates.executorEscalationAttempted;
      if (updates.toolFailureDetectorLogCursor === null) task.toolFailureDetectorLogCursor = null;
      else if (updates.toolFailureDetectorLogCursor !== undefined) task.toolFailureDetectorLogCursor = updates.toolFailureDetectorLogCursor;
      if (updates.toolFailureRetryExhaustedAuditEmitted === null) task.toolFailureRetryExhaustedAuditEmitted = null;
      else if (updates.toolFailureRetryExhaustedAuditEmitted !== undefined) task.toolFailureRetryExhaustedAuditEmitted = updates.toolFailureRetryExhaustedAuditEmitted;
      if (updates.resumeLimboTipSha === null) {
        task.resumeLimboTipSha = undefined;
      } else if (updates.resumeLimboTipSha !== undefined) {
        task.resumeLimboTipSha = updates.resumeLimboTipSha;
      }
      if (updates.resumeLimboStepSignature === null) {
        task.resumeLimboStepSignature = undefined;
      } else if (updates.resumeLimboStepSignature !== undefined) {
        task.resumeLimboStepSignature = updates.resumeLimboStepSignature;
      }
      if (updates.executeRequeueLoopCount === null) {
        task.executeRequeueLoopCount = undefined;
      } else if (updates.executeRequeueLoopCount !== undefined) {
        task.executeRequeueLoopCount = updates.executeRequeueLoopCount;
      }
      if (updates.executeRequeueLoopSignature === null) {
        task.executeRequeueLoopSignature = undefined;
      } else if (updates.executeRequeueLoopSignature !== undefined) {
        task.executeRequeueLoopSignature = updates.executeRequeueLoopSignature;
      }
      if (updates.postReviewFixCount === null) {
        task.postReviewFixCount = undefined;
      } else if (updates.postReviewFixCount !== undefined) {
        task.postReviewFixCount = updates.postReviewFixCount;
      }
      if (updates.planReviewReplanCount === null) {
        task.planReviewReplanCount = undefined;
      } else if (updates.planReviewReplanCount !== undefined) {
        task.planReviewReplanCount = updates.planReviewReplanCount;
      }
      if (updates.recoveryRetryCount === null) {
        task.recoveryRetryCount = undefined;
      } else if (updates.recoveryRetryCount !== undefined) {
        task.recoveryRetryCount = updates.recoveryRetryCount;
      }
      if (updates.taskDoneRetryCount === null) {
        task.taskDoneRetryCount = undefined;
      } else if (updates.taskDoneRetryCount !== undefined) {
        task.taskDoneRetryCount = updates.taskDoneRetryCount;
      }
      // FNXC:Lifecycle 2026-07-16-21:40: FN-8141 skip-bypass taint marker; null clears the taint.
      if (updates.bulkCompletionRefusalAt === null) {
        task.bulkCompletionRefusalAt = undefined;
      } else if (updates.bulkCompletionRefusalAt !== undefined) {
        task.bulkCompletionRefusalAt = updates.bulkCompletionRefusalAt;
      }
      /*
      FNXC:WorkflowIrPin 2026-07-19-03:10 (U9b / KTD-3):
      Node entry SETS the pin; node settle CLEARS it (null). Both directions must be writable
      through updateTask or the pin either never lands or outlives its node and reports drift
      against a node the task already left.
      */
      if (updates.workflowIrPin === null) {
        task.workflowIrPin = undefined;
      } else if (updates.workflowIrPin !== undefined) {
        task.workflowIrPin = updates.workflowIrPin;
      }
      if (updates.workflowIrPinNodeId === null) {
        task.workflowIrPinNodeId = undefined;
      } else if (updates.workflowIrPinNodeId !== undefined) {
        task.workflowIrPinNodeId = updates.workflowIrPinNodeId;
      }
      if (updates.workflowIrPinColumnId === null) {
        task.workflowIrPinColumnId = undefined;
      } else if (updates.workflowIrPinColumnId !== undefined) {
        task.workflowIrPinColumnId = updates.workflowIrPinColumnId;
      }
      // FNXC:LegacyAdoption 2026-07-19-03:10 (U9b / KTD-8): stamped once by adoption; null is
      // reserved for tests/operator repair that need to force re-adoption.
      if (updates.legacyAdoptedAt === null) {
        task.legacyAdoptedAt = undefined;
      } else if (updates.legacyAdoptedAt !== undefined) {
        task.legacyAdoptedAt = updates.legacyAdoptedAt;
      }
      if (updates.worktreeSessionRetryCount === null) {
        task.worktreeSessionRetryCount = undefined;
      } else if (updates.worktreeSessionRetryCount !== undefined) {
        task.worktreeSessionRetryCount = updates.worktreeSessionRetryCount;
      }
      if (updates.completionHandoffLimboRecoveryCount === null) {
        task.completionHandoffLimboRecoveryCount = undefined;
      } else if (updates.completionHandoffLimboRecoveryCount !== undefined) {
        task.completionHandoffLimboRecoveryCount = updates.completionHandoffLimboRecoveryCount;
      }
      if (updates.verificationFailureCount === null) {
        task.verificationFailureCount = undefined;
      } else if (updates.verificationFailureCount !== undefined) {
        task.verificationFailureCount = updates.verificationFailureCount;
      }
      if (updates.mergeConflictBounceCount === null) {
        task.mergeConflictBounceCount = undefined;
      } else if (updates.mergeConflictBounceCount !== undefined) {
        task.mergeConflictBounceCount = updates.mergeConflictBounceCount;
      }
      if (updates.mergeAuditBounceCount === null) {
        task.mergeAuditBounceCount = undefined;
      } else if (updates.mergeAuditBounceCount !== undefined) {
        task.mergeAuditBounceCount = updates.mergeAuditBounceCount;
      }
      if (updates.mergeTransientRetryCount === null) {
        task.mergeTransientRetryCount = undefined;
      } else if (updates.mergeTransientRetryCount !== undefined) {
        task.mergeTransientRetryCount = updates.mergeTransientRetryCount;
      }
      if (updates.branchConflictRecoveryCount === null) {
        task.branchConflictRecoveryCount = undefined;
      } else if (updates.branchConflictRecoveryCount !== undefined) {
        task.branchConflictRecoveryCount = updates.branchConflictRecoveryCount;
      }
      if (updates.reviewerContextRetryCount === null) {
        task.reviewerContextRetryCount = undefined;
      } else if (updates.reviewerContextRetryCount !== undefined) {
        task.reviewerContextRetryCount = updates.reviewerContextRetryCount;
      }
      if (updates.reviewerFallbackRetryCount === null) {
        task.reviewerFallbackRetryCount = undefined;
      } else if (updates.reviewerFallbackRetryCount !== undefined) {
        task.reviewerFallbackRetryCount = updates.reviewerFallbackRetryCount;
      }
      if (updates.nextRecoveryAt === null) {
        task.nextRecoveryAt = undefined;
      } else if (updates.nextRecoveryAt !== undefined) {
        task.nextRecoveryAt = updates.nextRecoveryAt;
      }
      if (updates.enabledWorkflowSteps !== undefined) {
        // Pass the task's own workflow optional-group ids through untouched so a
        // toggled built-in group id (e.g. "browser-verification") is not remapped
        // to a materialized step row the executor never matches (code-review P1).
        const taskWorkflowId = (await store.getTaskWorkflowSelectionAsync(task.id))?.workflowId;
        task.enabledWorkflowSteps = await store.resolveEnabledWorkflowSteps(
          updates.enabledWorkflowSteps,
          await store.optionalGroupIdSet(taskWorkflowId),
        );
      }
      if (updates.noCommitsExpected === null) {
        task.noCommitsExpected = undefined;
      } else if (updates.noCommitsExpected !== undefined) {
        task.noCommitsExpected = updates.noCommitsExpected || undefined;
      }
      if (updates.modelProvider === null) {
        task.modelProvider = undefined;
      } else if (updates.modelProvider !== undefined) {
        task.modelProvider = updates.modelProvider;
      }
      if (updates.modelId === null) {
        task.modelId = undefined;
      } else if (updates.modelId !== undefined) {
        task.modelId = updates.modelId;
      }
      if (updates.validatorModelProvider === null) {
        task.validatorModelProvider = undefined;
      } else if (updates.validatorModelProvider !== undefined) {
        task.validatorModelProvider = updates.validatorModelProvider;
      }
      if (updates.validatorModelId === null) {
        task.validatorModelId = undefined;
      } else if (updates.validatorModelId !== undefined) {
        task.validatorModelId = updates.validatorModelId;
      }
      if (updates.planningModelProvider === null) {
        task.planningModelProvider = undefined;
      } else if (updates.planningModelProvider !== undefined) {
        task.planningModelProvider = updates.planningModelProvider;
      }
      if (updates.planningModelId === null) {
        task.planningModelId = undefined;
      } else if (updates.planningModelId !== undefined) {
        task.planningModelId = updates.planningModelId;
      }
      if (updates.mergerModelProvider === null) task.mergerModelProvider = undefined;
      else if (updates.mergerModelProvider !== undefined) task.mergerModelProvider = updates.mergerModelProvider;
      if (updates.mergerModelId === null) task.mergerModelId = undefined;
      else if (updates.mergerModelId !== undefined) task.mergerModelId = updates.mergerModelId;
      if (updates.validatorThinkingLevel === null) {
        task.validatorThinkingLevel = undefined;
      } else if (updates.validatorThinkingLevel !== undefined) {
        task.validatorThinkingLevel = updates.validatorThinkingLevel as import("../types.js").ThinkingLevel;
      }
      if (updates.planningThinkingLevel === null) {
        task.planningThinkingLevel = undefined;
      } else if (updates.planningThinkingLevel !== undefined) {
        task.planningThinkingLevel = updates.planningThinkingLevel as import("../types.js").ThinkingLevel;
      }
      if (updates.mergerThinkingLevel === null) task.mergerThinkingLevel = undefined;
      else if (updates.mergerThinkingLevel !== undefined) task.mergerThinkingLevel = updates.mergerThinkingLevel as import("../types.js").ThinkingLevel;
      if (updates.thinkingLevel === null) {
        task.thinkingLevel = undefined;
      } else if (updates.thinkingLevel !== undefined) {
        task.thinkingLevel = updates.thinkingLevel as import("../types.js").ThinkingLevel;
      }
      if (updates.executionMode === null) {
        task.executionMode = undefined;
      } else if (updates.executionMode !== undefined) {
        task.executionMode = updates.executionMode as import("../types.js").ExecutionMode;
      }
      /*
      FNXC:PlannerOversight 2026-07-14-18:11:
      sessionAdvisorEnabled: null clears to inherit project default; boolean sets override.
      */
      if (updates.sessionAdvisorEnabled === null) {
        task.sessionAdvisorEnabled = undefined;
      } else if (updates.sessionAdvisorEnabled !== undefined) {
        task.sessionAdvisorEnabled = updates.sessionAdvisorEnabled;
      }
      if (updates.error === null) {
        task.error = undefined;
      } else if (updates.error !== undefined) {
        task.error = updates.error;
      }
      if (updates.summary === null) {
        task.summary = undefined;
      } else if (updates.summary !== undefined) {
        task.summary = updates.summary;
      }
      if (updates.sessionFile === null) {
        task.sessionFile = undefined;
      } else if (updates.sessionFile !== undefined) {
        task.sessionFile = updates.sessionFile;
      }
      if (updates.firstExecutionAt === null) {
        task.firstExecutionAt = undefined;
      } else if (updates.firstExecutionAt !== undefined) {
        task.firstExecutionAt = updates.firstExecutionAt;
      }
      if (updates.cumulativeActiveMs === null) {
        task.cumulativeActiveMs = undefined;
      } else if (updates.cumulativeActiveMs !== undefined) {
        task.cumulativeActiveMs = updates.cumulativeActiveMs;
      }
      if (updates.executionStartedAt === null) {
        task.executionStartedAt = undefined;
      } else if (updates.executionStartedAt !== undefined) {
        task.executionStartedAt = updates.executionStartedAt;
      }
      if (updates.executionCompletedAt === null) {
        task.executionCompletedAt = undefined;
      } else if (updates.executionCompletedAt !== undefined) {
        task.executionCompletedAt = updates.executionCompletedAt;
      }
      if (updates.review === null) {
        task.review = undefined;
      } else if (updates.review !== undefined) {
        task.review = updates.review;
      }
      if (updates.reviewState === null) {
        task.reviewState = undefined;
      } else if (updates.reviewState !== undefined) {
        task.reviewState = normalizeTaskReviewState(updates.reviewState);
      }
      if (updates.workflowStepResults === null) {
        task.workflowStepResults = undefined;
      } else if (updates.workflowStepResults !== undefined) {
        task.workflowStepResults = updates.workflowStepResults;
      }
      if (updates.mergeDetails === null) {
        task.mergeDetails = undefined;
      } else if (updates.mergeDetails !== undefined) {
        task.mergeDetails = updates.mergeDetails;
      }
      if (updates.sourceIssue === null) {
        task.sourceIssue = undefined;
      } else if (updates.sourceIssue !== undefined) {
        task.sourceIssue = updates.sourceIssue;
      }
      if (updates.githubTracking === null) {
        task.githubTracking = undefined;
      } else if (updates.githubTracking !== undefined) {
        const previousTracking = task.githubTracking;
        const previousIssue = previousTracking?.issue;
        const nextTracking: import("../types.js").TaskGithubTracking = {
          ...(previousTracking ?? {}),
          ...updates.githubTracking,
        };

        if (updates.githubTracking.repoOverride === null) {
          nextTracking.repoOverride = undefined;
        }

        if (updates.githubTracking.enabled === false) {
          nextTracking.enabled = false;
          if (previousIssue) {
            nextTracking.issue = undefined;
            nextTracking.unlinkedAt = new Date().toISOString();
            task.log.push({
              timestamp: new Date().toISOString(),
              action: "GitHub issue unlinked",
              outcome: `${previousIssue.owner}/${previousIssue.repo}#${previousIssue.number}`,
              ...(runContext ? { runContext } : {}),
            });
          }
          task.log.push({
            timestamp: new Date().toISOString(),
            action: "GitHub tracking disabled",
            ...(runContext ? { runContext } : {}),
          });
        }

        if (updates.githubTracking.enabled === true) {
          nextTracking.enabled = true;
          task.log.push({
            timestamp: new Date().toISOString(),
            action: "GitHub tracking enabled",
            ...(runContext ? { runContext } : {}),
          });
        }

        if (updates.githubTracking.issue === null) {
          if (previousIssue) {
            task.log.push({
              timestamp: new Date().toISOString(),
              action: "GitHub issue unlinked",
              outcome: `${previousIssue.owner}/${previousIssue.repo}#${previousIssue.number}`,
              ...(runContext ? { runContext } : {}),
            });
          }
          nextTracking.issue = undefined;
          nextTracking.unlinkedAt = new Date().toISOString();
        }

        task.githubTracking = nextTracking;
      }
      if (updates.tokenUsage === null) {
        task.tokenUsage = undefined;
      } else if (updates.tokenUsage !== undefined) {
        task.tokenUsage = updates.tokenUsage;
      }
      if (updates.modifiedFiles === null) {
        task.modifiedFiles = undefined;
      } else if (updates.modifiedFiles !== undefined) {
        task.modifiedFiles = updates.modifiedFiles;
      }
      /* FNXC:SymbolLock 2026-07-31-10:00: present undefined is an explicit clear; only absent declarations may hydrate from a prompt write. */
      if (hasOwnDeclaredSymbols(updates)) {
        const normalized = normalizeDeclaredSymbols(Array.isArray(updates.declaredSymbols) ? updates.declaredSymbols : []);
        task.declaredSymbols = normalized.length ? normalized : undefined;
      } else if (updates.prompt !== undefined) {
        const normalized = normalizeDeclaredSymbols(extractDeclaredSymbolsFromPrompt(updates.prompt));
        task.declaredSymbols = normalized.length ? normalized : undefined;
      }
      if (updates.missionId === null) {
        task.missionId = undefined;
      } else if (updates.missionId !== undefined) {
        task.missionId = updates.missionId;
      }
      if (updates.sliceId === null) {
        task.sliceId = undefined;
      } else if (updates.sliceId !== undefined) {
        task.sliceId = updates.sliceId;
      }
      task.updatedAt = new Date().toISOString();

      // FNXC:TaskDetailPromptResilience 2026-07-10-17:00 (merge port from main):
      // Perform the explicit PROMPT.md write (and its File Scope validation)
      // BEFORE committing the task row, so a failed write (EACCES/EISDIR/
      // disk-full) or an invalid File Scope aborts the whole update atomically.
      // Previously this ran AFTER the row/task.json commit, so a failed prompt
      // write returned an error while the field changes stayed committed and
      // PROMPT.md went stale — a partial commit.
      if (updates.prompt !== undefined) {
        const validation = validateFileScopeInPromptContent(updates.prompt);
        if (validation.invalid.length > 0) {
          throw new InvalidFileScopeError(id, validation.invalid);
        }
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, "PROMPT.md"), updates.prompt);
      }

      // When runContext is provided, record audit event atomically with task mutation
      if (runContext) {
        await store.atomicWriteTaskJsonWithAudit(dir, task, {
          taskId: task.id,
          agentId: runContext.agentId,
          runId: runContext.runId,
          domain: "database",
          mutationType: "task:update",
          target: task.id,
          metadata: {
            updatedFields: Object.keys(updates).filter((k) => (updates as Record<string, unknown>)[k] !== undefined),
            ...(titleNormalized ? { titleNormalized: true } : {}),
          },
        });
      } else {
        await store.atomicWriteTaskJson(dir, task);
      }

      /*
      FNXC:MissionSymbolAdmission 2026-08-01-00:00:
      A workflow failure may park in the current in-progress column rather than
      move out of it. Release that task's durable symbols on the status edge as
      well as moveTask's column-exit path, allowing engine reconciliation to
      record failure provenance without incorrectly completing the feature.
      */
      if (store.backendMode && !wasFailed && task.status === "failed") {
        const symbols = resolveTaskSymbolsForTask(task);
        if (symbols.resolvable) {
          await store.releaseSymbolLocks(symbols.symbols, id);
        }
      }

      // Update cache if watcher is active
      if (store.isWatching) store.taskCache.set(id, { ...task });

      // Sync PROMPT.md when title or description changes (but not when explicit
      // prompt update — that already wrote the new content above).
      //
      // Two distinct cases:
      //
      // (a) Bootstrap stub — the auto-generated `# heading\n\n<desc>\n` block
      //     `createTask` writes. Rewrite the whole file from the new title +
      //     description so the human-visible stub stays in sync.
      //
      // (b) Real specification (any `##` section header, or the `**Created:**`
      //     / `**Size:**` metadata the triage prompt format requires). Do NOT
      //     rebuild the file from a section whitelist — earlier regressions
      //     either clobbered the spec entirely (FN-3056 + the previous
      //     `regeneratePrompt` path while column='triage') or silently dropped
      //     `## Review Level` / `## Frontend UX Criteria` and other custom
      //     sections (the same regen call on column!='triage'), which left the
      //     executor with reset review levels and missing UX guidance. Instead
      //     just splice the leading `#` heading line so the displayed title
      //     stays in sync with task.json; the body is preserved verbatim.
      //
      // task.json remains the canonical source for title/description fields.
      // PROMPT.md is only ever fully rewritten via explicit `updates.prompt`.
      if (updates.prompt === undefined && (updates.title !== undefined || updates.description !== undefined)) {
        // FNXC:TaskDetailPromptResilience 2026-07-10-15:00 (merge port from main):
        // Keeping the human-visible PROMPT.md heading/mission in sync with
        // task.json is cosmetic — the DB row (persisted above) is canonical. An
        // unreadable/unwritable PROMPT.md (EACCES/EISDIR/transient FS error)
        // must NOT fail the update itself, or every title/description edit 500s.
        // Best-effort: log and skip the sync on failure.
        const promptPath = join(dir, "PROMPT.md");
        try {
          if (existsSync(promptPath)) {
            const existingPrompt = await readFile(promptPath, "utf-8");

            if (isBootstrapPromptStub(existingPrompt, task.id, preUpdateTitle, preUpdateDescription)) {
              const newPrompt = buildBootstrapPrompt(task.id, task.title, task.description);
              await writeFile(promptPath, newPrompt);
            } else {
              // Real spec — surgical edits only. Each section we propagate to is
              // edited in place; everything else (Review Level, Frontend UX
              // Criteria, custom sections from triage) is preserved verbatim.
              let next = existingPrompt;
              if (updates.title !== undefined) {
                // Match the existing heading style: triage emits
                // `# Task: {id} - {title}`; createTask uses `# {id}: {title}`.
                const triageStyle = /^#\s+Task:\s+[A-Z]+-\d+\s+-\s+/m.test(existingPrompt);
                const heading = triageStyle
                  ? (task.title ? `Task: ${task.id} - ${task.title}` : `Task: ${task.id}`)
                  : (task.title ? `${task.id}: ${task.title}` : task.id);
                next = rewriteHeadingLine(next, heading);
              }
              if (updates.description !== undefined) {
                // FNXC:OriginalDescriptionInPrompt 2026-07-14-23:35:
                // Keep ## Mission and ## Original Description in sync with task.description
                // on real specs so operator edits stay visible at the top of PROMPT.md.
                next = rewriteMissionSection(next, task.description);
                next = applyOriginalDescription(next, task.description ?? "");
              }
              if (next !== existingPrompt) {
                await writeFile(promptPath, next);
              }
            }
          }
        } catch (err) {
          storeLog.warn(`[task-detail] failed to sync PROMPT.md heading for ${task.id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      if (movedToTriage) {
        store.emit("task:moved", { task, from: "todo" as Column, to: "triage" as Column, source: "engine" });
      }
      store.emitTaskLifecycleEventSafely("task:updated", [task]);
      return task;
    }
  }

