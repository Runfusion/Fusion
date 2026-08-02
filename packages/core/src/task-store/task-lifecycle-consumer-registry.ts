import { and, asc, eq, gt, lte, or, sql } from "drizzle-orm";
import * as schema from "../postgres/schema/index.js";
import { recordRunAuditEventWithinTransaction, type AsyncDataLayer, type DbTransaction } from "../postgres/data-layer.js";

/** Durable state of one independently observing task-lifecycle consumer. */
export interface TaskLifecycleConsumerCursor {
  readonly lastAckedSeq: bigint;
  readonly retryAttempts: number;
  readonly retryBackoffUntil: string | null;
  readonly leaseToken: string | null;
  readonly fencingToken: bigint;
  readonly leaseExpiresAt: string | null;
  readonly updatedAt: string;
}

export interface TaskLifecycleLease {
  readonly token: string;
  readonly fencingToken: bigint;
  readonly expiresAt: string;
}

/*
FNXC:CrossProcessDeleteObservation 2026-08-01-12:27:
A fenced dead-letter park must roll back its row and audit write together. This private signal
crosses only the transaction boundary, converting a stale holder into the consumer's required
lease-fenced audit path rather than an unhandled polling failure.
*/
class TaskLifecycleConsumerFenceRejectedError extends Error {}

function projectIdFor(layer: AsyncDataLayer): string {
  if (!layer.projectId) {
    throw new Error("Task lifecycle consumer state requires asyncLayer.projectId");
  }
  return layer.projectId;
}

/**
 * FNXC:CrossProcessDeleteObservation 2026-08-01-11:39:
 * Registration, rather than cursor existence, declares a durable consumer live. A registered
 * identity with no cursor deliberately blocks retention because it has not acknowledged any event.
 */
export async function registerTaskLifecycleConsumer(
  layer: AsyncDataLayer,
  consumerId: string,
  now = new Date().toISOString(),
): Promise<void> {
  const projectId = projectIdFor(layer);
  await layer.db.insert(schema.project.taskLifecycleConsumerRegistrations).values({
    projectId,
    consumerId,
    registeredAt: now,
    lastSeenAt: now,
    active: 1,
  }).onConflictDoUpdate({
    target: [
      schema.project.taskLifecycleConsumerRegistrations.projectId,
      schema.project.taskLifecycleConsumerRegistrations.consumerId,
    ],
    set: { lastSeenAt: now, active: 1 },
  });
}

export async function setTaskLifecycleConsumerActive(
  layer: AsyncDataLayer,
  consumerId: string,
  active: boolean,
  now = new Date().toISOString(),
): Promise<void> {
  const projectId = projectIdFor(layer);
  await layer.db.update(schema.project.taskLifecycleConsumerRegistrations)
    .set({ active: active ? 1 : 0, lastSeenAt: now })
    .where(and(
      eq(schema.project.taskLifecycleConsumerRegistrations.projectId, projectId),
      eq(schema.project.taskLifecycleConsumerRegistrations.consumerId, consumerId),
    ));
}

export async function readTaskLifecycleConsumerCursor(
  layer: AsyncDataLayer,
  consumerId: string,
): Promise<TaskLifecycleConsumerCursor | null> {
  const projectId = projectIdFor(layer);
  const [row] = await layer.db.select().from(schema.project.taskLifecycleConsumerCursors).where(and(
    eq(schema.project.taskLifecycleConsumerCursors.projectId, projectId),
    eq(schema.project.taskLifecycleConsumerCursors.consumerId, consumerId),
  )).limit(1);
  return row ?? null;
}

/** Create an empty cursor only when a consumer starts observing. */
export async function ensureTaskLifecycleConsumerCursor(
  layer: AsyncDataLayer,
  consumerId: string,
  now = new Date().toISOString(),
): Promise<TaskLifecycleConsumerCursor> {
  const projectId = projectIdFor(layer);
  await layer.db.insert(schema.project.taskLifecycleConsumerCursors).values({
    projectId,
    consumerId,
    updatedAt: now,
  }).onConflictDoNothing();
  const cursor = await readTaskLifecycleConsumerCursor(layer, consumerId);
  if (!cursor) throw new Error("Task lifecycle consumer cursor was not persisted");
  return cursor;
}

