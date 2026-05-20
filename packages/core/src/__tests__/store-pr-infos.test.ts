import { describe, expect, it, beforeEach, afterEach } from "vitest";
import type { PrInfo } from "../types.js";
import { createTaskStoreTestHarness } from "./store-test-helpers.js";

describe("TaskStore prInfos", () => {
  const harness = createTaskStoreTestHarness();
  let store: ReturnType<typeof harness.store>;

  const pr = (number: number, patch: Partial<PrInfo> = {}): PrInfo => ({
    url: `https://github.com/acme/repo/pull/${number}`,
    number,
    status: "open",
    title: `PR ${number}`,
    headBranch: `feature/${number}`,
    baseBranch: "main",
    commentCount: 0,
    ...patch,
  });

  beforeEach(async () => {
    await harness.beforeEach();
    store = harness.store();
  });

  afterEach(async () => {
    await harness.afterEach();
  });

  it("round-trips prInfos through sqlite row + rehydrate", async () => {
    const task = await harness.createTestTask();
    await store.addPrInfo(task.id, pr(11));
    await store.addPrInfo(task.id, pr(22));

    const db = (store as any).db;
    const row = db.prepare("SELECT prInfos FROM tasks WHERE id = ?").get(task.id) as { prInfos: string | null };
    expect(row.prInfos).toContain('"number":22');
    expect(row.prInfos).toContain('"number":11');

    const reopened = await store.getTask(task.id);
    expect(reopened.prInfos?.map((entry) => entry.number)).toEqual([22, 11]);
    expect(reopened.prInfo?.number).toBe(22);
  });

  it("materializes legacy prInfo into prInfos without writing back on read", async () => {
    const task = await harness.createTestTask();
    await store.updatePrInfo(task.id, pr(33));
    const db = (store as any).db;
    db.prepare("UPDATE tasks SET prInfos = NULL WHERE id = ?").run(task.id);

    const migrated = await store.getTask(task.id);
    expect(migrated.prInfos?.map((entry) => entry.number)).toEqual([33]);

    const row = db.prepare("SELECT prInfos FROM tasks WHERE id = ?").get(task.id) as { prInfos: string | null };
    expect(row.prInfos).toBeNull();
  });

  it("supports add/update/remove by PR number", async () => {
    const task = await harness.createTestTask();
    await store.addPrInfo(task.id, pr(1));
    await store.addPrInfo(task.id, pr(2));
    await store.updatePrInfoByNumber(task.id, 1, { status: "merged" });
    const updated = await store.removePrInfoByNumber(task.id, 2);

    expect(updated?.prInfos).toHaveLength(1);
    expect(updated?.prInfos?.[0].number).toBe(1);
    expect(updated?.prInfos?.[0].status).toBe("merged");
  });

  it("keeps primary mirror on most recently checked open PR", async () => {
    const task = await harness.createTestTask();
    await store.addPrInfo(task.id, pr(1, { lastCheckedAt: "2026-05-17T10:00:00.000Z" }));
    await store.addPrInfo(task.id, pr(2, { lastCheckedAt: "2026-05-17T11:00:00.000Z" }));
    await store.updatePrInfoByNumber(task.id, 1, { lastCheckedAt: "2026-05-17T12:00:00.000Z" });

    const current = await store.getTask(task.id);
    expect(current.prInfo?.number).toBe(1);
  });

  it("legacy updatePrInfo(null) clears prInfo and prInfos", async () => {
    const task = await harness.createTestTask();
    await store.addPrInfo(task.id, pr(1));
    await store.addPrInfo(task.id, pr(2));
    const cleared = await store.updatePrInfo(task.id, null);

    expect(cleared.prInfo).toBeUndefined();
    expect(cleared.prInfos).toBeUndefined();
  });
});
