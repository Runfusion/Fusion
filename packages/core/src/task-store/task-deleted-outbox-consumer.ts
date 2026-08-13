import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { TaskStore } from "../store.js";
import { createLogger } from "../process/logger.js";
import { recordRunAuditEvent } from "../postgres/data-layer.js";
import * as schema from "../postgres/schema/index.js";
import {
  acknowledgeTaskLifecycleEvent,
  acquireTaskLifecycleLease,
  advanceTaskLifecycleConsumerCursor,
  hasTaskLifecycleConsumerReceipt,
  listTaskLifecycleEvents,
  registerTaskLifecycleConsumer,
  releaseTaskLifecycleLease,
  readTaskLifecycleConsumerCursor,
  readTaskLifecycleEventBounds,
  renewTaskLifecycleLease,
  setTaskLifecycleConsumerActive,
  setTaskLifecycleConsumerRetry,
  parkTaskLifecycleConsumerDeadLetter,
  type TaskLifecycleLease,
} from "./task-lifecycle-consumer-registry.js";

export const TASK_DELETED_OUTBOX_POLL_MS = 5_000;
export const TASK_DELETED_OUTBOX_MAX_POLL_MS = 60_000;
export const TASK_DELETED_OUTBOX_BACKOFF_STEP_MS = 10_000;
export const TASK_DELETED_OUTBOX_POLL_JITTER_RATIO = 0.2;
export const TASK_DELETED_OUTBOX_LEASE_MS = 15_000;
export const TASK_DELETED_OUTBOX_BATCH_SIZE = 100;
export const TASK_DELETED_OUTBOX_RETENTION_DAYS = 30;

const outboxConsumerLog = createLogger("task-deleted-outbox-consumer");

/**
 * Apply ±`TASK_DELETED_OUTBOX_POLL_JITTER_RATIO` multiplicative jitter to a poll delay so the ~44
 * per-project dashboard/engine consumers de-synchronize instead of firing on the same cadence.
 * Imported by the regression test to assert its bounded, non-negative range. The delay never falls
 * below the fast base so jitter cannot speed an idle consumer back into the storm.
 */
export function applyPollJitter(delayMs: number, ratio = TASK_DELETED_OUTBOX_POLL_JITTER_RATIO): number {
  const delta = delayMs * ratio * (Math.random() * 2 - 1);
  return Math.max(TASK_DELETED_OUTBOX_POLL_MS, Math.round(delayMs + delta));
}

type OutboxEventForValidation = {
  eventId: string;
  eventType: string;
  taskId: string;
  occurredAt: string;
  payload: unknown;
};

type ReconciliationReason = "cursor-older-than-retention-bound" | "pruned-gap";

/**
 * FNXC:CrossProcessDeleteObservation 2026-08-01-12:14:
 * Reject malformed durable rows so poison handling, rather than acknowledgement, owns them.
 */
function assertTaskDeletedOutboxEvent(event: OutboxEventForValidation): void {
  const payload = event.payload;
  if (event.eventType !== "task:deleted" || !event.eventId || !event.taskId || !event.occurredAt
    || !payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new TypeError("Malformed task:deleted lifecycle outbox event");
  }
  const deleted = payload as Record<string, unknown>;
  if (deleted.taskId !== event.taskId || typeof deleted.previousColumn !== "string"
    || (deleted.previousStatus !== null && typeof deleted.previousStatus !== "string")
    || typeof deleted.deletedAt !== "string" || typeof deleted.allowResurrection !== "boolean"
    || (deleted.githubIssueAction !== null && typeof deleted.githubIssueAction !== "string")
    || (deleted.closureContext !== null && (!deleted.closureContext || typeof deleted.closureContext !== "object"
      || Array.isArray(deleted.closureContext)))
    || (deleted.deletedBy !== null && typeof deleted.deletedBy !== "string")) {
    throw new TypeError("Malformed task:deleted lifecycle outbox payload");
  }
}

/**
 * FNXC:CrossProcessDeleteObservation 2026-08-01-11:39:
 * The PostgreSQL outbox is authoritative for cross-process task deletion. Delivery dispatches
 * before the durable receipt/cursor acknowledgement, intentionally yielding at-least-once
 * observed notifications in the crash window; observed dispatch has no writer-owned effects.
 */
export class TaskDeletedOutboxConsumer {
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private renewalTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private lease: TaskLifecycleLease | null = null;
  private idlePollsSinceEvent = 0;

  constructor(private readonly store: TaskStore) {}

