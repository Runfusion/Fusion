import { and, eq, inArray, sql } from "drizzle-orm";
import type { ColumnId, Task } from "../types.js";
import * as schema from "../postgres/schema/index.js";
import { projectScopeFor } from "../postgres/data-layer.js";
import { acquireTaskAdvisoryXactLock } from "./task-advisory-lock.js";
import { withTaskWorkflowSerialization } from "./async/async-workflow-workitems.js";
import { readTaskRowInTransaction, upsertTaskRowInTransaction } from "./async/async-persistence.js";
import type { TaskStore } from "../store.js";
import { createLogger } from "../process/logger.js";
import { resolveTaskSymbolsForTask } from "../tasks/task-symbol-resolution.js";

const resetLog = createLogger("task-store-reset-lifecycle");
const ACTIVE_TASK_CONTINUATION_STATES = ["runnable", "running", "held", "retrying"] as const;

let resetPublicationFailureForTesting: (() => void | Promise<void>) | undefined;

/** @internal Failure injection is test-only and scoped to the next publication attempt. */
export function __setResetPublicationFailureForTesting(
  failure?: (() => void | Promise<void>),
): () => void {
  resetPublicationFailureForTesting = failure;
  return () => {
    if (resetPublicationFailureForTesting === failure) resetPublicationFailureForTesting = undefined;
  };
}

export interface ResetTaskPublicationOptions {
  description?: string;
}

export function resolveResetDescription(
  current: string | undefined,
  override?: string,
): string | undefined {
  const trimmedOverride = typeof override === "string" ? override.trim() : "";
  return trimmedOverride.length > 0 ? trimmedOverride : current;
}

