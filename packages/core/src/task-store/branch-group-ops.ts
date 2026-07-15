/**
 * branch-group-ops operations.
 *
 * FNXC:StoreModularization 2026-06-25-00:00:
 * Extracted from the monolithic packages/core/src/store.ts as a pure
 * behavior-preserving refactor. Each function receives the TaskStore
 * instance as its first parameter and performs byte-identical work.
 */
import {TaskStore} from "../store.js";
import type {Task, ColumnId, ArtifactType, ArtifactWithTask, InboxTask, TaskLogEntry, RunMutationContext, Agent} from "../types.js";
import {runReconciliationAbort} from "../workflow-reconciliation.js";
import "../builtin-traits.js";
import {evaluateImplementationTaskBind} from "../agent-role-policy.js";
import {isNearDuplicateCanonicalInactive} from "../near-duplicate-canonical.js";
import {type TaskRow} from "../task-store/persistence.js";
import {__setTaskActivityLogLimitsForTesting} from "../task-store/comments.js";
import type {ArtifactRow} from "../task-store/row-types.js";
import {listArtifacts as listArtifactsAsync} from "./async-comments-attachments.js";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import * as schema from "../postgres/schema/index.js";

export function saveWorkflowRunBranchImpl(store: TaskStore, state: { taskId: string; runId: string; branchId: string; currentNodeId: string; status: string; }): void {
    try {
      store.db
        .prepare(
          `INSERT INTO workflow_run_branches
             (taskId, runId, branchId, currentNodeId, status, updatedAt)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(taskId, runId, branchId) DO UPDATE SET
             currentNodeId = excluded.currentNodeId,
             status = excluded.status,
             updatedAt = excluded.updatedAt`,
        )
        .run(
          state.taskId,
          state.runId,
          state.branchId,
          state.currentNodeId,
          state.status,
          new Date().toISOString(),
        );
    } catch {
      // Legacy/missing table — persistence is additive, so degrade silently.
    }
  }

export async function clearNearDuplicateReferencesToImpl(store: TaskStore, canonicalId: string, inactiveState: { column?: ColumnId | null; deletedAt?: string | null; reason: string },): Promise<Task[]> {
    if (!isNearDuplicateCanonicalInactive(inactiveState)) {
      return [];
    }

    if (store.backendMode) {
      /*
       * FNXC:PostgresNearDuplicateCleanup 2026-07-14-18:30:
       * Archiving, deleting, or completing a canonical task must clear every
       * live duplicate marker in the same project. Stale JSONB markers alter
       * operator decisions, so PostgreSQL applies the same cleanup and audit
       * behavior as the legacy store instead of treating it as optional.
       */
      const layer = store.asyncLayer!;
      const table = schema.project.tasks;
      const conditions = [
        isNull(table.deletedAt),
        ne(table.column, "archived"),
        ne(table.column, "done"),
        sql`${table.sourceMetadata}->>'nearDuplicateOf' = ${canonicalId}`,
      ];
      if (layer.projectId) conditions.push(eq(table.projectId, layer.projectId));
      const rows = await layer.db
        .update(table)
        .set({
          sourceMetadata: sql`COALESCE(${table.sourceMetadata}, '{}'::jsonb) - 'nearDuplicateOf' - 'nearDuplicateScore' - 'nearDuplicateSharedTokens' - 'nearDuplicateDismissed'`,
          updatedAt: new Date().toISOString(),
        })
        .where(and(...conditions))
        .returning({ id: table.id });

      const updatedTasks: Task[] = [];
      for (const row of rows) {
        await store.logEntry(
          row.id,
          `Near-duplicate canonical ${canonicalId} is now inactive (${inactiveState.reason}); cleared duplicate flag (informational, no decision required)`,
        );
        const task = await store.getTask(row.id);
        if (task) updatedTasks.push(task);
      }
      return updatedTasks;
    }

    const selectClause = store.getTaskSelectClause(false, "t");
    const rows = store.db.prepare(`
      SELECT ${selectClause}
      FROM tasks t
      WHERE t."deletedAt" IS NULL
        AND t."column" != 'archived'
        AND t."column" != 'done'
        AND json_extract(t.sourceMetadata, '$.nearDuplicateOf') = ?
      ORDER BY t.createdAt ASC
    `).all(canonicalId) as TaskRow[];

    const updatedTasks: Task[] = [];
    for (const row of rows) {
      const task = store.rowToTask(row);
      const nextSourceMetadata = { ...(task.sourceMetadata ?? {}) };
      delete nextSourceMetadata.nearDuplicateOf;
      delete nextSourceMetadata.nearDuplicateScore;
      delete nextSourceMetadata.nearDuplicateSharedTokens;
      delete nextSourceMetadata.nearDuplicateDismissed;

      task.sourceMetadata = Object.keys(nextSourceMetadata).length > 0 ? nextSourceMetadata : undefined;
      const updatedAt = new Date().toISOString();
      task.updatedAt = updatedAt;
      task.log = [
        ...(task.log ?? []),
        {
          timestamp: updatedAt,
          action: `Near-duplicate canonical ${canonicalId} is now inactive (${inactiveState.reason}); cleared duplicate flag (informational, no decision required)`,
        },
      ];

      store.db.transactionImmediate(() => {
        store.upsertTaskWithFtsRecovery(task);
        store.db.bumpLastModified();
      });
      await store.writeTaskJsonFile(store.taskDir(task.id), task);
      if (store.isWatching) store.taskCache.set(task.id, { ...task });
      store.emit("task:updated", task);
      updatedTasks.push(task);
    }

    return updatedTasks;
  }

