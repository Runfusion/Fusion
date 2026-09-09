import { emitBoundedRunAudit } from "../run-audit/emit-bounded-run-audit.js";
/* FNXC:RunAudit 2026-08-20-05:49: FN-9177 bounds optional audit telemetry so a hostile sink cannot alter this lifecycle path. */
/**
 * audit-ops operations.
 *
 * FNXC:StoreModularization 2026-06-25-00:00:
 * Extracted from the monolithic packages/core/src/store.ts as a pure
 * behavior-preserving refactor. Each function receives the TaskStore
 * instance as its first parameter and performs byte-identical work.
 */
import { and, eq, isNull } from "drizzle-orm";
import {TaskStore} from "../store.js";
import type { Task, TaskDetail, TaskLogEntry, RunMutationContext } from "../types.js";
import {findWorkflowColumn} from "../plugins/plugin-gate-verdict.js";
import {getTraitRegistry} from "../workflows/trait-registry.js";
import {makeTransitionPending} from "../tasks/transition-types.js";
import {writeTransitionPendingAsync} from "./async/async-transition-pending.js";
import type {WorkflowIr} from "../workflows/workflow-ir-types.js";
import "../builtin-traits.js";
import {__setTaskActivityLogLimitsForTesting, truncateTaskLogOutcome, getTaskActivityLogEntryLimit} from "../task-store/comments.js";
import {readTaskRow, updateTaskColumns} from "../task-store/async/async-persistence.js";
import { getLiveTaskColumn } from "./async/async-comments-attachments.js";
import { acquireTaskAdvisoryXactLock } from "./task-advisory-lock.js";
import { ARCHIVED_SENTINEL_LANES } from "../project-lane-vocabulary.js";
import * as schema from "../postgres/schema/index.js";

export async function runPluginColumnTransitionHooksImpl(store: TaskStore, taskId: string, workflowIr: WorkflowIr, fromColumn: string, toColumn: string,): Promise<void> {
    const registry = getTraitRegistry();
    // Collect (traitId, hookKind) pairs: onExit for from-column plugin traits,
    // onEnter for to-column plugin traits. Only plugin-namespaced traits (KTD-7).
    const pending: Array<{ traitId: string; hookKind: "onEnter" | "onExit" }> = [];
    const fromCol = findWorkflowColumn(workflowIr, fromColumn);
    for (const ct of fromCol?.traits ?? []) {
      if (!ct.trait.startsWith("plugin:")) continue;
      const def = registry.getTrait(ct.trait);
      if (def?.hooks?.onExit) pending.push({ traitId: ct.trait, hookKind: "onExit" });
    }
    const toCol = findWorkflowColumn(workflowIr, toColumn);
    for (const ct of toCol?.traits ?? []) {
      if (!ct.trait.startsWith("plugin:")) continue;
      const def = registry.getTrait(ct.trait);
      if (def?.hooks?.onEnter) pending.push({ traitId: ct.trait, hookKind: "onEnter" });
    }
    if (pending.length === 0) return;

    // Record the plugin hooks in the marker's hooksRemaining (alongside the
    // default-workflow:postCommit marker already written in-txn) so a crash
    // mid-hook is recoverable.
    const hookIds = pending.map((p) => `${p.traitId}:${p.hookKind}`);
    const startedAt = Date.now();
    /*
    FNXC:PostgresOnlyDataAccess 2026-07-16-12:20:
    Backend mode previously threw on the sync store.db marker write /
    readTaskFromDb here; callers (moves.ts, lifecycle-ops.ts recovery) swallow
    the throw, so plugin onEnter/onExit column-transition hooks silently never
    fired on PostgreSQL. Route both the marker bookkeeping and the non-locking
    task read through the async layer.
    */
    const writeMarker = async (remainingHookIds: string[]): Promise<void> => {
      try {
        const marker = makeTransitionPending(toColumn, remainingHookIds, startedAt);
                await writeTransitionPendingAsync(store.asyncLayer!.db, taskId, marker);

      } catch {
        // Marker bookkeeping is best-effort; proceed to run the hooks regardless.
      }
    };
    await writeMarker(["default-workflow:postCommit", ...hookIds]);

    // Read the task once for hook context. MUST be a non-locking read — this
    // runs inside `withTaskLock`, so `getTask` (which re-acquires the lock)
    // would deadlock. `readTaskFromDb` is the in-lock-safe read (backend mode:
    // raw readTaskRow + row conversion, same non-locking property).
    const pgRow = await readTaskRow(store.asyncLayer!, taskId, { includeDeleted: false });
    const taskDetail: TaskDetail | undefined = pgRow
      ? (store.rowToTask(store.pgRowToTaskRow(pgRow)) as unknown as TaskDetail)
      : undefined;

    const remaining = ["default-workflow:postCommit", ...hookIds];
    for (const { traitId, hookKind } of pending) {
      const resolved = registry.resolveTraitHook(traitId, hookKind);
      if (resolved.warning) {
        // Degraded (no impl / force-disabled) → passive no-op, audit the warning.
        void emitBoundedRunAudit(store, {
          taskId,
          agentId: "system",
          runId: `plugin-trait-hook-${traitId}-${taskId}-${Date.now()}`,
          domain: "database",
          mutationType: "plugin:trait-hook-degraded",
          target: taskId,
          metadata: { traitId, hookKind, reason: "no-impl", message: resolved.warning.message },
        });
      } else if (resolved.impl) {
        try {
          await resolved.impl({ task: taskDetail, context: { fromColumn, toColumn, hookKind } });
        } catch (err) {
          // A throwing plugin hook DEGRADES — audited, never wedges the lock.
          void emitBoundedRunAudit(store, {
            taskId,
            agentId: "system",
            runId: `plugin-trait-hook-${traitId}-${taskId}-${Date.now()}`,
            domain: "database",
            mutationType: "plugin:trait-hook-degraded",
            target: taskId,
            metadata: {
              traitId,
              hookKind,
              reason: "threw",
              error: err instanceof Error ? err.message : String(err),
            },
          });
        }
      }
      // Mark this hook complete in the marker (whether it ran, degraded, or threw).
      const idx = remaining.indexOf(`${traitId}:${hookKind}`);
      if (idx >= 0) remaining.splice(idx, 1);
      // Best-effort progress bookkeeping; the final clear is the backstop.
      await writeMarker(remaining);
    }
  }