/*
FNXC:TaskReset 2026-08-28-20:50:
The reset publisher reproduces the durable state of a freshly started idea: no plan steps, per-run presentation state, or lifecycle status survives. `needs-replan` remains the graph signal for revising a rejected plan, while an operator Reset is a new planning request and must render "Queued to plan"; the bootstrap seed PROMPT.md written fail-closed by the route is now the load-bearing planning-admission signal instead. Reset deliberately preserves task history and operator intent: log, comments, steering comments, attachments, operator documents, assignedAgentId, model and preset configuration, enabledWorkflowSteps, creation-time reviewLevel, noCommitsExpected, repositoryScope, branchContext, the monotonic checkoutLeaseEpoch fence, wedgeNotification through preserveDurableTaskWedgeInvariants, and never-cleared timing analytics firstExecutionAt, cumulativeActiveMs, cumulativePlanningMs, and columnDwellMs.

FNXC:TaskReset 2026-08-28-16:31:
A corrected original request must commit in the same transaction as fresh-planning state so a failed Reset cannot leave rewritten intent behind. Blank overrides preserve the current description, while a non-empty override updates `task.description`, which `applyOriginalDescription` republishes into the regenerated `## Original Description` section.
*/
/** @internal Pure reset publication builder for contract tests. */
export function buildResetTask(
  task: Task,
  intakeColumn: ColumnId,
  options?: ResetTaskPublicationOptions,
): Task {
  const now = new Date().toISOString();
  return {
    ...task,
    description: resolveResetDescription(task.description, options?.description) ?? task.description,
    column: intakeColumn,
    status: undefined,
    error: undefined,
    currentStep: 0,
    steps: [],
    size: undefined,
    prInfo: undefined,
    prInfos: undefined,
    tokenUsage: undefined,
    tokenBudgetSoftAlertedAt: undefined,
    tokenBudgetHardAlertedAt: undefined,
    stepReports: [],
    workflowTransitionNotification: undefined,
    worktree: undefined,
    workspaceWorktrees: undefined,
    branch: undefined,
    executionStartBranch: undefined,
    baseCommitSha: undefined,
    blockedBy: undefined,
    overlapBlockedBy: undefined,
    queuedLogEpisodeSignature: undefined,
    paused: false,
    userPaused: false,
    pausedReason: undefined,
    externalBlock: undefined,
    pausedByAgentId: undefined,
    checkedOutBy: undefined,
    checkedOutAt: undefined,
    checkoutNodeId: undefined,
    checkoutRunId: undefined,
    checkoutLeaseRenewedAt: undefined,
    sessionFile: undefined,
    effectiveNodeId: undefined,
    effectiveNodeSource: undefined,
    executionStartedAt: undefined,
    executionCompletedAt: undefined,
    planningStartedAt: undefined,
    summary: undefined,
    review: undefined,
    reviewState: undefined,
    workflowStepResults: [],
    mergeDetails: undefined,
    awaitingApprovalReason: undefined,
    approvedPlanFingerprint: undefined,
    modifiedFiles: [],
    declaredSymbols: [],
    scopeAutoWiden: [],
    stuckKillCount: 0,
    mergeRetries: undefined,
    aiMergeReviewReconciliation: undefined,
    workflowStepRetries: undefined,
    resumeLimboCount: 0,
    executeRequeueLoopCount: 0,
    executeRequeueLoopSignature: undefined,
    graphResumeRetryCount: 0,
    consecutiveToolFailureRetryCount: 0,
    executorEscalationAttempted: false,
    toolFailureDetectorLogCursor: 0,
    toolFailureRetryExhaustedAuditEmitted: false,
    resumeLimboTipSha: undefined,
    resumeLimboStepSignature: undefined,
    postReviewFixCount: 0,
    planReviewReplanCount: 0,
    recoveryRetryCount: undefined,
    sessionContentionHoldCount: 0,
    sessionContentionWaitReason: undefined,
    taskDoneRetryCount: 0,
    bulkCompletionRefusalAt: undefined,
    worktreeSessionRetryCount: 0,
    completionHandoffLimboRecoveryCount: 0,
    verificationFailureCount: 0,
    mergeConflictBounceCount: 0,
    mergeAuditBounceCount: 0,
    mergeTransientRetryCount: 0,
    branchConflictRecoveryCount: 0,
    reviewerContextRetryCount: 0,
    reviewerFallbackRetryCount: 0,
    reviewConvergenceStage: 0,
    reviewConvergenceEscalationCount: 0,
    nextRecoveryAt: undefined,
    workflowIrPin: undefined,
    workflowIrPinNodeId: undefined,
    workflowIrPinColumnId: undefined,
    columnMovedAt: now,
    updatedAt: now,
  };
}

/** @internal Runtime assertion for the committed reset publication contract. */
export function assertResetTask(
  task: Task,
  intakeColumn: ColumnId,
  expectedDescription?: string,
): void {
  if (task.column !== intakeColumn || task.status !== undefined) {
    throw new Error("Reset publication returned a task outside its resolved fresh-planning state");
  }
  if (task.steps.length > 0) {
    throw new Error("Reset publication returned a task with retained plan steps");
  }
  if (
    task.size != null || task.prInfo != null || (task.prInfos?.length ?? 0) > 0
    || task.tokenUsage != null || task.tokenBudgetSoftAlertedAt != null || task.tokenBudgetHardAlertedAt != null
    || (task.stepReports?.length ?? 0) > 0 || task.workflowTransitionNotification != null
  ) {
    throw new Error("Reset publication returned stale per-run presentation state");
  }
  if (task.description !== expectedDescription) {
    throw new Error("Reset publication returned a task without the expected description");
  }
  if (
    task.worktree != null || task.branch != null || task.sessionFile != null
    || task.checkedOutBy != null || task.workflowIrPin != null || task.workflowStepResults?.length
    || task.review != null || task.reviewState != null || task.awaitingApprovalReason != null || task.externalBlock != null
    || Object.keys(task.workspaceWorktrees ?? {}).length > 0
  ) {
    throw new Error("Reset publication returned stale execution or review state");
  }
}

