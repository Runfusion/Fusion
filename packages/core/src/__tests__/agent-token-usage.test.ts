import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentStore } from "../agent-store.js";
import { aggregateAgentTokenUsage } from "../agent-token-usage.js";
import { createTaskStoreTestHarness } from "./store-test-helpers.js";

describe("aggregateAgentTokenUsage", () => {
  const harness = createTaskStoreTestHarness();
  let agentStore: AgentStore;

  beforeEach(async () => {
    await harness.beforeEach();
    agentStore = new AgentStore({ rootDir: harness.rootDir() });
    await agentStore.init();
  });

  afterEach(async () => {
    await harness.afterEach();
  });

  it("returns null when agent does not exist", async () => {
    const result = await aggregateAgentTokenUsage({ taskStore: harness.store(), agentStore, agentId: "missing" });
    expect(result).toBeNull();
  });

  it("returns null for ephemeral agents", async () => {
    const ephemeral = await agentStore.createAgent({ name: "temp", role: "executor", reportsTo: "FN-1", metadata: { type: "spawned" } });
    const result = await aggregateAgentTokenUsage({ taskStore: harness.store(), agentStore, agentId: ephemeral.id });
    expect(result).toBeNull();
  });

  it("aggregates usage across windows", async () => {
    const agent = await agentStore.createAgent({ name: "exec", role: "executor" });
    await harness.store().createTask({
      description: "recent",
      assignedAgentId: agent.id,
      tokenUsage: {
        inputTokens: 100,
        outputTokens: 10,
        cachedTokens: 50,
        cacheWriteTokens: 5,
        totalTokens: 165,
        firstUsedAt: "2026-05-13T09:00:00.000Z",
        lastUsedAt: "2026-05-13T11:00:00.000Z",
      },
    });
    await harness.store().createTask({
      description: "older",
      assignedAgentId: agent.id,
      tokenUsage: {
        inputTokens: 40,
        outputTokens: 4,
        cachedTokens: 10,
        cacheWriteTokens: 1,
        totalTokens: 55,
        firstUsedAt: "2026-05-05T09:00:00.000Z",
        lastUsedAt: "2026-05-05T11:00:00.000Z",
      },
    });

    const result = await aggregateAgentTokenUsage({
      taskStore: harness.store(),
      agentStore,
      agentId: agent.id,
      now: new Date("2026-05-13T12:00:00.000Z"),
    });

    expect(result).not.toBeNull();
    expect(result?.allTime).toMatchObject({ totalInputTokens: 140, totalCachedTokens: 60, totalCacheWriteTokens: 6, totalOutputTokens: 14, nTasks: 2 });
    expect(result?.last24h).toMatchObject({ totalInputTokens: 100, totalCachedTokens: 50, totalCacheWriteTokens: 5, totalOutputTokens: 10, nTasks: 1 });
    expect(result?.last7d).toMatchObject({ totalInputTokens: 100, totalCachedTokens: 50, totalCacheWriteTokens: 5, totalOutputTokens: 10, nTasks: 1 });
  });
});