export async function selectNextTaskForAgentImpl(store: TaskStore, agentId: string, agent?: Pick<Agent, "id" | "role"> & Partial<Pick<Agent, "runtimeConfig">>,): Promise<InboxTask | null> {
    const hasExecutorRoleOverride = (task: Task): boolean => task.sourceMetadata?.executorRoleOverride === true;
    const tasks = await store.listTasks({ slim: true });
    if (tasks.length === 0) {
      return null;
    }

    const tasksById = new Map(tasks.map((task) => [task.id, task]));
    const isCheckoutAware = "checkoutTask" in store && typeof (store as Record<string, unknown>).checkoutTask === "function";
    const isDoneLike = (task: Task | undefined) => task?.column === "done" || task?.column === "archived";
    const sortByOldestColumnMove = (a: Task, b: Task) => {
      const aSortAt = a.columnMovedAt ?? a.createdAt;
      const bSortAt = b.columnMovedAt ?? b.createdAt;
      return aSortAt.localeCompare(bSortAt);
    };

    /*
    FNXC:AgentRouting 2026-07-12-12:05 (merge port from main):
    FN-7851 / issue #2015: the in-progress branch used to return unconditionally, so a task mis-bound to a
    role-incompatible or policy-excluded agent was re-selected on every heartbeat forever (the NEXT-871 liaison
    loop). Route BOTH branches through the shared bind evaluator. executorRoleOverride still bypasses the role
    check but never assignmentPolicy "none" — that is the hard liaison guarantee.
    */
    const isBindCompatible = (task: Task): boolean => {
      if (!agent) return true;
      return evaluateImplementationTaskBind(agent, task, {
        explicitRouting: true,
        executorRoleOverride: hasExecutorRoleOverride(task),
      }).allowed;
    };

    const assignedTasks = tasks.filter((task) => task.assignedAgentId === agentId);

    const inProgress = assignedTasks
      .filter((task) => task.column === "in-progress" && isBindCompatible(task))
      .sort(sortByOldestColumnMove);
    if (inProgress.length > 0) {
      return {
        task: inProgress[0],
        priority: "in_progress",
        reason: "Resuming in-progress task assigned to this agent",
      };
    }

    const roleCompatibleAssignedTasks = assignedTasks.filter(isBindCompatible);

    const todoCandidates = roleCompatibleAssignedTasks.filter((task) => task.column === "todo" && task.paused !== true);

    const readyTodo = todoCandidates
      .filter((task) => {
        if (isCheckoutAware && task.checkedOutBy && task.checkedOutBy !== agentId) {
          return false;
        }
        return store.areAllDependenciesDone(task.dependencies, tasksById);
      })
      .sort(sortByOldestColumnMove);

    if (readyTodo.length > 0) {
      return {
        task: readyTodo[0],
        priority: "todo",
        reason: "Selecting oldest ready todo task assigned to this agent",
      };
    }

    const actionableBlocked = todoCandidates
      .filter((task) => {
        if (isCheckoutAware && task.checkedOutBy && task.checkedOutBy !== agentId) {
          return false;
        }

        if (store.areAllDependenciesDone(task.dependencies, tasksById)) {
          return false;
        }

        return task.dependencies.some((dependencyId) => isDoneLike(tasksById.get(dependencyId)));
      })
      .sort(sortByOldestColumnMove);

    if (actionableBlocked.length > 0) {
      return {
        task: actionableBlocked[0],
        priority: "blocked",
        reason: "Selecting partially actionable blocked task assigned to this agent",
      };
    }

    return null;
  }

