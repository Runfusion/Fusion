import { and, eq, inArray, sql } from "drizzle-orm";
import type { ColumnId, Task, TaskStep } from "../types.js";
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

function pendingSteps(steps: TaskStep[]): TaskStep[] {
  return steps.map((step) => ({ ...step, status: "pending" }));
}

/*
FNXC:TaskReset 2026-08-19-06:30:
The reset publisher is the single durable fresh-planning boundary. It re-reads the project-scoped row under the task and workflow locks, retires graph continuations and foreach instances, then writes pending steps, cleared execution/review state, `needs-replan`, and the resolved intake column in one transaction. Filesystem cleanup and runtime cancellation happen before this function; no route-level step, move, or pin writes may be interleaved.
*/
function buildResetTask(task: Task, intakeColumn: ColumnId): Task {
  const now = new Date().toISOString();
  return {
    ...task,
    column: intakeColumn,
    status: "needs-replan",
    error: undefined,
    currentStep: 0,
    steps: pendingSteps(task.steps),
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

function assertResetTask(task: Task, intakeColumn: ColumnId): void {
  if (task.column !== intakeColumn || task.status !== "needs-replan") {
    throw new Error("Reset publication returned a task outside its resolved intake state");
  }
  if (task.steps.some((step) => step.status !== "pending")) {
    throw new Error("Reset publication returned a task with a non-pending step");
  }
  if (
    task.worktree != null || task.branch != null || task.sessionFile != null
    || task.checkedOutBy != null || task.workflowIrPin != null || task.workflowStepResults?.length
    || task.review != null || task.reviewState != null || task.awaitingApprovalReason != null
  ) {
    throw new Error("Reset publication returned stale execution or review state");
  }
}

export async function resetTaskPublicationImpl(
  store: TaskStore,
  taskId: string,
  intakeColumn: ColumnId,
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

      const next = buildResetTask(current, intakeColumn);
      await upsertTaskRowInTransaction(
        tx,
        next as unknown as Record<string, unknown>,
        store.createTaskPersistSerializationContext(next, currentRow as never),
        projectId,
      );
      const committedRow = await readTaskRowInTransaction(tx, taskId, undefined, projectId);
      if (!committedRow) throw new Error(`Task ${taskId} disappeared during reset publication`);
      published = store.rowToTask(store.pgRowToTaskRow(committedRow));
      assertResetTask(published, intakeColumn);
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