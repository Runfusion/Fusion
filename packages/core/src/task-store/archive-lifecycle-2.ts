/**
 * archive-lifecycle-2 operations.
 *
 * FNXC:StoreModularization 2026-06-25-00:00:
 * Extracted from the monolithic packages/core/src/store.ts as a pure
 * behavior-preserving refactor. Each function receives the TaskStore
 * instance as its first parameter and performs byte-identical work.
 */
import {TaskStore, storeLog} from "../store.js";
import {getFeatureByTaskId as getMissionFeatureByTaskId, unlinkFeatureFromTaskId as unlinkMissionFeatureFromTaskId, recordGeneratedFixOperatorStop} from "../async-stores/async-mission-store-queries.js";
import {TaskHasDependentsError, TaskHasLineageChildrenError, TaskNotFoundError, TaskSelfDeleteError} from "./errors.js";
import {mkdir} from "node:fs/promises";
import {join} from "node:path";
import {and, eq, inArray, sql} from "drizzle-orm";
import * as schema from "../postgres/schema/index.js";
import type {Task, ArchivedTaskEntry, GithubIssueAction} from "../types.js";
import {buildDeleteCallerAuditFields, type TaskDeleteAuditContext} from "../task-delete-attribution.js";
import {notifyOperatorOfNonOperatorDelete} from "../task-delete-notice.js";
import "../builtin-traits.js";
import {normalizeTaskPriority} from "../tasks/task-priority.js";
import {clearTerminalFailureAutoRecoveryBudget} from "../tasks/terminal-failure-auto-recovery.js";
import {generateTaskLineageId} from "../tasks/task-lineage.js";
import {sanitizeFileScopeInPromptContent} from "../task-store/file-scope.js";
import {__setTaskActivityLogLimitsForTesting} from "../task-store/comments.js";
import {softDeleteTaskRowInTransaction, readTaskRow as readTaskRowAsync, readTaskRowInTransaction} from "../task-store/async/async-persistence.js";
import {supersedePlanReviewResults} from "../planner/plan-approval.js";
import {withTaskWorkflowSerialization} from "../task-store/async/async-workflow-workitems.js";
import {appendTaskLifecycleEventInTransaction} from "../task-store/lifecycle-outbox.js";
import {findLiveDependencyDependents, findLiveLineageChildren as findLiveLineageChildrenAsync, removeLineageReferences, type LineageRemovalOutcome} from "../task-store/async/async-lifecycle.js";
import { classifyLineageInvalidationOutcomeError, lineageEvidenceTargetVersionForTest, recordLineageInvalidationOutcome, reconcileClearedLineageChildren, resolveAndAssertLineageCandidatesUnchanged, runLineageInvalidation } from "../task-store/lineage-approval-invalidation.js";
import { ARCHIVED_SENTINEL_LANES } from "../project-lane-vocabulary.js";
import {writePromptFileAtomic} from "./prompt-file.js";
import {pickArchiveRestorableTaskFields} from "./archive-restoration-contract.js";

