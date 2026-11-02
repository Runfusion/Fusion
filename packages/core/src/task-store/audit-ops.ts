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
import {__setTaskActivityLogLimitsForTesting, truncateTaskLogOutcome} from "../task-store/comments.js";
import {readTaskRow} from "../task-store/async/async-persistence.js";
/*
FNXC:TaskLogSideTable 2026-11-01-18:08 (RUFU-312):
Every log seam in this file routes its ENTRIES through this module. A seam that also mutates task fields
keeps writing its own columns and stops writing `log`; a seam whose only task-column write was the log
array stops writing the task row entirely. Nothing here may author `log` without also handing the same
entries to `appendTaskLogEntries`, which is what keeps `task_log_rollup` the complete envelope author.
*/
import {
  appendTaskLogEntries,
  hasTaskLogEntryWithinWindow,
  hydrateTaskLogEntries,
  taskLogProjectId,
} from "./task-log-entries.js";
import { getLiveTaskColumn } from "./async/async-comments-attachments.js";
import { acquireTaskAdvisoryXactLock } from "./task-advisory-lock.js";
import { ARCHIVED_SENTINEL_LANES } from "../project-lane-vocabulary.js";
import { buildTaskLogReadOnlyMessage, buildTaskNotFoundMessage } from "./task-log-write-refusal.js";
import { recordRunAuditEventWithinTransaction } from "../postgres/data-layer.js";
import * as schema from "../postgres/schema/index.js";
import { observeOverlapWaitTransitionInTransaction } from "./overlap-wait-ops.js";

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
  const projectId = taskLogProjectId(layer);
  const now = new Date();
  const result = await layer.transactionImmediate(async (tx) => {
    await acquireTaskAdvisoryXactLock(tx, projectId, id);
    /*
    FNXC:TaskLogSideTable 2026-11-01-18:00 (RUFU-312):
    The dedupe probe used to materialize the whole task row and scan its jsonb array (one card measured
    3.99 MB of `log`) to answer "did this key already fire inside the window?". It is now an indexed
    lookup over the entries that carry that key, and the append itself is one INSERT: the suppressed answer
    RUFU-643 made cheap stays cheap, and the appended answer stops rewriting the card.
    */
    const duplicate = await hasTaskLogEntryWithinWindow(tx, projectId, id, input.dedupeKey, input.windowMs, now.getTime());
    if (duplicate) return { appended: false };
    /*
    FNXC:TaskLogSideTable 2026-11-01-18:05 (RUFU-312):
    Existence is now proved by the narrow lane probe rather than by the whole-row SELECT this seam used to
    need for its log array, so the refusal keeps its exact message while costing one indexed column read.
    The side-table foreign key would also refuse the insert, but with a constraint error nobody reads.
    */
    const state = await getLiveTaskColumn(tx, id, layer.projectId, ARCHIVED_SENTINEL_LANES);
    if (state === null) throw new Error(`Task ${id} not found while logging episode`);
    const appended = await appendTaskLogEntries({
      client: tx,
      projectId,
      taskId: id,
      entries: [{
        timestamp: now.toISOString(),
        action: input.action,
        outcome: truncateTaskLogOutcome(input.outcome),
        dedupeKey: input.dedupeKey,
      }],
    });
    return { appended: appended.appendedCount > 0 };
  });
  /*
  FNXC:DiagnosticLogDedupe 2026-10-11-22:51 (RUFU-643):
  A suppressed append used to finish by materializing the row it had just read: `rowToTask` over the
  whole record (the JSONB log column plus its stringified fields — the double parse the heap profile
  measures as `at p.rowToTask <- fromJson`), a full `task.json` mirror rewrite, and a cache copy. The
  caller only ever consumed the boolean, so every suppressed diagnostic paid the card's full byte cost
  to record nothing — and one card measured 3.99 MB of `log`. Returning the decision alone makes "the
  repeat was suppressed" cost one indexed SELECT instead of one whole-card materialization, which is the
  point of the seam. The appended arm is unchanged: the mirror and cache must still follow the write.
  */
  if (!result.appended) return false;
  /*
  FNXC:TaskLogSideTable 2026-11-01-18:05 (RUFU-312):
  The appended arm still owes the mirror and the cache copy (RUFU-643 kept that duty deliberately), but it
  no longer receives the row from the write — the write touched no row — so it reads the card once and
  hydrates `log` from the side table, exactly as `getTask` will answer on the next read.
  */
  const pgRow = await readTaskRow(layer, id, { includeDeleted: true });
  if (!pgRow) return true;
  const task = store.rowToTask(store.pgRowToTaskRow(pgRow as unknown as Record<string, unknown>));
  task.log = await hydrateTaskLogEntries({
    client: layer.db,
    projectId,
    taskId: id,
    legacyLog: Array.isArray(pgRow.log) ? (pgRow.log as TaskLogEntry[]) : [],
  });
  await store.writeTaskJsonFile(store.taskDir(id), task);
  if (store.isWatching) store.taskCache.set(id, { ...task });
  return true;
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
    /*
    FNXC:OverlapWaitSynchronization 2026-09-17-00:10:
    A queued-episode transition is exactly where `task.overlapBlockedBy` changes (set/replaced/
    cleared). Persist both the outgoing and incoming blocker edges into the durable wait table in
    this same transaction so a marker overwrite can never silently drop synchronization evidence.

    FNXC:MergeRebuild0919 2026-09-19-21:45:
    Kept on our line's shape: this call passes `newLeaseObservation: true`, which canonical lacks.
    That flag is what re-arms an episode Reset already stamped (see
    `FNXC:OverlapWaitRelease 2026-09-17-06:38` in overlap-wait-ops.ts), so a restarted predecessor
    behind an unconsumed Reset stamp is treated as a new wait instead of a no-op.
    */
    const currentTask = store.rowToTask(store.pgRowToTaskRow(current as unknown as Record<string, unknown>));
    await observeOverlapWaitTransitionInTransaction(tx, {
      projectId,
      previous: currentTask,
      nextOverlapBlockedBy: transition.overlapBlockedBy,
      observedAt: now,
      newLeaseObservation: true,
    });
    const log = Array.isArray(current.log) ? [...current.log as TaskLogEntry[]] : [];
    const queuedEntry: TaskLogEntry | null = appended ? {
      timestamp: now,
      action: transition.action,
      outcome: truncateTaskLogOutcome(transition.outcome),
      ...(transition.runContext ? { runContext: transition.runContext } : {}),
    } : null;
    if (queuedEntry) log.push(queuedEntry);
    /*
    FNXC:TaskLogSideTable 2026-11-01-18:10 (RUFU-312):
    This transition's task-row write carries queue state (status, blockers, episode signature) and always
    rewrites the row, so it keeps that write — but the log entry leaves with it. The queue edge is the
    mutation; the log line is a passenger, and a passenger may not make a card pay a fresh copy of its own
    history. In the same transaction, so the entry and the state it describes commit together.
    */
    const updated = await tx.update(schema.project.tasks).set({
      status: "queued",
      blockedBy: transition.blockedBy,
      overlapBlockedBy: transition.overlapBlockedBy,
      queuedLogEpisodeSignature: transition.signature,
      updatedAt: now,
    }).where(and(
      eq(schema.project.tasks.projectId, projectId),
      eq(schema.project.tasks.id, id),
    )).returning();
    if (queuedEntry) {
      await appendTaskLogEntries({
        client: tx,
        projectId,
        taskId: id,
        entries: [queuedEntry],
        legacyLog: log,
      });
    }
    return { appended, task: updated[0]!, entry: queuedEntry };
  });
  const task = store.rowToTask(store.pgRowToTaskRow(result.task as unknown as Record<string, unknown>));
  /*
  FNXC:TaskLogSideTable 2026-11-01-18:12 (RUFU-312):
  The row this write returned predates the entry by construction, so the mirror and the `task:updated`
  payload carry the merged log — the same answer `getTask` gives a reader that asks immediately after.
  */
  task.log = await hydrateTaskLogEntries({
    client: store.asyncLayer!.db,
    projectId,
    taskId: id,
    legacyLog: Array.isArray((result.task as unknown as Record<string, unknown>).log) ? ((result.task as unknown as Record<string, unknown>).log as TaskLogEntry[]) : [],
  });
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
  const projectId = taskLogProjectId(layer);
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
    /*
    FNXC:TaskLogSideTable 2026-11-01-18:12 (RUFU-312):
    The row read above exists only to prove the card is live — it used to be read *because* its log array
    was about to be rewritten, and this diagnostic (FNXC:PlanningHandoffRecovery 2026-08-04-06:35) must not
    make an old planning handoff look fresh to recovery grace windows. The claim row keeps carrying the
    episode timestamp, and the entry now goes to the side table in the same transaction, so the task row is
    untouched by this refusal at all.
    */
    await appendTaskLogEntries({
      client: tx,
      projectId,
      taskId: id,
      entries: [entry],
      legacyLog: Array.isArray(task.log) ? (task.log as TaskLogEntry[]) : [],
    });
    return true;
  });
  return recorded;
}