export async function pauseTaskImpl(store: TaskStore, id: string, paused: boolean, runContext?: RunMutationContext, agentOptions?: { pausedByAgentId?: string; pausedReason?: string },): Promise<Task> {
    return store.withTaskLock(id, async () => {
      const dir = store.taskDir(id);
      const task = await store.readTaskJson(dir);

      // Initialize log array if missing (for legacy tasks)
      if (!task.log) {
        task.log = [];
      }

      const previousPausedByAgentId = task.pausedByAgentId;
      task.paused = paused || undefined;
      if (paused && agentOptions?.pausedByAgentId) {
        task.pausedByAgentId = agentOptions.pausedByAgentId;
      }
      /*
       * FNXC:ApprovalHold 2026-07-09-00:05:
       * FN-7736: `agentOptions.pausedReason` is the minimal seam for durably
       * stamping WHY a task was paused (e.g. the canonical
       * `AWAITING_APPROVAL_PAUSE_REASON` from a tool-approval gate). Widening
       * this existing options bag avoids a second, racy `updateTask` write right
       * after `pauseTask` — the reason lands atomically with the pause itself.
       * On unpause the caller-supplied reason is cleared here (mirroring how
       * `pausedByAgentId`/`userPaused` are already cleared below); sweep-set
       * built-in reasons like `branch-conflict-unrecoverable` are cleared by
       * their own dedicated resume code paths and are unaffected.
       */
      if (paused && agentOptions?.pausedReason) {
        task.pausedReason = agentOptions.pausedReason;
      }
      if (!paused) {
        task.pausedByAgentId = undefined;
        task.userPaused = undefined;
        task.pausedReason = undefined;
      }
      // When pausing an in-progress/in-review task, set status so the UI can show the state.
      // When unpausing, clear the "paused" status.
      if (task.column === "in-progress" || task.column === "in-review") {
        task.status = paused ? "paused" : undefined;
      }
      const now = new Date().toISOString();
      task.updatedAt = now;
      const logEntry: TaskLogEntry = {
        timestamp: now,
        action: paused
          ? (agentOptions?.pausedByAgentId
            ? `Task paused (agent ${agentOptions.pausedByAgentId} paused)`
            : "Task paused")
          : (previousPausedByAgentId
            ? `Task unpaused (agent ${previousPausedByAgentId} resumed)`
            : "Task unpaused"),
      };
      if (runContext) {
        logEntry.runContext = runContext;
      }
      task.log.push(logEntry);

      // When runContext is provided, record audit event atomically with task mutation
      if (runContext) {
        await store.atomicWriteTaskJsonWithAudit(dir, task, {
          taskId: task.id,
          agentId: runContext.agentId,
          runId: runContext.runId,
          domain: "database",
          mutationType: paused ? "task:pause" : "task:unpause",
          target: task.id,
        });
      } else {
        await store.atomicWriteTaskJson(dir, task);
      }
      if (store.isWatching) store.taskCache.set(id, { ...task });

      store.emit("task:updated", task);
      return task;
    });
  }

export function clearLinkedAgentTaskIdsImpl(store: TaskStore, taskId: string, updatedAt: string = new Date().toISOString()): void {
    const linkedAgents = store.db
      .prepare("SELECT id FROM agents WHERE taskId = ?")
      .all(taskId) as Array<{ id: string }>;

    if (linkedAgents.length === 0) {
      return;
    }

    store.db.prepare(`
      UPDATE agents
      SET
        taskId = NULL,
        updatedAt = ?,
        data = CASE
          WHEN json_valid(data) THEN json_set(json_remove(data, '$.taskId'), '$.updatedAt', ?)
          ELSE data
        END
      WHERE taskId = ?
    `).run(updatedAt, updatedAt, taskId);
  }

