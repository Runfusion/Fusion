/**
 * FNXC:CodeOrganization 2026-07-19-12:00:
 * Domain rename from branch-and-pr-entities: branch groups, PR entities, and PR thread state.
 *
 * FNXC:StoreModularization 2026-06-25-00:00:
 * Extracted from the monolithic packages/core/src/store.ts as a pure
 * behavior-preserving refactor. Each function receives the TaskStore
 * instance as its first parameter and performs byte-identical work.
 */

import { TaskStore } from "../store.js";
import { filterTasksByBranchGroup } from "../branch-assignment.js";
import { BUILTIN_WORKFLOW_SETTINGS } from "../builtin-workflow-settings.js";
import { isBuiltinWorkflowId } from "../builtin-workflows.js";
import { FINGERPRINT_WINDOW_DEFAULT_MS, FINGERPRINT_WINDOW_MAX_MS } from "../duplicate-guard.js";
import * as schema from "../postgres/schema/index.js";
import { taskProjectScope } from "../postgres/data-layer.js";
import { ensureBranchGroupForSource as ensureBranchGroupForSourceAsync, ensurePrEntityForSource as ensurePrEntityForSourceAsync, getActivePrEntityBySource as getActivePrEntityBySourceAsync, getBranchGroup as getBranchGroupAsync, getBranchGroupByBranchName as getBranchGroupByBranchNameAsync, getBranchGroupBySource as getBranchGroupBySourceAsync, getPrEntity as getPrEntityAsync, getPrThreadState as getPrThreadStateAsync, listActivePrEntities as listActivePrEntitiesAsync, listBranchGroups as listBranchGroupsAsync, listPrThreadStates as listPrThreadStatesAsync, recordPrThreadOutcome as recordPrThreadOutcomeAsync } from "./async-branch-groups.js";
import { getWorkflowWorkItem as getWorkflowWorkItemAsync } from "./async-workflow-workitems.js";
import { MergeRequestRow, PrEntityRow, WorkflowWorkItemRow } from "./row-types.js";
import { BranchGroup, BranchGroupCreateInput, ColumnId, MergeRequestRecord, MergeRequestState, PrEntity, PrEntityCreateInput, PrThreadOutcome, PrThreadState, RunMutationContext, Task, TaskLogEntry, TaskPriority, TaskVerificationRequest, TaskVerificationResultSummary, TaskVerificationStatus, WorkflowWorkItem, WorkflowWorkItemKind, WorkflowWorkItemState, WorkflowWorkItemTransitionPatch } from "../types.js";
import { validateNodeOverrideChange } from "../node-override-guard.js";
import { WorkflowMovePolicyInput } from "../workflow-extension-types.js";
import { resolveWorkflowIrById } from "../workflow-ir-resolver.js";
import { WorkflowSettingDefinition } from "../workflow-ir-types.js";
import { and, asc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MoveTaskInternalOptions, MoveTaskOptions, storeLog } from "../store.js";

export async function getBranchGroupImpl(store: TaskStore, id: string): Promise<BranchGroup | null> {
    // FNXC:RuntimeWorkflowAsync 2026-06-24-16:21:
        const layer = store.asyncLayer!;
    return getBranchGroupAsync(layer.db, id);
}

export async function getBranchGroupBySourceImpl(store: TaskStore, sourceType: BranchGroup["sourceType"], sourceId: string): Promise<BranchGroup | null> {
        const layer = store.asyncLayer!;
    return getBranchGroupBySourceAsync(layer.db, sourceType, sourceId);
}

export async function getBranchGroupByBranchNameImpl(store: TaskStore, branchName: string): Promise<BranchGroup | null> {
        const layer = store.asyncLayer!;
    return getBranchGroupByBranchNameAsync(layer.db, branchName);
}

export async function ensureBranchGroupForSourceImpl(store: TaskStore,
    sourceType: BranchGroup["sourceType"],
    sourceId: string,
    init: Omit<BranchGroupCreateInput, "sourceType" | "sourceId">,
  ): Promise<BranchGroup> {
    /*
    FNXC:SqliteDualPathCleanup 2026-07-26-14:07:
    Branch-group ensure is PostgreSQL-only via ensureBranchGroupForSourceAsync (UNIQUE branchName reuse lives in the async helper).
    */
    return ensureBranchGroupForSourceAsync(store.asyncLayer!.db, sourceType, sourceId, init);
}

export async function listBranchGroupsImpl(store: TaskStore, options?: { status?: BranchGroup["status"] }): Promise<BranchGroup[]> {
        const layer = store.asyncLayer!;
    return listBranchGroupsAsync(layer.db, options);
}

/*
FNXC:BranchGroupCompletion 2026-07-18-01:55:
Archived shared-branch members remain part of promotion completion: an unlanded archived
member blocks promotion, while an archived member with persisted landing proof permits it.
The PostgreSQL path must therefore load archived tasks before applying group membership.
*/
export async function listTasksByBranchGroupImpl(store: TaskStore, groupId: string): Promise<Task[]> {
    const tasks = await store.listTasks({ includeArchived: true, slim: false });
    // Membership filter (incl. legacy synthetic-groupId fallback) is shared with
    // the dashboard list route via `filterTasksByBranchGroup` so semantics can't
    // drift between the two call sites (Fix #8/#9).
    const group = await store.getBranchGroup(groupId);
    return filterTasksByBranchGroup(tasks, group, groupId).sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );
}

export async function getPrEntityImpl(store: TaskStore, id: string): Promise<PrEntity | null> {
        const layer = store.asyncLayer!;
    return getPrEntityAsync(layer.db, id);
}

export async function getActivePrEntityBySourceImpl(store: TaskStore, sourceType: PrEntity["sourceType"], sourceId: string): Promise<PrEntity | null> {
        const layer = store.asyncLayer!;
    return getActivePrEntityBySourceAsync(layer.db, sourceType, sourceId);
}

export async function getPrEntityByNumberImpl(store: TaskStore, repo: string, prNumber: number): Promise<PrEntity | null> {
    // No dedicated async helper for by-number lookup; use the sync path's SQL
    // shape via a raw Drizzle query in backend mode.
        const layer = store.asyncLayer!;
    const rows = await layer.db
      .select()
      .from(schema.project.pullRequests)
      .where(and(eq(schema.project.pullRequests.repo, repo), eq(schema.project.pullRequests.prNumber, prNumber)))
      .limit(1);
    const row = rows[0] as PrEntityRow | undefined;
    return row ? store.rowToPrEntity(row) : null;
}

export async function ensurePrEntityForSourceImpl(store: TaskStore, input: PrEntityCreateInput): Promise<PrEntity> {
        const layer = store.asyncLayer!;
    return ensurePrEntityForSourceAsync(layer.db, input);
}

export async function listActivePrEntitiesImpl(store: TaskStore): Promise<PrEntity[]> {
        const layer = store.asyncLayer!;
    return listActivePrEntitiesAsync(layer.db);
}

export async function getPrThreadStateImpl(store: TaskStore, prEntityId: string, threadId: string, headOid: string): Promise<PrThreadState | null> {
        const layer = store.asyncLayer!;
    return getPrThreadStateAsync(layer.db, prEntityId, threadId, headOid);
}

