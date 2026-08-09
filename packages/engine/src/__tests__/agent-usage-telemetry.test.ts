import { describe, expect, it, vi } from "vitest";
import type { TaskStore } from "@fusion/core";
import { AgentLogger } from "../agents/agent-logger.js";
import { AGENT_SESSION_USAGE_CATEGORY, attachAgentUsageTelemetry, emitAgentSessionStart } from "../agents/agent-usage-telemetry.js";

/**
 * FNXC:CommandCenterActivity 2026-08-09-11:12:
 * Durable lanes attach telemetry after resolving their model, so this seam must update identity
 * without making tool callbacks or session boundaries depend on telemetry persistence.
 */
describe("agent usage telemetry", () => {
  it("attaches and refreshes tool identity without requiring a task log", async () => {
    const emitUsageEvent = vi.fn().mockResolvedValue(undefined);
    const logger = new AgentLogger({ appendLog: vi.fn().mockResolvedValue(undefined) });
    const store = { emitUsageEvent } as unknown as TaskStore;
    attachAgentUsageTelemetry(logger, { store, agentId: "durable-agent", taskId: null, nodeId: "node-1", model: "first", provider: "provider-a", lane: "heartbeat" });
    logger.onToolStart("Bash", { command: "secret command" });
    attachAgentUsageTelemetry(logger, { store, agentId: "durable-agent", taskId: null, nodeId: "node-1", model: "resolved", provider: "provider-b", lane: "heartbeat" });
    logger.onToolEnd("Bash", false, "secret result");
    await Promise.resolve();

    expect(emitUsageEvent).toHaveBeenNthCalledWith(1, expect.objectContaining({ kind: "tool_call", taskId: null, agentId: "durable-agent", nodeId: "node-1", model: "first", provider: "provider-a" }));
    expect(emitUsageEvent).toHaveBeenNthCalledWith(2, expect.objectContaining({ kind: "tool_result", taskId: null, agentId: "durable-agent", model: "resolved", provider: "provider-b" }));
  });

  it("emits content-free agent session boundaries fail-soft", async () => {
    const emitUsageEvent = vi.fn().mockRejectedValue(new Error("offline"));
    const store = { emitUsageEvent } as unknown as TaskStore;
    expect(() => emitAgentSessionStart({ store, agentId: "reviewer", taskId: "FN-8868", nodeId: null, model: "validator", provider: "test", lane: "reviewer", ephemeral: false, runId: "run-1" })).not.toThrow();
    expect(emitUsageEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: "session_start", category: AGENT_SESSION_USAGE_CATEGORY, meta: { lane: "reviewer", ephemeral: false, runId: "run-1" } }));
    expect(() => attachAgentUsageTelemetry(null, { store, lane: "reviewer" })).not.toThrow();
  });
});
