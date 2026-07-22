import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentStore, ReflectionStore, TaskStore, Agent, AgentRatingSummary, AgentRating } from "@fusion/core";
import { createReadEvaluationsTool, createUpdateIdentityTool } from "../agent-tools.js";
import { MAX_INSTRUCTIONS_TEXT_LENGTH, MAX_MEMORY_LENGTH, MAX_SOUL_LENGTH } from "../agents/agent-instructions.js";
import { AgentSelfImproveService } from "../agents/agent-self-improve.js";
import { HeartbeatMonitor } from "../agent-heartbeat.js";

vi.mock("../logger.js", () => ({
  createLogger: () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  heartbeatLog: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
  formatError: (err: unknown) => ({ detail: err instanceof Error ? err.message : String(err) }),
}));

vi.mock("../pi.js", () => ({
  createFnAgent: vi.fn(),
  promptWithFallback: vi.fn(async (session: { prompt: (prompt: string) => Promise<void> }, prompt: string) => {
    await session.prompt(prompt);
  }),
}));

import { createFnAgent } from "../pi.js";
const mockedCreateFnAgent = vi.mocked(createFnAgent);

function makeSummary(partial: Partial<AgentRatingSummary> = {}): AgentRatingSummary {
  return {
    agentId: "agent-1",
    averageScore: 4.25,
    totalRatings: 2,
    categoryAverages: { quality: 4.5 },
    recentRatings: [],
    trend: "improving",
    ...partial,
  };
}

function makeRating(partial: Partial<AgentRating> = {}): AgentRating {
  return {
    id: "r-1",
    agentId: "agent-1",
    raterType: "user",
    score: 4,
    comment: "Good progress",
    createdAt: new Date().toISOString(),
    ...partial,
  };
}

describe("createReadEvaluationsTool", () => {
  it("returns formatted data with ratings and reflections", async () => {
    const agentStore = {
      getRatingSummary: vi.fn().mockResolvedValue(makeSummary()),
      getRatings: vi.fn().mockResolvedValue([makeRating(), makeRating({ id: "r-2", score: 5, comment: "Great" })]),
    } as unknown as AgentStore;
    const reflectionStore = {
      getLatestReflection: vi.fn().mockResolvedValue({
        summary: "Keep adding tests",
        insights: ["Some regressions came from missing coverage"],
        suggestedImprovements: ["Run focused tests before commit"],
      }),
      getReflections: vi.fn().mockResolvedValue([
        { createdAt: "2026-05-01T00:00:00.000Z", summary: "Prioritize review" },
      ]),
    } as unknown as ReflectionStore;

    const tool = createReadEvaluationsTool(agentStore, reflectionStore, "agent-1");
    const result = await tool.execute("1", {}, undefined as any, undefined as any, undefined as any);
    const text = (result.content[0] as any).text;

    expect(text).toContain("Evaluation Summary");
    expect(text).toContain("Average score: 4.25");
    expect(text).toContain("Trend: improving");
    expect(text).toContain("Category averages");
    expect(text).toContain("Recent rating comments");
    expect(text).toContain("Latest reflection");
    expect(text).toContain("Recent reflection history");
  });

  it("returns ratings-only data when no reflection store is provided", async () => {
    const agentStore = {
      getRatingSummary: vi.fn().mockResolvedValue(makeSummary()),
      getRatings: vi.fn().mockResolvedValue([makeRating()]),
    } as unknown as AgentStore;
    const tool = createReadEvaluationsTool(agentStore, undefined, "agent-1");
    const result = await tool.execute("1", {}, undefined as any, undefined as any, undefined as any);
    const text = (result.content[0] as any).text;
    expect(text).toContain("Evaluation Summary");
    expect(text).not.toContain("Latest reflection");
  });

  it("returns no-data message", async () => {
    const agentStore = {
      getRatingSummary: vi.fn().mockResolvedValue(makeSummary({ totalRatings: 0, averageScore: 0, categoryAverages: {}, trend: "insufficient-data" })),
      getRatings: vi.fn().mockResolvedValue([]),
    } as unknown as AgentStore;
    const tool = createReadEvaluationsTool(agentStore, undefined, "agent-1");
    const result = await tool.execute("1", {}, undefined as any, undefined as any, undefined as any);
    expect((result.content[0] as any).text).toContain("No evaluation data available yet");
  });
});