export async function listPrThreadStatesImpl(store: TaskStore, prEntityId: string): Promise<PrThreadState[]> {
        const layer = store.asyncLayer!;
    return listPrThreadStatesAsync(layer.db, prEntityId);
}

export async function recordPrThreadOutcomeImpl(store: TaskStore,
    prEntityId: string,
    threadId: string,
    headOid: string,
    outcome: PrThreadOutcome,
    fixCommitSha?: string,
  ): Promise<void> {
        const layer = store.asyncLayer!;
    return recordPrThreadOutcomeAsync(layer.db, prEntityId, threadId, headOid, outcome, fixCommitSha);
}

export async function getBranchProgressByTaskImpl(store: TaskStore,
    taskIds: readonly string[],
  ): Promise<Map<string, Array<{ branchId: string; nodeId: string; status: string }>>> {
    const result = new Map<string, Array<{ branchId: string; nodeId: string; status: string }>>();
    if (taskIds.length === 0) return result;
    /*
    FNXC:PostgresOnlyDataAccess 2026-07-16-12:10:
    Backend mode previously fell into the sync catch below and silently
    returned an empty map, dropping branchProgress from every task payload on
    PostgreSQL. Read the rows async and resolve the winning (latest updatedAt,
    runId tie-break) run per task in JS — per-task row counts are small.
    */
        const table = schema.project.workflowRunBranches;
    const rows = await store.asyncLayer!.db
      .select({
        taskId: table.taskId,
        runId: table.runId,
        branchId: table.branchId,
        nodeId: table.currentNodeId,
        status: table.status,
        updatedAt: table.updatedAt,
      })
      .from(table)
      .where(inArray(table.taskId, taskIds as string[]));
    const latestRunByTask = new Map<string, { runId: string; updatedAt: string }>();
    for (const row of rows) {
      const current = latestRunByTask.get(row.taskId);
      if (!current
        || row.updatedAt > current.updatedAt
        || (row.updatedAt === current.updatedAt && row.runId > current.runId)) {
        latestRunByTask.set(row.taskId, { runId: row.runId, updatedAt: row.updatedAt });
      }
    }
    for (const row of rows) {
      if (latestRunByTask.get(row.taskId)?.runId !== row.runId) continue;
      const list = result.get(row.taskId) ?? [];
      list.push({ branchId: row.branchId, nodeId: row.nodeId, status: row.status });
      result.set(row.taskId, list);
    }
    return result;
}

export async function loadWorkflowRunBranchesImpl(store: TaskStore,
    taskId: string,
    runId: string,
  ): Promise<Array<{
    taskId: string;
    runId: string;
    branchId: string;
    currentNodeId: string;
    status: "running" | "completed" | "failed" | "aborted";
  }>> {
    /*
    FNXC:PostgresOnlyDataAccess 2026-07-16-12:10:
    Backend mode previously returned [] from the sync catch, so parallel-branch
    workflow runs lost their crash-recovery checkpoints on PostgreSQL.
    */
        const table = schema.project.workflowRunBranches;
    const rows = await store.asyncLayer!.db
      .select({
        taskId: table.taskId,
        runId: table.runId,
        branchId: table.branchId,
        currentNodeId: table.currentNodeId,
        status: table.status,
      })
      .from(table)
      .where(and(eq(table.taskId, taskId), eq(table.runId, runId)));
    return rows as Array<{
      taskId: string;
      runId: string;
      branchId: string;
      currentNodeId: string;
      status: "running" | "completed" | "failed" | "aborted";
    }>;
}

export async function saveWorkflowRunStepInstanceImpl(store: TaskStore,
    state: import("../types.js").WorkflowRunStepInstance,
  ): Promise<void> {
    /*
    FNXC:PostgresOnlyDataAccess 2026-07-16-13:40:
    Backend mode previously swallowed the sync throw, so foreach step-instance
    checkpoints were never persisted on PostgreSQL. Delegate to the FN-8157
    async sibling (single PG code path); its !backendMode branch routes back
    here, guarded so there is no recursion.
    */
        return saveWorkflowRunStepInstanceAsyncImpl(store, state);
}

export async function loadWorkflowRunStepInstancesImpl(store: TaskStore,
    taskId: string,
    runId: string,
  ): Promise<import("../types.js").WorkflowRunStepInstance[]> {
    // FNXC:PostgresOnlyDataAccess 2026-07-16-13:40: see saveWorkflowRunStepInstanceImpl.
        return loadWorkflowRunStepInstancesAsyncImpl(store, taskId, runId);
}

export async function clearWorkflowRunStepInstancesImpl(store: TaskStore, taskId: string, keepRunId?: string): Promise<void> {
    // FNXC:PostgresOnlyDataAccess 2026-07-16-13:40: see saveWorkflowRunStepInstanceImpl.
        return clearWorkflowRunStepInstancesAsyncImpl(store, taskId, keepRunId);
}

/*
FNXC:WorkflowStepInstancePersistence 2026-07-16-20:20:
PostgreSQL backend mode cannot use the removed synchronous SQLite `store.db`
path. These async siblings preserve the existing identity, pin-clearing, and
stale-run pruning semantics through the Drizzle async layer rather than
silently dropping foreach crash-resume state.
*/
export async function saveWorkflowRunStepInstanceAsyncImpl(
  store: TaskStore,
  state: import("../types.js").WorkflowRunStepInstance,
): Promise<void> {
  
  const layer = store.asyncLayer!;
  const now = new Date().toISOString();
  await layer.db
    .insert(schema.project.workflowRunStepInstances)
    .values({
      taskId: state.taskId,
      runId: state.runId,
      foreachNodeId: state.foreachNodeId,
      stepIndex: state.stepIndex,
      pinnedStepCount: state.pinnedStepCount,
      currentNodeId: state.currentNodeId ?? null,
      status: state.status,
      baselineSha: state.baselineSha ?? null,
      checkpointId: state.checkpointId ?? null,
      reworkCount: state.reworkCount ?? 0,
      branchName: state.branchName ?? null,
      integratedAt: state.integratedAt ?? null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        schema.project.workflowRunStepInstances.projectId,
        schema.project.workflowRunStepInstances.taskId,
        schema.project.workflowRunStepInstances.runId,
        schema.project.workflowRunStepInstances.foreachNodeId,
        schema.project.workflowRunStepInstances.stepIndex,
      ],
      set: {
        pinnedStepCount: state.pinnedStepCount,
        currentNodeId: state.currentNodeId ?? null,
        status: state.status,
        baselineSha: state.baselineSha ?? null,
        checkpointId: state.checkpointId ?? null,
        reworkCount: state.reworkCount ?? 0,
        branchName: state.branchName ?? null,
        integratedAt: state.integratedAt ?? null,
        updatedAt: now,
      },
    });
}

export async function loadWorkflowRunStepInstancesAsyncImpl(
  store: TaskStore,
  taskId: string,
  runId: string,
): Promise<import("../types.js").WorkflowRunStepInstance[]> {
  
  const layer = store.asyncLayer!;
  const rows = await layer.db
    .select()
    .from(schema.project.workflowRunStepInstances)
    .where(and(
      eq(schema.project.workflowRunStepInstances.taskId, taskId),
      eq(schema.project.workflowRunStepInstances.runId, runId),
    ))
    .orderBy(asc(schema.project.workflowRunStepInstances.stepIndex));
  return rows.map((row) => ({
    taskId: row.taskId,
    runId: row.runId,
    foreachNodeId: row.foreachNodeId,
    stepIndex: row.stepIndex,
    pinnedStepCount: row.pinnedStepCount,
    currentNodeId: row.currentNodeId,
    status: row.status as import("../types.js").WorkflowRunStepInstanceStatus,
    baselineSha: row.baselineSha,
    checkpointId: row.checkpointId,
    reworkCount: row.reworkCount,
    branchName: row.branchName,
    integratedAt: row.integratedAt,
    updatedAt: row.updatedAt,
  }));
}

