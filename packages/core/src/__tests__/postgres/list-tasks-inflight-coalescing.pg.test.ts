/**
 * FNXC:ListReadInFlightCoalescing 2026-10-23-21:24 (RUFU-627):
 * A V8 sampling profile of the production dashboard attributed 1.327 GiB of still-live allocations to
 * the board list-read path, ~0.58 GiB per fully parsed 2 417-row board, and the forced-GC floor rose
 * +33 MiB/min live / +27 MiB/min old_space — growth that only appears when engine consumers OVERLAP
 * parses and hold the results. These tests pin the mechanism that removes the duplication, and pin it
 * in the direction that matters: overlapping readers, not a sequential loop (a sequential loop never
 * overlaps, so it cannot demonstrate coalescing).
 *
 * The load-bearing assertions are, in order:
 *  1. N concurrent identical non-paginated reads cost ONE underlying read and share ONE frozen
 *     materialization, with a `coalesce: false` control that costs N of both;
 *  2. no two different read SHAPES ever share an entry — including the `includeArchived: true` live
 *     read against the `includeDeleted: true` forensic read, the exact collision RUFU-201 recorded;
 *  3. a caller that starts after a committed `task:created` re-issues and observes the write, while a
 *     caller that already joined resolves with the snapshot it joined.
 */
