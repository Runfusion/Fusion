import { createLogger } from "../logger.js";

const severityAuditLog = createLogger("core-task-mutation-ops");
/**
 * FNXC:CodeOrganization 2026-07-21-12:00:
 * Domain rename from remaining-ops-2: task JSON/config writes, atomic updates, tracking reconcile,
 * attachments, and related mutation helpers.
 *
 * FNXC:StoreModularization 2026-06-25-00:00:
 * Extracted from the monolithic packages/core/src/store.ts as a pure
 * behavior-preserving refactor. Each function receives the TaskStore
 * instance as its first parameter and performs byte-identical work.
 */
import {TaskStore, storeLog} from "../store.js";
import {TaskDeletedError} from "./errors.js";
import type {LegacyAutoMergeStampReconcileResult} from "../store.js";
import {randomUUID} from "node:crypto";
import {mkdir, readFile, writeFile, rename, unlink} from "node:fs/promises";
import {join} from "node:path";
import {existsSync} from "node:fs";
import type {Task, TaskCreateInput, TaskAttachment, BoardConfig, ActivityLogEntry, ActivityEventType, Artifact, ArtifactCreateInput, RunMutationContext, MergeQueueEntry, BranchGroup, BranchGroupUpdate, CompletionHandoffMarker, WorkflowWorkItem, WorkflowWorkItemKind, PrEntity, PrEntityUpdate} from "../types.js";
import {COLUMNS} from "../types.js";
import {resolveEntryColumnId} from "../workflow-reconciliation.js";
import {BUILTIN_CODING_WORKFLOW_IR} from "../builtin-coding-workflow-ir.js";
import {validateSettingValuePatch, WorkflowSettingRejectionError} from "../workflow-settings.js";
import "../builtin-traits.js";
import {toJson} from "../db.js";
import {resolveSameAgentDuplicateIntake} from "./task-creation.js";
import {type TaskRow, TASK_COLUMN_DESCRIPTORS} from "../task-store/persistence.js";
import {__setTaskActivityLogLimitsForTesting} from "../task-store/comments.js";
import {assertSafeGitBranchName} from "../task-store/shell-safety.js";
import {readTaskRow as readTaskRowAsync, readTaskRowInTransaction} from "../task-store/async-persistence.js";
import {upsertArchivedTaskEntry} from "./async-archive-lineage.js";
import {purgeTaskWorkflowSelectionRowsAsyncImpl} from "./workflow-definitions.js";
import * as schema from "../postgres/schema/index.js";
import {and, asc, eq, isNotNull, isNull, sql} from "drizzle-orm";
import {recoverExpiredMergeQueueLeases as recoverExpiredMergeQueueLeasesAsync} from "../task-store/async-merge-coordination.js";
import {updateBranchGroup as updateBranchGroupAsync, updatePrEntity as updatePrEntityAsync} from "../task-store/async-branch-groups.js";
import {recordCompletionHandoff as recordCompletionHandoffAsync, getCompletionHandoffMarker as getCompletionHandoffMarkerAsync} from "../task-store/async-workflow-workitems.js";
import { taskProjectScope } from "../postgres/data-layer.js";
import {getActivityLog as getActivityLogAsync} from "../task-store/async-audit.js";
import {insertArtifactRow as insertArtifactRowAsync} from "../task-store/async-comments-attachments.js";
import {appendConfigurationRevision, createConfigurationRevision, getConfigurationRevision, rollbackConfiguration} from "../async-configuration-revision-store.js";
import {readProjectConfig, writeProjectConfig} from "./async-settings.js";
import {publishSettingsUpdated} from "./settings-ops.js";
import type {ConfigChangedBy, ConfigurationRevision} from "../types.js";

export function getTaskSelectClauseWithActivityLogLimitImpl(store: TaskStore, limit: number): string {
    const columns = [
      "id", "lineageId", "title", "description", "priority", "\"column\"", "status", "size", "reviewLevel", "currentStep",
      "worktree", "blockedBy", "overlapBlockedBy", "paused", "pausedReason", "userPaused", "baseBranch", "branch", "autoMerge", "autoMergeProvenance", "executionStartBranch", "baseCommitSha",
      "modelPresetId", "modelProvider", "modelId",
      "validatorModelProvider", "validatorModelId",
      "planningModelProvider", "planningModelId", "mergerModelProvider", "mergerModelId",
      "mergeRetries", "workflowStepRetries", "stuckKillCount", "resumeLimboCount", "executeRequeueLoopCount", "graphResumeRetryCount", "consecutiveToolFailureRetryCount", "executorEscalationAttempted", "toolFailureDetectorLogCursor", "toolFailureRetryExhaustedAuditEmitted", "resumeLimboTipSha", "resumeLimboStepSignature", "executeRequeueLoopSignature", "postReviewFixCount", "planReviewReplanCount", "recoveryRetryCount", "taskDoneRetryCount", "bulkCompletionRefusalAt", "worktreeSessionRetryCount", "completionHandoffLimboRecoveryCount", "verificationFailureCount", "mergeConflictBounceCount", "mergeAuditBounceCount", "mergeTransientRetryCount", "branchConflictRecoveryCount", "reviewerContextRetryCount", "reviewerFallbackRetryCount", "nextRecoveryAt",
      // FNXC:WorkflowIrPin 2026-07-19-03:10 (U9b / KTD-3 + KTD-8): this projection is a SECOND
      // copy of the slim column list (see getTaskSelectClauseImpl2). The IR pin, its node entry,
      // and the adoption stamp must appear in BOTH or a task read through this path reads as
      // unpinned/never-adopted and gets re-adopted or traversed drift-blind.
      "workflowIrPin", "workflowIrPinNodeId", "workflowIrPinColumnId", "legacyAdoptedAt",
      "error", "summary", "thinkingLevel", "validatorThinkingLevel", "planningThinkingLevel", "mergerThinkingLevel", "executionMode",
      "tokenUsageInputTokens", "tokenUsageOutputTokens", "tokenUsageCachedTokens", "tokenUsageCacheWriteTokens", "tokenUsageTotalTokens", "tokenUsageFirstUsedAt", "tokenUsageLastUsedAt", "tokenUsageModelProvider", "tokenUsageModelId", "tokenUsagePerModel", "tokenBudgetSoftAlertedAt", "tokenBudgetHardAlertedAt", "tokenBudgetOverride",
      "createdAt", "updatedAt", "columnMovedAt", "firstExecutionAt", "cumulativeActiveMs", "cumulativePlanningMs", "planningStartedAt", "executionStartedAt", "executionCompletedAt",
      "dependencies", "steps", "customFields", "attachments", "steeringComments",
      "comments", "review", "reviewState", "workflowStepResults", "prInfo", "prInfos", "issueInfo", "githubTracking", "sourceIssueProvider", "sourceIssueRepository", "sourceIssueExternalIssueId", "sourceIssueNumber", "sourceIssueUrl", "sourceIssueClosedAt", "mergeDetails", "workspaceWorktrees",
      "breakIntoSubtasks", "noCommitsExpected", "enabledWorkflowSteps", "modifiedFiles", "declaredSymbols",
      "missionId", "sliceId", "scopeOverride", "scopeOverrideReason", "scopeAutoWiden", "assignedAgentId", "pausedByAgentId", "assigneeUserId", "nodeId", "effectiveNodeId", "effectiveNodeSource",
      "sourceType", "sourceAgentId", "sourceRunId", "sourceSessionId", "sourceMessageId", "sourceParentTaskId", "sourceMetadata",
      "checkedOutBy", "checkedOutAt", "checkoutNodeId", "checkoutRunId", "checkoutLeaseRenewedAt", "checkoutLeaseEpoch", "deletedAt", "allowResurrection",
    ];

    const limitedLog = `
      CASE
        WHEN json_valid(log) AND json_array_length(log) > ${limit} THEN (
          SELECT json_group_array(json(value))
          FROM (
            SELECT value
            FROM (
              SELECT key, value
              FROM json_each(tasks.log)
              ORDER BY key DESC
              LIMIT ${limit}
            )
            ORDER BY key ASC
          )
        )
        ELSE log
      END AS log
    `;

    return [...columns, limitedLog].join(", ");
  }

