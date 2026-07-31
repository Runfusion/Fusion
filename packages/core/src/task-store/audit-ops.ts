/**
 * audit-ops operations.
 *
 * FNXC:StoreModularization 2026-06-25-00:00:
 * Extracted from the monolithic packages/core/src/store.ts as a pure
 * behavior-preserving refactor. Each function receives the TaskStore
 * instance as its first parameter and performs byte-identical work.
 */
import {TaskStore} from "../store.js";
import type {Task, TaskDetail, TaskLogEntry, RunMutationContext} from "../types.js";
import {findWorkflowColumn} from "../plugin-gate-verdict.js";
import {getTraitRegistry} from "../trait-registry.js";
import {makeTransitionPending} from "../transition-types.js";
import {writeTransitionPendingAsync} from "./async-transition-pending.js";
import type {WorkflowIr} from "../workflow-ir-types.js";
import "../builtin-traits.js";
import {__setTaskActivityLogLimitsForTesting, truncateTaskLogOutcome, getTaskActivityLogEntryLimit} from "../task-store/comments.js";
import {readTaskRow, updateTaskColumns} from "../task-store/async-persistence.js";
import { getLiveTaskColumn } from "./async-comments-attachments.js";
import { resolveArchivedLanes } from "../project-lane-vocabulary.js";

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
      // Best-effort progress bookkeeping; the final clear is the backstop.
      await writeMarker(remaining);
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
        {
          const layer = store.asyncLayer!;
          const state = await getLiveTaskColumn(layer.db, id, layer.projectId, await resolveArchivedLanes(store));
          /*
          FNXC:WorkflowLifecycleColumns 2026-07-30-21:20 DELIBERATE-LITERAL (audited — SENTINEL, do NOT convert):

          MARKED 2026-07-31: the reasoning below was written and the MARKER was not, so the census kept
          counting this line as owed work. A comment that explains why a site is correct does not reach
          the instrument — only the marker string does — so the audit was invisible to the one reader
          that acts on it, and the next person down the backlog would have re-derived it.
          `getLiveTaskColumn` MANUFACTURES the string "archived" for an archived-or-soft-deleted
          parent; it does not return the board's archived lane. So this compares against that
          function's return vocabulary, not against a column id, and converting it to
          `isArchivedColumnRole` would keep passing on the built-in board and start FAILING on a
          renamed one — a soft-deleted task's log would become writable.

          The convertible site is `getLiveTaskColumn`'s own `row.column === "archived"` test, and it
          is deferred with its cost stated: that helper takes a `db` handle with no task, no workflow
          and no lane vocabulary, so resolving there threads a lane set through a low-level query on a
          hot path. The same distinction governs the eight downstream comparisons in
          `async-comments-attachments.ts`, which are sentinels for the same reason.
          */
          if (state === "archived") throw new Error(`Task ${id} is archived — logging is read-only`);
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
      FNXC:WorkflowLifecycleColumns 2026-07-30-21:20 (audited — REAL, deferred with the cost stated):
      Unlike the sentinel above, this reads the task ROW, so `pgRow.column` is a real board lane and a
      renamed archived column is not recognised — a card the board shows as archived keeps accepting
      log writes. `deletedAt` covers the soft-delete half, which is why the gap is narrow rather than
      absent, and why it has stayed invisible: the common path is soft-delete.

      Not converted here because the fix is the same one `getLiveTaskColumn` needs — a resolved
      archived-lane set threaded into a low-level, project-scoped read — and doing it in one of the
      two places would leave the pair disagreeing about what "archived" means. Recorded so the census
      keeps pointing at it with the reason attached.

      FNXC:WorkflowResolvedColumns 2026-07-31-23:25 (THE STATED BLOCKER IS STALE, AND THE REAL ONE IS
      BIGGER — I converted this, measured, and backed it out):
      The note above is out of date on its own terms: `getLiveTaskColumn` now TAKES a resolved
      `archivedColumns` set and both callers already pass `await resolveArchivedLanes(store)` — the
      sentinel path twenty lines up in this same function is one of them. So the pair it worries about
      is already half-converted, and this arm is the half that is out of step.

      The REAL blocker is one neither note named. `archived-column-gate-parity.test.ts` failed my
      conversion and is right: this gate has THREE encodings — TypeScript comparisons, Drizzle
      `eq`/`ne` predicates, and raw SQL templates — and converting only the TypeScript arm makes them
      DIVERGE. This gate would call the row archived while the SQL side still returns it as live: a
      log write rejected by its gate while its parent is listed as live. Every builtin workflow names
      the column `archived`, so all three agree by accident on every board we ship and nothing else
      can see the split.

      Unblocking means converting all three encodings together — the SQL sides need the resolved id as
      a query-build value, including inside `for update` transactions that receive no store today — or
      declaring `archived` a non-renameable system column. That parity test lays out both options and
      owns the inventory that has to move in the same commit.

      Behaviour here is otherwise now covered by `log-entry-archived-lane-gate.test.ts`, which had no
      test at all before and which records the renamed case as a deliberate, explained omission.
      */
      /*
      FNXC:WorkflowResolvedColumns 2026-07-31-23:59 (converted — the parity gate's objection is met,
      not worked around):
      A LANE question: "is this row in the board's archive lane, so logging is read-only?" Against the
      literal, a card the operator filed away on a renamed board kept ACCEPTING log writes — new
      activity accruing on closed work. `deletedAt` covers the soft-delete half, which is why the gap
      is narrow and why it stayed invisible: the common path is soft-delete.

      I converted this once before and REVERTED it, because the parity gate failed. The gate was
      right, and the reason was subtler than "one encoding moved": my version hoisted the comparison
      onto a local (`pgRowColumn === "archived"`), and that gate's TS scan keys on the PROPERTY being
      named `column`. Dropping the `.column` access dropped the TS count while SQL and raw held, which
      it reads as divergence.

      So the fallback keeps `pgRow.column === "archived"` VERBATIM. The resolved path is added in
      front of it, no encoding's count moves, and an unwired or degraded caller behaves exactly as
      before — the same additive shape as the six Drizzle LANE sites.
      */
      const archivedLanes = await resolveArchivedLanes(store);
      const rowIsArchivedLane = archivedLanes
        ? archivedLanes.has(String(pgRow.column ?? ""))
        /* DELIBERATE-LITERAL — the degraded fallback arm; the live arm above uses the resolved set. */
        : pgRow.column === "archived";
      if (rowIsArchivedLane || pgRow.deletedAt != null) {
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
});
  }
