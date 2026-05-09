import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent, AgentStore } from "@fusion/core";
import { createAgentCreateTool, createAgentDeleteTool, createGetAgentConfigTool, createUpdateAgentConfigTool } from "../agent-tools.js";

function createAgent(overrides: Partial<Agent> = {}): Agent {
  const now = new Date().toISOString();
  return {
    id: "manager-1",
    name: "Manager",
    role: "executor",
    state: "idle",
    createdAt: now,
    updatedAt: now,
    metadata: {},
    ...overrides,
  };
}

function createMockAgentStore(overrides: Partial<AgentStore> = {}): AgentStore {
  return {
    getAgent: vi.fn().mockResolvedValue(null),
    createAgent: vi.fn(),
    deleteAgent: vi.fn(),
    updateAgent: vi.fn(),
    updateAgentState: vi.fn(),
    ...overrides,
  } as unknown as AgentStore;
}

describe("createGetAgentConfigTool", () => {
  let agentStore: AgentStore;

  beforeEach(() => {
    agentStore = createMockAgentStore();
  });

  it("returns full configuration for a direct report", async () => {
    const report = createAgent({
      id: "report-1",
      reportsTo: "manager-1",
      soul: "Careful and concise",
      instructionsText: "Always verify with tests",
      instructionsPath: ".fusion/instructions/report.md",
      heartbeatProcedurePath: ".fusion/procedure.md",
      memory: "Knows release pipeline",
      runtimeConfig: {
        heartbeatIntervalMs: 30000,
        heartbeatTimeoutMs: 120000,
        maxConcurrentRuns: 2,
        messageResponseMode: "immediate",
        budget: { dailyLimitUsd: 10 },
      },
    });
    vi.mocked(agentStore.getAgent).mockResolvedValue(report);

    const tool = createGetAgentConfigTool(agentStore, "manager-1");
    const result = await tool.execute("session", { agent_id: "report-1" }, undefined as never, undefined as never, undefined as never);
    const text = (result.content[0] as { text: string }).text;

    expect(text).toContain("Agent Config: Manager (report-1)");
    expect(text).toContain("Soul:\nCareful and concise");
    expect(text).toContain("Instructions Text:\nAlways verify with tests");
    expect(text).toContain("heartbeatIntervalMs: 30000");
    expect(text).toContain("heartbeatTimeoutMs: 120000");
    expect(text).toContain("maxConcurrentRuns: 2");
    expect(text).toContain("messageResponseMode: immediate");
    expect(text).toContain("Memory:\nKnows release pipeline");
    expect(result.details).toEqual({ agent: report });
  });

  it("returns error when target agent not found", async () => {
    vi.mocked(agentStore.getAgent).mockResolvedValue(null);
    const tool = createGetAgentConfigTool(agentStore, "manager-1");
    const result = await tool.execute("session", { agent_id: "missing" }, undefined as never, undefined as never, undefined as never);
    expect((result.content[0] as { text: string }).text).toContain("ERROR: Agent missing not found");
  });

  it("returns error when target is not a direct report", async () => {
    vi.mocked(agentStore.getAgent).mockResolvedValue(createAgent({ id: "other", reportsTo: "another-manager" }));
    const tool = createGetAgentConfigTool(agentStore, "manager-1");
    const result = await tool.execute("session", { agent_id: "other" }, undefined as never, undefined as never, undefined as never);
    expect((result.content[0] as { text: string }).text).toContain("ERROR: You can only read configuration of agents that report to you");
  });

  it("returns error when target is the calling agent itself", async () => {
    vi.mocked(agentStore.getAgent).mockResolvedValue(createAgent({ id: "manager-1" }));
    const tool = createGetAgentConfigTool(agentStore, "manager-1");
    const result = await tool.execute("session", { agent_id: "manager-1" }, undefined as never, undefined as never, undefined as never);
    expect((result.content[0] as { text: string }).text).toContain("ERROR: You can only read configuration of agents that report to you");
  });
});

