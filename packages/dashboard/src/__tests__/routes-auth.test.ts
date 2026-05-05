// @vitest-environment node

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from "vitest";
import express from "express";
import http from "node:http";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import * as projectStoreResolver from "../project-store-resolver.js";
import * as terminalServiceModule from "../terminal-service.js";
import { get as performGet, request as performRequest } from "../test-request.js";
import { resetRuntimeLogSink, setRuntimeLogSink } from "../runtime-logger.js";
import { resetDiagnosticsSink, setDiagnosticsSink, type LogEntry } from "../ai-session-diagnostics.js";
import * as updateCheckModule from "../update-check.js";
import { __setAgentReflectionServiceForTests } from "../routes/register-agent-reflection-rating-routes.js";

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
    isGhAvailable: vi.fn(),
    isGhAuthenticated: vi.fn(),
    isQmdAvailable: vi.fn().mockResolvedValue(false),
    CentralCore: vi.fn().mockImplementation(() => ({
      init: mockCentralInit,
      close: mockCentralClose,
      listProjects: mockCentralListProjects,
      reconcileProjectStatuses: mockCentralReconcileProjectStatuses,
    })),
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

import { AgentStore, Database, RoutineStore, isGhAvailable, isGhAuthenticated } from "@fusion/core";
import { createFnAgent } from "@fusion/engine";

const mockIsGhAvailable = vi.mocked(isGhAvailable);
const mockIsGhAuthenticated = vi.mocked(isGhAuthenticated);

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

