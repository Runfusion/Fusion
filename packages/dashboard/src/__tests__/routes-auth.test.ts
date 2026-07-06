// @vitest-environment node

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from "vitest";
import express from "express";
import http from "node:http";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { createApiRoutes } from "../routes.js";
import {
  getProjectIdFromRequest as getProjectIdFromRouteRequest,
  getProjectContext as resolveRouteProjectContext,
  getScopedStore as resolveRouteScopedStore,
} from "../routes/context.js";
import { GitHubClient } from "../github.js";
import * as resolveDiffBaseModule from "../routes/resolve-diff-base.js";
import { githubRateLimiter } from "../github-poll.js";
import type { TaskStore, TaskAttachment, Routine, RoutineCreateInput, RoutineUpdateInput, RoutineExecutionResult, ChatSession, ChatMessage } from "@fusion/core";
import type { TaskDetail } from "@fusion/core";
import type { AuthStorageLike, ModelRegistryLike } from "../routes.js";
import { __resetBatchImportRateLimiter, __setCreateFnAgentForRefine } from "../routes.js";
import * as agentGenerationModule from "../agent-generation.js";
import { __resetPlanningState, __setCreateFnAgent, planningStreamManager } from "../planning.js";
import * as planningModule from "../planning.js";
import { __resetSubtaskBreakdownState, subtaskStreamManager } from "../subtask-breakdown.js";
import * as subtaskBreakdownModule from "../subtask-breakdown.js";
import { SESSION_CLEANUP_DEFAULT_MAX_AGE_MS } from "../ai-session-store.js";
import * as usageModule from "../usage.js";
import * as claudeCliProbeModule from "../claude-cli-probe.js";
import * as droidCliProbeModule from "../droid-cli-probe.js";
import * as llamaCppProbeModule from "../llama-cpp-probe.js";
import * as runtimeProviderProbesModule from "../runtime-provider-probes.js";
import * as projectStoreResolver from "../project-store-resolver.js";
import * as terminalServiceModule from "../terminal-service.js";
import { get as performGet, request as performRequest } from "../test-request.js";
import { resetRuntimeLogSink, setRuntimeLogSink } from "../runtime-logger.js";
import { resetDiagnosticsSink, setDiagnosticsSink, type LogEntry } from "../ai-session-diagnostics.js";
import * as updateCheckModule from "../update-check.js";
import { __setAgentReflectionServiceForTests } from "../routes/register-agent-reflection-rating-routes.js";
import { parseGitHubCopilotDeviceCode } from "../routes/register-auth-routes.js";

// Mock @fusion/core for gh CLI auth checks
const mockCentralListProjects = vi.fn().mockResolvedValue([]);
const mockCentralInit = vi.fn().mockResolvedValue(undefined);
const mockCentralClose = vi.fn().mockResolvedValue(undefined);
const mockCentralReconcileProjectStatuses = vi.fn().mockResolvedValue(undefined);
const { mockPerformUpdateCheck, mockClearUpdateCheckCache, mockExecSync, mockExecFile } = vi.hoisted(() => ({
  mockPerformUpdateCheck: vi.fn(),
  mockClearUpdateCheckCache: vi.fn(),
  mockExecSync: vi.fn(),
  mockExecFile: vi.fn(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    access: vi.fn(async (path: actual.PathLike) => {
      const value = String(path);
      if (value.endsWith("auth.json") || value.endsWith("models.json")) return;
      return actual.access(path);
    }),
    readFile: vi.fn(async (path: actual.PathLike, options?: Parameters<typeof actual.readFile>[1]) => {
      const value = String(path);
      if (value.endsWith("auth.json")) return '{"anthropic":{},"openai":{},"cursor-cli":{}}';
      if (value.endsWith("models.json")) return '{"providers":{"anthropic":{"apiKey":"x"},"openai":{"apiKey":"x"},"cursor-cli":{"apiKey":"x"}}}';
      return actual.readFile(path, options as never);
    }),
  };
});

vi.mock("../update-check.js", async () => {
  const actual = await vi.importActual<typeof import("../update-check.js")>("../update-check.js");
  return {
    ...actual,
    performUpdateCheck: mockPerformUpdateCheck,
    clearUpdateCheckCache: mockClearUpdateCheckCache,
  };
});

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  mockExecSync.mockImplementation(((...args: Parameters<typeof actual.execSync>) => actual.execSync(...args)) as typeof actual.execSync);
  // Default execFile mock blocks host-process pgrep calls used by /kill-vitest
  // but passes through all other commands (including git) to preserve route
  // behavior for integration-style API tests in this file.
  mockExecFile.mockImplementation((...callArgs: unknown[]) => {
    const [file, argsOrCb, maybeOptions, maybeCb] = callArgs as [string, unknown, unknown, unknown];
    const args = Array.isArray(argsOrCb) ? argsOrCb : [];
    const cb =
      typeof maybeCb === "function"
        ? (maybeCb as (err: unknown, stdout?: string, stderr?: string) => void)
        : typeof maybeOptions === "function"
          ? (maybeOptions as (err: unknown, stdout?: string, stderr?: string) => void)
          : typeof argsOrCb === "function"
            ? (argsOrCb as (err: unknown, stdout?: string, stderr?: string) => void)
            : null;

    if (file === "pgrep" && args[0] === "-f" && args[1] === "vitest") {
      if (cb) queueMicrotask(() => cb(null, "", ""));
      return;
    }

    return (actual.execFile as (...innerArgs: unknown[]) => unknown)(...callArgs);
  });
  return {
    ...actual,
    execSync: mockExecSync,
    execFile: mockExecFile,
  };
});

vi.mock("@fusion/core", async (importOriginal) => {
  const { createCoreMock } = await import("../test/mockCoreEngine.js");
  return createCoreMock(() => importOriginal<typeof import("@fusion/core")>(), {
    resolveGlobalDir: vi.fn().mockReturnValue("/tmp/fusion-test"),
    GIT_INSTALL_URL: "https://git-scm.com/downloads",
    isGhAvailable: vi.fn(),
    isGhAuthenticated: vi.fn(),
    probeGitCliStatus: vi.fn(),
    isQmdAvailable: vi.fn().mockResolvedValue(false),
    CentralCore: vi.fn().mockImplementation(function () { return {
      init: mockCentralInit,
      close: mockCentralClose,
      listProjects: mockCentralListProjects,
      reconcileProjectStatuses: mockCentralReconcileProjectStatuses,
    }; }),
  });
});

vi.mock("@fusion/engine", async () => {
  const { createEngineMock } = await import("../test/mockCoreEngine.js");
  return createEngineMock({
  createFnAgent: vi.fn(async (options?: { onText?: (delta: string) => void }) => ({
    session: {
      state: {
        messages: [] as Array<{ role: string; content: string }>,
      },
      prompt: vi.fn(async function (this: { state?: { messages?: Array<{ role: string; content: string }> } }, message: string) {
        options?.onText?.("mock-ai-output");
        const messages = this.state?.messages ?? [];
        messages.push({ role: "user", content: message });
        messages.push({
          role: "assistant",
          content: JSON.stringify({
            subtasks: [
              {
                id: "subtask-1",
                title: "Mock subtask",
                description: "Generated by the route test engine mock",
                suggestedSize: "S",
                dependsOn: [],
              },
            ],
          }),
        });
      }),
      dispose: vi.fn(),
    },
  })),
  promptWithFallback: vi.fn(async (session: { prompt: (message: string) => Promise<void> }, prompt: string) => {
    await session.prompt(prompt);
  }),
  AgentReflectionService: class MockAgentReflectionService {
    async generateReflection(): Promise<import("@fusion/core").AgentReflection | null> {
      throw new Error("Reflection service unavailable in route tests");
    }

    async buildReflectionContext(): Promise<never> {
      throw new Error("Reflection service unavailable in route tests");
    }
  },
  });
});

import { AgentStore, Database, RoutineStore, isGhAvailable, isGhAuthenticated, probeGitCliStatus } from "@fusion/core";
import { createFnAgent } from "@fusion/engine";

const mockIsGhAvailable = vi.mocked(isGhAvailable);
const mockIsGhAuthenticated = vi.mocked(isGhAuthenticated);
const mockProbeGitCliStatus = vi.mocked(probeGitCliStatus);

function createMockGlobalSettingsStore() {
  return {
    getSettings: vi.fn().mockResolvedValue({}),
    updateSettings: vi.fn().mockResolvedValue({}),
    getSettingsPath: vi.fn().mockReturnValue("/fake/home/.fusion/settings.json"),
    init: vi.fn().mockResolvedValue(false),
    invalidateCache: vi.fn(),
  };
}

function createMockStore(overrides: Partial<TaskStore> = {}): TaskStore {
  return {
    getTask: vi.fn(),
    listTasks: vi.fn().mockResolvedValue([]),
    searchTasks: vi.fn().mockResolvedValue([]),
    createTask: vi.fn(),
    moveTask: vi.fn(),
    updateTask: vi.fn(),
    deleteTask: vi.fn(),
    mergeTask: vi.fn(),
    archiveTask: vi.fn(),
    unarchiveTask: vi.fn(),
    getSettings: vi.fn().mockResolvedValue({}),
    getSettingsFast: vi.fn().mockResolvedValue({}),
    updateSettings: vi.fn(),
    updateGlobalSettings: vi.fn(),
    getSettingsByScope: vi.fn().mockResolvedValue({ global: {}, project: {} }),
    getSettingsByScopeFast: vi.fn().mockResolvedValue({ global: {}, project: {} }),
    getGlobalSettingsStore: vi.fn().mockReturnValue(createMockGlobalSettingsStore()),
    logEntry: vi.fn().mockResolvedValue(undefined),
    getAgentLogs: vi.fn().mockResolvedValue([]),
    getAgentLogCount: vi.fn().mockResolvedValue(0),
    getAgentLogsByTimeRange: vi.fn().mockResolvedValue([]),
    addSteeringComment: vi.fn(),
    addTaskComment: vi.fn(),
    updateTaskComment: vi.fn(),
    deleteTaskComment: vi.fn(),
    getTaskDocuments: vi.fn().mockResolvedValue([]),
    getTaskDocument: vi.fn().mockResolvedValue(null),
    getTaskDocumentRevisions: vi.fn().mockResolvedValue([]),
    getAllDocuments: vi.fn().mockResolvedValue([]),
    upsertTaskDocument: vi.fn(),
    deleteTaskDocument: vi.fn().mockResolvedValue(undefined),
    updatePrInfo: vi.fn().mockResolvedValue(undefined),
    updatePrInfoByNumber: vi.fn().mockResolvedValue(undefined),
    addPrInfo: vi.fn().mockResolvedValue(undefined),
    updateIssueInfo: vi.fn().mockResolvedValue(undefined),
    getRootDir: vi.fn().mockReturnValue("/fake/root"),
    listWorkflowSteps: vi.fn().mockResolvedValue([]),
    createWorkflowStep: vi.fn(),
    getWorkflowStep: vi.fn(),
    updateWorkflowStep: vi.fn(),
    deleteWorkflowStep: vi.fn(),
    getMissionStore: vi.fn().mockReturnValue({
      listMissions: vi.fn().mockReturnValue([]),
      createMission: vi.fn(),
      getMissionWithHierarchy: vi.fn(),
      updateMission: vi.fn(),
      getMission: vi.fn(),
      deleteMission: vi.fn(),
      listMilestonesByMission: vi.fn().mockReturnValue([]),
      createMilestone: vi.fn(),
      updateMilestone: vi.fn(),
      getMilestone: vi.fn(),
      deleteMilestone: vi.fn(),
      listTasksByMilestone: vi.fn().mockReturnValue([]),
      createMissionTask: vi.fn(),
      updateMissionTask: vi.fn(),
      getMissionTask: vi.fn(),
      deleteMissionTask: vi.fn(),
    }),
    ...overrides,
  } as unknown as TaskStore;
}

const TASK_TOKEN_USAGE_FIXTURE = {
  inputTokens: 1200,
  outputTokens: 450,
  cachedTokens: 210,
  totalTokens: 1860,
  firstUsedAt: "2026-04-24T09:00:00.000Z",
  lastUsedAt: "2026-04-24T10:15:00.000Z",
};

const FAKE_TASK_DETAIL: TaskDetail = {
  id: "FN-001",
  description: "Test task",
  column: "in-progress",
  dependencies: [],
  steps: [],
  currentStep: 0,
  log: [],
  tokenUsage: TASK_TOKEN_USAGE_FIXTURE,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  prompt: "# KB-001\n\nTest task",
};

async function GET(app: express.Express, path: string): Promise<{ status: number; body: any }> {
  const res = await performGet(app, path);
  return { status: res.status, body: res.body };
}

async function REQUEST(
  app: express.Express,
  method: string,
  path: string,
  body?: Buffer | string,
  headers?: Record<string, string>,
): Promise<{ status: number; body: any }> {
  const res = await performRequest(app, method, path, body, headers);
  return { status: res.status, body: res.body };
}

function collectOrderedRouteKeys(router: express.Router): string[] {
  const stack = (router as unknown as {
    stack?: Array<{ route?: { path?: string; methods?: Record<string, boolean> } }>;
  }).stack ?? [];

  const orderedKeys: string[] = [];
  for (const layer of stack) {
    const route = layer.route;
    if (!route?.path || !route.methods) continue;
    const method = Object.keys(route.methods).find((name) => route.methods?.[name]);
    if (!method) continue;
    orderedKeys.push(`${method.toUpperCase()} ${route.path}`);
  }
  return orderedKeys;
}

afterEach(() => {
  resetDiagnosticsSink();
});


// --- Models route tests ---