export async function logEntryImpl(store: TaskStore, id: string, action: string, outcome?: string, runContext?: RunMutationContext): Promise<Task> {
    return store.withTaskLock(id, async () => {
      const layer = store.asyncLayer!;
      const projectId = taskLogProjectId(layer);
      const entry: TaskLogEntry = {
        timestamp: new Date().toISOString(),
        action,
        outcome: truncateTaskLogOutcome(outcome),
      };
      /*
      FNXC:TaskLogSideTable 2026-11-01-17:58 (RUFU-312):
      THE APPEND ARM. Both arms used to end in a `tasks` write — the plain one via `updateTaskColumns`
      (log + `updated_at`), the `runContext` one via a whole-row atomic write — so every diagnostic line
      rewrote the card's ~28 KB row version, produced a fresh TOAST chunk for the grown jsonb array and
      re-maintained all 16 indexes. Measured consequence: 25 MB of 55 MB live-row bytes sat in this one
      column and the heap reached 4 609 MB. The entry now goes to `project.task_log_entries` and the task
      row is not written at all: no log column, no `updated_at` (bumping it "for ordering" would put the
      rewrite straight back, and `seq` is what orders entries), no derived-column pairing — the envelope
      `appendTaskLogEntries` authors into `task_log_rollup` replaces that.

      Everything a caller could observe OTHER than the row's bytes is preserved on purpose: the same two
      refusals, the mirror write, the cache copy, the `task:updated` emission (a board that shows new
      History must still be told to look), and a returned Task whose `log` carries the new entry.
      */
      if (runContext) {
        const state = await getLiveTaskColumn(layer.db, id, layer.projectId, ARCHIVED_SENTINEL_LANES);
        /*
        FNXC:TaskArchiveRemoval 2026-09-04-18:25 DELIBERATE-LITERAL:
        `getLiveTaskColumn` returns `archived` only as the stable deleted/historical sentinel. It is
        not a workflow role, and logs remain read-only for that sentinel; the shared helper owns its literal.
        */
        if (state === "archived") throw new Error(buildTaskLogReadOnlyMessage(id));
        if (state === null) throw new Error(buildTaskNotFoundMessage(id));
      }

      const pgRow = await readTaskRow(layer, id, { includeDeleted: true });
      if (!pgRow) {
        throw new Error(buildTaskNotFoundMessage(id));
      }
      /*
      FNXC:TaskArchiveRemoval 2026-09-04-18:25 DELIBERATE-LITERAL:
      Log mutation rejects the fixed historical sentinel and soft-deleted rows. Archive is not a
      workflow role; the shared helper owns the refusal literal while this comparison preserves SQL/TypeScript parity
      for migration-era data.
      */
      const historicalSentinels = ARCHIVED_SENTINEL_LANES;
      const rowIsHistoricalSentinel = historicalSentinels
        ? historicalSentinels.has(String(pgRow.column ?? ""))
        /* DELIBERATE-LITERAL — migration fallback for callers without sentinel metadata. */
        : pgRow.column === "archived";
      if (!runContext && (rowIsHistoricalSentinel || pgRow.deletedAt != null)) {
        throw new Error(buildTaskLogReadOnlyMessage(id));
      }
      // PG jsonb columns arrive already-parsed; this is the legacy half of the merged read.
      const legacyLog = Array.isArray(pgRow.log) ? (pgRow.log as TaskLogEntry[]) : [];
      if (runContext) entry.runContext = runContext;

      if (runContext) {
        // The `task:log` audit row stays transactional with the mutation it describes — the mutation is
        // now the side-table insert, so the audit write rides the same transaction handle.
        await layer.transactionImmediate(async (tx) => {
          await appendTaskLogEntries({ client: tx, projectId, taskId: id, entries: [entry], legacyLog });
          await recordRunAuditEventWithinTransaction(tx, {
            taskId: id,
            agentId: runContext.agentId,
            runId: runContext.runId,
            domain: "database",
            mutationType: "task:log",
            target: id,
            metadata: { action, outcome },
          });
        });
      } else {
        await appendTaskLogEntries({ client: layer.db, projectId, taskId: id, entries: [entry], legacyLog });
      }

      // The row in hand predates the append, so the emitted/mirrored Task carries the merged view.
      const task = store.rowToTask(store.pgRowToTaskRow(pgRow as unknown as Record<string, unknown>));
      task.log = await hydrateTaskLogEntries({
        client: layer.db,
        projectId,
        taskId: id,
        legacyLog,
      });
      await store.writeTaskJsonFile(store.taskDir(id), task);
      if (store.isWatching) {
        store.taskCache.set(id, { ...task });
      }
      if (runContext) store.emit("task:updated", task);
      else store.emitTaskLifecycleEventSafely("task:updated", [task]);
      return task;
});
  }