export async function clearWorkflowRunStepInstancesAsyncImpl(
  store: TaskStore,
  taskId: string,
  keepRunId?: string,
): Promise<void> {
  
  const layer = store.asyncLayer!;
  const conditions = [eq(schema.project.workflowRunStepInstances.taskId, taskId)];
  if (keepRunId !== undefined) {
    conditions.push(ne(schema.project.workflowRunStepInstances.runId, keepRunId));
  }
  await layer.db
    .delete(schema.project.workflowRunStepInstances)
    .where(and(...conditions));
}

export async function getActiveMergingTaskImpl(store: TaskStore, excludeTaskId?: string): Promise<string | undefined> {
    /*
     * FNXC:SqliteFinalRemoval 2026-06-26:
     * P0 fix: this method had no backendMode branch and threw on every merge in
     * PG mode (store.db getter throws). In backend mode, query the tasks table
     * via Drizzle, filtering on the same live + merging-status predicate the
     * SQLite path used (TaskStore.ACTIVE_TASKS_WHERE ≡ deletedAt IS NULL).
     */
        const layer = store.asyncLayer!;
    const conditions = [
      isNull(schema.project.tasks.deletedAt),
      inArray(schema.project.tasks.status, ["merging", "merging-pr"]),
    ];
    /*
     * FNXC:PostgresProjectIsolation 2026-07-17-00:00:
     * The cross-process merge guard is documented (project-engine.ts) as
     * "another process is already merging a task for THIS project" — in
     * SQLite mode the per-project DB file made that scoping implicit. The
     * shared PG tasks table needs the explicit project_id filter; without it
     * one merging task anywhere serializes merges across ALL projects
     * (observed: 697 cross-project "Merge deferred" retries in 10 minutes on
     * a 6-project deployment, collapsing merge throughput ~6x).
     */
    const scope = taskProjectScope(layer);
    if (scope) conditions.push(scope);
    if (excludeTaskId) {
      conditions.push(ne(schema.project.tasks.id, excludeTaskId));
    }
    const rows = await layer.db
      .select({ id: schema.project.tasks.id })
      .from(schema.project.tasks)
      .where(and(...conditions))
      .limit(1);
    return rows[0]?.id;
}

export async function findRecentTasksByContentFingerprintImpl(store: TaskStore,
    fingerprint: string,
    options?: { windowMs?: number; includeArchived?: boolean },
  ): Promise<Task[]> {
    const trimmedFingerprint = fingerprint.trim();
    if (trimmedFingerprint.length === 0) {
      return [];
    }

    /*
    FNXC:TaskCreationDeduplication 2026-07-26-07:40:
    Share the duplicate-guard's window constants. This query previously carried its own
    `?? 60_000` / `Math.min(300_000, …)` pair, so widening the guard alone capped the effective
    window at five minutes and made its ceiling unreachable — the guard asked for ten minutes
    and silently got five. One policy, one pair of bounds.
    */
    const requestedWindowMs = options?.windowMs ?? FINGERPRINT_WINDOW_DEFAULT_MS;
    const windowMs = Math.max(1, Math.min(FINGERPRINT_WINDOW_MAX_MS, Math.trunc(requestedWindowMs)));
    const cutoffIso = new Date(Date.now() - windowMs).toISOString();
    const includeArchived = options?.includeArchived ?? false;

    /*
     * FNXC:SqliteFinalRemoval 2026-06-26:
     * P1 fix: no backendMode branch existed AND the SQLite path used the
     * SQLite-only json_extract() function (no PG equivalent in that form). In
     * backend mode, query via Drizzle using the PostgreSQL jsonb `->>`
     * operator on the source_metadata column. The soft-delete visibility
     * filter (deletedAt IS NULL) and the createdAt window are preserved.
     */
        const layer = store.asyncLayer!;
    const conditions = [
      isNull(schema.project.tasks.deletedAt),
      sql`${schema.project.tasks.sourceMetadata}->>'contentFingerprint' = ${trimmedFingerprint}`,
      sql`${schema.project.tasks.createdAt} >= ${cutoffIso}`,
    ];
    if (!includeArchived) {
      conditions.push(ne(schema.project.tasks.column, "archived"));
    }
    /*
    FNXC:SqliteDualPathCleanup 2026-07-26-15:00:
    Scope fingerprint duplicate-guard to the bound project so another project's matching fingerprint cannot block create.
    */
    if (layer.projectId) {
      conditions.push(eq(schema.project.tasks.projectId, layer.projectId));
    }
    const rows = await layer.db
      .select()
      .from(schema.project.tasks)
      .where(and(...conditions))
      .orderBy(schema.project.tasks.createdAt);
    return rows.map((row) => store.rowToTask(store.pgRowToTaskRow(row as unknown as Record<string, unknown>)));
}

export async function findRecentTasksBySourceParentTaskIdImpl(
  store: TaskStore,
  sourceParentTaskId: string,
  options?: { windowMs?: number },
): Promise<Task[]> {
  const parentId = sourceParentTaskId.trim();
  if (!parentId) return [];
  const dayMs = 24 * 60 * 60 * 1000;
  const windowMs = Math.max(1, Math.min(dayMs, Math.trunc(options?.windowMs ?? dayMs)));
  const cutoffIso = new Date(Date.now() - windowMs).toISOString();
    const layer = store.asyncLayer!;
  const rows = await layer.db.select().from(schema.project.tasks).where(and(
    isNull(schema.project.tasks.deletedAt), taskProjectScope(layer),
    eq(schema.project.tasks.sourceParentTaskId, parentId),
    sql`${schema.project.tasks.createdAt} >= ${cutoffIso}`,
    ne(schema.project.tasks.column, "archived"), ne(schema.project.tasks.column, "done"),
  )).orderBy(asc(schema.project.tasks.createdAt));
  return rows.map((row) => store.rowToTask(store.pgRowToTaskRow(row as unknown as Record<string, unknown>)));
}

export async function clearNearDuplicateReferencesToFailSoftImpl(store: TaskStore,
    canonicalId: string,
    inactiveState: { column?: ColumnId | null; deletedAt?: string | null; reason: string },
  ): Promise<void> {
    try {
      await store.clearNearDuplicateReferencesTo(canonicalId, inactiveState);
    } catch (error) {
      storeLog.warn("Failed to clear stale near-duplicate references (degraded)", {
        taskId: canonicalId,
        reason: inactiveState.reason,
        error: error instanceof Error ? error.message : String(error),
      });
    }
}

export async function getTasksByAssignedAgentImpl(store: TaskStore,
    agentId: string,
    options?: { pausedOnly?: boolean; excludeArchived?: boolean },
  ): Promise<Task[]> {
    /*
     * FNXC:SqliteFinalRemoval 2026-06-25:
     * In backend mode, use listTasks and filter in-memory instead of raw SQL.
     */
        const allTasks = await store.listTasks();
    return allTasks.filter((task) => {
      if (task.assignedAgentId !== agentId) return false;
      if (options?.pausedOnly && !task.paused) return false;
      if (options?.excludeArchived && task.column === "archived") return false;
      return true;
    });
}

