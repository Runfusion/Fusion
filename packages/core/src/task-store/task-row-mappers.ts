/**
 * Task/PR/merge-queue row mappers and slim select serialization.
 *
 * FNXC:StoreModularization 2026-06-25-00:00:
 * Extracted from the monolithic packages/core/src/store.ts as a pure
 * behavior-preserving refactor. Each function receives the TaskStore
 * instance as its first parameter and performs byte-identical work.
 *
 * FNXC:CodeOrganization 2026-07-16-12:00:
 * Renamed from remaining-ops-3.ts (domain name: row mappers + persist select).
 */
import {TaskStore} from "../store.js";
import {TaskDeletedError} from "./errors.js";
import {randomUUID} from "node:crypto";
import {mkdir, writeFile, rename, unlink} from "node:fs/promises";
import {join} from "node:path";
import type {Task, RunAuditEvent, MergeQueueEntry, MergeRequestRecord, CompletionHandoffMarker, WorkflowWorkItem, PrEntity, PrConflictState, PrChecksRollup, PrReviewDecision} from "../types.js";
import "../builtin-traits.js";
import {normalizeTaskPriority} from "../task-priority.js";
import {fromJson} from "../db.js";
import {generateTaskLineageId} from "../task-lineage.js";
import {type TaskRow, type TaskPersistSerializationContext, type TaskColumnDescriptor, TASK_COLUMN_DESCRIPTORS, TASK_COLUMN_DESCRIPTOR_BY_COLUMN} from "../task-store/persistence.js";
import {__setTaskActivityLogLimitsForTesting} from "../task-store/comments.js";
import {readTaskRow as readTaskRowAsync} from "../task-store/async-persistence.js";
import {findArchivedTaskEntry} from "../task-store/async-archive-lineage.js";
import type {PrEntityRow, RunAuditEventRow, MergeQueueRow, MergeRequestRow, CompletionHandoffMarkerRow, WorkflowWorkItemRow} from "../task-store/row-types.js";

export function getTaskSelectClauseImpl2(store: TaskStore, slim: boolean, tableAlias?: string): string {
    if (!slim) {
      return tableAlias ? `${tableAlias}.*` : "*";
    }

    const prefix = tableAlias ? `${tableAlias}.` : "";
    return [
      "id", "lineageId", "title", "description", "priority", "\"column\"", "status", "size", "reviewLevel", "currentStep",
      "worktree", "blockedBy", "overlapBlockedBy", "paused", "pausedReason", "userPaused", "baseBranch", "branch", "autoMerge", "autoMergeProvenance", "executionStartBranch", "baseCommitSha",
      "modelPresetId", "modelProvider", "modelId",
      "validatorModelProvider", "validatorModelId",
      "planningModelProvider", "planningModelId", "mergerModelProvider", "mergerModelId",
      "mergeRetries", "workflowStepRetries", "stuckKillCount", "resumeLimboCount", "executeRequeueLoopCount", "graphResumeRetryCount", "consecutiveToolFailureRetryCount", "executorEscalationAttempted", "toolFailureDetectorLogCursor", "toolFailureRetryExhaustedAuditEmitted", "resumeLimboTipSha", "resumeLimboStepSignature", "executeRequeueLoopSignature", "postReviewFixCount", "planReviewReplanCount", "recoveryRetryCount", "taskDoneRetryCount", "bulkCompletionRefusalAt", "worktreeSessionRetryCount", "completionHandoffLimboRecoveryCount", "verificationFailureCount", "mergeConflictBounceCount", "mergeAuditBounceCount", "mergeTransientRetryCount", "branchConflictRecoveryCount", "reviewerContextRetryCount", "reviewerFallbackRetryCount", "nextRecoveryAt",
      "error", "summary", "thinkingLevel", "validatorThinkingLevel", "planningThinkingLevel", "mergerThinkingLevel", "executionMode",
      "tokenUsageInputTokens", "tokenUsageOutputTokens", "tokenUsageCachedTokens", "tokenUsageCacheWriteTokens", "tokenUsageTotalTokens", "tokenUsageFirstUsedAt", "tokenUsageLastUsedAt", "tokenUsageModelProvider", "tokenUsageModelId", "tokenUsagePerModel", "tokenBudgetSoftAlertedAt", "tokenBudgetHardAlertedAt", "tokenBudgetOverride",
      "createdAt", "updatedAt", "columnMovedAt", "firstExecutionAt", "cumulativeActiveMs", "executionStartedAt", "executionCompletedAt",
      "dependencies", "steps", "customFields", "comments", "review", "reviewState", "workflowStepResults", "steeringComments",
      "attachments", "prInfo", "prInfos", "issueInfo", "githubTracking", "sourceIssueProvider", "sourceIssueRepository", "sourceIssueExternalIssueId", "sourceIssueNumber", "sourceIssueUrl", "sourceIssueClosedAt", "mergeDetails", "workspaceWorktrees",
      "breakIntoSubtasks", "noCommitsExpected", "enabledWorkflowSteps", "modifiedFiles",
      "missionId", "sliceId", "scopeOverride", "scopeOverrideReason", "scopeAutoWiden", "assignedAgentId", "pausedByAgentId", "assigneeUserId", "nodeId", "effectiveNodeId", "effectiveNodeSource",
      "sourceType", "sourceAgentId", "sourceRunId", "sourceSessionId", "sourceMessageId", "sourceParentTaskId", "sourceMetadata", "proposalClaimId",
      "checkedOutBy", "checkedOutAt", "checkoutNodeId", "checkoutRunId", "checkoutLeaseRenewedAt", "checkoutLeaseEpoch", "deletedAt", "allowResurrection",
      // FNXC:WorkflowIrPin 2026-07-19-03:10 (U9b / KTD-3): the IR pin and its node entry MUST be
      // in the slim projection — restart recovery and the self-healing sweeps read tasks slim,
      // and a pin absent from the projection reads as "unpinned", which is exactly the
      // drift-blind traversal the pin exists to prevent.
      "workflowIrPin", "workflowIrPinNodeId", "workflowIrPinColumnId",
      // FNXC:LegacyAdoption 2026-07-19-03:10 (U9b / KTD-8): the startup adoption sweep lists tasks
      // slim, so the idempotency stamp must be visible there or every restart re-adopts every row.
      "legacyAdoptedAt",
      // `log` is fetched in slim mode so the server can aggregate
      // `timedExecutionMs` from `[timing] … in <N>ms` entries before
      // returning. The log itself is stripped from the response —
      // see `listTasks()` slim post-processing.
      "log",
    ].map((column) => `${prefix}${column}`).join(", ");
  }