/*
FNXC:CrossProcessDeleteObservation 2026-08-01-12:40:
Retention can remove every retained event while the project-scoped sequence counter remains ahead.
Read the counter for the reconciliation boundary so an empty retained window never regresses a
consumer cursor and replays already-accounted-for lifecycle history.
*/
export async function readTaskLifecycleEventBounds(layer: AsyncDataLayer): Promise<{ oldestSeq: bigint | null; oldestOccurredAt: string | null; headSeq: bigint }> {
  const projectId = projectIdFor(layer);
  const [oldest] = await layer.db.select({ seq: schema.project.taskLifecycleEvents.seq, occurredAt: schema.project.taskLifecycleEvents.occurredAt })
    .from(schema.project.taskLifecycleEvents).where(eq(schema.project.taskLifecycleEvents.projectId, projectId))
    .orderBy(asc(schema.project.taskLifecycleEvents.seq)).limit(1);
  const [sequence] = await layer.db.select({ lastSeq: schema.project.taskLifecycleEventSeq.lastSeq })
    .from(schema.project.taskLifecycleEventSeq)
    .where(eq(schema.project.taskLifecycleEventSeq.projectId, projectId))
    .limit(1);
  return { oldestSeq: oldest?.seq ?? null, oldestOccurredAt: oldest?.occurredAt ?? null, headSeq: sequence?.lastSeq ?? 0n };
}

export async function listTaskLifecycleEvents(
  layer: AsyncDataLayer,
  afterSeq: bigint,
  limit: number,
) {
  const projectId = projectIdFor(layer);
  return layer.db.select().from(schema.project.taskLifecycleEvents).where(and(
    eq(schema.project.taskLifecycleEvents.projectId, projectId),
    gt(schema.project.taskLifecycleEvents.seq, afterSeq),
  )).orderBy(asc(schema.project.taskLifecycleEvents.seq)).limit(limit);
}

export async function hasTaskLifecycleConsumerReceipt(
  layer: AsyncDataLayer,
  consumerId: string,
  eventId: string,
): Promise<boolean> {
  const projectId = projectIdFor(layer);
  const rows = await layer.db.select({ eventId: schema.project.taskLifecycleConsumerReceipts.eventId })
    .from(schema.project.taskLifecycleConsumerReceipts)
    .where(and(
      eq(schema.project.taskLifecycleConsumerReceipts.projectId, projectId),
      eq(schema.project.taskLifecycleConsumerReceipts.consumerId, consumerId),
      eq(schema.project.taskLifecycleConsumerReceipts.eventId, eventId),
    )).limit(1);
  return rows.length > 0;
}

/**
 * Atomically records the durable receipt and advances a cursor only for the lease fencing token
 * that dispatched it. A false return is a stale-holder signal; callers must stop their batch.
 */
export async function acknowledgeTaskLifecycleEvent(
  layer: AsyncDataLayer,
  input: { consumerId: string; eventId: string; seq: bigint; priorSeq: bigint; fencingToken: bigint; now?: string },
): Promise<boolean> {
  const projectId = projectIdFor(layer);
  const now = input.now ?? new Date().toISOString();
  return layer.transactionImmediate(async (tx) => {
    const advanced = await advanceCursorWithFence(tx, projectId, input.consumerId, input.priorSeq, input.seq, input.fencingToken, now);
    if (!advanced) return false;
    /*
    FNXC:CrossProcessDeleteObservation 2026-08-01-12:06:
    A successful acknowledgement starts the next event with a clean retry budget. Persist this
    reset in the same receipt/cursor transaction so one transient failure cannot poison a later row.
    */
    await tx.update(schema.project.taskLifecycleConsumerCursors).set({
      retryAttempts: 0,
      retryBackoffUntil: null,
      updatedAt: now,
    }).where(and(
      eq(schema.project.taskLifecycleConsumerCursors.projectId, projectId),
      eq(schema.project.taskLifecycleConsumerCursors.consumerId, input.consumerId),
      eq(schema.project.taskLifecycleConsumerCursors.fencingToken, input.fencingToken),
      eq(schema.project.taskLifecycleConsumerCursors.lastAckedSeq, input.seq),
    ));
    await tx.insert(schema.project.taskLifecycleConsumerReceipts).values({
      projectId,
      consumerId: input.consumerId,
      eventId: input.eventId,
      seq: input.seq,
      processedAt: now,
    }).onConflictDoNothing();
    return true;
  });
}