function createMockModelRegistry(overrides: Partial<ModelRegistryLike> = {}): ModelRegistryLike {
  return {
    refresh: vi.fn(),
    getAvailable: vi.fn().mockReturnValue([
      { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", provider: "anthropic", reasoning: true, contextWindow: 200000 },
      { id: "gpt-4o", name: "GPT-4o", provider: "openai", reasoning: false, contextWindow: 128000 },
    ]),
    ...overrides,
  };
}

function createMutableModelRegistry(initialModels: Array<Record<string, any>>): ModelRegistryLike & { models: Array<Record<string, any>> } {
  const registry = {
    models: [...initialModels],
    refresh: vi.fn(),
    getAll: vi.fn(() => registry.models as any),
    getAvailable: vi.fn(() => registry.models as any),
    registerProvider: vi.fn((providerName: string, config: { models?: Array<Record<string, any>> }) => {
      registry.models = registry.models.filter((model) => model.provider !== providerName);
      registry.models.push(...(config.models ?? []).map((model) => ({ ...model, provider: providerName })));
    }),
  };
  return registry;
}

describe("GET /models", () => {
  let store: TaskStore;

  beforeEach(() => {
    store = createMockStore();
  });

  function buildApp(modelRegistry?: ModelRegistryLike, authStorage?: AuthStorageLike) {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store, { modelRegistry, authStorage }));
    return app;
  }

  it("returns available models from registry", async () => {
    const modelRegistry = createMockModelRegistry();
    const res = await GET(buildApp(modelRegistry), "/api/models");

    expect(res.status).toBe(200);
    expect(res.body.models).toEqual([
      { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", reasoning: true, contextWindow: 200000 },
      { provider: "openai", id: "gpt-4o", name: "GPT-4o", reasoning: false, contextWindow: 128000 },
    ]);
    expect(modelRegistry.refresh).toHaveBeenCalled();
  });

  it("returns empty array when no model registry is provided", async () => {
    const res = await GET(buildApp(), "/api/models");

    expect(res.status).toBe(200);
    expect(res.body.models).toEqual([]);
  });

  it("returns empty array when registry has no available models", async () => {
    const modelRegistry = createMockModelRegistry({
      getAvailable: vi.fn().mockReturnValue([]),
    });
    const res = await GET(buildApp(modelRegistry), "/api/models");

    expect(res.status).toBe(200);
    expect(res.body.models).toEqual([]);
  });

  it("returns empty array when registry throws", async () => {
    const modelRegistry = createMockModelRegistry({
      getAvailable: vi.fn().mockImplementation(() => {
        throw new Error("registry error");
      }),
    });
    const res = await GET(buildApp(modelRegistry), "/api/models");

    expect(res.status).toBe(200);
    expect(res.body.models).toEqual([]);
  });

  it("advertises Claude Sonnet 5 for configured direct Anthropic users", async () => {
    const modelRegistry = createMutableModelRegistry([
      { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", provider: "anthropic", reasoning: true, contextWindow: 200000 },
      { id: "gpt-4o", name: "GPT-4o", provider: "openai", reasoning: false, contextWindow: 128000 },
    ]);

    const res = await GET(buildApp(modelRegistry), "/api/models");

    expect(res.status).toBe(200);
    // Sonnet 5 is re-advertised via SUPPLEMENTAL_ANTHROPIC_PROVIDER_REGISTRATION (works on API key + CLI).
    expect(res.body.models).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: "anthropic", id: "claude-sonnet-4-5" }),
      expect.objectContaining({ provider: "anthropic", id: "claude-sonnet-5" }),
    ]));
    expect(modelRegistry.registerProvider).toHaveBeenCalledWith("anthropic", expect.objectContaining({
      models: expect.arrayContaining([expect.objectContaining({ id: "claude-sonnet-5" })]),
    }));
  });

  it("does not expose Claude Sonnet 5 when direct Anthropic is not configured", async () => {
    const readFileSpy = vi.spyOn(fsPromises, "readFile").mockImplementation(async (path: any) => {
      const value = String(path);
      if (value.endsWith("auth.json")) return "{}" as never;
      if (value.endsWith("models.json")) return '{"providers":{}}' as never;
      return "{}" as never;
    });
    try {
      const modelRegistry = createMutableModelRegistry([
        { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", provider: "anthropic", reasoning: true, contextWindow: 200000 },
      ]);

      const res = await GET(buildApp(modelRegistry), "/api/models");

      expect(res.status).toBe(200);
      expect(res.body.models).toEqual([]);
      // Sonnet 5 is merged into the registry from supplemental metadata, but stays hidden
      // from the response because no Anthropic auth is configured (provider-visibility filter).
      expect(modelRegistry.models.some((model) => model.id === "claude-sonnet-5")).toBe(true);
      expect(res.body.models.some((model: { id: string }) => model.id === "claude-sonnet-5")).toBe(false);
    } finally {
      readFileSpy.mockRestore();
    }
  });

  it("dedupes Claude Sonnet 5 when upstream registry already includes it", async () => {
    const modelRegistry = createMutableModelRegistry([
      { id: "claude-sonnet-5", name: "Claude Sonnet 5 Upstream", provider: "anthropic", reasoning: true, contextWindow: 1_000_000, maxTokens: 128_000 },
    ]);

    const res = await GET(buildApp(modelRegistry), "/api/models");

    expect(res.status).toBe(200);
    const sonnetFiveRows = res.body.models.filter((model: { provider: string; id: string }) => model.provider === "anthropic" && model.id === "claude-sonnet-5");
    expect(sonnetFiveRows).toHaveLength(1);
    expect(modelRegistry.registerProvider).not.toHaveBeenCalled();
  });

  // Regression guard: FN-2370's auto-resolved squash inverted this filter,
  // emptying every model picker in the UI. The filter is small but the
  // failure mode is silent and project-wide — keep these tests close to the
  // route so any future flip flips CI red immediately.
  describe("useClaudeCli filter", () => {
    function buildAppWithSetting(useClaudeCli: boolean | undefined, modelRegistry: ModelRegistryLike, authStorage?: AuthStorageLike) {
      const globalStore = createMockGlobalSettingsStore();
      (globalStore.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue(
        useClaudeCli === undefined ? {} : { useClaudeCli },
      );
      (store.getGlobalSettingsStore as ReturnType<typeof vi.fn>).mockReturnValue(globalStore);
      return buildApp(modelRegistry, authStorage);
    }

    function registryWithAnthropicSurfaces(): ModelRegistryLike {
      return createMockModelRegistry({
        getAvailable: vi.fn().mockReturnValue([
          { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", provider: "anthropic", reasoning: true, contextWindow: 200000 },
          { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5 OAuth", provider: "anthropic-subscription", reasoning: true, contextWindow: 200000 },
          { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5 (CLI)", provider: "pi-claude-cli", reasoning: true, contextWindow: 200000 },
          { id: "claude-sonnet-5", name: "Claude Sonnet 5 (CLI)", provider: "pi-claude-cli", reasoning: true, contextWindow: 1_000_000 },
          { id: "claude-sonnet-5", name: "Claude Sonnet 5 Duplicate (CLI)", provider: "pi-claude-cli", reasoning: true, contextWindow: 1_000_000 },
        ]),
      });
    }

    async function withNoFilesystemProviders(run: () => Promise<void>) {
      await vi.mocked(fsPromises.readFile).withImplementation(async (path: unknown) => {
        const value = String(path);
        if (value.endsWith("auth.json")) return "{}";
        if (value.endsWith("models.json")) return JSON.stringify({ providers: {} });
        return "{}";
      }, run);
    }

    function registryWithCli(): ModelRegistryLike {
      return createMockModelRegistry({
        getAvailable: vi.fn().mockReturnValue([
          { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", provider: "anthropic", reasoning: true, contextWindow: 200000 },
          { id: "gpt-4o", name: "GPT-4o", provider: "openai", reasoning: false, contextWindow: 128000 },
          { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5 (CLI)", provider: "pi-claude-cli", reasoning: true, contextWindow: 200000 },
          { id: "claude-sonnet-5", name: "Claude Sonnet 5 (CLI)", provider: "pi-claude-cli", reasoning: true, contextWindow: 1_000_000 },
          { id: "claude-sonnet-5", name: "Claude Sonnet 5 Duplicate (CLI)", provider: "pi-claude-cli", reasoning: true, contextWindow: 1_000_000 },
        ]),
      });
    }

    it("hides pi-claude-cli entries, including Claude Sonnet 5, when useClaudeCli is false", async () => {
      const res = await GET(buildAppWithSetting(false, registryWithCli()), "/api/models");
      expect(res.status).toBe(200);
      const providers = res.body.models.map((m: { provider: string }) => m.provider);
      expect(providers).not.toContain("pi-claude-cli");
      expect(res.body.models).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ provider: "pi-claude-cli", id: "claude-sonnet-5" }),
      ]));
      expect(providers).toEqual(expect.arrayContaining(["anthropic", "openai"]));
    });

    it("hides pi-claude-cli entries when setting is unset (default off)", async () => {
      const res = await GET(buildAppWithSetting(undefined, registryWithCli()), "/api/models");
      expect(res.status).toBe(200);
      const providers = res.body.models.map((m: { provider: string }) => m.provider);
      expect(providers).not.toContain("pi-claude-cli");
    });

    it("includes pi-claude-cli Claude Sonnet 5 exactly once alongside other providers when useClaudeCli is true", async () => {
      const res = await GET(buildAppWithSetting(true, registryWithCli()), "/api/models");
      expect(res.status).toBe(200);
      const providers = res.body.models.map((m: { provider: string }) => m.provider);
      expect(providers).toEqual(expect.arrayContaining(["anthropic", "openai", "pi-claude-cli"]));
      const cliSonnetFiveRows = res.body.models.filter((m: { provider: string; id: string }) => m.provider === "pi-claude-cli" && m.id === "claude-sonnet-5");
      expect(cliSonnetFiveRows).toHaveLength(1);
      expect(cliSonnetFiveRows[0]).toEqual(expect.objectContaining({
        name: "Claude Sonnet 5 (CLI)",
        contextWindow: 1_000_000,
      }));
    });

    it("uses authStorage subscription OAuth plus Claude CLI to expose both direct Anthropic and CLI rows", async () => {
      await withNoFilesystemProviders(async () => {
        const authStorage = createMockAuthStorage({
          getOAuthProviders: vi.fn().mockReturnValue([{ id: "anthropic", name: "Anthropic" }]),
          hasAuth: vi.fn((provider: string) => provider === "anthropic-subscription"),
          get: vi.fn((provider: string) => provider === "anthropic-subscription" ? {
            type: "oauth",
            access: "subscription-oauth",
            refresh: "refresh",
            expires: Date.now() + 60_000,
          } : undefined),
        });

        const res = await GET(buildAppWithSetting(true, registryWithAnthropicSurfaces(), authStorage), "/api/models");

        expect(res.status).toBe(200);
        expect(res.body.models).not.toEqual([]);
        const providers = res.body.models.map((m: { provider: string }) => m.provider);
        // Subscription OAuth exposes the direct `anthropic` provider AND the CLI is selectable.
        expect(providers).toContain("anthropic");
        expect(providers).toContain("pi-claude-cli");
        expect(providers).not.toContain("anthropic-subscription");
        const cliSonnetFiveRows = res.body.models.filter((m: { provider: string; id: string }) => m.provider === "pi-claude-cli" && m.id === "claude-sonnet-5");
        expect(cliSonnetFiveRows).toHaveLength(1);
      });
    });

    it("exposes direct Anthropic rows for legacy OAuth while Claude CLI remains selectable", async () => {
      await withNoFilesystemProviders(async () => {
        const authStorage = createMockAuthStorage({
          getOAuthProviders: vi.fn().mockReturnValue([{ id: "anthropic", name: "Anthropic" }]),
          hasAuth: vi.fn((provider: string) => provider === "anthropic"),
          get: vi.fn((provider: string) => provider === "anthropic" ? {
            type: "oauth",
            access: "legacy-oauth",
            refresh: "refresh",
            expires: Date.now() + 60_000,
          } : undefined),
        });

        const res = await GET(buildAppWithSetting(true, registryWithAnthropicSurfaces(), authStorage), "/api/models");

        expect(res.status).toBe(200);
        const providers = res.body.models.map((m: { provider: string }) => m.provider);
        // Restored v0.51.0: legacy OAuth makes the direct `anthropic` provider selectable
        // (pi-ai runs it on /v1 via Claude Code impersonation). `anthropic-subscription` is
        // an auth/status id only, never a picker row.
        expect(providers).toContain("anthropic");
        expect(providers).toContain("pi-claude-cli");
        expect(providers).not.toContain("anthropic-subscription");
        expect(res.body.models).toEqual(expect.arrayContaining([
          expect.objectContaining({ provider: "pi-claude-cli", id: "claude-sonnet-5" }),
        ]));
      });
    });

    it("uses authStorage raw Anthropic API key to expose direct rows without requiring OAuth", async () => {
      await withNoFilesystemProviders(async () => {
        const authStorage = createMockAuthStorage({
          getApiKeyProviders: vi.fn().mockReturnValue([{ id: "anthropic-api-key", name: "Anthropic API Key" }]),
          hasApiKey: vi.fn((provider: string) => provider === "anthropic-api-key"),
          get: vi.fn((provider: string) => provider === "anthropic-api-key" ? {
            type: "api_key",
            key: "sk-ant-api03-direct",
          } : undefined),
        });

        const res = await GET(buildAppWithSetting(false, registryWithAnthropicSurfaces(), authStorage), "/api/models");

        expect(res.status).toBe(200);
        const providers = res.body.models.map((m: { provider: string }) => m.provider);
        expect(providers).toContain("anthropic");
        expect(providers).not.toContain("pi-claude-cli");
        expect(providers).not.toContain("anthropic-subscription");
      });
    });

    it("exposes the direct Anthropic provider for subscription OAuth even when Claude CLI is disabled", async () => {
      await withNoFilesystemProviders(async () => {
        const authStorage = createMockAuthStorage({
          getOAuthProviders: vi.fn().mockReturnValue([{ id: "anthropic", name: "Anthropic" }]),
          hasAuth: vi.fn((provider: string) => provider === "anthropic-subscription"),
          get: vi.fn((provider: string) => provider === "anthropic-subscription" ? {
            type: "oauth",
            access: "subscription-oauth",
            refresh: "refresh",
            expires: Date.now() + 60_000,
          } : undefined),
        });

        const res = await GET(buildAppWithSetting(false, registryWithAnthropicSurfaces(), authStorage), "/api/models");

        expect(res.status).toBe(200);
        const providers = res.body.models.map((m: { provider: string }) => m.provider);
        // Subscription OAuth drives the direct `anthropic` provider; the CLI stays hidden
        // (disabled) and `anthropic-subscription` is never advertised as its own picker row.
        expect(providers).toContain("anthropic");
        expect(providers).not.toContain("anthropic-subscription");
        expect(providers).not.toContain("pi-claude-cli");
      });
    });

    it("exposes direct Anthropic rows for OAuth-only subscription auth alongside distinct Claude CLI rows", async () => {
      await vi.mocked(fsPromises.readFile).withImplementation(async (path: unknown) => {
        const value = String(path);
        if (value.endsWith("auth.json")) {
          return JSON.stringify({
            anthropic: { type: "oauth", access: "legacy-oauth", refresh: "refresh", expires: Date.now() + 60_000 },
            "anthropic-subscription": { type: "oauth", access: "subscription-oauth", refresh: "refresh", expires: Date.now() + 60_000 },
            openai: { type: "api_key", key: "openai-key" },
          });
        }
        if (value.endsWith("models.json")) {
          return JSON.stringify({ providers: { openai: { apiKey: "openai-key" } } });
        }
        return "{}";
      }, async () => {
        const registry = createMockModelRegistry({
          getAvailable: vi.fn().mockReturnValue([
            { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", provider: "anthropic", reasoning: true, contextWindow: 200000 },
            { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5 OAuth", provider: "anthropic-subscription", reasoning: true, contextWindow: 200000 },
            { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5 (CLI)", provider: "pi-claude-cli", reasoning: true, contextWindow: 200000 },
            { id: "gpt-4o", name: "GPT-4o", provider: "openai", reasoning: false, contextWindow: 128000 },
          ]),
        });
        const res = await GET(buildAppWithSetting(true, registry), "/api/models");
        expect(res.status).toBe(200);
        const providers = res.body.models.map((m: { provider: string }) => m.provider);
        // auth.json legacy + subscription OAuth both make the direct `anthropic` provider
        // selectable; `anthropic-subscription` remains an auth id, not a picker row.
        expect(providers).toContain("anthropic");
        expect(providers).toContain("pi-claude-cli");
        expect(providers).toContain("openai");
        expect(providers).not.toContain("anthropic-subscription");
      });
    });

    it("exposes direct Anthropic rows for OAuth-only auth even when the Claude CLI picker is disabled", async () => {
      await vi.mocked(fsPromises.readFile).withImplementation(async (path: unknown) => {
        const value = String(path);
        if (value.endsWith("auth.json")) {
          return JSON.stringify({
            "anthropic-subscription": { type: "oauth", access: "subscription-oauth", refresh: "refresh", expires: Date.now() + 60_000 },
          });
        }
        if (value.endsWith("models.json")) {
          return JSON.stringify({ providers: {} });
        }
        return "{}";
      }, async () => {
        const res = await GET(buildAppWithSetting(false, registryWithCli()), "/api/models");
        expect(res.status).toBe(200);
        const providers = res.body.models.map((m: { provider: string }) => m.provider);
        // Subscription OAuth (file-scan path) advertises the direct `anthropic` provider; the
        // CLI stays hidden while disabled, and `anthropic-subscription` is not a picker row.
        expect(providers).toContain("anthropic");
        expect(providers).not.toContain("anthropic-subscription");
        expect(providers).not.toContain("pi-claude-cli");
      });
    });

    it("shows direct Anthropic rows when a raw API key exists", async () => {
      await vi.mocked(fsPromises.readFile).withImplementation(async (path: unknown) => {
        const value = String(path);
        if (value.endsWith("auth.json")) {
          return JSON.stringify({ anthropic: { type: "api_key", key: "sk-ant-api03-direct" } });
        }
        if (value.endsWith("models.json")) {
          return JSON.stringify({ providers: {} });
        }
        return "{}";
      }, async () => {
        const res = await GET(buildAppWithSetting(false, registryWithCli()), "/api/models");
        expect(res.status).toBe(200);
        const providers = res.body.models.map((m: { provider: string }) => m.provider);
        expect(providers).toContain("anthropic");
        expect(providers).not.toContain("pi-claude-cli");
      });
    });
  });
});

describe("GET /usage", () => {
  let store: TaskStore;

  beforeEach(() => {
    store = createMockStore();
  });

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store));
    return app;
  }

  it("returns provider usage payload", async () => {
    const providers = [{ name: "Claude", icon: "🤖", status: "ok", windows: [] }];
    const usageSpy = vi.spyOn(usageModule, "fetchAllProviderUsage").mockResolvedValue(providers as never);

    const res = await GET(buildApp(), "/api/usage");

    usageSpy.mockRestore();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ providers });
  });

  it("maps usage fetch errors to 500 responses", async () => {
    const usageSpy = vi.spyOn(usageModule, "fetchAllProviderUsage").mockRejectedValue(new Error("usage boom"));

    const res = await GET(buildApp(), "/api/usage");

    usageSpy.mockRestore();

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("usage boom");
  });
});

describe("/update-check routes", () => {
  let store: TaskStore;

  beforeEach(() => {
    store = createMockStore();
    mockPerformUpdateCheck.mockReset();
    mockClearUpdateCheckCache.mockReset();
  });

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store));
    return app;
  }

  it("GET /update-check returns disabled payload when update checks are disabled", async () => {
    const mockGlobalStore = createMockGlobalSettingsStore();
    mockGlobalStore.getSettings.mockResolvedValue({ updateCheckEnabled: false });
    (store.getGlobalSettingsStore as ReturnType<typeof vi.fn>).mockReturnValue(mockGlobalStore);

    const res = await GET(buildApp(), "/api/update-check");

    expect(res.status).toBe(200);
    expect(res.body.updateAvailable).toBe(false);
    expect(res.body.disabled).toBe(true);
    expect(mockPerformUpdateCheck).not.toHaveBeenCalled();
  });

  it("GET /update-check performs update check when enabled", async () => {
    const mockGlobalStore = createMockGlobalSettingsStore();
    mockGlobalStore.getSettings.mockResolvedValue({ updateCheckEnabled: true });
    (store.getGlobalSettingsStore as ReturnType<typeof vi.fn>).mockReturnValue(mockGlobalStore);

    mockPerformUpdateCheck.mockResolvedValue({
      currentVersion: "0.1.0",
      latestVersion: "0.2.0",
      updateAvailable: true,
      lastChecked: 123,
    });

    const res = await GET(buildApp(), "/api/update-check");

    expect(res.status).toBe(200);
    expect(res.body.updateAvailable).toBe(true);
    expect(res.body.latestVersion).toBe("0.2.0");
    expect(updateCheckModule.performUpdateCheck).toHaveBeenCalledOnce();
  });

  it("POST /update-check/refresh clears cache then rechecks", async () => {
    mockPerformUpdateCheck.mockResolvedValue({
      currentVersion: "0.1.0",
      latestVersion: "0.1.0",
      updateAvailable: false,
      lastChecked: 123,
    });

    const res = await REQUEST(buildApp(), "POST", "/api/update-check/refresh");

    expect(res.status).toBe(200);
    expect(updateCheckModule.clearUpdateCheckCache).toHaveBeenCalledOnce();
    expect(updateCheckModule.performUpdateCheck).toHaveBeenCalledOnce();
  });
});

// --- Auth route tests ---

function createMockAuthStorage(overrides: Partial<AuthStorageLike> = {}): AuthStorageLike {
  return {
    reload: vi.fn(),
    getOAuthProviders: vi.fn().mockReturnValue([
      { id: "github-copilot", name: "GitHub Copilot" },
    ]),
    hasAuth: vi.fn().mockReturnValue(false),
    get: vi.fn().mockReturnValue(undefined),
    getApiKey: vi.fn().mockResolvedValue(undefined),
    login: vi.fn().mockImplementation((_provider: string, callbacks: any) => {
      // Simulate onAuth callback with a URL, then resolve
      callbacks.onAuth({ url: "https://auth.example.com/login", instructions: "Open in browser" });
      return Promise.resolve();
    }),
    logout: vi.fn(),
    getApiKeyProviders: vi.fn().mockReturnValue([
      { id: "openrouter", name: "OpenRouter" },
      { id: "kimi-coding", name: "Kimi" },
    ]),
    hasApiKey: vi.fn().mockReturnValue(false),
    setApiKey: vi.fn(),
    clearApiKey: vi.fn(),
    ...overrides,
  } as unknown as AuthStorageLike;
}