export function createTaskPersistSerializationContextImpl(store: TaskStore, task: Task, existingRow?: Pick<TaskRow, "lineageId">,): TaskPersistSerializationContext {
    return {
      lineageId: task.lineageId ?? existingRow?.lineageId ?? generateTaskLineageId(),
    };
  }

export function getTaskPersistValuesImpl(store: TaskStore, task: Task, existingRow?: Pick<TaskRow, "lineageId">): unknown[] {
    const context = store.createTaskPersistSerializationContext(task, existingRow);
    return TASK_COLUMN_DESCRIPTORS.map((descriptor) => descriptor.serialize(task, context));
  }

export function getTaskPatchDescriptorsImpl(store: TaskStore, changedColumns: Iterable<keyof TaskRow>): TaskColumnDescriptor[] {
    const descriptors: TaskColumnDescriptor[] = [];
    for (const column of changedColumns) {
      const descriptor = TASK_COLUMN_DESCRIPTOR_BY_COLUMN.get(column);
      if (!descriptor) {
        throw new Error(`Unknown task column for partial patch: ${String(column)}`);
      }
      descriptors.push(descriptor);
    }
    return descriptors;
  }

export function normalizeTaskFromDiskImpl(store: TaskStore, task: Task): Task {
    if (!Array.isArray(task.log)) task.log = [];
    if (!Array.isArray(task.dependencies)) task.dependencies = [];
    if (!Array.isArray(task.steps)) task.steps = [];
    task.priority = normalizeTaskPriority(task.priority);
    return task;
  }

export async function writeTaskJsonFileImpl(store: TaskStore, dir: string, task: Task): Promise<void> {
    store.clearStartupSlimListMemo();
    const taskJsonPath = join(dir, "task.json");
    // Use a unique tmp filename per write so concurrent writers to the same task
    // don't race on a shared `task.json.tmp` (one rename consumes it, the other
    // ENOENTs). See FN-4122/FN-4123/FN-4148 for the reproducer.
    const tmpPath = join(dir, `task.json.${process.pid}.${randomUUID()}.tmp`);
    store.suppressWatcher(taskJsonPath);
    await mkdir(dir, { recursive: true });
    await writeFile(tmpPath, JSON.stringify(task));
    try {
      await rename(tmpPath, taskJsonPath);
    } catch (err) {
      // Best-effort cleanup of our tmp on rename failure so we don't leave
      // orphaned `task.json.*.tmp` files behind.
      try {
        await unlink(tmpPath);
      } catch {
        // ignore — tmp may already be gone
      }
      throw err;
    }
  }

