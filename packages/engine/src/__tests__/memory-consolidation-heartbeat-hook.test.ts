import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent, AgentHeartbeatRun, AgentStore, TaskStore } from "@fusion/core";
import {
  HEARTBEAT_ERROR_RECOVERY_METADATA_KEY,
  HEARTBEAT_ERROR_RETRY_EXHAUSTED_PAUSE_REASON,
} from "../agents/agent-heartbeat-error-recovery.js";

const memory = vi.hoisted(() => ({ resolve: vi.fn(), run: vi.fn(), ensure: vi.fn() }));
vi.mock("../memory/index.js", () => ({
  resolveMemoryConsolidationPorts: memory.resolve,
  MemoryConsolidationService: class { runConsolidationTick = memory.run; },
  MemoryConsolidationError: class MemoryConsolidationError extends Error {
    constructor(readonly stage: "graph" | "recall" | "cross-reference", message: string) { super(message); }
  },
}));
vi.mock("../agents/agent-instructions.js", async () => {
  const actual = await vi.importActual<typeof import("../agents/agent-instructions.js")>("../agents/agent-instructions.js");
  return { ...actual, ensureDefaultHeartbeatProcedureFile: memory.ensure };
});
vi.mock("../logger.js", () => ({ heartbeatLog: { log: vi.fn(), warn: vi.fn(), error: vi.fn() }, createLogger: vi.fn(() => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() })) }));
import { HeartbeatMonitor } from "../agent-heartbeat.js";
import { MemoryConsolidationError } from "../memory/index.js";

function outcome(changed = false, skipped?: "in-progress") {
  return { graphChanged: changed, graphRecoveryReason: changed ? "inconsistent-artifact" as const : null, parsedFiles: 0, reusedFiles: 1, prunedFiles: 0, nodeCount: 1, edgeCount: 0, recallCandidates: 1, recallCreated: changed ? 1 : 0, recallDuplicate: changed ? 0 : 1, crossRefUpdated: 0, crossRefUnchanged: 1, crossRefMissing: 0, semanticsWritten: changed ? 1 : 0, semanticsDeduped: changed ? 2 : 0, semanticsDroppedUnresolved: changed ? 3 : 0, durationMs: 1, changed, ...(skipped ? { skipped } : {}) };
}

