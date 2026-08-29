/*
FNXC:CrossProcessDeleteObservation 2026-08-01-12:29:
A reconnect must make its 30-day decision from durable acknowledgement state, not a lease update.
These PostgreSQL checks exercise the real conditional updates so a hand-written query fake cannot
hide a lease write that makes an offline cursor appear current.
*/
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import * as schema from "../../postgres/schema/index.js";
import { TaskDeletedOutboxConsumer } from "../../task-store/task-deleted-outbox-consumer.js";
import {
  acquireTaskLifecycleLease,
  ensureTaskLifecycleConsumerCursor,
  advanceTaskLifecycleConsumerCursor,
  parkTaskLifecycleConsumerDeadLetter,
  readTaskLifecycleConsumerCursor,
  readTaskLifecycleEventBounds,
  renewTaskLifecycleLease,
} from "../../task-store/task-lifecycle-consumer-registry.js";

const pgTest = pgDescribe;
const TEST_PROJECT_ID = "outbox-consumer-project";

pgTest("task:deleted outbox consumer fences", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_task_deleted_outbox_consumer",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  it("preserves acknowledgement freshness while acquiring and renewing a lease", async () => {
    const layer = { ...h.layer(), projectId: TEST_PROJECT_ID };
    const consumerId = "engine";
    const acknowledgedAt = "2026-06-01T00:00:00.000Z";
    await ensureTaskLifecycleConsumerCursor(layer, consumerId, acknowledgedAt);

    const lease = await acquireTaskLifecycleLease(
      layer,
      consumerId,
      "lease-a",
      "2026-08-02T00:00:15.000Z",
      "2026-08-02T00:00:00.000Z",
    );

    expect(lease).not.toBeNull();
    await expect(renewTaskLifecycleLease(
      layer,
      consumerId,
      lease!,
      "2026-08-02T00:00:30.000Z",
      "2026-08-02T00:00:15.000Z",
    )).resolves.toBe(true);
    expect((await readTaskLifecycleConsumerCursor(layer, consumerId))?.updatedAt).toBe(acknowledgedAt);
  });

  it("reconciles an unacknowledged cursor when retained rows start after sequence zero", async () => {
    const layer = { ...h.layer(), projectId: TEST_PROJECT_ID };
    await layer.db.insert(schema.project.taskLifecycleEvents).values({
      projectId: TEST_PROJECT_ID,
      seq: 2n,
      eventId: "retained-gap",
      eventType: "task:deleted",
      taskId: "FN-GAP",
      occurredAt: "2026-08-01T00:00:00.000Z",
      createdAt: "2026-08-01T00:00:00.000Z",
      payload: {},
    });
    const consumer = new TaskDeletedOutboxConsumer({ asyncLayer: layer } as never);
    const needsReconciliation = (consumer as unknown as {
      needsReconciliation(lastAckedSeq: bigint, updatedAt: string): Promise<"pruned-gap" | "cursor-older-than-retention-bound" | null>;
    }).needsReconciliation.bind(consumer);

    await expect(needsReconciliation(0n, "2026-08-01T00:00:00.000Z")).resolves.toBe("pruned-gap");
  });

  it("uses the durable sequence counter after retention removes all event rows and rejects cursor regression", async () => {
    const projectId = "outbox-consumer-pruned-sequence";
    const layer = { ...h.layer(), projectId };
    const consumerId = "engine-pruned-head";
    const now = "2026-08-01T00:00:00.000Z";
    await ensureTaskLifecycleConsumerCursor(layer, consumerId, now);
    await layer.db.update(schema.project.taskLifecycleConsumerCursors).set({ lastAckedSeq: 100n }).where(and(
      eq(schema.project.taskLifecycleConsumerCursors.projectId, projectId),
      eq(schema.project.taskLifecycleConsumerCursors.consumerId, consumerId),
    ));
    await layer.db.insert(schema.project.taskLifecycleEventSeq).values({
      projectId,
      lastSeq: 100n,
    });

    await expect(readTaskLifecycleEventBounds(layer)).resolves.toMatchObject({
      oldestSeq: null,
      headSeq: 100n,
    });
    await expect(advanceTaskLifecycleConsumerCursor(layer, consumerId, 100n, 0n, 0n, now)).resolves.toBe(false);
    expect((await readTaskLifecycleConsumerCursor(layer, consumerId))?.lastAckedSeq).toBe(100n);
  });

  it("reports acknowledgement-age reconciliation separately from a retained-row gap", async () => {
    const layer = { ...h.layer(), projectId: "outbox-consumer-acknowledgement-age" };
    const consumer = new TaskDeletedOutboxConsumer({ asyncLayer: layer } as never);
    const needsReconciliation = (consumer as unknown as {
      needsReconciliation(lastAckedSeq: bigint, updatedAt: string): Promise<"pruned-gap" | "cursor-older-than-retention-bound" | null>;
    }).needsReconciliation.bind(consumer);

    await expect(needsReconciliation(0n, "2026-06-01T00:00:00.000Z")).resolves.toBe("cursor-older-than-retention-bound");
  });

  it("rolls back a fenced dead-letter park so the poller can emit lease-fenced evidence", async () => {
    const layer = { ...h.layer(), projectId: TEST_PROJECT_ID };
    const consumerId = "engine-fence";
    await ensureTaskLifecycleConsumerCursor(layer, consumerId, "2026-08-01T00:00:00.000Z");
    const staleLease = await acquireTaskLifecycleLease(
      layer,
      consumerId,
      "lease-stale",
      "2026-08-01T00:00:01.000Z",
      "2026-08-01T00:00:00.000Z",
    );
    const successorLease = await acquireTaskLifecycleLease(
      layer,
      consumerId,
      "lease-successor",
      "2026-08-01T00:01:00.000Z",
      "2026-08-01T00:00:02.000Z",
    );
    expect(staleLease).not.toBeNull();
    expect(successorLease?.fencingToken).toBeGreaterThan(staleLease!.fencingToken);

    await expect(parkTaskLifecycleConsumerDeadLetter(layer, {
      consumerId,
      eventId: "event-stale",
      seq: 1n,
      priorSeq: 0n,
      attempts: 10,
      failureClass: "TypeError",
      lease: staleLease!,
      now: "2026-08-01T00:00:03.000Z",
    })).resolves.toBe(false);

    const cursor = await readTaskLifecycleConsumerCursor(layer, consumerId);
    expect(cursor?.lastAckedSeq).toBe(0n);
    const letters = await layer.db.select().from(schema.project.taskLifecycleConsumerDeadLetters).where(and(
      eq(schema.project.taskLifecycleConsumerDeadLetters.projectId, layer.projectId!),
      eq(schema.project.taskLifecycleConsumerDeadLetters.consumerId, consumerId),
    ));
    expect(letters).toHaveLength(0);
  });
});