export async function taskToArchiveEntryImpl(store: TaskStore, task: Task, archivedAt: string): Promise<ArchivedTaskEntry> {
    /*
    FNXC:ArchiveRemoval 2026-09-04-10:36:
    Cold snapshots now exist only as compatibility and soft-delete recovery records, never as an operator-managed archive. Keep their agent-log payload bounded without exposing archive retention settings that no longer have a task-lifecycle effect.
    */
    const agentLogMode = "compact" as const;
    const [prompt, agentLogFields] = await Promise.all([
      store.readPromptForArchive(task.id),
      store.buildArchivedAgentLogFields(task.id, agentLogMode),
    ]);

    return {
      id: task.id,
      lineageId: task.lineageId || generateTaskLineageId(),
      title: task.title,
      description: task.description,
      priority: normalizeTaskPriority(task.priority),
      column: "archived",
      /*
      FNXC:WorkflowLifecycleColumns 2026-08-01-11:30:
      Preserve the task's live column in the historical snapshot. Store-open reintegration uses this
      provenance only for migration diagnostics; restored history is always re-homed to Complete.
      */
      preArchiveColumn: task.preArchiveColumn ?? (task.column as ArchivedTaskEntry["preArchiveColumn"]),
      dependencies: task.dependencies,
      steps: task.steps,
      currentStep: task.currentStep,
      customFields: task.customFields,
      size: task.size,
      reviewLevel: task.reviewLevel,
      prInfo: task.prInfo,
      prInfos: task.prInfos,
      issueInfo: task.issueInfo,
      githubTracking: task.githubTracking,
      /*
      FNXC:GitLabTracking 2026-07-16-13:00:
      Historical deletion snapshots retain GitLab provenance for migration and forensic reads.
      */
      gitlabTracking: task.gitlabTracking,
      sourceIssue: task.sourceIssue,
      attachments: task.attachments,
      comments: task.comments,
      review: task.review,
      prompt,
      ...agentLogFields,
      /*
      FNXC:TaskArchiveReintegration 2026-09-06-09:03:
      A cold-only restore must retain the activity history that was durable at deletion time because
      slim archive reads derive timedExecutionMs from its [timing] events. Append the deletion marker
      instead of replacing those proofs; transient runtime ownership remains excluded separately.
      */
      log: [...(task.log ?? []), { timestamp: archivedAt, action: "Task deleted" }],
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      columnMovedAt: task.columnMovedAt,
      archivedAt,
      ...pickArchiveRestorableTaskFields(task),
      // Branch is retained as forensic provenance in the snapshot but is not a restorable runtime owner.
      branch: task.branch,
    };
  }

type DeleteTaskBackendOptions = { removeDependencyReferences?: boolean; removeLineageReferences?: boolean; allowResurrection?: boolean; githubIssueAction?: GithubIssueAction; auditContext?: TaskDeleteAuditContext; };
type DeleteTaskClaimResult = { task: Task; claimed: boolean };