export function resolveWorkflowMoveActorImpl(store: TaskStore,
    moveSource: NonNullable<MoveTaskOptions["moveSource"]>,
    internal: MoveTaskInternalOptions,
    options?: MoveTaskOptions,
  ): WorkflowMovePolicyInput["actor"] {
    if (options?.workflowMoveActor) return options.workflowMoveActor;
    if (moveSource === "user") return { kind: "human" };
    if (moveSource === "scheduler") return { kind: "system" };
    if (internal.runContext?.agentId) {
      return { kind: "agent", id: internal.runContext.agentId };
    }
    return { kind: "engine" };
}

export function resetAllStepsToPendingImpl(store: TaskStore, task: Task): void {
    if (task.steps.length === 0) {
      return;
    }

    for (const step of task.steps) {
      step.status = "pending";
    }

    task.currentStep = 0;
}

export async function resetPromptCheckboxesImpl(store: TaskStore, dir: string): Promise<void> {
    const promptPath = join(dir, "PROMPT.md");
    if (!existsSync(promptPath)) {
      return;
    }

    // FNXC:TaskDetailPromptResilience 2026-07-10-15:00 (merge port from main):
    // cosmetic checkbox reset — an unreadable/unwritable PROMPT.md must not
    // fail the task reset itself; the DB reset already proceeded.
    try {
      const content = await readFile(promptPath, "utf-8");
      const resetContent = content.replace(/^- \[x\]/gm, "- [ ]");

      if (resetContent !== content) {
        await writeFile(promptPath, resetContent, "utf-8");
      }
    } catch (err) {
      storeLog.warn(`[task-detail] failed to reset PROMPT.md checkboxes in ${dir}: ${err instanceof Error ? err.message : String(err)}`);
    }
}

export async function updateTaskImpl(store: TaskStore,
    id: string,
    updates: { title?: string; description?: string; priority?: TaskPriority | null; prompt?: string; worktree?: string | null; workspaceWorktrees?: import("../types.js").Task["workspaceWorktrees"]; status?: string | null; dependencies?: string[]; steps?: import("../types.js").TaskStep[]; customFields?: Record<string, unknown>; currentStep?: number; blockedBy?: string | null; overlapBlockedBy?: string | null; assignedAgentId?: string | null; pausedByAgentId?: string | null; pausedReason?: string | null; tokenBudgetSoftAlertedAt?: string | null; worktrunkFallbackAlertedAt?: string | null; worktrunkFailure?: import("../types.js").Task["worktrunkFailure"] | null; tokenBudgetHardAlertedAt?: string | null; tokenBudgetOverride?: import("../types.js").TaskTokenBudgetOverride | null; dispatchStormCount?: number | null; lastDispatchAt?: string | null; assigneeUserId?: string | null; scopeOverride?: boolean | null; scopeOverrideReason?: string | null; scopeAutoWiden?: string[] | null; nodeId?: string | null; effectiveNodeId?: string | null; effectiveNodeSource?: string | null; checkedOutBy?: string | null; checkedOutAt?: string | null; checkoutNodeId?: string | null; checkoutRunId?: string | null; checkoutLeaseRenewedAt?: string | null; checkoutLeaseEpoch?: number | null; paused?: boolean; baseBranch?: string | null; autoMerge?: boolean | null; branch?: string | null; executionStartBranch?: string | null; baseCommitSha?: string | null; size?: "S" | "M" | "L"; reviewLevel?: number; executionMode?: import("../types.js").ExecutionMode | null; mergeRetries?: number; workflowStepRetries?: number; stuckKillCount?: number | null; resumeLimboCount?: number | null; executeRequeueLoopCount?: number | null; graphResumeRetryCount?: number | null; consecutiveToolFailureRetryCount?: number | null; executorEscalationAttempted?: boolean | null; toolFailureDetectorLogCursor?: number | null; toolFailureRetryExhaustedAuditEmitted?: boolean | null; resumeLimboTipSha?: string | null; resumeLimboStepSignature?: string | null; executeRequeueLoopSignature?: string | null; postReviewFixCount?: number | null; planReviewReplanCount?: number | null; recoveryRetryCount?: number | null; taskDoneRetryCount?: number | null; bulkCompletionRefusalAt?: string | null; workflowIrPin?: string | null; workflowIrPinNodeId?: string | null; workflowIrPinColumnId?: string | null; legacyAdoptedAt?: string | null; worktreeSessionRetryCount?: number | null; completionHandoffLimboRecoveryCount?: number | null; verificationFailureCount?: number | null; mergeConflictBounceCount?: number | null; mergeAuditBounceCount?: number | null; mergeTransientRetryCount?: number | null; branchConflictRecoveryCount?: number | null; reviewerContextRetryCount?: number | null; reviewerFallbackRetryCount?: number | null; nextRecoveryAt?: string | null; enabledWorkflowSteps?: string[]; noCommitsExpected?: boolean | null; modelProvider?: string | null; modelId?: string | null; validatorModelProvider?: string | null; validatorModelId?: string | null; planningModelProvider?: string | null; planningModelId?: string | null; mergerModelProvider?: string | null; mergerModelId?: string | null; thinkingLevel?: string | null; validatorThinkingLevel?: string | null; planningThinkingLevel?: string | null; mergerThinkingLevel?: string | null; error?: string | null; summary?: string | null; sessionFile?: string | null; firstExecutionAt?: string | null; cumulativeActiveMs?: number | null; executionStartedAt?: string | null; executionCompletedAt?: string | null; review?: import("../types.js").TaskReview | null; reviewState?: import("../types.js").TaskReviewState | null; workflowStepResults?: import("../types.js").WorkflowStepResult[] | null; mergeDetails?: import("../types.js").MergeDetails | null; sourceIssue?: import("../types.js").TaskSourceIssue | null; sourceMetadataPatch?: Record<string, unknown> | null; githubTracking?: import("../types.js").TaskGithubTracking | null; tokenUsage?: import("../types.js").TaskTokenUsage | null; modifiedFiles?: string[] | null; missionId?: string | null; sliceId?: string | null; workflowTransitionNotification?: import("../types.js").WorkflowTransitionNotificationMarker | undefined; sessionAdvisorEnabled?: boolean | null },    runContext?: RunMutationContext,
  ): Promise<Task> {
    /*
    FNXC:StateMachine 2026-07-07-12:00:
    Signature 2 (FN-7641): resolve the nodeId='end' finalize-on-proof-or-error contract ONCE here so
    the dashboard route, CLI task-update tool, and any other updateTask caller share identical
    behavior via this single choke point. Read the current task and check BEFORE acquiring the
    per-task lock (getTask/moveTask each acquire their own lock; nesting inside withTaskLock would
    deadlock since the lock is non-reentrant). A terminal-node override with durable merge proof
    finalizes the card to done via the Signature-1 recovery rehome; without proof it throws an
    explicit error instead of letting updateTaskUnlocked write a no-op nodeId field.
    */
    if (updates.nodeId !== undefined) {
      const currentTask = await store.getTask(id).catch(() => null);
      if (currentTask) {
        const validation = validateNodeOverrideChange(currentTask, updates.nodeId ?? null, {
          isTerminalNodeId: (nodeId) => isTaskTerminalNodeIdImpl(store, id, nodeId),
        });
        if (!validation.allowed) {
          throw new Error(validation.message);
        }
        if (validation.requiresFinalize) {
          await store.moveTask(id, "done", {
            moveSource: "engine",
            recoveryRehome: true,
            preserveProgress: true,
          });
        }
      }
    }
    // FNXC:RuntimeTaskOrchestrationAsync 2026-06-24-14:00:
    // Backend-mode updateTask: delegates to updateTaskUnlocked which now
    // handles backend mode by upserting the task row via async Drizzle
    // (upsertTaskRowInTransaction) inside a transactionImmediate. The task
    // object is mutated in-place exactly as in the SQLite path, then the
    // full row is written to PostgreSQL. The SQLite path is unchanged.
    return store.withTaskLock(id, () => store.updateTaskUnlocked(id, updates, runContext));
}