describe("createUpdateIdentityTool", () => {
  it("updates provided fields and returns previews", async () => {
    const agentStore = {
      updateAgent: vi.fn().mockResolvedValue({}),
    } as unknown as AgentStore;
    const tool = createUpdateIdentityTool(agentStore, "agent-1");

    const result = await tool.execute("1", {
      soul: "  new soul  ",
      instructionsText: "new instructions",
      memory: "new memory",
    }, undefined as any, undefined as any, undefined as any);

    expect((agentStore.updateAgent as any)).toHaveBeenCalledWith("agent-1", {
      soul: "new soul",
      instructionsText: "new instructions",
      memory: "new memory",
    });
    expect((result.content[0] as any).text).toContain("Updated identity fields");
    expect((result.content[0] as any).text).toContain("soul");
  });

  it("rejects empty update and length overages", async () => {
    const agentStore = { updateAgent: vi.fn() } as unknown as AgentStore;
    const tool = createUpdateIdentityTool(agentStore, "agent-1");

    const empty = await tool.execute("1", {}, undefined as any, undefined as any, undefined as any);
    expect((empty.content[0] as any).text).toContain("Provide at least one field");

    const tooLongSoul = await tool.execute("1", { soul: "x".repeat(MAX_SOUL_LENGTH + 1) }, undefined as any, undefined as any, undefined as any);
    expect((tooLongSoul.content[0] as any).text).toContain("soul exceeds");

    const tooLongInstructions = await tool.execute("1", { instructionsText: "x".repeat(MAX_INSTRUCTIONS_TEXT_LENGTH + 1) }, undefined as any, undefined as any, undefined as any);
    expect((tooLongInstructions.content[0] as any).text).toContain("instructionsText exceeds");

    const tooLongMemory = await tool.execute("1", { memory: "x".repeat(MAX_MEMORY_LENGTH + 1) }, undefined as any, undefined as any, undefined as any);
    expect((tooLongMemory.content[0] as any).text).toContain("memory exceeds");
  });
});

