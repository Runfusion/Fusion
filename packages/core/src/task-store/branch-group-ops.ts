import { emitBoundedRunAudit } from "../run-audit/emit-bounded-run-audit.js";
/* FNXC:RunAudit 2026-08-20-05:49: FN-9177 bounds optional audit telemetry so a hostile sink cannot alter this lifecycle path. */
/**
 * branch-group-ops operations.
 *
 * FNXC:StoreModularization 2026-06-25-00:00:
 * Extracted from the monolithic packages/core/src/store.ts as a pure
 * behavior-preserving refactor. Each function receives the TaskStore
 * instance as its first parameter and performs byte-identical work.
 */
import {TaskStore} from "../store.js";
import {resolveTaskLifecycleColumns, columnsWithFlag} from "../workflows/workflow-lifecycle-traits.js";
import {resolveWorkflowIrForTask} from "../workflows/workflow-ir-resolver.js";
import type {WorkflowIr} from "../workflows/workflow-ir-types.js";
import type {Task, ColumnId, ArtifactType, ArtifactWithTask, InboxTask, TaskLogEntry, RunMutationContext, Agent} from "../types.js";
import {runReconciliationAbort} from "../workflows/workflow-reconciliation.js";
import "../builtin-traits.js";
import {evaluateImplementationTaskBind} from "../agents/agent-role-policy.js";
import {isNearDuplicateCanonicalInactive} from "../duplicates/near-duplicate-canonical.js";
import {resolveColumnFlags} from "../workflows/trait-registry.js";
import {__setTaskActivityLogLimitsForTesting} from "../task-store/comments.js";
import {listArtifacts as listArtifactsAsync} from "./async/async-comments-attachments.js";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import * as schema from "../postgres/schema/index.js";
import { ARCHIVED_SENTINEL_LANES, resolveProjectColumnsForRoles } from "../project-lane-vocabulary.js";

export async function saveWorkflowRunBranchImpl(store: TaskStore, state: { taskId: string; runId: string; branchId: string; currentNodeId: string; status: string; }): Promise<void> {
    /*
    FNXC:PostgresOnlyDataAccess 2026-07-16-12:15:
    Backend mode previously swallowed the sync throw, so parallel-branch
    checkpoints were never persisted on PostgreSQL. ON CONFLICT targets the PK
    by constraint name because project-schema PKs lead with project_id (which
    itself comes from the column's current_setting default under RLS).
    */
        await store.asyncLayer!.db.execute(sql`
      INSERT INTO project.workflow_run_branches
        (task_id, run_id, branch_id, current_node_id, status, updated_at)
      VALUES (${state.taskId}, ${state.runId}, ${state.branchId}, ${state.currentNodeId}, ${state.status}, ${new Date().toISOString()})
      ON CONFLICT ON CONSTRAINT workflow_run_branches_pkey DO UPDATE SET
        current_node_id = EXCLUDED.current_node_id,
        status = EXCLUDED.status,
        updated_at = EXCLUDED.updated_at
    `);
    return;
}