export function getChangedTaskColumnsImpl(store: TaskStore, existingRow: TaskRow, task: Task): Set<keyof TaskRow> {
    const nextValues = store.getTaskPersistValues(task, existingRow);
    const changedColumns = new Set<keyof TaskRow>();
    for (const [index, descriptor] of TASK_COLUMN_DESCRIPTORS.entries()) {
      if (descriptor.column === "updatedAt") {
        continue;
      }
      if (!Object.is(existingRow[descriptor.column], nextValues[index])) {
        changedColumns.add(descriptor.column);
      }
    }
    return changedColumns;
  }

export function getSoftDeletedWriteConflictImpl(store: TaskStore, id: string, task: Task, existingRow?: TaskRow): string | undefined {
    const existing = existingRow ?? store.readTaskRowFromDb(id, { includeDeleted: true });
    if (!existing?.deletedAt || task.deletedAt !== undefined) {
      return undefined;
    }
    return existing.deletedAt;
  }

export async function readTaskJsonImpl(store: TaskStore, dir: string): Promise<Task> {
    const id = store.getTaskIdFromDir(dir);

    /*
    FNXC:SqliteDualPathCleanup 2026-07-26-14:30:
    readTaskJson is PostgreSQL + task.json only. The SQLite store.readTaskFromDb arm is deleted.
    Read the task row via async helper without acquiring withTaskLock (callers often already hold it; getTask would deadlock).
    File-system task.json remains the fallback when no live DB row exists (not SQLite authority).
    FNXC:RuntimeTaskOrchestrationAsync 2026-06-24-15:40: same lock/deadlock constraint as before.
    */
    const layer = store.asyncLayer!;
    const pgRow = await readTaskRowAsync(layer, id, { includeDeleted: true });
    if (pgRow) {
      if (pgRow.deletedAt) {
        throw new TaskDeletedError(id, pgRow.deletedAt as string);
      }
      return store.rowToTask(store.pgRowToTaskRow(pgRow));
    }
    const filePath = join(dir, "task.json");
    const raw = await readFile(filePath, "utf-8");
    try {
      return store.normalizeTaskFromDisk(JSON.parse(raw) as Task);
    } catch (err) {
      throw new Error(
        `Failed to parse task.json at ${filePath}: ${(err as Error).message}`,
      );
    }
  }