/*
FNXC:LifecycleOutbox 2026-08-01-11:12:
The internal result preserves whether this caller won the conditional first-transition claim.
`deleteTaskIf` exposes that fact as `deleted`, so a cross-process loser cannot report that it
performed a deletion merely because its predicate ran against a stale live snapshot.
*/
async function deleteTaskBackendWithClaimResultImpl(store: TaskStore, id: string, options?: DeleteTaskBackendOptions): Promise<DeleteTaskClaimResult> {
  /*
  FNXC:TaskDeletion 2026-07-01-00:00:
  Task-bound runtime callers may never soft-delete the task they are executing; this guard is the PostgreSQL-backend mirror of the SQLite-path guard in deleteTaskImpl so direct callers of deleteTaskBackend inherit the same invariant before any mutation or audit.
  */
  if (options?.auditContext?.taskId === id) {
    throw new TaskSelfDeleteError(id);
  }
    const layer = store.asyncLayer!;
    // Read the task row (forensic: include soft-deleted).
    const pgRow = await readTaskRowAsync(layer, id, { includeDeleted: true });
    if (!pgRow) {
      // FNXC:TaskLookup404 2026-07-26-12:00: typed miss (message unchanged) so
      // DELETE /api/tasks/:id answers 404 for an unknown id instead of 500.
      throw new TaskNotFoundError(id);
    }
    const task = store.rowToTask(store.pgRowToTaskRow(pgRow));

    // Idempotent: already soft-deleted is a no-op.
    if (task.deletedAt) {
      return { task, claimed: false };
    }

    // Lineage-integrity gate (VAL-DATA-010).
    /* FNXC:TaskArchiveRemoval 2026-09-04-18:25 DELIBERATE-LITERAL: historical-sentinel children are not live and do not block parent deletion. */
    const lineageHistoricalSentinels = ARCHIVED_SENTINEL_LANES;
    const lineageChildIds = await findLiveLineageChildrenAsync(layer.db, id, layer.projectId, lineageHistoricalSentinels);
    if (lineageChildIds.length > 0 && !options?.removeLineageReferences) {
      throw new TaskHasLineageChildrenError(id, lineageChildIds);
    }
    const dependencyDependentIds = await findLiveDependencyDependents(layer.db, id, layer.projectId);
    if (dependencyDependentIds.length > 0 && !options?.removeDependencyReferences) {
      throw new TaskHasDependentsError(id, dependencyDependentIds);
    }

    const deletedAt = new Date().toISOString();
    const allowResurrection = options?.allowResurrection === true;
    const projectId = layer.projectId?.trim() || "__legacy_unscoped__";
    /*
    FNXC:LifecycleOutbox 2026-08-01-10:33:
    Test-only barrier: production never assigns this private store property. It makes the
    cross-process pre-claim TOCTOU deterministic instead of relying on scheduler timing.
    */
    await (store as unknown as { __beforeDeleteClaimForTest?: (taskId: string) => void | Promise<void> }).__beforeDeleteClaimForTest?.(id);

    // Soft-delete + lineage clear + mission unlink + audit in one transaction (atomicity).
    const executeDelete = async (context?: { candidateIds: string[]; promptByChildId: ReadonlyMap<string, string>; locksHeld: boolean; attempt: number }) => {
    let deletion: DeleteTaskClaimResult & { lineageOutcome: LineageRemovalOutcome };
    try {
      deletion = await layer.transactionImmediate(async (tx) => withTaskWorkflowSerialization(tx, layer.projectId, id, async () => {
      if (context) await resolveAndAssertLineageCandidatesUnchanged(tx, id, layer.projectId, lineageHistoricalSentinels, context.candidateIds);
      const liveDependencyDependents = await findLiveDependencyDependents(tx, id, layer.projectId);
      if (liveDependencyDependents.length > 0 && !options?.removeDependencyReferences) {
        throw new TaskHasDependentsError(id, liveDependencyDependents);
      }
      /*
      FNXC:DependencyIntegrity 2026-08-20-17:27:
      Delete and incoming-edge removal share this transaction. A dependent must never observe a
      soft-deleted prerequisite while retaining its dependency, so forced removal clears the edge,
      stale blocker, and plan approval before the parent tombstone can commit.
      */
      if (options?.removeDependencyReferences && liveDependencyDependents.length > 0) {
        /*
        FNXC:DependencyIntegrity 2026-08-20-17:41:
        Forced deletion is a material dependency mutation, not a JSON-array cleanup. Reuse the
        dependency-replan fence: supersede Plan Review evidence and cancel only unclaimed task
        continuations in this transaction. Running and terminal continuations remain immutable.
        */
        for (const dependentId of liveDependencyDependents.sort()) {
          await withTaskWorkflowSerialization(tx, layer.projectId, dependentId, async () => {
            const dependentRow = await readTaskRowInTransaction(tx, dependentId, {}, projectId);
            if (!dependentRow) return;
            const dependent = store.rowToTask(store.pgRowToTaskRow(dependentRow));
            const dependencies = dependent.dependencies.filter((dependencyId) => dependencyId !== id);
            // Revalidation prevents a candidate that changed during deletion from losing a new edge.
            if (dependencies.length === dependent.dependencies.length) return;
            await tx.update(schema.project.tasks).set({
              dependencies,
              blockedBy: dependent.blockedBy === id ? null : dependent.blockedBy ?? null,
              approvedPlanFingerprint: null,
              awaitingApprovalReason: null,
              workflowStepResults: supersedePlanReviewResults(dependent.workflowStepResults, deletedAt),
              status: "needs-replan",
              error: null,
              updatedAt: deletedAt,
            }).where(and(
              eq(schema.project.tasks.projectId, projectId),
              eq(schema.project.tasks.id, dependentId),
              sql`${schema.project.tasks.dependencies} @> ${JSON.stringify([id])}::jsonb`,
              sql`${schema.project.tasks.deletedAt} IS NULL`,
            ));
            await tx.update(schema.project.workflowWorkItems).set({
              state: "cancelled",
              leaseOwner: null,
              leaseExpiresAt: null,
              lastError: "cancelled-by-planning-dependency-reseed",
              updatedAt: deletedAt,
            }).where(and(
              eq(schema.project.workflowWorkItems.projectId, projectId),
              eq(schema.project.workflowWorkItems.taskId, dependentId),
              eq(schema.project.workflowWorkItems.kind, "task"),
              inArray(schema.project.workflowWorkItems.state, ["runnable", "held", "retrying"]),
            ));
          });
        }
      }
      /*
      FNXC:LifecycleOutbox 2026-08-01-10:33:
      The pre-transaction deletedAt read is a cross-process TOCTOU window. A conditional
      claim makes one transition own all side effects; a loser re-reads on this transaction
      because returning its captured live snapshot would lie about deletedAt.
      */
      const claimed = await softDeleteTaskRowInTransaction(tx, id, deletedAt, allowResurrection, projectId, true);
      if (claimed === false) {
        const reloaded = await readTaskRowInTransaction(tx, id, { includeDeleted: true }, projectId);
        if (!reloaded) throw new TaskNotFoundError(id);
        return { claimed: false, task: store.rowToTask(store.pgRowToTaskRow(reloaded)), lineageOutcome: { clearedChildIds: [] as string[], evidenceVersionByChild: new Map<string, number>(), evidenceUnavailableChildIds: [], evidenceInsertAttempts: 0 } };
      }
      /*
      FNXC:TaskWedgeNotifications 2026-08-10-20:30:
      A soft-deleted row is invisible to the recovery sweep. Clear its terminal-failure budget
      only after this transaction won the first-delete claim, so a declined conditional delete
      cannot mute a live card and every backend delete path shares the same atomic boundary.
      */
      const deletedRow = await readTaskRowInTransaction(tx, id, { includeDeleted: true }, projectId);
      if (!deletedRow) throw new TaskNotFoundError(id);
      const deletedTask = store.rowToTask(store.pgRowToTaskRow(deletedRow));
      if (deletedTask.wedgeNotification?.autoRecovery) {
        await tx.update(schema.project.tasks)
          .set({ wedgeNotification: JSON.stringify(clearTerminalFailureAutoRecoveryBudget(deletedTask.wedgeNotification, deletedAt)) })
          .where(and(eq(schema.project.tasks.projectId, projectId), eq(schema.project.tasks.id, id)));
      }
      // Clear lineage references and approval only after locked candidates were revalidated.
      const lineageOutcome = context
        ? await removeLineageReferences(tx, id, context.candidateIds, deletedAt, layer.projectId, context.promptByChildId, lineageEvidenceTargetVersionForTest(store))
        : { clearedChildIds: [], evidenceVersionByChild: new Map<string, number>(), evidenceUnavailableChildIds: [], evidenceInsertAttempts: 0 };
      /*
      FNXC:MissionStore 2026-07-17-17:40:
      Clear any mission feature→task link IN THIS TRANSACTION so it commits (or rolls
      back) atomically with the soft-delete. The prior post-commit / pre-commit variants
      could leave the two out of sync on a partial failure: a committed delete with a
      dangling feature pointer, or a committed unlink whose delete then failed and could
      not be recovered (getFeatureByTaskId no longer finds it). Running the tx-scoped
      taskId=NULL clear alongside the delete removes that window. The feature's status
      rollup is non-critical for a deleted task and self-heals on the next mission read.
      */
      const linkedFeature = await getMissionFeatureByTaskId(tx, id);
      if (linkedFeature) {
        /*
        FNXC:MissionLineageBudget 2026-07-22-15:00:
        Generated remediation task removal is operator intervention, recorded
        before clearing the feature task edge in this same soft-delete transaction.
        */
        await recordGeneratedFixOperatorStop(tx, linkedFeature, "task-delete");
        await unlinkMissionFeatureFromTaskId(tx, linkedFeature.id);
      }
      // Record the audit event.
      await store.recordRunAuditEventBackend(tx, {
        domain: "database",
        mutationType: "task:deleted",
        target: id,
        taskId: id,
        agentId: options?.auditContext?.agentId ?? "system",
        runId: options?.auditContext?.runId ?? store.makeSyntheticDeleteRunId(id),
        metadata: {
          previousColumn: task.column,
          previousStatus: task.status ?? null,
          githubIssueAction: options?.githubIssueAction ?? "auto",
          removeDependencyReferences: !!options?.removeDependencyReferences,
          removeLineageReferences: !!options?.removeLineageReferences,
          allowResurrection,
          sessionId: options?.auditContext?.sessionId,
          // FNXC:TaskDeleteAttribution 2026-07-26-14:30: caller class + calling
          // task id; `taskId` reached this function but was never persisted.
          ...buildDeleteCallerAuditFields(options?.auditContext),
        },
      });
      /*
      FNXC:LifecycleOutbox 2026-08-01-10:33:
      This stays inside transactionImmediate, unlike mailbox delivery: state and durable
      observation must commit or roll back together, which is the outbox's purpose.
      */
      await appendTaskLifecycleEventInTransaction(tx, {
        projectId,
        eventType: "task:deleted",
        taskId: id,
        occurredAt: deletedAt,
        payload: {
          taskId: id,
          previousColumn: task.column ?? "unknown",
          previousStatus: task.status ?? null,
          deletedAt,
          allowResurrection,
          githubIssueAction: options?.githubIssueAction ?? null,
          deletedBy: options?.auditContext?.agentId ?? null,
        },
      });
      /*
      FNXC:LifecycleOutbox 2026-08-01-10:51:
      This private test seam injects a failure after every durable delete write, proving the
      outbox, counter, audit, and soft-delete share one transaction. Production construction
      never assigns it; it exists instead of timing-dependent fault injection.
      */
      await (store as unknown as { __afterLifecycleOutboxWriteForTest?: () => void | Promise<void> }).__afterLifecycleOutboxWriteForTest?.();
      // FNXC:LifecycleOutbox 2026-08-01-10:33: return the persisted transition to both
      // callers so neither receives the pre-claim live snapshot after a successful delete.
      const reloaded = await readTaskRowInTransaction(tx, id, { includeDeleted: true }, projectId);
      if (!reloaded) throw new TaskNotFoundError(id);
      return { claimed: true, task: store.rowToTask(store.pgRowToTaskRow(reloaded)), lineageOutcome };
    }));
    } catch (error) {
      if (context) recordLineageInvalidationOutcome(store, {
        attempt: context.attempt, locksHeld: context.locksHeld, degraded: !context.locksHeld,
        candidateIds: context.candidateIds, clearedChildIds: [], evidenceVersionByChild: new Map(),
        evidenceUnavailableChildIds: [], evidenceInsertAttempts: 0,
        error: classifyLineageInvalidationOutcomeError(error),
      });
      throw error;
    }
      if (context) {
        recordLineageInvalidationOutcome(store, {
          attempt: context.attempt, locksHeld: context.locksHeld, degraded: !context.locksHeld,
          candidateIds: context.candidateIds, clearedChildIds: deletion.lineageOutcome.clearedChildIds,
          evidenceVersionByChild: deletion.lineageOutcome.evidenceVersionByChild,
          evidenceUnavailableChildIds: deletion.lineageOutcome.evidenceUnavailableChildIds,
          evidenceInsertAttempts: deletion.lineageOutcome.evidenceInsertAttempts,
        });
        await reconcileClearedLineageChildren(store, deletion.lineageOutcome.clearedChildIds, { locksHeld: context.locksHeld });
      }
      return deletion;
    };
    const deletion = options?.removeLineageReferences
      ? await runLineageInvalidation(store, id, { archivedColumns: lineageHistoricalSentinels, initialCandidateIds: lineageChildIds }, executeDelete)
      : await executeDelete();

    if (!deletion.claimed) return deletion;

    // Emit lifecycle event (best-effort, outside the transaction).
    store.laneCache.invalidate(task.id);
    store.emit("task:deleted", task, {
      githubIssueAction: options?.githubIssueAction ?? "auto",
    });
    /*
    FNXC:TaskDeleteNotice 2026-07-26-16:10:
    Operator mailbox notice for a delete the operator did not perform. Deliberately placed here,
    beside the lifecycle emit and OUTSIDE `transactionImmediate`: a mailbox INSERT that threw inside
    that callback would roll back the committed soft-delete, the lineage clear, the mission unlink,
    and the audit row. `task` is still the pre-delete snapshot at this point, so `task.column` is the
    real previous column. `deleteTaskIfBackendImpl` delegates here, so it is covered too.
    */
    await notifyOperatorOfNonOperatorDelete(
      store,
      { id: task.id, title: task.title, previousColumn: task.column, previousStatus: task.status ?? null },
      options?.auditContext,
    );
    return deletion;
  }