describe("createUpdateAgentConfigTool", () => {
  let agentStore: AgentStore;

  beforeEach(() => {
    agentStore = createMockAgentStore();
  });

  it("successfully updates soul on a direct report", async () => {
    const report = createAgent({ id: "report-1", reportsTo: "manager-1" });
    const updated = createAgent({ id: "report-1", reportsTo: "manager-1", soul: "New soul" });
    vi.mocked(agentStore.getAgent).mockResolvedValue(report);
    vi.mocked(agentStore.updateAgent).mockResolvedValue(updated);

    const tool = createUpdateAgentConfigTool(agentStore, "manager-1");
    await tool.execute("session", { agent_id: "report-1", soul: "New soul" }, undefined as never, undefined as never, undefined as never);

    expect(agentStore.updateAgent).toHaveBeenCalledWith("report-1", { soul: "New soul" });
  });

  it("successfully updates instructionsText on a direct report", async () => {
    const report = createAgent({ id: "report-1", reportsTo: "manager-1" });
    const updated = createAgent({ id: "report-1", reportsTo: "manager-1", instructionsText: "Do X" });
    vi.mocked(agentStore.getAgent).mockResolvedValue(report);
    vi.mocked(agentStore.updateAgent).mockResolvedValue(updated);

    const tool = createUpdateAgentConfigTool(agentStore, "manager-1");
    await tool.execute("session", { agent_id: "report-1", instructions_text: "Do X" }, undefined as never, undefined as never, undefined as never);

    expect(agentStore.updateAgent).toHaveBeenCalledWith("report-1", { instructionsText: "Do X" });
  });

  it("successfully updates heartbeat interval by merging runtimeConfig", async () => {
    const report = createAgent({ id: "report-1", reportsTo: "manager-1", runtimeConfig: { custom: true } });
    const updated = createAgent({ id: "report-1", reportsTo: "manager-1", runtimeConfig: { custom: true, heartbeatIntervalMs: 2000 } });
    vi.mocked(agentStore.getAgent).mockResolvedValue(report);
    vi.mocked(agentStore.updateAgent).mockResolvedValue(updated);

    const tool = createUpdateAgentConfigTool(agentStore, "manager-1");
    await tool.execute("session", { agent_id: "report-1", heartbeat_interval_ms: 2000 }, undefined as never, undefined as never, undefined as never);

    expect(agentStore.updateAgent).toHaveBeenCalledWith("report-1", {
      runtimeConfig: { custom: true, heartbeatIntervalMs: 2000 },
    });
  });

  it("successfully updates multiple fields at once", async () => {
    const report = createAgent({ id: "report-1", reportsTo: "manager-1" });
    const updated = createAgent({ id: "report-1", reportsTo: "manager-1" });
    vi.mocked(agentStore.getAgent).mockResolvedValue(report);
    vi.mocked(agentStore.updateAgent).mockResolvedValue(updated);

    const tool = createUpdateAgentConfigTool(agentStore, "manager-1");
    await tool.execute("session", {
      agent_id: "report-1",
      soul: "A",
      instructions_text: "B",
      heartbeat_timeout_ms: 9000,
      message_response_mode: "on-heartbeat",
    }, undefined as never, undefined as never, undefined as never);

    expect(agentStore.updateAgent).toHaveBeenCalledWith("report-1", {
      soul: "A",
      instructionsText: "B",
      runtimeConfig: {
        heartbeatTimeoutMs: 9000,
        messageResponseMode: "on-heartbeat",
      },
    });
  });

  it("preserves existing runtimeConfig keys when updating heartbeat fields", async () => {
    const report = createAgent({ id: "report-1", reportsTo: "manager-1", runtimeConfig: { budget: { cap: 1 }, existing: "keep" } });
    const updated = createAgent({ id: "report-1", reportsTo: "manager-1" });
    vi.mocked(agentStore.getAgent).mockResolvedValue(report);
    vi.mocked(agentStore.updateAgent).mockResolvedValue(updated);

    const tool = createUpdateAgentConfigTool(agentStore, "manager-1");
    await tool.execute("session", { agent_id: "report-1", max_concurrent_runs: 3 }, undefined as never, undefined as never, undefined as never);

    expect(agentStore.updateAgent).toHaveBeenCalledWith("report-1", {
      runtimeConfig: { budget: { cap: 1 }, existing: "keep", maxConcurrentRuns: 3 },
    });
  });

  it("returns error when target agent not found", async () => {
    vi.mocked(agentStore.getAgent).mockResolvedValue(null);
    const tool = createUpdateAgentConfigTool(agentStore, "manager-1");
    const result = await tool.execute("session", { agent_id: "missing", soul: "x" }, undefined as never, undefined as never, undefined as never);
    expect((result.content[0] as { text: string }).text).toContain("ERROR: Agent missing not found");
    expect(agentStore.updateAgent).not.toHaveBeenCalled();
  });

  it("returns error when target is not a direct report", async () => {
    vi.mocked(agentStore.getAgent).mockResolvedValue(createAgent({ id: "other", reportsTo: "different" }));
    const tool = createUpdateAgentConfigTool(agentStore, "manager-1");
    const result = await tool.execute("session", { agent_id: "other", soul: "x" }, undefined as never, undefined as never, undefined as never);
    expect((result.content[0] as { text: string }).text).toContain("ERROR: You can only update configuration of agents that report to you");
    expect(agentStore.updateAgent).not.toHaveBeenCalled();
  });

  it("returns error when target is ephemeral", async () => {
    vi.mocked(agentStore.getAgent).mockResolvedValue(createAgent({ id: "ephemeral", reportsTo: "manager-1", metadata: { agentKind: "task-worker" } }));
    const tool = createUpdateAgentConfigTool(agentStore, "manager-1");
    const result = await tool.execute("session", { agent_id: "ephemeral", soul: "x" }, undefined as never, undefined as never, undefined as never);
    expect((result.content[0] as { text: string }).text).toContain("ERROR: Cannot update ephemeral/runtime agent ephemeral");
    expect(agentStore.updateAgent).not.toHaveBeenCalled();
  });

  it("returns error when no fields provided to update", async () => {
    vi.mocked(agentStore.getAgent).mockResolvedValue(createAgent({ id: "report-1", reportsTo: "manager-1" }));
    const tool = createUpdateAgentConfigTool(agentStore, "manager-1");
    const result = await tool.execute("session", { agent_id: "report-1" }, undefined as never, undefined as never, undefined as never);
    expect((result.content[0] as { text: string }).text).toContain("ERROR: Provide at least one field to update");
    expect(agentStore.updateAgent).not.toHaveBeenCalled();
  });

  it("validates soul max length", async () => {
    vi.mocked(agentStore.getAgent).mockResolvedValue(createAgent({ id: "report-1", reportsTo: "manager-1" }));
    const tool = createUpdateAgentConfigTool(agentStore, "manager-1");
    const result = await tool.execute("session", { agent_id: "report-1", soul: "x".repeat(10001) }, undefined as never, undefined as never, undefined as never);
    expect((result.content[0] as { text: string }).text).toContain("ERROR: soul exceeds 10000 character limit");
  });

  it("validates instructionsText max length", async () => {
    vi.mocked(agentStore.getAgent).mockResolvedValue(createAgent({ id: "report-1", reportsTo: "manager-1" }));
    const tool = createUpdateAgentConfigTool(agentStore, "manager-1");
    const result = await tool.execute("session", { agent_id: "report-1", instructions_text: "x".repeat(50001) }, undefined as never, undefined as never, undefined as never);
    expect((result.content[0] as { text: string }).text).toContain("ERROR: instructions_text exceeds 50000 character limit");
  });

  it("validates heartbeatIntervalMs minimum", async () => {
    const tool = createUpdateAgentConfigTool(agentStore, "manager-1");
    const schema = tool.parameters as { properties: Record<string, { minimum?: number }> };
    expect(schema.properties.heartbeat_interval_ms?.minimum).toBe(1000);
  });

  it("validates heartbeatTimeoutMs minimum", async () => {
    const tool = createUpdateAgentConfigTool(agentStore, "manager-1");
    const schema = tool.parameters as { properties: Record<string, { minimum?: number }> };
    expect(schema.properties.heartbeat_timeout_ms?.minimum).toBe(5000);
  });
});

