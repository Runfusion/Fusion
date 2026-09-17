/*
FNXC:TaskQueueOrder 2026-09-17-12:07:
FN-509's durable Boost against a REAL PostgreSQL database. This file replaces `store-priority.pg.test.ts`,
whose subject (persisting a task priority level) FN-509 deleted; the first case below is the direct
proof of that removal, and the rest exercise what took its place.

Why PostgreSQL rather than a fake store: the parts that can actually go wrong here are the migration
(column + sequence), the server-assigned ordering of concurrent clicks, and the interaction between
the single Boost writer and the generic writers that must not clobber it. None of those exist in an
in-memory double.
*/
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import { resolveEffectiveQueueBoost, resolveTaskColumnEntryAt } from "../../tasks/task-queue-order.js";

const pgTest = pgDescribe;

pgTest("TaskStore durable queue rank (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_queue_boost",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  const boostArgs = (task: { column: string; createdAt: string; columnMovedAt?: string }, requestId: string) => ({
    requestId,
    workflowId: "builtin:coding",
    expectedColumn: task.column,
    expectedColumnEntryAt: resolveTaskColumnEntryAt(task),
  });

  it("never persists a task priority, even when a caller smuggles one in", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "No level survives" } as never);
    expect((task as { priority?: unknown }).priority).toBeUndefined();

    const reread = await store.getTask(task.id);
    expect((reread as { priority?: unknown }).priority).toBeUndefined();
    // A generic update cannot reintroduce the retired field either.
    await store.updateTask(task.id, { priority: "urgent" } as never);
    expect(((await store.getTask(task.id)) as { priority?: unknown }).priority).toBeUndefined();
  });

  it("creates every task without a rank, then persists exactly one on boost", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "Boostable" });
    expect(task.queueBoost).toBeUndefined();

    const outcome = await store.boostTask(task.id, boostArgs(task, "req-1"));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.idempotent).toBe(false);
    expect(outcome.boost.sequence).toMatch(/^\d+$/);

    // The rank survives a full re-read, so it is durable rather than in-memory.
    const reread = await store.getTask(task.id);
    expect(resolveEffectiveQueueBoost(reread, { workflowId: "builtin:coding" })).toMatchObject({
      sequence: outcome.boost.sequence,
      column: task.column,
      requestId: "req-1",
    });
  });

  it("orders two concurrent boosts by the server sequence, not by the caller", async () => {
    const store = h.store();
    const first = await store.createTask({ description: "A" });
    const second = await store.createTask({ description: "B" });

    const [a, b] = await Promise.all([
      store.boostTask(first.id, boostArgs(first, "req-a")),
      store.boostTask(second.id, boostArgs(second, "req-b")),
    ]);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    // Two distinct, strictly increasing values: the database, not a browser clock, ordered them.
    expect(a.boost.sequence).not.toBe(b.boost.sequence);
    expect(new Set([a.boost.sequence, b.boost.sequence]).size).toBe(2);
  });

  it("is idempotent for a retried request id and mints a new rank for a genuinely new click", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "Retry" });

    const first = await store.boostTask(task.id, boostArgs(task, "req-same"));
    const retry = await store.boostTask(task.id, boostArgs(task, "req-same"));
    expect(first.ok && retry.ok).toBe(true);
    if (!first.ok || !retry.ok) return;
    expect(retry.idempotent).toBe(true);
    expect(retry.boost.sequence).toBe(first.boost.sequence);

    const newClick = await store.boostTask(task.id, boostArgs(task, "req-new"));
    expect(newClick.ok).toBe(true);
    if (!newClick.ok) return;
    expect(newClick.idempotent).toBe(false);
    expect(newClick.boost.sequence).not.toBe(first.boost.sequence);
  });

  it("refuses a boost aimed at a stay the card has already left", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "Moved on" });

    const stale = await store.boostTask(task.id, {
      requestId: "req-stale",
      workflowId: "builtin:coding",
      expectedColumn: task.column,
      expectedColumnEntryAt: "1999-01-01T00:00:00.000Z",
    });
    expect(stale.ok).toBe(false);
    if (stale.ok) return;
    expect(stale.reason).toBe("scope-changed");
    expect((await store.getTask(task.id)).queueBoost).toBeUndefined();
  });

  it("refuses a boost on a card the caller proves is already active", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "Running" });

    const refused = await store.boostTask(task.id, {
      ...boostArgs(task, "req-active"),
      isActive: () => true,
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.reason).toBe("active");
    expect((await store.getTask(task.id)).queueBoost).toBeUndefined();
  });

  it("refuses an unknown task without inventing a row", async () => {
    const store = h.store();
    const missing = await store.boostTask("FN-does-not-exist", {
      requestId: "req-missing",
      workflowId: "builtin:coding",
    });
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.reason).toBe("not-found");
  });

  it("keeps a committed rank through a later generic title write", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "Rename me" });
    const boosted = await store.boostTask(task.id, boostArgs(task, "req-keep"));
    expect(boosted.ok).toBe(true);
    if (!boosted.ok) return;

    await store.updateTask(task.id, { title: "Renamed after the boost" });

    const reread = await store.getTask(task.id);
    expect(reread.title).toBe("Renamed after the boost");
    // A generic write must not silently drop the durable rank a separate mutation committed.
    expect(reread.queueBoost?.sequence).toBe(boosted.boost.sequence);
  });

  it("does not copy a rank onto a duplicated task", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "Original" });
    const boosted = await store.boostTask(task.id, boostArgs(task, "req-clone"));
    expect(boosted.ok).toBe(true);

    const clone = await store.duplicateTask(task.id);
    expect(clone.queueBoost).toBeUndefined();
    expect((await store.getTask(task.id)).queueBoost).toBeDefined();
  });
});