describe("GET /auth/status", () => {
  let store: TaskStore;
  let authStorage: AuthStorageLike;
  let app: express.Express;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeAll(() => {
    store = createMockStore();
    authStorage = createMockAuthStorage();
    app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store, { authStorage }));
  });

  beforeEach(() => {
    mockProbeGitCliStatus.mockResolvedValue({
      available: true,
      version: "2.45.1",
      installUrl: "https://git-scm.com/downloads",
    });
    mockIsGhAvailable.mockReturnValue(false);
    mockIsGhAuthenticated.mockReturnValue(false);

    vi.spyOn(claudeCliProbeModule, "probeClaudeCli").mockResolvedValue({
      available: false,
      reason: "mocked unavailable",
      probeDurationMs: 0,
    });
    vi.spyOn(droidCliProbeModule, "probeDroidCli").mockResolvedValue({
      available: false,
      reason: "mocked unavailable",
      probeDurationMs: 0,
    });
    vi.spyOn(runtimeProviderProbesModule, "probeCursorCliProvider").mockResolvedValue({
      available: false,
      reason: "mocked unavailable",
      probeDurationMs: 0,
    });
    vi.spyOn(llamaCppProbeModule, "probeLlamaCpp").mockResolvedValue({
      available: false,
      reason: "mocked unavailable",
      probeDurationMs: 0,
    });

    vi.mocked(authStorage.reload).mockReset();
    vi.mocked(authStorage.getOAuthProviders).mockReset();
    vi.mocked(authStorage.hasAuth).mockReset();
    vi.mocked(authStorage.get).mockReset();
    vi.mocked(authStorage.getApiKey).mockReset();
    vi.mocked(authStorage.login).mockReset();
    vi.mocked(authStorage.getApiKeyProviders).mockReset();
    vi.mocked(authStorage.hasApiKey).mockReset();
    vi.mocked(authStorage.setApiKey).mockReset();
    vi.mocked(authStorage.clearApiKey).mockReset();

    vi.mocked(authStorage.reload).mockResolvedValue(undefined);
    vi.mocked(authStorage.getOAuthProviders).mockReturnValue([{ id: "github-copilot", name: "GitHub Copilot" }]);
    vi.mocked(authStorage.hasAuth).mockReturnValue(false);
    vi.mocked(authStorage.get).mockReturnValue(undefined);
    vi.mocked(authStorage.getApiKey).mockResolvedValue(undefined);
    vi.mocked(authStorage.login).mockImplementation((_provider: string, callbacks: any) => {
      callbacks.onAuth({ url: "https://auth.example.com/login", instructions: "Open in browser" });
      return Promise.resolve();
    });
    vi.mocked(authStorage.getApiKeyProviders).mockReturnValue([
      { id: "openrouter", name: "OpenRouter" },
      { id: "kimi-coding", name: "Kimi" },
    ]);
    vi.mocked(authStorage.hasApiKey).mockReturnValue(false);
  });

  it("returns provider list with auth status", async () => {
    (authStorage.hasAuth as ReturnType<typeof vi.fn>).mockReturnValue(true);

    const res = await GET(app, "/api/auth/status");

    expect(res.status).toBe(200);
    // Filter out synthetic CLI providers — they have dedicated route tests.
    // Structural assertions here are about OAuth + API-key paths only.
    const providers = res.body.providers.filter((p: any) => p.id !== "claude-cli" && p.id !== "droid-cli" && p.id !== "cursor-cli" && p.id !== "llama-cpp");
    expect(providers).toEqual([
      { id: "github-copilot", name: "GitHub Copilot", authenticated: true, type: "oauth", expired: false, loginInProgress: false },
      { id: "openrouter", name: "OpenRouter", authenticated: false, type: "api_key" },
      { id: "kimi-coding", name: "Kimi", authenticated: false, type: "api_key" },
    ]);
    expect(authStorage.reload).toHaveBeenCalled();
  });

  it("includes git CLI status while preserving gh CLI status", async () => {
    mockIsGhAvailable.mockReturnValue(true);
    mockIsGhAuthenticated.mockReturnValue(true);
    mockProbeGitCliStatus.mockResolvedValue({
      available: true,
      version: "2.45.1",
      installUrl: "https://git-scm.com/downloads",
    });

    const res = await GET(app, "/api/auth/status");

    expect(res.status).toBe(200);
    expect(res.body.ghCli).toEqual({ available: true, authenticated: true });
    expect(res.body.gitCli).toEqual({
      available: true,
      version: "2.45.1",
      installUrl: "https://git-scm.com/downloads",
    });
  });

  it("reports missing git CLI without changing provider readiness", async () => {
    mockProbeGitCliStatus.mockResolvedValue({
      available: false,
      installUrl: "https://git-scm.com/downloads",
    });

    const res = await GET(app, "/api/auth/status");

    expect(res.status).toBe(200);
    expect(res.body.gitCli).toEqual({
      available: false,
      installUrl: "https://git-scm.com/downloads",
    });
    expect(res.body.providers).toEqual(expect.any(Array));
    expect(res.body.ghCli).toEqual({ available: false, authenticated: false });
  });

  it("degrades git CLI probe errors to an unavailable status", async () => {
    mockProbeGitCliStatus.mockRejectedValue(new Error("probe failed"));

    const res = await GET(app, "/api/auth/status");

    expect(res.status).toBe(200);
    expect(res.body.gitCli).toEqual({
      available: false,
      installUrl: "https://git-scm.com/downloads",
    });
  });

  it("includes GitHub Copilot as oauth when auth storage reports it", async () => {
    (authStorage.getOAuthProviders as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: "github-copilot", name: "GitHub Copilot" },
    ]);
    (authStorage.hasAuth as ReturnType<typeof vi.fn>).mockImplementation((provider: string) => provider === "github-copilot");

    const res = await GET(app, "/api/auth/status");

    expect(res.status).toBe(200);
    const githubCopilot = res.body.providers.find((p: any) => p.id === "github-copilot");
    expect(githubCopilot).toEqual({
      id: "github-copilot",
      name: "GitHub Copilot",
      authenticated: true,
      type: "oauth",
      expired: false,
      loginInProgress: false,
    });
  });

  it("includes oauth and model-registry-derived API key providers in one response", async () => {
    (authStorage.getOAuthProviders as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: "github-copilot", name: "GitHub Copilot" },
      { id: "openai-codex", name: "OpenAI Codex" },
    ]);
    (authStorage.getApiKeyProviders as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: "openrouter", name: "OpenRouter" },
      { id: "kimi-coding", name: "Kimi" },
      { id: "acme-extension", name: "Acme Extension" },
    ]);
    (authStorage.hasAuth as ReturnType<typeof vi.fn>).mockImplementation((provider: string) => provider === "github-copilot");
    (authStorage.hasApiKey as ReturnType<typeof vi.fn>).mockImplementation((provider: string) => provider === "acme-extension");

    const res = await GET(app, "/api/auth/status");

    expect(res.status).toBe(200);
    const providers = res.body.providers.filter((p: any) => p.id !== "claude-cli" && p.id !== "droid-cli" && p.id !== "cursor-cli" && p.id !== "llama-cpp");
    expect(providers).toEqual([
      { id: "github-copilot", name: "GitHub Copilot", authenticated: true, type: "oauth", expired: false, loginInProgress: false },
      { id: "openai-codex", name: "OpenAI Codex", authenticated: false, type: "oauth", expired: false, loginInProgress: false, requiresManualCode: true },
      { id: "openrouter", name: "OpenRouter", authenticated: false, type: "api_key" },
      { id: "kimi-coding", name: "Kimi", authenticated: false, type: "api_key" },
      { id: "acme-extension", name: "Acme Extension", authenticated: true, type: "api_key" },
    ]);
  });

  it.each(["https://my-host.example.com", undefined])(
    "marks manual-code oauth providers during auth status when origin is %s",
    async (origin) => {
      (authStorage.getOAuthProviders as ReturnType<typeof vi.fn>).mockReturnValue([
        { id: "github-copilot", name: "GitHub Copilot" },
        { id: "openai-codex", name: "OpenAI Codex" },
        { id: "anthropic", name: "Anthropic" },
      ]);
      (authStorage.getApiKeyProviders as ReturnType<typeof vi.fn>).mockReturnValue([
        { id: "openrouter", name: "OpenRouter" },
      ]);

      const res = origin
        ? await REQUEST(app, "GET", "/api/auth/status", undefined, { Origin: origin })
        : await REQUEST(app, "GET", "/api/auth/status");

      expect(res.status).toBe(200);
      const openAiCodex = res.body.providers.find((p: any) => p.id === "openai-codex");
      const anthropic = res.body.providers.find((p: any) => p.id === "anthropic-subscription");
      const githubCopilot = res.body.providers.find((p: any) => p.id === "github-copilot");
      const openrouter = res.body.providers.find((p: any) => p.id === "openrouter");
      const claudeCli = res.body.providers.find((p: any) => p.id === "claude-cli");

      expect(openAiCodex.requiresManualCode).toBe(true);
      expect(anthropic.requiresManualCode).toBe(true);
      expect(githubCopilot).not.toHaveProperty("requiresManualCode");
      expect(openrouter).not.toHaveProperty("requiresManualCode");
      expect(claudeCli).not.toHaveProperty("requiresManualCode");
    },
  );

  it("returns unauthenticated status", async () => {
    (authStorage.hasAuth as ReturnType<typeof vi.fn>).mockReturnValue(false);

    const res = await GET(app, "/api/auth/status");

    expect(res.status).toBe(200);
    expect(res.body.providers[0].authenticated).toBe(false);
  });

  it("reports oauth expired flag for valid, expired, and missing credentials", async () => {
    const now = Date.now();
    (authStorage.getOAuthProviders as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: "github-copilot", name: "GitHub Copilot" },
      { id: "claude", name: "Claude" },
      { id: "gemini-oauth", name: "Gemini OAuth" },
    ]);
    (authStorage.hasAuth as ReturnType<typeof vi.fn>).mockImplementation(
      (provider: string) => provider !== "gemini-oauth",
    );
    (authStorage.get as ReturnType<typeof vi.fn>).mockImplementation((provider: string) => {
      if (provider === "github-copilot") {
        return { type: "oauth", access: "token", refresh: "refresh", expires: now + 60_000 };
      }
      if (provider === "claude") {
        return { type: "oauth", access: "token", refresh: "refresh", expires: now - 1_000 };
      }
      return undefined;
    });

    const res = await GET(app, "/api/auth/status");

    expect(res.status).toBe(200);
    const githubCopilot = res.body.providers.find((p: any) => p.id === "github-copilot");
    const claude = res.body.providers.find((p: any) => p.id === "claude");
    const geminiOauth = res.body.providers.find((p: any) => p.id === "gemini-oauth");

    expect(githubCopilot).toMatchObject({ authenticated: true, expired: false });
    expect(claude).toMatchObject({ authenticated: false, expired: true });
    expect(geminiOauth).toMatchObject({ authenticated: false, expired: false });
  });

  it("attempts async refresh for expired oauth before reporting status", async () => {
    const now = Date.now();
    let refreshed = false;
    (authStorage.getOAuthProviders as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: "anthropic", name: "Anthropic" },
    ]);
    (authStorage.hasAuth as ReturnType<typeof vi.fn>).mockImplementation((provider: string) => provider === "anthropic-subscription");
    (authStorage.get as ReturnType<typeof vi.fn>).mockImplementation((provider: string) => provider === "anthropic-subscription" ? ({
      type: "oauth",
      access: refreshed ? "refreshed-token" : "expired-token",
      refresh: "refresh",
      expires: refreshed ? now + 3_600_000 : now - 1_000,
    }) : undefined);
    (authStorage.getApiKey as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      refreshed = true;
      return "refreshed-token";
    });

    const res = await GET(app, "/api/auth/status");

    expect(res.status).toBe(200);
    const anthropic = res.body.providers.find((p: any) => p.id === "anthropic-subscription");
    expect(authStorage.getApiKey).toHaveBeenCalledWith("anthropic-subscription");
    expect(anthropic).toMatchObject({ authenticated: true, expired: false });
  });

  it("reports legacy Anthropic OAuth expiry under the subscription status id without using CLI state", async () => {
    const now = Date.now();
    (authStorage.getOAuthProviders as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: "anthropic", name: "Anthropic" },
    ]);
    (authStorage.hasAuth as ReturnType<typeof vi.fn>).mockImplementation((provider: string) => provider === "anthropic-subscription");
    (authStorage.get as ReturnType<typeof vi.fn>).mockImplementation((provider: string) => {
      if (provider === "anthropic") {
        return {
          type: "oauth",
          access: "expired-legacy-token",
          refresh: "refresh",
          expires: now - 1_000,
        };
      }
      return undefined;
    });
    (authStorage.getApiKey as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("refresh failed"));

    const res = await GET(app, "/api/auth/status");

    expect(res.status).toBe(200);
    const anthropic = res.body.providers.find((p: any) => p.id === "anthropic-subscription");
    const claudeCli = res.body.providers.find((p: any) => p.id === "claude-cli");
    expect(authStorage.getApiKey).toHaveBeenCalledWith("anthropic-subscription");
    expect(anthropic).toMatchObject({ authenticated: false, expired: true });
    expect(claudeCli).toMatchObject({ type: "cli" });
  });

  it("keeps expired oauth status when async refresh fails", async () => {
    const now = Date.now();
    (authStorage.getOAuthProviders as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: "anthropic", name: "Anthropic" },
    ]);
    (authStorage.hasAuth as ReturnType<typeof vi.fn>).mockImplementation((provider: string) => provider === "anthropic-subscription");
    (authStorage.get as ReturnType<typeof vi.fn>).mockImplementation((provider: string) => provider === "anthropic-subscription" ? ({
      type: "oauth",
      access: "expired-token",
      refresh: "refresh",
      expires: now - 1_000,
    }) : undefined);
    (authStorage.getApiKey as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("refresh failed"));

    const res = await GET(app, "/api/auth/status");

    expect(res.status).toBe(200);
    const anthropic = res.body.providers.find((p: any) => p.id === "anthropic-subscription");
    expect(authStorage.getApiKey).toHaveBeenCalledWith("anthropic-subscription");
    expect(anthropic).toMatchObject({ authenticated: false, expired: true });
  });

  /*
  FNXC:ClaudeOAuth 2026-07-05-19:10:
  A present, unexpired Anthropic subscription OAuth token whose scopes lack an inference
  capability (e.g. profile-only grant, or one a buggy refresh narrowed to user:profile)
  authenticates identity but 403s every model call. /auth/status must report it as
  not-connected (authenticated:false, expired:true so the re-login banner fires) with a
  scope-specific loginError — not as a healthy session. The complementary test below
  guards against a false negative: a token that DOES carry user:inference stays connected.
  */
  it("reports an unexpired Anthropic subscription OAuth token that lacks the inference scope as not-connected", async () => {
    const now = Date.now();
    (authStorage.getOAuthProviders as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: "anthropic", name: "Anthropic" },
    ]);
    (authStorage.hasAuth as ReturnType<typeof vi.fn>).mockImplementation((provider: string) => provider === "anthropic-subscription");
    (authStorage.get as ReturnType<typeof vi.fn>).mockImplementation((provider: string) => provider === "anthropic-subscription" ? ({
      type: "oauth",
      access: "profile-only-token",
      refresh: "refresh",
      expires: now + 3_600_000,
      scopes: ["user:profile"],
    }) : undefined);

    const res = await GET(app, "/api/auth/status");

    expect(res.status).toBe(200);
    const anthropic = res.body.providers.find((p: any) => p.id === "anthropic-subscription");
    expect(anthropic).toMatchObject({ authenticated: false, expired: true });
    expect(anthropic.loginError).toMatch(/inference/i);
  });

  it("keeps an unexpired Anthropic subscription OAuth token that carries user:inference connected", async () => {
    const now = Date.now();
    (authStorage.getOAuthProviders as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: "anthropic", name: "Anthropic" },
    ]);
    (authStorage.hasAuth as ReturnType<typeof vi.fn>).mockImplementation((provider: string) => provider === "anthropic-subscription");
    (authStorage.get as ReturnType<typeof vi.fn>).mockImplementation((provider: string) => provider === "anthropic-subscription" ? ({
      type: "oauth",
      access: "inference-capable-token",
      refresh: "refresh",
      expires: now + 3_600_000,
      scopes: ["user:profile", "user:inference"],
    }) : undefined);

    const res = await GET(app, "/api/auth/status");

    expect(res.status).toBe(200);
    const anthropic = res.body.providers.find((p: any) => p.id === "anthropic-subscription");
    expect(anthropic).toMatchObject({ authenticated: true, expired: false });
    expect(anthropic.loginError).toBeUndefined();
  });

  it("does not penalize an unexpired Anthropic subscription OAuth token that records no scopes", async () => {
    const now = Date.now();
    (authStorage.getOAuthProviders as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: "anthropic", name: "Anthropic" },
    ]);
    (authStorage.hasAuth as ReturnType<typeof vi.fn>).mockImplementation((provider: string) => provider === "anthropic-subscription");
    (authStorage.get as ReturnType<typeof vi.fn>).mockImplementation((provider: string) => provider === "anthropic-subscription" ? ({
      type: "oauth",
      access: "fresh-login-token",
      refresh: "refresh",
      expires: now + 3_600_000,
      // Fresh pi-ai login persists no `scopes` field — must be treated as usable.
    }) : undefined);

    const res = await GET(app, "/api/auth/status");

    expect(res.status).toBe(200);
    const anthropic = res.body.providers.find((p: any) => p.id === "anthropic-subscription");
    expect(anthropic).toMatchObject({ authenticated: true, expired: false });
  });

  /*
  FNXC:ProviderAuth 2026-07-05-00:00:
  FN-7574 symptom verification: an expired, unrefreshable Anthropic Subscription OAuth
  credential must report authenticated:false/expired:true across BOTH the legacy
  pre-split `anthropic`-row storage permutation and the separated `anthropic-subscription`-
  row permutation, so the settings card and OAuthReloniBanner never show a lapsed
  subscription as connected. Covers the exact reproduction from the task's Symptom
  Verification section.
  */
  it("FN-7574: reports expired-and-unrefreshable subscription OAuth as not-connected (separated anthropic-subscription row)", async () => {
    const now = Date.now();
    (authStorage.getOAuthProviders as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: "anthropic", name: "Anthropic" },
    ]);
    (authStorage.hasAuth as ReturnType<typeof vi.fn>).mockImplementation((provider: string) => provider === "anthropic-subscription");
    (authStorage.get as ReturnType<typeof vi.fn>).mockImplementation((provider: string) => provider === "anthropic-subscription" ? ({
      type: "oauth",
      access: "expired-token",
      refresh: "revoked-refresh-token",
      expires: now - 60_000,
    }) : undefined);
    // Simulate a revoked refresh token: the best-effort refresh attempt inside the
    // status route fails (non-200 from the OAuth token endpoint), so getApiKey resolves
    // to undefined without throwing.
    (authStorage.getApiKey as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    const res = await GET(app, "/api/auth/status");

    expect(res.status).toBe(200);
    const anthropic = res.body.providers.find((p: any) => p.id === "anthropic-subscription");
    expect(authStorage.getApiKey).toHaveBeenCalledWith("anthropic-subscription");
    expect(anthropic).toMatchObject({ authenticated: false, expired: true });
  });

  it("FN-7574: reports expired-and-unrefreshable subscription OAuth as not-connected (legacy anthropic row)", async () => {
    const now = Date.now();
    (authStorage.getOAuthProviders as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: "anthropic", name: "Anthropic" },
    ]);
    (authStorage.hasAuth as ReturnType<typeof vi.fn>).mockImplementation((provider: string) => provider === "anthropic-subscription");
    (authStorage.get as ReturnType<typeof vi.fn>).mockImplementation((provider: string) => provider === "anthropic" ? ({
      type: "oauth",
      access: "expired-legacy-token",
      refresh: "revoked-refresh-token",
      expires: now - 60_000,
    }) : undefined);
    (authStorage.getApiKey as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    const res = await GET(app, "/api/auth/status");

    expect(res.status).toBe(200);
    const anthropic = res.body.providers.find((p: any) => p.id === "anthropic-subscription");
    expect(authStorage.getApiKey).toHaveBeenCalledWith("anthropic-subscription");
    expect(anthropic).toMatchObject({ authenticated: false, expired: true });
  });

  it("FN-7574: treats an oauth credential missing a numeric expires as expired, not authenticated", async () => {
    (authStorage.getOAuthProviders as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: "anthropic", name: "Anthropic" },
    ]);
    (authStorage.hasAuth as ReturnType<typeof vi.fn>).mockImplementation((provider: string) => provider === "anthropic-subscription");
    (authStorage.get as ReturnType<typeof vi.fn>).mockImplementation((provider: string) => provider === "anthropic-subscription" ? ({
      type: "oauth",
      access: "token-without-expiry",
      refresh: "refresh",
      // expires intentionally omitted — a partially-hydrated/corrupted credential.
    }) : undefined);
    (authStorage.getApiKey as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    const res = await GET(app, "/api/auth/status");

    expect(res.status).toBe(200);
    const anthropic = res.body.providers.find((p: any) => p.id === "anthropic-subscription");
    expect(anthropic).toMatchObject({ authenticated: false, expired: true });
  });

  it("reports loginInProgress for oauth providers with active logins", async () => {
    let releaseLogin: (() => void) | undefined;
    (authStorage.login as ReturnType<typeof vi.fn>).mockImplementation(
      (_provider: string, callbacks: { onAuth: (info: { url: string }) => void }) => {
        callbacks.onAuth({ url: "https://auth.example.com/login" });
        return new Promise<void>((resolve) => {
          releaseLogin = resolve;
        });
      },
    );

    const loginRequest = REQUEST(app, "POST", "/api/auth/login", JSON.stringify({ provider: "github-copilot" }), {
      "Content-Type": "application/json",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const statusRes = await GET(app, "/api/auth/status");
    const githubCopilot = statusRes.body.providers.find((p: any) => p.id === "github-copilot");
    expect(githubCopilot.loginInProgress).toBe(true);

    releaseLogin?.();
    await loginRequest;
  });

  it("returns authenticated true for API-key provider when hasApiKey is true", async () => {
    (authStorage.hasAuth as ReturnType<typeof vi.fn>).mockReturnValue(false);
    (authStorage.hasApiKey as ReturnType<typeof vi.fn>).mockReturnValue(true);

    const res = await GET(app, "/api/auth/status");

    expect(res.status).toBe(200);
    const openrouter = res.body.providers.find((p: any) => p.id === "openrouter");
    expect(openrouter).toBeDefined();
    expect(openrouter.authenticated).toBe(true);
    expect(openrouter.type).toBe("api_key");
  });

  it("separates Anthropic subscription OAuth from Anthropic API-key status when ids collide", async () => {
    (authStorage.getOAuthProviders as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: "anthropic", name: "Anthropic" },
    ]);
    (authStorage.getApiKeyProviders as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: "anthropic-api-key", name: "Anthropic API Key" },
    ]);
    (authStorage.hasAuth as ReturnType<typeof vi.fn>).mockReturnValue(false);
    (authStorage.hasApiKey as ReturnType<typeof vi.fn>).mockImplementation((provider: string) => provider === "anthropic-api-key");
    (authStorage.get as ReturnType<typeof vi.fn>).mockImplementation((provider: string) => (
      provider === "anthropic-api-key" ? { type: "api_key", key: "sk-ant-api03-abcdef1234" } : undefined
    ));

    const res = await GET(app, "/api/auth/status");

    expect(res.status).toBe(200);
    const subscription = res.body.providers.find((p: any) => p.id === "anthropic-subscription");
    const apiKey = res.body.providers.find((p: any) => p.id === "anthropic-api-key");
    expect(subscription).toMatchObject({
      id: "anthropic-subscription",
      name: "Anthropic Subscription",
      authenticated: false,
      type: "oauth",
      requiresManualCode: true,
    });
    expect(subscription).not.toHaveProperty("supportsApiKey");
    expect(apiKey).toMatchObject({
      id: "anthropic-api-key",
      name: "Anthropic API Key",
      authenticated: true,
      type: "api_key",
      keyHint: "sk-•••••1234",
    });
  });

  it("preserves Anthropic OAuth authentication while surfacing a separate stored API key", async () => {
    (authStorage.getOAuthProviders as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: "anthropic", name: "Anthropic" },
    ]);
    (authStorage.getApiKeyProviders as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: "anthropic-api-key", name: "Anthropic API Key" },
    ]);
    (authStorage.hasAuth as ReturnType<typeof vi.fn>).mockImplementation((provider: string) => provider === "anthropic-subscription");
    (authStorage.hasApiKey as ReturnType<typeof vi.fn>).mockImplementation((provider: string) => provider === "anthropic-api-key");
    (authStorage.get as ReturnType<typeof vi.fn>).mockImplementation((provider: string) => (
      provider === "anthropic-api-key" ? { type: "api_key", key: "sk-ant-api03-oauthandkey" } : undefined
    ));

    const res = await GET(app, "/api/auth/status");

    expect(res.status).toBe(200);
    const subscription = res.body.providers.find((p: any) => p.id === "anthropic-subscription");
    const apiKey = res.body.providers.find((p: any) => p.id === "anthropic-api-key");
    expect(subscription).toMatchObject({
      authenticated: true,
      type: "oauth",
    });
    expect(subscription).not.toHaveProperty("keyHint");
    expect(subscription).not.toHaveProperty("supportsApiKey");
    expect(apiKey).toMatchObject({
      authenticated: true,
      type: "api_key",
      keyHint: "sk-•••••dkey",
    });
  });

  it("reports research API-key providers with type api_key", async () => {
    (authStorage.getApiKeyProviders as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: "tavily", name: "Tavily" },
    ]);

    const res = await GET(app, "/api/auth/status");

    expect(res.status).toBe(200);
    expect(res.body.providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "tavily", type: "api_key" }),
      ]),
    );
  });

  it("returns 500 on error", async () => {
    (authStorage.getOAuthProviders as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("storage error");
    });

    const res = await GET(app, "/api/auth/status");

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("storage error");
  });
});

describe("POST /auth/claude-cli", () => {
  let store: TaskStore;

  beforeEach(() => {
    store = createMockStore({
      updateGlobalSettings: vi.fn().mockResolvedValue({ useClaudeCli: true }),
      getGlobalSettingsStore: vi.fn().mockReturnValue({
        ...createMockGlobalSettingsStore(),
        getSettings: vi.fn().mockResolvedValue({ useClaudeCli: false }),
      }),
    });
  });

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store));
    return app;
  }

  it("enables Claude CLI when binary is available", async () => {
    const probeSpy = vi.spyOn(claudeCliProbeModule, "probeClaudeCli").mockResolvedValue({
      available: true,
      version: "claude 1.0.0",
      probeDurationMs: 20,
    });

    const res = await REQUEST(buildApp(), "POST", "/api/auth/claude-cli", JSON.stringify({ enabled: true }), {
      "Content-Type": "application/json",
    });

    probeSpy.mockRestore();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enabled: true, restartRequired: false });
    expect(store.updateGlobalSettings).toHaveBeenCalledWith({ useClaudeCli: true });
  });

  it("returns 400 when enabling Claude CLI without an available binary", async () => {
    const probeSpy = vi.spyOn(claudeCliProbeModule, "probeClaudeCli").mockResolvedValue({
      available: false,
      reason: "`claude` not found on PATH",
      probeDurationMs: 20,
    });

    const res = await REQUEST(buildApp(), "POST", "/api/auth/claude-cli", JSON.stringify({ enabled: true }), {
      "Content-Type": "application/json",
    });

    probeSpy.mockRestore();

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Cannot enable Claude CLI routing");
  });
});

describe("GET /providers/claude-cli/status", () => {
  let store: TaskStore;

  beforeEach(() => {
    store = createMockStore({
      getGlobalSettingsStore: vi.fn().mockReturnValue({
        ...createMockGlobalSettingsStore(),
        getSettings: vi.fn().mockResolvedValue({ useClaudeCli: true }),
      }),
    });
  });

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use(
      "/api",
      createApiRoutes(store, {
        getClaudeCliExtensionStatus: () => ({ status: "ok", path: "/tmp/ext" }),
      } as Parameters<typeof createApiRoutes>[1]),
    );
    return app;
  }

  it("returns binary + toggle diagnostics and computed readiness", async () => {
    const probeSpy = vi.spyOn(claudeCliProbeModule, "probeClaudeCli").mockResolvedValue({
      available: true,
      version: "claude 1.0.0",
      probeDurationMs: 10,
    });

    const res = await GET(buildApp(), "/api/providers/claude-cli/status");

    probeSpy.mockRestore();

    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
    expect(res.body.ready).toBe(true);
    expect(res.body.binary).toMatchObject({ available: true, version: "claude 1.0.0" });
    expect(res.body.extension).toMatchObject({ status: "ok" });
  });

  it("surfaces ACP transport state + the bridge auth-failure signal", async () => {
    const probeSpy = vi.spyOn(claudeCliProbeModule, "probeClaudeCli").mockResolvedValue({
      available: true, version: "claude 1.0.0", probeDurationMs: 10,
    });
    const signalPath = join(tmpdir(), "fusion-acp-bridge-auth.json");
    const prevBridge = process.env.FUSION_CLAUDE_ACP_BRIDGE;
    const prevFlag = process.env.FUSION_CLAUDE_ACP;
    process.env.FUSION_CLAUDE_ACP_BRIDGE = "/abs/node_modules/.bin/claude-code-cli-acp";
    process.env.FUSION_CLAUDE_ACP = "1";
    writeFileSync(signalPath, JSON.stringify({ authFailed: true, reason: "Not logged in" }));
    try {
      const res = await GET(buildApp(), "/api/providers/claude-cli/status");
      expect(res.status).toBe(200);
      expect(res.body.acp).toMatchObject({ enabled: true, bridgeAvailable: true, active: true, authFailed: true });
      expect(res.body.acp.authReason).toContain("Not logged in");
    } finally {
      probeSpy.mockRestore();
      rmSync(signalPath, { force: true });
      if (prevBridge === undefined) delete process.env.FUSION_CLAUDE_ACP_BRIDGE;
      else process.env.FUSION_CLAUDE_ACP_BRIDGE = prevBridge;
      if (prevFlag === undefined) delete process.env.FUSION_CLAUDE_ACP;
      else process.env.FUSION_CLAUDE_ACP = prevFlag;
    }
  });

  it("reports acp inactive + no auth failure when the bridge isn't published", async () => {
    const probeSpy = vi.spyOn(claudeCliProbeModule, "probeClaudeCli").mockResolvedValue({
      available: true, version: "claude 1.0.0", probeDurationMs: 10,
    });
    const prevBridge = process.env.FUSION_CLAUDE_ACP_BRIDGE;
    delete process.env.FUSION_CLAUDE_ACP_BRIDGE;
    rmSync(join(tmpdir(), "fusion-acp-bridge-auth.json"), { force: true });
    try {
      const res = await GET(buildApp(), "/api/providers/claude-cli/status");
      expect(res.body.acp.bridgeAvailable).toBe(false);
      expect(res.body.acp.active).toBe(false);
      expect(res.body.acp.authFailed).toBe(false);
    } finally {
      probeSpy.mockRestore();
      if (prevBridge === undefined) delete process.env.FUSION_CLAUDE_ACP_BRIDGE;
      else process.env.FUSION_CLAUDE_ACP_BRIDGE = prevBridge;
    }
  });
});

