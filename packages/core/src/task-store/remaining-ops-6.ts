/**
 * remaining-ops-6 operations.
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
import { fromJson } from "../db.js";
import * as schema from "../postgres/schema/index.js";
import { ensureBranchGroupForSource as ensureBranchGroupForSourceAsync, ensurePrEntityForSource as ensurePrEntityForSourceAsync, getActivePrEntityBySource as getActivePrEntityBySourceAsync, getBranchGroup as getBranchGroupAsync, getBranchGroupByBranchName as getBranchGroupByBranchNameAsync, getBranchGroupBySource as getBranchGroupBySourceAsync, getPrEntity as getPrEntityAsync, getPrThreadState as getPrThreadStateAsync, listActivePrEntities as listActivePrEntitiesAsync, listBranchGroups as listBranchGroupsAsync, listPrThreadStates as listPrThreadStatesAsync, recordPrThreadOutcome as recordPrThreadOutcomeAsync } from "./async-branch-groups.js";
import { getWorkflowWorkItem as getWorkflowWorkItemAsync } from "./async-workflow-workitems.js";
import { type TaskRow } from "./persistence.js";
import { BranchGroupRow, MergeRequestRow, PrEntityRow, PrThreadStateRow, WorkflowWorkItemRow } from "./row-types.js";
import { BranchGroup, BranchGroupCreateInput, ColumnId, MergeRequestRecord, MergeRequestState, PrEntity, PrEntityCreateInput, PrThreadOutcome, PrThreadState, RunMutationContext, Task, TaskLogEntry, TaskPriority, WorkflowWorkItem, WorkflowWorkItemKind, WorkflowWorkItemState, WorkflowWorkItemTransitionPatch } from "../types.js";
import { validateNodeOverrideChange } from "../node-override-guard.js";
import { WorkflowMovePolicyInput } from "../workflow-extension-types.js";
import { resolveWorkflowIrById } from "../workflow-ir-resolver.js";
import { WorkflowSettingDefinition } from "../workflow-ir-types.js";
import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MoveTaskInternalOptions, MoveTaskOptions, storeLog } from "../store.js";

export async function getBranchGroupImpl(store: TaskStore, id: string): Promise<BranchGroup | null> {
    // FNXC:RuntimeWorkflowAsync 2026-06-24-16:21:
    if (store.backendMode) {
      const layer = store.asyncLayer!;
      return getBranchGroupAsync(layer.db, id);
    }
    const row = store.db.prepare(`SELECT * FROM branch_groups WHERE id = ?`).get(id) as BranchGroupRow | undefined;
    return row ? store.rowToBranchGroup(row) : null;
}

export async function getBranchGroupBySourceImpl(store: TaskStore, sourceType: BranchGroup["sourceType"], sourceId: string): Promise<BranchGroup | null> {
    if (store.backendMode) {
      const layer = store.asyncLayer!;
      return getBranchGroupBySourceAsync(layer.db, sourceType, sourceId);
    }
    const row = store.db.prepare(`SELECT * FROM branch_groups WHERE sourceType = ? AND sourceId = ?`).get(sourceType, sourceId) as BranchGroupRow | undefined;
    return row ? store.rowToBranchGroup(row) : null;
}

export async function getBranchGroupByBranchNameImpl(store: TaskStore, branchName: string): Promise<BranchGroup | null> {
    if (store.backendMode) {
      const layer = store.asyncLayer!;
      return getBranchGroupByBranchNameAsync(layer.db, branchName);
    }
    const row = store.db.prepare(`SELECT * FROM branch_groups WHERE branchName = ? AND status = 'open' ORDER BY createdAt DESC LIMIT 1`).get(branchName) as BranchGroupRow | undefined;
    return row ? store.rowToBranchGroup(row) : null;
}

export async function ensureBranchGroupForSourceImpl(store: TaskStore,
    sourceType: BranchGroup["sourceType"],
    sourceId: string,
    init: Omit<BranchGroupCreateInput, "sourceType" | "sourceId">,
  ): Promise<BranchGroup> {
    if (store.backendMode) {
      const layer = store.asyncLayer!;
      return ensureBranchGroupForSourceAsync(layer.db, sourceType, sourceId, init);
    }
    const existing = await store.getBranchGroupBySource(sourceType, sourceId);
    if (existing) {
      return existing;
    }

    // `branch_groups.branchName` is globally UNIQUE — a branch is represented by
    // exactly one open group. If another source already owns an open group for
    // store branch, reuse it rather than calling createBranchGroup and violating
    // the UNIQUE constraint. Without store, two missions whose shared base resolves
    // to the same branch (e.g. "main") collide: the throw escapes triageFeature
    // and is swallowed by its callers, silently stranding "defined" features.
    const existingByBranch = await store.getBranchGroupByBranchName(init.branchName);
    if (existingByBranch) {
      return existingByBranch;
    }

    return store.createBranchGroup({
      sourceType,
      sourceId,
      ...init,
    });
}

export async function listBranchGroupsImpl(store: TaskStore, options?: { status?: BranchGroup["status"] }): Promise<BranchGroup[]> {
    if (store.backendMode) {
      const layer = store.asyncLayer!;
      return listBranchGroupsAsync(layer.db, options);
    }
    const rows = options?.status
      ? store.db.prepare(`SELECT * FROM branch_groups WHERE status = ? ORDER BY createdAt ASC`).all(options.status)
      : store.db.prepare(`SELECT * FROM branch_groups ORDER BY createdAt ASC`).all();
    return (rows as BranchGroupRow[]).map((row) => store.rowToBranchGroup(row));
}

export async function listTasksByBranchGroupImpl(store: TaskStore, groupId: string): Promise<Task[]> {
    const tasks = await store.listTasks({ includeArchived: false, slim: true });
    // Membership filter (incl. legacy synthetic-groupId fallback) is shared with
    // the dashboard list route via `filterTasksByBranchGroup` so semantics can't
    // drift between the two call sites (Fix #8/#9).
    const group = await store.getBranchGroup(groupId);
    return filterTasksByBranchGroup(tasks, group, groupId).sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );
}

export async function getPrEntityImpl(store: TaskStore, id: string): Promise<PrEntity | null> {
    if (store.backendMode) {
      const layer = store.asyncLayer!;
      return getPrEntityAsync(layer.db, id);
    }
    const row = store.db.prepare(`SELECT * FROM pull_requests WHERE id = ?`).get(id) as PrEntityRow | undefined;
    return row ? store.rowToPrEntity(row) : null;
}

export async function getActivePrEntityBySourceImpl(store: TaskStore, sourceType: PrEntity["sourceType"], sourceId: string): Promise<PrEntity | null> {
    if (store.backendMode) {
      const layer = store.asyncLayer!;
      return getActivePrEntityBySourceAsync(layer.db, sourceType, sourceId);
    }
    const row = store.db
      .prepare(
        `SELECT * FROM pull_requests
         WHERE sourceType = ? AND sourceId = ? AND state NOT IN ('merged','closed','failed')
         ORDER BY createdAt DESC LIMIT 1`,
      )
      .get(sourceType, sourceId) as PrEntityRow | undefined;
    return row ? store.rowToPrEntity(row) : null;
}

export async function getPrEntityByNumberImpl(store: TaskStore, repo: string, prNumber: number): Promise<PrEntity | null> {
    // No dedicated async helper for by-number lookup; use the sync path's SQL
    // shape via a raw Drizzle query in backend mode.
    if (store.backendMode) {
      const layer = store.asyncLayer!;
      const rows = await layer.db
        .select()
        .from(schema.project.pullRequests)
        .where(and(eq(schema.project.pullRequests.repo, repo), eq(schema.project.pullRequests.prNumber, prNumber)))
        .limit(1);
      const row = rows[0] as PrEntityRow | undefined;
      return row ? store.rowToPrEntity(row) : null;
    }
    const row = store.db
      .prepare(`SELECT * FROM pull_requests WHERE repo = ? AND prNumber = ?`)
      .get(repo, prNumber) as PrEntityRow | undefined;
    return row ? store.rowToPrEntity(row) : null;
}

export async function ensurePrEntityForSourceImpl(store: TaskStore, input: PrEntityCreateInput): Promise<PrEntity> {
    if (store.backendMode) {
      const layer = store.asyncLayer!;
      return ensurePrEntityForSourceAsync(layer.db, input);
    }
    const existing = await store.getActivePrEntityBySource(input.sourceType, input.sourceId);
    if (existing) return existing;
    const id = store.generatePrEntityId();
    const now = Date.now();
    store.db
      .prepare(
        `INSERT INTO pull_requests
           (id, sourceType, sourceId, repo, headBranch, baseBranch, state,
            prNumber, prUrl, autoMerge, unverified, responseRounds, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      )
      .run(
        id,
        input.sourceType,
        input.sourceId,
        input.repo,
        input.headBranch,
        input.baseBranch ?? null,
        input.state ?? "creating",
        input.prNumber ?? null,
        input.prUrl ?? null,
        input.autoMerge ? 1 : 0,
        input.unverified ? 1 : 0,
        now,
        now,
      );
    store.db.bumpLastModified();
    const created = await store.getPrEntity(id);
    return created!;
}

export async function listActivePrEntitiesImpl(store: TaskStore): Promise<PrEntity[]> {
    if (store.backendMode) {
      const layer = store.asyncLayer!;
      return listActivePrEntitiesAsync(layer.db);
    }
    const rows = store.db
      .prepare(`SELECT * FROM pull_requests WHERE state NOT IN ('merged','closed','failed') ORDER BY createdAt ASC`)
      .all() as PrEntityRow[];
    return rows.map((r) => store.rowToPrEntity(r));
}

export async function getPrThreadStateImpl(store: TaskStore, prEntityId: string, threadId: string, headOid: string): Promise<PrThreadState | null> {
    if (store.backendMode) {
      const layer = store.asyncLayer!;
      return getPrThreadStateAsync(layer.db, prEntityId, threadId, headOid);
    }
    const row = store.db
      .prepare(`SELECT * FROM pull_request_thread_state WHERE prEntityId = ? AND threadId = ? AND headOid = ?`)
      .get(prEntityId, threadId, headOid) as PrThreadStateRow | undefined;
    return row
      ? {
          prEntityId: row.prEntityId,
          threadId: row.threadId,
          headOid: row.headOid,
          outcome: row.outcome,
          fixCommitSha: row.fixCommitSha ?? undefined,
          updatedAt: row.updatedAt,
        }
      : null;
}

export async function listPrThreadStatesImpl(store: TaskStore, prEntityId: string): Promise<PrThreadState[]> {
    if (store.backendMode) {
      const layer = store.asyncLayer!;
      return listPrThreadStatesAsync(layer.db, prEntityId);
    }
    const rows = store.db
      .prepare(`SELECT * FROM pull_request_thread_state WHERE prEntityId = ?`)
      .all(prEntityId) as PrThreadStateRow[];
    return rows.map((row) => ({
      prEntityId: row.prEntityId,
      threadId: row.threadId,
      headOid: row.headOid,
      outcome: row.outcome,
      fixCommitSha: row.fixCommitSha ?? undefined,
      updatedAt: row.updatedAt,
    }));
}

export async function recordPrThreadOutcomeImpl(store: TaskStore,
    prEntityId: string,
    threadId: string,
    headOid: string,
    outcome: PrThreadOutcome,
    fixCommitSha?: string,
  ): Promise<void> {
    if (store.backendMode) {
      const layer = store.asyncLayer!;
      return recordPrThreadOutcomeAsync(layer.db, prEntityId, threadId, headOid, outcome, fixCommitSha);
    }
    store.db
      .prepare(
        `INSERT INTO pull_request_thread_state (prEntityId, threadId, headOid, outcome, fixCommitSha, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (prEntityId, threadId, headOid)
         DO UPDATE SET outcome = excluded.outcome, fixCommitSha = excluded.fixCommitSha, updatedAt = excluded.updatedAt`,
      )
      .run(prEntityId, threadId, headOid, outcome, fixCommitSha ?? null, Date.now());
    store.db.bumpLastModified();
}

export function getBranchProgressByTaskImpl(store: TaskStore,
    taskIds: readonly string[],
  ): Map<string, Array<{ branchId: string; nodeId: string; status: string }>> {
    const result = new Map<string, Array<{ branchId: string; nodeId: string; status: string }>>();
    if (taskIds.length === 0) return result;
    try {
      // Skip entirely when the table has no rows (cheap existence probe).
      const any = store.db
        .prepare("SELECT 1 FROM workflow_run_branches LIMIT 1")
        .get();
      if (!any) return result;

      const placeholders = taskIds.map(() => "?").join(", ");
      // Filter to the latest run per task entirely in SQL (#1413): the
      // correlated subquery resolves the winning (updatedAt, runId) pair per
      // task — MAX(updatedAt) with a deterministic MAX(runId) tie-break — and
      // the JOIN matches both columns so only the latest run's rows are read.
      // The runId tie-break makes ties on updatedAt deterministic instead of
      // letting an arbitrary historical run win.
      const rows = store.db
        .prepare(
          `SELECT b.taskId AS taskId, b.runId AS runId, b.branchId AS branchId,
                  b.currentNodeId AS nodeId, b.status AS status, b.updatedAt AS updatedAt
             FROM workflow_run_branches b
             JOIN (
               -- Resolve the winning run per task: the run owning the row with
               -- the greatest updatedAt, with runId as a deterministic
               -- tie-break when two runs share an updatedAt. Returns the whole
               -- run's rows (all its branches), not just the single max row.
               SELECT taskId, runId AS latestRunId
                 FROM (
                   SELECT taskId, runId,
                          ROW_NUMBER() OVER (
                            PARTITION BY taskId
                            ORDER BY MAX(updatedAt) DESC, runId DESC
                          ) AS rn
                     FROM workflow_run_branches
                    WHERE taskId IN (${placeholders})
                    GROUP BY taskId, runId
                 )
                WHERE rn = 1
             ) latest_run
               ON latest_run.taskId = b.taskId
              AND latest_run.latestRunId = b.runId
            WHERE b.taskId IN (${placeholders})`,
        )
        .all(...taskIds, ...taskIds) as Array<{
          taskId: string;
          runId: string;
          branchId: string;
          nodeId: string;
          status: string;
          updatedAt: string;
        }>;

      for (const row of rows) {
        const list = result.get(row.taskId) ?? [];
        list.push({ branchId: row.branchId, nodeId: row.nodeId, status: row.status });
        result.set(row.taskId, list);
      }
    } catch {
      // Legacy/missing table or query failure — degrade to no branch progress.
      return new Map();
    }
    return result;
}

export function loadWorkflowRunBranchesImpl(store: TaskStore,
    taskId: string,
    runId: string,
  ): Array<{
    taskId: string;
    runId: string;
    branchId: string;
    currentNodeId: string;
    status: "running" | "completed" | "failed" | "aborted";
  }> {
    try {
      const rows = store.db
        .prepare(
          `SELECT taskId, runId, branchId, currentNodeId, status
             FROM workflow_run_branches
            WHERE taskId = ? AND runId = ?`,
        )
        .all(taskId, runId) as Array<{
          taskId: string;
          runId: string;
          branchId: string;
          currentNodeId: string;
          status: "running" | "completed" | "failed" | "aborted";
        }>;
      return rows;
    } catch {
      return [];
    }
}

export function saveWorkflowRunStepInstanceImpl(store: TaskStore,
    state: import("../types.js").WorkflowRunStepInstance,
  ): void {
    try {
      store.db
        .prepare(
          `INSERT INTO workflow_run_step_instances
             (taskId, runId, foreachNodeId, stepIndex, pinnedStepCount, currentNodeId, status, baselineSha, checkpointId, reworkCount, branchName, integratedAt, updatedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(taskId, runId, foreachNodeId, stepIndex) DO UPDATE SET
             pinnedStepCount = excluded.pinnedStepCount,
             currentNodeId = excluded.currentNodeId,
             status = excluded.status,
             baselineSha = excluded.baselineSha,
             checkpointId = excluded.checkpointId,
             reworkCount = excluded.reworkCount,
             branchName = excluded.branchName,
             integratedAt = excluded.integratedAt,
             updatedAt = excluded.updatedAt`,
        )
        .run(
          state.taskId,
          state.runId,
          state.foreachNodeId,
          state.stepIndex,
          state.pinnedStepCount,
          state.currentNodeId ?? null,
          state.status,
          state.baselineSha ?? null,
          state.checkpointId ?? null,
          state.reworkCount ?? 0,
          state.branchName ?? null,
          state.integratedAt ?? null,
          new Date().toISOString(),
        );
    } catch {
      // Legacy/missing table — persistence is additive, so degrade silently.
    }
}

export function loadWorkflowRunStepInstancesImpl(store: TaskStore,
    taskId: string,
    runId: string,
  ): import("../types.js").WorkflowRunStepInstance[] {
    try {
      const rows = store.db
        .prepare(
          `SELECT taskId, runId, foreachNodeId, stepIndex, pinnedStepCount, currentNodeId, status, baselineSha, checkpointId, reworkCount, branchName, integratedAt, updatedAt
             FROM workflow_run_step_instances
            WHERE taskId = ? AND runId = ?
            ORDER BY stepIndex ASC`,
        )
        .all(taskId, runId) as import("../types.js").WorkflowRunStepInstance[];
      return rows;
    } catch {
      return [];
    }
}

export function clearWorkflowRunStepInstancesImpl(store: TaskStore, taskId: string, keepRunId?: string): void {
    try {
      if (keepRunId === undefined) {
        store.db
          .prepare(`DELETE FROM workflow_run_step_instances WHERE taskId = ?`)
          .run(taskId);
      } else {
        store.db
          .prepare(
            `DELETE FROM workflow_run_step_instances WHERE taskId = ? AND runId != ?`,
          )
          .run(taskId, keepRunId);
      }
    } catch {
      // Legacy/missing table — pruning is additive, so degrade silently.
    }
}

export async function getActiveMergingTaskImpl(store: TaskStore, excludeTaskId?: string): Promise<string | undefined> {
    /*
     * FNXC:SqliteFinalRemoval 2026-06-26:
     * P0 fix: this method had no backendMode branch and threw on every merge in
     * PG mode (store.db getter throws). In backend mode, query the tasks table
     * via Drizzle, filtering on the same live + merging-status predicate the
     * SQLite path used (TaskStore.ACTIVE_TASKS_WHERE ≡ deletedAt IS NULL).
     */
    if (store.backendMode) {
      const layer = store.asyncLayer!;
      const conditions = [
        isNull(schema.project.tasks.deletedAt),
        inArray(schema.project.tasks.status, ["merging", "merging-pr"]),
      ];
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
    const sql = excludeTaskId
      ? `SELECT id FROM tasks WHERE ${TaskStore.ACTIVE_TASKS_WHERE} AND status IN ('merging', 'merging-pr') AND id != ? LIMIT 1`
      : `SELECT id FROM tasks WHERE ${TaskStore.ACTIVE_TASKS_WHERE} AND status IN ('merging', 'merging-pr') LIMIT 1`;
    const params = excludeTaskId ? [excludeTaskId] : [];
    const row = store.db.prepare(sql).get(...params) as { id: string } | undefined;
    return row?.id;
}

