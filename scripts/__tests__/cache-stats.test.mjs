import test from "node:test";
import assert from "node:assert/strict";
import { collectCacheStats } from "../cache-stats.mjs";

test("collectCacheStats groups role and permanent-agent totals", async () => {
  const taskStore = {
    async listTasks() {
      return [
        { assignedAgentId: "a1", tokenUsage: { inputTokens: 100, cachedTokens: 50, cacheWriteTokens: 10, outputTokens: 20 } },
        { assignedAgentId: "a2", tokenUsage: { inputTokens: 200, cachedTokens: 100, cacheWriteTokens: 5, outputTokens: 50 } },
        { assignedAgentId: "missing", tokenUsage: { inputTokens: 10, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 2 } },
      ];
    },
  };
  const agentStore = {
    async listAgents() {
      return [
        { id: "a1", role: "executor", metadata: { type: "permanent" } },
        { id: "a2", role: "reviewer", metadata: { type: "spawned" } },
      ];
    },
  };

  const result = await collectCacheStats({ taskStore, agentStore });

  assert.equal(result.byRole.find((r) => r.role === "executor")?.total_cached, 50);
  assert.equal(result.byRole.find((r) => r.role === "reviewer")?.total_input, 200);
  assert.equal(result.byRole.find((r) => r.role === "unknown")?.total_input, 10);
  assert.equal(result.byAgent.length, 1);
  assert.equal(result.byAgent[0].id, "a1");
  assert.equal(result.byAgent[0].hit_ratio, 50 / 150);
});
