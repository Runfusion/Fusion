import { describe, expect, it, vi } from "vitest";
import type { TaskStore } from "@fusion/core";
import { AgentLogger } from "../agents/agent-logger.js";
import { HeartbeatMonitor } from "../agent-heartbeat.js";
import * as sessionHelpers from "../agents/agent-session-helpers.js";
import { attachAgentUsageTelemetry, emitAgentSessionStart, type AgentTelemetryLane } from "../agents/agent-usage-telemetry.js";

/**
 * FNXC:CommandCenterActivity 2026-08-09-11:29:
 * Every engine lane uses the same fail-soft logger seam. These focused fixtures exercise the
 * durable/no-task identity contract without making a provider session or task-agent log a test dependency.
 */
describe("agent usage telemetry lane seam", () => {
  function exercise(lane: AgentTelemetryLane, taskId: string | null, agentId = `${lane}-agent`) {
    const emitUsageEvent = vi.fn().mockResolvedValue(undefined);
    const appendAgentLog = vi.fn().mockResolvedValue(undefined);
    const store = { emitUsageEvent, appendAgentLog } as unknown as TaskStore;
    const logger = new AgentLogger({ taskId: taskId ?? undefined, appendLog: vi.fn().mockResolvedValue(undefined) });
    const context = { store, lane, agentId, taskId, nodeId: taskId ? "mesh-node" : null, model: "resolved-model", provider: "resolved-provider" } as const;
    attachAgentUsageTelemetry(logger, context);
    emitAgentSessionStart(context);
    logger.onToolStart("Read", { path: "private-path" });
    logger.onToolEnd("Read", false, "private-result");
    return { emitUsageEvent, appendAgentLog };
  }

  it.each(["heartbeat", "executor", "workflow-step", "triage", "reviewer", "merger"] as const)("emits an attributed session and tool usage for %s", (lane) => {
    const { emitUsageEvent } = exercise(lane, lane === "heartbeat" ? null : "FN-8868");
    expect(emitUsageEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: "session_start", category: "agent-session", meta: { lane } }));
    expect(emitUsageEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: "tool_call", agentId: `${lane}-agent`, taskId: lane === "heartbeat" ? null : "FN-8868", model: "resolved-model" }));
    expect(emitUsageEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: "tool_result", provider: "resolved-provider" }));
  });

  it("keeps no-task heartbeat telemetry out of task agent logs and swallows persistence rejection", async () => {
    const emitUsageEvent = vi.fn().mockRejectedValue(new Error("offline"));
    const appendAgentLog = vi.fn();
    const store = { emitUsageEvent, appendAgentLog } as unknown as TaskStore;
    const logger = new AgentLogger({ appendLog: vi.fn().mockResolvedValue(undefined) });
    const context = { store, lane: "heartbeat" as const, agentId: "durable-heartbeat", taskId: null };
    expect(() => {
      attachAgentUsageTelemetry(logger, context);
      emitAgentSessionStart(context);
      logger.onToolStart("Read", { path: "x" });
      logger.onToolEnd("Read", false, "ok");
    }).not.toThrow();
    await Promise.resolve();
    expect(appendAgentLog).not.toHaveBeenCalled();
  });

  it("emits durable no-task heartbeat usage through HeartbeatMonitor's live session callbacks", async () => {
    /*
    FNXC:CommandCenterActivity 2026-08-09-14:55:
    The durable heartbeat regression must execute the production monitor rather than manually
    invoking the seam. This proves its no-task logger receives store attachment and forwards
    provider callbacks without task-log persistence.
    */
    const emitUsageEvent = vi.fn().mockResolvedValue(undefined);
    const appendRunLog = vi.fn().mockResolvedValue(undefined);
    const heartbeatStore = {
      startHeartbeatRun: vi.fn().mockResolvedValue({ id: "run-1", agentId: "durable-agent", status: "active", startedAt: new Date().toISOString() }),
      getRunDetail: vi.fn(), saveRun: vi.fn(), updateAgentState: vi.fn(), updateAgent: vi.fn(), endHeartbeatRun: vi.fn(),
      assignTask: vi.fn(), getBudgetStatus: vi.fn().mockResolvedValue({ isOverBudget: false, isOverThreshold: false, usagePercent: 0 }),
      getCachedAgent: vi.fn().mockReturnValue(null), getLastBlockedState: vi.fn(), setLastBlockedState: vi.fn(), clearLastBlockedState: vi.fn(),
      appendRunLog, getAgentsByReportsTo: vi.fn().mockResolvedValue([]), recordHeartbeat: vi.fn(),
      getAgent: vi.fn().mockResolvedValue({ id: "durable-agent", name: "Durable", role: "executor", state: "active", createdAt: "", updatedAt: "", metadata: {}, soul: "patrol" }),
    };
    const taskStore = { getSettings: vi.fn().mockResolvedValue({}), emitUsageEvent, appendAgentLog: vi.fn(), listTasks: vi.fn().mockResolvedValue([]), selectNextTaskForAgent: vi.fn().mockResolvedValue(null) } as unknown as TaskStore;
    const sessionSpy = vi.spyOn(sessionHelpers, "createResolvedAgentSession").mockImplementation(async (options: any) => {
      options.onToolStart("Read", { path: "private-heartbeat-input" });
      options.onToolEnd("Read", false, "private-heartbeat-output");
      return { session: { prompt: vi.fn().mockResolvedValue(undefined), dispose: vi.fn(), subscribe: vi.fn() } } as any;
    });
    try {
      await new HeartbeatMonitor({ store: heartbeatStore as any, taskStore, rootDir: "/repo" }).executeHeartbeat({ agentId: "durable-agent", source: "on_demand" });
    } finally {
      sessionSpy.mockRestore();
    }

    expect(emitUsageEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: "session_start", category: "agent-session", agentId: "durable-agent", taskId: null, meta: expect.objectContaining({ lane: "heartbeat", ephemeral: false, runId: "run-1" }) }));
    expect(emitUsageEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: "tool_call", agentId: "durable-agent", taskId: null, toolName: "Read" }));
    expect(emitUsageEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: "tool_result", agentId: "durable-agent", taskId: null, toolName: "Read" }));
    expect(taskStore.appendAgentLog).not.toHaveBeenCalled();
  });
});