/** Shared CAS primitive for normal acknowledgement, reconciliation, and poison parking. */
export async function advanceCursorWithFence(
  tx: DbTransaction,
  projectId: string,
  consumerId: string,
  priorSeq: bigint,
  nextSeq: bigint,
  fencingToken: bigint,
  now: string,
): Promise<boolean> {
  if (nextSeq < priorSeq) return false;
  const result = await tx.update(schema.project.taskLifecycleConsumerCursors).set({
    lastAckedSeq: nextSeq,
    updatedAt: now,
  }).where(and(
    eq(schema.project.taskLifecycleConsumerCursors.projectId, projectId),
    eq(schema.project.taskLifecycleConsumerCursors.consumerId, consumerId),
    eq(schema.project.taskLifecycleConsumerCursors.lastAckedSeq, priorSeq),
    eq(schema.project.taskLifecycleConsumerCursors.fencingToken, fencingToken),
  )).returning({ consumerId: schema.project.taskLifecycleConsumerCursors.consumerId });
  return result.length === 1;
}

/** Advance a captured reconciliation boundary without reading a newer outbox head. */
export async function advanceTaskLifecycleConsumerCursor(
  layer: AsyncDataLayer,
  consumerId: string,
  priorSeq: bigint,
  nextSeq: bigint,
  fencingToken: bigint,
  now = new Date().toISOString(),
): Promise<boolean> {
  const projectId = projectIdFor(layer);
  return layer.transactionImmediate((tx) =>
    advanceCursorWithFence(tx, projectId, consumerId, priorSeq, nextSeq, fencingToken, now));
}

/**
 * FNXC:CrossProcessDeleteObservation 2026-08-01-11:39:
 * Lease claims are conditional on expiry and increment the fencing token. TTL is only a liveness
 * aid: every acknowledgement still checks this token so an expired holder cannot advance state.
 */
export async function acquireTaskLifecycleLease(
  layer: AsyncDataLayer,
  consumerId: string,
  token: string,
  expiresAt: string,
  now = new Date().toISOString(),
): Promise<TaskLifecycleLease | null> {
  const projectId = projectIdFor(layer);
  await ensureTaskLifecycleConsumerCursor(layer, consumerId, now);
  const claimed = await layer.db.update(schema.project.taskLifecycleConsumerCursors).set({
    leaseToken: token,
    leaseExpiresAt: expiresAt,
    fencingToken: sql`${schema.project.taskLifecycleConsumerCursors.fencingToken} + 1`,
  }).where(and(
    eq(schema.project.taskLifecycleConsumerCursors.projectId, projectId),
    eq(schema.project.taskLifecycleConsumerCursors.consumerId, consumerId),
    or(
      lte(schema.project.taskLifecycleConsumerCursors.leaseExpiresAt, now),
      sql`${schema.project.taskLifecycleConsumerCursors.leaseExpiresAt} IS NULL`,
    ),
  )).returning({ fencingToken: schema.project.taskLifecycleConsumerCursors.fencingToken });
  const row = claimed[0];
  return row ? { token, fencingToken: row.fencingToken, expiresAt } : null;
}

/*
FNXC:CrossProcessDeleteObservation 2026-08-01-12:27:
Lease bookkeeping must not overwrite the cursor's acknowledgement timestamp. Reconnect logic uses
that timestamp to select the 30-day reconciliation fallback, so only acknowledgement/reconciliation
advances update it; lease claims, renewals, releases, and retry scheduling do not.
*/
/** Renewal preserves the fencing token; only an expired-lease reclaim mints a higher one. */
export async function renewTaskLifecycleLease(
  layer: AsyncDataLayer,
  consumerId: string,
  lease: TaskLifecycleLease,
  expiresAt: string,
  _now = new Date().toISOString(),
): Promise<boolean> {
  const projectId = projectIdFor(layer);
  const renewed = await layer.db.update(schema.project.taskLifecycleConsumerCursors).set({
    leaseExpiresAt: expiresAt,
  }).where(and(
    eq(schema.project.taskLifecycleConsumerCursors.projectId, projectId),
    eq(schema.project.taskLifecycleConsumerCursors.consumerId, consumerId),
    eq(schema.project.taskLifecycleConsumerCursors.leaseToken, lease.token),
    eq(schema.project.taskLifecycleConsumerCursors.fencingToken, lease.fencingToken),
  )).returning({ consumerId: schema.project.taskLifecycleConsumerCursors.consumerId });
  return renewed.length === 1;
}

