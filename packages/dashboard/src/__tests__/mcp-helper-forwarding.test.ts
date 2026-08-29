import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Task, type TaskStore } from "@fusion/core";
import * as coreModule from "@fusion/core";
import { request } from "../test-request.js";

const { mockCreateFnAgent, mockPromptWithFallback, mockResolveMcpServersForStore, execMock } = vi.hoisted(() => ({
  mockCreateFnAgent: vi.fn(),
  mockPromptWithFallback: vi.fn(),
  mockResolveMcpServersForStore: vi.fn(),
  execMock: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, exec: execMock };
});

vi.mock("@fusion/engine", () => ({
  listCliAdapterDescriptors: () => [],
  buildSessionSkillContextSync: () => ({
    skillSelectionContext: { projectRootDir: "/tmp/project", requestedSkillNames: ["fusion"], sessionPurpose: "executor" },
    resolvedSkillNames: ["fusion"],
    skillSource: "role-fallback" as const,
  }),
  createFnAgent: mockCreateFnAgent,
  promptWithFallback: mockPromptWithFallback,
  resolveMcpServersForStore: mockResolveMcpServersForStore,
  // FNXC:DashboardMocks 2026-07-13-14:00 (round 11):
  // Insight extraction now resolves a per-run thinking level via resolvePlanningThinkingLevel
  // (imported from @fusion/engine) before reaching resolveMcpServersForStore. Without this mock
  // export the call throws TypeError, the run is marked failed (still HTTP 201), and the MCP
  // forwarding assertion sees 0 calls. Mirror the insights-routes.test.ts mock shape.
  resolvePlanningThinkingLevel: vi.fn((_settings: unknown, thinkingLevel?: string) => thinkingLevel),
}));

const resolvedMcpServers = [
  { name: "docs", transport: "stdio", command: "node", args: ["server.js"], env: { MCP_TOKEN: "materialized-secret-value" } },
];

function createMcpEnabledStore(): object {
  return {
    mcpEnabledForTest: true,
    getSettingsByScope: vi.fn().mockResolvedValue({ global: { mcpServers: { enabled: true, servers: [{ name: "docs" }] } }, project: {} }),
    getSecretsStore: vi.fn().mockResolvedValue({ revealSecret: vi.fn().mockResolvedValue("materialized-secret-value") }),
  };
}

function createMcpDisabledStore(): object {
  return {
    getSettingsByScope: vi.fn().mockResolvedValue({ global: { mcpServers: { enabled: false, servers: [] } }, project: {} }),
    getSecretsStore: vi.fn().mockResolvedValue({ revealSecret: vi.fn() }),
  };
}

