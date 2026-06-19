import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { Database } from "../db.js";
import { costFor } from "../model-pricing.js";
import { aggregateTokenAnalytics } from "../token-analytics.js";

interface TaskSeed {
  id: string;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number | null;
  lastUsedAt: string | null;
  modelProvider?: string | null;
  modelId?: string | null;
  tokenUsageModelProvider?: string | null;
  tokenUsageModelId?: string | null;
  tokenUsagePerModel?: unknown;
  nodeId?: string | null;
  agentId?: string | null;
}

function insertTask(db: Database, t: TaskSeed): void {
  db.prepare(
    `INSERT INTO tasks
       (id, description, "column", createdAt, updatedAt,
        tokenUsageInputTokens, tokenUsageOutputTokens, tokenUsageCachedTokens,
        tokenUsageCacheWriteTokens, tokenUsageTotalTokens, tokenUsageLastUsedAt,
        modelProvider, modelId, tokenUsageModelProvider, tokenUsageModelId, tokenUsagePerModel, checkoutNodeId, assignedAgentId)
     VALUES (?, 'desc', 'todo', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
             ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    t.id,
    t.inputTokens ?? null,
    t.outputTokens ?? null,
    t.cachedTokens ?? null,
    t.cacheWriteTokens ?? null,
    t.totalTokens === undefined ? null : t.totalTokens,
    t.lastUsedAt,
    t.modelProvider ?? null,
    t.modelId ?? null,
    t.tokenUsageModelProvider ?? null,
    t.tokenUsageModelId ?? null,
    t.tokenUsagePerModel === undefined ? null : JSON.stringify(t.tokenUsagePerModel),
    t.nodeId ?? null,
    t.agentId ?? null,
  );
}

describe("token-analytics", () => {
  let tmpDir: string;
  let db: Database;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "kb-token-analytics-"));
    db = new Database(join(tmpDir, ".fusion"));
    db.init();
  });

  afterEach(async () => {
    db.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns correct per-model token totals for 5 tasks across 2 models", () => {
    // 3 tasks on model-A, 2 on model-B, all within range.
    insertTask(db, { id: "t1", inputTokens: 100, outputTokens: 50, totalTokens: 150, lastUsedAt: "2026-03-01T00:00:00.000Z", modelId: "model-A", modelProvider: "anthropic" });
    insertTask(db, { id: "t2", inputTokens: 200, outputTokens: 80, totalTokens: 280, lastUsedAt: "2026-03-02T00:00:00.000Z", modelId: "model-A", modelProvider: "anthropic" });
    insertTask(db, { id: "t3", inputTokens: 300, outputTokens: 20, totalTokens: 320, lastUsedAt: "2026-03-03T00:00:00.000Z", modelId: "model-A", modelProvider: "anthropic" });
    insertTask(db, { id: "t4", inputTokens: 10, outputTokens: 5, totalTokens: 15, lastUsedAt: "2026-03-04T00:00:00.000Z", modelId: "model-B", modelProvider: "openai" });
    insertTask(db, { id: "t5", inputTokens: 40, outputTokens: 60, totalTokens: 100, lastUsedAt: "2026-03-05T00:00:00.000Z", modelId: "model-B", modelProvider: "openai" });

    const result = aggregateTokenAnalytics(db, {
      from: "2026-03-01T00:00:00.000Z",
      to: "2026-03-31T00:00:00.000Z",
      groupBy: "model",
    });

    expect(result.totals.inputTokens).toBe(650);
    expect(result.totals.outputTokens).toBe(215);
    expect(result.totals.totalTokens).toBe(865);
    expect(result.totals.nTasks).toBe(5);

    const groups = new Map(result.groups.map((g) => [g.key, g]));
    expect(groups.get("model-A")!.inputTokens).toBe(600);
    expect(groups.get("model-A")!.totalTokens).toBe(750);
    expect(groups.get("model-A")!.nTasks).toBe(3);
    expect(groups.get("model-B")!.inputTokens).toBe(50);
    expect(groups.get("model-B")!.totalTokens).toBe(115);
    expect(groups.get("model-B")!.nTasks).toBe(2);
    // groups sorted descending by totalTokens
    expect(result.groups[0].key).toBe("model-A");
  });

  it("expands one multi-model task into per-model and per-provider token groups", () => {
    const perModel = [
      {
        modelProvider: "anthropic",
        modelId: "claude-sonnet-4-5",
        inputTokens: 700,
        outputTokens: 300,
        cachedTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 1000,
        firstUsedAt: "2026-03-01T00:00:00.000Z",
        lastUsedAt: "2026-03-01T00:01:00.000Z",
      },
      {
        modelProvider: "openai",
        modelId: "gpt-5",
        inputTokens: 250,
        outputTokens: 150,
        cachedTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 400,
        firstUsedAt: "2026-03-01T00:02:00.000Z",
        lastUsedAt: "2026-03-01T00:03:00.000Z",
      },
    ];
    insertTask(db, {
      id: "multi-model",
      inputTokens: 950,
      outputTokens: 450,
      cachedTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 1400,
      lastUsedAt: "2026-03-01T00:03:00.000Z",
      tokenUsageModelProvider: "openai",
      tokenUsageModelId: "gpt-5",
      tokenUsagePerModel: perModel,
    });

    const byModel = aggregateTokenAnalytics(db, { groupBy: "model" });
    const modelGroups = new Map(byModel.groups.map((group) => [group.key, group]));

    expect(byModel.totals.totalTokens).toBe(1400);
    expect(byModel.totals.nTasks).toBe(1);
    expect(modelGroups.get("claude-sonnet-4-5")).toMatchObject({ totalTokens: 1000, inputTokens: 700, outputTokens: 300, nTasks: 1 });
    expect(modelGroups.get("claude-sonnet-4-5")?.cost).toEqual(costFor(
      { inputTokens: 700, outputTokens: 300, cachedTokens: 0, cacheWriteTokens: 0 },
      { provider: "anthropic", model: "claude-sonnet-4-5" },
    ));
    expect(modelGroups.get("gpt-5")).toMatchObject({ totalTokens: 400, inputTokens: 250, outputTokens: 150, nTasks: 1 });
    expect(modelGroups.get("gpt-5")?.cost).toEqual(costFor(
      { inputTokens: 250, outputTokens: 150, cachedTokens: 0, cacheWriteTokens: 0 },
      { provider: "openai", model: "gpt-5" },
    ));
    expect(modelGroups.size).toBe(2);
    expect([...modelGroups.values()].reduce((sum, group) => sum + group.nTasks, 0)).toBe(2);

    const expectedTaskCost = costFor(
      { inputTokens: 950, outputTokens: 450, cachedTokens: 0, cacheWriteTokens: 0 },
      { provider: "openai", model: "gpt-5" },
    );
    expect(byModel.cost).toEqual(expectedTaskCost);

    const byProvider = aggregateTokenAnalytics(db, { groupBy: "provider" });
    expect(byProvider.totals).toEqual(byModel.totals);
    expect(new Map(byProvider.groups.map((group) => [group.key, group.totalTokens]))).toEqual(
      new Map([["anthropic", 1000], ["openai", 400]]),
    );
  });

  it("marks unpriced per-model buckets as cost unavailable instead of zero", () => {
    insertTask(db, {
      id: "unpriced-bucket",
      inputTokens: 60,
      outputTokens: 40,
      totalTokens: 100,
      lastUsedAt: "2026-03-01T00:00:00.000Z",
      tokenUsageModelProvider: "openai",
      tokenUsageModelId: "gpt-5",
      tokenUsagePerModel: [
        {
          modelProvider: "unknown-provider",
          modelId: "unknown-model",
          inputTokens: 60,
          outputTokens: 40,
          cachedTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 100,
          firstUsedAt: "2026-03-01T00:00:00.000Z",
          lastUsedAt: "2026-03-01T00:00:00.000Z",
        },
      ],
    });

    const result = aggregateTokenAnalytics(db, { groupBy: "model" });

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]).toMatchObject({ key: "unknown-model", totalTokens: 100, cost: { usd: null, unavailable: true } });
    expect(result.cost).toEqual(costFor(
      { inputTokens: 60, outputTokens: 40, cachedTokens: 0, cacheWriteTokens: 0 },
      { provider: "openai", model: "gpt-5" },
    ));
  });

  it("falls back to the legacy snapshot when per-model JSON is malformed", () => {
    insertTask(db, {
      id: "malformed-per-model",
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      lastUsedAt: "2026-03-01T00:00:00.000Z",
      tokenUsageModelProvider: "openai",
      tokenUsageModelId: "gpt-5",
      tokenUsagePerModel: "not-json",
    });

    const result = aggregateTokenAnalytics(db, { groupBy: "model" });

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]).toMatchObject({ key: "gpt-5", totalTokens: 15, nTasks: 1 });
  });

  it("groups resolved-via-settings token usage by the actually-used model snapshot", () => {
    insertTask(db, { id: "t1", inputTokens: 100, outputTokens: 50, totalTokens: 150, lastUsedAt: "2026-03-01T00:00:00.000Z", modelId: null, modelProvider: null, tokenUsageModelId: "claude-sonnet-4-5", tokenUsageModelProvider: "anthropic" });
    insertTask(db, { id: "t2", inputTokens: 25, outputTokens: 25, totalTokens: 50, lastUsedAt: "2026-03-02T00:00:00.000Z", modelId: null, modelProvider: null, tokenUsageModelId: "gpt-5", tokenUsageModelProvider: "openai" });
    insertTask(db, { id: "t3", inputTokens: 30, outputTokens: 20, totalTokens: 50, lastUsedAt: "2026-03-03T00:00:00.000Z", modelId: null, modelProvider: null, tokenUsageModelId: "gpt-5", tokenUsageModelProvider: "openai" });

    const result = aggregateTokenAnalytics(db, { groupBy: "model" });

    const groups = new Map(result.groups.map((g) => [g.key, g]));
    expect([...groups.keys()].sort()).toEqual(["claude-sonnet-4-5", "gpt-5"]);
    expect(groups.get("claude-sonnet-4-5")).toMatchObject({ totalTokens: 150, inputTokens: 100, outputTokens: 50, nTasks: 1 });
    expect(groups.get("gpt-5")).toMatchObject({ totalTokens: 100, inputTokens: 55, outputTokens: 45, nTasks: 2 });
    expect(groups.has(null)).toBe(false);
  });

  it("groups providers by the token-usage snapshot before task own-provider", () => {
    insertTask(db, { id: "t1", inputTokens: 100, totalTokens: 100, lastUsedAt: "2026-03-01T00:00:00.000Z", modelProvider: null, tokenUsageModelProvider: "anthropic", tokenUsageModelId: "claude-sonnet-4-5" });
    insertTask(db, { id: "t2", inputTokens: 200, totalTokens: 200, lastUsedAt: "2026-03-02T00:00:00.000Z", modelProvider: null, tokenUsageModelProvider: "openai", tokenUsageModelId: "gpt-5" });
    insertTask(db, { id: "t3", inputTokens: 25, totalTokens: 25, lastUsedAt: "2026-03-03T00:00:00.000Z", modelProvider: "legacy-provider", tokenUsageModelProvider: "openai", tokenUsageModelId: "gpt-5" });

    const result = aggregateTokenAnalytics(db, { groupBy: "provider" });

    expect(new Map(result.groups.map((g) => [g.key, g.totalTokens]))).toEqual(
      new Map([["anthropic", 100], ["openai", 225]]),
    );
  });

  it("falls back to legacy task model columns when no token snapshot exists", () => {
    insertTask(db, { id: "legacy", inputTokens: 40, totalTokens: 40, lastUsedAt: "2026-03-01T00:00:00.000Z", modelProvider: "anthropic", modelId: "legacy-model" });

    const result = aggregateTokenAnalytics(db, { groupBy: "model" });

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]).toMatchObject({ key: "legacy-model", totalTokens: 40, nTasks: 1 });
  });

  it("keeps own-model and resolved-model token snapshots as distinct model groups", () => {
    insertTask(db, { id: "own", inputTokens: 100, totalTokens: 100, lastUsedAt: "2026-03-01T00:00:00.000Z", modelProvider: "anthropic", modelId: "own-model", tokenUsageModelProvider: "anthropic", tokenUsageModelId: "own-model" });
    insertTask(db, { id: "resolved", inputTokens: 75, totalTokens: 75, lastUsedAt: "2026-03-02T00:00:00.000Z", modelProvider: null, modelId: null, tokenUsageModelProvider: "openai", tokenUsageModelId: "resolved-model" });

    const result = aggregateTokenAnalytics(db, { groupBy: "model" });

    expect(new Map(result.groups.map((g) => [g.key, g.totalTokens]))).toEqual(
      new Map([["own-model", 100], ["resolved-model", 75]]),
    );
  });

  it("groups by provider, node, and agent", () => {
    insertTask(db, { id: "t1", inputTokens: 100, totalTokens: 100, lastUsedAt: "2026-03-01T00:00:00.000Z", modelProvider: "anthropic", nodeId: "node-1", agentId: "agent-x" });
    insertTask(db, { id: "t2", inputTokens: 200, totalTokens: 200, lastUsedAt: "2026-03-02T00:00:00.000Z", modelProvider: "openai", nodeId: "node-1", agentId: "agent-y" });

    const byProvider = aggregateTokenAnalytics(db, { groupBy: "provider" });
    expect(new Map(byProvider.groups.map((g) => [g.key, g.totalTokens]))).toEqual(
      new Map([["anthropic", 100], ["openai", 200]]),
    );

    const byNode = aggregateTokenAnalytics(db, { groupBy: "node" });
    expect(byNode.groups).toHaveLength(1);
    expect(byNode.groups[0].key).toBe("node-1");
    expect(byNode.groups[0].totalTokens).toBe(300);

    const byAgent = aggregateTokenAnalytics(db, { groupBy: "agent" });
    expect(new Map(byAgent.groups.map((g) => [g.key, g.totalTokens]))).toEqual(
      new Map([["agent-x", 100], ["agent-y", 200]]),
    );
  });

  it("empty range returns zeroed structures, not nulls", () => {
    insertTask(db, { id: "t1", inputTokens: 100, totalTokens: 100, lastUsedAt: "2026-03-01T00:00:00.000Z", modelId: "model-A" });

    const result = aggregateTokenAnalytics(db, {
      from: "2027-01-01T00:00:00.000Z",
      to: "2027-12-31T00:00:00.000Z",
      groupBy: "model",
    });
    expect(result.totals).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
      nTasks: 0,
    });
    expect(result.groups).toEqual([]);
  });

  it("includes a boundary task exactly at `from` (inclusive lower bound)", () => {
    insertTask(db, { id: "boundary", inputTokens: 42, totalTokens: 42, lastUsedAt: "2026-03-01T00:00:00.000Z", modelId: "model-A" });

    const result = aggregateTokenAnalytics(db, {
      from: "2026-03-01T00:00:00.000Z",
      to: "2026-03-31T00:00:00.000Z",
    });
    expect(result.totals.nTasks).toBe(1);
    expect(result.totals.inputTokens).toBe(42);
  });

  it("excludes tasks with no token usage (lastUsedAt null)", () => {
    insertTask(db, { id: "no-usage", lastUsedAt: null, modelId: "model-A" });
    insertTask(db, { id: "has-usage", inputTokens: 5, totalTokens: 5, lastUsedAt: "2026-03-01T00:00:00.000Z", modelId: "model-A" });

    const result = aggregateTokenAnalytics(db, {});
    expect(result.totals.nTasks).toBe(1);
    expect(result.totals.inputTokens).toBe(5);
  });

  it("derives totalTokens from parts when the persisted total is null", () => {
    insertTask(db, { id: "t1", inputTokens: 10, outputTokens: 20, cachedTokens: 5, cacheWriteTokens: 1, totalTokens: null, lastUsedAt: "2026-03-01T00:00:00.000Z", modelId: "model-A" });
    const result = aggregateTokenAnalytics(db, {});
    expect(result.totals.totalTokens).toBe(36);
  });

  it("omits series unless granularity is requested while preserving totals", () => {
    insertTask(db, { id: "t1", inputTokens: 10, totalTokens: 10, lastUsedAt: "2026-03-01T00:00:00.000Z", modelId: "model-A" });

    const result = aggregateTokenAnalytics(db, {});

    expect(result.totals.totalTokens).toBe(10);
    expect(result).not.toHaveProperty("series");
  });

  it("buckets token usage by UTC day in ascending order with inclusive bounds", () => {
    insertTask(db, { id: "before", inputTokens: 1, totalTokens: 1, lastUsedAt: "2026-02-29T23:59:59.999Z", modelId: "model-A" });
    insertTask(db, { id: "from", inputTokens: 100, outputTokens: 10, totalTokens: 110, lastUsedAt: "2026-03-01T00:00:00.000Z", modelId: "model-A" });
    insertTask(db, { id: "same-day", inputTokens: 200, outputTokens: 20, totalTokens: 220, lastUsedAt: "2026-03-01T12:00:00.000Z", modelId: "model-A" });
    insertTask(db, { id: "to", inputTokens: 300, outputTokens: 30, totalTokens: 330, lastUsedAt: "2026-03-02T00:00:00.000Z", modelId: "model-A" });
    insertTask(db, { id: "after", inputTokens: 1, totalTokens: 1, lastUsedAt: "2026-03-02T00:00:00.001Z", modelId: "model-A" });

    const result = aggregateTokenAnalytics(db, {
      from: "2026-03-01T00:00:00.000Z",
      to: "2026-03-02T00:00:00.000Z",
      granularity: "day",
    });

    expect(result.series?.map((p) => p.bucket)).toEqual(["2026-03-01", "2026-03-02"]);
    expect(result.series?.map((p) => p.totalTokens)).toEqual([330, 330]);
    expect(result.totals.totalTokens).toBe(660);
  });

  it("buckets token usage by UTC hour", () => {
    insertTask(db, { id: "h1a", inputTokens: 10, totalTokens: 10, lastUsedAt: "2026-03-01T01:05:00.000Z", modelId: "model-A" });
    insertTask(db, { id: "h1b", inputTokens: 20, totalTokens: 20, lastUsedAt: "2026-03-01T01:59:00.000Z", modelId: "model-A" });
    insertTask(db, { id: "h2", inputTokens: 30, totalTokens: 30, lastUsedAt: "2026-03-01T02:00:00.000Z", modelId: "model-A" });

    const result = aggregateTokenAnalytics(db, { granularity: "hour" });

    expect(result.series?.map((p) => [p.bucket, p.totalTokens])).toEqual([
      ["2026-03-01T01", 30],
      ["2026-03-01T02", 30],
    ]);
  });

  it("buckets token usage by ISO week across year boundaries", () => {
    insertTask(db, { id: "w1", inputTokens: 10, totalTokens: 10, lastUsedAt: "2026-12-31T12:00:00.000Z", modelId: "model-A" });
    insertTask(db, { id: "w1b", inputTokens: 20, totalTokens: 20, lastUsedAt: "2027-01-01T12:00:00.000Z", modelId: "model-A" });
    insertTask(db, { id: "w2", inputTokens: 30, totalTokens: 30, lastUsedAt: "2027-01-04T00:00:00.000Z", modelId: "model-A" });

    const result = aggregateTokenAnalytics(db, { granularity: "week" });

    expect(result.series?.map((p) => [p.bucket, p.totalTokens])).toEqual([
      ["2026-W53", 30],
      ["2027-W01", 30],
    ]);
  });

  it("computes per-bucket cost with priced and unavailable models", () => {
    insertTask(db, { id: "priced", inputTokens: 1_000_000, outputTokens: 1_000_000, cachedTokens: 0, cacheWriteTokens: 0, totalTokens: 2_000_000, lastUsedAt: "2026-03-01T00:00:00.000Z", modelProvider: "openai", modelId: "gpt-4o" });
    insertTask(db, { id: "unknown", inputTokens: 100, totalTokens: 100, lastUsedAt: "2026-03-01T10:00:00.000Z", modelProvider: "unknown", modelId: "mystery" });

    const result = aggregateTokenAnalytics(db, { granularity: "day" });

    expect(result.series).toHaveLength(1);
    expect(result.series?.[0].cost).toEqual({ usd: 12.5, unavailable: true, stale: false });
  });

  it("prices resolved-model token usage costs from the usage snapshot across analytics surfaces", () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000, cachedTokens: 0, cacheWriteTokens: 0 };
    const expected = costFor(usage, { provider: "openai", model: "gpt-4o" });
    expect(expected).toEqual({ usd: 12.5, unavailable: false, stale: false });

    insertTask(db, {
      id: "resolved",
      ...usage,
      totalTokens: 2_000_000,
      lastUsedAt: "2026-03-01T00:00:00.000Z",
      modelProvider: null,
      modelId: null,
      tokenUsageModelProvider: "openai",
      tokenUsageModelId: "gpt-4o",
      nodeId: "node-resolved",
      agentId: "agent-resolved",
    });

    const byModel = aggregateTokenAnalytics(db, { groupBy: "model" });
    const modelGroup = byModel.groups.find((group) => group.key === "gpt-4o");
    expect(modelGroup?.cost).toEqual(expected);
    expect(modelGroup?.cost.unavailable).toBe(false);
    expect(byModel.cost).toEqual(expected);

    const byProvider = aggregateTokenAnalytics(db, { groupBy: "provider" });
    expect(byProvider.groups.find((group) => group.key === "openai")?.cost).toEqual(expected);

    const byNode = aggregateTokenAnalytics(db, { groupBy: "node" });
    expect(byNode.groups.find((group) => group.key === "node-resolved")?.cost).toEqual(expected);

    const byAgent = aggregateTokenAnalytics(db, { groupBy: "agent" });
    expect(byAgent.groups.find((group) => group.key === "agent-resolved")?.cost).toEqual(expected);

    const byDay = aggregateTokenAnalytics(db, { granularity: "day" });
    expect(byDay.series).toHaveLength(1);
    expect(byDay.series?.[0].cost).toEqual(expected);
  });

  it("keeps token cost fallback and snapshot precedence guess-free", () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000, cachedTokens: 0, cacheWriteTokens: 0 };
    const legacyExpected = costFor(usage, { provider: "openai", model: "gpt-4o-mini" });
    const snapshotExpected = costFor(usage, { provider: "openai", model: "gpt-4o" });
    expect(legacyExpected.usd).not.toBe(snapshotExpected.usd);

    insertTask(db, {
      id: "legacy-priced",
      ...usage,
      totalTokens: 2_000_000,
      lastUsedAt: "2026-03-01T00:00:00.000Z",
      modelProvider: "openai",
      modelId: "gpt-4o-mini",
    });
    insertTask(db, {
      id: "snapshot-wins",
      ...usage,
      totalTokens: 2_000_000,
      lastUsedAt: "2026-03-02T00:00:00.000Z",
      modelProvider: "openai",
      modelId: "gpt-4o-mini",
      tokenUsageModelProvider: "openai",
      tokenUsageModelId: "gpt-4o",
    });
    insertTask(db, {
      id: "unpriced-snapshot",
      inputTokens: 100,
      totalTokens: 100,
      lastUsedAt: "2026-03-03T00:00:00.000Z",
      modelProvider: "openai",
      modelId: "gpt-4o",
      tokenUsageModelProvider: "unknown",
      tokenUsageModelId: "mystery-model",
    });

    const result = aggregateTokenAnalytics(db, { groupBy: "model" });
    const groups = new Map(result.groups.map((group) => [group.key, group]));

    expect(groups.get("gpt-4o-mini")?.cost).toEqual(legacyExpected);
    expect(groups.get("gpt-4o")?.cost).toEqual(snapshotExpected);
    expect(groups.get("mystery-model")?.cost).toEqual({ usd: null, unavailable: true, stale: false });
  });

  it("returns an empty series for an empty requested range", () => {
    insertTask(db, { id: "t1", inputTokens: 100, totalTokens: 100, lastUsedAt: "2026-03-01T00:00:00.000Z", modelId: "model-A" });

    const result = aggregateTokenAnalytics(db, {
      from: "2027-01-01T00:00:00.000Z",
      to: "2027-12-31T00:00:00.000Z",
      granularity: "day",
    });

    expect(result.series).toEqual([]);
    expect(result.totals.totalTokens).toBe(0);
  });
});