/** Clean shutdown releases only its own fenced lease and cannot clear a successor's lease. */
export async function setTaskLifecycleConsumerRetry(
  layer: AsyncDataLayer,
  consumerId: string,
  lease: TaskLifecycleLease,
  attempts: number,
  backoffUntil: string | null,
  _now = new Date().toISOString(),
): Promise<boolean> {
  const projectId = projectIdFor(layer);
  const updated = await layer.db.update(schema.project.taskLifecycleConsumerCursors).set({
    retryAttempts: attempts,
    retryBackoffUntil: backoffUntil,
  }).where(and(
    eq(schema.project.taskLifecycleConsumerCursors.projectId, projectId),
    eq(schema.project.taskLifecycleConsumerCursors.consumerId, consumerId),
    eq(schema.project.taskLifecycleConsumerCursors.leaseToken, lease.token),
    eq(schema.project.taskLifecycleConsumerCursors.fencingToken, lease.fencingToken),
  )).returning({ consumerId: schema.project.taskLifecycleConsumerCursors.consumerId });
  return updated.length === 1;
}

/**
 * FNXC:CrossProcessDeleteObservation 2026-08-01-11:39:
 * Poison parking is one transaction: an idempotent dead-letter insert, fenced cursor advance,
 * retry reset, and audit row commit or roll back together. A failed fenced advance throws only
 * inside the transaction so the catch below can report a stale lease without committing an orphan
 * dead-letter or audit row.
 */
export async function parkTaskLifecycleConsumerDeadLetter(
  layer: AsyncDataLayer,
  input: {
    consumerId: string;
    eventId: string;
    seq: bigint;
    priorSeq: bigint;
    attempts: number;
    failureClass: string;
    lease: TaskLifecycleLease;
    now?: string;
  },
): Promise<boolean> {
  const projectId = projectIdFor(layer);
  const now = input.now ?? new Date().toISOString();
  try {
    return await layer.transactionImmediate(async (tx) => {
      const inserted = await tx.insert(schema.project.taskLifecycleConsumerDeadLetters).values({
        projectId,
        consumerId: input.consumerId,
        eventId: input.eventId,
        seq: input.seq,
        attempts: input.attempts,
        failureClass: input.failureClass,
        parkedAt: now,
        updatedAt: now,
      }).onConflictDoNothing().returning({ eventId: schema.project.taskLifecycleConsumerDeadLetters.eventId });
      // A prior committed park is complete; do not manufacture another audit row on a replay.
      if (inserted.length === 0) return true;
      const advanced = await advanceCursorWithFence(
        tx, projectId, input.consumerId, input.priorSeq, input.seq, input.lease.fencingToken, now,
      );
      if (!advanced) throw new TaskLifecycleConsumerFenceRejectedError();
      await tx.update(schema.project.taskLifecycleConsumerCursors).set({
        retryAttempts: 0,
        retryBackoffUntil: null,
        updatedAt: now,
      }).where(and(
        eq(schema.project.taskLifecycleConsumerCursors.projectId, projectId),
        eq(schema.project.taskLifecycleConsumerCursors.consumerId, input.consumerId),
        eq(schema.project.taskLifecycleConsumerCursors.fencingToken, input.lease.fencingToken),
      ));
      await recordRunAuditEventWithinTransaction(tx, {
        taskId: undefined,
        agentId: "system",
        runId: `task-deleted-outbox:${input.consumerId}`,
        domain: "task-lifecycle",
        mutationType: "task-deleted-outbox:dead-letter",
        target: input.eventId,
        metadata: {
          projectId,
          consumerId: input.consumerId,
          eventId: input.eventId,
          seq: input.seq.toString(),
          attempts: input.attempts,
          failureClass: input.failureClass,
        },
      });
      return true;
    });
  } catch (error) {
    if (error instanceof TaskLifecycleConsumerFenceRejectedError) return false;
    throw error;
  }
}

export async function releaseTaskLifecycleLease(
  layer: AsyncDataLayer,
  consumerId: string,
  lease: TaskLifecycleLease,
  _now = new Date().toISOString(),
): Promise<void> {
  const projectId = projectIdFor(layer);
  await layer.db.update(schema.project.taskLifecycleConsumerCursors).set({
    leaseToken: null,
    leaseExpiresAt: null,
  }).where(and(
    eq(schema.project.taskLifecycleConsumerCursors.projectId, projectId),
    eq(schema.project.taskLifecycleConsumerCursors.consumerId, consumerId),
    eq(schema.project.taskLifecycleConsumerCursors.leaseToken, lease.token),
    eq(schema.project.taskLifecycleConsumerCursors.fencingToken, lease.fencingToken),
  ));
}