function createTask(): Task {
  return {
    id: "FN-7078",
    title: "Forward helper MCP",
    description: "Wire MCP into helper sessions",
    status: "todo",
    column: "todo",
    priority: "normal",
    dependencies: [],
    size: "M",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as Task;
}

function createInsightTaskStore(mode: boolean | "no-settings-scope"): { root: string; store: TaskStore } {
  const root = "/tmp/mcp-helper-forwarding";
  let run = {
    id: "INS-MCP",
    projectId: "",
    trigger: "manual",
    status: "pending",
    lifecycle: { attempt: 1, maxAttempts: 2 },
  };
  // FNXC:PostgresCutover 2026-07-16-07:20: MCP forwarding is a route-boundary
  // assertion, not TaskStore persistence coverage. Model the async insight-run
  // contract directly so this test no longer constructs the deleted SQLite mode.
  const insightStore = {
    findActiveRun: vi.fn(async () => undefined),
    createRunOrThrowConflict: vi.fn(async (projectId: string, input: Record<string, unknown>) => {
      run = { ...run, projectId, ...input } as typeof run;
      return run;
    }),
    updateRun: vi.fn(async (_id: string, patch: Record<string, unknown>) => {
      run = { ...run, ...patch, lifecycle: { ...run.lifecycle, ...(patch.lifecycle as object ?? {}) } } as typeof run;
      return run;
    }),
    appendRunEvent: vi.fn(async () => undefined),
    listStalePendingRuns: vi.fn(async () => []),
  };
  const store = {
    getRootDir: () => root,
    getSettings: vi.fn(async () => ({})),
    getInsightStore: () => insightStore,
  } as TaskStore & { mcpEnabledForTest?: boolean; getSettingsByScope?: unknown };
  if (mode === true) store.mcpEnabledForTest = true;
  if (mode === "no-settings-scope") {
    Object.defineProperty(store, "getSettingsByScope", { value: undefined, configurable: true });
  }
  return { root, store };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveMcpServersForStore.mockImplementation(async (store: { mcpEnabledForTest?: boolean }) => (
    store?.mcpEnabledForTest ? { servers: resolvedMcpServers, errors: [] } : { servers: [], errors: [] }
  ));
  mockPromptWithFallback.mockResolvedValue(undefined);
  mockCreateFnAgent.mockImplementation(async (options?: { onText?: (delta: string) => void; systemPrompt?: string }) => {
    const messages: Array<{ role: string; content: string }> = [];
    return {
      session: {
        state: { messages },
        prompt: vi.fn(async () => {
          if (options?.onText) {
            options.onText(JSON.stringify({
              title: "feat: forward MCP",
              summary: "Summary",
              changes: "Changes",
              testing: "Tests",
              linkedTask: "FN-7078",
            }));
          }
          messages.push({
            role: "assistant",
            content: JSON.stringify({
              title: "Generated Agent",
              icon: "🤖",
              role: "custom",
              description: "Generated description",
              systemPrompt: "Generated prompt",
              thinkingLevel: "low",
              maxTurns: 12,
            }),
          });
        }),
        dispose: vi.fn(),
      },
    };
  });
  execMock.mockImplementation((command: string, options: unknown, callback?: (error: Error | null, stdout: string, stderr: string) => void) => {
    const cb = typeof options === "function" ? options : callback;
    cb?.(null, command.includes("rev-parse") ? "main\n" : "mock output\n", "");
    return { kill: vi.fn() };
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("MCP forwarding for readonly dashboard helper seams", () => {
  it.each([
    ["enabled", createMcpEnabledStore, resolvedMcpServers],
    ["disabled", createMcpDisabledStore, []],
    ["absent", () => undefined, []],
  ])("agent onboarding generation forwards MCP set for %s store", async (_label, storeFactory, expectedServers) => {
    const { startAgentGeneration, generateAgentSpec } = await import("../agent-generation.js");
    const session = await startAgentGeneration(`127.0.0.${Math.floor(Math.random() * 200) + 1}`, "Create a docs helper");
    const store = storeFactory();

    await generateAgentSpec(session.id, "/tmp/project", undefined, store as never);

    expect(mockResolveMcpServersForStore).toHaveBeenCalledWith(store ?? {});
    expect(mockCreateFnAgent).toHaveBeenCalledWith(expect.objectContaining({ tools: "none", mcpServers: expectedServers }));
  });

  it.each([
    ["enabled", createMcpEnabledStore, resolvedMcpServers],
    ["disabled", createMcpDisabledStore, []],
    ["absent", () => undefined, []],
  ])("agent onboarding interview start forwards MCP set for %s store", async (_label, storeFactory, expectedServers) => {
    const { __resetAgentOnboardingState, startAgentOnboardingSession } = await import("../agent-onboarding.js");
    const store = storeFactory();

    try {
      await startAgentOnboardingSession(
        `127.0.0.${Math.floor(Math.random() * 200) + 1}`,
        { intent: "Create a docs helper", existingAgents: [], templates: [] },
        "/tmp/project",
        undefined,
        undefined,
        undefined,
        undefined,
        store as never,
      );

      expect(mockResolveMcpServersForStore).toHaveBeenCalledWith(store ?? {});
      expect(mockCreateFnAgent).toHaveBeenCalledWith(expect.objectContaining({ tools: "readonly", mcpServers: expectedServers }));
    } finally {
      __resetAgentOnboardingState();
    }
  });

  it("agent onboarding interview retry forwards scoped MCP set when recreating an uninitialized helper agent", async () => {
    const { __resetAgentOnboardingState, getAgentOnboardingSession, retryAgentOnboardingSession, startAgentOnboardingSession } = await import("../agent-onboarding.js");
    const startStore = createMcpDisabledStore();
    const retryStore = createMcpEnabledStore();

    try {
      const sessionId = await startAgentOnboardingSession(
        "127.0.0.77",
        { intent: "Create a docs helper", existingAgents: [], templates: [] },
        "/tmp/project",
        undefined,
        undefined,
        undefined,
        undefined,
        startStore as never,
      );
      const session = getAgentOnboardingSession(sessionId) as { agent?: unknown; error?: string };
      session.agent = undefined;
      session.error = "AI generation timed out. You can retry.";
      mockResolveMcpServersForStore.mockClear();
      mockCreateFnAgent.mockClear();

      await retryAgentOnboardingSession(sessionId, retryStore as never);

      expect(mockResolveMcpServersForStore).toHaveBeenCalledWith(retryStore);
      expect(mockCreateFnAgent).toHaveBeenCalledWith(expect.objectContaining({ tools: "readonly", mcpServers: resolvedMcpServers }));
    } finally {
      __resetAgentOnboardingState();
    }
  });

  it.each([
    ["enabled", createMcpEnabledStore, resolvedMcpServers],
    ["disabled", createMcpDisabledStore, []],
    ["absent", () => undefined, []],
  ])("PR metadata generation forwards MCP set for %s store", async (_label, storeFactory, expectedServers) => {
    const { generatePrMetadata } = await import("../pr-metadata-generator.js");
    const store = storeFactory();

    await generatePrMetadata({
      task: createTask(),
      repoRoot: "/tmp/project",
      settings: {},
      store: store as never,
      timeoutMs: 5_000,
    });

    expect(mockResolveMcpServersForStore).toHaveBeenCalledWith(store ?? {});
    expect(mockCreateFnAgent).toHaveBeenCalledWith(expect.objectContaining({ tools: "readonly", mcpServers: expectedServers }));
  });

  it.each([
    ["enabled", true, resolvedMcpServers],
    ["disabled", false, []],
    ["no settings-scope", "no-settings-scope", []],
  ] as const)("insight extraction forwards MCP set for %s scoped store", async (_label, mode, expectedServers) => {
    const { createInsightsRouter } = await import("../insights-routes.js");
    const readWorkingMemorySpy = vi.spyOn(coreModule, "readWorkingMemory").mockResolvedValue("working memory notes");
    vi.spyOn(coreModule, "readInsightsMemory").mockResolvedValue(null);
    vi.spyOn(coreModule, "writeInsightsMemory").mockResolvedValue(undefined);
    vi.spyOn(coreModule, "buildInsightExtractionPrompt").mockReturnValue("prompt");
    vi.spyOn(coreModule, "parseInsightExtractionResponse").mockReturnValue({
      summary: "Extraction summary",
      insights: [],
      extractedAt: "2026-06-26T00:00:00.000Z",
    });
    vi.spyOn(coreModule, "mergeInsights").mockReturnValue("# merged insights");
    const { root, store } = createInsightTaskStore(mode);
    const app = express();
    app.use(express.json());
    const router = createInsightsRouter(store) as ReturnType<typeof createInsightsRouter> & { __disposeSweeper?: () => void };
    app.use("/api/insights", router);

    try {
      const res = await request(app, "POST", "/api/insights/run", JSON.stringify({ trigger: "manual" }), { "content-type": "application/json" });

      expect(res.status).toBe(201);
      expect(readWorkingMemorySpy).toHaveBeenCalledWith(root);
      expect(mockResolveMcpServersForStore).toHaveBeenCalledWith(store);
      expect(mockCreateFnAgent).toHaveBeenCalledWith(expect.objectContaining({ tools: "readonly", mcpServers: expectedServers }));
    } finally {
      router.__disposeSweeper?.();
    }
  });
});