function fixture(enabled: unknown, metadata: Record<string, unknown> = {}) {
  let sequence = 0; const audits: Array<Record<string, unknown>> = [];
  const agent = { id: "memory", name: "Memory Keeper", role: "custom", roles: ["custom"], state: "active", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", metadata: { builtInMemoryAgent: true, ...metadata }, runtimeConfig: { enabled: true } } as unknown as Agent;
  const runs = new Map<string, AgentHeartbeatRun>();
  const store = {
    getAgent: vi.fn(async () => agent), getCachedAgent: vi.fn(() => agent), listAgents: vi.fn(async () => [agent]), on: vi.fn(), off: vi.fn(),
    updateAgentState: vi.fn(async (_id: string, state: Agent["state"]) => { agent.state = state; }),
    updateAgent: vi.fn(async (_id: string, patch: Partial<Agent>) => Object.assign(agent, patch, patch.metadata ? { metadata: patch.metadata } : {})),
    startHeartbeatRun: vi.fn(async () => { const run = { id: `run-${++sequence}`, agentId: agent.id, source: "timer", startedAt: new Date().toISOString(), endedAt: null, status: "active" } as AgentHeartbeatRun; runs.set(run.id, run); return run; }),
    saveRun: vi.fn(async (run: AgentHeartbeatRun) => runs.set(run.id, run)), getRunDetail: vi.fn(async (_id: string, runId: string) => runs.get(runId) ?? null), endHeartbeatRun: vi.fn(), appendRunLog: vi.fn(), getBudgetStatus: vi.fn(async () => ({ allowed: true })), getActiveHeartbeatRun: vi.fn(async () => null),
  } as unknown as AgentStore;
  const taskStore = { getSettings: vi.fn(async () => ({ defaultWorkflowId: "builtin:coding", heartbeatErrorRecoveryAttempts: 2 })), getWorkflowSettingsProjectId: () => "project", getTaskWorkflowSelection: vi.fn(() => undefined), getWorkflowDefinition: vi.fn(async () => undefined), getWorkflowSettingValues: vi.fn(() => ({ memoryConsolidationEnabled: enabled })), recordRunAuditEvent: vi.fn(async (event) => audits.push(event as Record<string, unknown>)), getAsyncLayer: vi.fn(() => ({ projectId: "project" })) } as unknown as TaskStore;
  return { agent, store, taskStore, audits };
}

function monitor(f: ReturnType<typeof fixture>) {
  return new HeartbeatMonitor({ store: f.store, taskStore: f.taskStore, rootDir: process.cwd() });
}

beforeEach(() => { memory.resolve.mockReset(); memory.run.mockReset(); memory.ensure.mockResolvedValue(undefined); });

describe("Memory Keeper heartbeat hook", () => {
  it("suppresses ports and sessions when the workflow switch is disabled", async () => {
    const f = fixture(false); const result = await monitor(f).executeHeartbeat({ agentId: "memory", source: "timer" });
    expect(result?.status).toBe("completed"); expect(memory.resolve).not.toHaveBeenCalled(); expect(memory.run).not.toHaveBeenCalled();
    expect(f.audits).toEqual([expect.objectContaining({ mutationType: "memory:consolidation-skipped", target: "memory", metadata: expect.objectContaining({ agentId: "memory", reason: "disabled" }) })]);
    expect(vi.mocked(f.taskStore.getSettings)).toHaveBeenCalledTimes(1);
  });

  it("treats an unavailable adapter environment as a successful audited skip", async () => {
    memory.resolve.mockResolvedValue({ status: "unavailable", reason: "no-data-layer" });
    const f = fixture(true); const result = await monitor(f).executeHeartbeat({ agentId: "memory", source: "timer" });
    expect(result?.status).toBe("completed"); expect(memory.run).not.toHaveBeenCalled();
    expect(f.audits).toEqual([expect.objectContaining({ mutationType: "memory:consolidation-skipped", target: "memory", metadata: expect.objectContaining({ agentId: "memory", reason: "unavailable", unavailableReason: "no-data-layer" }) })]);
  });

  it("emits changed and in-progress production outcomes with their fixed audit shapes", async () => {
    memory.resolve.mockResolvedValue({ status: "ready", projectId: "resolved-project", ports: {} });
    memory.run.mockResolvedValueOnce(outcome(true)).mockResolvedValueOnce(outcome(false, "in-progress"));
    const f = fixture(true); const first = await monitor(f).executeHeartbeat({ agentId: "memory", source: "timer" });
    const second = await monitor(f).executeHeartbeat({ agentId: "memory", source: "timer" });
    expect(first?.status).toBe("completed"); expect(second?.status).toBe("completed");
    expect(memory.run).toHaveBeenCalledWith({ agentId: "memory", projectId: "resolved-project" });
    expect(f.audits).toEqual(expect.arrayContaining([
      expect.objectContaining({ mutationType: "memory:semantics-inferred", target: "memory", metadata: expect.objectContaining({ agentId: "memory", edgesWritten: 1, edgesDeduped: 2, edgesDroppedUnresolved: 3 }) }),
      expect.objectContaining({ mutationType: "memory:consolidation-completed", target: "memory", metadata: expect.objectContaining({ agentId: "memory", graphRecoveryReason: "inconsistent-artifact", recallCreated: 1 }) }),
      expect.objectContaining({ mutationType: "memory:consolidation-skipped", target: "memory", metadata: expect.objectContaining({ agentId: "memory", reason: "in-progress" }) }),
    ]));
    expect(JSON.stringify(f.audits)).not.toContain("distinctive model prose");
  });

  it("routes recoverable tick failures through completeRun and the shared exhaustion budget", async () => {
    memory.resolve.mockResolvedValue({ status: "ready", projectId: "project", ports: {} });
    memory.run.mockRejectedValue(new MemoryConsolidationError("recall", "temporary consolidation failure"));
    const f = fixture(true, { [HEARTBEAT_ERROR_RECOVERY_METADATA_KEY]: { consecutiveAttempts: 2 } });
    const result = await monitor(f).executeHeartbeat({ agentId: "memory", source: "timer" });
    expect(result?.status).toBe("failed");
    expect(f.agent.state).toBe("paused");
    expect(f.agent.pauseReason).toBe(HEARTBEAT_ERROR_RETRY_EXHAUSTED_PAUSE_REASON);
    expect(f.agent.metadata).toHaveProperty(HEARTBEAT_ERROR_RECOVERY_METADATA_KEY);
    expect(f.audits).toEqual(expect.arrayContaining([
      expect.objectContaining({ mutationType: "memory:consolidation-failed", target: "memory", metadata: expect.objectContaining({ agentId: "memory", stage: "recall", recoverable: true, priorRetryCount: 2, retryLimit: 2 }) }),
    ]));
    const failure = f.audits.find((event) => event.mutationType === "memory:consolidation-failed")!;
    expect(JSON.stringify(failure.metadata)).not.toContain("temporary consolidation failure");
  });
});