export function rowToPrEntityImpl(store: TaskStore, row: PrEntityRow): PrEntity {
    return {
      id: row.id,
      sourceType: row.sourceType,
      sourceId: row.sourceId,
      repo: row.repo,
      headBranch: row.headBranch,
      baseBranch: row.baseBranch ?? undefined,
      state: row.state,
      prNumber: row.prNumber ?? undefined,
      prUrl: row.prUrl ?? undefined,
      headOid: row.headOid ?? undefined,
      mergeable: (row.mergeable as PrConflictState | null) ?? undefined,
      checksRollup: (row.checksRollup as PrChecksRollup | null) ?? undefined,
      reviewDecision: (row.reviewDecision as PrReviewDecision) ?? undefined,
      autoMerge: Boolean(row.autoMerge),
      unverified: Boolean(row.unverified),
      failureReason: row.failureReason ?? undefined,
      responseRounds: row.responseRounds,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      closedAt: row.closedAt ?? undefined,
    };
  }

export function generatePrEntityIdImpl(_store: TaskStore): string {
    const timestamp = Date.now().toString(36).toUpperCase();
    const random = Math.random().toString(36).slice(2, 8).toUpperCase();
    return `PR-${timestamp}-${random}`;
  }

export async function readTaskForMoveImpl(store: TaskStore, id: string): Promise<Task> {
    // FNXC:RuntimeTaskOrchestrationAsync 2026-06-24-15:50:
    // Backend mode: read the task row directly via the async helper (without
    // acquiring the task lock). This method is called INSIDE withTaskLock from
    // moveTask/handoffToReview, so using getTask() (which also acquires the
    // lock) would deadlock. We read the raw row and convert it. Fall back to
    // archive lookup if the task is not in the live table.
    if (store.backendMode) {
      const layer = store.asyncLayer!;
      const pgRow = await readTaskRowAsync(layer, id, { includeDeleted: true });
      if (pgRow) {
        if (pgRow.deletedAt) {
          throw new TaskDeletedError(id, pgRow.deletedAt as string);
        }
        return store.rowToTask(store.pgRowToTaskRow(pgRow));
      }
      // Fall back to archive lookup (soft-deleted/archived tasks).
      const entry = await findArchivedTaskEntry(layer.db, id, layer.projectId);
      if (entry) {
        return store.archiveEntryToTask(entry, false);
      }
      throw new Error(`Task ${id} not found`);
    }
    const dir = store.taskDir(id);
    try {
      return await store.readTaskJson(dir);
    } catch (error) {
      const archived = store.archiveDb.get(id);
      if (!archived) {
        throw error;
      }
      return store.archiveEntryToTask(archived, false);
    }
  }

export function rowToMergeQueueEntryImpl(store: TaskStore, row: MergeQueueRow): MergeQueueEntry {
    return {
      taskId: row.taskId,
      enqueuedAt: row.enqueuedAt,
      priority: normalizeTaskPriority(row.priority),
      leasedBy: row.leasedBy,
      leasedAt: row.leasedAt,
      leaseExpiresAt: row.leaseExpiresAt,
      attemptCount: row.attemptCount,
      lastError: row.lastError,
    };
  }

export function rowToMergeRequestRecordImpl(store: TaskStore, row: MergeRequestRow): MergeRequestRecord {
    return {
      taskId: row.taskId,
      state: store.normalizeMergeRequestState(row.state),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      attemptCount: row.attemptCount,
      lastError: row.lastError,
    };
  }

export function rowToCompletionHandoffMarkerImpl(store: TaskStore, row: CompletionHandoffMarkerRow): CompletionHandoffMarker {
    return {
      taskId: row.taskId,
      acceptedAt: row.acceptedAt,
      source: row.source,
    };
  }

export function rowToWorkflowWorkItemImpl(store: TaskStore, row: WorkflowWorkItemRow): WorkflowWorkItem {
    return {
      id: row.id,
      runId: row.runId,
      taskId: row.taskId,
      nodeId: row.nodeId,
      kind: store.normalizeWorkflowWorkItemKind(row.kind),
      state: store.normalizeWorkflowWorkItemState(row.state),
      attempt: row.attempt,
      retryAfter: row.retryAfter,
      leaseOwner: row.leaseOwner,
      leaseExpiresAt: row.leaseExpiresAt,
      lastError: row.lastError,
      blockedReason: row.blockedReason,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

export function rowToRunAuditEventImpl(store: TaskStore, row: RunAuditEventRow): RunAuditEvent {
    return {
      id: row.id,
      timestamp: row.timestamp,
      taskId: row.taskId || undefined,
      agentId: row.agentId,
      runId: row.runId,
      domain: row.domain as RunAuditEvent["domain"],
      mutationType: row.mutationType,
      target: row.target,
      metadata: fromJson<Record<string, unknown>>(row.metadata),
    };
  }