export async function findRecentTasksByContentFingerprintImpl(store: TaskStore,
    fingerprint: string,
    options?: { windowMs?: number; includeArchived?: boolean },
  ): Promise<Task[]> {
    const trimmedFingerprint = fingerprint.trim();
    if (trimmedFingerprint.length === 0) {
      return [];
    }

    const requestedWindowMs = options?.windowMs ?? 60_000;
    const windowMs = Math.max(1, Math.min(300_000, Math.trunc(requestedWindowMs)));
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
    if (store.backendMode) {
      const layer = store.asyncLayer!;
      const conditions = [
        isNull(schema.project.tasks.deletedAt),
        sql`${schema.project.tasks.sourceMetadata}->>'contentFingerprint' = ${trimmedFingerprint}`,
        sql`${schema.project.tasks.createdAt} >= ${cutoffIso}`,
      ];
      if (!includeArchived) {
        conditions.push(ne(schema.project.tasks.column, "archived"));
      }
      const rows = await layer.db
        .select()
        .from(schema.project.tasks)
        .where(and(...conditions))
        .orderBy(schema.project.tasks.createdAt);
      return rows.map((row) => store.rowToTask(store.pgRowToTaskRow(row as unknown as Record<string, unknown>)));
    }

    const selectClause = store.getTaskSelectClause(false, "t");

    const rows = store.db.prepare(`
      SELECT ${selectClause}
      FROM tasks t
      WHERE t."deletedAt" IS NULL
        AND json_extract(t.sourceMetadata, '$.contentFingerprint') = ?
        AND t.createdAt >= ?
        ${includeArchived ? "" : "AND t.\"column\" != 'archived'"}
      ORDER BY t.createdAt ASC
    `).all(trimmedFingerprint, cutoffIso) as TaskRow[];

    return rows.map((row) => store.rowToTask(row));
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
    if (store.backendMode) {
      const allTasks = await store.listTasks();
      return allTasks.filter((task) => {
        if (task.assignedAgentId !== agentId) return false;
        if (options?.pausedOnly && !task.paused) return false;
        if (options?.excludeArchived && task.column === "archived") return false;
        return true;
      });
    }

    const whereClauses = ["assignedAgentId = ?", TaskStore.ACTIVE_TASKS_WHERE];
    const params: Array<string | number> = [agentId];

    if (options?.pausedOnly) {
      whereClauses.push("paused = 1");
    }

    if (options?.excludeArchived) {
      whereClauses.push('"column" != \'archived\'');
    }

    const selectClause = store.getTaskSelectClause(false);
    const rows = store.db.prepare(`
      SELECT ${selectClause} FROM tasks
      WHERE ${whereClauses.join(" AND ")}
      ORDER BY createdAt ASC
    `).all(...params) as TaskRow[];

    return rows.map((row) => store.rowToTask(row));
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
    updates: { title?: string; description?: string; priority?: TaskPriority | null; prompt?: string; worktree?: string | null; workspaceWorktrees?: import("../types.js").Task["workspaceWorktrees"]; status?: string | null; dependencies?: string[]; steps?: import("../types.js").TaskStep[]; customFields?: Record<string, unknown>; currentStep?: number; blockedBy?: string | null; overlapBlockedBy?: string | null; assignedAgentId?: string | null; pausedByAgentId?: string | null; pausedReason?: string | null; tokenBudgetSoftAlertedAt?: string | null; worktrunkFallbackAlertedAt?: string | null; worktrunkFailure?: import("../types.js").Task["worktrunkFailure"] | null; tokenBudgetHardAlertedAt?: string | null; tokenBudgetOverride?: import("../types.js").TaskTokenBudgetOverride | null; dispatchStormCount?: number | null; lastDispatchAt?: string | null; assigneeUserId?: string | null; scopeOverride?: boolean | null; scopeOverrideReason?: string | null; scopeAutoWiden?: string[] | null; nodeId?: string | null; effectiveNodeId?: string | null; effectiveNodeSource?: string | null; checkedOutBy?: string | null; checkedOutAt?: string | null; checkoutNodeId?: string | null; checkoutRunId?: string | null; checkoutLeaseRenewedAt?: string | null; checkoutLeaseEpoch?: number | null; paused?: boolean; baseBranch?: string | null; autoMerge?: boolean | null; branch?: string | null; executionStartBranch?: string | null; baseCommitSha?: string | null; size?: "S" | "M" | "L"; reviewLevel?: number; executionMode?: import("../types.js").ExecutionMode | null; mergeRetries?: number; workflowStepRetries?: number; stuckKillCount?: number | null; resumeLimboCount?: number | null; executeRequeueLoopCount?: number | null; graphResumeRetryCount?: number | null; resumeLimboTipSha?: string | null; resumeLimboStepSignature?: string | null; executeRequeueLoopSignature?: string | null; postReviewFixCount?: number | null; planReviewReplanCount?: number | null; recoveryRetryCount?: number | null; taskDoneRetryCount?: number | null; worktreeSessionRetryCount?: number | null; completionHandoffLimboRecoveryCount?: number | null; verificationFailureCount?: number | null; mergeConflictBounceCount?: number | null; mergeAuditBounceCount?: number | null; mergeTransientRetryCount?: number | null; branchConflictRecoveryCount?: number | null; reviewerContextRetryCount?: number | null; reviewerFallbackRetryCount?: number | null; nextRecoveryAt?: string | null; enabledWorkflowSteps?: string[]; noCommitsExpected?: boolean | null; modelProvider?: string | null; modelId?: string | null; validatorModelProvider?: string | null; validatorModelId?: string | null; planningModelProvider?: string | null; planningModelId?: string | null; thinkingLevel?: string | null; validatorThinkingLevel?: string | null; planningThinkingLevel?: string | null; error?: string | null; summary?: string | null; sessionFile?: string | null; firstExecutionAt?: string | null; cumulativeActiveMs?: number | null; executionStartedAt?: string | null; executionCompletedAt?: string | null; review?: import("../types.js").TaskReview | null; reviewState?: import("../types.js").TaskReviewState | null; workflowStepResults?: import("../types.js").WorkflowStepResult[] | null; mergeDetails?: import("../types.js").MergeDetails | null; sourceIssue?: import("../types.js").TaskSourceIssue | null; sourceMetadataPatch?: Record<string, unknown> | null; githubTracking?: import("../types.js").TaskGithubTracking | null; tokenUsage?: import("../types.js").TaskTokenUsage | null; modifiedFiles?: string[] | null; missionId?: string | null; sliceId?: string | null; workflowTransitionNotification?: import("../types.js").WorkflowTransitionNotificationMarker | undefined },
    runContext?: RunMutationContext,
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
    try {
      return store.db.getProjectIdentity()?.id ?? store.rootDir;
    } catch {
      return store.rootDir;
    }
}