import { afterEach, beforeEach, describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import { listReadShapeKey } from "../../task-store/reads.js";
import { resetReadAttributionForTests, snapshotReadAttribution } from "../../task-store/read-attribution.js";
import type { Task } from "../../types.js";

const pgTest = pgDescribe;

/** Underlying fetches actually performed, as the production attribution seam counts them. */
function listReadCalls(): number {
  return snapshotReadAttribution().listTasks.calls;
}

pgTest("listTasks in-flight coalescing (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_inflight_coalesce",
  });

  beforeAll(h.beforeAll);
  afterAll(h.afterAll);
  beforeEach(async () => {
    await h.beforeEach();
    resetReadAttributionForTests();
  });
  afterEach(async () => {
    resetReadAttributionForTests();
    await h.afterEach();
  });

  async function seedCards(count: number): Promise<void> {
    const store = h.store();
    for (let i = 0; i < count; i += 1) {
      await store.createTaskWithReservedId(
        { description: `RUFU-627 probe card ${i}`, column: i % 2 === 0 ? "in-progress" : "todo" },
        { taskId: `RUFU-9${300 + i}`, applyDefaultWorkflowSteps: false },
      );
    }
  }

  it("costs one read and one materialization for overlapping identical board reads", async () => {
    await seedCards(4);
    const store = h.store();
    const options = { slim: true, includeArchived: false, startupMemo: false } as const;

    const before = listReadCalls();
    // Issued in the same tick, so every joiner must see the registered entry — no timing race in the
    // assertion, which is the whole point of register-then-delegate.
    const rows = await Promise.all([
      store.listTasks(options),
      store.listTasks(options),
      store.listTasks(options),
      store.listTasks(options),
    ]);
    const after = listReadCalls();

    expect(after - before).toBe(1);
    expect(rows[0]).toHaveLength(4);
    for (const one of rows.slice(1)) expect(Object.is(one, rows[0])).toBe(true);
  });

  it("coalesces full (slim: false) rows too, because the admission lanes do not read slim", async () => {
    await seedCards(3);
    const store = h.store();
    const options = { slim: false, includeArchived: false, startupMemo: false } as const;

    const before = listReadCalls();
    const rows = await Promise.all([store.listTasks(options), store.listTasks(options)]);
    expect(listReadCalls() - before).toBe(1);
    expect(Object.is(rows[0], rows[1])).toBe(true);
  });

  it("costs N reads and N materializations when callers opt out with coalesce: false", async () => {
    await seedCards(4);
    const store = h.store();
    const options = { slim: true, includeArchived: false, startupMemo: false, coalesce: false } as const;

    const before = listReadCalls();
    const rows = await Promise.all([
      store.listTasks(options),
      store.listTasks(options),
      store.listTasks(options),
      store.listTasks(options),
    ]);
    expect(listReadCalls() - before).toBe(4);
    expect(rows.every((one) => one.length === 4)).toBe(true);
    expect(Object.is(rows[0], rows[1])).toBe(false);
  });

  it("shares one frozen snapshot instead of letting a mutator corrupt its siblings", async () => {
    await seedCards(2);
    const store = h.store();
    const options = { slim: true, includeArchived: false, startupMemo: false } as const;

    const [first, second] = await Promise.all([store.listTasks(options), store.listTasks(options)]);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first[0])).toBe(true);
    expect(() => {
      (first as Task[]).sort((a, b) => a.id.localeCompare(b.id));
    }).toThrow(TypeError);
    // The sibling is unaffected: same frozen array, same order it arrived in.
    expect(Object.is(first, second)).toBe(true);
    expect(second.map((task) => task.id)).toEqual(first.map((task) => task.id));
  });

  it("never shares an entry across read shapes, including the RUFU-201 tombstone collision", async () => {
    await seedCards(3);
    const store = h.store();

    const live = await store.listTasks({ includeArchived: true, slim: true, coalesce: false });
    const forensic = await store.listTasks({
      includeArchived: true,
      includeDeleted: true,
      slim: true,
      coalesce: false,
    });
    expect(listReadShapeKey({ includeArchived: true, slim: true })).not.toBe(
      listReadShapeKey({ includeArchived: true, includeDeleted: true, slim: true }),
    );
    expect(Object.is(live, forensic)).toBe(false);

    // Same key from two option orders, and a differing dimension on every other axis.
    expect(listReadShapeKey({ includeArchived: true, includeDeleted: true, slim: true })).toBe(
      listReadShapeKey({ slim: true, includeDeleted: true, includeArchived: true }),
    );
    const pairs: Array<readonly [Record<string, unknown>, Record<string, unknown>]> = [
      [{ derive: false }, {}],
      [{ column: "in-progress" }, {}],
      [{ columns: ["in-progress"] }, { columns: ["todo"] }],
      [{ excludeColumns: ["done"] }, {}],
      [{ sort: "completion-desc" }, {}],
      [{ includeDeleted: true }, {}],
    ];
    for (const [left, right] of pairs) {
      expect(listReadShapeKey(left as never)).not.toBe(listReadShapeKey(right as never));
    }
    // A key carries the memo's six dimensions and nothing else: pagination must not join, so it is
    // excluded by the gate rather than becoming a seventh dimension.
    expect(listReadShapeKey({})).toBe(listReadShapeKey({ limit: 10, offset: 5 }));
  });

  it("never coalesces a paginated or keyset read", async () => {
    await seedCards(4);
    const store = h.store();

    const before = listReadCalls();
    const pages = await Promise.all([
      store.listTasks({ slim: true, limit: 2 }),
      store.listTasks({ slim: true, limit: 2 }),
    ]);
    expect(listReadCalls() - before).toBe(2);
    expect(Object.is(pages[0], pages[1])).toBe(false);
    expect(store.listReadInFlight.size).toBe(0);

    const keyedBefore = listReadCalls();
    const first = await store.listTasks({ slim: true, limit: 2 });
    const next = await store.listTasks({
      slim: true,
      limit: 2,
      afterCreatedAt: first[first.length - 1]!.createdAt,
      afterId: first[first.length - 1]!.id,
    });
    expect(listReadCalls() - keyedBefore).toBe(2);
    expect(next.map((task) => task.id).filter((id) => first.some((t) => t.id === id))).toEqual([]);
  });

  it("re-issues for a caller that starts after a committed write, and keeps the joined snapshot for one that did not", async () => {
    await seedCards(2);
    const store = h.store();
    const options = { slim: true, includeArchived: false, startupMemo: false } as const;
    const key = listReadShapeKey(options);

    // Gate the first read on a deferred we control: this is what makes the mutation-visibility
    // assertion deterministic instead of a race that happens to pass.
    let release!: (rows: Task[]) => void;
    const gated = new Promise<Task[]>((resolve) => {
      release = resolve;
    });
    const staleSnapshot = Object.freeze([{ id: "STALE-CARD" }] as unknown as Task[]);
    store.listReadInFlight.set(key, gated);

    const joiner = store.listTasks(options);
    const joinedBeforeCommit = await Promise.race([
      joiner.then((rows) => ({ settled: true, rows })),
      Promise.resolve({ settled: false as const, rows: undefined }),
    ]);
    expect(joinedBeforeCommit.settled).toBe(false);

    // The write lands while the first read is still in flight. Creating the card fires
    // `task:created`, whose listener is the invalidation seam.
    await store.createTaskWithReservedId(
      { description: "RUFU-627 committed during flight", column: "todo" },
      { taskId: "RUFU-9399", applyDefaultWorkflowSteps: false },
    );
    expect(store.listReadInFlight.has(key)).toBe(false);

    const afterWrite = await store.listTasks(options);
    expect(afterWrite.some((task) => task.id === "RUFU-9399")).toBe(true);

    release(staleSnapshot);
    const joined = await joiner;
    expect(Object.is(joined, staleSnapshot)).toBe(true);
    expect(joined.some((task) => task.id === "RUFU-9399")).toBe(false);
  });

  it("does not duplicate work when the startup memo and coalescing both apply", async () => {
    /*
    The memo is a separate mechanism with its own tests (`list-tasks-derive-optout.pg.test.ts`), and the
    harness store is not watching, so a `slim` read reaches the memo by default. This leg pins the
    interaction rather than pretending it away: the two records are the caller-visible read and the
    memo's own `startupMemo: false` recursion, and every later caller joins the single fetch the memo
    issued. Four records would mean the two mechanisms are duplicating each other.
    */
    await seedCards(3);
    const store = h.store();
    const memoized = { slim: true, includeArchived: false } as const;

    const before = listReadCalls();
    const rows = await Promise.all([
      store.listTasks(memoized),
      store.listTasks(memoized),
      store.listTasks(memoized),
      store.listTasks(memoized),
    ]);
    expect(listReadCalls() - before).toBe(2);
    for (const one of rows.slice(1)) expect(Object.is(one, rows[0])).toBe(true);
  });

  it("drops the in-flight entry once the fetch settles, so the map cannot grow", async () => {
    await seedCards(2);
    const store = h.store();
    const options = { slim: true, includeArchived: false, startupMemo: false } as const;

    expect(store.listReadInFlight.size).toBe(0);
    await store.listTasks(options);
    expect(store.listReadInFlight.size).toBe(0);

    // A rejected fetch must not leave a poisoned entry behind either.
    const failing = store.listTasks({ ...options, column: "no-such-column-xyz" } as never).catch(() => null);
    expect(store.listReadInFlight.size).toBeLessThanOrEqual(1);
    await failing;
    expect(store.listReadInFlight.size).toBe(0);
  });
});