/**
 * FNXC:StateMachine 2026-07-07-12:00:
 * Resolve whether `nodeId` is the task's resolved workflow terminal `end` node (kind === "end"),
 * for the nodeId='end' finalize-on-proof-or-error contract (FN-7641 Signature 2). Falls back to
 * the literal id check when the workflow IR cannot be resolved or does not contain the node, which
 * still matches every built-in workflow's terminal node id.
 */
function isTaskTerminalNodeIdImpl(store: TaskStore, taskId: string, nodeId: string): boolean {
  try {
    const ir = store.resolveTaskWorkflowIrSync(taskId);
    const node = ir.nodes.find((n) => n.id === nodeId);
    if (node) return node.kind === "end";
  } catch {
    // Fall through to the literal-id fallback below.
  }
  return nodeId === "end";
}

export function mergeCustomFieldPatchImpl(store: TaskStore,
    current: Record<string, unknown> | undefined,
    patch: Record<string, unknown>,
  ): Record<string, unknown> {
    const next: Record<string, unknown> = { ...(current ?? {}) };
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) {
        delete next[key];
      } else {
        next[key] = value;
      }
    }
    return next;
}

export async function resolveWorkflowSettingDeclarationsImpl(store: TaskStore,
    workflowId: string,
  ): Promise<WorkflowSettingDefinition[] | undefined> {
    const ir = await resolveWorkflowIrById(store, workflowId);
    const declared = ir.version === "v2" ? ir.settings : undefined;
    if (declared && declared.length > 0) return declared;
    // Defensive belt: built-in ids always have a declaration catalog even if a
    // particular built-in graph somehow lacks the embed.
    if (isBuiltinWorkflowId(workflowId)) return BUILTIN_WORKFLOW_SETTINGS;
    return declared;
}

export function getWorkflowSettingsProjectIdImpl(store: TaskStore): string {
    /*
     * FNXC:CentralProjectIdentity 2026-07-13-22:40:
     * This is the SINGLE seam that produces the `project_id` key for the
     * `workflow_settings` / `workflow_prompt_overrides` tables (keyed by
     * (workflow_id, project_id)). Project identity ALWAYS comes from the
     * central-registry id when available; rootDir is only a filesystem root /
     * last-resort legacy key.
     *
     * Resolution order:
     *   (a) `store.asyncLayer?.projectId` — backend (PostgreSQL) mode bound to a
     *       central-registry project (e.g. "proj_2f4be0f31a404d2c"). This is the
     *       id the rest of the system partitions by, so workflow settings MUST
     *       key by it too.
     *   (b) `store.db.getProjectIdentity()?.id` — legacy SQLite identity id.
     *   (c) `store.rootDir` — absolute filesystem path, last-resort legacy key.
     *
     * BUG this fixes: the old code went straight to (b). In backend mode
     * `store.db` is a SQLite stub whose `getProjectIdentity()` THROWS
     * (throwSqliteRemoved), so the catch ALWAYS returned `store.rootDir` — an
     * absolute path like "/Users/…/kb". Meanwhile every other backend-mode read/
     * write partitions by the central-registry id, so workflow settings landed
     * under a rootDir key that nothing else could find (settings looked "reset").
     *
     * Legacy rows still keyed by rootDir / the old identity id are re-keyed by
     * migration stamping (owned elsewhere — see the PG startup/migration path).
     */
    const boundProjectId = store.asyncLayer?.projectId;
    if (boundProjectId) return boundProjectId;
    /*
    FNXC:PostgresWorkflowSettings 2026-07-17-14:20:
    An unscoped backend store (asyncLayer present but projectId empty) must NOT
    reach `store.db` below — it throws the removed-SQLite stub, which the catch
    then swallows, so the throw was invisible. Return the same rootDir key the
    swallow produced, without the spurious stub throw. Only the true legacy
    (non-backend) path consults the SQLite identity.
    */
    /* FNXC:SqliteDualPathCleanup 2026-07-26-14:15: project id for workflow settings is rootDir under PG. */
    return store.rootDir;
}

export async function listWorkflowSettingValuesForProjectImpl(store: TaskStore): Promise<Record<string, Record<string, unknown>>> {
    /*
     * FNXC:PostgresWorkflowSettings 2026-07-14-17:46:
     * Settings exports, dashboard scope responses, memory settings, and cross-node comparisons must include the project-bound PostgreSQL workflow_settings rows. The project id is resolved through the same store binding used for writes so one project's values cannot leak into another export.
     */
        const projectId = store.getWorkflowSettingsProjectId();
    const rows = await store.asyncLayer!.db
      .select({ workflowId: schema.project.workflowSettings.workflowId, values: schema.project.workflowSettings.values })
      .from(schema.project.workflowSettings)
      .where(eq(schema.project.workflowSettings.projectId, projectId));
    const out: Record<string, Record<string, unknown>> = {};
    for (const row of rows) {
      if (row.values && typeof row.values === "object" && !Array.isArray(row.values)) {
        out[row.workflowId] = row.values as Record<string, unknown>;
      }
    }
    return out;
}

export async function computeMovedSettingsTargetWorkflowIdsImpl(store: TaskStore): Promise<Set<string>> {
    const targetWorkflowIds = new Set<string>();
    /*
     * FNXC:SqliteFinalRemoval 2026-06-26:
     * P1 fix: no backendMode branch existed, so the task_workflow_selection
     * read threw in PG mode. In backend mode, read distinct workflowId via
     * Drizzle.
     */
        const layer = store.asyncLayer!;
    const rows = await layer.db
      .selectDistinct({ workflowId: schema.project.taskWorkflowSelection.workflowId })
      .from(schema.project.taskWorkflowSelection);
    for (const row of rows) {
      if (row.workflowId && row.workflowId.trim()) targetWorkflowIds.add(row.workflowId);
    }

    let defaultWorkflowId = "builtin:coding";
    try {
      const resolved = await store.getDefaultWorkflowId();
      if (resolved && resolved.trim()) {
        const exists = isBuiltinWorkflowId(resolved) || (await store.getWorkflowDefinition(resolved));
        defaultWorkflowId = exists ? resolved : "builtin:coding";
      }
    } catch {
      defaultWorkflowId = "builtin:coding";
    }
    targetWorkflowIds.add(defaultWorkflowId);
    return targetWorkflowIds;
}

