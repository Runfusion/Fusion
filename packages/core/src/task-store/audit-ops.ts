/**
 * audit-ops operations.
 *
 * FNXC:StoreModularization 2026-06-25-00:00:
 * Extracted from the monolithic packages/core/src/store.ts as a pure
 * behavior-preserving refactor. Each function receives the TaskStore
 * instance as its first parameter and performs byte-identical work.
 */
import {TaskStore} from "../store.js";
import type {Task, TaskDetail, Column, TaskLogEntry, RunMutationContext} from "../types.js";
import {findWorkflowColumn} from "../plugin-gate-verdict.js";
import {getTraitRegistry} from "../trait-registry.js";
import {makeTransitionPending} from "../transition-types.js";
import {writeTransitionPending} from "../transition-pending.js";
import type {WorkflowIr} from "../workflow-ir-types.js";
import "../builtin-traits.js";
import {toJson, fromJson} from "../db.js";
import {__setTaskActivityLogLimitsForTesting, truncateTaskLogOutcome, getTaskActivityLogEntryLimit} from "../task-store/comments.js";
import {readTaskRow, updateTaskColumns} from "../task-store/async-persistence.js";
import { getLiveTaskColumn } from "./async-comments-attachments.js";

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
    try {
      writeTransitionPending(
        store.db,
        taskId,
        makeTransitionPending(toColumn, ["default-workflow:postCommit", ...hookIds], startedAt),
      );
    } catch {
      // Marker bookkeeping is best-effort; proceed to run the hooks regardless.
    }

    // Read the task once for hook context. MUST be a non-locking read — this
    // runs inside `withTaskLock`, so `getTask` (which re-acquires the lock)
    // would deadlock. `readTaskFromDb` is the in-lock-safe read.
    const taskRow = store.readTaskFromDb(taskId, { includeDeleted: false });
    const taskDetail = taskRow as unknown as TaskDetail | undefined;

    const remaining = ["default-workflow:postCommit", ...hookIds];
    for (const { traitId, hookKind } of pending) {
      const resolved = registry.resolveTraitHook(traitId, hookKind);
      if (resolved.warning) {
        // Degraded (no impl / force-disabled) → passive no-op, audit the warning.
        void store.recordRunAuditEvent({
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
          void store.recordRunAuditEvent({
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
      try {
        writeTransitionPending(store.db, taskId, makeTransitionPending(toColumn, remaining, startedAt));
      } catch {
        // Best-effort progress bookkeeping; the final clear is the backstop.
      }
    }
  }

export async function logEntryImpl(store: TaskStore, id: string, action: string, outcome?: string, runContext?: RunMutationContext): Promise<Task> {
    return store.withTaskLock(id, async () => {
      const entry: TaskLogEntry = {
        timestamp: new Date().toISOString(),
        action,
        outcome: truncateTaskLogOutcome(outcome),
      };
      if (runContext) {
        if (store.backendMode) {
          const layer = store.asyncLayer!;
          const state = await getLiveTaskColumn(layer.db, id, layer.projectId);
          if (state === "archived") throw new Error(`Task ${id} is archived — logging is read-only`);
          if (state === null) throw new Error(`Task ${id} not found`);
        }
        if (store.isTaskArchived(id)) {
          throw new Error(`Task ${id} is archived — logging is read-only`);
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
      if (store.backendMode) {
        const layer = store.asyncLayer!;
        const pgRow = await readTaskRow(layer, id, { includeDeleted: true });
        if (!pgRow) {
          throw new Error(`Task ${id} not found`);
        }
        if (pgRow.column === "archived" || pgRow.deletedAt != null) {
          throw new Error(`Task ${id} is archived — logging is read-only`);
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
      }

      const row = store.db.prepare(`SELECT log, "column" FROM tasks WHERE id = ? AND ${TaskStore.ACTIVE_TASKS_WHERE}`).get(id) as
        | { log: string | null; column: Column }
        | undefined;
      if (!row) {
        if (store.isTaskArchived(id)) {
          throw new Error(`Task ${id} is archived — logging is read-only`);
        }
        throw new Error(`Task ${id} not found`);
      }

      if (row.column === "archived") {
        throw new Error(`Task ${id} is archived — logging is read-only`);
      }

      const log = fromJson<TaskLogEntry[]>(row.log) || [];
      log.push(entry);
      const _entryLimit = getTaskActivityLogEntryLimit();
      if (log.length > _entryLimit) {
        log.splice(0, log.length - _entryLimit);
      }
      const updatedAt = new Date().toISOString();

      store.db.prepare("UPDATE tasks SET log = ?, updatedAt = ? WHERE id = ?").run(toJson(log), updatedAt, id);
      store.db.bumpLastModified();

      const current = store.readTaskFromDb(id);
      if (current) {
        await store.writeTaskJsonFile(store.taskDir(id), current);
        if (store.isWatching) {
          store.taskCache.set(id, { ...current });
        }
        store.emitTaskLifecycleEventSafely("task:updated", [current]);
        return current;
      }

      const emittedTask = ({ id, log, updatedAt } as unknown) as Task;
      store.emitTaskLifecycleEventSafely("task:updated", [emittedTask]);
      return emittedTask;
    });
  }