/*
FNXC:PlanningDependencyReseed 2026-08-04-02:10:
Release gates can be evaluated by multiple schedulers. Claim the project/task
episode and append its diagnostic in one transaction so a crash cannot leave a
suppression marker without the operator-visible task-log entry.
*/
/**
 * FNXC:WorkspaceIntegration 2026-08-21-22:07:
 * Environment repair is one operator episode even when concurrent merge doors observe it.
 * The project/task advisory lock makes the log check and append atomic across engine, CLI, and UI.
 */
export async function logEntryOnceImpl(
  store: TaskStore,
  id: string,
  input: { action: string; outcome?: string; dedupeKey: string; windowMs: number },
): Promise<boolean> {
  const layer = store.asyncLayer!;
  const projectId = layer.projectId?.trim() || "__legacy_unscoped__";
  const now = new Date();
  const result = await layer.transactionImmediate(async (tx) => {
    await acquireTaskAdvisoryXactLock(tx, projectId, id);
    const rows = await tx.select().from(schema.project.tasks).where(and(
      eq(schema.project.tasks.projectId, projectId), eq(schema.project.tasks.id, id), isNull(schema.project.tasks.deletedAt),
    ));
    const current = rows[0];
    if (!current) throw new Error(`Task ${id} not found while logging episode`);
    const log = Array.isArray(current.log) ? [...current.log as TaskLogEntry[]] : [];
    const duplicate = log.some((entry) => entry.dedupeKey === input.dedupeKey
      && now.getTime() - Date.parse(entry.timestamp) < input.windowMs);
    if (duplicate) return { appended: false, row: current };
    log.push({ timestamp: now.toISOString(), action: input.action, outcome: truncateTaskLogOutcome(input.outcome), dedupeKey: input.dedupeKey });
    const limit = getTaskActivityLogEntryLimit();
    if (log.length > limit) log.splice(0, log.length - limit);
    const updated = await tx.update(schema.project.tasks).set({ log, updatedAt: now.toISOString() }).where(and(
      eq(schema.project.tasks.projectId, projectId), eq(schema.project.tasks.id, id),
    )).returning();
    return { appended: true, row: updated[0]! };
  });
  const task = store.rowToTask(store.pgRowToTaskRow(result.row as unknown as Record<string, unknown>));
  await store.writeTaskJsonFile(store.taskDir(id), task);
  if (store.isWatching) store.taskCache.set(id, { ...task });
  return result.appended;
}

export interface QueuedEpisodeTransition {
  /** Canonical complete blocker identity, e.g. dependency:FN-1,FN-2. */
  signature: string;
  blockedBy: string | null;
  overlapBlockedBy: string | null;
  action: string;
  outcome?: string;
  runContext?: RunMutationContext;
}

export interface QueuedEpisodeTransitionResult {
  appended: boolean;
  task: Task;
}

