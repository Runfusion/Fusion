import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TaskStore } from "../store.js";

describe("TaskStore inReviewStalled hydration", () => {
  let rootDir: string;
  let globalDir: string;
  let store: TaskStore;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "store-in-review-stalled-"));
    globalDir = join(rootDir, ".fusion-global-settings");
    store = new TaskStore(rootDir, globalDir, { inMemoryDb: true });
    await store.init();
  });

  afterEach(async () => {
    await store.close();
    await rm(rootDir, { recursive: true, force: true });
  });

  async function seedTask(
    id: string,
    overrides: { paused?: boolean; ageMs?: number; column?: "in-review" | "todo"; mergeConfirmed?: boolean; log?: unknown[] },
  ) {
    const now = Date.now();
    const ageMs = overrides.ageMs ?? 24 * 60 * 60_000 + 1_000;
    const movedAt = new Date(now - ageMs).toISOString();
    const column = overrides.column ?? "in-review";
    await store.createTaskWithReservedId(
      { description: id, column },
      { taskId: id, createdAt: movedAt, updatedAt: movedAt, applyDefaultWorkflowSteps: false },
    );
    const db = (store as unknown as { db: { prepare: (sql: string) => { run: (...params: unknown[]) => unknown } } }).db;
    db.prepare(`UPDATE tasks
      SET paused = ?, mergeDetails = ?, columnMovedAt = ?, updatedAt = ?, log = ?
      WHERE id = ?`).run(
      overrides.paused ? 1 : 0,
      JSON.stringify(overrides.mergeConfirmed ? { mergeConfirmed: true } : {}),
      movedAt,
      movedAt,
      JSON.stringify(overrides.log ?? []),
      id,
    );
  }

  it("hydrates inReviewStalled for unpaused in-review task quiet beyond threshold", async () => {
    await seedTask("FN-5093-S1", { paused: false });
    const task = (await store.listTasks({ slim: true })).find((entry) => entry.id === "FN-5093-S1");
    expect(task?.inReviewStalled?.code).toBe("in-review-stalled");
  });

  it("respects inReviewStalledThresholdMs override", async () => {
    await store.updateSettings({ inReviewStalledThresholdMs: 2_000 });
    await seedTask("FN-5093-S2", { paused: false, ageMs: 2_500 });
    const task = (await store.listTasks({ slim: true })).find((entry) => entry.id === "FN-5093-S2");
    expect(task?.inReviewStalled?.thresholdMs).toBe(2_000);
  });

  it("disables hydration when inReviewStalledThresholdMs is zero", async () => {
    await store.updateSettings({ inReviewStalledThresholdMs: 0 });
    await seedTask("FN-5093-S3", { paused: false });
    const task = (await store.listTasks({ slim: true })).find((entry) => entry.id === "FN-5093-S3");
    expect(task?.inReviewStalled).toBeUndefined();
  });

  it("suppresses hydration when autoMerge is false", async () => {
    await store.updateSettings({ autoMerge: false });
    await seedTask("FN-5093-S4", { paused: false });
    const task = (await store.listTasks({ slim: true })).find((entry) => entry.id === "FN-5093-S4");
    expect(task?.inReviewStalled).toBeUndefined();
  });

  it("does not overlap with stalePausedReview for paused in-review tasks", async () => {
    await seedTask("FN-5093-S5", { paused: true });
    const task = (await store.listTasks({ slim: true })).find((entry) => entry.id === "FN-5093-S5");
    expect(task?.inReviewStalled).toBeUndefined();
    expect(task?.stalePausedReview?.code).toBe("stale-paused-review");
  });
});
