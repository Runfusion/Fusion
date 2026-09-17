import { and, eq, isNull, sql } from "drizzle-orm";
import type { TaskStore } from "../store.js";
import type { Task, TaskOverlapWait } from "../types.js";
import type { WorkflowIr } from "../workflows/workflow-ir-types.js";
import * as schema from "../postgres/schema/index.js";
import { resolveTaskLifecycleColumns } from "../workflows/workflow-lifecycle-traits.js";
import { acquireTaskAdvisoryXactLock } from "./task-advisory-lock.js";
import { readTaskRowInTransaction } from "./async/async-persistence.js";
import { getTaskActivityLogEntryLimit } from "./comments.js";
import { hasConcreteOverlapDelivery, observedOverlapDeliveries, overlapDeliverySnapshots, overlapPredecessorRelease, isRecoverableOverlapWaitFailure } from "../tasks/overlap-wait-release.js";

export interface OverlapWaitReconciliationOptions {
  /** Synchronous engine liveness/policy check, repeated against the transaction's current task. */
  resumeIf?: (task: Task) => boolean;
}
export interface OverlapWaitReconciliationResult {
  cancelledCount: number;
  clearedBlockerIds: string[];
  resumed: boolean;
}

/*
FNXC:OverlapWaitRelease 2026-09-17-06:29:
Startup, periodic healing and every execution entry use this same reconciliation. A terminal/reset
predecessor with no delivered files is not missing evidence: its old execution has ended. Cancel only
that obligation, retaining every actual delivery for the existing Git freshness gate. Clear display
markers independently of delivery consumption. Resume ONLY missing-delivery or superseded-owner failures, in place,
without resetting steps, reviews, branches or worktrees; user pauses and live continuations always win.
*/
export async function reconcileTaskOverlapWaitsImpl(
  store: TaskStore,
  taskId: string,
  options: OverlapWaitReconciliationOptions = {},
): Promise<OverlapWaitReconciliationResult> {
  const layer = store.asyncLayer;
  if (!layer) throw new Error("Overlap reconciliation requires a PostgreSQL store");
  const projectId = layer.projectId?.trim() || "__legacy_unscoped__";
  const observed = await store.listTaskOverlapWaits(taskId);
  const initial = await store.getTask(taskId);
  const refs = new Set([taskId, ...observed.map((episode) => episode.blockerTaskId), ...[initial.overlapBlockedBy, initial.blockedBy].filter((id): id is string => Boolean(id))]);
  const completeById = new Map<string, Set<string>>();
  const irCache = new Map<string, WorkflowIr>();
  for (const id of refs) {
    const lanes = await resolveTaskLifecycleColumns(store, id, irCache);
    completeById.set(id, new Set(lanes?.complete ? [lanes.complete] : []));
  }
  const outcome = await layer.transactionImmediate(async (tx) => {
    await acquireTaskAdvisoryXactLock(tx, projectId, taskId);
    const raw = await readTaskRowInTransaction(tx, taskId, { includeDeleted: true }, projectId);
    const result: OverlapWaitReconciliationResult = { cancelledCount: 0, clearedBlockerIds: [], resumed: false };
    if (!raw || raw.deletedAt) return { result };
    const current = store.rowToTask(store.pgRowToTaskRow(raw));
    const rows = await tx.select().from(schema.project.taskOverlapWaits).where(and(
      eq(schema.project.taskOverlapWaits.projectId, projectId), eq(schema.project.taskOverlapWaits.taskId, taskId),
    )).orderBy(schema.project.taskOverlapWaits.observedAt);
    const blockerIds = new Set([...rows.map((row) => row.blockerTaskId), ...[current.overlapBlockedBy, current.blockedBy].filter((id): id is string => Boolean(id))]);
    const blockers = new Map<string, Task | undefined>();
    for (const id of blockerIds) {
      const row = await readTaskRowInTransaction(tx, id, { includeDeleted: true }, projectId);
      blockers.set(id, row ? store.rowToTask(store.pgRowToTaskRow(row)) : undefined);
    }
    const released = new Map<string, string>();
    let unresolved = false;
    const now = new Date().toISOString();
    for (const row of rows) {
      const episode = { ...row, observation: row.observation ?? {} } as TaskOverlapWait;
      const blocker = blockers.get(row.blockerTaskId);
      const reason = overlapPredecessorRelease(episode, blocker, completeById.get(row.blockerTaskId) ?? new Set());
      if (reason) released.set(row.blockerTaskId, reason);
      else released.delete(row.blockerTaskId);
      if (row.phase === "cancelled" || row.phase === "delivered" || row.phase === "ready") continue;
      const captured = observedOverlapDeliveries(episode);
      // A later execution of a Reset predecessor must not be substituted for the discarded one.
      const deliveries = captured.length ? captured : blocker && reason !== "reset" ? overlapDeliverySnapshots(blocker) : [];
      const concrete = deliveries.some(hasConcreteOverlapDelivery);
      // FNXC:OverlapWaitRelease 2026-09-17-06:38: Legacy receipts can contain delivery proof absent from observations. Keep that obligation fail-closed: aggregated proofs lack predecessor identity, so neither cancel nor fabricate an attributed snapshot.
      const receiptHasDelivery = episode.receipt?.deliveryProofs?.some((proof) => proof.landedSha || Array.isArray(proof.landedFiles) || proof.noOp);
      if (reason && !concrete && !receiptHasDelivery) {
        const updated = await tx.update(schema.project.taskOverlapWaits).set({
          phase: "cancelled", owner: null, checkoutEpoch: null, revision: row.revision + 1,
          observation: { ...episode.observation, releaseReason: reason }, updatedAt: now,
        }).where(and(eq(schema.project.taskOverlapWaits.projectId, projectId), eq(schema.project.taskOverlapWaits.taskId, taskId),
          eq(schema.project.taskOverlapWaits.episodeId, row.episodeId), eq(schema.project.taskOverlapWaits.revision, row.revision))).returning();
        if (updated.length) result.cancelledCount++;
        else unresolved = true;
      } else {
        if (!concrete || deliveries.some((delivery) => !hasConcreteOverlapDelivery(delivery)
          || (delivery.evidence === "unavailable" && !delivery.landedSha))) unresolved = true;
        if (!captured.length && concrete) {
          const updated = await tx.update(schema.project.taskOverlapWaits).set({
            observation: { ...episode.observation, deliveries }, revision: row.revision + 1, updatedAt: now,
          }).where(and(eq(schema.project.taskOverlapWaits.projectId, projectId), eq(schema.project.taskOverlapWaits.taskId, taskId),
            eq(schema.project.taskOverlapWaits.episodeId, row.episodeId), eq(schema.project.taskOverlapWaits.revision, row.revision))).returning();
          if (!updated.length) unresolved = true;
        }
      }
    }
    const ownComplete = completeById.get(taskId)?.has(current.column) === true;
    const values: Partial<typeof schema.project.tasks.$inferInsert> = {};
    for (const key of ["overlapBlockedBy", "blockedBy"] as const) {
      const id = current[key];
      if (!id) continue;
      const blocker = blockers.get(id);
      const reason = released.get(id) ?? overlapPredecessorRelease({ observedAt: now }, blocker, completeById.get(id) ?? new Set());
      // A declared dependency on a reset task is still real work, not a file-scope lease.
      if (ownComplete || (reason && !(key === "blockedBy" && reason === "reset" && current.dependencies?.includes(id)))) {
        values[key] = null;
        if (!result.clearedBlockerIds.includes(id)) result.clearedBlockerIds.push(id);
      }
    }
    const overlapRemains = values.overlapBlockedBy === null ? null : current.overlapBlockedBy;
    const blockedRemains = values.blockedBy === null ? null : current.blockedBy;
    if (result.clearedBlockerIds.length && current.status === "queued" && !overlapRemains && !blockedRemains && !current.paused && !current.userPaused) values.status = null;
    if (rows.length && !unresolved && !ownComplete && current.status === "failed" && isRecoverableOverlapWaitFailure(current.error)
      && !current.paused && !current.userPaused && !current.externalBlock && options.resumeIf?.(current)) {
      const active = await tx.select({ id: schema.project.workflowWorkItems.id }).from(schema.project.workflowWorkItems).where(and(
        eq(schema.project.workflowWorkItems.projectId, projectId), eq(schema.project.workflowWorkItems.taskId, taskId),
        sql`${schema.project.workflowWorkItems.state} IN ('runnable', 'running', 'held', 'retrying')`,
      )).limit(1);
      if (!active.length) {
        values.status = null;
        values.error = null;
        result.resumed = true;
      }
    }
    if (!Object.keys(values).length) return { result };
    const log = [...(current.log ?? []), { timestamp: now, action: result.resumed
      ? "Overlap predecessor reconciled — resuming execution in place"
      : "Cleared obsolete overlap/dependency indicators", outcome: [...new Set(result.clearedBlockerIds)].join(", ") }].slice(-getTaskActivityLogEntryLimit());
    // FNXC:OverlapWaitRelease 2026-09-17-06:38: Also fence legacy writers which do not yet take the task advisory lock. A concurrent pause, Reset, retry or replacement blocker must win over this snapshot.
    const [updated] = await tx.update(schema.project.tasks).set({ ...values, log, updatedAt: now }).where(and(
      eq(schema.project.tasks.projectId, projectId), eq(schema.project.tasks.id, taskId), isNull(schema.project.tasks.deletedAt),
      eq(schema.project.tasks.updatedAt, current.updatedAt),
      sql`${schema.project.tasks.status} IS NOT DISTINCT FROM ${raw.status ?? null}`,
      sql`${schema.project.tasks.error} IS NOT DISTINCT FROM ${raw.error ?? null}`,
      sql`${schema.project.tasks.paused} IS NOT DISTINCT FROM ${raw.paused ?? null}`,
      sql`${schema.project.tasks.userPaused} IS NOT DISTINCT FROM ${raw.userPaused ?? null}`,
      sql`${schema.project.tasks.overlapBlockedBy} IS NOT DISTINCT FROM ${raw.overlapBlockedBy ?? null}`,
      sql`${schema.project.tasks.blockedBy} IS NOT DISTINCT FROM ${raw.blockedBy ?? null}`,
    )).returning();
    if (!updated) { result.resumed = false; result.clearedBlockerIds = []; }
    return { result, task: updated ? store.rowToTask(store.pgRowToTaskRow(updated)) : undefined };
  });
  if (outcome.task) {
    await store.atomicWriteTaskJson(store.taskDir(taskId), outcome.task).catch(() => undefined);
    if (store.isWatching) store.taskCache.set(taskId, { ...outcome.task });
    store.emitTaskLifecycleEventSafely("task:updated", [outcome.task]);
  }
  return outcome.result;
}