export async function clearNearDuplicateReferencesToImpl(store: TaskStore, canonicalId: string, inactiveState: { column?: ColumnId | null; deletedAt?: string | null; reason: string },): Promise<Task[]> {
    /*
    FNXC:WorkflowResolvedColumns 2026-07-30-03:10:
    Resolve the CANONICAL's own column flags before asking whether it is inactive. Omitted, the
    predicate falls back to the legacy `done`/`archived` ids, so on a renamed board a canonical that
    has just been completed (`shipped`) reads as still ACTIVE — this guard
    early-returns and the duplicate markers pointing at it are NEVER cleared. The flagged tasks stay
    parked behind a user decision that can never arrive, which is the exact stranding the note on
    `isNearDuplicateCanonicalInactive` says it was written to prevent.

    Five of this predicate's six production call sites already resolved flags; this one did not, and
    it is the one that runs on every completion or deletion transition.

    `undefined` on failure is deliberate and matches `moves.ts`: it degrades to the legacy id rather
    than to absent traits that match nothing.
    */
    const canonicalIr = await resolveWorkflowIrForTask(store, canonicalId).catch(() => undefined);
    /* v1 IRs declare no columns, so there is nothing to resolve and the legacy fallback stands.
       (`columnsOf` in workflow-lifecycle-traits.ts is module-private; this is the same narrowing,
       inlined rather than widening that module's API for a single caller.) */
    const canonicalColumns = canonicalIr?.version === "v2" ? canonicalIr.columns : [];
    const canonicalColumn = canonicalColumns.find((column) => column.id === inactiveState.column);
    const canonicalFlags = canonicalColumn ? resolveColumnFlags(canonicalColumn) : undefined;
    if (!isNearDuplicateCanonicalInactive(inactiveState, canonicalFlags)) {
      return [];
    }

        /*
     * FNXC:PostgresNearDuplicateCleanup 2026-07-14-18:30:
     * Archiving, deleting, or completing a canonical task must clear every
     * live duplicate marker in the same project. Stale JSONB markers alter
     * operator decisions, so PostgreSQL applies the same cleanup and audit
     * behavior as the legacy store instead of treating it as optional.
     */
    const layer = store.asyncLayer!;
    const table = schema.project.tasks;
    /*
    FNXC:WorkflowResolvedColumns 2026-07-31-23:59:
    LANE. This clears near-duplicate markers pointing at a canonical that is still LIVE; a finished
    canonical's markers are handled elsewhere. Against the literals a renamed board found no live
    rows at all, so stale markers survived — and the header above says stale markers alter operator
    decisions, which is why the PG path mirrors the legacy store here rather than treating it as
    optional.

    Additive and legacy-seeded: an unconverted board builds the same two `ne`s it built before.
    */
    const resolvedLiveCompleteLanes = await resolveProjectColumnsForRoles(store, ["complete"])
      .catch(() => undefined);
    const liveCanonicalLanes = resolvedLiveCompleteLanes
      ? new Set([...resolvedLiveCompleteLanes, ...ARCHIVED_SENTINEL_LANES])
      : undefined;
    const finishedExclusions = liveCanonicalLanes && liveCanonicalLanes.size > 0
      ? [...liveCanonicalLanes].map((lane) => ne(table.column, lane))
      : [ne(table.column, "archived"), ne(table.column, "done")];
    const conditions = [
      isNull(table.deletedAt),
      ...finishedExclusions,
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

export async function selectNextTaskForAgentImpl(store: TaskStore, agentId: string, agent?: Pick<Agent, "id" | "role"> & Partial<Pick<Agent, "runtimeConfig">>,): Promise<InboxTask | null> {
    const hasExecutorRoleOverride = (task: Task): boolean => task.sourceMetadata?.executorRoleOverride === true;
    const tasks = await store.listTasks({ slim: true });
    if (tasks.length === 0) {
      return null;
    }

    const tasksById = new Map(tasks.map((task) => [task.id, task]));
    const isCheckoutAware = "checkoutTask" in store && typeof (store as Record<string, unknown>).checkoutTask === "function";

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

    /*
    FNXC:WorkflowResolvedColumns 2026-07-30-14:50 (fleet phase; #2739 review — greptile P2):
    The dispatcher's OWN lane filters, resolved for this agent's tasks only. On a renamed board both
    matched nothing, so an agent asking for work was told there was none with its own assigned tasks
    sitting in the list it just fetched — no error, no log, the agent simply idles.

    Scoped to `assignedTasks` deliberately: an earlier version walked the whole board before filtering, so
    a 400-card board paid 400 resolutions to dispatch one agent that owns three. `assignedAgentId` is a
    plain property read and was already the next filter, so hoisting it costs nothing.

    ONE cache across BOTH lifecycle loops. An earlier version of this comment claimed the dependency pass
    below shared it while the code allocated a second map, so a task and its dependency in the same workflow
    resolved that workflow's IR twice — the comment asserted an optimisation the code did not perform.
    `lifecycleIrCache` is now the only cache and the dependency loop takes it.
    */
    const lifecycleIrCache = new Map<string, WorkflowIr>();
    const lifecycleByTaskId = new Map<string, Awaited<ReturnType<typeof resolveTaskLifecycleColumns>>>();
    for (const task of assignedTasks) {
      if (lifecycleByTaskId.has(task.id)) continue;
      lifecycleByTaskId.set(task.id, await resolveTaskLifecycleColumns(store, task.id, lifecycleIrCache));
    }
    const isWipTask = (task: Task) => task.column === (lifecycleByTaskId.get(task.id)?.wip ?? "in-progress");
    const isHoldTask = (task: Task) => task.column === (lifecycleByTaskId.get(task.id)?.hold ?? "todo");

    const inProgress = assignedTasks
      .filter((task) => isWipTask(task) && isBindCompatible(task))
      .sort(sortByOldestColumnMove);
    if (inProgress.length > 0) {
      return {
        task: inProgress[0],
        priority: "in_progress",
        reason: "Resuming in-progress task assigned to this agent",
      };
    }

    const roleCompatibleAssignedTasks = assignedTasks.filter(isBindCompatible);

    /*
    FNXC:WorkflowLifecycleColumns 2026-08-02-20:35 (PR #2745 review — greptile P1: "dependency lanes remain
    legacy-only"):
    ONE SATISFIED SET FOR THE WHOLE BATCH, resolved from the dependency rows already loaded into `tasksById`.
    The reviewer's point is the one that matters: adding `satisfiedColumns` to `areAllDependenciesDone` without
    wiring this caller left the capability unused, so a branch-group task depending on a card that landed in a
    workflow-specific complete lane stayed excluded from dispatch — unchanged from before the conversion.

    Resolved per dependency through a shared IR cache (dependencies can span workflows) and unioned with the
    built-in `done` fallback, matching the merge blocker.
    */
    const satisfiedColumns = new Set<string>(["done"]);
    /* FNXC:WorkflowResolvedColumns 2026-07-30-14:50 (#2739 review): reuses the dispatch cache above, so a
       task and its dependency in one workflow read that IR once between them. */
    /*
    FNXC:WorkflowResolvedColumns 2026-07-30-16:10 (#2739 review — greptile P1, MEMBERSHIP not first-per-role):
    `resolveLifecycleColumns` returns the FIRST column carrying each trait, so a workflow declaring two
    complete lanes (or a complete plus a separate sign-off-complete) had only one of them counted as
    satisfying a dependency. A dependent whose blocker landed in the SECOND terminal lane read as unfinished
    and was dropped from both ready and actionable-blocked dispatch — silently, since "no work available" is
    indistinguishable from "correctly waiting".

    Fixed locally with `columnsWithFlag`, and worth distinguishing from the arity gap I declined to fix on
    the earlier thread. That one asked a single-id question (`lifecycle.wip`) where making it membership
    changes what the shared resolver returns for ~30 consumers. THIS loop already builds a SET and already
    unions across dependencies, so membership is what it was always trying to express — no resolver change,
    no consumer migration, and it matches the `register-task-workflow-routes` precedent.
    */
    for (const dependencyId of new Set(
      roleCompatibleAssignedTasks.flatMap((task) => task.dependencies ?? []),
    )) {
      const ir = await resolveWorkflowIrForTask(store, dependencyId, lifecycleIrCache);
      if (!ir) continue;
      for (const columnId of columnsWithFlag(ir, "complete")) satisfiedColumns.add(columnId);
    }
    const isDoneLike = (task: Task | undefined) => task !== undefined && satisfiedColumns.has(task.column);

    /** FNXC:TaskDispatch 2026-07-19-14:40: remembered ownership must not reselect an operator-parked task when `userPaused` remains true but legacy `paused` is false. */
    const todoCandidates = roleCompatibleAssignedTasks.filter(
      (task) => isHoldTask(task) && task.paused !== true && task.userPaused !== true,
    );

    const readyTodo = todoCandidates
      .filter((task) => {
        if (isCheckoutAware && task.checkedOutBy && task.checkedOutBy !== agentId) {
          return false;
        }
        return store.areAllDependenciesDone(task.dependencies, tasksById, satisfiedColumns);
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

        if (store.areAllDependenciesDone(task.dependencies, tasksById, satisfiedColumns)) {
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

export async function pauseTaskImpl(store: TaskStore, id: string, paused: boolean, runContext?: RunMutationContext, agentOptions?: { pausedByAgentId?: string; pausedReason?: string; userPaused?: boolean },): Promise<Task> {
    return store.withTaskLock(id, async () => {
      const dir = store.taskDir(id);
      const task = await store.readTaskJson(dir);

      // Initialize log array if missing (for legacy tasks)
      if (!task.log) {
        task.log = [];
      }

      const previousPausedByAgentId = task.pausedByAgentId;
      task.paused = paused || undefined;
      if (paused && agentOptions?.userPaused) {
        task.userPaused = true;
      }
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
      /*
      FNXC:WorkflowResolvedColumns 2026-07-30-14:50 (fleet phase):
      One task in hand, so one resolution — the "is this card mid-flight or in review" test that decides
      whether pausing shows a `paused` status. On a renamed board neither literal matched, so pausing a
      running card left its status untouched and the UI kept showing it as working.
      */
      const pauseLifecycle = await resolveTaskLifecycleColumns(store, id);
      if (
        task.column === (pauseLifecycle?.wip ?? "in-progress")
        || task.column === (pauseLifecycle?.review ?? "in-review")
      ) {
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
        return listArtifactsAsync(store.asyncLayer!.db, options, store.asyncLayer!.projectId);
}

/*
FNXC:WorkflowColumns 2026-07-28-00:00 (U12 — PR #2513 review):
Returns the OUTCOME instead of `void`. This function deliberately swallows a rejected
move ("a full target column rejects, which we audit and skip"), which is correct for
the sweep-style callers that re-home many cards best-effort — but for the workflow
SWITCH it produced a torn write with no alarm: the new selection had already
committed, so the selection said one thing and the card's column said another and
nothing reported it. Callers that need to know now can; the audit event is unchanged.
*/
export interface RehomeOccupantResult {
  /** True when the card actually landed in `targetColumn`. */
  readonly moved: boolean;
  /** Why the move was rejected, when it was. */
  readonly error?: string;
}

export async function rehomeOccupantImpl(store: TaskStore, taskId: string, targetColumn: string, reason: "workflow-switch" | "workflow-delete" | "workflow-edit-rehome", metadata: Record<string, unknown>,): Promise<RehomeOccupantResult> {
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
    if (!current) return { moved: false, error: "task not readable" };
    const fromColumn = current.column;
    if (fromColumn === targetColumn) {
      // Already in the target column — nothing to move, but still record the
      // reconciliation decision for audit traceability.
      void emitBoundedRunAudit(store, {
        taskId,
        agentId: "system",
        runId: `workflow-reconcile-${reason}-${taskId}-${Date.now()}`,
        domain: "database",
        mutationType: "task:workflow-reconcile",
        target: taskId,
        metadata: { ...metadata, reason, fromColumn, toColumn: targetColumn, moved: false },
      });
      // Already in the target column: nothing to move, and nothing failed.
      return { moved: true };
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
    void emitBoundedRunAudit(store, {
      taskId,
      agentId: "system",
      runId: `workflow-reconcile-${reason}-${taskId}-${Date.now()}`,
      domain: "database",
      mutationType: "task:workflow-reconcile",
      target: taskId,
      metadata: { ...metadata, reason, fromColumn, toColumn: targetColumn, abortRan, moved, error },
    });
    return { moved, ...(error !== undefined ? { error } : {}) };
  }
