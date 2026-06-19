import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTaskStoreTestHarness } from "./store-test-helpers.js";

describe("TaskStore", () => {
  const harness = createTaskStoreTestHarness();

  beforeEach(harness.beforeEach);
  afterEach(harness.afterEach);

  describe("task token usage persistence", () => {
    it("creates and reads tasks without token usage data as undefined", async () => {
      const task = await harness.store().createTask({
        description: "Task without token usage",
      });

      expect(task.tokenUsage).toBeUndefined();

      const detail = await harness.store().getTask(task.id);
      expect(detail.tokenUsage).toBeUndefined();
    });

    it("round-trips token usage totals and timestamps through create and read", async () => {
      const tokenUsage = {
        inputTokens: 120,
        outputTokens: 45,
        cachedTokens: 30,
        cacheWriteTokens: 9,
        totalTokens: 204,
        firstUsedAt: "2026-04-23T10:00:00.000Z",
        lastUsedAt: "2026-04-23T10:05:00.000Z",
        modelProvider: "anthropic",
        modelId: "claude-sonnet-4-5",
      };

      const task = await harness.store().createTask({
        description: "Task with token usage",
        tokenUsage,
      });

      expect(task.tokenUsage).toEqual(tokenUsage);

      const detail = await harness.store().getTask(task.id);
      expect(detail.tokenUsage).toEqual(tokenUsage);
    });

    it("round-trips token usage through update and preserves exact values", async () => {
      const task = await harness.store().createTask({ description: "Update token usage" });

      const tokenUsage = {
        inputTokens: 210,
        outputTokens: 80,
        cachedTokens: 40,
        cacheWriteTokens: 15,
        totalTokens: 345,
        firstUsedAt: "2026-04-23T12:00:00.000Z",
        lastUsedAt: "2026-04-23T12:30:00.000Z",
        modelProvider: "openai",
        modelId: "gpt-5",
      };

      const updated = await harness.store().updateTask(task.id, { tokenUsage });
      expect(updated.tokenUsage).toEqual(tokenUsage);

      const detail = await harness.store().getTask(task.id);
      expect(detail.tokenUsage).toEqual(tokenUsage);
    });

    it("persists token usage across TaskStore reinitialization", async () => {
      // Cross-instance persistence test — swap beforeEach's in-memory
      // store for disk-backed so the second `new TaskStore` below can
      // observe what this instance writes.
      harness.store().close();
      await harness.reopenDiskBackedStore();

      const tokenUsage = {
        inputTokens: 300,
        outputTokens: 120,
        cachedTokens: 50,
        cacheWriteTokens: 25,
        totalTokens: 495,
        firstUsedAt: "2026-04-23T13:00:00.000Z",
        lastUsedAt: "2026-04-23T13:45:00.000Z",
      };

      const created = await harness.store().createTask({
        description: "Reinit token usage persistence",
        tokenUsage,
      });

      harness.store().close();
      await harness.reopenDiskBackedStore();

      const reloaded = await harness.store().getTask(created.id);
      expect(reloaded.tokenUsage).toEqual(tokenUsage);
    });

    it("defaults legacy null cacheWriteTokens rows to 0 without dropping tokenUsage", async () => {
      const created = await harness.store().createTask({
        description: "Legacy null cache write",
        tokenUsage: {
          inputTokens: 10,
          outputTokens: 20,
          cachedTokens: 30,
          cacheWriteTokens: 40,
          totalTokens: 100,
          firstUsedAt: "2026-04-23T15:00:00.000Z",
          lastUsedAt: "2026-04-23T15:01:00.000Z",
        },
      });

      (harness.store() as any).db.prepare(`
        UPDATE tasks
        SET tokenUsageCacheWriteTokens = NULL
        WHERE id = ?
      `).run(created.id);

      const legacy = await harness.store().getTask(created.id);
      expect(legacy.tokenUsage).toMatchObject({
        inputTokens: 10,
        outputTokens: 20,
        cachedTokens: 30,
        cacheWriteTokens: 0,
        totalTokens: 100,
      });
    });

    it("round-trips cacheWriteTokens specifically", async () => {
      const tokenUsage = {
        inputTokens: 1,
        outputTokens: 2,
        cachedTokens: 3,
        cacheWriteTokens: 1234,
        totalTokens: 1240,
        firstUsedAt: "2026-04-23T15:00:00.000Z",
        lastUsedAt: "2026-04-23T15:01:00.000Z",
      };

      const task = await harness.store().createTask({
        description: "Cache write token round-trip",
        tokenUsage,
      });

      const detail = await harness.store().getTask(task.id);
      expect(detail.tokenUsage?.cacheWriteTokens).toBe(1234);
      expect(detail.tokenUsage).toEqual(tokenUsage);
    });

    it("round-trips token budget alert sentinels and overrides", async () => {
      const created = await harness.store().createTask({
        description: "Token budget fields",
      });
      await harness.store().updateTask(created.id, {
        tokenBudgetSoftAlertedAt: "2026-05-14T01:00:00.000Z",
        tokenBudgetHardAlertedAt: "2026-05-14T01:05:00.000Z",
        tokenBudgetOverride: {
          soft: 1_000_000,
          hard: 2_000_000,
          raisedAt: "2026-05-14T01:06:00.000Z",
          reason: "manual override",
        },
      });

      const reloaded = await harness.store().getTask(created.id);
      expect(reloaded.tokenBudgetSoftAlertedAt).toBe("2026-05-14T01:00:00.000Z");
      expect(reloaded.tokenBudgetHardAlertedAt).toBe("2026-05-14T01:05:00.000Z");
      expect(reloaded.tokenBudgetOverride).toEqual({
        soft: 1_000_000,
        hard: 2_000_000,
        raisedAt: "2026-05-14T01:06:00.000Z",
        reason: "manual override",
      });
    });

    it("clears token usage via null update and keeps it absent after reload", async () => {
      // Cross-instance persistence test — see counterpart above.
      harness.store().close();
      await harness.reopenDiskBackedStore();

      const task = await harness.store().createTask({
        description: "Clear token usage",
        tokenUsage: {
          inputTokens: 99,
          outputTokens: 44,
          cachedTokens: 11,
          cacheWriteTokens: 3,
          totalTokens: 157,
          firstUsedAt: "2026-04-23T14:00:00.000Z",
          lastUsedAt: "2026-04-23T14:01:00.000Z",
        },
      });

      const cleared = await harness.store().updateTask(task.id, { tokenUsage: null });
      expect(cleared.tokenUsage).toBeUndefined();

      harness.store().close();
      await harness.reopenDiskBackedStore();

      const reloaded = await harness.store().getTask(task.id);
      expect(reloaded.tokenUsage).toBeUndefined();
    });
  });
});