/*
FNXC:QueuedTaskLogging 2026-08-04-18:03:
Dependency and file-scope producers share this full-signature transition so queue activity is
edge-triggered across schedulers, executors, self-healing, and process restarts. Acquire the
project/task advisory transaction lock before reading or updating the row; atomically persist the
marker, queue fields, and sole log entry. A matching signature suppresses only an already queued
row with matching blocker fields, so recovery/non-queued state and any blocker-kind/full-set change
re-arm reporting. Do not call public TaskStore mutation methods in this transaction.
*/
export async function transitionQueuedEpisodeImpl(
  store: TaskStore,
  id: string,
  transition: QueuedEpisodeTransition,
): Promise<QueuedEpisodeTransitionResult> {
  const layer = store.asyncLayer!;
  const projectId = layer.projectId?.trim() || "__legacy_unscoped__";
  const now = new Date().toISOString();
  const result = await layer.transactionImmediate(async (tx) => {
    await acquireTaskAdvisoryXactLock(tx, projectId, id);
    const rows = await tx.select().from(schema.project.tasks).where(and(
      eq(schema.project.tasks.projectId, projectId),
      eq(schema.project.tasks.id, id),
      isNull(schema.project.tasks.deletedAt),
    ));
    const current = rows[0];
    if (!current) throw new Error(`Task ${id} not found or deleted while queuing`);

    const appended = !(
      current.status === "queued"
      && (current.blockedBy ?? null) === transition.blockedBy
      && (current.overlapBlockedBy ?? null) === transition.overlapBlockedBy
      && (current.queuedLogEpisodeSignature ?? null) === transition.signature
    );
    const log = Array.isArray(current.log) ? [...current.log as TaskLogEntry[]] : [];
    if (appended) {
      log.push({
        timestamp: now,
        action: transition.action,
        outcome: truncateTaskLogOutcome(transition.outcome),
        ...(transition.runContext ? { runContext: transition.runContext } : {}),
      });
      const limit = getTaskActivityLogEntryLimit();
      if (log.length > limit) log.splice(0, log.length - limit);
    }
    const updated = await tx.update(schema.project.tasks).set({
      status: "queued",
      blockedBy: transition.blockedBy,
      overlapBlockedBy: transition.overlapBlockedBy,
      queuedLogEpisodeSignature: transition.signature,
      ...(appended ? { log } : {}),
      updatedAt: now,
    }).where(and(
      eq(schema.project.tasks.projectId, projectId),
      eq(schema.project.tasks.id, id),
    )).returning();
    return { appended, task: updated[0]! };
  });
  const task = store.rowToTask(store.pgRowToTaskRow(result.task as unknown as Record<string, unknown>));
  await store.writeTaskJsonFile(store.taskDir(id), task);
  if (store.isWatching) store.taskCache.set(id, { ...task });
  store.emitTaskLifecycleEventSafely("task:updated", [task]);
  return { appended: result.appended, task };
}

export async function checkAndRecordUnplannedExecutionBlockImpl(
  store: TaskStore,
  id: string,
  episode: string,
): Promise<boolean> {
  const layer = store.asyncLayer!;
  const projectId = layer.projectId ?? "__legacy_unscoped__";
  const entry: TaskLogEntry = {
    timestamp: new Date().toISOString(),
    action: "Execution dispatch refused — task is still unplanned",
    outcome: "Waiting for planning lifecycle handoff or Plan Review continuation",
  };
  const recorded = await layer.transactionImmediate(async (tx) => {
    const claimed = await tx
      .insert(schema.project.unplannedExecutionBlocks)
      .values({ projectId, taskId: id, episode, createdAt: entry.timestamp })
      .onConflictDoNothing()
      .returning({ taskId: schema.project.unplannedExecutionBlocks.taskId });
    if (claimed.length === 0) return false;

    const rows = await tx.select({ log: schema.project.tasks.log, deletedAt: schema.project.tasks.deletedAt })
      .from(schema.project.tasks)
      .where(and(
        eq(schema.project.tasks.projectId, projectId),
        eq(schema.project.tasks.id, id),
        isNull(schema.project.tasks.deletedAt),
      ));
    const task = rows[0];
    if (!task) throw new Error(`Task ${id} not found or deleted while recording unplanned dispatch refusal`);
    const log = Array.isArray(task.log) ? [...task.log as TaskLogEntry[]] : [];
    log.push(entry);
    const limit = getTaskActivityLogEntryLimit();
    if (log.length > limit) log.splice(0, log.length - limit);
    await tx.update(schema.project.tasks)
      /*
       * FNXC:PlanningHandoffRecovery 2026-08-04-06:35:
       * This diagnostic must not make an old planning handoff look fresh to
       * recovery grace windows. The marker timestamp records audit recency.
       */
      .set({ log })
      .where(and(eq(schema.project.tasks.projectId, projectId), eq(schema.project.tasks.id, id)));
    return true;
  });
  return recorded;
}

