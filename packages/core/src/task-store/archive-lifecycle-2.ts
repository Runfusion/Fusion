/**
 * archive-lifecycle-2 operations.
 *
 * FNXC:StoreModularization 2026-06-25-00:00:
 * Extracted from the monolithic packages/core/src/store.ts as a pure
 * behavior-preserving refactor. Each function receives the TaskStore
 * instance as its first parameter and performs byte-identical work.
 */
import {TaskStore, storeLog} from "../store.js";
import { columnsWithFlag, declaresAnyLifecycleTrait } from "../workflows/workflow-lifecycle-traits.js";
import { resolveWorkflowIrForTask } from "../workflows/workflow-ir-resolver.js";
import { toTaskMoveLanes } from "../workflows/workflow-lifecycle-traits.js";
import {getFeatureByTaskId as getMissionFeatureByTaskId, unlinkFeatureFromTaskId as unlinkMissionFeatureFromTaskId, recordGeneratedFixOperatorStop} from "../async-stores/async-mission-store-queries.js";
import {TaskHasLineageChildrenError, TaskNotFoundError, TaskSelfDeleteError} from "./errors.js";
import {mkdir, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {and, eq} from "drizzle-orm";
import * as schema from "../postgres/schema/index.js";
import type {Task, Column, ArchivedTaskEntry, GithubIssueAction, TaskDeleteClosureContext} from "../types.js";
import {buildDeleteCallerAuditFields, buildDeleteClosureAuditFields, type TaskDeleteAuditContext} from "../task-delete-attribution.js";
import {notifyOperatorOfNonOperatorDelete} from "../task-delete-notice.js";
import "../builtin-traits.js";
import {normalizeTaskPriority} from "../tasks/task-priority.js";
import {clearTerminalFailureAutoRecoveryBudget} from "../tasks/terminal-failure-auto-recovery.js";
import {generateTaskLineageId} from "../tasks/task-lineage.js";
import {sanitizeFileScopeInPromptContent} from "../task-store/file-scope.js";
import {__setTaskActivityLogLimitsForTesting} from "../task-store/comments.js";
import {softDeleteTaskRowInTransaction, readTaskRow as readTaskRowAsync, readTaskRowInTransaction} from "../task-store/async/async-persistence.js";
import {appendTaskLifecycleEventInTransaction} from "../task-store/lifecycle-outbox.js";
import {findLiveLineageChildren as findLiveLineageChildrenAsync, projectPartition, removeLineageReferences, type LineageRemovalOutcome} from "../task-store/async/async-lifecycle.js";
import { classifyLineageInvalidationOutcomeError, lineageEvidenceTargetVersionForTest, recordLineageInvalidationOutcome, reconcileClearedLineageChildren, resolveAndAssertLineageCandidatesUnchanged, runLineageInvalidation } from "../task-store/lineage-approval-invalidation.js";
import { resolveProjectColumnsForRoles } from "../project-lane-vocabulary.js";
import {archiveParentTaskWithLineageGate, findArchivedTaskEntry, deleteArchivedTaskEntry, restoreTaskFromArchive} from "../task-store/async/async-archive-lineage.js";
import {getArchivedRowCount, listArchivedTaskEntriesPage} from "../async-stores/async-archive-db.js";
import {disposeArchivedWorkspaceWorktrees, disposeArchivedWorktree, prepareArchivedWorkspaceWorktrees, releasePreparedWorkspaceArchiveDisposal} from "./archive-lifecycle.js";

export async function taskToArchiveEntryImpl(store: TaskStore, task: Task, archivedAt: string): Promise<ArchivedTaskEntry> {
    const settings = await store.getSettingsFast();
    const agentLogMode = settings.archiveAgentLogMode ?? "compact";
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
      FNXC:WorkflowLifecycleColumns 2026-08-01-11:30 (PR #2824's finding, fixed):
      CAPTURE THE COLUMN THE CARD WAS IN. This field was only ever COPIED — here, back out of the
      entry on restore, and through serialization — and never SET from anywhere, so it was `undefined`
      for every archive that has ever happened. `unarchiveTaskImpl` then fell to its `?? "todo"` and
      the restore destination was decided by a literal instead of by history.

      On the default board `todo` is a declared column, so restores landed in the queue and looked
      right — which is why this survived three separate fixes to `resolveUnarchiveTargetColumnImpl`,
      all of which were correcting how it interprets a value that never arrived. On a renamed board
      `todo` is declared nowhere, so the resolver took its "no usable history" branch and returned the
      COMPLETE lane: a card archived mid-implementation came back marked finished. Proven end to end
      in `workflow-unarchive-target-live-e2e.pg.test.ts`.

      `task.column` is the pre-archive column at this point — the entry's own `column` is set to
      `"archived"` on the line above, so this is the last place the original is still in hand. The
      `??` keeps an already-captured value, so a re-archive of a restored card does not overwrite the
      history with an intermediate lane.

      DEFAULT-BOARD BEHAVIOUR CHANGES, deliberately: a card archived from `done` restored to `todo`
      under the literal and now restores to `done`. Returning finished work to the queue was the
      fallback showing through, not a rule anyone chose — the resolver's own branches say a card
      archived from a declared column goes back to it.
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
      Archiving must retain GitLab provenance just as live TaskStore persistence does;
      restored imports need their original GitLab tracking item for reconciliation.
      */
      gitlabTracking: task.gitlabTracking,
      sourceIssue: task.sourceIssue,
      attachments: task.attachments,
      comments: task.comments,
      review: task.review,
      reviewState: task.reviewState,
      prompt,
      ...agentLogFields,
      log: [{ timestamp: archivedAt, action: "Task archived" }],
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      columnMovedAt: task.columnMovedAt,
      firstExecutionAt: task.firstExecutionAt,
      cumulativeActiveMs: task.cumulativeActiveMs,
      cumulativePlanningMs: task.cumulativePlanningMs,
      planningStartedAt: task.planningStartedAt,
      executionStartedAt: task.executionStartedAt,
      executionCompletedAt: task.executionCompletedAt,
      archivedAt,
      modelPresetId: task.modelPresetId,
      modelProvider: task.modelProvider,
      credentialInstanceId: task.credentialInstanceId,
      modelId: task.modelId,
      validatorModelProvider: task.validatorModelProvider,
      validatorCredentialInstanceId: task.validatorCredentialInstanceId,
      validatorModelId: task.validatorModelId,
      planningModelProvider: task.planningModelProvider,
      planningCredentialInstanceId: task.planningCredentialInstanceId,
      planningModelId: task.planningModelId,
      mergerModelProvider: task.mergerModelProvider,
      mergerCredentialInstanceId: task.mergerCredentialInstanceId,
      mergerModelId: task.mergerModelId,
      mergerThinkingLevel: task.mergerThinkingLevel,
      breakIntoSubtasks: task.breakIntoSubtasks,
      noCommitsExpected: task.noCommitsExpected,
      baseBranch: task.baseBranch,
      branch: task.branch,
      branchContext: task.branchContext,
      autoMerge: task.autoMerge,
      baseCommitSha: task.baseCommitSha,
      mergeRetries: task.mergeRetries,
      error: task.error,
      modifiedFiles: task.modifiedFiles,
      declaredSymbols: task.declaredSymbols,
      missionId: task.missionId,
      sliceId: task.sliceId,
      assigneeUserId: task.assigneeUserId,
      mergeDetails: task.mergeDetails,
    };
  }

type DeleteTaskBackendOptions = { removeDependencyReferences?: boolean; removeLineageReferences?: boolean; allowResurrection?: boolean; githubIssueAction?: GithubIssueAction; closureContext?: TaskDeleteClosureContext; auditContext?: TaskDeleteAuditContext; };
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
    /* FNXC:WorkflowResolvedColumns 2026-07-31-23:59: resolved archive lanes, so an archived child no
       longer blocks its parent on a renamed board. Fail-soft to undefined -> the legacy id. */
    const lineageArchivedLanes = await resolveProjectColumnsForRoles(store, ["archived"]).catch(() => undefined);
    const lineageChildIds = await findLiveLineageChildrenAsync(layer.db, id, layer.projectId, lineageArchivedLanes);
    if (lineageChildIds.length > 0 && !options?.removeLineageReferences) {
      throw new TaskHasLineageChildrenError(id, lineageChildIds);
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
      deletion = await layer.transactionImmediate(async (tx) => {
      if (context) await resolveAndAssertLineageCandidatesUnchanged(tx, id, layer.projectId, lineageArchivedLanes, context.candidateIds);
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
          ...buildDeleteClosureAuditFields(options?.closureContext),
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
          closureContext: options?.closureContext ?? null,
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
    });
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
      ? await runLineageInvalidation(store, id, { archivedColumns: lineageArchivedLanes, initialCandidateIds: lineageChildIds }, executeDelete)
      : await executeDelete();

    if (!deletion.claimed) return deletion;

    // Emit lifecycle event (best-effort, outside the transaction).
    store.laneCache.invalidate(task.id);
    store.emit("task:deleted", task, {
      githubIssueAction: options?.githubIssueAction ?? "auto",
      ...(options?.closureContext ? { closureContext: options.closureContext } : {}),
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
  options?: { removeDependencyReferences?: boolean; removeLineageReferences?: boolean; allowResurrection?: boolean; githubIssueAction?: GithubIssueAction; closureContext?: TaskDeleteClosureContext; auditContext?: TaskDeleteAuditContext },
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
    /* FNXC:WorkflowResolvedColumns 2026-07-31-23:59: resolved archive lanes, so an archived child no
       longer blocks its parent on a renamed board. Fail-soft to undefined -> the legacy id. */
    const lineageArchivedLanes = await resolveProjectColumnsForRoles(store, ["archived"]).catch(() => undefined);
    const lineageChildIds = await findLiveLineageChildrenAsync(layer.db, id, layer.projectId, lineageArchivedLanes);
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
FNXC:WorkflowResolvedColumns 2026-07-30-18:20 (batch-core):
The archived lanes for one task, resolved from its own workflow. Shared by the archive and unarchive
guards below so the two cannot disagree about what "archived" means — one refusing a card the other
would accept is the half-converted-pair shape.

A workflow expressing NO trait on any column is a v1 upgrade (`synthesizeDefaultColumns` emits
`traits: []` everywhere) rather than a board without an archive lane, so it keeps the legacy id — as
does a workflow that cannot be read.
*/
async function archivedLanesForTask(store: TaskStore, taskId: string): Promise<ReadonlySet<string>> {
  const lanes = new Set<string>(["archived"]);
  try {
    const ir = await resolveWorkflowIrForTask(store, taskId);
    if (ir && declaresAnyLifecycleTrait(ir)) {
      for (const id of columnsWithFlag(ir, "archived")) lanes.add(id);
    }
  } catch { /* degraded: the legacy id */ }
  return lanes;
}

export async function archiveTaskBackendImpl(store: TaskStore, id: string, optionsOrCleanup: boolean | { cleanup?: boolean; removeLineageReferences?: boolean },): Promise<Task> {
    const layer = store.asyncLayer!;
    const cleanup = typeof optionsOrCleanup === "boolean" ? optionsOrCleanup : optionsOrCleanup.cleanup !== false;
    const removeLineageRefs = typeof optionsOrCleanup === "object" && optionsOrCleanup.removeLineageReferences === true;

    // Read the task (forensic: include deleted for idempotency check).
    const task = await store.getTask(id);
    if (!task) {
      throw new Error(`Task ${id} not found`);
    }
    /*
    FNXC:WorkflowResolvedColumns 2026-07-30-18:20 (batch-core):
    Keyed on the literal, a renamed board let an ALREADY-archived card be archived again — a second
    archive pass over a row the archive already owns.
    */
    if ((await archivedLanesForTask(store, id)).has(task.column)) {
      throw new Error(`Cannot archive ${id}: task is already archived`);
    }

    const fromColumn = task.column as Column;
    const archivedAt = new Date().toISOString();

    // Build the archive entry for cold storage.
    const entry = await store.taskToArchiveEntry(task, archivedAt);

    /*
    FNXC:SpecLockLineageInvalidation 2026-08-10-14:33:
    Archive keeps its legacy archived-lane semantics (undefined -> "archived") but threads that
    one value through pre-read and gate. The workspace reservation is created inside the locked body.
    */
    const archiveLineageArchivedLanes: ReadonlySet<string> | undefined = undefined;
    const archiveRun = async (context?: { candidateIds: string[]; promptByChildId: ReadonlyMap<string, string>; locksHeld: boolean; attempt: number }) => {
      const preparedWorkspace = cleanup ? await prepareArchivedWorkspaceWorktrees(store, task) : undefined;
      try {
        const result = await archiveParentTaskWithLineageGate(layer, id, entry, {
          removeLineageReferences: removeLineageRefs,
          now: archivedAt,
          archivedColumns: archiveLineageArchivedLanes,
          ...(context ? {
            revalidateAgainst: context.candidateIds,
            promptByChildId: context.promptByChildId,
            evidenceTargetVersionForTest: lineageEvidenceTargetVersionForTest(store),
            beforeLineageGate: (store as unknown as { __beforeArchiveLineageGateForTest?: () => void | Promise<void> }).__beforeArchiveLineageGateForTest,
          } : {}),
          beforeArchive: async (tx) => {
            const linkedFeature = await getMissionFeatureByTaskId(tx, id);
            if (linkedFeature) {
              await recordGeneratedFixOperatorStop(tx, linkedFeature, "task-archive");
              await unlinkMissionFeatureFromTaskId(tx, linkedFeature.id);
            }
          },
        });
        // Reconcile only rows the guarded UPDATE actually cleared; candidates can reparent away.
        if (context) {
          const lineageOutcome = result.archived
            ? result.lineageOutcome ?? { clearedChildIds: [], evidenceVersionByChild: new Map<string, number>(), evidenceUnavailableChildIds: [], evidenceInsertAttempts: 0 }
            : { clearedChildIds: [], evidenceVersionByChild: new Map<string, number>(), evidenceUnavailableChildIds: [], evidenceInsertAttempts: 0 };
          recordLineageInvalidationOutcome(store, {
            attempt: context.attempt, locksHeld: context.locksHeld, degraded: !context.locksHeld,
            candidateIds: context.candidateIds, ...lineageOutcome,
            ...(result.archived ? {} : { error: "gate-rejected" as const }),
          });
          if (result.archived) await reconcileClearedLineageChildren(store, lineageOutcome.clearedChildIds, { locksHeld: context.locksHeld });
        }
        return { result, preparedWorkspace };
      } catch (error) {
        if (context) recordLineageInvalidationOutcome(store, {
          attempt: context.attempt, locksHeld: context.locksHeld, degraded: !context.locksHeld,
          candidateIds: context.candidateIds, clearedChildIds: [], evidenceVersionByChild: new Map(),
          evidenceUnavailableChildIds: [], evidenceInsertAttempts: 0,
          error: classifyLineageInvalidationOutcomeError(error),
        });
        if (preparedWorkspace) await releasePreparedWorkspaceArchiveDisposal(preparedWorkspace);
        throw error;
      }
    };
    const archiveExecution = removeLineageRefs
      ? await runLineageInvalidation(store, id, { archivedColumns: archiveLineageArchivedLanes }, archiveRun)
      : await archiveRun();
    const result = archiveExecution.result;
    const preparedWorkspace = archiveExecution.preparedWorkspace;
    if (!result.archived) {
      if (preparedWorkspace) await releasePreparedWorkspaceArchiveDisposal(preparedWorkspace);
      throw new TaskHasLineageChildrenError(id, result.liveChildIds);
    }

    // File-system cleanup if requested.
    const dir = store.taskDir(id);
    if (cleanup) {
      /*
      FNXC:WorkflowLifecycle 2026-07-16-10:00:
      PostgreSQL must accept the lineage-child gate before destructive cleanup.
      A rejected archive leaves its live task and pinned worktree untouched;
      successful archives still await disposal before publishing the move event.
      */
      const workspace = await disposeArchivedWorkspaceWorktrees(store, task, preparedWorkspace);
      if (!workspace.singularDeduplicated) await disposeArchivedWorktree(store, task);
      await store.cleanupBranchForTask(task);
      const { rm } = await import("node:fs/promises");
      await rm(dir, { recursive: true, force: true });
      if (store.isWatching) {
        store.taskCache.delete(id);
      }
    }

    // Update the task object to reflect the archived state for the event.
    task.column = "archived" as Column;
    task.columnMovedAt = archivedAt;
    task.updatedAt = archivedAt;
    task.deletedAt = archivedAt;

    /*
    FNXC:WorkflowEvents 2026-07-31-00:40 (fleet):
    Carry the resolved lanes, like the main move path in `moves.ts`. Listeners read `task:moved`
    synchronously and cannot resolve for themselves, so an emit WITHOUT lanes hands every consumer
    its legacy fallback — which on a renamed board is the wrong answer, not a missing one.

    Concretely: the executor's archive branch releases the task's active-session registry entry, and
    that entry is what blocks a SUCCESSOR task from acquiring the same path. Emitting this transition
    lane-less left that leak reachable through this path even after the listener itself was fixed.
    */
    const movedLanes = toTaskMoveLanes(await resolveWorkflowIrForTask(store, task.id).catch(() => undefined));
    store.laneCache.set(task.id, movedLanes);
    store.emit("task:moved", { task, from: fromColumn, to: "archived" as Column, source: "engine", lanes: movedLanes });
    store.laneCache.invalidate(task.id);

    // Best-effort near-duplicate cleanup.
    await store.clearNearDuplicateReferencesToFailSoft(id, {
      /*
      FNXC:TaskStoreArchiveLifecycle 2026-08-01-23:23 DELIBERATE-LITERAL — STATE MARKER:
      This cleanup follows the physical archive transition after soft deletion. It must identify the
      durable archive marker rather than a custom workflow archived lane, which may still hold live work.
      */
      column: "archived",
      reason: "archived",
    });

    return store.archiveEntryToTask(entry, false);
  }

/**
 * FNXC:ArchivePagination 2026-07-08-00:00:
 * Dedicated archived-only read path for the Archived board column (FN-7659).
 * The merged `listTasks({includeArchived:true})` path re-sorts everything
 * (active + archived) by `createdAt ASC`, which is correct for the merged
 * consumers but wrong for the Archived column (must be newest-first) and
 * unbounded. This reads ONLY archive cold storage via a bounded LIMIT/OFFSET
 * page ordered `archivedAt DESC` — do not re-sort by createdAt and do not use
 * as a substitute for the merged path. Backend mode reads `archive.archived_tasks`
 * via async Drizzle; the sqlite path mirrors upstream's `archiveDb.listPage()`.
 */
export async function listArchivedTasksImpl(store: TaskStore, options?: {
  limit?: number;
  offset?: number;
  slim?: boolean;
}): Promise<{ tasks: Task[]; total: number; hasMore: boolean }> {
    const rawLimit = options?.limit ?? 100;
    const limit = Math.min(500, Math.max(1, Math.trunc(rawLimit) || 100));
    const rawOffset = options?.offset ?? 0;
    const offset = Math.max(0, Math.trunc(rawOffset) || 0);
    const slim = options?.slim ?? true;

        const layer = store.asyncLayer!;
    // FNXC:MultiProjectIsolation 2026-07-12 (PR #2007 review): the archived
    // board and its count are scoped to the bound project — the shared
    // cold-storage table would otherwise surface every project's archived
    // tasks in every project's dashboard.
    const total = await getArchivedRowCount(layer.db, layer.projectId);
    const entries = await listArchivedTaskEntriesPage(layer.db, limit, offset, layer.projectId);
    const tasks = entries.map((entry) => store.archiveEntryToTask(entry, slim));
    return { tasks, total, hasMore: offset + tasks.length < total };
}

export async function unarchiveTaskImpl(store: TaskStore, id: string): Promise<Task> {
    /*
     * FNXC:SqliteFinalRemoval 2026-06-25:
     * Backend-mode unarchiveTask: uses async archive helpers to read from PG
     * archive table, restore the task to active storage, and delete the archive
     * entry — all without touching store.db or store.archiveDb (SQLite).
     */
        const layer = store.asyncLayer!;
    /*
    FNXC:ArchiveRestore 2026-07-14-18:48:
    Public getTask deliberately falls back to cold storage when the live row is tombstoned. Unarchive must inspect the live table directly so that fallback cannot masquerade as an already-restored row and leave deleted_at set after deleting the only cold snapshot.
    */
    const liveRow = await readTaskRowAsync(layer, id, { includeDeleted: true });
    const entry = await findArchivedTaskEntry(layer.db, id, layer.projectId);
    let task: Task;
    if (entry) {
      /*
      FNXC:ArchiveRestore 2026-07-14-21:48:
      A cold snapshot may outlive a missing project.tasks row after cleanup or partial legacy archival. Rebuild that row through the canonical snapshot restoration path before restoreTaskFromArchive consumes the snapshot; an existing live or tombstoned row keeps the established in-place restore path.
      */
      if (!liveRow) {
        await store.restoreFromArchive(entry);
      }
      await restoreTaskFromArchive(layer, entry);
      task = await store.getTask(id);
    } else if (liveRow && liveRow.deletedAt == null) {
      task = await store.getTask(id);
    } else {
      throw new Error(`Cannot unarchive ${id}: task is missing from active storage and not found in archive`);
    }

    /*
    FNXC:WorkflowResolvedColumns 2026-07-30-18:50 DELIBERATE-LITERAL: the value is literally "archived" by construction.

    I converted this and then proved the conversion INERT, which is worth recording so it is not
    attempted a third time. `task` here comes from the archive entry, and `archiveEntryToTask`
    (serialization.ts:353) hardcodes `column: "archived"` on every task it reconstructs. So this
    comparison can only ever see the literal, on every board, renamed or not — resolving lanes here
    changes no outcome and only makes the guard look converted.

    The board's own archive lane is not involved: a card in cold storage has left the board entirely.
    If archived rows ever start carrying their originating board's lane id, this becomes a real guard
    and should be converted then.
    */
    if (task.column !== "archived") {
      throw new Error(`Cannot unarchive ${id}: task is in '${task.column}', must be in 'archived'`);
    }

    /*
    FNXC:WorkflowLifecycleColumns 2026-08-01-12:40 (PR #2824's finding, fixed — read the SNAPSHOT):
    THE HISTORY LIVES IN COLD STORAGE, NOT ON THE ROW. `preArchiveColumn` has no column in
    `project.tasks` — it exists on the `Task` type and in the archive entry, and nowhere else. So the
    in-place restore above cannot carry it, `store.getTask(id)` reads a live row that never had it,
    and `task.preArchiveColumn` was `undefined` for every unarchive that has ever run. The `?? "todo"`
    then decided the destination by literal instead of by history.

    On the default board `todo` is declared, so restores landed in the queue and looked right — which
    is why this survived three separate fixes to `resolveUnarchiveTargetColumnImpl`, every one of them
    correcting how it interprets a value that never arrived. On a renamed board `todo` is declared
    nowhere, so the resolver took its "no usable history" branch and returned the COMPLETE lane: a
    card archived mid-implementation came back marked finished.

    `entry` is the snapshot this function already loaded, and it is the only place the original column
    survives. Preferred over the row, which falls back to it, which falls back to the literal for a
    row so old it was archived before the column was captured at all.
    */
    const preArchiveColumn = entry?.preArchiveColumn ?? task.preArchiveColumn ?? "todo";
    const toColumn = await store.resolveUnarchiveTargetColumn(preArchiveColumn, id);

    /*
     * FNXC:SqliteFinalRemoval 2026-06-25:
     * Directly update the column instead of calling moveTask. The VALID_TRANSITIONS
     * graph only allows archived→done, but unarchive needs to restore to the
     * preArchiveColumn (todo/in-progress/etc). The SQLite path bypasses transition
     * validation by directly setting task.column; the backend path must do the same
     * via a direct UPDATE. Using moveTask would throw "Invalid transition" for any
     * target other than "done".
     */
    const now = new Date().toISOString();
    await layer.db
      .update(schema.project.tasks)
      .set({
        column: toColumn,
        deletedAt: null,
        columnMovedAt: now,
        updatedAt: now,
      })
      .where(and(
        eq(schema.project.tasks.projectId, projectPartition(layer.projectId)),
        eq(schema.project.tasks.id, id),
      ));

    const updatedTask = await store.getTask(id);

    // Log the unarchive action.
    await store.logEntry(id, "Task unarchived");

    // Remove from archive table.
    await deleteArchivedTaskEntry(layer.db, id, layer.projectId);

    return updatedTask;
}

export async function restoreFromArchiveImpl(store: TaskStore, entry: import("../types.js").ArchivedTaskEntry): Promise<Task> {
    const dir = store.taskDir(entry.id);

    // Create task directory
    await mkdir(dir, { recursive: true });

    // Build restored task (clear transient fields)
    const restoredTask: Task = {
      id: entry.id,
      lineageId: entry.lineageId || generateTaskLineageId(),
      title: entry.title,
      description: entry.description,
      priority: normalizeTaskPriority(entry.priority),
      column: "archived", // Will be changed by unarchiveTask
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
      updatedAt: new Date().toISOString(),
      columnMovedAt: entry.columnMovedAt,
      modelPresetId: entry.modelPresetId,
      modelProvider: entry.modelProvider,
      credentialInstanceId: entry.credentialInstanceId,
      modelId: entry.modelId,
      validatorModelProvider: entry.validatorModelProvider,
      validatorCredentialInstanceId: entry.validatorCredentialInstanceId,
      validatorModelId: entry.validatorModelId,
      planningModelProvider: entry.planningModelProvider,
      planningCredentialInstanceId: entry.planningCredentialInstanceId,
      planningModelId: entry.planningModelId,
      mergerModelProvider: entry.mergerModelProvider,
      mergerCredentialInstanceId: entry.mergerCredentialInstanceId,
      mergerModelId: entry.mergerModelId,
      mergerThinkingLevel: entry.mergerThinkingLevel,
      breakIntoSubtasks: entry.breakIntoSubtasks,
      noCommitsExpected: entry.noCommitsExpected,
      modifiedFiles: entry.modifiedFiles,
      declaredSymbols: entry.declaredSymbols,
      // Intentionally NOT restoring: worktree, status, blockedBy, paused, executionStartBranch, baseCommitSha, error
    };

    // Write task.json
    await store.atomicWriteTaskJson(dir, restoredTask);

    // Generate PROMPT.md with preserved steps
    const prompt = entry.prompt ?? store.generatePromptFromArchiveEntry(entry);
    const sanitizedPrompt = sanitizeFileScopeInPromptContent(prompt);
    if (sanitizedPrompt.dropped.length > 0) {
      storeLog.log(`[file-scope-sanitize] restore ${entry.id}: dropped=[${sanitizedPrompt.dropped.join(",")}]`);
    }
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "PROMPT.md"), sanitizedPrompt.sanitized);

    // Create empty attachments directory if attachments existed
    if (entry.attachments && entry.attachments.length > 0) {
      await mkdir(join(dir, "attachments"), { recursive: true });
    }

    return restoredTask;
  }