export function getWorkflowSettingValuesImpl(_store: TaskStore, _workflowId: string, _projectId: string): Record<string, unknown> {
    /*
     * FNXC:SqliteFinalRemoval 2026-06-26:
     * P1 fix: no backendMode branch existed, so this threw in PG mode. In
     * backend mode, sync reads of workflow_settings are not possible. Return
     * empty (the default); the async `updateWorkflowSettingValues` path reads
     * the real values via Drizzle before merging.
     */
        return {};
}

/**
 * FNXC:WorkflowModelLanes 2026-07-14-16:26:
 * PostgreSQL-backed workflow execution must read the migrated per-project workflow values instead of the synchronous backend fallback. Model lanes, fallback lanes, thinking levels, and other workflow policy are authoritative in this row after the settings hard-move.
 */
export async function getWorkflowSettingValuesAsyncImpl(
    store: TaskStore,
    workflowId: string,
    projectId: string,
  ): Promise<Record<string, unknown>> {
    /* FNXC:SqliteDualPathCleanup 2026-07-26-14:15: always PostgreSQL path below. */
    const rows = await store.asyncLayer!.db
      .select({ values: schema.project.workflowSettings.values })
      .from(schema.project.workflowSettings)
      .where(and(
        eq(schema.project.workflowSettings.workflowId, workflowId),
        eq(schema.project.workflowSettings.projectId, projectId),
      ))
      .limit(1);
    const values = rows[0]?.values;
    return values && typeof values === "object" && !Array.isArray(values)
      ? values as Record<string, unknown>
      : {};
}

export function parseWorkflowPromptOverrideJsonImpl(store: TaskStore, raw: string | null | undefined): Record<string, string> {
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      const out: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value !== "string") continue;
        const trimmed = value.trim();
        if (trimmed.length === 0) continue;
        out[key] = value;
      }
      return out;
    } catch {
      return {};
    }
}

/** FNXC:WorkflowModelLanes 2026-07-14-16:26: Async workflow resolution must retain migrated project-scoped prompt overrides in PostgreSQL backend mode. */
export async function getWorkflowPromptOverridesAsyncImpl(
    store: TaskStore,
    workflowId: string,
    projectId: string,
  ): Promise<Record<string, string>> {
    /* FNXC:SqliteDualPathCleanup 2026-07-26-14:15: always PostgreSQL path below. */
    const rows = await store.asyncLayer!.db
      .select({ overrides: schema.project.workflowPromptOverrides.overrides })
      .from(schema.project.workflowPromptOverrides)
      .where(and(
        eq(schema.project.workflowPromptOverrides.workflowId, workflowId),
        eq(schema.project.workflowPromptOverrides.projectId, projectId),
      ))
      .limit(1);
    const overrides = rows[0]?.overrides;
    if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) return {};
    const out: Record<string, string> = {};
    for (const [nodeId, value] of Object.entries(overrides as Record<string, unknown>)) {
      if (typeof value === "string" && value.trim()) out[nodeId] = value;
    }
    return out;
}

export async function updateWorkflowPromptOverridesImpl(store: TaskStore,
    workflowId: string,
    projectId: string,
    patch: Record<string, string | null | undefined>,
  ): Promise<Record<string, string>> {
    /*
     * FNXC:WorkflowModelLanes 2026-07-14-16:26:
     * Keep PostgreSQL prompt override patches on the same authoritative transaction path as workflow settings; a backend sync-default read must never erase sibling overrides.
     */
        const layer = store.asyncLayer!;
    return layer.transactionImmediate(async (tx) => {
      const rows = await tx
        .select({ overrides: schema.project.workflowPromptOverrides.overrides })
        .from(schema.project.workflowPromptOverrides)
        .where(and(
          eq(schema.project.workflowPromptOverrides.workflowId, workflowId),
          eq(schema.project.workflowPromptOverrides.projectId, projectId),
        ))
        .limit(1);
      const rawCurrent = rows[0]?.overrides;
      const current = rawCurrent && typeof rawCurrent === "object" && !Array.isArray(rawCurrent)
        ? rawCurrent as Record<string, string>
        : {};
      const next: Record<string, string> = { ...current };
      for (const [nodeId, value] of Object.entries(patch)) {
        if (typeof value !== "string" || value.trim().length === 0) {
          delete next[nodeId];
        } else {
          next[nodeId] = value;
        }
      }

      const now = new Date().toISOString();
      await tx
        .insert(schema.project.workflowPromptOverrides)
        .values({
          workflowId,
          projectId,
          overrides: next,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [schema.project.workflowPromptOverrides.workflowId, schema.project.workflowPromptOverrides.projectId],
          set: {
            overrides: next,
            updatedAt: now,
          },
        });
      return next;
    });
}