export async function logEntryImpl(store: TaskStore, id: string, action: string, outcome?: string, runContext?: RunMutationContext): Promise<Task> {
    return store.withTaskLock(id, async () => {
      const entry: TaskLogEntry = {
        timestamp: new Date().toISOString(),
        action,
        outcome: truncateTaskLogOutcome(outcome),
      };
      if (runContext) {
        {
          const layer = store.asyncLayer!;
          const state = await getLiveTaskColumn(layer.db, id, layer.projectId, ARCHIVED_SENTINEL_LANES);
          /*
          FNXC:TaskArchiveRemoval 2026-09-04-18:25 DELIBERATE-LITERAL:
          `getLiveTaskColumn` returns `archived` only as the stable deleted/historical sentinel. It is
          not a workflow role, and logs remain read-only for that sentinel.
          */
          if (state === "archived") throw new Error(`Task ${id} is deleted or historical — logging is read-only`);
          if (state === null) throw new Error(`Task ${id} not found`);
        }

        const dir = store.taskDir(id);
        const task = await store.readTaskJson(dir);

        // Initialize log array if missing (for legacy tasks)
        if (!task.log) {
          task.log = [];
        }

        entry.runContext = runContext;
        task.log.push(entry);
        const _entryLimit = getTaskActivityLogEntryLimit();
        if (task.log.length > _entryLimit) {
          task.log.splice(0, task.log.length - _entryLimit);
        }
        task.updatedAt = new Date().toISOString();

        // When runContext is provided, record audit event atomically with task mutation.
        await store.atomicWriteTaskJsonWithAudit(dir, task, {
          taskId: task.id,
          agentId: runContext.agentId,
          runId: runContext.runId,
          domain: "database",
          mutationType: "task:log",
          target: task.id,
          metadata: { action, outcome },
        });

        if (store.isWatching) store.taskCache.set(id, { ...task });
        store.emit("task:updated", task);
        return task;
      }

      // Fast path for high-volume log entries: update only the log + updatedAt fields
      // instead of reading/writing the entire task payload on every append.
      //
      // FNXC:SqliteFinalRemoval 2026-06-25-23:05:
      // Backend mode: read the task row via async Drizzle, append the log entry,
      // and write back only the log + updatedAt columns. This avoids the
      // sync this.db.prepare() path which throws "SQLite Database is not
      // available in backend mode" (discovered by sqlite-final-removal session 3).
            const layer = store.asyncLayer!;
      const pgRow = await readTaskRow(layer, id, { includeDeleted: true });
      if (!pgRow) {
        throw new Error(`Task ${id} not found`);
      }
      /*
      FNXC:TaskArchiveRemoval 2026-09-04-18:25 DELIBERATE-LITERAL:
      Log mutation rejects the fixed historical sentinel and soft-deleted rows. Archive is not a
      workflow role; keeping the property comparison in the fallback preserves SQL/TypeScript parity
      for migration-era data.
      */
      const historicalSentinels = ARCHIVED_SENTINEL_LANES;
      const rowIsHistoricalSentinel = historicalSentinels
        ? historicalSentinels.has(String(pgRow.column ?? ""))
        /* DELIBERATE-LITERAL — migration fallback for callers without sentinel metadata. */
        : pgRow.column === "archived";
      if (rowIsHistoricalSentinel || pgRow.deletedAt != null) {
        throw new Error(`Task ${id} is deleted or historical — logging is read-only`);
      }
      // PG jsonb columns arrive already-parsed; convert to the TaskLogEntry[] shape.
      const existingLog = Array.isArray(pgRow.log) ? (pgRow.log as TaskLogEntry[]) : [];
      existingLog.push(entry);
      const _entryLimit = getTaskActivityLogEntryLimit();
      if (existingLog.length > _entryLimit) {
        existingLog.splice(0, existingLog.length - _entryLimit);
      }
      const updatedAt = new Date().toISOString();
      await updateTaskColumns(layer, id, { log: existingLog, updatedAt });

      // Re-read the task for event emission (full row → Task).
      const updatedRow = await readTaskRow(layer, id, { includeDeleted: false });
      if (updatedRow) {
        const current = store.rowToTask(store.pgRowToTaskRow(updatedRow));
        await store.writeTaskJsonFile(store.taskDir(id), current);
        if (store.isWatching) {
          store.taskCache.set(id, { ...current });
        }
        store.emitTaskLifecycleEventSafely("task:updated", [current]);
        return current;
      }
      const emittedTask = ({ id, log: existingLog, updatedAt } as unknown) as Task;
      store.emitTaskLifecycleEventSafely("task:updated", [emittedTask]);
      return emittedTask;
});
  }