export async function resetTaskPublicationImpl(
  store: TaskStore,
  taskId: string,
  intakeColumn: ColumnId,
  options?: ResetTaskPublicationOptions,
): Promise<Task> {
  const layer = store.asyncLayer;
  if (!layer) {
    throw new Error("Atomic task reset publication requires the PostgreSQL backend");
  }
  const projectId = layer.projectId;
  const beforeReset = await store.getTask(taskId);
  if (!beforeReset) throw new Error(`Task ${taskId} not found`);
  const symbols = resolveTaskSymbolsForTask(beforeReset);
  /*
  FNXC:TaskReset 2026-08-22-04:45:
  Symbol release is intentionally before publication: it owns a separate transaction, while publication clears declaredSymbols. Releasing preserves audit history instead of leaking held rows until expiry.
  */
  if (store.backendMode && symbols.resolvable) await store.releaseSymbolLocks(symbols.symbols, taskId);
  let published!: Task;

  await layer.transactionImmediate(async (tx) => {
    await acquireTaskAdvisoryXactLock(tx, projectId, taskId);
    await withTaskWorkflowSerialization(tx, projectId, taskId, async () => {
      const currentRow = await readTaskRowInTransaction(tx, taskId, undefined, projectId);
      if (!currentRow) throw new Error(`Task ${taskId} not found`);
      const current = store.rowToTask(store.pgRowToTaskRow(currentRow));
      const scope = projectScopeFor(schema.project.workflowWorkItems.projectId, projectId);
      const active = await tx.select({ id: schema.project.workflowWorkItems.id })
        .from(schema.project.workflowWorkItems)
        .where(and(
          scope,
          eq(schema.project.workflowWorkItems.taskId, taskId),
          eq(schema.project.workflowWorkItems.kind, "task"),
          inArray(schema.project.workflowWorkItems.state, [...ACTIVE_TASK_CONTINUATION_STATES]),
        ));
      if (active.length > 0) {
        await tx.update(schema.project.workflowWorkItems)
          .set({ state: "cancelled", leaseOwner: null, leaseExpiresAt: null, updatedAt: new Date().toISOString() })
          .where(and(scope, inArray(schema.project.workflowWorkItems.id, active.map((row) => row.id))));
      }
      await resetPublicationFailureForTesting?.();
      const documentScope = projectScopeFor(schema.project.taskDocuments.projectId, projectId);
      const revisionScope = projectScopeFor(schema.project.taskDocumentRevisions.projectId, projectId);
      const documents = await tx.select({ key: schema.project.taskDocuments.key, author: schema.project.taskDocuments.author })
        .from(schema.project.taskDocuments).where(and(documentScope, eq(schema.project.taskDocuments.taskId, taskId)));
      const revisions = await tx.select({ key: schema.project.taskDocumentRevisions.key, author: schema.project.taskDocumentRevisions.author })
        .from(schema.project.taskDocumentRevisions).where(and(revisionScope, eq(schema.project.taskDocumentRevisions.taskId, taskId)));
      /*
      FNXC:TaskReset 2026-08-22-04:45:
      Reset retains user-authored documents and their complete revision history. Agent-only documents and run projections are discarded, while attachments, spec-locks, commit associations, and audit history remain operator history.
      */
      const userTouchedKeys = new Set([...documents, ...revisions].filter((row) => row.author === "user").map((row) => row.key));
      const removableKeys = documents.filter((row) => !userTouchedKeys.has(row.key)).map((row) => row.key);
      if (removableKeys.length) {
        await tx.delete(schema.project.taskDocumentRevisions).where(and(revisionScope, eq(schema.project.taskDocumentRevisions.taskId, taskId), inArray(schema.project.taskDocumentRevisions.key, removableKeys)));
        await tx.delete(schema.project.taskDocuments).where(and(documentScope, eq(schema.project.taskDocuments.taskId, taskId), inArray(schema.project.taskDocuments.key, removableKeys)));
      }
      await tx.delete(schema.project.currentPlanEvidence).where(and(projectScopeFor(schema.project.currentPlanEvidence.projectId, projectId), eq(schema.project.currentPlanEvidence.taskId, taskId)));
      await tx.delete(schema.project.specDriftReports).where(and(projectScopeFor(schema.project.specDriftReports.projectId, projectId), eq(schema.project.specDriftReports.taskId, taskId)));
      await tx.delete(schema.project.taskVerificationRequests).where(and(projectScopeFor(schema.project.taskVerificationRequests.projectId, projectId), eq(schema.project.taskVerificationRequests.taskId, taskId)));
      await tx.delete(schema.project.unplannedExecutionBlocks).where(and(projectScopeFor(schema.project.unplannedExecutionBlocks.projectId, projectId), eq(schema.project.unplannedExecutionBlocks.taskId, taskId)));
      await tx.delete(schema.project.completionHandoffMarkers).where(and(projectScopeFor(schema.project.completionHandoffMarkers.projectId, projectId), eq(schema.project.completionHandoffMarkers.taskId, taskId)));
      await tx.delete(schema.project.mergeQueue).where(and(projectScopeFor(schema.project.mergeQueue.projectId, projectId), eq(schema.project.mergeQueue.taskId, taskId)));
      await tx.delete(schema.project.mergeRequests).where(and(projectScopeFor(schema.project.mergeRequests.projectId, projectId), eq(schema.project.mergeRequests.taskId, taskId)));
      /*
      FNXC:TaskReset 2026-08-27-22:20:
      Reset clears workspace acquire leases and land intents in the same publication transaction.
      A retained acquire lease would make the next dispatch raise WorkspaceRepoAcquireBusyError until
      TTL expiry, while a retained pending land intent could revive partial-land recovery for worktrees
      the reset no longer owns.
      */
      await tx.delete(schema.project.workspaceLandIntents).where(and(
        projectScopeFor(schema.project.workspaceLandIntents.projectId, projectId),
        eq(schema.project.workspaceLandIntents.taskId, taskId),
      ));
      await tx.delete(schema.project.workspaceCoordinationLeases).where(and(
        projectScopeFor(schema.project.workspaceCoordinationLeases.projectId, projectId),
        eq(schema.project.workspaceCoordinationLeases.ownerTaskId, taskId),
      ));
      await tx.delete(schema.project.artifacts).where(and(
        projectScopeFor(schema.project.artifacts.projectId, projectId), eq(schema.project.artifacts.taskId, taskId),
        sql`coalesce(${schema.project.artifacts.metadata}->>'source', '') <> 'attachment'`,
      ));
      await tx.delete(schema.project.workflowRunStepInstances).where(and(
        projectScopeFor(schema.project.workflowRunStepInstances.projectId, projectId),
        eq(schema.project.workflowRunStepInstances.taskId, taskId),
      ));
      await tx.delete(schema.project.workflowRunBranches).where(and(
        projectScopeFor(schema.project.workflowRunBranches.projectId, projectId),
        eq(schema.project.workflowRunBranches.taskId, taskId),
      ));

      const expectedDescription = resolveResetDescription(current.description, options?.description);
      const next = buildResetTask(current, intakeColumn, options);
      await upsertTaskRowInTransaction(
        tx,
        next as unknown as Record<string, unknown>,
        store.createTaskPersistSerializationContext(next, currentRow as never),
        projectId,
      );
      const committedRow = await readTaskRowInTransaction(tx, taskId, undefined, projectId);
      if (!committedRow) throw new Error(`Task ${taskId} disappeared during reset publication`);
      published = store.rowToTask(store.pgRowToTaskRow(committedRow));
      assertResetTask(published, intakeColumn, expectedDescription);
    });
  });

  // PostgreSQL is authoritative. The compatibility task.json mirror is repaired best-effort after commit.
  try {
    await store.atomicWriteTaskJson(store.taskDir(taskId), published);
  } catch (error) {
    resetLog.warn(`[reset] committed PostgreSQL reset but task.json mirroring failed for ${taskId}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (store.isWatching) store.taskCache.set(taskId, { ...published });
  store.emitTaskLifecycleEventSafely("task:updated", [published]);
  return published;
}