describe("GET /models", () => {
  let store: TaskStore;

  beforeEach(() => {
    store = createMockStore();
  });

  function buildApp(modelRegistry?: ModelRegistryLike) {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store, { modelRegistry }));
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

  // Regression guard: FN-2370's auto-resolved squash inverted this filter,
  // emptying every model picker in the UI. The filter is small but the
  // failure mode is silent and project-wide — keep these tests close to the
  // route so any future flip flips CI red immediately.
  describe("useClaudeCli filter", () => {
    function buildAppWithSetting(useClaudeCli: boolean | undefined, modelRegistry: ModelRegistryLike) {
      const globalStore = createMockGlobalSettingsStore();
      (globalStore.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue(
        useClaudeCli === undefined ? {} : { useClaudeCli },
      );
      (store.getGlobalSettingsStore as ReturnType<typeof vi.fn>).mockReturnValue(globalStore);
      return buildApp(modelRegistry);
    }

    function registryWithCli(): ModelRegistryLike {
      return createMockModelRegistry({
        getAvailable: vi.fn().mockReturnValue([
          { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", provider: "anthropic", reasoning: true, contextWindow: 200000 },
          { id: "gpt-4o", name: "GPT-4o", provider: "openai", reasoning: false, contextWindow: 128000 },
          { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5 (CLI)", provider: "pi-claude-cli", reasoning: true, contextWindow: 200000 },
        ]),
      });
    }

    it("hides pi-claude-cli entries when useClaudeCli is false", async () => {
      const res = await GET(buildAppWithSetting(false, registryWithCli()), "/api/models");
      expect(res.status).toBe(200);
      const providers = res.body.models.map((m: { provider: string }) => m.provider);
      expect(providers).not.toContain("pi-claude-cli");
      expect(providers).toEqual(expect.arrayContaining(["anthropic", "openai"]));
    });

    it("hides pi-claude-cli entries when setting is unset (default off)", async () => {
      const res = await GET(buildAppWithSetting(undefined, registryWithCli()), "/api/models");
      expect(res.status).toBe(200);
      const providers = res.body.models.map((m: { provider: string }) => m.provider);
      expect(providers).not.toContain("pi-claude-cli");
    });

    it("includes pi-claude-cli entries alongside other providers when useClaudeCli is true", async () => {
      const res = await GET(buildAppWithSetting(true, registryWithCli()), "/api/models");
      expect(res.status).toBe(200);
      const providers = res.body.models.map((m: { provider: string }) => m.provider);
      expect(providers).toEqual(expect.arrayContaining(["anthropic", "openai", "pi-claude-cli"]));
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

  it("returns provider list with auth status", async () => {
    (authStorage.hasAuth as ReturnType<typeof vi.fn>).mockReturnValue(true);

    const res = await GET(buildApp(), "/api/auth/status");

    expect(res.status).toBe(200);
    // Filter out synthetic CLI providers — they have dedicated route tests.
    // Structural assertions here are about OAuth + API-key paths only.
    const providers = res.body.providers.filter((p: any) => p.id !== "claude-cli" && p.id !== "droid-cli" && p.id !== "llama-cpp");
    expect(providers).toEqual([
      { id: "github-copilot", name: "GitHub Copilot", authenticated: true, type: "oauth", loginInProgress: false },
      { id: "openrouter", name: "OpenRouter", authenticated: false, type: "api_key" },
      { id: "kimi-coding", name: "Kimi", authenticated: false, type: "api_key" },
    ]);
    expect(authStorage.reload).toHaveBeenCalled();
  });

  it("includes Anthropic as oauth when auth storage reports it", async () => {
    (authStorage.getOAuthProviders as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: "anthropic", name: "Anthropic" },
    ]);
    (authStorage.hasAuth as ReturnType<typeof vi.fn>).mockImplementation((provider: string) => provider === "anthropic");

    const res = await GET(buildApp(), "/api/auth/status");

    expect(res.status).toBe(200);
    const anthropic = res.body.providers.find((p: any) => p.id === "anthropic");
    expect(anthropic).toEqual({
      id: "anthropic",
      name: "Anthropic",
      authenticated: true,
      type: "oauth",
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

    const res = await GET(buildApp(), "/api/auth/status");

    expect(res.status).toBe(200);
    const providers = res.body.providers.filter((p: any) => p.id !== "claude-cli" && p.id !== "droid-cli" && p.id !== "llama-cpp");
    expect(providers).toEqual([
      { id: "github-copilot", name: "GitHub Copilot", authenticated: true, type: "oauth", loginInProgress: false },
      { id: "openai-codex", name: "OpenAI Codex", authenticated: false, type: "oauth", loginInProgress: false },
      { id: "openrouter", name: "OpenRouter", authenticated: false, type: "api_key" },
      { id: "kimi-coding", name: "Kimi", authenticated: false, type: "api_key" },
      { id: "acme-extension", name: "Acme Extension", authenticated: true, type: "api_key" },
    ]);
  });

  it("returns unauthenticated status", async () => {
    (authStorage.hasAuth as ReturnType<typeof vi.fn>).mockReturnValue(false);

    const res = await GET(buildApp(), "/api/auth/status");

    expect(res.status).toBe(200);
    expect(res.body.providers[0].authenticated).toBe(false);
  });

  it("treats expired oauth credentials as unauthenticated", async () => {
    (authStorage.hasAuth as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (authStorage.get as ReturnType<typeof vi.fn>).mockImplementation((provider: string) =>
      provider === "github-copilot"
        ? { type: "oauth", access: "token", refresh: "refresh", expires: Date.now() - 1_000 }
        : undefined,
    );

    const res = await GET(buildApp(), "/api/auth/status");

    expect(res.status).toBe(200);
    const githubCopilot = res.body.providers.find((p: any) => p.id === "github-copilot");
    expect(githubCopilot.authenticated).toBe(false);
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

    const app = buildApp();
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

    const res = await GET(buildApp(), "/api/auth/status");

    expect(res.status).toBe(200);
    const openrouter = res.body.providers.find((p: any) => p.id === "openrouter");
    expect(openrouter).toBeDefined();
    expect(openrouter.authenticated).toBe(true);
    expect(openrouter.type).toBe("api_key");
  });

  it("reports research API-key providers with type api_key", async () => {
    (authStorage.getApiKeyProviders as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: "tavily", name: "Tavily" },
    ]);

    const res = await GET(buildApp(), "/api/auth/status");

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

    const res = await GET(buildApp(), "/api/auth/status");

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

  it("rewrites redirect_uri to dashboard oauth proxy when origin is non-localhost", async () => {
    (authStorage.login as ReturnType<typeof vi.fn>).mockImplementation((_provider: string, callbacks: any) => {
      callbacks.onAuth({
        url: "https://accounts.example.com/o/oauth2/v2/auth?state=test-state&redirect_uri=http%3A%2F%2Flocalhost%3A8085%2Foauth2callback",
        instructions: "Open in browser",
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
    const returnedUrl = new URL(res.body.url);
    expect(returnedUrl.searchParams.get("redirect_uri")).toBe("https://my-host.example.com/api/auth/oauth-callback");
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
      getOAuthProviders: vi.fn().mockReturnValue([{ id: "openai-codex", name: "OpenAI Codex" }]),
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
        JSON.stringify({ provider: "github-copilot", origin: "https://remote.example.com" }),
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

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store, { authStorage }));
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
      it("returns empty array when no documents", async () => {
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

      it("returns 404 when document not found", async () => {
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

      it("returns empty array for nonexistent document", async () => {
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

      it("returns documents across multiple tasks", async () => {
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
          {
            id: "doc-2",
            taskId: "KB-002",
            key: "notes",
            content: "Notes content",
            revision: 1,
            author: "agent",
            createdAt: "2024-01-02T00:00:00.000Z",
            updatedAt: "2024-01-02T00:00:00.000Z",
            taskTitle: "Task Two",
            taskColumn: "in-progress",
          },
        ];
        (store.getAllDocuments as ReturnType<typeof vi.fn>).mockResolvedValue(mockDocs);
        const res = await GET(buildApp(), "/api/documents");
        expect(res.status).toBe(200);
        expect(res.body).toHaveLength(2);
        expect(res.body[0].taskTitle).toBe("Task One");
        expect(res.body[1].taskTitle).toBe("Task Two");
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
        JSON.stringify({ title: "Test PR" }),
        { "Content-Type": "application/json" }
      );

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("in-review");
    });

    it("returns 409 if task already has a PR", async () => {
      (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...FAKE_TASK_DETAIL,
        column: "in-review",
        prInfo: mockPrInfo,
      });

      const res = await REQUEST(
        buildApp(),
        "POST",
        "/api/tasks/KB-001/pr/create",
        JSON.stringify({ title: "Test PR" }),
        { "Content-Type": "application/json" }
      );

      expect(res.status).toBe(409);
      expect(res.body.error).toContain("already has PR");
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
          JSON.stringify({ title: `Test PR ${i}` }),
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
        JSON.stringify({ title: "Test PR" }),
        { "Content-Type": "application/json" }
      );

      expect(res.status).toBe(201);
      expect(findSpy).toHaveBeenCalledWith(expect.objectContaining({ head: "fusion/fn-001", state: "all" }));
      expect(createSpy).not.toHaveBeenCalled();
      expect(pushSpy).not.toHaveBeenCalledWith(["push", "-u", "origin", "fusion/fn-001"], expect.anything(), expect.anything());
      expect(store.logEntry).toHaveBeenCalledWith("FN-001", "Linked existing PR", "PR #77: https://github.com/owner/repo/pull/77");

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
        JSON.stringify({ title: "Test PR" }),
        { "Content-Type": "application/json" }
      );

      expect(res.status).toBe(201);
      expect(findSpy).toHaveBeenCalled();
      expect(pushSpy).toHaveBeenCalledWith(["push", "-u", "origin", "fusion/fn-001"], "/fake/root", 60_000);
      expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({ head: "fusion/fn-001" }));
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
        JSON.stringify({ title: "Test PR" }),
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