export async function deleteTaskBackendImpl(store: TaskStore, id: string, options?: DeleteTaskBackendOptions): Promise<Task> {
  return (await deleteTaskBackendWithClaimResultImpl(store, id, options)).task;
}

/** PostgreSQL mirror of deleteTaskIfImpl: predicate and deletion share one task lock. */
export async function deleteTaskIfBackendImpl(
  store: TaskStore,
  id: string,
  predicate: (live: Task) => boolean | Promise<boolean>,
  options?: { removeDependencyReferences?: boolean; removeLineageReferences?: boolean; allowResurrection?: boolean; githubIssueAction?: GithubIssueAction; auditContext?: TaskDeleteAuditContext },
): Promise<{ task: Task; deleted: boolean }> {
  if (options?.auditContext?.taskId === id) throw new TaskSelfDeleteError(id);
  return store.withTaskLock(id, async () => {
    const layer = store.asyncLayer!;
    const row = await readTaskRowAsync(layer, id, { includeDeleted: true });
    if (!row) throw new Error(`Task ${id} not found`);
    const live = store.rowToTask(store.pgRowToTaskRow(row));
    if (live.deletedAt) return { task: live, deleted: false };
    // FNXC:TaskDeletion 2026-07-29-19:15:
    // FN-8361 conditional deletion preserves delete's lineage gate even when
    // the caller predicate declines the mutation; guards precede the predicate.
    /* FNXC:TaskArchiveRemoval 2026-09-04-18:25 DELIBERATE-LITERAL: historical-sentinel children are not live and do not block parent deletion. */
    const lineageHistoricalSentinels = ARCHIVED_SENTINEL_LANES;
    const lineageChildIds = await findLiveLineageChildrenAsync(layer.db, id, layer.projectId, lineageHistoricalSentinels);
    if (lineageChildIds.length > 0 && !options?.removeLineageReferences) {
      throw new TaskHasLineageChildrenError(id, lineageChildIds);
    }
    if (!await predicate(live)) return { task: live, deleted: false };
    const deletion = await deleteTaskBackendWithClaimResultImpl(store, id, options);
    /*
    FNXC:LifecycleOutbox 2026-08-01-11:12:
    `deleted` means this caller won the first-transition claim, not merely that the predicate
    observed a live row. The loser carries the transaction-scoped re-read deleted task while
    returning false, preventing downstream conditional-delete callers from duplicating work.
    */
    return { task: deletion.task, deleted: deletion.claimed };
  });
}