describe("agent lifecycle tools", () => {
  it("create tool allows direct-report creation", async () => {
    const manager = createAgent({ id: "manager-1", reportsTo: "ceo-1" });
    const created = createAgent({ id: "report-1", reportsTo: "manager-1", name: "Report" });
    const agentStore = createMockAgentStore();
    vi.mocked(agentStore.getAgent).mockResolvedValue(manager);
    vi.mocked(agentStore.createAgent).mockResolvedValue(created);

    const tool = createAgentCreateTool(agentStore, "manager-1");
    const result = await tool.execute("session", { name: "Report", role: "executor" }, undefined as never, undefined as never, undefined as never);

    expect((result.content[0] as { text: string }).text).toContain("Created agent Report (report-1)");
    expect(agentStore.createAgent).toHaveBeenCalledWith(expect.objectContaining({ reportsTo: "manager-1" }));
  });

  it("create tool blocks non-privileged cross-manager create", async () => {
    const manager = createAgent({ id: "manager-1", reportsTo: "ceo-1" });
    const agentStore = createMockAgentStore();
    vi.mocked(agentStore.getAgent).mockResolvedValue(manager);

    const tool = createAgentCreateTool(agentStore, "manager-1");
    const result = await tool.execute("session", { name: "Report", role: "executor", reportsTo: "other" }, undefined as never, undefined as never, undefined as never);

    expect((result.content[0] as { text: string }).text).toContain("ERROR: You can only create agents that report to you");
    expect(agentStore.createAgent).not.toHaveBeenCalled();
  });

  it("delete tool blocks non-direct report delete", async () => {
    const manager = createAgent({ id: "manager-1", reportsTo: "ceo-1" });
    const target = createAgent({ id: "report-1", reportsTo: "other" });
    const agentStore = createMockAgentStore();
    vi.mocked(agentStore.getAgent).mockResolvedValueOnce(manager).mockResolvedValueOnce(target);

    const tool = createAgentDeleteTool(agentStore, "manager-1");
    const result = await tool.execute("session", { agent_id: "report-1" }, undefined as never, undefined as never, undefined as never);

    expect((result.content[0] as { text: string }).text).toContain("ERROR: You can only delete agents that report to you");
    expect(agentStore.deleteAgent).not.toHaveBeenCalled();
  });
});
