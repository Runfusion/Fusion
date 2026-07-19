/*
FNXC:HeartbeatRecovery 2026-07-15-08:50:
Focused suite for false-positive heartbeat-model-unavailable parks. Kept out of the large
quarantined self-healing.test.ts so default vitest project covers the auto-retry contract.
*/
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Agent, AgentStore, Settings, TaskStore } from "@fusion/core";
import { SelfHealingManager } from "../self-healing.js";
import {
  HEARTBEAT_ERROR_RECOVERY_METADATA_KEY,
  HEARTBEAT_MODEL_UNAVAILABLE_PAUSE_REASON,
  readHeartbeatErrorRetryCount,
} from "../agent-heartbeat.js";

vi.mock("../logger.js", () => ({
  createLogger: vi.fn(() => ({
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
  schedulerLog: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function createStatefulMockAgentStore(agents: Agent[]): AgentStore & { getAgent(id: string): Agent | undefined } {
  const agentMap = new Map<string, Agent>(
    agents.map((agent) => [agent.id, { ...agent, metadata: agent.metadata ? { ...agent.metadata } : agent.metadata }]),
  );
  return {
    getAgent: (id: string) => agentMap.get(id),
    listAgents: vi.fn().mockImplementation(async () => Array.from(agentMap.values())),
    updateAgentState: vi.fn().mockImplementation(async (id: string, state: Agent["state"]) => {
      const agent = agentMap.get(id);
      if (agent) agentMap.set(id, { ...agent, state });
    }),
    updateAgent: vi.fn().mockImplementation(async (id: string, patch: Partial<Agent>) => {
      const agent = agentMap.get(id);
      if (agent) agentMap.set(id, { ...agent, ...patch });
    }),
  } as unknown as AgentStore & { getAgent(id: string): Agent | undefined };
}

describe("SelfHealingManager heartbeat-model-unavailable recovery", () => {
  let store: TaskStore;

  beforeEach(() => {
    vi.clearAllMocks();
    store = {
      getSettings: vi.fn().mockResolvedValue({
        globalPause: false,
        enginePaused: false,
        taskStuckTimeoutMs: 60_000,
      } as unknown as Settings),
      recordRunAuditEvent: vi.fn().mockResolvedValue(undefined),
      listTasks: vi.fn().mockResolvedValue([]),
    } as unknown as TaskStore;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("startup resets both misattributed and same-provider heartbeat-model-unavailable parks", async () => {
    const now = Date.now();
    const agentStore = createStatefulMockAgentStore([
      {
        id: "misattributed-heartbeat-model",
        state: "paused",
        pauseReason: HEARTBEAT_MODEL_UNAVAILABLE_PAUSE_REASON,
        lastError: 'No API key for provider: anthropic. Configure credentials for provider "anthropic" in settings, then resume the agent.',
        runtimeConfig: { enabled: true, modelProvider: "grok-cli", modelId: "grok-4.5", model: "grok-cli/grok-4.5" },
        updatedAt: new Date(now).toISOString(),
      } as unknown as Agent,
      {
        id: "genuine-heartbeat-model",
        state: "paused",
        pauseReason: HEARTBEAT_MODEL_UNAVAILABLE_PAUSE_REASON,
        lastError: 'No API key for provider: anthropic. Configure credentials for provider "anthropic" in settings, then resume the agent.',
        runtimeConfig: { enabled: true, modelProvider: "anthropic", modelId: "claude-opus-4-8", model: "anthropic/claude-opus-4-8" },
        updatedAt: new Date(now).toISOString(),
      } as unknown as Agent,
      {
        id: "user-paused",
        state: "paused",
        pauseReason: "manual",
        lastError: "socket hang up",
        updatedAt: new Date(now).toISOString(),
      } as unknown as Agent,
    ]);
    const restartDurableAgentHeartbeat = vi.fn().mockResolvedValue(true);
    const manager = new SelfHealingManager(store, {
      rootDir: "/tmp/test-project",
      agentStore,
      restartDurableAgentHeartbeat,
    });

    const resetCount = await manager.resetDurableAgentErrorStateOnStartup();

    expect(resetCount).toBe(2);
    for (const agentId of ["misattributed-heartbeat-model", "genuine-heartbeat-model"]) {
      const agent = agentStore.getAgent(agentId)!;
      expect(agent.state).toBe("active");
      expect(agent.lastError).toBeUndefined();
      expect(agent.pauseReason).toBeUndefined();
      expect(readHeartbeatErrorRetryCount(agent)).toBe(0);
    }
    expect(restartDurableAgentHeartbeat).toHaveBeenCalledWith("misattributed-heartbeat-model", {
      reason: "startup-error-reset",
      attempt: 1,
    });
    expect(restartDurableAgentHeartbeat).toHaveBeenCalledWith("genuine-heartbeat-model", {
      reason: "startup-error-reset",
      attempt: 1,
    });
    expect(agentStore.updateAgentState).not.toHaveBeenCalledWith("user-paused", expect.anything());
    manager.stop();
  });

  it("recoverOrphanedAgents auto-recovers a stale under-budget model-unavailable park", async () => {
    const now = Date.now();
    const agentStore = createStatefulMockAgentStore([
      {
        id: "false-model-park",
        state: "paused",
        pauseReason: HEARTBEAT_MODEL_UNAVAILABLE_PAUSE_REASON,
        lastError: 'No API key for provider: anthropic. Configure credentials for provider "anthropic" in settings, then resume the agent.',
        runtimeConfig: { enabled: true },
        metadata: {},
        updatedAt: new Date(now - 120_000).toISOString(),
      } as unknown as Agent,
      {
        id: "fresh-model-park",
        state: "paused",
        pauseReason: HEARTBEAT_MODEL_UNAVAILABLE_PAUSE_REASON,
        lastError: 'No API key for provider: anthropic. Configure credentials for provider "anthropic" in settings, then resume the agent.',
        runtimeConfig: { enabled: true },
        updatedAt: new Date(now).toISOString(),
      } as unknown as Agent,
      {
        id: "exhausted-model-park",
        state: "paused",
        pauseReason: HEARTBEAT_MODEL_UNAVAILABLE_PAUSE_REASON,
        lastError: 'No API key for provider: anthropic. Configure credentials for provider "anthropic" in settings, then resume the agent.',
        runtimeConfig: { enabled: true },
        metadata: { [HEARTBEAT_ERROR_RECOVERY_METADATA_KEY]: { consecutiveAttempts: 5 } },
        updatedAt: new Date(now - 120_000).toISOString(),
      } as unknown as Agent,
    ]);
    const restartDurableAgentHeartbeat = vi.fn().mockResolvedValue(true);
    const manager = new SelfHealingManager(store, {
      rootDir: "/tmp/test-project",
      agentStore,
      restartDurableAgentHeartbeat,
    });

    const result = await manager.recoverOrphanedAgents();

    expect(result).toBe(1);
    expect(agentStore.getAgent("false-model-park")?.state).toBe("active");
    expect(agentStore.getAgent("false-model-park")?.pauseReason).toBeUndefined();
    expect(store.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "agent:auto-recover-error-state",
      target: "false-model-park",
      metadata: expect.objectContaining({ agentId: "false-model-park", attempt: 1, limit: 5, source: "self-healing" }),
    }));
    expect(restartDurableAgentHeartbeat).toHaveBeenCalledWith("false-model-park", { reason: "transient-error", attempt: 1 });
    expect(agentStore.getAgent("fresh-model-park")?.state).toBe("paused");
    expect(agentStore.getAgent("exhausted-model-park")?.state).toBe("paused");
    manager.stop();
  });
});