  /*
  FNXC:TaskLifecycleConsumerIdleBackoff 2026-08-13-06:41:
  The outbox consumer reschedules itself instead of polling a fixed 5s setInterval forever. Each
  poll feeds back its outcome: an idle poll (the outbox returned zero events) grows the next delay
  by TASK_DELETED_OUTBOX_BACKOFF_STEP_MS toward TASK_DELETED_OUTBOX_MAX_POLL_MS, with ±20% jitter
  so the ~44 per-project dashboard/engine consumers de-synchronize instead of thundering together;
  a poll that delivered events resets to the fast TASK_DELETED_OUTBOX_POLL_MS base. A paused/idle
  project stops writing lifecycle events, so its outbox drains and backoff alone drops the DB
  idx_scan/CPU storm on task_lifecycle_consumer_cursors without touching delivery semantics. Any
  new event mid-backoff resets the cadence to 5s, bounding delivery latency. Cursor fencing, lease
  advance, per-event ordering, and at-least-once delivery are unchanged — backoff only changes when
  poll() runs, never the poll/dispatch/ack logic.
  */
  async start(): Promise<void> {
    if (this.running || !this.store.asyncLayer || !this.store.consumerId) return;
    this.running = true;
    /* Drain any backlog with the immediate poll, then feed its idle/active outcome into the first
    scheduled delay so a fresh idle consumer backs off from the very first timer (not after one
    wasted 5s tick). */
    const active = await this.pollSafely();
    if (active) this.idlePollsSinceEvent = 0;
    else this.idlePollsSinceEvent += 1;
    this.scheduleNextPoll();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.renewalTimer) clearInterval(this.renewalTimer);
    this.pollTimer = null;
    this.renewalTimer = null;
    const layer = this.store.asyncLayer;
    const consumerId = this.store.consumerId;
    if (layer && consumerId && this.lease) {
      try {
        await releaseTaskLifecycleLease(layer, consumerId, this.lease);
      } catch (error) {
        outboxConsumerLog.warn("Could not release task:deleted outbox lease during shutdown", error);
      }
    }
    this.lease = null;
    if (layer && consumerId) {
      try {
        await setTaskLifecycleConsumerActive(layer, consumerId, false);
      } catch (error) {
        outboxConsumerLog.warn("Could not deactivate task:deleted outbox consumer during shutdown", error);
      }
    }
  }

  private async pollSafely(): Promise<boolean> {
    try {
      return await this.poll();
    } catch (error) {
      outboxConsumerLog.warn("Task:deleted outbox poll failed; delivery will retry", error);
      return false;
    }
  }

  /**
   * Idle/active backoff contract: returns `true` when the poll delivered/processed at least one
   * lifecycle event (the consumer is active), `false` when it found the outbox empty or took a
   * non-delivering early return (the consumer is idle). The rescheduling loop uses this to extend
   * the next poll delay toward the 60s cap while idle and reset to the fast 5s base once events
   * flow again.
   */
  async poll(): Promise<boolean> {
    const layer = this.store.asyncLayer;
    const consumerId = this.store.consumerId;
    if (!this.running || !layer || !consumerId) return false;
    await registerTaskLifecycleConsumer(layer, consumerId);
    /*
    FNXC:CrossProcessDeleteObservation 2026-08-01-12:14:
    stop() can race the asynchronous registration write. Re-marking this identity inactive after
    that race prevents a cleanly stopped consumer from pinning retention as live.
    */
    if (!this.running) {
      await setTaskLifecycleConsumerActive(layer, consumerId, false);
      return false;
    }
    const now = new Date();
    const acquired = await acquireTaskLifecycleLease(
      layer,
      consumerId,
      randomUUID(),
      new Date(now.getTime() + TASK_DELETED_OUTBOX_LEASE_MS).toISOString(),
      now.toISOString(),
    );
    if (!acquired) return false;
    if (!this.running) {
      await releaseTaskLifecycleLease(layer, consumerId, acquired);
      return false;
    }
    this.lease = acquired;
    this.startRenewal(acquired);
    try {
      const cursor = await readTaskLifecycleConsumerCursor(layer, consumerId);
      if (!cursor) return false;
      if (cursor.retryBackoffUntil && Date.parse(cursor.retryBackoffUntil) > Date.now()) return false;
      const reconciliationReason = await this.needsReconciliation(cursor.lastAckedSeq, cursor.updatedAt);
      if (reconciliationReason) {
        const reconciled = await this.reconcile(cursor.lastAckedSeq, acquired, reconciliationReason);
        if (!reconciled) {
          await this.recordLeaseFenced(acquired, 0);
          return false;
        }
      }
      const currentCursor = await readTaskLifecycleConsumerCursor(layer, consumerId);
      if (!currentCursor) return false;
      const events = await listTaskLifecycleEvents(layer, currentCursor.lastAckedSeq, TASK_DELETED_OUTBOX_BATCH_SIZE);
      let priorSeq = currentCursor.lastAckedSeq;
      let dispatchedCount = 0;
      for (const event of events) {
        if (!this.running || this.lease?.fencingToken !== acquired.fencingToken) break;
        try {
          assertTaskDeletedOutboxEvent(event);
          if (await hasTaskLifecycleConsumerReceipt(layer, consumerId, event.eventId)) {
            priorSeq = event.seq;
            continue;
          }
          const task = await this.readDeletedTask(event.taskId);
          if (!task) {
            // Cache absence is not an idempotency gate: commit a receipt for every valid row.
            const acknowledged = await acknowledgeTaskLifecycleEvent(layer, {
              consumerId, eventId: event.eventId, seq: event.seq, priorSeq, fencingToken: acquired.fencingToken,
            });
            if (!acknowledged) {
              await this.recordLeaseFenced(acquired, 1);
              break;
            }
            priorSeq = event.seq;
            continue;
          }
          const payload = event.payload as {
            githubIssueAction: import("../types.js").GithubIssueAction | null;
            closureContext: import("../types.js").TaskDeleteClosureContext | null;
          };
          this.store.emitObservedTaskDeleted(task, event.eventId, {
            githubIssueAction: payload.githubIssueAction ?? "auto",
            ...(payload.closureContext ? { closureContext: payload.closureContext } : {}),
          });
          dispatchedCount++;
          const acknowledged = await acknowledgeTaskLifecycleEvent(layer, {
            consumerId, eventId: event.eventId, seq: event.seq, priorSeq, fencingToken: acquired.fencingToken,
          });
          if (!acknowledged) {
            await this.recordLeaseFenced(acquired, 1);
            break;
          }
          priorSeq = event.seq;
        } catch (error) {
          const attempts = currentCursor.retryAttempts + 1;
          const failureClass = error instanceof Error ? error.name : "unknown";
          if (attempts >= 10) {
            const parked = await parkTaskLifecycleConsumerDeadLetter(layer, {
              consumerId, eventId: event.eventId, seq: event.seq, priorSeq, attempts, failureClass, lease: acquired,
            });
            if (!parked) await this.recordLeaseFenced(acquired, 1);
            else priorSeq = event.seq;
            break;
          }
          const delayMs = [1_000, 5_000, 30_000, 300_000, 900_000][Math.min(attempts - 1, 4)]!;
          const retried = await setTaskLifecycleConsumerRetry(layer, consumerId, acquired, attempts,
            new Date(Date.now() + delayMs).toISOString(),
          );
          if (!retried) await this.recordLeaseFenced(acquired, 1);
          break;
        }
      }
      if (this.running && events.length > 0) {
        await recordRunAuditEvent(layer, {
          agentId: "system",
          runId: `task-deleted-outbox:${consumerId}`,
          domain: "task-lifecycle",
          mutationType: "task-deleted-outbox:catch-up",
          target: consumerId,
          metadata: { projectId: layer.projectId, consumerId, fromSeq: currentCursor.lastAckedSeq.toString(), toSeq: priorSeq.toString(), dispatchedCount },
        });
      }
      if (this.running) await setTaskLifecycleConsumerActive(layer, consumerId, true);
      return events.length > 0;
    } finally {
      if (this.renewalTimer) clearInterval(this.renewalTimer);
      this.renewalTimer = null;
      /*
      FNXC:CrossProcessDeleteObservation 2026-08-01-12:06:
      Every completed batch releases its own fenced lease instead of waiting for TTL expiry. This
      keeps normal polling responsive while the token predicate protects a successor's reclaim.
      */
      if (this.lease?.token === acquired.token) {
        await releaseTaskLifecycleLease(layer, consumerId, acquired);
        this.lease = null;
      }
    }
  }

  /**
   * FNXC:CrossProcessDeleteObservation 2026-08-01-11:39:
   * Capture the outbox head before reading task state. Advancing only to that fenced snapshot
   * preserves rows inserted during reconciliation for the following ordinary poll.
   */
  private async needsReconciliation(lastAckedSeq: bigint, updatedAt: string): Promise<ReconciliationReason | null> {
    const bounds = await readTaskLifecycleEventBounds(this.store.asyncLayer!);
    if (bounds.oldestSeq !== null && lastAckedSeq + 1n < bounds.oldestSeq) return "pruned-gap";
    if (Date.parse(updatedAt) < Date.now() - TASK_DELETED_OUTBOX_RETENTION_DAYS * 86_400_000) {
      return "cursor-older-than-retention-bound";
    }
    return null;
  }

  /**
   * Reschedule the next poll with a setTimeout whose delay reflects the previous poll's outcome,
   * replacing the old fixed-interval setInterval so an idle consumer stops thundering against the
   * DB. pollSafely always resolves (it swallows errors), so the reschedule chain never stalls.
   */
  private scheduleNextPoll(): void {
    if (!this.running) return;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      void this.pollSafely().then((active) => {
        if (active) this.idlePollsSinceEvent = 0;
        else this.idlePollsSinceEvent += 1;
        this.scheduleNextPoll();
      });
    }, this.nextPollDelayMs());
  }

  /** Jittered delay for the upcoming poll, derived from the accumulated idle-poll count. */
  private nextPollDelayMs(): number {
    return applyPollJitter(this.computeNextPollDelayMs());
  }

  /** Deterministic idle-backoff delay (no jitter): 5s -> 15s -> 25s -> ... -> 60s cap. */
  private computeNextPollDelayMs(): number {
    if (this.idlePollsSinceEvent <= 0) return TASK_DELETED_OUTBOX_POLL_MS;
    const grown = TASK_DELETED_OUTBOX_POLL_MS
      + this.idlePollsSinceEvent * TASK_DELETED_OUTBOX_BACKOFF_STEP_MS;
    return Math.min(grown, TASK_DELETED_OUTBOX_MAX_POLL_MS);
  }

  private async reconcile(
    priorSeq: bigint,
    lease: TaskLifecycleLease,
    reason: ReconciliationReason,
  ): Promise<boolean> {
    const layer = this.store.asyncLayer!;
    const consumerId = this.store.consumerId!;
    const bounds = await readTaskLifecycleEventBounds(layer);
    const headSeq = bounds.headSeq;
    const liveRows = await layer.db.select({ id: schema.project.tasks.id })
      .from(schema.project.tasks)
      .where(and(eq(schema.project.tasks.projectId, layer.projectId!), isNull(schema.project.tasks.deletedAt)));
    const liveIds = new Set(liveRows.map((row) => row.id));
    let dispatchedCount = 0;
    for (const task of this.store.taskCache.values()) {
      if (!liveIds.has(task.id)) {
        this.store.emitObservedTaskDeleted(task, `reconciliation:${task.id}:${headSeq}`);
        dispatchedCount++;
      }
    }
    const advanced = await advanceTaskLifecycleConsumerCursor(layer, consumerId, priorSeq, headSeq, lease.fencingToken);
    if (!advanced) return false;
    await recordRunAuditEvent(layer, {
      agentId: "system", runId: `task-deleted-outbox:${consumerId}`, domain: "task-lifecycle",
      mutationType: "task-deleted-outbox:reconciliation-fallback", target: consumerId,
      metadata: { projectId: layer.projectId, consumerId, reason, reconciliationHeadSeq: headSeq.toString(), dispatchedCount, scannedCount: liveRows.length },
    });
    return true;
  }

  private async recordLeaseFenced(lease: TaskLifecycleLease, abortedCount: number): Promise<void> {
    const layer = this.store.asyncLayer;
    const consumerId = this.store.consumerId;
    if (!layer || !consumerId) return;
    const cursor = await readTaskLifecycleConsumerCursor(layer, consumerId);
    await recordRunAuditEvent(layer, {
      agentId: "system", runId: `task-deleted-outbox:${consumerId}`, domain: "task-lifecycle",
      mutationType: "task-deleted-outbox:lease-fenced", target: consumerId,
      metadata: {
        projectId: layer.projectId, consumerId, staleToken: lease.fencingToken.toString(),
        currentToken: (cursor?.fencingToken ?? lease.fencingToken).toString(), abortedCount,
      },
    });
  }

  private startRenewal(lease: TaskLifecycleLease): void {
    if (this.renewalTimer) clearInterval(this.renewalTimer);
    this.renewalTimer = setInterval(() => {
      const layer = this.store.asyncLayer;
      const consumerId = this.store.consumerId;
      if (!layer || !consumerId || this.lease?.fencingToken !== lease.fencingToken) return;
      const now = new Date();
      void renewTaskLifecycleLease(layer, consumerId, lease,
        new Date(now.getTime() + TASK_DELETED_OUTBOX_LEASE_MS).toISOString(), now.toISOString(),
      ).then((renewed) => {
        if (!renewed && this.lease?.fencingToken === lease.fencingToken) this.lease = null;
      }).catch((error) => {
        outboxConsumerLog.warn("Could not renew task:deleted outbox lease", error);
      });
    }, Math.floor(TASK_DELETED_OUTBOX_LEASE_MS / 3));
  }

  private async readDeletedTask(taskId: string) {
    const cached = this.store.taskCache.get(taskId);
    if (cached) return cached;
    const layer = this.store.asyncLayer!;
    if (!layer.projectId) return null;
    const [row] = await layer.db.select().from(schema.project.tasks).where(and(
      eq(schema.project.tasks.projectId, layer.projectId),
      eq(schema.project.tasks.id, taskId),
    )).limit(1);
    return row ? this.store.rowToTask(this.store.pgRowToTaskRow(row as Record<string, unknown>)) : null;
  }
}