describe("AgentSelfImproveService", () => {
  let agent: Agent;
  let agentStore: AgentStore;

  beforeEach(() => {
    agent = {
      id: "agent-1",
      name: "Agent",
      role: "executor",
      state: "active",
      runtimeConfig: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as unknown as Agent;

    agentStore = {
      getAgent: vi.fn().mockResolvedValue(agent),
      getRatingSummary: vi.fn().mockResolvedValue(makeSummary()),
      updateAgent: vi.fn().mockResolvedValue(agent),
    } as unknown as AgentStore;
  });

  it("evaluates interval, first-run behavior, prompt, and record", async () => {
    const service = new AgentSelfImproveService({ agentStore, reflectionStore: {} as ReflectionStore, rootDir: "/tmp" });

    agent.runtimeConfig = { selfImproveIntervalMs: 3_600_000, lastSelfImproveAt: new Date(Date.now() - 4_000_000).toISOString() };
    await expect(service.shouldRunSelfImprove("agent-1")).resolves.toBe(true);

    agent.runtimeConfig = { selfImproveIntervalMs: 3_600_000, lastSelfImproveAt: new Date().toISOString() };
    await expect(service.shouldRunSelfImprove("agent-1")).resolves.toBe(false);

    agent.runtimeConfig = {};
    await expect(service.shouldRunSelfImprove("agent-1")).resolves.toBe(true);

    (agentStore.getRatingSummary as any).mockResolvedValueOnce(makeSummary({ totalRatings: 0 }));
    await expect(service.shouldRunSelfImprove("agent-1")).resolves.toBe(false);

    agent.runtimeConfig = { selfImproveEnabled: false };
    await expect(service.shouldRunSelfImprove("agent-1")).resolves.toBe(false);

    agent.runtimeConfig = { lastSelfImproveAt: "2026-05-01T00:00:00.000Z" };
    await expect(service.getSelfImprovePrompt("agent-1")).resolves.toContain("2026-05-01T00:00:00.000Z");
    agent.runtimeConfig = {};
    await expect(service.getSelfImprovePrompt("agent-1")).resolves.toContain("never");

    await service.recordSelfImprove("agent-1");
    expect((agentStore.updateAgent as any)).toHaveBeenCalledWith("agent-1", expect.objectContaining({
      runtimeConfig: expect.objectContaining({ lastSelfImproveAt: expect.any(String) }),
    }));
  });
});

describe("heartbeat integration for evaluation tools", () => {
  it("exposes tools in task-scoped and no-task runs", async () => {
    const agent: Agent = {
      id: "agent-1",
      name: "Agent",
      role: "executor",
      state: "active",
      taskId: "FN-1",
      soul: "improve from feedback",
      runtimeConfig: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as unknown as Agent;

    const store = {
      getActiveHeartbeatRun: vi.fn().mockResolvedValue(null),
      startHeartbeatRun: vi.fn().mockResolvedValue({ id: "run-1", startedAt: new Date().toISOString(), status: "running", agentId: "agent-1" }),
      saveRun: vi.fn().mockResolvedValue(undefined),
      endHeartbeatRun: vi.fn().mockResolvedValue(undefined),
      getRunDetail: vi.fn().mockResolvedValue({ id: "run-1" }),
      getAgent: vi.fn().mockResolvedValue(agent),
      updateAgentState: vi.fn().mockResolvedValue(undefined),
      assignTask: vi.fn().mockResolvedValue(undefined),
      recordHeartbeat: vi.fn().mockResolvedValue(undefined),
      clearLastBlockedState: vi.fn().mockResolvedValue(undefined),
      getLastBlockedState: vi.fn().mockResolvedValue(null),
      getBudgetStatus: vi.fn().mockResolvedValue({ isOverBudget: false, isOverThreshold: false }),
      appendRunLog: vi.fn().mockResolvedValue(undefined),
      getRatings: vi.fn().mockResolvedValue([]),
      getRatingSummary: vi.fn().mockResolvedValue(makeSummary({ totalRatings: 0, averageScore: 0, categoryAverages: {}, trend: "insufficient-data" })),
      listAgents: vi.fn().mockResolvedValue([]),
      getRecentRuns: vi.fn().mockResolvedValue([]),
    } as unknown as AgentStore;

    const taskStore = {
      getTask: vi.fn().mockResolvedValue({ id: "FN-1", status: "todo", column: "todo", comments: [], steeringComments: [] }),
      createTask: vi.fn().mockResolvedValue({ id: "FN-2" }),
      logEntry: vi.fn().mockResolvedValue(undefined),
      getSettings: vi.fn().mockResolvedValue({}),
      getTaskDocuments: vi.fn().mockResolvedValue([]),
      createTaskDocument: vi.fn().mockResolvedValue({ id: "doc-1" }),
      addComment: vi.fn().mockResolvedValue(undefined),
      listTasks: vi.fn().mockResolvedValue([]),
      selectNextTaskForAgent: vi.fn().mockResolvedValue(null),
    } as unknown as TaskStore;

    mockedCreateFnAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
        subscribe: vi.fn(),
      } as any,
    } as any);

    const monitor = new HeartbeatMonitor({
      store,
      taskStore,
      rootDir: "/tmp",
      reflectionStore: {
        getLatestReflection: vi.fn().mockResolvedValue(null),
        getReflections: vi.fn().mockResolvedValue([]),
      } as unknown as ReflectionStore,
      reflectionService: { generateReflection: vi.fn() } as any,
    });

    const taskTools = monitor.createHeartbeatTools("agent-1", taskStore, "FN-1").map((tool) => tool.name);
    expect(taskTools).toContain("fn_read_evaluations");
    expect(taskTools).toContain("fn_update_identity");
    expect(taskTools).toContain("fn_reflect_on_performance");

    agent.taskId = undefined;
    await monitor.executeHeartbeat({ agentId: "agent-1", source: "timer" });
    const call = mockedCreateFnAgent.mock.calls.at(-1)?.[0];
    const names = (call?.customTools ?? []).map((tool: { name: string }) => tool.name);
    expect(names).toContain("fn_read_evaluations");
    expect(names).toContain("fn_update_identity");
    expect(names).toContain("fn_reflect_on_performance");
  });
});
