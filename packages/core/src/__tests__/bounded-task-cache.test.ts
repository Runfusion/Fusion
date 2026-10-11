import { describe, expect, it } from "vitest";
import { BoundedTaskCache } from "../task-store/bounded-task-cache.js";
import type { Task } from "../types.js";

/*
FNXC:TaskCacheMemory 2026-10-11-11:40:
The deployed board retained ~415k `log` entry objects in one heap because the per-store task cache
held full rows for every card its 64 write seams had touched, with no eviction. These tests pin the
invariant the fix has to keep: the cache bounds its own footprint, keeps object identity for the one
consumer that mutates cached rows in place, and NEVER loses the id index the deleted-task
reconciliation fallback depends on.
*/

function taskWithLog(id: string, logEntries: number): Task {
  return {
    id,
    log: Array.from({ length: logEntries }, (_, i) => ({
      timestamp: `2026-10-11T00:0${i % 6}:00.000Z`,
      action: `entry ${i}`,
    })),
  } as unknown as Task;
}

describe("BoundedTaskCache", () => {
  it("evicts least-recently-used rows once the entry budget is exceeded", () => {
    const cache = new BoundedTaskCache({ maxEntries: 3, maxLoggedEntries: 100_000 });
    for (const id of ["A", "B", "C", "D"]) cache.set(id, taskWithLog(id, 1));
    expect([...cache.keys()]).toEqual(["B", "C", "D"]);
    expect(cache.get("A")).toBeUndefined();
  });

  it("bounds the aggregate log entries it holds, not just the row count", () => {
    const cache = new BoundedTaskCache({ maxEntries: 100, maxLoggedEntries: 100 });
    cache.set("A", taskWithLog("A", 60));
    cache.set("B", taskWithLog("B", 60));
    expect(cache.get("A")).toBeUndefined();
    expect(cache.get("B")).toBeDefined();
    expect(cache.heldLoggedEntries).toBeLessThanOrEqual(100);
  });

  it("keeps the entry it has just set even when that single row exceeds the budget", () => {
    const cache = new BoundedTaskCache({ maxEntries: 100, maxLoggedEntries: 10 });
    cache.set("BIG", taskWithLog("BIG", 500));
    expect(cache.get("BIG")).toBeDefined();
  });

  it("re-reads the same object after a get, so an in-place mutator keeps writing to the cached row", () => {
    const cache = new BoundedTaskCache({ maxEntries: 2, maxLoggedEntries: 100_000 });
    const row = taskWithLog("A", 1);
    cache.set("A", row);
    cache.set("B", taskWithLog("B", 1));
    expect(cache.get("A")).toBe(row);
    cache.set("C", taskWithLog("C", 1));
    // `get("A")` refreshed its recency, so the oldest row is B and A survives.
    expect(cache.get("A")).toBeDefined();
    expect(cache.get("B")).toBeUndefined();
  });

  it("subtracts evicted log entries from the budget instead of drifting upward", () => {
    const cache = new BoundedTaskCache({ maxEntries: 2, maxLoggedEntries: 1_000 });
    cache.set("A", taskWithLog("A", 300));
    cache.set("B", taskWithLog("B", 300));
    cache.delete("A");
    expect(cache.heldLoggedEntries).toBe(300);
  });

  it("keeps the seen-id index after eviction and after clear(), which is what deletion reconciliation reads", () => {
    const cache = new BoundedTaskCache({ maxEntries: 1, maxLoggedEntries: 1_000 });
    cache.set("A", taskWithLog("A", 1));
    cache.set("B", taskWithLog("B", 1));
    expect([...cache.keys()]).toEqual(["B"]);
    expect(cache.seenIds).toEqual(["A", "B"]);

    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.heldLoggedEntries).toBe(0);
    expect(cache.seenIds).toEqual(["A", "B"]);
  });

  it("drops a row that has been idle past the TTL on the next write sweep", () => {
    let clock = 0;
    const cache = new BoundedTaskCache({
      maxEntries: 100, maxLoggedEntries: 100_000, idleTtlMs: 10_000, sweepIntervalMs: 100, now: () => clock,
    });
    cache.set("COLD", taskWithLog("COLD", 10));
    cache.set("WARM", taskWithLog("WARM", 10));
    clock = 5_000;
    expect(cache.get("WARM")).toBeDefined();   // within TTL, refreshes recency
    clock = 12_000;
    // COLD has been idle 12 s (past the 10 s TTL); WARM has been idle 7 s and must stay.
    cache.set("NEW", taskWithLog("NEW", 10));
    expect(cache.get("COLD")).toBeUndefined();
    expect(cache.get("WARM")).toBeDefined();
    expect(cache.get("NEW")).toBeDefined();
    expect(cache.expiredRowCount).toBe(1);
    // Budget accounting must follow the expired row out, or later sets evict for nothing.
    expect(cache.heldLoggedEntries).toBe(20);
  });

  it("expires an untouched row on read instead of returning stale data", () => {
    let clock = 0;
    const cache = new BoundedTaskCache({ maxEntries: 10, maxLoggedEntries: 100_000, idleTtlMs: 500, now: () => clock });
    cache.set("A", taskWithLog("A", 3));
    clock = 600;
    expect(cache.get("A")).toBeUndefined();
    expect(cache.heldLoggedEntries).toBe(0);
  });

  it("bounds the id index itself, dropping the coldest ids first", () => {
    const cache = new BoundedTaskCache({ maxEntries: 100, maxLoggedEntries: 100_000, seenIdCapacity: 2 });
    for (const id of ["A", "B", "C"]) cache.set(id, taskWithLog(id, 1));
    expect(cache.seenIds).toEqual(["B", "C"]);
  });

  it("re-members a re-cached id without duplicating the index", () => {
    const cache = new BoundedTaskCache({ maxEntries: 100, maxLoggedEntries: 100_000 });
    cache.set("A", taskWithLog("A", 1));
    cache.set("A", taskWithLog("A", 2));
    expect(cache.seenIds).toEqual(["A"]);
    expect(cache.heldLoggedEntries).toBe(2);
  });
});