/*
FNXC:TaskArchiveRemoval 2026-09-04-19:28:
Cold-only reintegration inserts the durable row before publishing compatibility files, so a file
watcher cannot manufacture the row outside the advisory transaction. When a target completion lane
is supplied, every restored file already names that lane and cannot transiently revive `archived`.
*/
export async function restoreFromArchiveImpl(
  store: TaskStore,
  entry: import("../types.js").ArchivedTaskEntry,
  options: { targetColumn?: string; now?: string; authoritativeTask?: Task } = {},
): Promise<Task> {
    const dir = store.taskDir(entry.id);

    // Create task directory
    await mkdir(dir, { recursive: true });

    // Build restored task (clear transient fields)
    const archiveProjection: Task = {
      id: entry.id,
      lineageId: entry.lineageId || generateTaskLineageId(),
      title: entry.title,
      description: entry.description,
      priority: normalizeTaskPriority(entry.priority),
      column: options.targetColumn ?? "archived", // Historical carrier unless one-way reintegration targets Complete.
      preArchiveColumn: entry.preArchiveColumn,
      dependencies: entry.dependencies,
      steps: entry.steps,
      currentStep: entry.currentStep,
      customFields: entry.customFields ?? undefined,
      size: entry.size,
      reviewLevel: entry.reviewLevel,
      prInfo: entry.prInfo,
      review: entry.review,
      issueInfo: entry.issueInfo,
      githubTracking: entry.githubTracking,
      gitlabTracking: entry.gitlabTracking,
      sourceIssue: entry.sourceIssue,
      attachments: entry.attachments,
      log: [...entry.log, { timestamp: new Date().toISOString(), action: "Task restored from archive" }],
      comments: entry.comments,
      createdAt: entry.createdAt,
      updatedAt: options.now ?? new Date().toISOString(),
      columnMovedAt: options.targetColumn ? (options.now ?? new Date().toISOString()) : entry.columnMovedAt,
      ...pickArchiveRestorableTaskFields(entry),
      /*
      FNXC:ArchiveRestore 2026-08-15-05:39:
      Cold archive entries intentionally omit per-repository worktree and landing state. Reconstructing
      either `workspaceWorktrees` or `branch` would revive disposed paths and let the workspace
      partial-land reconciler mistake a reintegrated historical card for a recoverable landing.
      */
      // Intentionally NOT restoring: worktree, workspaceWorktrees, branch, status, blockedBy, paused, executionStartBranch, error
    };
    /*
    FNXC:TaskArchiveReintegration 2026-09-06-08:00:
    PostgreSQL has already committed before compatibility artifacts are published. Re-project the
    authoritative row here so a file watcher can never write archive values over richer live data.
    */
    const restoredTask: Task = options.authoritativeTask ? {
      ...archiveProjection,
      ...options.authoritativeTask,
      column: options.targetColumn ?? options.authoritativeTask.column,
      updatedAt: options.now ?? options.authoritativeTask.updatedAt,
      columnMovedAt: options.targetColumn
        ? (options.now ?? options.authoritativeTask.columnMovedAt)
        : options.authoritativeTask.columnMovedAt,
    } : archiveProjection;

    // Write task.json
    await store.atomicWriteTaskJson(dir, restoredTask);

    // Generate PROMPT.md with preserved steps
    const prompt = entry.prompt ?? store.generatePromptFromArchiveEntry(entry);
    const sanitizedPrompt = sanitizeFileScopeInPromptContent(prompt);
    if (sanitizedPrompt.dropped.length > 0) {
      storeLog.log(`[file-scope-sanitize] restore ${entry.id}: dropped=[${sanitizedPrompt.dropped.join(",")}]`);
    }
    await mkdir(dir, { recursive: true });
    await writePromptFileAtomic(join(dir, "PROMPT.md"), sanitizedPrompt.sanitized);

    // Create empty attachments directory if attachments existed
    if (entry.attachments && entry.attachments.length > 0) {
      await mkdir(join(dir, "attachments"), { recursive: true });
    }

    return restoredTask;
  }