describe("Droid CLI auth routes", () => {
  let store: TaskStore;

  function setDroidPluginSettings(settings: Record<string, unknown>) {
    (store as TaskStore & {
      getPluginStore: () => { getPlugin: (id: string) => Promise<{ settings: Record<string, unknown> }> };
    }).getPluginStore = vi.fn().mockReturnValue({
      getPlugin: vi.fn().mockImplementation(async (id: string) => {
        if (id !== "fusion-plugin-droid-runtime") {
          throw new Error("not found");
        }
        return { settings };
      }),
    });
  }

  beforeEach(() => {
    store = createMockStore({
      updateGlobalSettings: vi.fn().mockResolvedValue({ useDroidCli: true }),
      getGlobalSettingsStore: vi.fn().mockReturnValue({
        ...createMockGlobalSettingsStore(),
        getSettings: vi.fn().mockResolvedValue({ useDroidCli: false }),
      }),
    });

    /*
    FNXC:DashboardTests 2026-06-30-17:15 (FN-5048 — no slow tests):
    GET /auth/status probes claude/cursor/llama CLIs UNCONDITIONALLY (register-auth-routes.ts:
    probeClaudeCli/probeCursorCliProvider/probeLlamaCpp run regardless of the enabled toggle).
    The two /auth/status tests in this describe previously mocked only probeDroidCli, so the
    other three ran real subprocess probes and each blocked on a real CLI-absent timeout — ~6s
    per test (12s of the suite's wall time). Stub every CLI probe here so no real subprocess or
    wall-clock wait remains; the droid-specific tests still override probeDroidCli as needed.
    */
    vi.spyOn(claudeCliProbeModule, "probeClaudeCli").mockResolvedValue({
      available: false,
      reason: "mocked unavailable",
      probeDurationMs: 0,
    });
    vi.spyOn(runtimeProviderProbesModule, "probeCursorCliProvider").mockResolvedValue({
      available: false,
      reason: "mocked unavailable",
      probeDurationMs: 0,
    });
    vi.spyOn(llamaCppProbeModule, "probeLlamaCpp").mockResolvedValue({
      available: false,
      reason: "mocked unavailable",
      probeDurationMs: 0,
    });
  });

  function buildApp(options?: Parameters<typeof createApiRoutes>[1]) {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store, { authStorage: createMockAuthStorage(), ...options }));
    return app;
  }

  it("enables Droid CLI when binary is available", async () => {
    setDroidPluginSettings({ droidBinaryPath: "/opt/custom-droid" });
    const probeSpy = vi.spyOn(droidCliProbeModule, "probeDroidCli").mockResolvedValue({
      available: true,
      version: "droid 1.0.0",
      probeDurationMs: 20,
    });

    const res = await REQUEST(buildApp(), "POST", "/api/auth/droid-cli", JSON.stringify({ enabled: true }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enabled: true, restartRequired: false });
    expect(store.updateGlobalSettings).toHaveBeenCalledWith({ useDroidCli: true });
    expect(probeSpy).toHaveBeenCalledWith({ settings: { droidBinaryPath: "/opt/custom-droid" } });
    probeSpy.mockRestore();
  });

  it("returns 400 when enabling without available binary", async () => {
    const probeSpy = vi.spyOn(droidCliProbeModule, "probeDroidCli").mockResolvedValue({
      available: false,
      reason: "`droid` not found on PATH",
      probeDurationMs: 20,
    });

    const res = await REQUEST(buildApp(), "POST", "/api/auth/droid-cli", JSON.stringify({ enabled: true }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Cannot enable Droid CLI routing");
    probeSpy.mockRestore();
  });

  it("disabling works without probing binary", async () => {
    const probeSpy = vi.spyOn(droidCliProbeModule, "probeDroidCli");

    const res = await REQUEST(buildApp(), "POST", "/api/auth/droid-cli", JSON.stringify({ enabled: false }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(probeSpy).not.toHaveBeenCalled();
    probeSpy.mockRestore();
  });

  it("returns 400 for non-boolean enabled", async () => {
    const res = await REQUEST(buildApp(), "POST", "/api/auth/droid-cli", JSON.stringify({ enabled: "yes" }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(400);
  });

  it("fires onUseDroidCliToggled hook on transition", async () => {
    const onUseDroidCliToggled = vi.fn();
    vi.spyOn(droidCliProbeModule, "probeDroidCli").mockResolvedValue({
      available: true,
      version: "droid 1.0.0",
      probeDurationMs: 20,
    });

    const res = await REQUEST(
      buildApp({ onUseDroidCliToggled } as Parameters<typeof createApiRoutes>[1]),
      "POST",
      "/api/auth/droid-cli",
      JSON.stringify({ enabled: true }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(200);
    expect(onUseDroidCliToggled).toHaveBeenCalledWith(false, true);
  });

  it("returns binary + toggle + extension diagnostics and computed readiness", async () => {
    setDroidPluginSettings({ droidBinaryPath: "/opt/custom-droid" });
    const probeSpy = vi.spyOn(droidCliProbeModule, "probeDroidCli").mockResolvedValue({
      available: true,
      version: "droid 1.0.0",
      probeDurationMs: 10,
    });
    store.getGlobalSettingsStore = vi.fn().mockReturnValue({
      ...createMockGlobalSettingsStore(),
      getSettings: vi.fn().mockResolvedValue({ useDroidCli: true }),
    });

    const res = await GET(
      buildApp({ getDroidCliExtensionStatus: () => ({ status: "ok", path: "/tmp/ext" }) } as Parameters<
        typeof createApiRoutes
      >[1]),
      "/api/providers/droid-cli/status",
    );

    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
    expect(res.body.ready).toBe(true);
    expect(res.body.binary).toMatchObject({ available: true, version: "droid 1.0.0" });
    expect(res.body.extension).toMatchObject({ status: "ok" });
    expect(probeSpy).toHaveBeenCalledWith({ settings: { droidBinaryPath: "/opt/custom-droid" } });
  });

  it("returns ready false when binary unavailable", async () => {
    vi.spyOn(droidCliProbeModule, "probeDroidCli").mockResolvedValue({
      available: false,
      reason: "missing",
      probeDurationMs: 10,
    });
    store.getGlobalSettingsStore = vi.fn().mockReturnValue({
      ...createMockGlobalSettingsStore(),
      getSettings: vi.fn().mockResolvedValue({ useDroidCli: true }),
    });

    const res = await GET(buildApp(), "/api/providers/droid-cli/status");
    expect(res.status).toBe(200);
    expect(res.body.ready).toBe(false);
  });

  it("returns ready false when toggle is off", async () => {
    vi.spyOn(droidCliProbeModule, "probeDroidCli").mockResolvedValue({
      available: true,
      version: "droid 1.0.0",
      probeDurationMs: 10,
    });

    const res = await GET(buildApp(), "/api/providers/droid-cli/status");
    expect(res.status).toBe(200);
    expect(res.body.ready).toBe(false);
  });

  it("GET /auth/status includes droid-cli provider with cli type", async () => {
    setDroidPluginSettings({ droidBinaryPath: "/opt/custom-droid" });
    const probeSpy = vi.spyOn(droidCliProbeModule, "probeDroidCli").mockResolvedValue({
      available: true,
      version: "droid 1.0.0",
      probeDurationMs: 10,
    });
    store.getGlobalSettingsStore = vi.fn().mockReturnValue({
      ...createMockGlobalSettingsStore(),
      getSettings: vi.fn().mockResolvedValue({ useDroidCli: true }),
    });

    const res = await GET(buildApp(), "/api/auth/status");
    expect(res.status).toBe(200);
    expect(res.body.providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "droid-cli",
          name: "Factory AI — via Droid CLI",
          type: "cli",
          authenticated: true,
        }),
      ]),
    );
    expect(probeSpy).toHaveBeenCalledWith({ settings: { droidBinaryPath: "/opt/custom-droid" } });
  });

  it("GET /auth/status marks droid-cli unauthenticated when extension status is not ok", async () => {
    vi.spyOn(droidCliProbeModule, "probeDroidCli").mockResolvedValue({
      available: true,
      version: "droid 1.0.0",
      probeDurationMs: 10,
    });
    store.getGlobalSettingsStore = vi.fn().mockReturnValue({
      ...createMockGlobalSettingsStore(),
      getSettings: vi.fn().mockResolvedValue({ useDroidCli: true }),
    });

    const res = await GET(
      buildApp({ getDroidCliExtensionStatus: () => ({ status: "error", reason: "bad ext" }) } as Parameters<
        typeof createApiRoutes
      >[1]),
      "/api/auth/status",
    );

    expect(res.status).toBe(200);
    expect(res.body.providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "droid-cli",
          authenticated: false,
          type: "cli",
        }),
      ]),
    );
  });

  it("POST /auth/cursor-cli enables when cursor binary is available", async () => {
    vi.spyOn(runtimeProviderProbesModule, "probeCursorCliProvider").mockResolvedValue({
      available: true,
      version: "cursor-agent 1.0.0",
      probeDurationMs: 8,
    });
    store.updateGlobalSettings = vi.fn().mockResolvedValue({ useCursorCli: true });

    const res = await REQUEST(buildApp(), "POST", "/api/auth/cursor-cli", JSON.stringify({ enabled: true }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enabled: true, restartRequired: false });
    expect(store.updateGlobalSettings).toHaveBeenCalledWith({ useCursorCli: true });
  });

  it("POST /auth/cursor-cli saves a validated binary path without toggling", async () => {
    vi.spyOn(runtimeProviderProbesModule, "probeCursorCliProvider").mockResolvedValue({
      available: true,
      version: "cursor-agent 1.0.0",
      binaryPath: "/opt/Cursor/cursor-agent",
      configuredBinaryPath: "/opt/Cursor/cursor-agent",
      usingConfiguredBinaryPath: true,
      probeDurationMs: 8,
    });
    store.getGlobalSettingsStore = vi.fn().mockReturnValue({
      ...createMockGlobalSettingsStore(),
      getSettings: vi.fn().mockResolvedValue({ useCursorCli: false }),
    });
    store.updateGlobalSettings = vi.fn().mockResolvedValue({ useCursorCli: false, cursorCliBinaryPath: "/opt/Cursor/cursor-agent" });

    const res = await REQUEST(buildApp(), "POST", "/api/auth/cursor-cli", JSON.stringify({ binaryPath: "  /opt/Cursor/cursor-agent  " }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enabled: false, binaryPath: "/opt/Cursor/cursor-agent", restartRequired: false });
    expect(runtimeProviderProbesModule.probeCursorCliProvider).toHaveBeenCalledWith({ binaryPath: "/opt/Cursor/cursor-agent" });
    expect(store.updateGlobalSettings).toHaveBeenCalledWith({ cursorCliBinaryPath: "/opt/Cursor/cursor-agent" });
  });

  it("POST /auth/cursor-cli rejects invalid binaryPath values", async () => {
    const res = await REQUEST(buildApp(), "POST", "/api/auth/cursor-cli", JSON.stringify({ enabled: false, binaryPath: 123 }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("binaryPath must be a string or null");
  });

  it("POST /auth/cursor-cli rejects configured paths that only succeed via PATH fallback", async () => {
    vi.spyOn(runtimeProviderProbesModule, "probeCursorCliProvider").mockResolvedValue({
      available: true,
      version: "cursor-agent 1.0.0",
      binaryPath: "cursor-agent",
      configuredBinaryPath: "/missing/cursor-agent",
      usingConfiguredBinaryPath: false,
      reason: "Configured Cursor CLI binary '/missing/cursor-agent' failed; PATH fallback succeeded",
      probeDurationMs: 8,
    });

    const res = await REQUEST(buildApp(), "POST", "/api/auth/cursor-cli", JSON.stringify({ binaryPath: "/missing/cursor-agent" }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Cannot save Cursor CLI binary path");
    expect(store.updateGlobalSettings).not.toHaveBeenCalled();
  });

  it("POST /auth/cursor-cli clears the binary path and restores PATH auto-detection", async () => {
    vi.spyOn(runtimeProviderProbesModule, "probeCursorCliProvider").mockResolvedValue({
      available: true,
      version: "cursor-agent 1.0.0",
      binaryPath: "cursor-agent",
      probeDurationMs: 8,
    });
    store.getGlobalSettingsStore = vi.fn().mockReturnValue({
      ...createMockGlobalSettingsStore(),
      getSettings: vi.fn().mockResolvedValue({ useCursorCli: true, cursorCliBinaryPath: "/opt/Cursor/cursor-agent" }),
    });
    store.updateGlobalSettings = vi.fn().mockResolvedValue({ useCursorCli: true });

    const res = await REQUEST(buildApp(), "POST", "/api/auth/cursor-cli", JSON.stringify({ binaryPath: "   " }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enabled: true, restartRequired: false });
    expect(runtimeProviderProbesModule.probeCursorCliProvider).toHaveBeenCalledWith({ binaryPath: undefined });
    expect(store.updateGlobalSettings).toHaveBeenCalledWith({ cursorCliBinaryPath: null });
  });

  it("POST /auth/cursor-cli enables using the stored binary override", async () => {
    vi.spyOn(runtimeProviderProbesModule, "probeCursorCliProvider").mockResolvedValue({
      available: true,
      version: "cursor-agent 1.0.0",
      binaryPath: "/opt/Cursor/cursor-agent",
      configuredBinaryPath: "/opt/Cursor/cursor-agent",
      usingConfiguredBinaryPath: true,
      probeDurationMs: 8,
    });
    store.getGlobalSettingsStore = vi.fn().mockReturnValue({
      ...createMockGlobalSettingsStore(),
      getSettings: vi.fn().mockResolvedValue({ cursorCliBinaryPath: "/opt/Cursor/cursor-agent" }),
    });
    store.updateGlobalSettings = vi.fn().mockResolvedValue({ useCursorCli: true, cursorCliBinaryPath: "/opt/Cursor/cursor-agent" });

    const res = await REQUEST(buildApp(), "POST", "/api/auth/cursor-cli", JSON.stringify({ enabled: true }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(runtimeProviderProbesModule.probeCursorCliProvider).toHaveBeenCalledWith({ binaryPath: "/opt/Cursor/cursor-agent" });
    expect(store.updateGlobalSettings).toHaveBeenCalledWith({ useCursorCli: true });
  });

  it("POST /auth/cursor-cli returns 400 when enabling without binary", async () => {
    vi.spyOn(runtimeProviderProbesModule, "probeCursorCliProvider").mockResolvedValue({
      available: false,
      reason: "cursor-agent not found",
      probeDurationMs: 8,
    });

    const res = await REQUEST(buildApp(), "POST", "/api/auth/cursor-cli", JSON.stringify({ enabled: true }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Cannot enable Cursor CLI routing");
  });

  it("POST /auth/cursor-cli disables without probing binary", async () => {
    const probeSpy = vi.spyOn(runtimeProviderProbesModule, "probeCursorCliProvider");
    probeSpy.mockClear();
    store.updateGlobalSettings = vi.fn().mockResolvedValue({ useCursorCli: false });

    const res = await REQUEST(buildApp(), "POST", "/api/auth/cursor-cli", JSON.stringify({ enabled: false }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enabled: false, restartRequired: false });
    expect(probeSpy).not.toHaveBeenCalled();
  });

  it("GET /providers/cursor-cli/status returns readiness from toggle and binary", async () => {
    vi.spyOn(runtimeProviderProbesModule, "probeCursorCliProvider").mockResolvedValue({
      available: true,
      version: "cursor-agent 1.0.0",
      probeDurationMs: 8,
    });
    store.getGlobalSettingsStore = vi.fn().mockReturnValue({
      ...createMockGlobalSettingsStore(),
      getSettings: vi.fn().mockResolvedValue({ useCursorCli: true, cursorCliBinaryPath: "/opt/Cursor/cursor-agent" }),
    });

    const res = await GET(buildApp(), "/api/providers/cursor-cli/status");
    expect(res.status).toBe(200);
    expect(runtimeProviderProbesModule.probeCursorCliProvider).toHaveBeenCalledWith({ binaryPath: "/opt/Cursor/cursor-agent" });
    expect(res.body.ready).toBe(true);
    expect(res.body.enabled).toBe(true);
    expect(res.body.binaryPath).toBe("/opt/Cursor/cursor-agent");
    expect(res.body.binary.available).toBe(true);
  });

  it("GET /auth/status probes Cursor CLI with the stored override", async () => {
    vi.spyOn(runtimeProviderProbesModule, "probeCursorCliProvider").mockResolvedValue({
      available: true,
      version: "cursor-agent 1.0.0",
      binaryPath: "C:\\Users\\A User\\AppData\\Roaming\\npm\\cursor-agent.cmd",
      configuredBinaryPath: "C:\\Users\\A User\\AppData\\Roaming\\npm\\cursor-agent.cmd",
      usingConfiguredBinaryPath: true,
      probeDurationMs: 8,
    });
    store.getGlobalSettingsStore = vi.fn().mockReturnValue({
      ...createMockGlobalSettingsStore(),
      getSettings: vi.fn().mockResolvedValue({ useCursorCli: true, cursorCliBinaryPath: "C:\\Users\\A User\\AppData\\Roaming\\npm\\cursor-agent.cmd" }),
    });

    const res = await GET(buildApp(), "/api/auth/status");

    expect(res.status).toBe(200);
    expect(runtimeProviderProbesModule.probeCursorCliProvider).toHaveBeenCalledWith({ binaryPath: "C:\\Users\\A User\\AppData\\Roaming\\npm\\cursor-agent.cmd" });
    expect(res.body.providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "cursor-cli", authenticated: true }),
      ]),
    );
  });

  it("GET /providers/cursor-cli/status returns ready false when binary unavailable", async () => {
    vi.spyOn(runtimeProviderProbesModule, "probeCursorCliProvider").mockResolvedValue({
      available: false,
      reason: "missing",
      probeDurationMs: 8,
    });
    store.getGlobalSettingsStore = vi.fn().mockReturnValue({
      ...createMockGlobalSettingsStore(),
      getSettings: vi.fn().mockResolvedValue({ useCursorCli: true }),
    });

    const res = await GET(buildApp(), "/api/providers/cursor-cli/status");
    expect(res.status).toBe(200);
    expect(res.body.ready).toBe(false);
  });

  it("PUT /settings/global with useDroidCli fires onUseDroidCliToggled", async () => {
    const onUseDroidCliToggled = vi.fn();
    store.updateGlobalSettings = vi.fn().mockResolvedValue({ useDroidCli: true });
    store.getGlobalSettingsStore = vi.fn().mockReturnValue({
      ...createMockGlobalSettingsStore(),
      getSettings: vi.fn().mockResolvedValue({ useDroidCli: false, useClaudeCli: false }),
    });

    const res = await REQUEST(
      buildApp({ onUseDroidCliToggled } as Parameters<typeof createApiRoutes>[1]),
      "PUT",
      "/api/settings/global",
      JSON.stringify({ useDroidCli: true }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(200);
    expect(onUseDroidCliToggled).toHaveBeenCalledWith(false, true);
  });
});

describe("POST /auth/login", () => {
  let store: TaskStore;
  let authStorage: AuthStorageLike;

  beforeEach(() => {
    store = createMockStore();
    authStorage = createMockAuthStorage();
  });

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store, { authStorage }));
    return app;
  }

  it("returns auth URL for valid provider", async () => {
    const res = await REQUEST(buildApp(), "POST", "/api/auth/login", JSON.stringify({ provider: "github-copilot" }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(res.body.url).toBe("https://auth.example.com/login");
    expect(res.body.instructions).toBe("Open in browser");
  });

  it("returns parsed deviceCode for github-copilot", async () => {
    (authStorage.login as ReturnType<typeof vi.fn>).mockImplementation((_provider: string, callbacks: any) => {
      callbacks.onAuth({
        url: "https://github.com/login/device",
        instructions: "Enter code: ABCD-1234",
      });
      return Promise.resolve();
    });

    const res = await REQUEST(buildApp(), "POST", "/api/auth/login", JSON.stringify({ provider: "github-copilot" }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(res.body.deviceCode).toEqual({
      userCode: "ABCD-1234",
      verificationUri: "https://github.com/login/device",
    });
  });

  it("handles github-copilot device-code callback without crashing", async () => {
    (authStorage.login as ReturnType<typeof vi.fn>).mockImplementation((_provider: string, callbacks: any) => {
      callbacks.onDeviceCode({
        userCode: "WXYZ-9876",
        verificationUri: "https://github.com/login/device",
      });
      return Promise.resolve();
    });

    const res = await REQUEST(buildApp(), "POST", "/api/auth/login", JSON.stringify({ provider: "github-copilot" }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(res.body.deviceCode).toEqual({
      userCode: "WXYZ-9876",
      verificationUri: "https://github.com/login/device",
    });
    expect(res.body.url).toBe("https://github.com/login/device");
  });

  it("auto-resolves first onPrompt invocation for github-copilot with blank input", async () => {
    let promptValue: string | undefined;
    (authStorage.login as ReturnType<typeof vi.fn>).mockImplementation(async (_provider: string, callbacks: any) => {
      promptValue = await callbacks.onPrompt({
        message: "GitHub Enterprise URL/domain (blank for github.com)",
        placeholder: "company.ghe.com",
        allowEmpty: true,
      });
      callbacks.onAuth({ url: "https://github.com/login/device", instructions: "Enter code: ABCD-1234" });
    });

    const res = await REQUEST(buildApp(), "POST", "/api/auth/login", JSON.stringify({ provider: "github-copilot" }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(promptValue).toBe("");
  });

  it("returns github-copilot verification_uri verbatim on non-localhost origins", async () => {
    (authStorage.login as ReturnType<typeof vi.fn>).mockImplementation((_provider: string, callbacks: any) => {
      callbacks.onAuth({
        url: "https://github.com/login/device",
        instructions: "Enter code: ABCD-1234",
      });
      return Promise.resolve();
    });

    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/auth/login",
      JSON.stringify({ provider: "github-copilot", origin: "https://my-host.example.com" }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(200);
    expect(res.body.url).toBe("https://github.com/login/device");
    expect(res.body.deviceCode).toEqual({
      userCode: "ABCD-1234",
      verificationUri: "https://github.com/login/device",
    });
  });

  it.each(["http://localhost:4040", "http://127.0.0.1:4040"])(
    "does not rewrite redirect_uri when origin is local (%s)",
    async (origin) => {
      const unchangedUrl =
        "https://accounts.example.com/o/oauth2/v2/auth?state=test-state&redirect_uri=http%3A%2F%2Flocalhost%3A8085%2Foauth2callback";

      (authStorage.login as ReturnType<typeof vi.fn>).mockImplementation((_provider: string, callbacks: any) => {
        callbacks.onAuth({ url: unchangedUrl });
        return Promise.resolve();
      });

      const res = await REQUEST(
        buildApp(),
        "POST",
        "/api/auth/login",
        JSON.stringify({ provider: "github-copilot", origin }),
        { "Content-Type": "application/json" },
      );

      expect(res.status).toBe(200);
      expect(res.body.url).toBe(unchangedUrl);
    },
  );

  it("does not rewrite redirect_uri when origin is missing", async () => {
    const unchangedUrl =
      "https://accounts.example.com/o/oauth2/v2/auth?state=test-state&redirect_uri=http%3A%2F%2Flocalhost%3A8085%2Foauth2callback";

    (authStorage.login as ReturnType<typeof vi.fn>).mockImplementation((_provider: string, callbacks: any) => {
      callbacks.onAuth({ url: unchangedUrl });
      return Promise.resolve();
    });

    const res = await REQUEST(buildApp(), "POST", "/api/auth/login", JSON.stringify({ provider: "github-copilot" }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(res.body.url).toBe(unchangedUrl);
  });

  it("does not rewrite redirect_uri for github-copilot even on non-localhost origins", async () => {
    const unchangedUrl =
      "https://accounts.example.com/o/oauth2/v2/auth?state=test-state&redirect_uri=http%3A%2F%2Flocalhost%3A8085%2Foauth2callback";

    (authStorage.login as ReturnType<typeof vi.fn>).mockImplementation((_provider: string, callbacks: any) => {
      callbacks.onAuth({ url: unchangedUrl });
      return Promise.resolve();
    });

    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/auth/login",
      JSON.stringify({ provider: "github-copilot", origin: "https://my-host.example.com" }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(200);
    expect(res.body.url).toBe(unchangedUrl);
  });

  it("does not rewrite redirect_uri for openai-codex even on non-localhost origins", async () => {
    const unchangedUrl =
      "https://auth.openai.com/oauth/authorize?state=test-state&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback";

    (authStorage.getOAuthProviders as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: "openai-codex", name: "OpenAI Codex" },
    ]);
    (authStorage.login as ReturnType<typeof vi.fn>).mockImplementation((_provider: string, callbacks: any) => {
      callbacks.onAuth({ url: unchangedUrl });
      return Promise.resolve();
    });

    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/auth/login",
      JSON.stringify({ provider: "openai-codex", origin: "https://my-host.example.com" }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(200);
    expect(res.body.url).toBe(unchangedUrl);
    expect(res.body.manualCode).toEqual({
      prompt: "Paste the final redirect URL or authorization code",
      placeholder: "http://localhost:1455/auth/callback?code=...&state=... or just the code",
      helpText: "After sign-in, OpenAI may redirect to a localhost callback that cannot open from this dashboard host. Copy the full browser URL from the address bar and paste it here.",
    });
  });

  it("maps Anthropic subscription login to upstream anthropic OAuth and skips callback rewrite", async () => {
    const unchangedUrl =
      "https://claude.ai/oauth/authorize?state=anthropic-state&redirect_uri=http%3A%2F%2Flocalhost%3A3210%2Fauth%2Fcallback";

    (authStorage.getOAuthProviders as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: "anthropic", name: "Anthropic" },
    ]);
    (authStorage.login as ReturnType<typeof vi.fn>).mockImplementation((_provider: string, callbacks: any) => {
      callbacks.onAuth({ url: unchangedUrl, instructions: "Sign in with Claude" });
      return Promise.resolve();
    });

    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/auth/login",
      JSON.stringify({ provider: "anthropic-subscription", origin: "https://my-host.example.com" }),
      { "Content-Type": "application/json" },
    );

    expect(authStorage.login).toHaveBeenCalledWith("anthropic", expect.any(Object));
    expect(res.status).toBe(200);
    expect(res.body.url).toBe(unchangedUrl);
    expect(res.body.instructions).toContain("After Claude sign-in");
    expect(res.body.manualCode).toEqual({
      prompt: "Paste the final redirect URL or authorization code",
      placeholder: "http://localhost:*/callback?code=...&state=... or just the code",
      helpText: "After Claude sign-in, copy the full browser URL (or just the code) and paste it here to finish login from this dashboard host.",
    });
  });

  it("does not auto-resolve prompt for anthropic", async () => {
    (authStorage.getOAuthProviders as ReturnType<typeof vi.fn>).mockReturnValue([{ id: "anthropic", name: "Anthropic" }]);

    let observedPromptInput: string | undefined;
    (authStorage.login as ReturnType<typeof vi.fn>).mockImplementation(async (_provider: string, callbacks: any) => {
      callbacks.onAuth({ url: "https://claude.ai/oauth/authorize?state=s&redirect_uri=http%3A%2F%2Flocalhost%3A3210%2Fcb" });
      observedPromptInput = await callbacks.onPrompt({ message: "Paste callback" });
    });

    const app = buildApp();
    const loginReq = REQUEST(app, "POST", "/api/auth/login", JSON.stringify({ provider: "anthropic", origin: "https://remote.example.com" }), {
      "Content-Type": "application/json",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const submitRes = await REQUEST(app, "POST", "/api/auth/manual-code", JSON.stringify({ provider: "anthropic", code: "manual-code" }), {
      "Content-Type": "application/json",
    });
    expect(submitRes.status).toBe(200);

    await loginReq;
    expect(observedPromptInput).toBe("manual-code");
  });

  it.each([
    ["http query", "http://localhost:53692/callback?code=http-code&state=expected-state", "code=http-code&state=expected-state"],
    ["fragment", "http://localhost:53692/callback#code=fragment-code&state=expected-state", "code=fragment-code&state=expected-state"],
    ["schemeless", "localhost:53692/callback?code=schemeless-code&state=expected-state", "code=schemeless-code&state=expected-state"],
  ])("normalizes Anthropic subscription pasted callback URLs with %s parameters", async (_case, callbackUrl, expectedInput) => {
    (authStorage.getOAuthProviders as ReturnType<typeof vi.fn>).mockReturnValue([{ id: "anthropic", name: "Anthropic" }]);

    let observedManualInput: string | undefined;
    (authStorage.login as ReturnType<typeof vi.fn>).mockImplementation(async (_provider: string, callbacks: any) => {
      callbacks.onAuth({ url: "https://claude.ai/oauth/authorize?state=expected-state&redirect_uri=http%3A%2F%2Flocalhost%3A53692%2Fcallback" });
      observedManualInput = await callbacks.onManualCodeInput();
    });

    const app = buildApp();
    const loginReq = REQUEST(app, "POST", "/api/auth/login", JSON.stringify({ provider: "anthropic-subscription", origin: "https://remote.example.com" }), {
      "Content-Type": "application/json",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const submitRes = await REQUEST(app, "POST", "/api/auth/manual-code", JSON.stringify({ provider: "anthropic-subscription", code: callbackUrl }), {
      "Content-Type": "application/json",
    });
    expect(submitRes.status).toBe(200);

    await loginReq;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(observedManualInput).toBe(expectedInput);
  });

  it("prefers browser login for openai-codex multi-option prompts", async () => {
    let selectedOption: string | undefined;
    (authStorage.getOAuthProviders as ReturnType<typeof vi.fn>).mockReturnValue([{ id: "openai-codex", name: "OpenAI Codex" }]);
    (authStorage.login as ReturnType<typeof vi.fn>).mockImplementation(async (_provider: string, callbacks: any) => {
      selectedOption = await callbacks.onSelect({
        message: "Select OpenAI Codex login method:",
        options: [
          { id: "browser", label: "Browser login (default)" },
          { id: "device_code", label: "Device code login (headless)" },
        ],
      });
      if (!selectedOption) {
        throw new Error("Login cancelled");
      }
      callbacks.onAuth({
        url: "https://auth.openai.com/oauth/authorize?state=test-state&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback",
      });
    });

    const res = await REQUEST(buildApp(), "POST", "/api/auth/login", JSON.stringify({ provider: "openai-codex" }), {
      "Content-Type": "application/json",
    });

    expect(selectedOption).toBe("browser");
    expect(res.status).toBe(200);
    expect(res.body.url).toBe(
      "https://auth.openai.com/oauth/authorize?state=test-state&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback",
    );
  });

  it("keeps returning the only option id for single-option prompts", async () => {
    let selectedOption: string | undefined;
    (authStorage.getOAuthProviders as ReturnType<typeof vi.fn>).mockReturnValue([{ id: "openai-codex", name: "OpenAI Codex" }]);
    (authStorage.login as ReturnType<typeof vi.fn>).mockImplementation(async (_provider: string, callbacks: any) => {
      selectedOption = await callbacks.onSelect({
        message: "Only one choice",
        options: [{ id: "browser", label: "Browser login" }],
      });
      callbacks.onAuth({ url: "https://auth.example.com/login" });
    });

    const res = await REQUEST(buildApp(), "POST", "/api/auth/login", JSON.stringify({ provider: "openai-codex" }), {
      "Content-Type": "application/json",
    });

    expect(selectedOption).toBe("browser");
    expect(res.status).toBe(200);
  });

  it("prefers the default-labelled option for generic multi-option prompts", async () => {
    let selectedOption: string | undefined;
    (authStorage.getOAuthProviders as ReturnType<typeof vi.fn>).mockReturnValue([{ id: "anthropic", name: "Anthropic" }]);
    (authStorage.login as ReturnType<typeof vi.fn>).mockImplementation(async (_provider: string, callbacks: any) => {
      selectedOption = await callbacks.onSelect({
        message: "Select login method:",
        options: [
          { id: "device_code", label: "Device code login" },
          { id: "browser", label: "Browser login (DEFAULT)" },
          { id: "manual", label: "Manual login" },
        ],
      });
      callbacks.onAuth({ url: "https://claude.ai/oauth/authorize?state=test-state&redirect_uri=http%3A%2F%2Flocalhost%3A3210%2Fauth%2Fcallback" });
    });

    const res = await REQUEST(buildApp(), "POST", "/api/auth/login", JSON.stringify({ provider: "anthropic" }), {
      "Content-Type": "application/json",
    });

    expect(selectedOption).toBe("browser");
    expect(res.status).toBe(200);
  });

  it("returns 400 when provider is missing", async () => {
    const res = await REQUEST(buildApp(), "POST", "/api/auth/login", JSON.stringify({}), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("provider is required");
  });

  it("returns 400 for unknown provider", async () => {
    const res = await REQUEST(buildApp(), "POST", "/api/auth/login", JSON.stringify({ provider: "unknown" }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Unknown provider");
  });

  it("returns 409 when login is already in progress for the same provider", async () => {
    let releaseLogin: (() => void) | undefined;
    (authStorage.login as ReturnType<typeof vi.fn>).mockImplementation(
      (_provider: string, callbacks: { onAuth: (info: { url: string }) => void }) => {
        callbacks.onAuth({ url: "https://auth.example.com/login" });
        return new Promise<void>((resolve) => {
          releaseLogin = resolve;
        });
      },
    );

    const app = buildApp();

    const firstRequest = REQUEST(app, "POST", "/api/auth/login", JSON.stringify({ provider: "github-copilot" }), {
      "Content-Type": "application/json",
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    const secondResponse = await REQUEST(app, "POST", "/api/auth/login", JSON.stringify({ provider: "github-copilot" }), {
      "Content-Type": "application/json",
    });

    expect(secondResponse.status).toBe(409);
    expect(secondResponse.body.error).toBe("Login already in progress for github-copilot");

    releaseLogin?.();
    await firstRequest;
  });

  it("returns 500 when login fails", async () => {
    (authStorage.login as ReturnType<typeof vi.fn>).mockImplementation((_provider: string, callbacks: any) => {
      return Promise.reject(new Error("OAuth failed"));
    });

    const res = await REQUEST(buildApp(), "POST", "/api/auth/login", JSON.stringify({ provider: "github-copilot" }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("OAuth failed");
  });
});

describe("parseGitHubCopilotDeviceCode", () => {
  it("parses a well-formed github copilot instruction string", () => {
    expect(parseGitHubCopilotDeviceCode("Enter code: ABCD-1234")).toBe("ABCD-1234");
  });

  it("returns undefined for malformed instruction strings", () => {
    expect(parseGitHubCopilotDeviceCode("Open browser and continue")).toBeUndefined();
  });
});

describe("POST /auth/cancel", () => {
  let store: TaskStore;
  let authStorage: AuthStorageLike;

  beforeEach(() => {
    store = createMockStore();
    authStorage = createMockAuthStorage();
  });

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store, { authStorage }));
    return app;
  }

  it("cancels active login and allows immediate retry", async () => {
    let releaseLogin: (() => void) | undefined;
    (authStorage.login as ReturnType<typeof vi.fn>).mockImplementation(
      (_provider: string, callbacks: { onAuth: (info: { url: string }) => void; signal: AbortSignal }) => {
        callbacks.onAuth({ url: "https://auth.example.com/login" });
        return new Promise<void>((resolve, reject) => {
          releaseLogin = resolve;
          callbacks.signal.addEventListener("abort", () => {
            reject(new Error("cancelled"));
          });
        });
      },
    );

    const app = buildApp();
    const firstLogin = REQUEST(app, "POST", "/api/auth/login", JSON.stringify({ provider: "github-copilot" }), {
      "Content-Type": "application/json",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const cancelRes = await REQUEST(app, "POST", "/api/auth/cancel", JSON.stringify({ provider: "github-copilot" }), {
      "Content-Type": "application/json",
    });
    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body).toEqual({ success: true, cancelled: true });

    const retryRes = await REQUEST(app, "POST", "/api/auth/login", JSON.stringify({ provider: "github-copilot" }), {
      "Content-Type": "application/json",
    });
    expect(retryRes.status).toBe(200);

    releaseLogin?.();
    await firstLogin;
  });

  it("returns success when there is no active login", async () => {
    const res = await REQUEST(buildApp(), "POST", "/api/auth/cancel", JSON.stringify({ provider: "github-copilot" }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, cancelled: false });
  });

  it("returns 400 when provider is missing", async () => {
    const res = await REQUEST(buildApp(), "POST", "/api/auth/cancel", JSON.stringify({}), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("provider is required");
  });
});

describe("POST /auth/manual-code", () => {
  let store: TaskStore;
  let authStorage: AuthStorageLike;

  beforeEach(() => {
    store = createMockStore();
    authStorage = createMockAuthStorage({
      getOAuthProviders: vi.fn().mockReturnValue([
        { id: "openai-codex", name: "OpenAI Codex" },
        { id: "anthropic", name: "Anthropic" },
      ]),
    });
  });

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store, { authStorage }));
    return app;
  }

  it("submits pasted manual code into an active login", async () => {
    let submittedCode: string | undefined;
    let releaseLogin: (() => void) | undefined;
    (authStorage.login as ReturnType<typeof vi.fn>).mockImplementation(
      async (_provider: string, callbacks: {
        onAuth: (info: { url: string; instructions?: string }) => void;
        onManualCodeInput?: () => Promise<string>;
      }) => {
        callbacks.onAuth({
          url: "https://auth.openai.com/oauth/authorize?state=test-state&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback",
        });
        submittedCode = await callbacks.onManualCodeInput?.();
        releaseLogin?.();
      },
    );

    const app = buildApp();
    const loginRes = await REQUEST(
      app,
      "POST",
      "/api/auth/login",
      JSON.stringify({ provider: "openai-codex", origin: "https://remote.example.com" }),
      { "Content-Type": "application/json" },
    );

    expect(loginRes.status).toBe(200);

    const submitRes = await REQUEST(
      app,
      "POST",
      "/api/auth/manual-code",
      JSON.stringify({
        provider: "openai-codex",
        code: "http://localhost:1455/auth/callback?code=test-code&state=test-state",
      }),
      { "Content-Type": "application/json" },
    );

    expect(submitRes.status).toBe(200);
    expect(submitRes.body).toEqual({ success: true, submitted: true });
    await vi.waitFor(() => {
      expect(submittedCode).toBe("http://localhost:1455/auth/callback?code=test-code&state=test-state");
    });
  });

  it("delivers pasted Anthropic callback URLs to the local OAuth listener", async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => "ok" });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    let submittedCode: string | undefined;
    (authStorage.login as ReturnType<typeof vi.fn>).mockImplementation(
      async (_provider: string, callbacks: {
        onAuth: (info: { url: string; instructions?: string }) => void;
        onManualCodeInput?: () => Promise<string>;
      }) => {
        callbacks.onAuth({
          url: "https://claude.ai/oauth/authorize?state=anthropic-state&redirect_uri=http%3A%2F%2Flocalhost%3A53692%2Fcallback",
        });
        submittedCode = await callbacks.onManualCodeInput?.();
      },
    );

    try {
      const app = buildApp();
      const loginRes = await REQUEST(
        app,
        "POST",
        "/api/auth/login",
        JSON.stringify({ provider: "anthropic-subscription", origin: "https://remote.example.com" }),
        { "Content-Type": "application/json" },
      );

      expect(loginRes.status).toBe(200);

      const submitRes = await REQUEST(
        app,
        "POST",
        "/api/auth/manual-code",
        JSON.stringify({ provider: "anthropic-subscription", code: "http://localhost:53692/callback?code=anthropic-code&state=anthropic-state" }),
        { "Content-Type": "application/json" },
      );

      expect(submitRes.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(String(fetchMock.mock.calls[0]?.[0])).toBe("http://127.0.0.1:53692/callback?code=anthropic-code&state=anthropic-state");
      expect(fetchMock.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ method: "GET" }));
      await vi.waitFor(() => {
        expect(submittedCode).toBe("code=anthropic-code&state=anthropic-state");
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("submits pasted manual code for anthropic login", async () => {
    let submittedCode: string | undefined;
    (authStorage.login as ReturnType<typeof vi.fn>).mockImplementation(
      async (_provider: string, callbacks: {
        onAuth: (info: { url: string; instructions?: string }) => void;
        onPrompt?: () => Promise<string>;
      }) => {
        callbacks.onAuth({
          url: "https://claude.ai/oauth/authorize?state=anthropic-state&redirect_uri=http%3A%2F%2Flocalhost%3A3210%2Fauth%2Fcallback",
        });
        submittedCode = await callbacks.onPrompt?.();
      },
    );

    const app = buildApp();
    const loginRes = await REQUEST(
      app,
      "POST",
      "/api/auth/login",
      JSON.stringify({ provider: "anthropic", origin: "https://remote.example.com" }),
      { "Content-Type": "application/json" },
    );

    expect(loginRes.status).toBe(200);

    const submitRes = await REQUEST(
      app,
      "POST",
      "/api/auth/manual-code",
      JSON.stringify({ provider: "anthropic", code: "anthropic-manual-code" }),
      { "Content-Type": "application/json" },
    );

    expect(submitRes.status).toBe(200);
    expect(submitRes.body).toEqual({ success: true, submitted: true });
    await vi.waitFor(() => {
      expect(submittedCode).toBe("anthropic-manual-code");
    });
  });

  it("returns 409 when no login is in progress", async () => {
    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/auth/manual-code",
      JSON.stringify({ provider: "openai-codex", code: "test-code" }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("No login in progress for openai-codex");
  });
});

describe("GET /auth/oauth-callback", () => {
  let store: TaskStore;
  let authStorage: AuthStorageLike;

  beforeEach(() => {
    store = createMockStore();
    authStorage = createMockAuthStorage();
  });

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store, { authStorage }));
    return app;
  }

  it("proxies callback request to original localhost callback server", async () => {
    const callbackServer = express();
    callbackServer.get("/oauth2callback", (req, res) => {
      res.status(200).type("text/html").send(`proxied:${String(req.query.code)}:${String(req.query.state)}`);
    });

    const callbackListener = await new Promise<import("node:http").Server>((resolve) => {
      const listener = callbackServer.listen(0, () => resolve(listener));
    });

    try {
      const address = callbackListener.address();
      const port = typeof address === "object" && address ? address.port : 0;
      expect(port).toBeGreaterThan(0);

      (authStorage.getOAuthProviders as ReturnType<typeof vi.fn>).mockReturnValue([
        { id: "google", name: "Google" },
      ]);
      (authStorage.login as ReturnType<typeof vi.fn>).mockImplementation((_provider: string, callbacks: any) => {
        callbacks.onAuth({
          url: `https://accounts.example.com/o/oauth2/v2/auth?state=test-state&redirect_uri=${encodeURIComponent(`http://localhost:${port}/oauth2callback`)}`,
        });
        return Promise.resolve();
      });

      const app = buildApp();
      const loginRes = await REQUEST(
        app,
        "POST",
        "/api/auth/login",
        JSON.stringify({ provider: "google", origin: "https://remote.example.com" }),
        { "Content-Type": "application/json" },
      );
      expect(loginRes.status).toBe(200);

      const res = await REQUEST(app, "GET", "/api/auth/oauth-callback?code=test-code&state=test-state");
      expect(res.status).toBe(200);
      expect(String(res.body)).toContain("proxied:test-code:test-state");
    } finally {
      await new Promise<void>((resolve, reject) => callbackListener.close((err) => (err ? reject(err) : resolve())));
    }
  });

  it("returns 400 for unknown state", async () => {
    const res = await REQUEST(buildApp(), "GET", "/api/auth/oauth-callback?code=test-code&state=unknown");
    expect(res.status).toBe(400);
    expect(String(res.body)).toContain("OAuth session expired or not found");
  });

  it("returns 400 with error page when oauth provider reports error", async () => {
    const res = await REQUEST(buildApp(), "GET", "/api/auth/oauth-callback?error=access_denied&state=test-state");
    expect(res.status).toBe(400);
    expect(String(res.body)).toContain("OAuth failed");
    expect(String(res.body)).toContain("access_denied");
  });
});

describe("POST /auth/logout", () => {
  let store: TaskStore;
  let authStorage: AuthStorageLike;

  beforeEach(() => {
    store = createMockStore();
    authStorage = createMockAuthStorage();
  });

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store, { authStorage }));
    return app;
  }

  it("removes credentials for a provider", async () => {
    const res = await REQUEST(buildApp(), "POST", "/api/auth/logout", JSON.stringify({ provider: "github-copilot" }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(authStorage.logout).toHaveBeenCalledWith("github-copilot");
  });

  it("returns 400 when provider is missing", async () => {
    const res = await REQUEST(buildApp(), "POST", "/api/auth/logout", JSON.stringify({}), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("provider is required");
  });

  it("returns 500 on error", async () => {
    (authStorage.logout as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("logout failed");
    });

    const res = await REQUEST(buildApp(), "POST", "/api/auth/logout", JSON.stringify({ provider: "github-copilot" }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("logout failed");
  });
});

describe("POST /auth/api-key", () => {
  let store: TaskStore;
  let authStorage: AuthStorageLike;

  beforeEach(() => {
    store = createMockStore();
    authStorage = createMockAuthStorage();
  });

  function buildApp(options?: {
    onApiKeySaved?: (providerId: string) => Promise<{ registeredCount: number; reason?: string; error?: string } | void>;
    modelRegistry?: ModelRegistryLike;
  }) {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store, { authStorage, ...(options ?? {}) }));
    return app;
  }

  it("saves an API key for a valid provider", async () => {
    const res = await REQUEST(buildApp(), "POST", "/api/auth/api-key", JSON.stringify({
      provider: "openrouter",
      apiKey: "sk-or-v1-test-key",
    }), { "Content-Type": "application/json" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(authStorage.setApiKey).toHaveBeenCalledWith("openrouter", "sk-or-v1-test-key");
  });

  it("trims whitespace from API key", async () => {
    const res = await REQUEST(buildApp(), "POST", "/api/auth/api-key", JSON.stringify({
      provider: "openrouter",
      apiKey: "  sk-or-v1-test-key  ",
    }), { "Content-Type": "application/json" });

    expect(res.status).toBe(200);
    expect(authStorage.setApiKey).toHaveBeenCalledWith("openrouter", "sk-or-v1-test-key");
  });

  it("saves a trimmed key for research API-key providers", async () => {
    (authStorage.getApiKeyProviders as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: "tavily", name: "Tavily" },
    ]);

    const res = await REQUEST(buildApp(), "POST", "/api/auth/api-key", JSON.stringify({
      provider: "tavily",
      apiKey: "  tavily-secret  ",
    }), { "Content-Type": "application/json" });

    expect(res.status).toBe(200);
    expect(authStorage.setApiKey).toHaveBeenCalledWith("tavily", "tavily-secret");
  });

  it("saves an Anthropic API key when Anthropic is also an OAuth provider", async () => {
    (authStorage.getApiKeyProviders as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: "anthropic-api-key", name: "Anthropic API Key" },
    ]);

    const res = await REQUEST(buildApp(), "POST", "/api/auth/api-key", JSON.stringify({
      provider: "anthropic-api-key",
      apiKey: "  sk-ant-api03-test-key  ",
    }), { "Content-Type": "application/json" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(authStorage.setApiKey).toHaveBeenCalledWith("anthropic-api-key", "sk-ant-api03-test-key");
  });

  it("returns 400 and does not save when Anthropic subscription OAuth is submitted as an API-key provider", async () => {
    (authStorage.getApiKeyProviders as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: "anthropic-api-key", name: "Anthropic API Key" },
    ]);

    const res = await REQUEST(buildApp(), "POST", "/api/auth/api-key", JSON.stringify({
      provider: "anthropic-subscription",
      apiKey: "sk-ant-api03-wrong-card",
    }), { "Content-Type": "application/json" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Unknown API key provider");
    expect(authStorage.setApiKey).not.toHaveBeenCalled();
  });

  it("returns 400 when provider is missing", async () => {
    const res = await REQUEST(buildApp(), "POST", "/api/auth/api-key", JSON.stringify({
      apiKey: "sk-test",
    }), { "Content-Type": "application/json" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("provider is required");
  });

  it("returns 400 when apiKey is missing", async () => {
    const res = await REQUEST(buildApp(), "POST", "/api/auth/api-key", JSON.stringify({
      provider: "openrouter",
    }), { "Content-Type": "application/json" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("apiKey is required");
  });

  it("returns 400 when apiKey is empty", async () => {
    const res = await REQUEST(buildApp(), "POST", "/api/auth/api-key", JSON.stringify({
      provider: "openrouter",
      apiKey: "   ",
    }), { "Content-Type": "application/json" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("apiKey is required");
  });

  it("accepts API key providers discovered from model registry-backed auth storage", async () => {
    (authStorage.getApiKeyProviders as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: "acme-extension", name: "Acme Extension" },
    ]);

    const res = await REQUEST(buildApp(), "POST", "/api/auth/api-key", JSON.stringify({
      provider: "acme-extension",
      apiKey: "acme-secret-key",
    }), { "Content-Type": "application/json" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(authStorage.setApiKey).toHaveBeenCalledWith("acme-extension", "acme-secret-key");
  });

  it("returns 400 for unknown provider", async () => {
    const res = await REQUEST(buildApp(), "POST", "/api/auth/api-key", JSON.stringify({
      provider: "unknown-provider",
      apiKey: "sk-test",
    }), { "Content-Type": "application/json" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Unknown API key provider");
  });

  it("returns 400 when storage does not support API keys", async () => {
    const storageWithoutApiKeys = createMockAuthStorage({
      setApiKey: undefined,
      getApiKeyProviders: undefined,
    });

    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store, { authStorage: storageWithoutApiKeys }));

    const res = await REQUEST(app, "POST", "/api/auth/api-key", JSON.stringify({
      provider: "openrouter",
      apiKey: "sk-test",
    }), { "Content-Type": "application/json" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("not supported");
  });

  it("runs post-save refresh hook and model registry refresh for opencode-go", async () => {
    const onApiKeySaved = vi.fn().mockResolvedValue({ registeredCount: 3, reason: "no-models-from-cli" });
    const modelRegistry = { refresh: vi.fn(), getAvailable: vi.fn().mockReturnValue([]) } as unknown as ModelRegistryLike;
    (authStorage.getApiKeyProviders as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: "openrouter", name: "OpenRouter" },
      { id: "opencode-go", name: "Opencode (Go)" },
    ]);

    const res = await REQUEST(buildApp({ onApiKeySaved, modelRegistry }), "POST", "/api/auth/api-key", JSON.stringify({
      provider: "opencode-go",
      apiKey: "sk-test",
    }), { "Content-Type": "application/json" });

    expect(res.status).toBe(200);
    expect(onApiKeySaved).toHaveBeenCalledWith("opencode-go");
    expect(modelRegistry.refresh).toHaveBeenCalled();
    expect(res.body.modelsRefreshed).toBe(3);
    expect(res.body.refreshReason).toBe("no-models-from-cli");
  });

  it("returns success when post-save refresh hook throws", async () => {
    const onApiKeySaved = vi.fn().mockRejectedValue(new Error("opencode missing"));
    (authStorage.getApiKeyProviders as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: "openrouter", name: "OpenRouter" },
      { id: "opencode-go", name: "Opencode (Go)" },
    ]);

    const res = await REQUEST(buildApp({ onApiKeySaved }), "POST", "/api/auth/api-key", JSON.stringify({
      provider: "opencode-go",
      apiKey: "sk-test",
    }), { "Content-Type": "application/json" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.refreshError).toContain("opencode missing");
  });

  it("does not include refresh metadata when callback returns undefined", async () => {
    const onApiKeySaved = vi.fn().mockResolvedValue(undefined);

    const res = await REQUEST(buildApp({ onApiKeySaved }), "POST", "/api/auth/api-key", JSON.stringify({
      provider: "openrouter",
      apiKey: "sk-test",
    }), { "Content-Type": "application/json" });

    expect(res.status).toBe(200);
    expect(onApiKeySaved).toHaveBeenCalledWith("openrouter");
    expect(res.body.modelsRefreshed).toBeUndefined();
    expect(res.body.refreshReason).toBeUndefined();
  });

  it("returns 500 on storage error", async () => {
    (authStorage.setApiKey as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("disk full");
    });

    const res = await REQUEST(buildApp(), "POST", "/api/auth/api-key", JSON.stringify({
      provider: "openrouter",
      apiKey: "sk-test",
    }), { "Content-Type": "application/json" });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("disk full");
  });
});

describe("DELETE /auth/api-key", () => {
  let store: TaskStore;
  let authStorage: AuthStorageLike;

  beforeEach(() => {
    store = createMockStore();
    authStorage = createMockAuthStorage();
  });

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store, { authStorage }));
    return app;
  }

  it("clears an API key for a provider", async () => {
    const res = await REQUEST(buildApp(), "DELETE", "/api/auth/api-key", JSON.stringify({
      provider: "openrouter",
    }), { "Content-Type": "application/json" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(authStorage.clearApiKey).toHaveBeenCalledWith("openrouter");
  });

  it("returns 400 when provider is missing", async () => {
    const res = await REQUEST(buildApp(), "DELETE", "/api/auth/api-key", JSON.stringify({}), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("provider is required");
  });

  it("returns 400 and does not clear when provider is not API-key-backed", async () => {
    const res = await REQUEST(buildApp(), "DELETE", "/api/auth/api-key", JSON.stringify({
      provider: "anthropic-subscription",
    }), { "Content-Type": "application/json" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Unknown API key provider");
    expect(authStorage.clearApiKey).not.toHaveBeenCalled();
  });

  it("returns 400 when storage does not support API keys", async () => {
    const storageWithoutApiKeys = createMockAuthStorage({
      clearApiKey: undefined,
    });

    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store, { authStorage: storageWithoutApiKeys }));

    const res = await REQUEST(app, "DELETE", "/api/auth/api-key", JSON.stringify({
      provider: "openrouter",
    }), { "Content-Type": "application/json" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("not supported");
  });
});

describe("Pause/Unpause endpoints", () => {
  let store: TaskStore;
  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store));
    return app;
  }

  beforeEach(() => {
    store = createMockStore({
      getTask: vi.fn().mockResolvedValue({ id: "FN-001" }),
      pauseTask: vi.fn().mockResolvedValue({ id: "FN-001", paused: true }),
    });
  });

  it("POST /tasks/:id/pause — pauses a task", async () => {
    const res = await REQUEST(buildApp(), "POST", "/api/tasks/KB-001/pause");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: "FN-001", paused: true });
    expect(store.pauseTask).toHaveBeenCalledWith("KB-001", true);
  });

  it("POST /tasks/:id/unpause — unpauses a task", async () => {
    (store.pauseTask as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "FN-001" });
    const res = await REQUEST(buildApp(), "POST", "/api/tasks/KB-001/unpause");
    expect(res.status).toBe(200);
    expect(store.pauseTask).toHaveBeenCalledWith("KB-001", false);
  });

  it("POST /tasks/:id/pause — returns 500 on error", async () => {
    (store.getTask as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("not found"));
    const res = await REQUEST(buildApp(), "POST", "/api/tasks/KB-001/pause");
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("not found");
  });

  describe("task comment routes", () => {
    it("GET /tasks/:id/comments — returns task comments", async () => {
      const comments = [{ id: "c1", text: "Hello", author: "alice", createdAt: "2026-01-01T00:00:00.000Z" }];
      const store = createMockStore({
        getTask: vi.fn().mockResolvedValue({ ...FAKE_TASK_DETAIL, comments }),
      });

      const app = express();
      app.use(express.json());
      app.use("/api", createApiRoutes(store));

      const res = await GET(app, "/api/tasks/KB-001/comments");
      expect(res.status).toBe(200);
      expect(res.body).toEqual(comments);
    });

    it("POST /tasks/:id/comments — adds a task comment", async () => {
      const updatedTask = { ...FAKE_TASK_DETAIL, comments: [{ id: "c1", text: "Hello", author: "user", createdAt: "2026-01-01T00:00:00.000Z" }] };
      const store = createMockStore({ addTaskComment: vi.fn().mockResolvedValue(updatedTask) });
      const app = express();
      app.use(express.json());
      app.use("/api", createApiRoutes(store));

      const res = await REQUEST(app, "POST", "/api/tasks/KB-001/comments", JSON.stringify({ text: "Hello" }), {
        "Content-Type": "application/json",
      });
      expect(res.status).toBe(200);
      expect(store.addTaskComment).toHaveBeenCalledWith("KB-001", "Hello", "user");
    });

    it("POST /tasks/:id/comments — triggers immediate heartbeat wake for assigned agent", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "kb-routes-comment-heartbeat-"));
      const fusionDir = join(tempDir, ".fusion");
      mkdirSync(fusionDir, { recursive: true });

      try {
        const { AgentStore } = await import("@fusion/core");
        const agentStore = new AgentStore({ rootDir: fusionDir });
        await agentStore.init();
        const agent = await agentStore.createAgent({ name: "Wake Agent", role: "executor" });
        await agentStore.updateAgent(agent.id, {
          runtimeConfig: { messageResponseMode: "immediate" },
        });

        const heartbeatMonitor = {
          executeHeartbeat: vi.fn().mockResolvedValue({ id: "run-1" }),
        };

        const updatedTask = {
          ...FAKE_TASK_DETAIL,
          id: "KB-001",
          assignedAgentId: agent.id,
          comments: [{ id: "comment-1", text: "Hello", author: "user", createdAt: "2026-01-01T00:00:00.000Z" }],
        };

        const store = createMockStore({
          addTaskComment: vi.fn().mockResolvedValue(updatedTask),
          getFusionDir: vi.fn().mockReturnValue(fusionDir),
        });

        const app = express();
        app.use(express.json());
        app.use("/api", createApiRoutes(store, { heartbeatMonitor } as any));

        const res = await REQUEST(app, "POST", "/api/tasks/KB-001/comments", JSON.stringify({ text: "Hello" }), {
          "Content-Type": "application/json",
        });

        expect(res.status).toBe(200);
        await vi.waitFor(() => {
          expect(heartbeatMonitor.executeHeartbeat).toHaveBeenCalledWith(expect.objectContaining({
            agentId: agent.id,
            source: "on_demand",
            taskId: "KB-001",
            triggeringCommentIds: ["comment-1"],
            triggeringCommentType: "task",
          }));
        }, { timeout: 1000 });
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    }, 15_000);

    it("POST /tasks/:id/comments — skips heartbeat wake when task has no assigned agent", async () => {
      const heartbeatMonitor = {
        executeHeartbeat: vi.fn().mockResolvedValue({ id: "run-1" }),
      };
      const updatedTask = {
        ...FAKE_TASK_DETAIL,
        id: "KB-001",
        assignedAgentId: undefined,
        comments: [{ id: "comment-1", text: "Hello", author: "user", createdAt: "2026-01-01T00:00:00.000Z" }],
      };

      const store = createMockStore({
        addTaskComment: vi.fn().mockResolvedValue(updatedTask),
      });

      const app = express();
      app.use(express.json());
      app.use("/api", createApiRoutes(store, { heartbeatMonitor } as any));

      const res = await REQUEST(app, "POST", "/api/tasks/KB-001/comments", JSON.stringify({ text: "Hello" }), {
        "Content-Type": "application/json",
      });

      expect(res.status).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(heartbeatMonitor.executeHeartbeat).not.toHaveBeenCalled();
    });

    it("POST /tasks/:id/comments — succeeds without heartbeat monitor when task is assigned", async () => {
      const updatedTask = {
        ...FAKE_TASK_DETAIL,
        id: "KB-001",
        assignedAgentId: "agent-123",
        comments: [{ id: "comment-1", text: "Hello", author: "user", createdAt: "2026-01-01T00:00:00.000Z" }],
      };

      const store = createMockStore({
        addTaskComment: vi.fn().mockResolvedValue(updatedTask),
      });

      const app = express();
      app.use(express.json());
      app.use("/api", createApiRoutes(store));

      const res = await REQUEST(app, "POST", "/api/tasks/KB-001/comments", JSON.stringify({ text: "Hello" }), {
        "Content-Type": "application/json",
      });

      expect(res.status).toBe(200);
      expect(store.addTaskComment).toHaveBeenCalledWith("KB-001", "Hello", "user");
    });

    it("POST /tasks/:id/comments — skips heartbeat wake when an active run already exists", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "kb-routes-comment-active-run-"));
      const fusionDir = join(tempDir, ".fusion");
      mkdirSync(fusionDir, { recursive: true });

      try {
        const { AgentStore } = await import("@fusion/core");
        const agentStore = new AgentStore({ rootDir: fusionDir });
        await agentStore.init();
        const agent = await agentStore.createAgent({ name: "Active Run Agent", role: "executor" });
        await agentStore.updateAgent(agent.id, {
          runtimeConfig: { messageResponseMode: "immediate" },
        });
        await agentStore.startHeartbeatRun(agent.id);

        const heartbeatMonitor = {
          executeHeartbeat: vi.fn().mockResolvedValue({ id: "run-1" }),
        };

        const updatedTask = {
          ...FAKE_TASK_DETAIL,
          id: "KB-001",
          assignedAgentId: agent.id,
          comments: [{ id: "comment-1", text: "Hello", author: "user", createdAt: "2026-01-01T00:00:00.000Z" }],
        };

        const store = createMockStore({
          addTaskComment: vi.fn().mockResolvedValue(updatedTask),
          getFusionDir: vi.fn().mockReturnValue(fusionDir),
        });

        const app = express();
        app.use(express.json());
        app.use("/api", createApiRoutes(store, { heartbeatMonitor } as any));

        const res = await REQUEST(app, "POST", "/api/tasks/KB-001/comments", JSON.stringify({ text: "Hello" }), {
          "Content-Type": "application/json",
        });

        expect(res.status).toBe(200);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(heartbeatMonitor.executeHeartbeat).not.toHaveBeenCalled();
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("PATCH /tasks/:id/comments/:commentId — updates a task comment", async () => {
      const updatedTask = { ...FAKE_TASK_DETAIL, comments: [{ id: "c1", text: "Updated", author: "user", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:01:00.000Z" }] };
      const store = createMockStore({ updateTaskComment: vi.fn().mockResolvedValue(updatedTask) });
      const app = express();
      app.use(express.json());
      app.use("/api", createApiRoutes(store));

      const res = await REQUEST(app, "PATCH", "/api/tasks/KB-001/comments/c1", JSON.stringify({ text: "Updated" }), {
        "Content-Type": "application/json",
      });
      expect(res.status).toBe(200);
      expect(store.updateTaskComment).toHaveBeenCalledWith("KB-001", "c1", "Updated");
    });

    it("DELETE /tasks/:id/comments/:commentId — deletes a task comment", async () => {
      const updatedTask = { ...FAKE_TASK_DETAIL, comments: [] };
      const store = createMockStore({ deleteTaskComment: vi.fn().mockResolvedValue(updatedTask) });
      const app = express();
      app.use(express.json());
      app.use("/api", createApiRoutes(store));

      const res = await REQUEST(app, "DELETE", "/api/tasks/KB-001/comments/c1");
      expect(res.status).toBe(200);
      expect(store.deleteTaskComment).toHaveBeenCalledWith("KB-001", "c1");
    });
  });

  describe("POST /tasks/:id/steer", () => {
    it("adds a steering comment to a task", async () => {
      const mockComment = {
        id: "FN-001",
        steeringComments: [
          {
            id: "1234567890-abc123",
            text: "Please handle the edge case",
            createdAt: "2026-01-01T00:00:00.000Z",
            author: "user" as const,
          },
        ],
      };
      (store.addSteeringComment as ReturnType<typeof vi.fn>).mockResolvedValue(mockComment);

      const res = await REQUEST(
        buildApp(),
        "POST",
        "/api/tasks/KB-001/steer",
        JSON.stringify({ text: "Please handle the edge case" }),
        { "Content-Type": "application/json" }
      );

      expect(res.status).toBe(200);
      expect(res.body).toEqual(mockComment);
      expect(store.addSteeringComment).toHaveBeenCalledWith(
        "KB-001",
        "Please handle the edge case",
        "user"
      );
    });

    it("triggers immediate heartbeat wake for assigned agent", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "kb-routes-steer-heartbeat-"));
      const fusionDir = join(tempDir, ".fusion");
      mkdirSync(fusionDir, { recursive: true });

      try {
        const { AgentStore } = await import("@fusion/core");
        const agentStore = new AgentStore({ rootDir: fusionDir });
        await agentStore.init();
        const agent = await agentStore.createAgent({ name: "Steer Wake Agent", role: "executor" });
        await agentStore.updateAgent(agent.id, {
          runtimeConfig: { messageResponseMode: "immediate" },
        });

        const heartbeatMonitor = {
          executeHeartbeat: vi.fn().mockResolvedValue({ id: "run-1" }),
        };

        const steeredTask = {
          ...FAKE_TASK_DETAIL,
          id: "KB-001",
          assignedAgentId: agent.id,
          steeringComments: [{ id: "steer-1", text: "Please handle edge case", author: "user", createdAt: "2026-01-01T00:00:00.000Z" }],
        };
        (store.addSteeringComment as ReturnType<typeof vi.fn>).mockResolvedValue(steeredTask);
        (store.getFusionDir as any) = vi.fn().mockReturnValue(fusionDir);

        const app = express();
        app.use(express.json());
        app.use("/api", createApiRoutes(store, { heartbeatMonitor } as any));

        const res = await REQUEST(
          app,
          "POST",
          "/api/tasks/KB-001/steer",
          JSON.stringify({ text: "Please handle edge case" }),
          { "Content-Type": "application/json" },
        );

        expect(res.status).toBe(200);
        await vi.waitFor(() => {
          expect(heartbeatMonitor.executeHeartbeat).toHaveBeenCalledWith(expect.objectContaining({
            agentId: agent.id,
            source: "on_demand",
            taskId: "KB-001",
            triggeringCommentIds: ["steer-1"],
            triggeringCommentType: "steering",
          }));
        }, { timeout: 1000 });
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("skips heartbeat wake when assigned agent is not in immediate response mode", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "kb-routes-steer-non-immediate-"));
      const fusionDir = join(tempDir, ".fusion");
      mkdirSync(fusionDir, { recursive: true });

      try {
        const { AgentStore } = await import("@fusion/core");
        const agentStore = new AgentStore({ rootDir: fusionDir });
        await agentStore.init();
        const agent = await agentStore.createAgent({ name: "Non-immediate Agent", role: "executor" });
        await agentStore.updateAgent(agent.id, {
          runtimeConfig: { messageResponseMode: "on-heartbeat" },
        });

        const heartbeatMonitor = {
          executeHeartbeat: vi.fn().mockResolvedValue({ id: "run-1" }),
        };

        const steeredTask = {
          ...FAKE_TASK_DETAIL,
          id: "KB-001",
          assignedAgentId: agent.id,
          steeringComments: [{ id: "steer-1", text: "Please handle edge case", author: "user", createdAt: "2026-01-01T00:00:00.000Z" }],
        };
        (store.addSteeringComment as ReturnType<typeof vi.fn>).mockResolvedValue(steeredTask);
        (store.getFusionDir as any) = vi.fn().mockReturnValue(fusionDir);

        const app = express();
        app.use(express.json());
        app.use("/api", createApiRoutes(store, { heartbeatMonitor } as any));

        const res = await REQUEST(
          app,
          "POST",
          "/api/tasks/KB-001/steer",
          JSON.stringify({ text: "Please handle edge case" }),
          { "Content-Type": "application/json" },
        );

        expect(res.status).toBe(200);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(heartbeatMonitor.executeHeartbeat).not.toHaveBeenCalled();
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("returns 400 when text is missing", async () => {
      const res = await REQUEST(buildApp(), "POST", "/api/tasks/KB-001/steer", JSON.stringify({}), {
        "Content-Type": "application/json",
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("text is required");
    });

    it("returns 400 when text is empty", async () => {
      const res = await REQUEST(
        buildApp(),
        "POST",
        "/api/tasks/KB-001/steer",
        JSON.stringify({ text: "" }),
        { "Content-Type": "application/json" }
      );

      expect(res.status).toBe(400);
      // Empty string fails the "!text" check, not the length check
      expect(res.body.error).toContain("text is required");
    });

    it("returns 400 when text exceeds 2000 characters", async () => {
      const longText = "a".repeat(2001);
      const res = await REQUEST(
        buildApp(),
        "POST",
        "/api/tasks/KB-001/steer",
        JSON.stringify({ text: longText }),
        { "Content-Type": "application/json" }
      );

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("text must be between 1 and 2000 characters");
    });

    it("returns 404 when task not found", async () => {
      const error = new Error("Task not found") as Error & { code?: string };
      error.code = "ENOENT";
      (store.addSteeringComment as ReturnType<typeof vi.fn>).mockRejectedValue(error);

      const res = await REQUEST(
        buildApp(),
        "POST",
        "/api/tasks/KB-001/steer",
        JSON.stringify({ text: "Valid comment" }),
        { "Content-Type": "application/json" }
      );

      expect(res.status).toBe(404);
    });

    it("returns 500 on unexpected errors", async () => {
      (store.addSteeringComment as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("Database error")
      );

      const res = await REQUEST(
        buildApp(),
        "POST",
        "/api/tasks/KB-001/steer",
        JSON.stringify({ text: "Valid comment" }),
        { "Content-Type": "application/json" }
      );

      expect(res.status).toBe(500);
      expect(res.body.error).toBe("Database error");
    });
  });

  // --- Task Document route tests ---

  describe("task document routes", () => {
    function buildApp() {
      const app = express();
      app.use(express.json());
      app.use("/api", createApiRoutes(store));
      return app;
    }

    describe("GET /tasks/:id/documents", () => {
      it("returns empty array when the store hides documents for a soft-deleted parent", async () => {
        (store.getTaskDocuments as ReturnType<typeof vi.fn>).mockResolvedValue([]);
        const res = await GET(buildApp(), "/api/tasks/KB-001/documents");
        expect(res.status).toBe(200);
        expect(res.body).toEqual([]);
      });

      it("returns documents list", async () => {
        const docs = [
          { id: "d1", taskId: "KB-001", key: "plan", content: "My plan", revision: 1, author: "user", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
        ];
        (store.getTaskDocuments as ReturnType<typeof vi.fn>).mockResolvedValue(docs);
        const res = await GET(buildApp(), "/api/tasks/KB-001/documents");
        expect(res.status).toBe(200);
        expect(res.body).toEqual(docs);
      });
    });

    describe("GET /tasks/:id/documents/:key", () => {
      it("returns document when found", async () => {
        const doc = { id: "d1", taskId: "KB-001", key: "plan", content: "My plan", revision: 1, author: "user", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
        (store.getTaskDocument as ReturnType<typeof vi.fn>).mockResolvedValue(doc);
        const res = await GET(buildApp(), "/api/tasks/KB-001/documents/plan");
        expect(res.status).toBe(200);
        expect(res.body).toEqual(doc);
      });

      it("returns 404 when the store hides a document for a soft-deleted parent", async () => {
        (store.getTaskDocument as ReturnType<typeof vi.fn>).mockResolvedValue(null);
        const res = await GET(buildApp(), "/api/tasks/KB-001/documents/missing");
        expect(res.status).toBe(404);
        expect(res.body.error).toBe("Document not found");
      });
    });

    describe("GET /tasks/:id/documents/:key/revisions", () => {
      it("returns revisions list", async () => {
        const revisions = [
          { id: "r1", taskId: "KB-001", key: "plan", revision: 2, content: "Updated plan", author: "user", createdAt: "2026-01-02T00:00:00.000Z" },
          { id: "r2", taskId: "KB-001", key: "plan", revision: 1, content: "Original plan", author: "user", createdAt: "2026-01-01T00:00:00.000Z" },
        ];
        (store.getTaskDocumentRevisions as ReturnType<typeof vi.fn>).mockResolvedValue(revisions);
        const res = await GET(buildApp(), "/api/tasks/KB-001/documents/plan/revisions");
        expect(res.status).toBe(200);
        expect(res.body).toEqual(revisions);
      });

      it("returns empty array when the store hides revisions for a soft-deleted parent", async () => {
        (store.getTaskDocumentRevisions as ReturnType<typeof vi.fn>).mockResolvedValue([]);
        const res = await GET(buildApp(), "/api/tasks/KB-001/documents/missing/revisions");
        expect(res.status).toBe(200);
        expect(res.body).toEqual([]);
      });

      it("returns empty array for nonexistent document errors", async () => {
        (store.getTaskDocumentRevisions as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("not found"));
        const res = await GET(buildApp(), "/api/tasks/KB-001/documents/missing/revisions");
        // Per spec: "Return empty array if document doesn't exist (not an error)"
        expect(res.status).toBe(200);
        expect(res.body).toEqual([]);
      });
    });

    describe("PUT /tasks/:id/documents/:key", () => {
      it("creates new document with 201", async () => {
        const newDoc = { id: "d1", taskId: "KB-001", key: "plan", content: "My plan", revision: 1, author: "user", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
        (store.upsertTaskDocument as ReturnType<typeof vi.fn>).mockResolvedValue(newDoc);
        const res = await REQUEST(
          buildApp(),
          "PUT",
          "/api/tasks/KB-001/documents/plan",
          JSON.stringify({ content: "My plan" }),
          { "Content-Type": "application/json" }
        );
        expect(res.status).toBe(201);
        expect(store.upsertTaskDocument).toHaveBeenCalledWith("KB-001", { key: "plan", content: "My plan", author: "user", metadata: undefined });
      });

      it("updates existing document with 200", async () => {
        const updatedDoc = { id: "d1", taskId: "KB-001", key: "plan", content: "Updated plan", revision: 2, author: "user", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z" };
        (store.upsertTaskDocument as ReturnType<typeof vi.fn>).mockResolvedValue(updatedDoc);
        const res = await REQUEST(
          buildApp(),
          "PUT",
          "/api/tasks/KB-001/documents/plan",
          JSON.stringify({ content: "Updated plan" }),
          { "Content-Type": "application/json" }
        );
        expect(res.status).toBe(200);
      });

      it("returns 400 for missing content", async () => {
        const res = await REQUEST(
          buildApp(),
          "PUT",
          "/api/tasks/KB-001/documents/plan",
          JSON.stringify({}),
          { "Content-Type": "application/json" }
        );
        expect(res.status).toBe(400);
        expect(res.body.error).toBe("content is required");
      });

      it("returns 400 for invalid key format (spaces)", async () => {
        const res = await REQUEST(
          buildApp(),
          "PUT",
          "/api/tasks/KB-001/documents/my%20plan",
          JSON.stringify({ content: "My plan" }),
          { "Content-Type": "application/json" }
        );
        expect(res.status).toBe(400);
        expect(res.body.error).toContain("Invalid document key");
      });

      it("returns 400 for invalid key format (special chars)", async () => {
        const res = await REQUEST(
          buildApp(),
          "PUT",
          "/api/tasks/KB-001/documents/plan@test",
          JSON.stringify({ content: "My plan" }),
          { "Content-Type": "application/json" }
        );
        expect(res.status).toBe(400);
        expect(res.body.error).toContain("Invalid document key");
      });

      it("returns 400 for content exceeding 100000 chars", async () => {
        const longContent = "a".repeat(100001);
        const res = await REQUEST(
          buildApp(),
          "PUT",
          "/api/tasks/KB-001/documents/plan",
          JSON.stringify({ content: longContent }),
          { "Content-Type": "application/json" }
        );
        expect(res.status).toBe(400);
        expect(res.body.error).toContain("content must be between 1 and 100000 characters");
      });

      it("accepts optional author and metadata", async () => {
        const newDoc = { id: "d1", taskId: "KB-001", key: "notes", content: "My notes", revision: 1, author: "agent", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
        (store.upsertTaskDocument as ReturnType<typeof vi.fn>).mockResolvedValue(newDoc);
        const res = await REQUEST(
          buildApp(),
          "PUT",
          "/api/tasks/KB-001/documents/notes",
          JSON.stringify({ content: "My notes", author: "agent", metadata: { priority: "high" } }),
          { "Content-Type": "application/json" }
        );
        expect(res.status).toBe(201);
        expect(store.upsertTaskDocument).toHaveBeenCalledWith("KB-001", { key: "notes", content: "My notes", author: "agent", metadata: { priority: "high" } });
      });
    });

    describe("DELETE /tasks/:id/documents/:key", () => {
      it("returns 204 on success", async () => {
        (store.deleteTaskDocument as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
        const res = await REQUEST(buildApp(), "DELETE", "/api/tasks/KB-001/documents/plan");
        expect(res.status).toBe(204);
        expect(store.deleteTaskDocument).toHaveBeenCalledWith("KB-001", "plan");
      });

      it("returns 404 when document not found", async () => {
        (store.deleteTaskDocument as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Document not found"));
        const res = await REQUEST(buildApp(), "DELETE", "/api/tasks/KB-001/documents/missing");
        expect(res.status).toBe(404);
      });
    });

    describe("GET /documents", () => {
      it("returns empty array when no documents", async () => {
        (store.getAllDocuments as ReturnType<typeof vi.fn>).mockResolvedValue([]);
        const res = await GET(buildApp(), "/api/documents");
        expect(res.status).toBe(200);
        expect(res.body).toEqual([]);
      });

      it("returns only the live-parent documents surfaced by the store", async () => {
        const mockDocs = [
          {
            id: "doc-1",
            taskId: "KB-001",
            key: "plan",
            content: "Plan content",
            revision: 1,
            author: "user",
            createdAt: "2024-01-01T00:00:00.000Z",
            updatedAt: "2024-01-01T00:00:00.000Z",
            taskTitle: "Task One",
            taskColumn: "triage",
          },
        ];
        (store.getAllDocuments as ReturnType<typeof vi.fn>).mockResolvedValue(mockDocs);
        const res = await GET(buildApp(), "/api/documents");
        expect(res.status).toBe(200);
        expect(res.body).toEqual(mockDocs);
      });

      it("filters by search query", async () => {
        (store.getAllDocuments as ReturnType<typeof vi.fn>).mockResolvedValue([]);
        const res = await GET(buildApp(), "/api/documents?q=plan");
        expect(res.status).toBe(200);
        expect(store.getAllDocuments).toHaveBeenCalledWith({ searchQuery: "plan", limit: 200, offset: 0 });
      });

      it("respects limit parameter", async () => {
        (store.getAllDocuments as ReturnType<typeof vi.fn>).mockResolvedValue([]);
        const res = await GET(buildApp(), "/api/documents?limit=50");
        expect(res.status).toBe(200);
        expect(store.getAllDocuments).toHaveBeenCalledWith({ limit: 50, offset: 0 });
      });

      it("caps limit at 1000", async () => {
        (store.getAllDocuments as ReturnType<typeof vi.fn>).mockResolvedValue([]);
        const res = await GET(buildApp(), "/api/documents?limit=9999");
        expect(res.status).toBe(200);
        expect(store.getAllDocuments).toHaveBeenCalledWith({ limit: 1000, offset: 0 });
      });

      it("respects offset parameter", async () => {
        (store.getAllDocuments as ReturnType<typeof vi.fn>).mockResolvedValue([]);
        const res = await GET(buildApp(), "/api/documents?offset=10");
        expect(res.status).toBe(200);
        expect(store.getAllDocuments).toHaveBeenCalledWith({ limit: 200, offset: 10, searchQuery: undefined });
      });

      it("combines multiple parameters", async () => {
        (store.getAllDocuments as ReturnType<typeof vi.fn>).mockResolvedValue([]);
        const res = await GET(buildApp(), "/api/documents?q=search&limit=25&offset=5");
        expect(res.status).toBe(200);
        expect(store.getAllDocuments).toHaveBeenCalledWith({ searchQuery: "search", limit: 25, offset: 5 });
      });

      it("returns 400 for invalid limit", async () => {
        const res = await GET(buildApp(), "/api/documents?limit=-1");
        expect(res.status).toBe(400);
        expect(res.body.error).toContain("limit must be a positive integer");
      });

      it("returns 400 for non-numeric limit", async () => {
        const res = await GET(buildApp(), "/api/documents?limit=abc");
        expect(res.status).toBe(400);
        expect(res.body.error).toContain("limit must be a positive integer");
      });

      it("returns 400 for negative offset", async () => {
        const res = await GET(buildApp(), "/api/documents?offset=-5");
        expect(res.status).toBe(400);
        expect(res.body.error).toContain("offset must be a non-negative integer");
      });
    });
  });

  // --- PR Management route tests ---

  describe("POST /tasks/:id/pr/create", () => {
    let store: TaskStore;

    beforeEach(() => {
      store = createMockStore({
        getTask: vi.fn(),
        updatePrInfo: vi.fn(),
        logEntry: vi.fn().mockResolvedValue(undefined),
        getRootDir: vi.fn().mockReturnValue("/fake/root"),
      });
    });

    function buildApp() {
      const app = express();
      app.use(express.json());
      app.use("/api", createApiRoutes(store));
      return app;
    }

    const mockPrInfo = {
      url: "https://github.com/owner/repo/pull/42",
      number: 42,
      status: "open" as const,
      title: "Test PR",
      headBranch: "fusion/fn-001",
      baseBranch: "main",
      commentCount: 0,
    };

    const mockInReviewTask = {
      ...FAKE_TASK_DETAIL,
      column: "in-review" as const,
      prInfo: undefined,
    };

    it("returns 400 if task is not in in-review column", async () => {
      (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...FAKE_TASK_DETAIL,
        column: "in-progress",
      });

      const res = await REQUEST(
        buildApp(),
        "POST",
        "/api/tasks/KB-001/pr/create",
        JSON.stringify({ title: "Test PR", body: "Test body" }),
        { "Content-Type": "application/json" }
      );

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("in-review");
    });

    it("allows adding another PR even when a task already has one (multi-PR support)", async () => {
      // FN-4967 added multi-PR support: the route no longer rejects in-review
      // tasks that already have a primary PR. The handler reaches the GitHub
      // calls and, with no real git remote configured, fails downstream
      // (400/500). Just verify the early 409 is gone.
      (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...FAKE_TASK_DETAIL,
        column: "in-review",
        prInfo: mockPrInfo,
      });

      const res = await REQUEST(
        buildApp(),
        "POST",
        "/api/tasks/KB-001/pr/create",
        JSON.stringify({ title: "Test PR", body: "Test body" }),
        { "Content-Type": "application/json" }
      );

      expect(res.status).not.toBe(409);
    });

    it("returns 400 if title is missing", async () => {
      (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(mockInReviewTask);

      const res = await REQUEST(
        buildApp(),
        "POST",
        "/api/tasks/KB-001/pr/create",
        JSON.stringify({}),
        { "Content-Type": "application/json" }
      );

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("title is required");
    });

    it("no longer has in-app rate limiter (gh CLI handles rate limiting)", async () => {
      // Previously this test checked for a 429 response from an in-memory rate limiter.
      // Now gh CLI handles rate limiting internally, so multiple rapid requests
      // are allowed (gh CLI has its own rate limiting and caching).
      // Set up GITHUB_REPOSITORY env to bypass git lookup
      const originalEnv = process.env.GITHUB_REPOSITORY;
      process.env.GITHUB_REPOSITORY = "owner/rate-test";

      // Create a fresh store mock for this test
      const freshStore = createMockStore({
        getTask: vi.fn(),
        updatePrInfo: vi.fn(),
        logEntry: vi.fn().mockResolvedValue(undefined),
        getRootDir: vi.fn().mockReturnValue("/fake/root"),
      });

      function buildFreshApp() {
        const app = express();
        app.use(express.json());
        app.use("/api", createApiRoutes(freshStore));
        return app;
      }

      // Make multiple rapid requests - should not be rate limited by our code
      // (gh CLI handles rate limiting with GitHub)
      const app = buildFreshApp();
      for (let i = 0; i < 5; i++) {
        (freshStore.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
          ...mockInReviewTask,
          id: `KB-RATE-${i}`,
        });
        const res = await REQUEST(
          app,
          "POST",
          `/api/tasks/KB-RATE-${i}/pr/create`,
          JSON.stringify({ title: `Test PR ${i}`, body: "Test body" }),
          { "Content-Type": "application/json" }
        );
        // Should not get 429 from our code (may get 500 from gh CLI not being available in test)
        expect(res.status).not.toBe(429);
      }

      // Restore env
      if (originalEnv) {
        process.env.GITHUB_REPOSITORY = originalEnv;
      } else {
        delete process.env.GITHUB_REPOSITORY;
      }
    });

    it("reuses an existing branch PR without pushing or creating a duplicate", async () => {
      const originalEnv = process.env.GITHUB_REPOSITORY;
      process.env.GITHUB_REPOSITORY = "owner/repo";
      (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(mockInReviewTask);
      const existingPr = { ...mockPrInfo, number: 77, url: "https://github.com/owner/repo/pull/77" };
      const findSpy = vi.spyOn(GitHubClient.prototype, "findPrForBranch").mockResolvedValue(existingPr);
      const createSpy = vi.spyOn(GitHubClient.prototype, "createPr").mockResolvedValue(mockPrInfo);
      const pushSpy = vi.spyOn(resolveDiffBaseModule, "runGitCommand").mockResolvedValue("ok");

      const res = await REQUEST(
        buildApp(),
        "POST",
        "/api/tasks/KB-001/pr/create",
        JSON.stringify({ title: "Test PR", body: "Test body" }),
        { "Content-Type": "application/json" }
      );

      expect(res.status).toBe(201);
      expect(findSpy).toHaveBeenCalledWith(expect.objectContaining({ head: "fusion/fn-001", state: "all" }));
      expect(createSpy).not.toHaveBeenCalled();
      expect(pushSpy).not.toHaveBeenCalledWith(["push", "-u", "origin", "fusion/fn-001"], expect.anything(), expect.anything());
      expect(store.updatePrInfo).toHaveBeenCalledWith("FN-001", expect.objectContaining({ number: 77, manual: true }));
      expect(res.body).toEqual(expect.objectContaining({ number: 77, manual: true }));
      expect(store.logEntry).toHaveBeenCalledWith("FN-001", "Linked existing PR", "PR #77: https://github.com/owner/repo/pull/77");

      if (originalEnv) process.env.GITHUB_REPOSITORY = originalEnv;
      else delete process.env.GITHUB_REPOSITORY;
    });

    it("stores linked PRs with manual provenance when appending to an existing PR list", async () => {
      const originalEnv = process.env.GITHUB_REPOSITORY;
      process.env.GITHUB_REPOSITORY = "owner/repo";
      (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...mockInReviewTask,
        prInfo: mockPrInfo,
        prInfos: [mockPrInfo],
      });
      const existingPr = { ...mockPrInfo, number: 88, url: "https://github.com/owner/repo/pull/88" };
      vi.spyOn(GitHubClient.prototype, "findPrForBranch").mockResolvedValue(existingPr);
      const createSpy = vi.spyOn(GitHubClient.prototype, "createPr").mockResolvedValue(mockPrInfo);
      const pushSpy = vi.spyOn(resolveDiffBaseModule, "runGitCommand").mockResolvedValue("ok");

      const res = await REQUEST(
        buildApp(),
        "POST",
        "/api/tasks/KB-001/pr/create",
        JSON.stringify({ title: "Test PR", body: "Test body" }),
        { "Content-Type": "application/json" }
      );

      expect(res.status).toBe(201);
      expect(createSpy).not.toHaveBeenCalled();
      expect(pushSpy).not.toHaveBeenCalledWith(["push", "-u", "origin", "fusion/fn-001"], expect.anything(), expect.anything());
      expect(store.addPrInfo).toHaveBeenCalledWith("FN-001", expect.objectContaining({ number: 88, manual: true }));
      expect(res.body).toEqual(expect.objectContaining({ number: 88, manual: true }));

      if (originalEnv) process.env.GITHUB_REPOSITORY = originalEnv;
      else delete process.env.GITHUB_REPOSITORY;
    });

    it("pushes the task branch before creating a PR when no existing PR is found", async () => {
      const originalEnv = process.env.GITHUB_REPOSITORY;
      process.env.GITHUB_REPOSITORY = "owner/repo";
      (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(mockInReviewTask);
      const findSpy = vi.spyOn(GitHubClient.prototype, "findPrForBranch").mockResolvedValue(null);
      const createSpy = vi.spyOn(GitHubClient.prototype, "createPr").mockResolvedValue(mockPrInfo);
      const pushSpy = vi.spyOn(resolveDiffBaseModule, "runGitCommand").mockResolvedValue("ok");

      const res = await REQUEST(
        buildApp(),
        "POST",
        "/api/tasks/KB-001/pr/create",
        JSON.stringify({ title: "Test PR", body: "Test body" }),
        { "Content-Type": "application/json" }
      );

      expect(res.status).toBe(201);
      expect(findSpy).toHaveBeenCalled();
      expect(pushSpy).toHaveBeenCalledWith(["push", "-u", "origin", "fusion/fn-001"], "/fake/root", 60_000);
      expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({ head: "fusion/fn-001" }));
      expect(store.updatePrInfo).toHaveBeenCalledWith("FN-001", expect.objectContaining({ number: 42, manual: true }));
      expect(res.body).toEqual(expect.objectContaining({ number: 42, manual: true }));
      expect(store.logEntry).toHaveBeenCalledWith("FN-001", "Created PR", "PR #42: https://github.com/owner/repo/pull/42");

      if (originalEnv) process.env.GITHUB_REPOSITORY = originalEnv;
      else delete process.env.GITHUB_REPOSITORY;
    });

    it("returns 404 for non-existent task", async () => {
      // Create error with proper ENOENT code
      const error = new Error("ENOENT: task not found") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      error.errno = -2;
      (store.getTask as ReturnType<typeof vi.fn>).mockRejectedValue(error);

      const res = await REQUEST(
        buildApp(),
        "POST",
        "/api/tasks/KB-999/pr/create",
        JSON.stringify({ title: "Test PR", body: "Test body" }),
        { "Content-Type": "application/json" }
      );

      expect(res.status).toBe(404);
      expect(res.body.error).toContain("not found");
    });
  });

  describe("GET /tasks/:id/pr/status", () => {
    let store: TaskStore;

    beforeEach(() => {
      store = createMockStore({
        getTask: vi.fn(),
        getRootDir: vi.fn().mockReturnValue("/fake/root"),
      });
    });

    function buildApp() {
      const app = express();
      app.use(express.json());
      app.use("/api", createApiRoutes(store));
      return app;
    }

    const mockPrInfo = {
      url: "https://github.com/owner/repo/pull/42",
      number: 42,
      status: "open" as const,
      title: "Test PR",
      headBranch: "fusion/fn-001",
      baseBranch: "main",
      commentCount: 3,
    };

    it("returns cached PR info when available", async () => {
      (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...FAKE_TASK_DETAIL,
        prInfo: mockPrInfo,
        updatedAt: new Date().toISOString(),
      });

      const res = await GET(buildApp(), "/api/tasks/KB-001/pr/status");

      expect(res.status).toBe(200);
      expect(res.body.prInfo).toEqual(mockPrInfo);
      expect(res.body.stale).toBe(false);
      expect(res.body.automationStatus).toBeNull();
    });

    it("returns 404 when task has no PR", async () => {
      (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(FAKE_TASK_DETAIL);

      const res = await GET(buildApp(), "/api/tasks/KB-001/pr/status");

      expect(res.status).toBe(404);
      expect(res.body.error).toContain("no associated PR");
    });

    it("returns 404 for non-existent task", async () => {
      const error = new Error("Task not found") as Error & { code?: string };
      error.code = "ENOENT";
      (store.getTask as ReturnType<typeof vi.fn>).mockRejectedValue(error);

      const res = await GET(buildApp(), "/api/tasks/KB-999/pr/status");

      expect(res.status).toBe(404);
    });

    it("marks data as stale when older than 5 minutes", async () => {
      const oldDate = new Date(Date.now() - 6 * 60 * 1000).toISOString(); // 6 minutes ago
      (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...FAKE_TASK_DETAIL,
        prInfo: mockPrInfo,
        updatedAt: oldDate,
      });

      const res = await GET(buildApp(), "/api/tasks/KB-001/pr/status");

      expect(res.status).toBe(200);
      expect(res.body.stale).toBe(true);
    });

    it("uses lastCheckedAt for staleness check when available", async () => {
      const recentUpdate = new Date().toISOString();
      const oldCheck = new Date(Date.now() - 6 * 60 * 1000).toISOString(); // 6 minutes ago
      (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...FAKE_TASK_DETAIL,
        prInfo: { ...mockPrInfo, lastCheckedAt: oldCheck },
        updatedAt: recentUpdate,
      });

      const res = await GET(buildApp(), "/api/tasks/KB-001/pr/status");

      expect(res.status).toBe(200);
      // Should be stale because lastCheckedAt is old, even though updatedAt is recent
      expect(res.body.stale).toBe(true);
    });

    it("returns automationStatus so the UI can reflect PR-first waiting states", async () => {
      (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...FAKE_TASK_DETAIL,
        status: "awaiting-pr-checks",
        prInfo: mockPrInfo,
        updatedAt: new Date().toISOString(),
      });

      const res = await GET(buildApp(), "/api/tasks/KB-001/pr/status");

      expect(res.status).toBe(200);
      expect(res.body.automationStatus).toBe("awaiting-pr-checks");
    });

    it("marks data as fresh when lastCheckedAt is recent", async () => {
      const recentCheck = new Date(Date.now() - 2 * 60 * 1000).toISOString(); // 2 minutes ago
      (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...FAKE_TASK_DETAIL,
        prInfo: { ...mockPrInfo, lastCheckedAt: recentCheck },
        updatedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(), // 10 minutes ago
      });

      const res = await GET(buildApp(), "/api/tasks/KB-001/pr/status");

      expect(res.status).toBe(200);
      // Should be fresh because lastCheckedAt is recent, even though updatedAt is old
      expect(res.body.stale).toBe(false);
    });
  });

  describe("POST /tasks/:id/pr/refresh", () => {
    let store: TaskStore;

    beforeEach(() => {
      store = createMockStore({
        getTask: vi.fn(),
        updatePrInfo: vi.fn(),
        getRootDir: vi.fn().mockReturnValue("/fake/root"),
        getSettings: vi.fn().mockResolvedValue({}),
      });
    });

    function buildApp() {
      const app = express();
      app.use(express.json());
      app.use("/api", createApiRoutes(store));
      return app;
    }

    const mockPrInfo = {
      url: "https://github.com/owner/repo/pull/42",
      number: 42,
      status: "open" as const,
      title: "Test PR",
      headBranch: "fusion/fn-001",
      baseBranch: "main",
      commentCount: 3,
    };

    it("returns merge readiness details for PR-first UI refreshes", async () => {
      const originalRepo = process.env.GITHUB_REPOSITORY;
      process.env.GITHUB_REPOSITORY = "owner/repo";
      vi.spyOn(GitHubClient.prototype, "getPrReviewSnapshot").mockResolvedValue({
        decision: "CHANGES_REQUESTED",
        reviewers: [],
        items: [],
      });
      vi.spyOn(GitHubClient.prototype, "getPrMergeStatus").mockResolvedValue({
        prInfo: mockPrInfo,
        mergeReady: false,
        blockingReasons: ["required checks not successful: ci (pending)"],
        reviewDecision: "CHANGES_REQUESTED",
        checks: [{ name: "ci", required: true, state: "pending" }],
      });
      (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...FAKE_TASK_DETAIL,
        status: "awaiting-pr-checks",
        prInfo: mockPrInfo,
      });

      const res = await REQUEST(
        buildApp(),
        "POST",
        "/api/tasks/KB-001/pr/refresh",
        JSON.stringify({}),
        { "Content-Type": "application/json" }
      );

      expect(res.status).toBe(200);
      expect(res.body.prInfo.number).toBe(42);
      expect(res.body.mergeReady).toBe(false);
      expect(res.body.blockingReasons).toEqual(["required checks not successful: ci (pending)"]);
      expect(res.body.reviewDecision).toBe("CHANGES_REQUESTED");
      expect(res.body.automationStatus).toBe("awaiting-pr-checks");

      if (originalRepo) {
        process.env.GITHUB_REPOSITORY = originalRepo;
      } else {
        delete process.env.GITHUB_REPOSITORY;
      }
    });

    it("returns 404 when task has no PR", async () => {
      (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(FAKE_TASK_DETAIL);

      const res = await REQUEST(
        buildApp(),
        "POST",
        "/api/tasks/KB-001/pr/refresh",
        JSON.stringify({}),
        { "Content-Type": "application/json" }
      );

      expect(res.status).toBe(404);
      expect(res.body.error).toContain("no associated PR");
    });

    it("returns 404 for non-existent task", async () => {
      const error = new Error("Task not found") as Error & { code?: string };
      error.code = "ENOENT";
      (store.getTask as ReturnType<typeof vi.fn>).mockRejectedValue(error);

      const res = await REQUEST(
        buildApp(),
        "POST",
        "/api/tasks/KB-999/pr/refresh",
        JSON.stringify({}),
        { "Content-Type": "application/json" }
      );

      expect(res.status).toBe(404);
    });
  });

  describe("GET /tasks/:id/issue/status", () => {
    let store: TaskStore;

    beforeEach(() => {
      store = createMockStore({
        getTask: vi.fn(),
        getRootDir: vi.fn().mockReturnValue("/fake/root"),
      });
    });

    function buildApp() {
      const app = express();
      app.use(express.json());
      app.use("/api", createApiRoutes(store));
      return app;
    }

    const mockIssueInfo = {
      url: "https://github.com/owner/repo/issues/123",
      number: 123,
      state: "open" as const,
      title: "Test Issue",
    };

    it("returns cached issue info when available", async () => {
      (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...FAKE_TASK_DETAIL,
        issueInfo: mockIssueInfo,
        updatedAt: new Date().toISOString(),
      });

      const res = await GET(buildApp(), "/api/tasks/KB-001/issue/status");

      expect(res.status).toBe(200);
      expect(res.body.issueInfo).toEqual(mockIssueInfo);
      expect(res.body.stale).toBe(false);
    });

    it("returns 404 when task has no issue", async () => {
      (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(FAKE_TASK_DETAIL);

      const res = await GET(buildApp(), "/api/tasks/KB-001/issue/status");

      expect(res.status).toBe(404);
      expect(res.body.error).toContain("no associated issue");
    });
  });

  describe("POST /tasks/:id/issue/refresh", () => {
    let store: TaskStore;

    beforeEach(() => {
      store = createMockStore({
        getTask: vi.fn(),
        updateIssueInfo: vi.fn(),
        getRootDir: vi.fn().mockReturnValue("/fake/root"),
      });
    });

    function buildApp() {
      const app = express();
      app.use(express.json());
      app.use("/api", createApiRoutes(store));
      return app;
    }

    const mockIssueInfo = {
      url: "https://github.com/owner/repo/issues/123",
      number: 123,
      state: "closed" as const,
      title: "Test Issue",
      stateReason: "completed" as const,
    };

    it("refreshes and persists issue status", async () => {
      const originalRepo = process.env.GITHUB_REPOSITORY;
      process.env.GITHUB_REPOSITORY = "owner/repo";
      vi.spyOn(GitHubClient.prototype, "getIssueStatus").mockResolvedValue(mockIssueInfo);
      (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...FAKE_TASK_DETAIL,
        issueInfo: {
          url: "https://github.com/owner/repo/issues/123",
          number: 123,
          state: "open" as const,
          title: "Test Issue",
        },
      });

      const res = await REQUEST(
        buildApp(),
        "POST",
        "/api/tasks/KB-001/issue/refresh",
        JSON.stringify({}),
        { "Content-Type": "application/json" }
      );

      expect(res.status).toBe(200);
      expect(res.body.number).toBe(123);
      expect(res.body.state).toBe("closed");
      expect(res.body.stateReason).toBe("completed");
      expect(store.updateIssueInfo).toHaveBeenCalled();

      if (originalRepo) {
        process.env.GITHUB_REPOSITORY = originalRepo;
      } else {
        delete process.env.GITHUB_REPOSITORY;
      }
    });

    it("returns 404 when task has no issue", async () => {
      (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(FAKE_TASK_DETAIL);

      const res = await REQUEST(
        buildApp(),
        "POST",
        "/api/tasks/KB-001/issue/refresh",
        JSON.stringify({}),
        { "Content-Type": "application/json" }
      );

      expect(res.status).toBe(404);
      expect(res.body.error).toContain("no associated issue");
    });
  });

  describe("POST /github/batch/status", () => {
    let store: TaskStore;

    beforeEach(() => {
      store = createMockStore({
        getTask: vi.fn(),
        updateIssueInfo: vi.fn().mockResolvedValue(undefined),
        updatePrInfo: vi.fn().mockResolvedValue(undefined),
      });
    });

    function buildApp() {
      const app = express();
      app.use(express.json());
      app.use("/api", createApiRoutes(store));
      return app;
    }

    it("returns status for multiple tasks in one request", async () => {
      (store.getTask as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({
          ...FAKE_TASK_DETAIL,
          id: "FN-001",
          updatedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
          issueInfo: {
            url: "https://github.com/owner/repo/issues/101",
            number: 101,
            state: "open" as const,
            title: "Issue 101",
          },
        })
        .mockResolvedValueOnce({
          ...FAKE_TASK_DETAIL,
          id: "FN-002",
          updatedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
          prInfo: {
            url: "https://github.com/owner/repo/pull/42",
            number: 42,
            status: "open" as const,
            title: "PR 42",
            headBranch: "feature/42",
            baseBranch: "main",
            commentCount: 0,
          },
        });

      vi.spyOn(GitHubClient.prototype, "getBatchIssueStatus").mockResolvedValue(new Map([
        [101, {
          url: "https://github.com/owner/repo/issues/101",
          number: 101,
          state: "closed",
          title: "Issue 101",
          stateReason: "completed",
        }],
      ]));
      vi.spyOn(GitHubClient.prototype, "getBatchPrStatus").mockResolvedValue(new Map([
        [42, {
          url: "https://github.com/owner/repo/pull/42",
          number: 42,
          status: "merged",
          title: "PR 42",
          headBranch: "feature/42",
          baseBranch: "main",
          commentCount: 3,
        }],
      ]));

      const res = await REQUEST(
        buildApp(),
        "POST",
        "/api/github/batch/status",
        JSON.stringify({ taskIds: ["FN-001", "FN-002"] }),
        { "Content-Type": "application/json" },
      );

      expect(res.status).toBe(200);
      expect(res.body.results["FN-001"].issueInfo.state).toBe("closed");
      expect(res.body.results["FN-001"].stale).toBe(false);
      expect(res.body.results["FN-002"].prInfo.status).toBe("merged");
      expect(res.body.results["FN-002"].stale).toBe(false);
      expect(store.updateIssueInfo).toHaveBeenCalledWith(
        "FN-001",
        expect.objectContaining({ number: 101, state: "closed", lastCheckedAt: expect.any(String) }),
      );
      expect(store.updatePrInfo).toHaveBeenCalledWith(
        "FN-002",
        expect.objectContaining({ number: 42, status: "merged", lastCheckedAt: expect.any(String) }),
      );
    });

    it("preserves manual PR provenance during batch status refresh", async () => {
      (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...FAKE_TASK_DETAIL,
        id: "FN-003",
        updatedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
        prInfo: {
          url: "https://github.com/owner/repo/pull/43",
          number: 43,
          status: "open" as const,
          title: "PR 43",
          headBranch: "feature/43",
          baseBranch: "main",
          commentCount: 0,
          manual: true,
        },
      });

      vi.spyOn(GitHubClient.prototype, "getBatchPrStatus").mockResolvedValue(new Map([
        [43, {
          url: "https://github.com/owner/repo/pull/43",
          number: 43,
          status: "open",
          title: "PR 43 refreshed",
          headBranch: "feature/43",
          baseBranch: "main",
          commentCount: 2,
        }],
      ]));

      const res = await REQUEST(
        buildApp(),
        "POST",
        "/api/github/batch/status",
        JSON.stringify({ taskIds: ["FN-003"] }),
        { "Content-Type": "application/json" },
      );

      expect(res.status).toBe(200);
      expect(res.body.results["FN-003"].prInfo.manual).toBe(true);
      expect(store.updatePrInfo).toHaveBeenCalledWith(
        "FN-003",
        expect.objectContaining({ number: 43, manual: true, lastCheckedAt: expect.any(String) }),
      );
    });

    it("handles partial failures without dropping successful results", async () => {
      (store.getTask as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({
          ...FAKE_TASK_DETAIL,
          id: "FN-001",
          updatedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
          issueInfo: {
            url: "https://github.com/owner/repo/issues/101",
            number: 101,
            state: "open" as const,
            title: "Issue 101",
          },
        })
        .mockResolvedValueOnce({
          ...FAKE_TASK_DETAIL,
          id: "FN-002",
          updatedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
          issueInfo: {
            url: "https://github.com/owner/repo/issues/404",
            number: 404,
            state: "open" as const,
            title: "Issue 404",
          },
        });

      vi.spyOn(GitHubClient.prototype, "getBatchIssueStatus").mockResolvedValue(new Map([
        [101, {
          url: "https://github.com/owner/repo/issues/101",
          number: 101,
          state: "closed",
          title: "Issue 101",
          stateReason: "completed",
        }],
      ]));

      const res = await REQUEST(
        buildApp(),
        "POST",
        "/api/github/batch/status",
        JSON.stringify({ taskIds: ["FN-001", "FN-002"] }),
        { "Content-Type": "application/json" },
      );

      expect(res.status).toBe(200);
      expect(res.body.results["FN-001"].issueInfo.state).toBe("closed");
      expect(res.body.results["FN-002"].error).toContain("Issue #404 not found");
      expect(res.body.results["FN-002"].stale).toBe(true);
    });

    it("returns 429 when rate limit is exceeded", async () => {
      const originalRepo = process.env.GITHUB_REPOSITORY;
      process.env.GITHUB_REPOSITORY = "owner/repo";
      (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...FAKE_TASK_DETAIL,
        id: "FN-001",
        issueInfo: {
          url: "https://github.com/owner/repo/issues/101",
          number: 101,
          state: "open" as const,
          title: "Issue 101",
        },
      });

      const canMakeRequestSpy = vi.spyOn(githubRateLimiter, "canMakeRequest").mockReturnValue(false);
      const getResetTimeSpy = vi.spyOn(githubRateLimiter, "getResetTime").mockReturnValue(new Date("2026-03-30T12:05:00.000Z"));

      const res = await REQUEST(
        buildApp(),
        "POST",
        "/api/github/batch/status",
        JSON.stringify({ taskIds: ["FN-001"] }),
        { "Content-Type": "application/json" },
      );

      expect(res.status).toBe(429);
      expect(res.body.error).toContain("rate limit exceeded");
      expect(res.body.details?.resetAt).toBe("2026-03-30T12:05:00.000Z");

      canMakeRequestSpy.mockRestore();
      getResetTimeSpy.mockRestore();
      if (originalRepo) {
        process.env.GITHUB_REPOSITORY = originalRepo;
      } else {
        delete process.env.GITHUB_REPOSITORY;
      }
    });

    it("calculates stale per task based on refresh success and existing cached data", async () => {
      (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...FAKE_TASK_DETAIL,
        id: "FN-001",
        updatedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
        issueInfo: {
          url: "https://github.com/owner/repo/issues/101",
          number: 101,
          state: "open" as const,
          title: "Issue 101",
          lastCheckedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
        },
      });
      vi.spyOn(GitHubClient.prototype, "getBatchIssueStatus").mockResolvedValue(new Map());

      const res = await REQUEST(
        buildApp(),
        "POST",
        "/api/github/batch/status",
        JSON.stringify({ taskIds: ["FN-001"] }),
        { "Content-Type": "application/json" },
      );

      expect(res.status).toBe(200);
      expect(res.body.results["FN-001"].stale).toBe(true);
      expect(res.body.results["FN-001"].error).toContain("Issue #101 not found");
    });

    it("returns empty results for empty taskIds", async () => {
      const res = await REQUEST(
        buildApp(),
        "POST",
        "/api/github/batch/status",
        JSON.stringify({ taskIds: [] }),
        { "Content-Type": "application/json" },
      );

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ results: {} });
      expect(store.getTask).not.toHaveBeenCalled();
    });
  });
});

// --- GitHub Import route tests ---

describe("llama.cpp auth routes", () => {
  let store: TaskStore;
  let authStorage: AuthStorageLike;

  function buildApp(options?: Parameters<typeof createApiRoutes>[1]) {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store, { authStorage, ...options }));
    return app;
  }

  beforeEach(() => {
    store = createMockStore({
      updateGlobalSettings: vi.fn().mockResolvedValue({ useLlamaCpp: true }),
      getGlobalSettingsStore: vi.fn().mockReturnValue({
        ...createMockGlobalSettingsStore(),
        getSettings: vi.fn().mockResolvedValue({ useLlamaCpp: false }),
      }),
    });
    authStorage = createMockAuthStorage();
    vi.spyOn(llamaCppProbeModule, "probeLlamaCpp").mockResolvedValue({
      reachable: true,
      url: "http://127.0.0.1:8080",
      hasApiKey: false,
    });
  });

  it("enables llama.cpp when probe passes", async () => {
    const res = await REQUEST(buildApp(), "POST", "/api/auth/llama-cpp", JSON.stringify({ enabled: true }), {
      "content-type": "application/json",
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enabled: true, restartRequired: false });
    expect(store.updateGlobalSettings).toHaveBeenCalledWith({ useLlamaCpp: true });
  });

  it("returns 400 when enabling with unreachable server", async () => {
    vi.spyOn(llamaCppProbeModule, "probeLlamaCpp").mockResolvedValue({
      reachable: false,
      url: "http://127.0.0.1:8080",
      hasApiKey: false,
      reason: "llama.cpp server did not return a healthy response",
    });

    const res = await REQUEST(buildApp(), "POST", "/api/auth/llama-cpp", JSON.stringify({ enabled: true }), {
      "content-type": "application/json",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Cannot enable llama.cpp routing");
  });

  it("disabling works without probing the server", async () => {
    const probeSpy = vi.spyOn(llamaCppProbeModule, "probeLlamaCpp");
    probeSpy.mockClear();

    const res = await REQUEST(buildApp(), "POST", "/api/auth/llama-cpp", JSON.stringify({ enabled: false }), {
      "content-type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(probeSpy).not.toHaveBeenCalled();
  });

  it("returns 400 for non-boolean enabled", async () => {
    const res = await REQUEST(buildApp(), "POST", "/api/auth/llama-cpp", JSON.stringify({ enabled: "yes" }), {
      "content-type": "application/json",
    });

    expect(res.status).toBe(400);
  });

  it("returns llama.cpp provider status including API key flag", async () => {
    vi.spyOn(llamaCppProbeModule, "probeLlamaCpp").mockResolvedValue({
      reachable: true,
      url: "http://127.0.0.1:8080",
      hasApiKey: true,
    });

    const res = await GET(buildApp(), "/api/providers/llama-cpp/status");
    expect(res.status).toBe(200);
    expect(res.body.server.url).toBe("http://127.0.0.1:8080");
    expect(res.body.server.hasApiKey).toBe(true);
    expect(res.body.ready).toBe(false);
  });

  it("marks llama.cpp status not ready when extension resolution fails", async () => {
    const res = await GET(
      buildApp({
        getLlamaCppExtensionStatus: () => ({ status: "error", reason: "extension failed" }),
      } as Parameters<typeof createApiRoutes>[1]),
      "/api/providers/llama-cpp/status",
    );

    expect(res.status).toBe(200);
    expect(res.body.ready).toBe(false);
    expect(res.body.extension.status).toBe("error");
  });

  it("GET /auth/status includes llama-cpp provider with cli type", async () => {
    store.getGlobalSettingsStore = vi.fn().mockReturnValue({
      ...createMockGlobalSettingsStore(),
      getSettings: vi.fn().mockResolvedValue({ useLlamaCpp: true }),
    });

    const res = await GET(buildApp(), "/api/auth/status");
    expect(res.status).toBe(200);
    expect(res.body.providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "llama-cpp",
          name: "llama.cpp — via HTTP server",
          type: "cli",
          authenticated: true,
        }),
      ]),
    );
  });

  it("GET /auth/status marks llama-cpp unauthenticated when extension status is not ok", async () => {
    store.getGlobalSettingsStore = vi.fn().mockReturnValue({
      ...createMockGlobalSettingsStore(),
      getSettings: vi.fn().mockResolvedValue({ useLlamaCpp: true }),
    });

    const res = await GET(
      buildApp({ getLlamaCppExtensionStatus: () => ({ status: "error", reason: "bad ext" }) } as Parameters<
        typeof createApiRoutes
      >[1]),
      "/api/auth/status",
    );

    expect(res.status).toBe(200);
    expect(res.body.providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "llama-cpp",
          authenticated: false,
          type: "cli",
        }),
      ]),
    );
  });

  it("fires onUseLlamaCppToggled hook on transition", async () => {
    const onUseLlamaCppToggled = vi.fn();

    const res = await REQUEST(
      buildApp({ onUseLlamaCppToggled } as Parameters<typeof createApiRoutes>[1]),
      "POST",
      "/api/auth/llama-cpp",
      JSON.stringify({ enabled: true }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(200);
    expect(onUseLlamaCppToggled).toHaveBeenCalledWith(false, true);
  });

  it("PUT /settings/global with useLlamaCpp fires onUseLlamaCppToggled", async () => {
    const onUseLlamaCppToggled = vi.fn();
    store.updateGlobalSettings = vi.fn().mockResolvedValue({ useLlamaCpp: true });
    store.getGlobalSettingsStore = vi.fn().mockReturnValue({
      ...createMockGlobalSettingsStore(),
      getSettings: vi.fn().mockResolvedValue({ useLlamaCpp: false, useClaudeCli: false, useDroidCli: false }),
    });

    const res = await REQUEST(
      buildApp({ onUseLlamaCppToggled } as Parameters<typeof createApiRoutes>[1]),
      "PUT",
      "/api/settings/global",
      JSON.stringify({ useLlamaCpp: true }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(200);
    expect(onUseLlamaCppToggled).toHaveBeenCalledWith(false, true);
  });
});