export function listWorkflowSettingValuesForProjectImpl(store: TaskStore): Record<string, Record<string, unknown>> {
    /*
     * FNXC:SqliteFinalRemoval 2026-06-26:
     * P1 fix: no backendMode branch existed, so this threw in PG mode. In
     * backend mode, sync reads of workflow_settings are not possible (the
     * async layer is the authoritative reader). Return empty (the default)
     * so sync callers (e.g. settings export snapshots composing a sync view)
     * do not throw; async callers use the async listWorkflowSettingValues
     * path. The async `getSettingsByScope`-composed dashboard routes read
     * workflow settings through the async helpers, not this sync method.
     */
    if (store.backendMode) {
      return {};
    }
    const projectId = store.getWorkflowSettingsProjectId();
    const rows = store.db
      .prepare('SELECT workflowId, "values" FROM workflow_settings WHERE projectId = ?')
      .all(projectId) as Array<{ workflowId: string; values: string }>;
    const out: Record<string, Record<string, unknown>> = {};
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.values) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          out[row.workflowId] = parsed as Record<string, unknown>;
        }
      } catch {
        // Skip corrupt row.
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
    if (store.backendMode) {
      const layer = store.asyncLayer!;
      const rows = await layer.db
        .selectDistinct({ workflowId: schema.project.taskWorkflowSelection.workflowId })
        .from(schema.project.taskWorkflowSelection);
      for (const row of rows) {
        if (row.workflowId && row.workflowId.trim()) targetWorkflowIds.add(row.workflowId);
      }
    } else {
      try {
        const rows = store.db
          .prepare("SELECT DISTINCT workflowId FROM task_workflow_selection WHERE workflowId IS NOT NULL AND workflowId != ''")
          .all() as Array<{ workflowId: string }>;
        for (const row of rows) {
          if (row.workflowId && row.workflowId.trim()) targetWorkflowIds.add(row.workflowId);
        }
      } catch {
        // No selections / table issue — fall through to the default below.
      }
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

export function getWorkflowSettingValuesImpl(store: TaskStore, workflowId: string, projectId: string): Record<string, unknown> {
    /*
     * FNXC:SqliteFinalRemoval 2026-06-26:
     * P1 fix: no backendMode branch existed, so this threw in PG mode. In
     * backend mode, sync reads of workflow_settings are not possible. Return
     * empty (the default); the async `updateWorkflowSettingValues` path reads
     * the real values via Drizzle before merging.
     */
    if (store.backendMode) {
      return {};
    }
    const row = store.db
      .prepare('SELECT "values" FROM workflow_settings WHERE workflowId = ? AND projectId = ?')
      .get(workflowId, projectId) as { values: string } | undefined;
    if (!row) return {};
    try {
      const parsed = JSON.parse(row.values) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
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

export async function updateWorkflowPromptOverridesImpl(store: TaskStore,
    workflowId: string,
    projectId: string,
    patch: Record<string, string | null | undefined>,
  ): Promise<Record<string, string>> {
    /*
     * FNXC:SqliteFinalRemoval 2026-06-26:
     * P1 fix: no backendMode branch existed, so this threw in PG mode. In
     * backend mode, read-merge-upsert the workflow_prompt_overrides row via
     * Drizzle inside a transactionImmediate (preserving the lost-update guard
     * the sync path's transactionImmediate provides). overrides is jsonb.
     */
    if (store.backendMode) {
      const layer = store.asyncLayer!;
      return layer.transactionImmediate(async () => {
        const current = await store.getWorkflowPromptOverrides(workflowId, projectId);
        const next: Record<string, string> = { ...current };
        for (const [nodeId, value] of Object.entries(patch)) {
          if (typeof value !== "string" || value.trim().length === 0) {
            delete next[nodeId];
          } else {
            next[nodeId] = value;
          }
        }

        const now = new Date().toISOString();
        await layer.db
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
    return store.db.transactionImmediate(() => {
      const current = store.getWorkflowPromptOverrides(workflowId, projectId);
      const next: Record<string, string> = { ...current };
      for (const [nodeId, value] of Object.entries(patch)) {
        if (typeof value !== "string" || value.trim().length === 0) {
          delete next[nodeId];
        } else {
          next[nodeId] = value;
        }
      }

      const now = new Date().toISOString();
      store.db
        .prepare(
          `INSERT INTO workflow_prompt_overrides (workflowId, projectId, overrides, updatedAt)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(workflowId, projectId)
           DO UPDATE SET overrides = excluded.overrides, updatedAt = excluded.updatedAt`,
        )
        .run(workflowId, projectId, JSON.stringify(next), now);
      store.db.bumpLastModified();
      return next;
    });
}

export async function getMutationsForRunImpl(store: TaskStore, runId: string): Promise<TaskLogEntry[]> {
    /*
     * FNXC:SqliteFinalRemoval 2026-06-26:
     * In backend mode, use the async layer to read tasks instead of store.db.
     */
    if (store.backendMode) {
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
    const rows = store.db.prepare(`SELECT log FROM tasks WHERE ${TaskStore.ACTIVE_TASKS_WHERE}`).all() as Array<{ log: string | null }>;
    const mutations: TaskLogEntry[] = [];
    for (const row of rows) {
      const logEntries = fromJson<TaskLogEntry[]>(row.log) || [];
      for (const entry of logEntries) {
        if (entry.runContext?.runId === runId) {
          mutations.push(entry);
        }
      }
    }
    // Sort by timestamp ascending
    return mutations.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
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
    if (store.backendMode) {
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
            target: schema.project.mergeRequests.taskId,
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
    return store.db.transactionImmediate(() => {
      const now = input.now ?? new Date().toISOString();
      store.db.prepare(`
        INSERT INTO merge_requests (taskId, state, createdAt, updatedAt, attemptCount, lastError)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(taskId) DO UPDATE SET
          state = excluded.state,
          updatedAt = excluded.updatedAt,
          attemptCount = excluded.attemptCount,
          lastError = excluded.lastError
      `).run(taskId, input.state, now, now, input.attemptCount ?? 0, input.lastError ?? null);

      const row = store.db.prepare("SELECT * FROM merge_requests WHERE taskId = ?").get(taskId) as MergeRequestRow | undefined;
      if (!row) throw new Error(`Failed to upsert merge request for ${taskId}`);

      store.insertRunAuditEventRow({
        taskId,
        domain: "database",
        mutationType: "mergeRequest:upsert",
        target: taskId,
        metadata: { taskId, state: row.state, attemptCount: row.attemptCount, lastError: row.lastError },
      });

      return store.rowToMergeRequestRecord(row);
    });
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
    if (store.backendMode) {
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
    return store.db.transactionImmediate(() => {
      const now = opts.now ?? new Date().toISOString();
      const existing = store.db.prepare("SELECT * FROM merge_requests WHERE taskId = ?").get(taskId) as MergeRequestRow | undefined;
      if (!existing) {
        throw new Error(`Merge request record not found for ${taskId}`);
      }
      const fromState = store.normalizeMergeRequestState(existing.state);
      if (!store.isValidMergeRequestTransition(fromState, toState)) {
        throw new Error(`Invalid merge request state transition for ${taskId}: ${fromState} -> ${toState}`);
      }

      store.db.prepare(`
        UPDATE merge_requests
           SET state = ?,
               updatedAt = ?,
               attemptCount = ?,
               lastError = ?
         WHERE taskId = ?
      `).run(toState, now, opts.attemptCount ?? existing.attemptCount, opts.lastError ?? existing.lastError, taskId);

      const updated = store.db.prepare("SELECT * FROM merge_requests WHERE taskId = ?").get(taskId) as MergeRequestRow | undefined;
      if (!updated) throw new Error(`Merge request record disappeared for ${taskId}`);

      store.insertRunAuditEventRow({
        taskId,
        domain: "database",
        mutationType: "mergeRequest:transition",
        target: taskId,
        metadata: { taskId, fromState, toState, attemptCount: updated.attemptCount, lastError: updated.lastError },
      });
      return store.rowToMergeRequestRecord(updated);
    });
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
    if (store.backendMode) {
      const layer = store.asyncLayer!;
      return getWorkflowWorkItemAsync(layer.db, id);
    }
    const row = store.db.prepare("SELECT * FROM workflow_work_items WHERE id = ?").get(id) as WorkflowWorkItemRow | undefined;
    return row ? store.rowToWorkflowWorkItem(row) : null;
}