export async function listArtifactsImpl(store: TaskStore, options?: { type?: ArtifactType; authorId?: string; taskId?: string; limit?: number; offset?: number; search?: string; }): Promise<ArtifactWithTask[]> {
    // FNXC:Artifacts 2026-06-27-12:10:
    // PG backend mode: delegate to the AsyncDataLayer helper. The sync path
    // below dereferences store.db (no SQLite handle in backend mode) and 500'd
    // the dashboard /api/artifacts list.
    if (store.backendMode) {
      return listArtifactsAsync(store.asyncLayer!.db, options);
    }
    const limit = Math.min(Math.max(1, options?.limit ?? 200), 1000);
    const offset = Math.max(0, options?.offset ?? 0);

    let sql = `
      SELECT
        a.id,
        a.type,
        a.title,
        a.description,
        a.mimeType,
        a.sizeBytes,
        a.uri,
        NULL as content,
        a.authorId,
        a.authorType,
        a.taskId,
        a.metadata,
        a.createdAt,
        a.updatedAt,
        t.title as taskTitle,
        t.description as taskDescription,
        t.column as taskColumn
      FROM artifacts a
      LEFT JOIN tasks t ON a.taskId = t.id
      WHERE (a.taskId IS NULL OR t.${TaskStore.ACTIVE_TASKS_WHERE})
    `;
    const params: (string | number)[] = [];

    if (options?.type) {
      sql += " AND a.type = ?";
      params.push(options.type);
    }
    if (options?.authorId) {
      sql += " AND a.authorId = ?";
      params.push(options.authorId);
    }
    if (options?.taskId) {
      sql += " AND a.taskId = ?";
      params.push(options.taskId);
    }
    if (options?.search && options.search.trim() !== "") {
      const query = `%${options.search.trim()}%`;
      sql += " AND (a.title LIKE ? OR a.description LIKE ?)";
      params.push(query, query);
    }

    sql += " ORDER BY a.createdAt DESC LIMIT ? OFFSET ?";
    params.push(limit, offset);

    const rows = store.db.prepare(sql).all(...params) as unknown as Array<ArtifactRow & {
      taskTitle: string | null;
      taskDescription: string | null;
      taskColumn: string | null;
    }>;
    return rows.map((row) => ({
      ...store.rowToArtifact(row),
      ...(row.taskTitle !== null ? { taskTitle: row.taskTitle } : {}),
      ...(row.taskDescription !== null ? { taskDescription: row.taskDescription } : {}),
      ...(row.taskColumn !== null ? { taskColumn: row.taskColumn } : {}),
    }));
  }

export async function rehomeOccupantImpl(store: TaskStore, taskId: string, targetColumn: string, reason: "workflow-switch" | "workflow-delete" | "workflow-edit-rehome", metadata: Record<string, unknown>,): Promise<void> {
    /*
    FNXC:PostgresWorkflowEvacuation 2026-07-14-17:49:
    Re-homing is an async workflow mutation and must read its current task through the authoritative PostgreSQL path; otherwise ON→OFF evacuation discovers custom-column cards but the SQLite-only read prevents every move.
    */
    let current: Task | undefined;
    try {
      current = store.backendMode
        ? await store.getTask(taskId, { includeDeleted: false })
        : store.readTaskFromDb(taskId, { includeDeleted: false });
    } catch {
      current = undefined;
    }
    if (!current) return;
    const fromColumn = current.column;
    if (fromColumn === targetColumn) {
      // Already in the target column — nothing to move, but still record the
      // reconciliation decision for audit traceability.
      void store.recordRunAuditEvent({
        taskId,
        agentId: "system",
        runId: `workflow-reconcile-${reason}-${taskId}-${Date.now()}`,
        domain: "database",
        mutationType: "task:workflow-reconcile",
        target: taskId,
        metadata: { ...metadata, reason, fromColumn, toColumn: targetColumn, moved: false },
      });
      return;
    }
    const abortRan = await runReconciliationAbort({ taskId, fromColumn, reason });
    let moved = false;
    let error: string | undefined;
    try {
      // Recovery-class move: engine source + bypassGuards (KTD-9). preserveProgress
      // keeps the task's fields intact (R20 delete semantics). Capacity (KTD-10) is
      // NOT bypassed — a full target column rejects, which we audit and skip.
      await store.moveTask(taskId, targetColumn, {
        moveSource: "engine",
        bypassGuards: true,
        recoveryRehome: true,
        preserveProgress: true,
        preserveResumeState: true,
        preserveWorktree: true,
        allowDirectInReviewMove: true,
      });
      moved = true;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    void store.recordRunAuditEvent({
      taskId,
      agentId: "system",
      runId: `workflow-reconcile-${reason}-${taskId}-${Date.now()}`,
      domain: "database",
      mutationType: "task:workflow-reconcile",
      target: taskId,
      metadata: { ...metadata, reason, fromColumn, toColumn: targetColumn, abortRan, moved, error },
    });
  }