export async function getMutationsForRunImpl(store: TaskStore, runId: string): Promise<TaskLogEntry[]> {
    /*
     * FNXC:SqliteFinalRemoval 2026-06-26:
     * In backend mode, use the async layer to read tasks instead of store.db.
     */
        const tasks = await store.listTasks();
    const mutations: TaskLogEntry[] = [];
    for (const task of tasks) {
      const logEntries = task.log || [];
      for (const entry of logEntries) {
        if (entry.runContext?.runId === runId) {
          mutations.push(entry);
        }
      }
    }
    return mutations.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

/*
FNXC:TaskVerificationRequest 2026-07-30-00:00:
The queue is intentionally one record per project/task. Creation refuses an in-flight
record and both claim/terminal writes compare request_id so executor races stay safe.
*/
function verificationScope(store: TaskStore) {
  const projectId = store.asyncLayer?.projectId;
  return projectId ? eq(schema.project.taskVerificationRequests.projectId, projectId) : undefined;
}
function verificationRowToRecord(row: typeof schema.project.taskVerificationRequests.$inferSelect): TaskVerificationRequest {
  return {
    taskId: row.taskId, requestId: row.requestId, status: row.status as TaskVerificationStatus,
    profile: row.profile as TaskVerificationRequest["profile"], command: row.command,
    scope: row.scope as TaskVerificationRequest["scope"], requestedBy: row.requestedBy,
    requestedAt: row.requestedAt, ...(row.startedAt ? { startedAt: row.startedAt } : {}),
    ...(row.completedAt ? { completedAt: row.completedAt } : {}),
    ...(row.result ? { result: row.result as TaskVerificationResultSummary } : {}),
    ...(row.rejectionReason ? { rejectionReason: row.rejectionReason } : {}),
  };
}
export async function createTaskVerificationRequestImpl(store: TaskStore, input: Omit<TaskVerificationRequest, "status" | "requestedAt"> & { requestedAt?: string }): Promise<{ request?: TaskVerificationRequest; inFlightRequestId?: string }> {
  if (!store.backendMode) throw new Error("Task verification requests require PostgreSQL persistence");
  const layer = store.asyncLayer!;
  return layer.db.transaction(async (tx) => {
    const where = verificationScope(store);
    const rows = await tx.select().from(schema.project.taskVerificationRequests).where(and(eq(schema.project.taskVerificationRequests.taskId, input.taskId), ...(where ? [where] : []))).limit(1);
    const existing = rows[0];
    if (existing && (existing.status === "requested" || existing.status === "running")) return { inFlightRequestId: existing.requestId };
    const requestedAt = input.requestedAt ?? new Date().toISOString();
    const values = { ...input, status: "requested" as const, requestedAt, startedAt: null, completedAt: null, result: null, rejectionReason: null, projectId: layer.projectId ?? "__legacy_unscoped__" };
    await tx.insert(schema.project.taskVerificationRequests).values(values).onConflictDoUpdate({ target: [schema.project.taskVerificationRequests.projectId, schema.project.taskVerificationRequests.taskId], set: values });
    return { request: verificationRowToRecord(values) };
  });
}
export async function claimTaskVerificationRequestImpl(store: TaskStore, taskId: string, requestId: string): Promise<TaskVerificationRequest | null> {
  if (!store.backendMode) return null;
  const startedAt = new Date().toISOString(); const where = verificationScope(store);
  const rows = await store.asyncLayer!.db.update(schema.project.taskVerificationRequests).set({ status: "running", startedAt }).where(and(eq(schema.project.taskVerificationRequests.taskId, taskId), eq(schema.project.taskVerificationRequests.requestId, requestId), eq(schema.project.taskVerificationRequests.status, "requested"), ...(where ? [where] : []))).returning();
  return rows[0] ? verificationRowToRecord(rows[0]) : null;
}
export async function finishTaskVerificationRequestImpl(store: TaskStore, taskId: string, requestId: string, status: Extract<TaskVerificationStatus, "passed" | "failed" | "rejected">, result?: TaskVerificationResultSummary, rejectionReason?: string): Promise<TaskVerificationRequest | null> {
  if (!store.backendMode) return null;
  const where = verificationScope(store);
  const rows = await store.asyncLayer!.db.update(schema.project.taskVerificationRequests).set({ status, completedAt: new Date().toISOString(), result: result ?? null, rejectionReason: rejectionReason ?? null }).where(and(eq(schema.project.taskVerificationRequests.taskId, taskId), eq(schema.project.taskVerificationRequests.requestId, requestId), eq(schema.project.taskVerificationRequests.status, "running"), ...(where ? [where] : []))).returning();
  return rows[0] ? verificationRowToRecord(rows[0]) : null;
}

export function normalizeMergeRequestStateImpl(store: TaskStore, value: string): MergeRequestState {
    switch (value) {
      case "queued":
      case "running":
      case "retrying":
      case "succeeded":
      case "exhausted":
      case "cancelled":
      case "manual-required":
        return value;
      default:
        return "queued";
    }
}

export function normalizeWorkflowWorkItemKindImpl(store: TaskStore, value: string): WorkflowWorkItemKind {
    switch (value) {
      case "task":
      case "merge":
      case "retry":
      case "manual-hold":
      case "recovery":
        return value;
      default:
        return "task";
    }
}

export function normalizeWorkflowWorkItemStateImpl(store: TaskStore, value: string): WorkflowWorkItemState {
    switch (value) {
      case "runnable":
      case "running":
      case "held":
      case "retrying":
      case "manual-required":
      case "succeeded":
      case "failed":
      case "cancelled":
      case "exhausted":
        return value;
      default:
        return "runnable";
    }
}

export function workflowStateForMergeRequestStateImpl(store: TaskStore, state: MergeRequestState): WorkflowWorkItemState {
    const states: Record<MergeRequestState, WorkflowWorkItemState> = {
      queued: "runnable",
      running: "running",
      retrying: "retrying",
      succeeded: "succeeded",
      exhausted: "exhausted",
      cancelled: "cancelled",
      "manual-required": "manual-required",
    };
    return states[state];
}

export async function upsertMergeRequestRecordImpl(store: TaskStore,
    taskId: string,
    input: { state: MergeRequestState; now?: string; attemptCount?: number; lastError?: string | null },
  ): Promise<MergeRequestRecord> {
    /*
     * FNXC:SqliteFinalRemoval 2026-06-26:
     * P0 fix: no backendMode branch existed, so this threw on every merge in
     * PG mode. In backend mode, upsert the merge_requests row via Drizzle
     * inside a transactionImmediate, then fire the audit event (matching the
     * sync path's audit fan-out). The audit uses the fire-and-forget async
     * helper (recordRunAuditEventAsync) for parity with other backend paths.
     */
        const layer = store.asyncLayer!;
    const now = input.now ?? new Date().toISOString();
    const attemptCount = input.attemptCount ?? 0;
    const lastError = input.lastError ?? null;
    const result = await layer.transactionImmediate(async (tx) => {
      await tx
        .insert(schema.project.mergeRequests)
        .values({
          taskId,
          state: input.state,
          createdAt: now,
          updatedAt: now,
          attemptCount,
          lastError,
        })
        .onConflictDoUpdate({
          target: [schema.project.mergeRequests.projectId, schema.project.mergeRequests.taskId],
          set: {
            state: input.state,
            updatedAt: now,
            attemptCount,
            lastError,
          },
        });
      const rows = await tx
        .select()
        .from(schema.project.mergeRequests)
        .where(eq(schema.project.mergeRequests.taskId, taskId))
        .limit(1);
      const row = rows[0] as MergeRequestRow | undefined;
      if (!row) throw new Error(`Failed to upsert merge request for ${taskId}`);
      return row;
    });
    store.insertRunAuditEventRow({
      taskId,
      domain: "database",
      mutationType: "mergeRequest:upsert",
      target: taskId,
      metadata: { taskId, state: result.state, attemptCount: result.attemptCount, lastError: result.lastError },
    });
    return store.rowToMergeRequestRecord(result);
}

export async function transitionMergeRequestStateImpl(store: TaskStore,
    taskId: string,
    toState: MergeRequestState,
    opts: { now?: string; attemptCount?: number; lastError?: string | null } = {},
  ): Promise<MergeRequestRecord> {
    /*
     * FNXC:SqliteFinalRemoval 2026-06-26:
     * P0 fix: no backendMode branch existed, so the merge state machine could
     * not advance in PG mode. In backend mode, read-validate-update the
     * merge_requests row inside a transactionImmediate and fire the audit
     * event, mirroring the sync path's transition guard + audit fan-out.
     */
        const layer = store.asyncLayer!;
    const now = opts.now ?? new Date().toISOString();
    const updated = await layer.transactionImmediate(async (tx) => {
      const existingRows = await tx
        .select()
        .from(schema.project.mergeRequests)
        .where(eq(schema.project.mergeRequests.taskId, taskId))
        .limit(1);
      const existing = existingRows[0] as MergeRequestRow | undefined;
      if (!existing) {
        throw new Error(`Merge request record not found for ${taskId}`);
      }
      const fromState = store.normalizeMergeRequestState(existing.state);
      if (!store.isValidMergeRequestTransition(fromState, toState)) {
        throw new Error(`Invalid merge request state transition for ${taskId}: ${fromState} -> ${toState}`);
      }

      await tx
        .update(schema.project.mergeRequests)
        .set({
          state: toState,
          updatedAt: now,
          attemptCount: opts.attemptCount ?? existing.attemptCount,
          lastError: opts.lastError ?? existing.lastError,
        })
        .where(eq(schema.project.mergeRequests.taskId, taskId));

      const updatedRows = await tx
        .select()
        .from(schema.project.mergeRequests)
        .where(eq(schema.project.mergeRequests.taskId, taskId))
        .limit(1);
      const row = updatedRows[0] as MergeRequestRow | undefined;
      if (!row) throw new Error(`Merge request record disappeared for ${taskId}`);
      return { row, fromState };
    });
    store.insertRunAuditEventRow({
      taskId,
      domain: "database",
      mutationType: "mergeRequest:transition",
      target: taskId,
      metadata: { taskId, fromState: updated.fromState, toState, attemptCount: updated.row.attemptCount, lastError: updated.row.lastError },
    });
    return store.rowToMergeRequestRecord(updated.row);
}

export function insertCompletionHandoffWorkflowWorkAuditImpl(store: TaskStore,
    task: Pick<Task, "id">,
    item: WorkflowWorkItem,
    autoMerge: boolean,
    source?: string,
  ): void {
    store.insertRunAuditEventRow({
      taskId: task.id,
      runId: item.runId,
      domain: "database",
      mutationType: "workflowWorkItem:completion-handoff",
      target: item.id,
      metadata: {
        taskId: task.id,
        autoMerge,
        source: source ?? "completion-handoff",
        workItemId: item.id,
        nodeId: item.nodeId,
        state: item.state,
      },
    });
}

export function transitionWorkflowWorkItemSyncImpl(store: TaskStore,
    id: string,
    state: WorkflowWorkItemState,
    patch: WorkflowWorkItemTransitionPatch = {},
  ): WorkflowWorkItem {
    return store.db.transactionImmediate(() => {
      const now = patch.now ?? new Date().toISOString();
      const existing = store.db.prepare("SELECT * FROM workflow_work_items WHERE id = ?").get(id) as WorkflowWorkItemRow | undefined;
      if (!existing) throw new Error(`Workflow work item ${id} not found`);
      const fromState = store.normalizeWorkflowWorkItemState(existing.state);
      if (store.isTerminalWorkflowWorkItemState(fromState) && fromState !== state) {
        throw new Error(`Workflow work item ${id} is terminal (${fromState}) and cannot transition to ${state}`);
      }

      store.db
        .prepare(
          `UPDATE workflow_work_items
              SET state = ?,
                  attempt = ?,
                  retryAfter = ?,
                  leaseOwner = ?,
                  leaseExpiresAt = ?,
                  lastError = ?,
                  blockedReason = ?,
                  updatedAt = ?
            WHERE id = ?`,
        )
        .run(
          state,
          patch.attempt ?? existing.attempt,
          patch.retryAfter === undefined ? existing.retryAfter : patch.retryAfter,
          patch.leaseOwner === undefined ? existing.leaseOwner : patch.leaseOwner,
          patch.leaseExpiresAt === undefined ? existing.leaseExpiresAt : patch.leaseExpiresAt,
          patch.lastError === undefined ? existing.lastError : patch.lastError,
          patch.blockedReason === undefined ? existing.blockedReason : patch.blockedReason,
          now,
          id,
        );

      const updated = store.db.prepare("SELECT * FROM workflow_work_items WHERE id = ?").get(id) as WorkflowWorkItemRow | undefined;
      if (!updated) throw new Error(`Workflow work item ${id} disappeared`);
      store.insertRunAuditEventRow({
        taskId: updated.taskId,
        runId: updated.runId,
        domain: "database",
        mutationType: "workflowWorkItem:transition",
        target: updated.id,
        metadata: { id: updated.id, fromState, toState: state, attempt: updated.attempt },
      });
      return store.rowToWorkflowWorkItem(updated);
    });
}

export async function getWorkflowWorkItemImpl(store: TaskStore, id: string): Promise<WorkflowWorkItem | null> {
        const layer = store.asyncLayer!;
    return getWorkflowWorkItemAsync(layer.db, id);
}

export type ToolFailureRetryClaim =
  | { outcome: "claimed"; attempt: number }
  | { outcome: "already-claimed-for-run" }
  | { outcome: "exhausted" };

/**
 * FNXC:ExecutorToolFailureRetry 2026-07-16-12:00:
 * PostgreSQL owns the durable per-run claim. The cursor predicate is deliberately
 * evaluated before the cap after a miss: an older handler must never park a newer run.
 */
export async function claimNextToolFailureRetryImpl(
  store: TaskStore,
  taskId: string,
  expectedCursor: number,
  maxRetries: number,
): Promise<ToolFailureRetryClaim> {
  /*
   * FNXC:ExecutorToolFailureRetry 2026-07-16-13:30:
   * PostgreSQL is the only runtime TaskStore backend. Keep compatibility-mode
   * stores on the legacy terminal-park path instead of throwing from a
   * default-enabled retry policy: they have no durable atomic claim primitive.
   */
  if (!store.backendMode) return { outcome: "exhausted" };
  const layer = store.asyncLayer!;
  const projectId = layer.projectId?.trim() || "__legacy_unscoped__";
  const rows = await layer.db.update(schema.project.tasks).set({
    consecutiveToolFailureRetryCount: sql`coalesce(${schema.project.tasks.consecutiveToolFailureRetryCount}, 0) + 1`,
    toolFailureDetectorLogCursor: null,
    updatedAt: new Date().toISOString(),
  }).where(and(
    eq(schema.project.tasks.projectId, projectId),
    eq(schema.project.tasks.id, taskId),
    eq(schema.project.tasks.toolFailureDetectorLogCursor, expectedCursor),
    sql`coalesce(${schema.project.tasks.consecutiveToolFailureRetryCount}, 0) < ${maxRetries}`,
  )).returning({ attempt: schema.project.tasks.consecutiveToolFailureRetryCount });
  if (rows.length > 0) return { outcome: "claimed", attempt: rows[0]!.attempt ?? 1 };
  const [current] = await layer.db.select({
    cursor: schema.project.tasks.toolFailureDetectorLogCursor,
    count: schema.project.tasks.consecutiveToolFailureRetryCount,
  }).from(schema.project.tasks).where(and(eq(schema.project.tasks.projectId, projectId), eq(schema.project.tasks.id, taskId)));
  // Cursor mismatch MUST win before cap: stale handlers silently defer to the newer run.
  if (!current || current.cursor !== expectedCursor) return { outcome: "already-claimed-for-run" };
  if ((current.count ?? 0) >= maxRetries) return { outcome: "exhausted" };
  return { outcome: "already-claimed-for-run" };
}

/** CAS for the single exhaustion audit; terminal parking intentionally remains idempotent. */
export async function markToolFailureRetryExhaustedAuditImpl(store: TaskStore, taskId: string): Promise<boolean> {
  // FNXC:ExecutorToolFailureRetry 2026-07-16-13:30: non-PostgreSQL compatibility stores safely skip the deduplicated audit and retain legacy terminal parking.
  if (!store.backendMode) return false;
  const layer = store.asyncLayer!;
  const projectId = layer.projectId?.trim() || "__legacy_unscoped__";
  const rows = await layer.db.update(schema.project.tasks).set({
    toolFailureRetryExhaustedAuditEmitted: 1,
    updatedAt: new Date().toISOString(),
  }).where(and(
    eq(schema.project.tasks.projectId, projectId),
    eq(schema.project.tasks.id, taskId),
    sql`(${schema.project.tasks.toolFailureRetryExhaustedAuditEmitted} is null or ${schema.project.tasks.toolFailureRetryExhaustedAuditEmitted} = 0)`,
  )).returning({ id: schema.project.tasks.id });
  return rows.length > 0;
}