export async function writeConfigImpl(store: TaskStore, config: BoardConfig, options?: { nextWorkflowStepId?: number },): Promise<void> {
    const now = new Date().toISOString();
    const row = store.db
      .prepare("SELECT nextWorkflowStepId FROM config WHERE id = 1")
      .get() as { nextWorkflowStepId?: number } | undefined;
    const nextWorkflowStepId = options?.nextWorkflowStepId ?? row?.nextWorkflowStepId ?? 1;

    const legacyWorkflowSteps = (config as { workflowSteps?: unknown }).workflowSteps;
    const workflowStepsJson = Array.isArray(legacyWorkflowSteps)
      ? JSON.stringify(legacyWorkflowSteps)
      : "[]";

    // `config.nextId` is deprecated legacy state. Preserve the existing column
    // value for one release, but stop writing new values so distributed_task_id_state
    // remains the sole active allocator counter.
    store.db.prepare(
      `INSERT INTO config (id, nextWorkflowStepId, settings, workflowSteps, updatedAt)
       VALUES (1, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         nextWorkflowStepId = excluded.nextWorkflowStepId,
         settings = excluded.settings,
         workflowSteps = excluded.workflowSteps,
         updatedAt = excluded.updatedAt`,
    ).run(
      nextWorkflowStepId,
      JSON.stringify(config.settings || {}),
      workflowStepsJson,
      now,
    );
    store.db.bumpLastModified();
    // Also write config.json to disk for backward compatibility
    try {
      const tmpPath = store.configPath + ".tmp";
      await writeFile(tmpPath, store.serializeConfigForDisk(config));
      await rename(tmpPath, store.configPath);
    } catch (err) {
      // Best-effort: SQLite is the primary store
      storeLog.warn("Backward-compat config.json sync failed after config write", {
        phase: "writeConfig:disk-sync",
        configPath: store.configPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

export async function _maybeAutoArchiveSameAgentDuplicateBackendImpl(store: TaskStore, task: Task, input: TaskCreateInput,): Promise<void> {
  // Keep the production backend as wiring only: policy lives in the shared resolver.
  return resolveSameAgentDuplicateIntake(store, task, input);
}

export async function updateBranchGroupImpl(store: TaskStore, id: string, patch: BranchGroupUpdate): Promise<BranchGroup> {
        const layer = store.asyncLayer!;
    return updateBranchGroupAsync(layer.db, id, patch);
}

export async function updatePrEntityImpl(store: TaskStore, id: string, patch: PrEntityUpdate): Promise<PrEntity> {
        const layer = store.asyncLayer!;
    return updatePrEntityAsync(layer.db, id, patch);
}

export async function listTasksForGithubTrackingReconcileImpl(store: TaskStore, options?: { offset?: number; limit?: number }): Promise<{ tasks: Task[]; hasMore: boolean }> {
    const reconcileScanLimit = 200;
    const offset = Math.max(0, options?.offset ?? 0);
    const limit = Math.max(0, options?.limit ?? reconcileScanLimit);
    /*
    FNXC:PostgresCutover 2026-07-04:
    Backend-mode GitHub-tracking reconcile via async Drizzle. Mirrors the
    SQLite path's two concerns: (1) count + paginate soft-deleted tasks that
    carry githubTracking, ordered by updatedAt ASC (FN-5577 bypasses the
    active-tasks filter intentionally), and (2) hydrate each row through the
    shared pgRowToTaskRow + rowToTask pipeline, then strip the log payload
    (the reconcile only needs identity + tracking fields). The archived-tasks
    fallback is a separate async subsystem (AsyncArchiveLineage) not wired
    through the sync archiveDb, so it is skipped in backend mode.
    */
        const layer = store.asyncLayer!;
    /*
    FNXC:SqliteDualPathCleanup 2026-07-26-15:00:
    Project-scope GitHub-tracking reconcile so soft-deleted rows from other projects are not scanned.
    */
    const trackedDeletedFilter = and(
      isNotNull(schema.project.tasks.deletedAt),
      isNotNull(schema.project.tasks.githubTracking),
      taskProjectScope(layer),
    );
    const countRows = await layer.db
      .select({ count: sql<number>`count(*)` })
      .from(schema.project.tasks)
      .where(trackedDeletedFilter);
    const deletedCount = Number(countRows[0]?.count ?? 0);
    const deletedOffset = Math.min(offset, deletedCount);
    const deletedRowsRaw = await layer.db
      .select()
      .from(schema.project.tasks)
      .where(trackedDeletedFilter)
      .orderBy(asc(schema.project.tasks.updatedAt))
      .limit(limit)
      .offset(deletedOffset);
    const deletedTasks = deletedRowsRaw.map((row) => {
      const task = store.rowToTask(store.pgRowToTaskRow(row as unknown as Record<string, unknown>));
      task.timedExecutionMs = store.computeTimedExecutionMs(task.log);
      task.log = [];
      return task;
    });
    const totalCount = deletedCount;
    const hasMore = offset + limit < totalCount;
    return { tasks: deletedTasks, hasMore };
}

/**
 * FNXC:GitLabTracking 2026-07-02-00:00:
 * GitLab-tracking reconcile, cloned from listTasksForGithubTrackingReconcileImpl
 * with githubTracking → gitlabTracking. Returns soft-deleted tasks carrying
 * gitlab_tracking JSONB, paginated by updatedAt ASC. Archived tasks are skipped
 * in backend mode (AsyncArchiveLineage is a separate async subsystem).
 */
export async function listTasksForGitlabTrackingReconcileImpl(store: TaskStore, options?: { offset?: number; limit?: number }): Promise<{ tasks: Task[]; hasMore: boolean }> {
    const reconcileScanLimit = 200;
    const offset = Math.max(0, options?.offset ?? 0);
    const limit = Math.max(0, options?.limit ?? reconcileScanLimit);

    /*
    FNXC:SqliteDualPathCleanup 2026-07-26-14:32:
    GitLab tracking reconcile is PostgreSQL-only; the non-backend throw arm is deleted.
    */
    const layer = store.asyncLayer!;
    /*
    FNXC:SqliteDualPathCleanup 2026-07-26-15:00:
    Project-scope GitLab-tracking reconcile.
    */
    const trackedDeletedFilter = and(
      isNotNull(schema.project.tasks.gitlabTracking),
      isNotNull(schema.project.tasks.deletedAt),
      taskProjectScope(layer),
    );
    const countRows = await layer.db
      .select({ count: sql<number>`count(*)` })
      .from(schema.project.tasks)
      .where(trackedDeletedFilter);
    const deletedCount = Number(countRows[0]?.count ?? 0);
    const deletedOffset = Math.min(offset, deletedCount);
    const deletedRowsRaw = await layer.db
      .select()
      .from(schema.project.tasks)
      .where(trackedDeletedFilter)
      .orderBy(asc(schema.project.tasks.updatedAt))
      .limit(limit)
      .offset(deletedOffset);
    const deletedTasks = deletedRowsRaw.map((row) => {
      const raw = row as unknown as Record<string, unknown>;
      // FNXC:GitLabTracking 2026-07-16-05:36: rowToTask now hydrates GitLab
      // tracking through the shared persistence registry, so reconcile uses
      // the same authoritative mapper as every other live-task read.
      const task = store.rowToTask(store.pgRowToTaskRow(raw));
      task.timedExecutionMs = store.computeTimedExecutionMs(task.log);
      task.log = [];
      return task;
    });
    const totalCount = deletedCount;
    const hasMore = offset + limit < totalCount;
    return { tasks: deletedTasks, hasMore };
  }

export async function listTasksModifiedSinceImpl2(store: TaskStore, since: string, limit?: number, opts?: { includeArchived?: boolean },): Promise<{ tasks: Task[]; hasMore: boolean }> {
    /*
    FNXC:SqliteFinalRemoval 2026-06-25-10:45:
    DEPRECATED stub. The real implementation is listTasksModifiedSinceImpl in
    reads.ts. This previously delegated back to store.listTasksModifiedSince,
    causing infinite recursion. It is retained only for backward-compat with
    any external import; new code MUST use listTasksModifiedSinceImpl directly
    or the TaskStore.listTasksModifiedSince facade.
    */
    return store.listTasksModifiedSince(since, limit, opts);
  }

export async function renewCheckoutLeaseImpl(store: TaskStore, taskId: string, update: { checkoutRunId: string | null; checkoutLeaseRenewedAt: string; },): Promise<Task> {
    /*
     * FNXC:SqliteFinalRemoval 2026-06-26:
     * P1 fix: no backendMode branch existed, so checkout lease renewal threw in
     * PG mode, silently escalating to checkout expiry during active execution.
     * In backend mode, read-check-update inside a transactionImmediate so the
     * soft-delete resurrection guard (R7) and the active-task filter both hold.
     */
        const layer = store.asyncLayer!;
    const dir = store.taskDir(taskId);
    const outcome = await layer.transactionImmediate(async (tx) => {
      const row = await readTaskRowInTransaction(tx, taskId, { includeDeleted: true }, layer.projectId);
      if (row?.deletedAt) {
        return { deletedAt: row.deletedAt as string, current: undefined };
      }
      const result = await tx
        .update(schema.project.tasks)
        .set({
          checkoutRunId: update.checkoutRunId,
          checkoutLeaseRenewedAt: update.checkoutLeaseRenewedAt,
          updatedAt: update.checkoutLeaseRenewedAt,
        })
        .where(and(eq(schema.project.tasks.id, taskId), isNull(schema.project.tasks.deletedAt)));
      if (result.length === 0) {
        return { deletedAt: undefined, current: undefined };
      }
      const fresh = await readTaskRowInTransaction(tx, taskId, undefined, layer.projectId);
      return { deletedAt: undefined, current: fresh };
    });

    if (outcome.deletedAt) {
      store.throwSoftDeletedWriteBlocked(taskId, outcome.deletedAt, "renewCheckoutLease", {
        timestamp: update.checkoutLeaseRenewedAt,
      });
    }
    if (!outcome.current) {
      throw new Error(`Task ${taskId} not found`);
    }
    const current = store.rowToTask(store.pgRowToTaskRow(outcome.current));
    await store.writeTaskJsonFile(dir, current);
    if (store.isWatching) {
      store.taskCache.set(taskId, { ...current });
    }
    store.emitTaskLifecycleEventSafely("task:updated", [current]);
    return current;
}

export async function updateTaskAtomicImpl(store: TaskStore, id: string, updater: ( current: Task, ) => Parameters<TaskStore["updateTask"]>[1] | null | undefined | Promise<Parameters<TaskStore["updateTask"]>[1] | null | undefined>, runContext?: RunMutationContext,): Promise<Task> {
    return store.withTaskLock(id, async () => {
      const current = await store.readTaskJson(store.taskDir(id));
      const updates = await updater(current);
      if (!updates || Object.values(updates).every((value) => value === undefined)) {
        return current;
      }
      return store.updateTaskUnlocked(id, updates, runContext);
    });
  }

export function getWorkflowPromptOverridesImpl(_store: TaskStore, _workflowId: string, _projectId: string): Record<string, string> {
    /*
     * FNXC:SqliteFinalRemoval 2026-06-26:
     * P1 fix: no backendMode branch existed, so this threw in PG mode. In
     * backend mode, sync reads of workflow_prompt_overrides are not possible.
     * Return empty (the default); the async `updateWorkflowPromptOverrides`
     * path reads the real values via Drizzle before merging. The sync
     * applyBuiltInPromptOverridesSync path (used by resolveTaskWorkflowIrSync)
     * thus applies no overrides in backend mode — overrides are applied by the
     * async getWorkflowDefinition path instead.
     */
        return {};
}

export async function updateWorkflowSettingValuesImpl(store: TaskStore, workflowId: string, projectId: string, patch: Record<string, unknown>, changedBy: ConfigChangedBy = { kind: "human", id: "local-user" },): Promise<Record<string, unknown>> {
    /*
    FNXC:ConfigVersioning 2026-07-18-19:10:
    Workflow values are rollbackable only with the PostgreSQL target mutation
    and revision in one transaction. Reject the legacy SQLite writer before it
    can persist an unjournaled configuration change.
    */
    if (!store.backendMode) throw new Error("Workflow configuration changes require the PostgreSQL revision store");
    /*
    FNXC:ConfigVersioning 2026-07-18-12:15:
    Preserve the established SQLite workflow-value writer for compatibility.
    PostgreSQL installations take the transaction-backed journal branch below;
    legacy projects retain their supported write behavior during migration.
    */
    const declarations = await store.resolveWorkflowSettingDeclarations(workflowId);
    const result = validateSettingValuePatch(declarations, patch);
    if (result.rejections.length > 0) {
      // Invalid values are NEVER persisted — fail the whole write loudly.
      throw new WorkflowSettingRejectionError(result.rejections);
    }

    // Read-merge-upsert must be atomic: two concurrent calls for the same
    // (workflowId, projectId) could otherwise both merge from the same
    // pre-update snapshot, and the later upsert would erase the earlier
    // call's keys (lost update). Serialize the whole cycle under an immediate
    // write transaction. Validation/declaration resolution above stays outside
    // since it's async and doesn't read the row being mutated.
    /*
     * FNXC:WorkflowModelLanes 2026-07-14-16:26:
     * PostgreSQL workflow setting patches must read and write the existing JSONB row through the same transaction handle. The synchronous backend getter intentionally returns an empty default; using it here erased every previously saved model lane whenever another lane was patched.
     */
        const layer = store.asyncLayer!;
    const committed = await layer.transactionImmediate(async (tx) => {
      const rows = await tx
        .select({ values: schema.project.workflowSettings.values })
        .from(schema.project.workflowSettings)
        .where(and(
          eq(schema.project.workflowSettings.workflowId, workflowId),
          eq(schema.project.workflowSettings.projectId, projectId),
        ))
        .limit(1);
      const rawCurrent = rows[0]?.values;
      const current = rawCurrent && typeof rawCurrent === "object" && !Array.isArray(rawCurrent)
        ? rawCurrent as Record<string, unknown>
        : {};
      const next: Record<string, unknown> = { ...current };
      for (const [key, value] of Object.entries(result.accepted)) {
        if (value === null) {
          delete next[key];
        } else {
          next[key] = value;
        }
      }

      const now = new Date().toISOString();
      await tx
        .insert(schema.project.workflowSettings)
        .values({
          workflowId,
          projectId,
          values: next,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [schema.project.workflowSettings.workflowId, schema.project.workflowSettings.projectId],
          set: {
            values: next,
            updatedAt: now,
          },
        });
      /* FNXC:ConfigVersioning 2026-07-18-00:00: workflow values and their revision commit together. */
      const revision = createConfigurationRevision({
        projectId,
        ownerScope: "project",
        configKind: "workflow-settings",
        configTarget: { workflowId, projectId },
        before: current,
        after: next,
        changedBy,
      });
      if (revision) await appendConfigurationRevision(tx, revision);
      return { next, revision };
    });
    if (committed.revision) {
      store.emit("workflow:setting-values-updated", {
        workflowId,
        projectId,
        settingIds: committed.revision.diffs.map((diff) => diff.field),
        mutationId: committed.revision.id,
      });
    }
    return committed.next;
}

export async function rollbackConfigurationImpl(store: TaskStore, revisionId: string, changedBy: ConfigChangedBy = {kind: "human", id: "local-user"}): Promise<ConfigurationRevision> {
  if (!store.backendMode) throw new Error("Configuration rollback requires the PostgreSQL revision store");
  const layer = store.asyncLayer!;
  // First resolve project ownership without a bypass. The selected snapshot and
  // current target are then read through one immediate transaction below.
  const projectRevision = await getConfigurationRevision(layer.db, layer.projectId ?? "", revisionId);
  if (!projectRevision) {
    // Global revisions live in the reserved central partition and are queried
    // through GlobalSettingsStore's privileged writer/reader.
    const previous = await store.getSettings();
    const rollback = await store.globalSettingsStore.rollbackConfiguration(revisionId, changedBy);
    await publishSettingsUpdated(store, previous, await store.getSettings());
    return rollback;
  }
  const previous = await store.getSettings();
  const rollback = await layer.transactionImmediate(async (tx) => {
    /* FNXC:ConfigVersioning 2026-07-18-02:00: read both the selected revision and current config via tx so rollback's forward `before` snapshot cannot race a concurrent settings write. */
    const revision = await getConfigurationRevision(tx, layer.projectId ?? "", revisionId);
    if (!revision) throw new Error(`Configuration revision ${revisionId} was not found`);
    return rollbackConfiguration(tx, layer.projectId ?? "", revisionId, changedBy, {
    readCurrent: async () => {
      if (revision.configKind === "project-settings") return (await readProjectConfig(layer, tx)).settings ?? {};
      if (revision.configKind === "workflow-settings") {
        const workflowId = String(revision.configTarget.workflowId);
        const projectId = String(revision.configTarget.projectId);
        const rows = await tx.select({values: schema.project.workflowSettings.values}).from(schema.project.workflowSettings).where(and(eq(schema.project.workflowSettings.workflowId, workflowId), eq(schema.project.workflowSettings.projectId, projectId))).limit(1);
        return rows[0]?.values ?? {};
      }
      throw new Error(`Configuration revision ${revisionId} belongs to ${revision.configKind}; use its resource store rollback API`);
    },
    replace: async (snapshot) => {
      if (revision.configKind === "project-settings") {
        await writeProjectConfig(layer, snapshot as Record<string, unknown>, undefined, tx);
        return;
      }
      if (revision.configKind === "workflow-settings") {
        const workflowId = String(revision.configTarget.workflowId);
        const projectId = String(revision.configTarget.projectId);
        await tx.insert(schema.project.workflowSettings).values({workflowId, projectId, values: snapshot as Record<string, unknown>, updatedAt: new Date().toISOString()}).onConflictDoUpdate({target: [schema.project.workflowSettings.workflowId, schema.project.workflowSettings.projectId], set: {values: snapshot as Record<string, unknown>, updatedAt: new Date().toISOString()}});
        return;
      }
      throw new Error(`Configuration revision ${revisionId} cannot be restored by TaskStore`);
    },
    });
  });
  /* FNXC:ConfigVersioning 2026-07-18-14:20: exact replacement commits first; only then notify caches/listeners, matching forward settings writes. */
  if (projectRevision.configKind === "project-settings") {
    await publishSettingsUpdated(store, previous, await store.getSettings());
  } else {
    // Workflow VALUE changes do not alter the merged project settings object,
    // but settings consumers still need the standard invalidation signal.
    store.emit("settings:updated", { settings: await store.getSettings(), previous });
    store.emit("workflow:setting-values-updated", {
      workflowId: String(projectRevision.configTarget.workflowId),
      projectId: String(projectRevision.configTarget.projectId),
      settingIds: rollback.diffs.map((diff) => diff.field),
      mutationId: rollback.id,
    });
  }
  return rollback;
}

export async function cancelActiveWorkflowWorkItemsForTaskImpl(store: TaskStore, taskId: string, opts: { kinds?: WorkflowWorkItemKind[]; now?: string; lastError?: string | null; excludeIds?: string[] } = {}, tx?: import("../postgres/data-layer.js").DbTransaction): Promise<WorkflowWorkItem[]> {
    // FNXC:PostgresCutover 2026-06-27-10:20:
    // Accept an optional outer transaction so handoff-to-review can thread the
    // move tx through, ensuring cancel + upsert commit atomically with the move.
    // No dedicated async helper; the composite is: list active items, then
    // transition each to 'cancelled'. In backend mode, do this without a
    // sync transactionImmediate (each transition is independently atomic).
        const excludeIds = new Set(opts.excludeIds ?? []);
    const items = (await store.listWorkflowWorkItemsForTask(taskId, opts)).filter((item) =>
      store.isActiveWorkflowWorkItemState(item.state) && !excludeIds.has(item.id)
    );
    const results: WorkflowWorkItem[] = [];
    for (const item of items) {
      results.push(
        await store.transitionWorkflowWorkItem(item.id, "cancelled", {
          now: opts.now,
          leaseOwner: null,
          leaseExpiresAt: null,
          lastError: opts.lastError ?? item.lastError ?? "cancelled-by-user-hard-cancel",
        }, tx),
      );
    }
    return results;
}

export async function setCompletionHandoffAcceptedMarkerImpl(store: TaskStore, taskId: string, opts: { source: string; acceptedAt?: string },): Promise<CompletionHandoffMarker> {
    // FNXC:RuntimeWorkflowAsync 2026-06-24-16:35:
    // Backend mode: delegate to the async workflow-workitems helper. The helper
    // records the marker upsert; the sync path also records a run-audit event,
    // so we fire that in backend mode too (fire-and-forget, best-effort).
        const layer = store.asyncLayer!;
    await recordCompletionHandoffAsync(layer.db, taskId, opts.source, opts.acceptedAt);
    const marker = await getCompletionHandoffMarkerAsync(layer.db, taskId);
    if (!marker) throw new Error(`Failed to set completion handoff marker for ${taskId}`);
    void store.recordRunAuditEvent({
      taskId,
      agentId: "system",
      runId: `completion-handoff:${taskId}:${Date.now()}`,
      domain: "database",
      mutationType: "task:completion-handoff-accepted",
      target: taskId,
      metadata: { taskId, acceptedAt: marker.acceptedAt, source: marker.source },
    }).catch((err) => {
      storeLog.warn("completion-handoff audit write failed", {
        taskId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
    return marker as CompletionHandoffMarker;
}

export async function reconcileLegacyAutoMergeStampsImpl(store: TaskStore, options?: { apply?: boolean }): Promise<LegacyAutoMergeStampReconcileResult[]> {
    const candidates = await store.listLegacyAutoMergeStampCandidates();
    const results: LegacyAutoMergeStampReconcileResult[] = [];

    if (options?.apply !== true) {
      return candidates.map((task) => ({ taskId: task.id, column: task.column, cleared: false }));
    }

    for (const candidate of candidates) {
      const current = await store.getTask(candidate.id);
      if (!current || !store.isLegacyAutoMergeStampCandidate(current)) {
        continue;
      }

      const priorAutoMerge = current.autoMerge;
      const priorProvenance = current.autoMergeProvenance;
      current.autoMerge = undefined;
      current.autoMergeProvenance = undefined;
      current.updatedAt = new Date().toISOString();

      await store.atomicWriteTaskJson(store.taskDir(current.id), current);
      if (store.isWatching) store.taskCache.set(current.id, { ...current });
      store.emitTaskLifecycleEventSafely("task:updated", [current]);

      void store.recordRunAuditEvent({
        taskId: current.id,
        agentId: "system",
        runId: `legacy-auto-merge-stamp-clear-${current.id}-${Date.now()}`,
        domain: "database",
        mutationType: "task:auto-merge-legacy-stamp-cleared",
        target: current.id,
        metadata: {
          taskId: current.id,
          priorAutoMerge,
          priorAutoMergeProvenance: priorProvenance ?? null,
          action: "cleared-to-follow-global-autoMerge",
        },
      });
      results.push({ taskId: current.id, column: current.column, cleared: true });
    }

    return results;
  }

export async function recoverExpiredMergeQueueLeasesImpl(store: TaskStore, now: string = new Date().toISOString()): Promise<MergeQueueEntry[]> {
        const layer = store.asyncLayer!;
    return recoverExpiredMergeQueueLeasesAsync(layer, now);
}

export function rewriteDependentsForRemovalImpl(store: TaskStore, taskId: string, dependentIds: string[]): Task[] {
    const rewrittenDependents: Task[] = [];

    for (const dependentId of dependentIds) {
      const dependentTask = store.readTaskFromDb(dependentId);
      if (!dependentTask) continue;

      const nextDependencies = dependentTask.dependencies.filter((dependencyId) => dependencyId !== taskId);
      const clearsBlockedBy = dependentTask.blockedBy === taskId;
      if (nextDependencies.length === dependentTask.dependencies.length && !clearsBlockedBy) {
        continue;
      }

      const updatedLog = clearsBlockedBy
        ? [
          ...(dependentTask.log ?? []),
          {
            timestamp: new Date().toISOString(),
            action: `Auto-unblocked: blocker ${taskId} was soft-deleted`,
          },
        ]
        : dependentTask.log;
      const updatedDependent: Task = {
        ...dependentTask,
        dependencies: nextDependencies,
        blockedBy: clearsBlockedBy ? undefined : dependentTask.blockedBy,
        status: clearsBlockedBy ? undefined : dependentTask.status,
        log: updatedLog,
        updatedAt: new Date().toISOString(),
      };

      store.db.prepare("UPDATE tasks SET dependencies = ?, blockedBy = ?, status = ?, log = ?, updatedAt = ? WHERE id = ?").run(
        toJson(updatedDependent.dependencies),
        updatedDependent.blockedBy ?? null,
        updatedDependent.status ?? null,
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

export async function cleanupBranchForTaskImpl(store: TaskStore, task: Task): Promise<string[]> {
    const branches = new Set<string>();
    if (task.branch) {
      branches.add(task.branch);
    }
    branches.add(`fusion/${task.id.toLowerCase()}`);

    const deleted: string[] = [];
    for (const branch of branches) {
      try {
        assertSafeGitBranchName(branch);
      } catch {
        // Skip branches whose names would be unsafe to pass through a shell.
        // A malformed stored value should not become a command-injection vector.
        continue;
      }
      const verify = await store.runGitCommand(`git rev-parse --verify "${branch}"`);
      if (verify.exitCode !== 0) {
        continue;
      }

      const remove = await store.runGitCommand(`git branch -D "${branch}"`);
      if (remove.exitCode === 0) {
        deleted.push(branch);
      }
    }
    if (deleted.length > 0) {
      await store.clearStaleExecutionStartBranchReferences(deleted, task.id);
    }
    return deleted;
  }

export async function addAttachmentImpl(store: TaskStore, id: string, filename: string, content: Buffer, mimeType: string,): Promise<TaskAttachment> {
    if (!TaskStore.ALLOWED_MIME_TYPES.has(mimeType)) {
      throw new Error(
        `Invalid mime type '${mimeType}'. Allowed: ${[...TaskStore.ALLOWED_MIME_TYPES].join(", ")}`,
      );
    }
    // FNXC:ArtifactRegistry 2026-07-11-10:20 (merge port from main): videos get
    // a larger cap — a 5MB ceiling cannot hold even a short screen recording.
    const maxSize = mimeType.startsWith("video/") ? TaskStore.MAX_VIDEO_ATTACHMENT_SIZE : TaskStore.MAX_ATTACHMENT_SIZE;
    if (content.length > maxSize) {
      throw new Error(
        `File too large (${content.length} bytes). Maximum: ${maxSize} bytes (${maxSize / (1024 * 1024)}MB)`,
      );
    }

    const attachmentResult = await store.withTaskLock(id, async () => {
      const dir = store.taskDir(id);
      const attachDir = join(dir, "attachments");
      await mkdir(attachDir, { recursive: true });

      // Sanitize filename: keep alphanumeric, dots, hyphens, underscores
      const sanitized = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
      const storedName = `${Date.now()}-${sanitized}`;
      await writeFile(join(attachDir, storedName), content);

      const attachment: TaskAttachment = {
        filename: storedName,
        originalName: filename,
        mimeType,
        size: content.length,
        createdAt: new Date().toISOString(),
      };

      const task = await store.readTaskJson(dir);
      if (!task.attachments) task.attachments = [];
      task.attachments.push(attachment);
      task.updatedAt = new Date().toISOString();
      await store.atomicWriteTaskJson(dir, task);

      if (store.isWatching) store.taskCache.set(id, { ...task });
      store.emit("task:updated", task);

      return attachment;
    });

    if (mimeType.startsWith("image/") || mimeType.startsWith("video/")) {
      /*
       * FNXC:ArtifactRegistry 2026-07-10-00:00:
       * FN-7791 requires image task attachments created by agents, dashboard uploads, and route callers to surface as normal image artifacts. Register a URI-only artifact that points at the already-written attachment file so the proven artifact listing/SSE/media pipeline is reused without duplicating bytes or re-entering addAttachment.
       *
       * FNXC:ArtifactRegistry 2026-07-10-00:00:
       * registerArtifact() enforces the artifact-registry active/non-archived task rule (see registerArtifact's ACTIVE_TASKS_WHERE check), but addAttachment has never enforced that rule for attachments themselves — attachments may be added to archived or soft-deleted tasks. Without this guard, attaching an image to an archived/soft-deleted task would throw here AFTER the attachment file and task.json were already written, so the caller would see addAttachment fail even though the attachment actually succeeded. Bridging into the artifact registry is best-effort: swallow the expected archived/not-found rejection so addAttachment keeps its existing always-succeeds-for-a-valid-image contract, and only the artifact-gallery bridge is skipped.
       */
      /*
       * FNXC:ArtifactRegistry 2026-07-11-10:20 (merge port from main):
       * Video attachments bridge the same way so uploaded/agent-attached recordings surface in the Artifacts gallery's Videos section and stream through the range-aware media route.
       */
      const bridgeType = mimeType.startsWith("video/") ? "video" as const : "image" as const;
      try {
        await store.registerArtifact({
          type: bridgeType,
          title: attachmentResult.originalName,
          description: bridgeType === "video" ? "Video task attachment" : "Image task attachment",
          mimeType,
          sizeBytes: attachmentResult.size,
          uri: `attachments/${attachmentResult.filename}`,
          authorId: "attachment",
          authorType: "system",
          taskId: id,
          metadata: {
            source: "attachment",
            attachmentFilename: attachmentResult.filename,
            originalName: attachmentResult.originalName,
          },
        });
      } catch (err) {
        severityAuditLog.warn(
          `[fusion:store] Skipping artifact bridge for attachment ${attachmentResult.filename} on task ${id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return attachmentResult;
  }

/**
 * FNXC:ArtifactRegistry 2026-07-10-00:00:
 * FN-7791 cleanup path: when an attachment is deleted, remove the URI-only
 * artifact row(s) the addAttachment image bridge registered for it, matched by
 * metadata.source === "attachment" && metadata.attachmentFilename. Dual-mode:
 * async Drizzle over project.artifacts in backend mode, sqlite otherwise.
 */
async function deleteAttachmentArtifactRows(store: TaskStore, taskId: string, filename: string): Promise<void> {
        const layer = store.asyncLayer!;
    const artifacts = await getArtifactsForAttachmentCleanup(store, taskId);
    const linkedArtifactIds = artifacts
      .filter((artifact) => artifact.metadata?.source === "attachment" && artifact.metadata.attachmentFilename === filename)
      .map((artifact) => artifact.id);
    if (linkedArtifactIds.length === 0) return;
    for (const artifactId of linkedArtifactIds) {
      await layer.db.delete(schema.project.artifacts).where(eq(schema.project.artifacts.id, artifactId));
    }
    return;
}

async function getArtifactsForAttachmentCleanup(store: TaskStore, taskId: string): Promise<Artifact[]> {
    // getArtifacts() filters to ACTIVE tasks; the cleanup must also cover
    // attachments deleted from archived/soft-deleted tasks, so query directly.
    const layer = store.asyncLayer!;
    const rows = await layer.db
      .select()
      .from(schema.project.artifacts)
      .where(eq(schema.project.artifacts.taskId, taskId));
    return rows as unknown as Artifact[];
}

export async function deleteAttachmentImpl(store: TaskStore, id: string, filename: string): Promise<Task> {
    return store.withTaskLock(id, async () => {
      const dir = store.taskDir(id);
      const task = await store.readTaskJson(dir);
      const idx = task.attachments?.findIndex((a) => a.filename === filename) ?? -1;
      if (idx === -1) {
        const err: NodeJS.ErrnoException = new Error(
          `Attachment '${filename}' not found on task ${id}`,
        );
        err.code = "ENOENT";
        throw err;
      }

      await deleteAttachmentArtifactRows(store, id, filename);

      // Remove file from disk
      const filePath = join(dir, "attachments", filename);
      try {
        await unlink(filePath);
      } catch {
        // File may already be gone
      }

      task.attachments!.splice(idx, 1);
      if (task.attachments!.length === 0) {
        task.attachments = undefined;
      }
      task.updatedAt = new Date().toISOString();
      await store.atomicWriteTaskJson(dir, task);

      if (store.isWatching) store.taskCache.set(id, { ...task });
      store.emit("task:updated", task);

      return task;
    });
  }

export async function registerArtifactImpl(store: TaskStore, input: ArtifactCreateInput): Promise<Artifact> {
    const id = randomUUID();
    const _now = new Date().toISOString();

    /*
    FNXC:SqliteDualPathCleanup 2026-07-26-14:30:
    Artifact registration is PostgreSQL-only. The former non-backend SQLite precheck (store.db.prepare) is deleted; insertArtifactRowAsync performs the archived/not-found gate inside its transaction via getLiveTaskColumn (correct atomic placement).
    */

    const register = async (): Promise<Artifact> => {
      const stored = await store.writeArtifactData(input, id);
      try {
        /*
        FNXC:SqliteDualPathCleanup 2026-07-26-14:07:
        Artifact row insert is PostgreSQL-only via insertArtifactRowAsync.
        */
        return insertArtifactRowAsync(store.asyncLayer!, input, stored);
      } catch (error) {
        if (stored.absolutePath) {
          await unlink(stored.absolutePath).catch(() => undefined);
        }
        throw error;
      }
    };

    return input.taskId ? store.withTaskLock(input.taskId, register) : register();
  }

export async function updatePrInfoImpl(store: TaskStore, id: string, prInfo: import("../types.js").PrInfo | null,): Promise<Task> {
    return store.withTaskLock(id, async () => {
      const dir = store.taskDir(id);
      const task = await store.readTaskJson(dir);

      const previous = task.prInfo;
      const badgeChanged =
        previous?.url !== prInfo?.url ||
        previous?.number !== prInfo?.number ||
        previous?.status !== prInfo?.status ||
        previous?.title !== prInfo?.title ||
        previous?.headBranch !== prInfo?.headBranch ||
        previous?.baseBranch !== prInfo?.baseBranch ||
        previous?.commentCount !== prInfo?.commentCount ||
        previous?.lastCommentAt !== prInfo?.lastCommentAt;
      const linkChanged = previous?.number !== prInfo?.number || previous?.url !== prInfo?.url;

      let prInfos = store.getTaskPrInfos(task);
      if (prInfo) {
        prInfos = store.upsertPrInfoByNumber(prInfos, prInfo);
        if (!previous || linkChanged) {
          task.log.push({ timestamp: new Date().toISOString(), action: "PR linked", outcome: `PR #${prInfo.number}: ${prInfo.url}` });
        } else if (badgeChanged) {
          task.log.push({ timestamp: new Date().toISOString(), action: "PR updated", outcome: `PR #${prInfo.number} badge metadata refreshed` });
        }
      } else {
        if (previous?.number !== undefined) {
          task.log.push({ timestamp: new Date().toISOString(), action: "PR unlinked", outcome: `PR #${previous.number} removed` });
        }
        prInfos = [];
      }

      task.prInfos = prInfos.length > 0 ? prInfos : undefined;
      task.prInfo = store.resolvePrimaryPrInfo(prInfos);
      task.updatedAt = new Date().toISOString();

      await store.atomicWriteTaskJson(dir, task);
      if (store.isWatching) store.taskCache.set(id, { ...task });
      if (badgeChanged || linkChanged || !prInfo) store.emit("task:updated", task);
      return task;
    });
  }

export async function unlinkGithubIssueImpl(store: TaskStore, id: string): Promise<Task> {
    return store.withTaskLock(id, async () => {
      const dir = store.taskDir(id);
      const task = await store.readTaskJson(dir);
      const previous = task.githubTracking;
      const previousIssue = previous?.issue;

      if (!previousIssue || !previous) {
        return task;
      }

      task.githubTracking = {
        ...previous,
        issue: undefined,
        unlinkedAt: new Date().toISOString(),
      };
      task.log.push({
        timestamp: new Date().toISOString(),
        action: "GitHub issue unlinked",
        outcome: `${previousIssue.owner}/${previousIssue.repo}#${previousIssue.number}`,
      });
      task.updatedAt = new Date().toISOString();

      await store.atomicWriteTaskJson(dir, task);
      if (store.isWatching) store.taskCache.set(id, { ...task });
      store.emit("task:updated", task);
      return task;
    });
  }

export async function cleanupArchivedTasksImpl(store: TaskStore): Promise<string[]> {
    /*
    FNXC:PostgresOnlyDataAccess 2026-07-17-15:10:
    Backend-mode port. `cleanupArchivedTasks` is the hard-removal path for tasks
    already in the `archived` column (the CLI documents it as such): it snapshots
    each to cold storage, hard-deletes the live project row, and removes the task
    directory. In PostgreSQL, archived rows are soft-deleted (`deleted_at` set), so
    enumeration MUST pass `includeDeleted`. The cold snapshot upsert is idempotent
    (archive already holds it from archive time); the project-row DELETE fires the
    ON DELETE CASCADE that purges the task's documents/artifacts, matching the
    SQLite path's dir removal. Selection rows are purged via the async helper.
    */
        const layer = store.asyncLayer!;
    /*
    FNXC:PostgresOnlyDataAccess 2026-07-17-17:40:
    Enumerate the archived rows with an EXPLICIT project predicate. `listTasks()`
    derives its scope from `taskProjectScope(layer)`, which is a NO-OP when the
    layer is unbound (projectId absent) — i.e. it would read archived rows across
    every project, and this destructive sweep (snapshot + dir removal + cache
    evict) would then touch tasks it must never own. Scoping the read here to the
    same `projectId` the DELETE below uses keeps enumerate+delete lockstep: a bound
    store sees only its project, an unbound store only the `__legacy_unscoped__`
    quarantine partition.
    */
    const projectId = layer.projectId?.trim() || "__legacy_unscoped__";
    const archivedRows = await layer.db
      .select()
      .from(schema.project.tasks)
      .where(and(eq(schema.project.tasks.projectId, projectId), eq(schema.project.tasks.column, "archived")));
    const cleanedUpIds: string[] = [];
    const { rm } = await import("node:fs/promises");

    for (const row of archivedRows) {
      const task = store.rowToTask(store.pgRowToTaskRow(row));
      const dir = store.taskDir(task.id);
      // Guarantee a cold-storage snapshot before the destructive delete.
      const entry = await store.taskToArchiveEntry(task, task.deletedAt ?? new Date().toISOString());
      await upsertArchivedTaskEntry(layer.db, entry, layer.projectId);

      await purgeTaskWorkflowSelectionRowsAsyncImpl(store, task.id);
      await layer.db
        .delete(schema.project.tasks)
        .where(and(eq(schema.project.tasks.projectId, projectId), eq(schema.project.tasks.id, task.id)));

      if (existsSync(dir)) {
        await rm(dir, { recursive: true, force: true });
      }
      if (store.isWatching) {
        store.taskCache.delete(task.id);
      }
      cleanedUpIds.push(task.id);
    }

    return cleanedUpIds;
}

export function generatePromptFromArchiveEntryImpl(store: TaskStore, entry: import("../types.js").ArchivedTaskEntry): string {
    const deps =
      entry.dependencies.length > 0
        ? entry.dependencies.map((d) => `- **Task:** ${d}`).join("\n")
        : "- **None**";

    const heading = entry.title ? `${entry.id}: ${entry.title}` : entry.id;

    // Build steps section from preserved steps
    let stepsSection = "## Steps\n\n";
    if (entry.steps && entry.steps.length > 0) {
      for (let i = 0; i < entry.steps.length; i++) {
        const step = entry.steps[i];
        const status = step.status === "done" ? "[x]" : "[ ]";
        stepsSection += `### Step ${i}: ${step.name}\n\n- ${status} ${step.name}\n\n`;
      }
    } else {
      stepsSection += "### Step 0: Preflight\n\n- [ ] Review and verify\n\n";
    }

    return `# ${heading}

**Created:** ${entry.createdAt.split("T")[0]}
${entry.size ? `**Size:** ${entry.size}` : "**Size:** M"}

## Mission

${entry.description}

## Dependencies

${deps}

${stepsSection}`;
  }

export async function listWorkflowOccupantTaskIdsImpl(store: TaskStore, workflowId: string, includeNullSelection: boolean): Promise<string[]> {
    /*
    FNXC:PostgresWorkflowOccupancy 2026-07-14-17:44:
    Workflow edits and deletes must discover occupants from PostgreSQL before changing an IR or clearing selection rows. Archived and soft-deleted tasks are never occupants; optionally include live tasks whose selection resolves implicitly to the default workflow.
    */
        const layer = store.asyncLayer!;
    const selected = await layer.db
      .select({ taskId: schema.project.taskWorkflowSelection.taskId })
      .from(schema.project.taskWorkflowSelection)
      .innerJoin(schema.project.tasks, and(
        eq(schema.project.tasks.id, schema.project.taskWorkflowSelection.taskId),
        eq(schema.project.tasks.projectId, schema.project.taskWorkflowSelection.projectId),
      ))
      .where(and(
        eq(schema.project.taskWorkflowSelection.workflowId, workflowId),
        isNull(schema.project.tasks.deletedAt),
        taskProjectScope(layer),
        layer.projectId
          ? eq(schema.project.taskWorkflowSelection.projectId, layer.projectId)
          : undefined,
      ));
    const ids = selected.map((row) => row.taskId);
    if (includeNullSelection) {
      const unselected = await layer.db
        .select({ id: schema.project.tasks.id })
        .from(schema.project.tasks)
        .leftJoin(
          schema.project.taskWorkflowSelection,
          and(
            eq(schema.project.taskWorkflowSelection.taskId, schema.project.tasks.id),
            eq(schema.project.taskWorkflowSelection.projectId, schema.project.tasks.projectId),
          ),
        )
        .where(and(
          isNull(schema.project.tasks.deletedAt),
          isNull(schema.project.taskWorkflowSelection.taskId),
          taskProjectScope(layer),
        ));
      ids.push(...unselected.map((row) => row.id));
    }
    return ids;
}

export async function evacuateCustomColumnsToLegacyImpl(store: TaskStore, trigger: "flag-off-init" | "flag-toggled-off",): Promise<{ scanned: number; evacuated: number }> {
    let scanned = 0;
    let evacuated = 0;

    const legacyColumns = new Set<string>(COLUMNS);
    // Nearest legacy landing column: the default workflow's entry column
    // (triage). Falls back to "triage" defensively if the IR can't be resolved.
    const targetColumn = resolveEntryColumnId(BUILTIN_CODING_WORKFLOW_IR) ?? "triage";

    /*
    FNXC:SqliteDualPathCleanup 2026-07-26-14:32:
    Custom-column evacuation scans live tasks via PostgreSQL only.
    */
    const rows: Array<{ id: string; col: string }> = await store.asyncLayer!.db
      .select({ id: schema.project.tasks.id, col: schema.project.tasks.column })
      .from(schema.project.tasks)
      .where(and(isNull(schema.project.tasks.deletedAt), taskProjectScope(store.asyncLayer!)));

    for (const { id, col } of rows) {
      scanned += 1;
      // Already in a legacy column (the common case) — nothing to evacuate.
      if (legacyColumns.has(col)) continue;
      // Never disturb terminal cards (legacy terminal semantics — these column
      // ids are never legacy here, but guard defensively for parity with the
      // integrity pass).
      if (col === "done" || col === "archived") continue;

      await store.rehomeOccupant(id, targetColumn, "workflow-edit-rehome", {
        evacuation: true,
        trigger,
        invalidColumn: col,
      });
      evacuated += 1;
    }

    if (evacuated > 0) {
      storeLog.log("workflowColumns ON→OFF evacuation completed", {
        phase: "evacuate-custom-columns",
        trigger,
        scanned,
        evacuated,
      });
    }
    return { scanned, evacuated };
  }

export async function listApprovedCliAutonomyAdaptersImpl(store: TaskStore): Promise<string[]> {
    const settings = await store.getSettings();
    const approved = (settings as { approvedCliAutonomyAdapters?: string[] }).approvedCliAutonomyAdapters;
    return Array.isArray(approved) ? [...approved] : [];
  }

export async function closeImpl(store: TaskStore): Promise<void> {
    store.closing = true;
    if (store.deferredTaskCreatedWork.size > 0) {
      await Promise.allSettled([...store.deferredTaskCreatedWork]);
    }
    store.stopWatching();
    // Flush any remaining buffered agent log entries before closing.
    // Wrap in try-catch because entries for already-deleted tasks will fail FK check.
    if (store.agentLogBuffer.length > 0) {
      try {
        store.flushAgentLogBuffer();
      } catch (err) {
        // Best-effort flush — entries for deleted tasks will fail FK check.
        // Log the error instead of silently swallowing it.
        severityAuditLog.warn(`[fusion] Could not flush remaining agent log entries on close:`, err);
      }
    }
    // Cancel any retry timer armed by a failed flush — the DB is about to close.
    if (store.agentLogFlushTimer) {
      clearTimeout(store.agentLogFlushTimer);
      store.agentLogFlushTimer = null;
    }
    store.agentLogBuffer.length = 0;
    if (store._db) {
      store._db.close();
      store._db = null;
      store.taskIdStateReconciled = false;
    }
    if (store._archiveDb) {
      store._archiveDb.close();
      store._archiveDb = null;
    }
    if (store.secretsCentralCore) {
      /**
       * FNXC:TaskStoreShutdown 2026-06-29-13:04:
       * TaskStore.close() must deterministically await the cached secrets CentralCore close before temp-root cleanup and test teardown continue.
       * CentralCore.close() is currently synchronous internally, but awaiting the async contract prevents unhandled rejections and preserves shutdown safety if the central secrets handle gains asynchronous cleanup.
       */
      const secretsCentralCore = store.secretsCentralCore;
      store.secretsCentralCore = null;
      try {
        await secretsCentralCore.close();
      } catch (err) {
        severityAuditLog.warn(`[fusion] Could not close secrets central core on TaskStore close:`, err);
      }
    }
    store.secretsStore = null;
    if (store.pluginStore) {
      /**
       * FNXC:Plugins 2026-06-25-00:00:
       * FN-7005 requires TaskStore.close() to own the cached PluginStore lifecycle because PluginStore has separate local and central SQLite connections.
       * Dispose it here so long-running processes and tests outside shared reset helpers do not leak handles after TaskStore shutdown; PluginStore.close() follows FN-7003's null-safe handle teardown.
       */
      const pluginStore = store.pluginStore;
      store.pluginStore = null;
      pluginStore.removeAllListeners();
      try {
        pluginStore.close();
      } catch (err) {
        severityAuditLog.warn(`[fusion] Could not close plugin store on TaskStore close:`, err);
      }
    }
    // FNXC:RuntimeBackendInjection 2026-06-24-14:30:
    // In backend mode the AsyncDataLayer owns the PostgreSQL connection pool.
    // Close it so the process can exit cleanly. Best-effort: a close failure
    // is logged but does not prevent the rest of teardown.
    if (store.asyncLayer) {
      try {
        await store.asyncLayer.close();
      } catch (err) {
        storeLog.warn("AsyncDataLayer close failed during TaskStore.close()", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

export async function getActivityLogImpl(store: TaskStore, options?: { limit?: number; since?: string; type?: ActivityEventType }): Promise<ActivityLogEntry[]> {
    // FNXC:RuntimeWorkflowAsync 2026-06-24-16:03:
    // Backend-mode: delegate to the async audit helper.
        const layer = store.asyncLayer!;
    return getActivityLogAsync(layer.db, layer.projectId ?? "", options);
}
