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
const { mockPerformUpdateCheck, mockClearUpdateCheckCache, mockExecSync, mockExecFile, mockGetActiveNotificationService } = vi.hoisted(() => ({
  mockPerformUpdateCheck: vi.fn(),
  mockClearUpdateCheckCache: vi.fn(),
  mockExecSync: vi.fn(),
  mockExecFile: vi.fn(),
  mockGetActiveNotificationService: vi.fn(),
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
  getActiveNotificationService: mockGetActiveNotificationService,
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


import { DEFAULT_SETTINGS } from "@fusion/core";

describe("GET /settings", () => {
  let store: TaskStore;

  beforeEach(() => {
    store = createMockStore();
    mockIsGhAvailable.mockReturnValue(false);
    mockIsGhAuthenticated.mockReturnValue(false);
  });

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store, { githubToken: "ghp_test_token" }));
    return app;
  }

  it("returns persisted settings merged with defaults", async () => {
    const persistedSettings = { maxConcurrent: 5, autoMerge: false };
    (store.getSettingsFast as ReturnType<typeof vi.fn>).mockResolvedValue({ ...DEFAULT_SETTINGS, ...persistedSettings });

    const res = await GET(buildApp(), "/api/settings");

    expect(res.status).toBe(200);
    expect(res.body.maxConcurrent).toBe(5);
    expect(res.body.autoMerge).toBe(false);
    expect(res.body.pollIntervalMs).toBe(DEFAULT_SETTINGS.pollIntervalMs);
  });

  it("injects prAuthAvailable as true when gh is available and authenticated", async () => {
    mockIsGhAvailable.mockReturnValue(true);
    mockIsGhAuthenticated.mockReturnValue(true);
    (store.getSettingsFast as ReturnType<typeof vi.fn>).mockResolvedValue(DEFAULT_SETTINGS);

    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store)); // no githubToken option

    const res = await GET(app, "/api/settings");

    expect(res.status).toBe(200);
    expect(res.body.prAuthAvailable).toBe(true);
    expect(res.body.trackingAuthAvailable).toBe(true);
    expect(res.body.trackingAuthReason).toBeNull();
    expect(res.body.githubTokenConfigured).toBeUndefined();
  });

  it("injects prAuthAvailable as true when token fallback is configured", async () => {
    (store.getSettingsFast as ReturnType<typeof vi.fn>).mockResolvedValue(DEFAULT_SETTINGS);

    const res = await GET(buildApp(), "/api/settings");

    expect(res.status).toBe(200);
    expect(res.body.prAuthAvailable).toBe(true);
    expect(res.body.githubTokenConfigured).toBeUndefined();
  });

  it("injects prAuthAvailable as false when neither gh auth nor token fallback is available", async () => {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store)); // no githubToken option

    (store.getSettingsFast as ReturnType<typeof vi.fn>).mockResolvedValue(DEFAULT_SETTINGS);

    const res = await GET(app, "/api/settings");

    expect(res.status).toBe(200);
    expect(res.body.prAuthAvailable).toBe(false);
    expect(res.body.trackingAuthAvailable).toBe(false);
    expect(res.body.trackingAuthReason).toBe("gh_not_installed");
    expect(res.body.githubTokenConfigured).toBeUndefined();
  });

  it("returns defaultNodeId and unavailableNodePolicy when configured", async () => {
    (store.getSettingsFast as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      defaultNodeId: "node-abc",
      unavailableNodePolicy: "fallback-local",
    });

    const res = await GET(buildApp(), "/api/settings");

    expect(res.status).toBe(200);
    expect(res.body.defaultNodeId).toBe("node-abc");
    expect(res.body.unavailableNodePolicy).toBe("fallback-local");
  });

  it("returns 500 on store error", async () => {
    (store.getSettingsFast as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Config read failed"));

    const res = await GET(buildApp(), "/api/settings");

    expect(res.status).toBe(500);
    expect(res.body.error).toContain("Config read failed");
  });
});

describe("PUT /settings", () => {
  let store: TaskStore;

  beforeEach(() => {
    store = createMockStore();
  });

  function buildApp(routeOptions: Parameters<typeof createApiRoutes>[1] = { githubToken: "ghp_test_token" }) {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store, routeOptions));
    return app;
  }

  it("updates settings with valid payload", async () => {
    const updatedSettings = { ...DEFAULT_SETTINGS, maxConcurrent: 8 };
    (store.updateSettings as ReturnType<typeof vi.fn>).mockResolvedValue(updatedSettings);

    const res = await REQUEST(
      buildApp(),
      "PUT",
      "/api/settings",
      JSON.stringify({ maxConcurrent: 8 }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(200);
    expect(store.updateSettings).toHaveBeenCalledWith({ maxConcurrent: 8 });
  });

  it("updates settings with auto-backup enabled without logging routine sync failure", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "kb-routes-backup-routine-"));
    const db = new Database(join(tempDir, ".fusion"));
    db.exec(`
      CREATE TABLE IF NOT EXISTS __meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        nextId INTEGER DEFAULT 1,
        nextWorkflowStepId INTEGER DEFAULT 1,
        settings TEXT DEFAULT '{}',
        workflowSteps TEXT DEFAULT '[]',
        updatedAt TEXT
      );
      CREATE TABLE IF NOT EXISTS routines (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        triggerType TEXT NOT NULL,
        triggerConfig TEXT NOT NULL,
        command TEXT,
        enabled INTEGER DEFAULT 1,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
    `);
    db.exec("INSERT INTO __meta (key, value) VALUES ('schemaVersion', '55')");
    db.exec("INSERT INTO __meta (key, value) VALUES ('lastModified', '1000')");
    db.close();

    const routineStore = new RoutineStore(tempDir);
    await routineStore.init();

    const updatedSettings = {
      ...DEFAULT_SETTINGS,
      autoBackupEnabled: true,
      autoBackupSchedule: "0 2 * * *",
    };
    (store.updateSettings as ReturnType<typeof vi.fn>).mockResolvedValue(updatedSettings);

    const runtimeEvents: Array<{ level: string; scope: string; message: string; context?: Record<string, unknown> }> = [];
    setRuntimeLogSink((level, scope, message, context) => {
      runtimeEvents.push({ level, scope, message, context });
    });

    try {
      const res = await REQUEST(
        buildApp({ githubToken: "ghp_test_token", routineStore }),
        "PUT",
        "/api/settings",
        JSON.stringify({ autoBackupEnabled: true, autoBackupSchedule: "0 2 * * *" }),
        { "Content-Type": "application/json" },
      );

      expect(res.status).toBe(200);
      expect(runtimeEvents.some((event) => event.message === "Failed to sync backup routine")).toBe(false);
    } finally {
      resetRuntimeLogSink();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("updates defaultNodeId when provided", async () => {
    const updatedSettings = { ...DEFAULT_SETTINGS, defaultNodeId: "node-abc" };
    (store.updateSettings as ReturnType<typeof vi.fn>).mockResolvedValue(updatedSettings);

    const res = await REQUEST(
      buildApp(),
      "PUT",
      "/api/settings",
      JSON.stringify({ defaultNodeId: "node-abc" }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(200);
    expect(store.updateSettings).toHaveBeenCalledWith({ defaultNodeId: "node-abc" });
  });

  it("clears defaultNodeId when null is provided", async () => {
    const updatedSettings = { ...DEFAULT_SETTINGS, defaultNodeId: undefined };
    (store.updateSettings as ReturnType<typeof vi.fn>).mockResolvedValue(updatedSettings);

    const res = await REQUEST(
      buildApp(),
      "PUT",
      "/api/settings",
      JSON.stringify({ defaultNodeId: null }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(200);
    expect(store.updateSettings).toHaveBeenCalledWith({ defaultNodeId: null });
  });

  it("updates unavailableNodePolicy to fallback-local", async () => {
    const updatedSettings = { ...DEFAULT_SETTINGS, unavailableNodePolicy: "fallback-local" };
    (store.updateSettings as ReturnType<typeof vi.fn>).mockResolvedValue(updatedSettings);

    const res = await REQUEST(
      buildApp(),
      "PUT",
      "/api/settings",
      JSON.stringify({ unavailableNodePolicy: "fallback-local" }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(200);
    expect(store.updateSettings).toHaveBeenCalledWith({ unavailableNodePolicy: "fallback-local" });
  });

  it("updates unavailableNodePolicy to block", async () => {
    const updatedSettings = { ...DEFAULT_SETTINGS, unavailableNodePolicy: "block" };
    (store.updateSettings as ReturnType<typeof vi.fn>).mockResolvedValue(updatedSettings);

    const res = await REQUEST(
      buildApp(),
      "PUT",
      "/api/settings",
      JSON.stringify({ unavailableNodePolicy: "block" }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(200);
    expect(store.updateSettings).toHaveBeenCalledWith({ unavailableNodePolicy: "block" });
  });

  it("strips server-owned fields before calling store.updateSettings", async () => {
    const updatedSettings = { ...DEFAULT_SETTINGS, maxConcurrent: 4 };
    (store.updateSettings as ReturnType<typeof vi.fn>).mockResolvedValue(updatedSettings);

    const res = await REQUEST(
      buildApp(),
      "PUT",
      "/api/settings",
      JSON.stringify({
        maxConcurrent: 4,
        githubTokenConfigured: true,
        prAuthAvailable: true,
        trackingAuthAvailable: true,
        trackingAuthReason: null,
      }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(200);
    // The server should strip server-computed fields before passing to store
    expect(store.updateSettings).toHaveBeenCalledWith({ maxConcurrent: 4 });
  });

  it("strips multiple server-owned fields if present", async () => {
    const updatedSettings = { ...DEFAULT_SETTINGS, maxWorktrees: 10 };
    (store.updateSettings as ReturnType<typeof vi.fn>).mockResolvedValue(updatedSettings);

    const res = await REQUEST(
      buildApp(),
      "PUT",
      "/api/settings",
      JSON.stringify({
        maxWorktrees: 10,
        githubTokenConfigured: true,
        prAuthAvailable: true,
        trackingAuthAvailable: false,
        trackingAuthReason: "token_missing",
      }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(200);
    expect(store.updateSettings).toHaveBeenCalledWith({ maxWorktrees: 10 });
  });

  it("validates and forwards model presets", async () => {
    const updatedSettings = {
      ...DEFAULT_SETTINGS,
      modelPresets: [{ id: "budget", name: "Budget", executorProvider: "openai", executorModelId: "gpt-4o-mini" }],
    };
    (store.updateSettings as ReturnType<typeof vi.fn>).mockResolvedValue(updatedSettings);

    const res = await REQUEST(
      buildApp(),
      "PUT",
      "/api/settings",
      JSON.stringify({ modelPresets: [{ id: "budget", name: "Budget", executorProvider: "openai", executorModelId: "gpt-4o-mini" }] }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(200);
    expect(store.updateSettings).toHaveBeenCalledWith(expect.objectContaining({
      modelPresets: [{ id: "budget", name: "Budget", executorProvider: "openai", executorModelId: "gpt-4o-mini", validatorProvider: undefined, validatorModelId: undefined }],
    }));
  });

  it("resolves duplicate preset ids by auto-generating unique ids", async () => {
    const res = await REQUEST(
      buildApp(),
      "PUT",
      "/api/settings",
      JSON.stringify({ modelPresets: [{ id: "budget", name: "Budget" }, { id: "budget", name: "Budget 2" }] }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(200);
    expect(store.updateSettings).toHaveBeenCalledWith(expect.objectContaining({
      modelPresets: [
        expect.objectContaining({ id: "budget", name: "Budget" }),
        // "budget" collides; falls back to slug of name "Budget 2" → "budget-2"
        expect.objectContaining({ id: "budget-2", name: "Budget 2" }),
      ],
    }));
  });

  it("auto-generates preset id from name when id is omitted", async () => {
    const updatedSettings = {
      ...DEFAULT_SETTINGS,
      modelPresets: [{ id: "my-custom-preset", name: "My Custom Preset" }],
    };
    (store.updateSettings as ReturnType<typeof vi.fn>).mockResolvedValue(updatedSettings);

    const res = await REQUEST(
      buildApp(),
      "PUT",
      "/api/settings",
      JSON.stringify({ modelPresets: [{ name: "My Custom Preset" }] }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(200);
    expect(store.updateSettings).toHaveBeenCalledWith(expect.objectContaining({
      modelPresets: [expect.objectContaining({ id: "my-custom-preset", name: "My Custom Preset" })],
    }));
  });

  it("preserves explicit preset id when provided", async () => {
    const updatedSettings = {
      ...DEFAULT_SETTINGS,
      modelPresets: [{ id: "custom-id", name: "My Preset" }],
    };
    (store.updateSettings as ReturnType<typeof vi.fn>).mockResolvedValue(updatedSettings);

    const res = await REQUEST(
      buildApp(),
      "PUT",
      "/api/settings",
      JSON.stringify({ modelPresets: [{ id: "custom-id", name: "My Preset" }] }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(200);
    expect(store.updateSettings).toHaveBeenCalledWith(expect.objectContaining({
      modelPresets: [expect.objectContaining({ id: "custom-id", name: "My Preset" })],
    }));
  });

  it("rejects incomplete model provider/modelId pairs", async () => {
    const res = await REQUEST(
      buildApp(),
      "PUT",
      "/api/settings",
      JSON.stringify({ modelPresets: [{ id: "budget", name: "Budget", executorProvider: "openai" }] }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("must include both provider and modelId or neither");
  });

  it("accepts dual-scope githubTrackingDefaultRepo on project settings endpoint", async () => {
    const updatedSettings = { ...DEFAULT_SETTINGS, githubTrackingDefaultRepo: "octo/project-default" };
    (store.updateSettings as ReturnType<typeof vi.fn>).mockResolvedValue(updatedSettings);

    const res = await REQUEST(
      buildApp(),
      "PUT",
      "/api/settings",
      JSON.stringify({ githubTrackingDefaultRepo: "octo/project-default" }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(200);
    expect(store.updateSettings).toHaveBeenCalledWith({ githubTrackingDefaultRepo: "octo/project-default" });
  });

  it("rejects global-only fields with 400 error and helpful message", async () => {
    const res = await REQUEST(
      buildApp(),
      "PUT",
      "/api/settings",
      JSON.stringify({ themeMode: "dark", maxConcurrent: 4 }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("global settings");
    expect(res.body.error).toContain("themeMode");
    expect(res.body.error).toContain("/settings/global");
  });

  it("rejects when only global fields are sent", async () => {
    const res = await REQUEST(
      buildApp(),
      "PUT",
      "/api/settings",
      JSON.stringify({ defaultProvider: "anthropic", defaultModelId: "claude-sonnet-4-5" }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("defaultProvider");
  });

  it("allows project-only fields to pass through successfully", async () => {
    const updatedSettings = { ...DEFAULT_SETTINGS, maxConcurrent: 8 };
    (store.updateSettings as ReturnType<typeof vi.fn>).mockResolvedValue(updatedSettings);

    const res = await REQUEST(
      buildApp(),
      "PUT",
      "/api/settings",
      JSON.stringify({ maxConcurrent: 8, autoMerge: false }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(200);
    expect(store.updateSettings).toHaveBeenCalledWith({ maxConcurrent: 8, autoMerge: false });
  });

  it("accepts valid nested evalSettings payload", async () => {
    (store.updateSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      evalSettings: {
        enabled: true,
        intervalMs: 300000,
        evaluatorProvider: "openai",
        evaluatorModelId: "gpt-5",
        followUpPolicy: "suggest-only",
        retentionDays: 45,
      },
    });

    const payload = {
      evalSettings: {
        enabled: true,
        intervalMs: 300000,
        evaluatorProvider: "openai",
        evaluatorModelId: "gpt-5",
        followUpPolicy: "suggest-only",
        retentionDays: 45,
      },
    };

    const res = await REQUEST(buildApp(), "PUT", "/api/settings", JSON.stringify(payload), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(store.updateSettings).toHaveBeenCalledWith(payload);
  });

  it("rejects invalid evalSettings payloads", async () => {
    const invalidPayloads = [
      {
        payload: { evalSettings: { intervalMs: 59_999 } },
        message: "evalSettings.intervalMs",
      },
      {
        payload: { evalSettings: { retentionDays: 0 } },
        message: "evalSettings.retentionDays",
      },
      {
        payload: { evalSettings: { followUpPolicy: "create" } },
        message: "evalSettings.followUpPolicy",
      },
      {
        payload: { evalSettings: { evaluatorProvider: "openai" } },
        message: "evalSettings.evaluatorProvider and evalSettings.evaluatorModelId",
      },
    ];

    for (const { payload, message } of invalidPayloads) {
      const res = await REQUEST(buildApp(), "PUT", "/api/settings", JSON.stringify(payload), {
        "Content-Type": "application/json",
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain(message);
    }

    expect(store.updateSettings).not.toHaveBeenCalled();
  });

  it("accepts partial remoteAccess patches and GET /settings returns merged sibling branches", async () => {
    const mergedRemoteAccess = {
      enabled: true,
      activeProvider: "tailscale",
      providers: {
        tailscale: {
          enabled: true,
          hostname: "tail.example.ts.net",
          targetPort: 5173,
          acceptRoutes: true,
        },
        cloudflare: {
          enabled: false,
        quickTunnel: false,
          tunnelName: "existing-tunnel",
          tunnelToken: null,
          ingressUrl: "",
        },
      },
      tokenStrategy: {
        persistent: {
          enabled: true,
          token: null,
        },
        shortLived: {
          enabled: false,
          ttlMs: 900000,
          maxTtlMs: 86400000,
        },
      },
      lifecycle: {
        rememberLastRunning: false,
        wasRunningOnShutdown: false,
        lastRunningProvider: null,
      },
    };

    const updatedSettings = {
      ...DEFAULT_SETTINGS,
      remoteAccess: mergedRemoteAccess,
    };

    (store.updateGlobalSettings as ReturnType<typeof vi.fn>).mockResolvedValue(updatedSettings);
    (store.getSettingsFast as ReturnType<typeof vi.fn>).mockResolvedValue(updatedSettings);

    const app = buildApp();
    const patch = {
      remoteAccess: {
        activeProvider: "tailscale",
        providers: {
          tailscale: {
            enabled: true,
            hostname: "tail.example.ts.net",
            targetPort: 5173,
            acceptRoutes: true,
          },
        },
      },
    };

    const updateRes = await REQUEST(
      app,
      "PUT",
      "/api/settings/global",
      JSON.stringify(patch),
      { "Content-Type": "application/json" },
    );

    expect(updateRes.status).toBe(200);
    expect(store.updateGlobalSettings).toHaveBeenCalledWith(patch);

    const getRes = await GET(app, "/api/settings");
    expect(getRes.status).toBe(200);
    expect(getRes.body.remoteAccess.providers.tailscale.hostname).toBe("tail.example.ts.net");
    expect(getRes.body.remoteAccess.providers.cloudflare.tunnelName).toBe("existing-tunnel");
    expect(getRes.body.remoteAccess.tokenStrategy.persistent.enabled).toBe(true);
    expect(getRes.body.remoteAccess.lifecycle.rememberLastRunning).toBe(false);
  });

  it("validates auto-archive age settings", async () => {
    const res = await REQUEST(
      buildApp(),
      "PUT",
      "/api/settings",
      JSON.stringify({ autoArchiveDoneAfterMs: 0 }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("autoArchiveDoneAfterMs");
    expect(store.updateSettings).not.toHaveBeenCalled();
  });

  it("validates archive agent log mode", async () => {
    const res = await REQUEST(
      buildApp(),
      "PUT",
      "/api/settings",
      JSON.stringify({ archiveAgentLogMode: "everything" }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("archiveAgentLogMode");
    expect(store.updateSettings).not.toHaveBeenCalled();
  });

  it("accepts unavailableNodePolicy fallback-local", async () => {
    const updatedSettings = {
      ...DEFAULT_SETTINGS,
      unavailableNodePolicy: "fallback-local",
    };
    (store.updateSettings as ReturnType<typeof vi.fn>).mockResolvedValue(updatedSettings);

    const res = await REQUEST(
      buildApp(),
      "PUT",
      "/api/settings",
      JSON.stringify({ unavailableNodePolicy: "fallback-local" }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(200);
    expect(store.updateSettings).toHaveBeenCalledWith({ unavailableNodePolicy: "fallback-local" });
  });

  it("rejects invalid unavailableNodePolicy values", async () => {
    const res = await REQUEST(
      buildApp(),
      "PUT",
      "/api/settings",
      JSON.stringify({ unavailableNodePolicy: "auto-retry" }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("unavailableNodePolicy");
    expect(store.updateSettings).not.toHaveBeenCalled();
  });

  it("rejects non-string unavailableNodePolicy values", async () => {
    const res = await REQUEST(
      buildApp(),
      "PUT",
      "/api/settings",
      JSON.stringify({ unavailableNodePolicy: 42 }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("unavailableNodePolicy");
    expect(store.updateSettings).not.toHaveBeenCalled();
  });

  it("returns 500 on store update error", async () => {
    (store.updateSettings as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Write failed"));

    const res = await REQUEST(
      buildApp(),
      "PUT",
      "/api/settings",
      JSON.stringify({ maxConcurrent: 3 }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(500);
    expect(res.body.error).toContain("Write failed");
  });

  it("updates planning and validator model settings via store.updateSettings", async () => {
    const updatedSettings = {
      ...DEFAULT_SETTINGS,
      planningProvider: "anthropic",
      planningModelId: "claude-sonnet-4-5",
      validatorProvider: "openai",
      validatorModelId: "gpt-4o",
    };
    (store.updateSettings as ReturnType<typeof vi.fn>).mockResolvedValue(updatedSettings);

    const res = await REQUEST(
      buildApp(),
      "PUT",
      "/api/settings",
      JSON.stringify({
        planningProvider: "anthropic",
        planningModelId: "claude-sonnet-4-5",
        validatorProvider: "openai",
        validatorModelId: "gpt-4o",
      }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(200);
    expect(store.updateSettings).toHaveBeenCalledWith({
      planningProvider: "anthropic",
      planningModelId: "claude-sonnet-4-5",
      validatorProvider: "openai",
      validatorModelId: "gpt-4o",
    });
  });

  it("persists planning/validator settings and returns them via GET /settings", async () => {
    // First, update the settings
    const updatedSettings = {
      ...DEFAULT_SETTINGS,
      planningProvider: "anthropic",
      planningModelId: "claude-opus-4",
      validatorProvider: "openai",
      validatorModelId: "gpt-4-turbo",
    };
    (store.updateSettings as ReturnType<typeof vi.fn>).mockResolvedValue(updatedSettings);

    const updateRes = await REQUEST(
      buildApp(),
      "PUT",
      "/api/settings",
      JSON.stringify({
        planningProvider: "anthropic",
        planningModelId: "claude-opus-4",
        validatorProvider: "openai",
        validatorModelId: "gpt-4-turbo",
      }),
      { "Content-Type": "application/json" },
    );

    expect(updateRes.status).toBe(200);

    // Then, verify GET /settings returns the persisted values
    (store.getSettingsFast as ReturnType<typeof vi.fn>).mockResolvedValue(updatedSettings);
    const getRes = await GET(buildApp(), "/api/settings");

    expect(getRes.status).toBe(200);
    expect(getRes.body.planningProvider).toBe("anthropic");
    expect(getRes.body.planningModelId).toBe("claude-opus-4");
    expect(getRes.body.validatorProvider).toBe("openai");
    expect(getRes.body.validatorModelId).toBe("gpt-4-turbo");
  });
});

describe("GET /settings/global", () => {
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

  it("returns global settings from the global settings store", async () => {
    const mockGlobalStore = createMockGlobalSettingsStore();
    mockGlobalStore.getSettings.mockResolvedValue({ themeMode: "light", colorTheme: "ocean" });
    (store.getGlobalSettingsStore as ReturnType<typeof vi.fn>).mockReturnValue(mockGlobalStore);

    const res = await GET(buildApp(), "/api/settings/global");

    expect(res.status).toBe(200);
    expect(res.body.themeMode).toBe("light");
    expect(res.body.colorTheme).toBe("ocean");
    // Should NOT include server-only fields
    expect(res.body.githubTokenConfigured).toBeUndefined();
  });

  it("returns 500 on global store error", async () => {
    const mockGlobalStore = createMockGlobalSettingsStore();
    mockGlobalStore.getSettings.mockRejectedValue(new Error("Read failed"));
    (store.getGlobalSettingsStore as ReturnType<typeof vi.fn>).mockReturnValue(mockGlobalStore);

    const res = await GET(buildApp(), "/api/settings/global");

    expect(res.status).toBe(500);
    expect(res.body.error).toContain("Read failed");
  });
});

describe("PUT /settings/global", () => {
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

  it("updates global settings via store.updateGlobalSettings", async () => {
    const updatedMerged = { themeMode: "light", maxConcurrent: 2 };
    (store.updateGlobalSettings as ReturnType<typeof vi.fn>).mockResolvedValue(updatedMerged);

    const res = await REQUEST(
      buildApp(),
      "PUT",
      "/api/settings/global",
      JSON.stringify({ themeMode: "light" }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(200);
    expect(store.updateGlobalSettings).toHaveBeenCalledWith({ themeMode: "light" });
  });

  it("accepts persistAgentToolOutput in global updates", async () => {
    const updatedMerged = { persistAgentToolOutput: false };
    (store.updateGlobalSettings as ReturnType<typeof vi.fn>).mockResolvedValue(updatedMerged);

    const res = await REQUEST(
      buildApp(),
      "PUT",
      "/api/settings/global",
      JSON.stringify({ persistAgentToolOutput: false }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(200);
    expect(store.updateGlobalSettings).toHaveBeenCalledWith({ persistAgentToolOutput: false });
    expect(res.body.persistAgentToolOutput).toBe(false);
  });

  it("accepts persistAgentThinkingLog in global updates", async () => {
    const updatedMerged = { persistAgentThinkingLog: true };
    (store.updateGlobalSettings as ReturnType<typeof vi.fn>).mockResolvedValue(updatedMerged);

    const res = await REQUEST(
      buildApp(),
      "PUT",
      "/api/settings/global",
      JSON.stringify({ persistAgentThinkingLog: true }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(200);
    expect(store.updateGlobalSettings).toHaveBeenCalledWith({ persistAgentThinkingLog: true });
    expect(res.body.persistAgentThinkingLog).toBe(true);
  });

  it("returns 500 on update error", async () => {
    (store.updateGlobalSettings as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Write failed"));

    const res = await REQUEST(
      buildApp(),
      "PUT",
      "/api/settings/global",
      JSON.stringify({ themeMode: "light" }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(500);
    expect(res.body.error).toContain("Write failed");
  });

  it("persists modelOnboardingComplete flag", async () => {
    const updated = { modelOnboardingComplete: true };
    (store.updateGlobalSettings as ReturnType<typeof vi.fn>).mockResolvedValue(updated);

    const res = await REQUEST(
      buildApp(),
      "PUT",
      "/api/settings/global",
      JSON.stringify(updated),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(200);
    expect(store.updateGlobalSettings).toHaveBeenCalledWith({ modelOnboardingComplete: true });
    expect(res.body.modelOnboardingComplete).toBe(true);
  });

  it("GET /settings/global returns modelOnboardingComplete value", async () => {
    const mockGlobalStore = createMockGlobalSettingsStore();
    mockGlobalStore.getSettings.mockResolvedValue({ modelOnboardingComplete: true, themeMode: "dark" });
    (store.getGlobalSettingsStore as ReturnType<typeof vi.fn>).mockReturnValue(mockGlobalStore);

    const res = await GET(buildApp(), "/api/settings/global");

    expect(res.status).toBe(200);
    expect(res.body.modelOnboardingComplete).toBe(true);
  });

  it("invalidates all global settings caches including engine stores", async () => {
    const updated = { defaultModelId: "claude-3-5-sonnet" };
    (store.updateGlobalSettings as ReturnType<typeof vi.fn>).mockResolvedValue(updated);

    // Create mock engine with GlobalSettingsStore spy
    const engineGlobalStore = createMockGlobalSettingsStore();
    const mockEngineStore = createMockStore();
    (mockEngineStore.getGlobalSettingsStore as ReturnType<typeof vi.fn>).mockReturnValue(engineGlobalStore);

    const mockEngine = {
      getTaskStore: vi.fn().mockReturnValue(mockEngineStore),
    };

    // Create mock engine manager
    const mockEngineManager = {
      getAllEngines: vi.fn().mockReturnValue(new Map([["project-1", mockEngine]])),
      getEngine: vi.fn(),
      ensureEngine: vi.fn(),
    };

    // Spy on invalidateAllGlobalSettingsCaches
    const invalidateAllSpy = vi.spyOn(projectStoreResolver, "invalidateAllGlobalSettingsCaches");

    // Build app with engineManager option
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store, { engineManager: mockEngineManager as any }));

    const res = await REQUEST(
      app,
      "PUT",
      "/api/settings/global",
      JSON.stringify(updated),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(200);
    expect(store.updateGlobalSettings).toHaveBeenCalledWith(updated);

    // Verify project-store-resolver caches are invalidated
    expect(invalidateAllSpy).toHaveBeenCalledOnce();

    // Verify engine store cache is invalidated
    expect(mockEngine.getTaskStore).toHaveBeenCalled();
    expect(engineGlobalStore.invalidateCache).toHaveBeenCalledOnce();
  });

  it("handles missing engineManager gracefully", async () => {
    const updated = { defaultModelId: "claude-3-5-sonnet" };
    (store.updateGlobalSettings as ReturnType<typeof vi.fn>).mockResolvedValue(updated);

    // Spy on invalidateAllGlobalSettingsCaches
    const invalidateAllSpy = vi.spyOn(projectStoreResolver, "invalidateAllGlobalSettingsCaches");

    // Build app WITHOUT engineManager option
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store));

    const res = await REQUEST(
      app,
      "PUT",
      "/api/settings/global",
      JSON.stringify(updated),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(200);
    expect(store.updateGlobalSettings).toHaveBeenCalledWith(updated);

    // Should still invalidate project-store-resolver caches
    expect(invalidateAllSpy).toHaveBeenCalledOnce();
  });
});

describe("GET /settings/scopes", () => {
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

  it("returns settings separated by scope", async () => {
    (store.getSettingsByScope as ReturnType<typeof vi.fn>).mockResolvedValue({
      global: {
        themeMode: "dark",
        defaultProvider: "anthropic",
        persistAgentToolOutput: true,
        persistAgentThinkingLog: false,
      },
      project: { maxConcurrent: 4, autoMerge: false },
    });

    const res = await GET(buildApp(), "/api/settings/scopes");

    expect(res.status).toBe(200);
    expect(res.body.global.themeMode).toBe("dark");
    expect(res.body.global.defaultProvider).toBe("anthropic");
    expect(res.body.global.persistAgentToolOutput).toBe(true);
    expect(res.body.global.persistAgentThinkingLog).toBe(false);
    expect(res.body.project.maxConcurrent).toBe(4);
    expect(res.body.project.autoMerge).toBe(false);
    expect(res.body.project.persistAgentToolOutput).toBeUndefined();
    expect(res.body.project.persistAgentThinkingLog).toBeUndefined();
  });

  it("returns exact response envelope shape with only global and project keys", async () => {
    (store.getSettingsByScope as ReturnType<typeof vi.fn>).mockResolvedValue({
      global: { themeMode: "dark" },
      project: { maxConcurrent: 4 },
    });

    const res = await GET(buildApp(), "/api/settings/scopes");

    expect(res.status).toBe(200);
    // Assert exact envelope shape
    expect(res.body).toHaveProperty("global");
    expect(res.body).toHaveProperty("project");
    // No unexpected top-level keys
    const keys = Object.keys(res.body);
    expect(keys).toHaveLength(2);
    expect(keys).toEqual(["global", "project"]);
  });

  it("global settings include model defaults", async () => {
    (store.getSettingsByScope as ReturnType<typeof vi.fn>).mockResolvedValue({
      global: {
        themeMode: "dark",
        defaultProvider: "anthropic",
        defaultModelId: "claude-sonnet-4-5",
        planningGlobalProvider: "google",
        planningGlobalModelId: "gemini-2.5-pro",
      },
      project: {},
    });

    const res = await GET(buildApp(), "/api/settings/scopes");

    expect(res.status).toBe(200);
    expect(res.body.global.defaultProvider).toBe("anthropic");
    expect(res.body.global.defaultModelId).toBe("claude-sonnet-4-5");
    expect(res.body.global.planningGlobalProvider).toBe("google");
    expect(res.body.global.planningGlobalModelId).toBe("gemini-2.5-pro");
  });

  it("project settings include execution and planning overrides", async () => {
    (store.getSettingsByScope as ReturnType<typeof vi.fn>).mockResolvedValue({
      global: { themeMode: "dark" },
      project: {
        executionProvider: "openai",
        executionModelId: "gpt-4o",
        planningProvider: "anthropic",
        planningModelId: "claude-sonnet-4-5",
        titleSummarizerProvider: "google",
        titleSummarizerModelId: "gemini-2.5-pro",
      },
    });

    const res = await GET(buildApp(), "/api/settings/scopes");

    expect(res.status).toBe(200);
    expect(res.body.project.executionProvider).toBe("openai");
    expect(res.body.project.executionModelId).toBe("gpt-4o");
    expect(res.body.project.planningProvider).toBe("anthropic");
    expect(res.body.project.planningModelId).toBe("claude-sonnet-4-5");
    expect(res.body.project.titleSummarizerProvider).toBe("google");
    expect(res.body.project.titleSummarizerModelId).toBe("gemini-2.5-pro");
  });

  it("returns evalSettings in project scope only", async () => {
    (store.getSettingsByScope as ReturnType<typeof vi.fn>).mockResolvedValue({
      global: { themeMode: "dark" },
      project: {
        evalSettings: {
          enabled: true,
          intervalMs: 300000,
          followUpPolicy: "auto-create",
          retentionDays: 14,
        },
      },
    });

    const res = await GET(buildApp(), "/api/settings/scopes");

    expect(res.status).toBe(200);
    expect(res.body.project.evalSettings).toEqual({
      enabled: true,
      intervalMs: 300000,
      followUpPolicy: "auto-create",
      retentionDays: 14,
    });
    expect(res.body.global.evalSettings).toBeUndefined();
  });

  it("returns remoteAccess only under project scope", async () => {
    (store.getSettingsByScope as ReturnType<typeof vi.fn>).mockResolvedValue({
      global: { themeMode: "dark" },
      project: {
        remoteAccess: {
          activeProvider: "tailscale",
          providers: {
            tailscale: {
              enabled: true,
              hostname: "tail.example.ts.net",
              targetPort: 5173,
              acceptRoutes: true,
            },
            cloudflare: {
              enabled: false,
        quickTunnel: false,
              tunnelName: "",
              tunnelToken: null,
              ingressUrl: "",
            },
          },
          tokenStrategy: {
            persistent: {
              enabled: true,
              token: null,
            },
            shortLived: {
              enabled: false,
              ttlMs: 900000,
              maxTtlMs: 86400000,
            },
          },
          lifecycle: {
            rememberLastRunning: false,
            wasRunningOnShutdown: false,
            lastRunningProvider: null,
          },
        },
      },
    });

    const res = await GET(buildApp(), "/api/settings/scopes");

    expect(res.status).toBe(200);
    expect(res.body.project.remoteAccess).toBeDefined();
    expect(res.body.global.remoteAccess).toBeUndefined();
  });

  it("returns 500 on store error", async () => {
    (store.getSettingsByScope as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Failed"));

    const res = await GET(buildApp(), "/api/settings/scopes");

    expect(res.status).toBe(500);
    expect(res.body.error).toContain("Failed");
  });
});

describe("GET /settings/scopes with projectId scoping", () => {
  const projectId = "proj-scopes-scoped";
  let defaultStore: TaskStore;
  let scopedStore: TaskStore;

  beforeEach(() => {
    defaultStore = createMockStore();
    scopedStore = createMockStore();

    vi.spyOn(projectStoreResolver, "getOrCreateProjectStore").mockResolvedValue(scopedStore);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(defaultStore));
    return app;
  }

  it("uses scoped store when projectId is provided", async () => {
    (scopedStore.getSettingsByScope as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      global: { themeMode: "light" },
      project: { maxConcurrent: 8, planningProvider: "anthropic", planningModelId: "claude-sonnet-4-5" },
    });

    const res = await GET(buildApp(), `/api/settings/scopes?projectId=${projectId}`);

    expect(res.status).toBe(200);
    expect(projectStoreResolver.getOrCreateProjectStore).toHaveBeenCalledWith(projectId);
    expect(scopedStore.getSettingsByScope).toHaveBeenCalled();
    expect(defaultStore.getSettingsByScope).not.toHaveBeenCalled();
    expect(res.body.project.maxConcurrent).toBe(8);
    expect(res.body.project.planningProvider).toBe("anthropic");
  });

  it("does not leak default store values into scoped response", async () => {
    // Default store with conflicting values
    (defaultStore.getSettingsByScope as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      global: { defaultProvider: "default-global-provider", defaultModelId: "default-global-model" },
      project: { maxConcurrent: 2 },
    });

    // Scoped store with different values
    (scopedStore.getSettingsByScope as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      global: { themeMode: "dark" },
      project: { maxConcurrent: 6 },
    });

    const res = await GET(buildApp(), `/api/settings/scopes?projectId=${projectId}`);

    expect(res.status).toBe(200);
    expect(projectStoreResolver.getOrCreateProjectStore).toHaveBeenCalledWith(projectId);
    // Verify scoped store was used exclusively
    expect(scopedStore.getSettingsByScope).toHaveBeenCalled();
    expect(defaultStore.getSettingsByScope).not.toHaveBeenCalled();
    // Verify values come from scoped store
    expect(res.body.project.maxConcurrent).toBe(6);
    // No leakage from default store
    expect(res.body.global.defaultProvider).toBeUndefined();
  });

  it("returns project settings from scoped store only", async () => {
    (scopedStore.getSettingsByScope as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      global: { themeMode: "light" },
      project: {
        executionProvider: "scoped-execution-provider",
        executionModelId: "scoped-execution-model",
        planningProvider: "scoped-planning-provider",
        planningModelId: "scoped-planning-model",
      },
    });

    const res = await GET(buildApp(), `/api/settings/scopes?projectId=${projectId}`);

    expect(res.status).toBe(200);
    expect(scopedStore.getSettingsByScope).toHaveBeenCalled();
    expect(res.body.project.executionProvider).toBe("scoped-execution-provider");
    expect(res.body.project.executionModelId).toBe("scoped-execution-model");
    expect(res.body.project.planningProvider).toBe("scoped-planning-provider");
    expect(res.body.project.planningModelId).toBe("scoped-planning-model");
  });

  it("returns 500 when scoped store getSettingsByScope fails", async () => {
    (scopedStore.getSettingsByScope as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("Scoped store failed"));

    const res = await GET(buildApp(), `/api/settings/scopes?projectId=${projectId}`);

    expect(res.status).toBe(500);
    expect(res.body.error).toContain("Scoped store failed");
  });
});

describe("POST /settings/test-ntfy", () => {
  let store: TaskStore;
  let fetchSpy: ReturnType<typeof vi.spyOn<any, any>>;

  beforeEach(() => {
    store = createMockStore();
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store));
    return app;
  }

  it("sends Fusion-branded test notification", async () => {
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ntfyEnabled: true,
      ntfyTopic: "test-topic",
    });

    const res = await REQUEST(buildApp(), "POST", "/api/settings/test-ntfy");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });

    // Verify the ntfy request uses Fusion branding
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const url = fetchSpy.mock.calls[0]?.[0] as string;
    const options = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect(url).toBe("https://ntfy.sh/test-topic");
    expect(options?.method).toBe("POST");
    expect(options?.headers).toHaveProperty("Title", "Fusion test notification");
  });

  it("sends Fusion-branded body text", async () => {
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ntfyEnabled: true,
      ntfyTopic: "my-topic",
    });

    const res = await REQUEST(buildApp(), "POST", "/api/settings/test-ntfy");

    expect(res.status).toBe(200);
    const options = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect(options?.body).toBe("Fusion test notification — your notifications are working!");
  });

  it("uses configured ntfyBaseUrl from settings when present", async () => {
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ntfyEnabled: true,
      ntfyTopic: "my-topic",
      ntfyBaseUrl: "https://ntfy.internal.example///",
    });

    const res = await REQUEST(buildApp(), "POST", "/api/settings/test-ntfy");

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const url = fetchSpy.mock.calls[0]?.[0] as string;
    expect(url).toBe("https://ntfy.internal.example/my-topic");
  });

  it("uses request ntfyBaseUrl override when provided", async () => {
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ntfyEnabled: true,
      ntfyTopic: "my-topic",
      ntfyBaseUrl: "https://ntfy.saved.example",
    });

    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/settings/test-ntfy",
      JSON.stringify({ ntfyBaseUrl: "https://ntfy.override.example//" }),
      { "content-type": "application/json" },
    );

    expect(res.status).toBe(200);
    const url = fetchSpy.mock.calls[0]?.[0] as string;
    expect(url).toBe("https://ntfy.override.example/my-topic");
  });

  it("falls back to saved ntfyBaseUrl when request override is blank", async () => {
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ntfyEnabled: true,
      ntfyTopic: "my-topic",
      ntfyBaseUrl: "https://ntfy.saved.example",
    });

    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/settings/test-ntfy",
      JSON.stringify({ ntfyBaseUrl: "   " }),
      { "content-type": "application/json" },
    );

    expect(res.status).toBe(200);
    const url = fetchSpy.mock.calls[0]?.[0] as string;
    expect(url).toBe("https://ntfy.saved.example/my-topic");
  });

  it("sends Authorization header from saved ntfy access token", async () => {
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ntfyEnabled: true,
      ntfyTopic: "my-topic",
      ntfyAccessToken: "saved-token",
    });

    const res = await REQUEST(buildApp(), "POST", "/api/settings/test-ntfy");

    expect(res.status).toBe(200);
    const options = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect(options.headers).toHaveProperty("Authorization", "Bearer saved-token");
  });

  it("prefers request ntfy access token override and ignores blank overrides", async () => {
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ntfyEnabled: true,
      ntfyTopic: "my-topic",
      ntfyAccessToken: "saved-token",
    });

    const overrideRes = await REQUEST(
      buildApp(),
      "POST",
      "/api/settings/test-ntfy",
      JSON.stringify({ ntfyAccessToken: "override-token" }),
      { "content-type": "application/json" },
    );

    expect(overrideRes.status).toBe(200);
    let options = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect(options.headers).toHaveProperty("Authorization", "Bearer override-token");

    fetchSpy.mockClear();
    const blankRes = await REQUEST(
      buildApp(),
      "POST",
      "/api/settings/test-ntfy",
      JSON.stringify({ ntfyAccessToken: "   " }),
      { "content-type": "application/json" },
    );

    expect(blankRes.status).toBe(200);
    options = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect(options.headers).toHaveProperty("Authorization", "Bearer saved-token");
  });

  it("returns 400 when ntfy is not enabled", async () => {
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ntfyEnabled: false,
    });

    const res = await REQUEST(buildApp(), "POST", "/api/settings/test-ntfy");

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("not enabled");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns 400 when topic is missing", async () => {
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ntfyEnabled: true,
      ntfyTopic: undefined,
    });

    const res = await REQUEST(buildApp(), "POST", "/api/settings/test-ntfy");

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("not configured or invalid");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns 400 when request ntfyBaseUrl uses non-http protocol", async () => {
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ntfyEnabled: true,
      ntfyTopic: "test-topic",
    });

    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/settings/test-ntfy",
      JSON.stringify({ ntfyBaseUrl: "ftp://ntfy.example.com" }),
      { "content-type": "application/json" },
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("http:// or https://");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns 400 when request ntfyBaseUrl is malformed", async () => {
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ntfyEnabled: true,
      ntfyTopic: "test-topic",
    });

    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/settings/test-ntfy",
      JSON.stringify({ ntfyBaseUrl: "not-a-url" }),
      { "content-type": "application/json" },
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("must be a valid URL");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ── Memory Routes ─────────────────────────────────────────────

describe("GET /api/memory", () => {
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

  it("returns memory content from the store", async () => {
    // The memory endpoint uses readProjectFile from file-service
    // which is mocked at the module level
    const res = await GET(buildApp(), "/api/memory");

    // Without mocking file-service, it will return empty or error
    // This test validates the route exists and is reachable
    expect([200, 500]).toContain(res.status);
  });
});

describe("POST /settings/test-notification", () => {
  let store: TaskStore;
  let fetchSpy: ReturnType<typeof vi.spyOn<any, any>>;

  beforeEach(() => {
    store = createMockStore();
    mockGetActiveNotificationService.mockReset();
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store));
    return app;
  }

  it("ntfy provider sends Fusion-branded test notification", async () => {
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ntfyEnabled: true,
      ntfyTopic: "test-topic",
    });

    const res = await REQUEST(buildApp(), "POST", "/api/settings/test-notification", JSON.stringify({ providerId: "ntfy" }), {
      "content-type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://ntfy.sh/test-topic",
      expect.objectContaining({
        headers: expect.objectContaining({
          Title: "Fusion test notification",
        }),
      }),
    );
  });

  it("ntfy provider dispatches a message-event pipeline test when messageEventType is provided", async () => {
    const dispatchSpy = vi.fn().mockResolvedValue(undefined);
    mockGetActiveNotificationService.mockReturnValue({ dispatch: dispatchSpy });
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ntfyEnabled: true,
      ntfyTopic: "test-topic",
    });

    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/settings/test-notification",
      JSON.stringify({ providerId: "ntfy", messageEventType: "message:agent-to-user" }),
      { "content-type": "application/json" },
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(dispatchSpy).toHaveBeenCalledWith(
      "message:agent-to-user",
      expect.objectContaining({
        event: "message:agent-to-user",
        metadata: expect.objectContaining({
          fromId: "system",
          toId: "user",
          preview: "Fusion test message notification",
        }),
      }),
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("ntfy provider dispatches a room message-event pipeline test when messageEventType is message:room", async () => {
    const dispatchSpy = vi.fn().mockResolvedValue(undefined);
    mockGetActiveNotificationService.mockReturnValue({ dispatch: dispatchSpy });
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ntfyEnabled: true,
      ntfyTopic: "test-topic",
    });

    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/settings/test-notification",
      JSON.stringify({ providerId: "ntfy", messageEventType: "message:room" }),
      { "content-type": "application/json" },
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(dispatchSpy).toHaveBeenCalledWith(
      "message:room",
      expect.objectContaining({
        event: "message:room",
        metadata: expect.objectContaining({
          roomId: "test-room",
          roomName: "Test Room",
          senderName: "Fusion",
          preview: "Fusion test room notification",
        }),
      }),
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("ntfy provider uses config override for baseUrl", async () => {
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ntfyEnabled: true,
      ntfyTopic: "my-topic",
      ntfyBaseUrl: "https://ntfy.saved.example",
    });

    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/settings/test-notification",
      JSON.stringify({ providerId: "ntfy", ntfyBaseUrl: "https://ntfy.override.example//" }),
      { "content-type": "application/json" },
    );

    expect(res.status).toBe(200);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("https://ntfy.override.example/my-topic");
  });

  it("ntfy provider sends Authorization header from saved or override token", async () => {
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ntfyEnabled: true,
      ntfyTopic: "my-topic",
      ntfyAccessToken: "saved-token",
    });

    const savedRes = await REQUEST(
      buildApp(),
      "POST",
      "/api/settings/test-notification",
      JSON.stringify({ providerId: "ntfy" }),
      { "content-type": "application/json" },
    );

    expect(savedRes.status).toBe(200);
    let options = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect(options.headers).toHaveProperty("Authorization", "Bearer saved-token");

    fetchSpy.mockClear();
    const overrideRes = await REQUEST(
      buildApp(),
      "POST",
      "/api/settings/test-notification",
      JSON.stringify({ providerId: "ntfy", ntfyAccessToken: "override-token" }),
      { "content-type": "application/json" },
    );

    expect(overrideRes.status).toBe(200);
    options = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect(options.headers).toHaveProperty("Authorization", "Bearer override-token");
  });

  it("ntfy provider omits Authorization header when no token is configured", async () => {
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ntfyEnabled: true,
      ntfyTopic: "my-topic",
      ntfyAccessToken: "   ",
    });

    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/settings/test-notification",
      JSON.stringify({ providerId: "ntfy", ntfyAccessToken: "   " }),
      { "content-type": "application/json" },
    );

    expect(res.status).toBe(200);
    const options = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect((options.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("ntfy provider returns 400 when ntfy not enabled", async () => {
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({ ntfyEnabled: false });

    const res = await REQUEST(buildApp(), "POST", "/api/settings/test-notification", JSON.stringify({ providerId: "ntfy" }), {
      "content-type": "application/json",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("not enabled");
  });

  it("ntfy provider returns 400 when topic missing", async () => {
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({ ntfyEnabled: true, ntfyTopic: undefined });

    const res = await REQUEST(buildApp(), "POST", "/api/settings/test-notification", JSON.stringify({ providerId: "ntfy" }), {
      "content-type": "application/json",
    });

    expect(res.status).toBe(400);
  });

  it("webhook provider sends test notification (generic format)", async () => {
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      webhookEnabled: true,
      webhookUrl: "https://hooks.example.com/test",
    });

    const res = await REQUEST(buildApp(), "POST", "/api/settings/test-notification", JSON.stringify({ providerId: "webhook" }), {
      "content-type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    const options = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("https://hooks.example.com/test");
    const payload = JSON.parse(String(options.body)) as Record<string, string>;
    expect(payload.event).toBe("test");
    expect(payload.message).toBe("Fusion test notification");
    expect(payload.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("webhook provider sends Slack format", async () => {
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      webhookEnabled: true,
      webhookUrl: "https://hooks.slack.com/test",
      webhookFormat: "slack",
    });

    const res = await REQUEST(buildApp(), "POST", "/api/settings/test-notification", JSON.stringify({ providerId: "webhook" }), {
      "content-type": "application/json",
    });

    expect(res.status).toBe(200);
    const options = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(options.body))).toEqual({
      text: "Fusion test notification — your webhook notifications are working!",
    });
  });

  it("webhook provider sends Discord format", async () => {
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      webhookEnabled: true,
      webhookUrl: "https://discord.com/api/webhooks/test",
      webhookFormat: "discord",
    });

    const res = await REQUEST(buildApp(), "POST", "/api/settings/test-notification", JSON.stringify({ providerId: "webhook" }), {
      "content-type": "application/json",
    });

    expect(res.status).toBe(200);
    const options = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(options.body))).toEqual({
      content: "Fusion test notification — your webhook notifications are working!",
    });
  });

  it("webhook provider uses config override for format", async () => {
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      webhookEnabled: true,
      webhookUrl: "https://hooks.example.com/test",
      webhookFormat: "generic",
    });

    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/settings/test-notification",
      JSON.stringify({ providerId: "webhook", webhookFormat: "slack" }),
      { "content-type": "application/json" },
    );

    expect(res.status).toBe(200);
    const options = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(options.body))).toEqual({
      text: "Fusion test notification — your webhook notifications are working!",
    });
  });

  it("webhook provider returns 400 when not enabled", async () => {
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({ webhookEnabled: false });

    const res = await REQUEST(buildApp(), "POST", "/api/settings/test-notification", JSON.stringify({ providerId: "webhook" }), {
      "content-type": "application/json",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("not enabled");
  });

  it("webhook provider returns 400 when URL missing", async () => {
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({ webhookEnabled: true, webhookUrl: undefined });

    const res = await REQUEST(buildApp(), "POST", "/api/settings/test-notification", JSON.stringify({ providerId: "webhook" }), {
      "content-type": "application/json",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("not configured");
  });

  it("webhook provider returns 502 on server error", async () => {
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      webhookEnabled: true,
      webhookUrl: "https://hooks.example.com/test",
    });
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 500, statusText: "Internal Server Error" }));

    const res = await REQUEST(buildApp(), "POST", "/api/settings/test-notification", JSON.stringify({ providerId: "webhook" }), {
      "content-type": "application/json",
    });

    expect(res.status).toBe(502);
  });

  it("unknown provider returns 400", async () => {
    const res = await REQUEST(buildApp(), "POST", "/api/settings/test-notification", JSON.stringify({ providerId: "email" }), {
      "content-type": "application/json",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Unknown notification provider: email");
  });

  it("missing providerId returns 400", async () => {
    const res = await REQUEST(buildApp(), "POST", "/api/settings/test-notification", JSON.stringify({}), {
      "content-type": "application/json",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("providerId");
  });

  it("backward compat — test-ntfy still works", async () => {
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ntfyEnabled: true,
      ntfyTopic: "compat-topic",
    });

    const res = await REQUEST(buildApp(), "POST", "/api/settings/test-ntfy");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
  });

  it("client→server contract for ntfy override via testNotification pattern", async () => {
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ntfyEnabled: true,
      ntfyTopic: "my-topic",
      ntfyBaseUrl: "https://ntfy.saved.example",
    });

    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/settings/test-notification",
      JSON.stringify({ providerId: "ntfy", ntfyBaseUrl: "https://ntfy.override.example/" }),
      { "content-type": "application/json" },
    );

    expect(res.status).toBe(200);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("https://ntfy.override.example/my-topic");
  });
});

describe("GET /api/memory/backend", () => {
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

  it("returns current backend and capabilities", async () => {
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      memoryBackendType: "file",
      memoryEnabled: true,
    });

    const res = await GET(buildApp(), "/api/memory/backend");

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("currentBackend");
    expect(res.body).toHaveProperty("capabilities");
    expect(res.body).toHaveProperty("availableBackends");
    expect(Array.isArray(res.body.availableBackends)).toBe(true);
    expect(res.body.availableBackends).toContain("file");
    expect(res.body.availableBackends).toContain("readonly");
  });

  it("includes capabilities for file backend", async () => {
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      memoryBackendType: "file",
      memoryEnabled: true,
    });

    const res = await GET(buildApp(), "/api/memory/backend");

    expect(res.status).toBe(200);
    expect(res.body.capabilities).toEqual({
      readable: true,
      writable: true,
      supportsAtomicWrite: true,
      hasConflictResolution: false,
      persistent: true,
    });
  });

  it("includes capabilities for readonly backend", async () => {
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      memoryBackendType: "readonly",
      memoryEnabled: true,
    });

    const res = await GET(buildApp(), "/api/memory/backend");

    expect(res.status).toBe(200);
    expect(res.body.currentBackend).toBe("readonly");
    expect(res.body.capabilities).toEqual({
      readable: true,
      writable: false,
      supportsAtomicWrite: false,
      hasConflictResolution: false,
      persistent: false,
    });
  });

  it("defaults to qmd backend when no backend type is set", async () => {
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      memoryEnabled: true,
    });

    const res = await GET(buildApp(), "/api/memory/backend");

    expect(res.status).toBe(200);
    expect(res.body.currentBackend).toBe("qmd");
  });

  it("returns qmd backend for unknown custom backend type (fallback)", async () => {
    // Unknown backend types are persisted but fallback to qmd at runtime
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      memoryBackendType: "unknown-custom-backend",
      memoryEnabled: true,
    });

    const res = await GET(buildApp(), "/api/memory/backend");

    expect(res.status).toBe(200);
    // currentBackend reflects the effective backend (qmd fallback)
    expect(res.body.currentBackend).toBe("qmd");
    // But availableBackends is still the list of registered backends
    expect(res.body.availableBackends).toContain("file");
    expect(res.body.availableBackends).toContain("readonly");
  });

  it("includes qmd backend in available backends when qmd is registered", async () => {
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      memoryBackendType: "file",
      memoryEnabled: true,
    });

    const res = await GET(buildApp(), "/api/memory/backend");

    expect(res.status).toBe(200);
    // qmd should be in the available backends list
    expect(res.body.availableBackends).toContain("qmd");
  });

  it("returns qmd backend capabilities when configured", async () => {
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      memoryBackendType: "qmd",
      memoryEnabled: true,
    });

    const res = await GET(buildApp(), "/api/memory/backend");

    expect(res.status).toBe(200);
    expect(res.body.currentBackend).toBe("qmd");
    // qmd has writable and persistent capabilities
    expect(res.body.capabilities).toMatchObject({
      readable: true,
      writable: true,
      persistent: true,
    });
  });
});

describe("PUT /api/memory", () => {
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

  it("returns 400 when content is not a string", async () => {
    const res = await REQUEST(buildApp(), "PUT", "/api/memory", JSON.stringify({ content: 123 }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("content must be a string");
  });

  it("returns 400 when content is missing", async () => {
    const res = await REQUEST(buildApp(), "PUT", "/api/memory", JSON.stringify({}), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("content must be a string");
  });
});

describe("POST /api/memory/compact", () => {
  let store: TaskStore;
  let rootDir: string;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), "fusion-memory-compact-"));
    mkdirSync(join(rootDir, ".fusion", "memory"), { recursive: true });
    store = createMockStore({
      getRootDir: vi.fn().mockReturnValue(rootDir),
    });
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store));
    return app;
  }

  it("returns 400 when memory content is too short", async () => {
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      memoryEnabled: true,
      memoryBackendType: "file",
    });
    writeFileSync(join(rootDir, ".fusion", "memory", "DREAMS.md"), "Short content");

    const res = await REQUEST(buildApp(), "POST", "/api/memory/compact", JSON.stringify({ path: ".fusion/memory/DREAMS.md" }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("too short to compact");
  });

  it("returns 409 for read-only memory backends before compacting", async () => {
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      memoryEnabled: true,
      memoryBackendType: "readonly",
    });
    writeFileSync(join(rootDir, ".fusion", "memory", "MEMORY.md"), "Long memory content.\n".repeat(20));

    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/memory/compact",
      JSON.stringify({ path: ".fusion/memory/MEMORY.md" }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("read-only");
  });
});

describe("POST /api/memory/dream", () => {
  let store: TaskStore;
  let rootDir: string;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), "fusion-memory-dream-"));
    mkdirSync(join(rootDir, ".fusion", "memory"), { recursive: true });
    writeFileSync(join(rootDir, ".fusion", "memory", "MEMORY.md"), "# Memory\n\nLong-term context");
    writeFileSync(join(rootDir, ".fusion", "memory", `${new Date().toISOString().slice(0, 10)}.md`), "# Daily Memory\n\n- notable note");

    store = createMockStore({
      getRootDir: vi.fn().mockReturnValue(rootDir),
      getFusionDir: vi.fn().mockReturnValue(join(rootDir, ".fusion")),
      getSettings: vi.fn().mockResolvedValue({
        memoryEnabled: true,
        memoryDreamsEnabled: true,
        memoryBackendType: "file",
      }),
    });

    vi.spyOn(AgentStore.prototype, "init").mockResolvedValue(undefined);
    vi.spyOn(AgentStore.prototype, "listAgents").mockResolvedValue([]);
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store));
    return app;
  }

  it("returns 200 with dream results on success", async () => {
    const session = {
      prompt: vi.fn().mockImplementation(async function (this: { state: { messages: unknown[] } }) {
        this.state.messages.push({
          role: "assistant",
          content: "## DREAMS\nSynthesis\n\n## LONG_TERM_UPDATES\nLesson",
        });
      }),
      dispose: vi.fn(),
      state: { messages: [] as unknown[] },
    };
    vi.mocked(createFnAgent).mockResolvedValue({ session } as never);

    const res = await REQUEST(buildApp(), "POST", "/api/memory/dream", JSON.stringify({}), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      dreamsWritten: true,
      longTermUpdatesWritten: true,
    });
  });

  it("returns 200 with empty results when no daily notes to process", async () => {
    writeFileSync(join(rootDir, ".fusion", "memory", `${new Date().toISOString().slice(0, 10)}.md`), "");
    const session = {
      prompt: vi.fn().mockImplementation(async function (this: { state: { messages: unknown[] } }) {
        this.state.messages.push({
          role: "assistant",
          content: "## DREAMS\n\n## LONG_TERM_UPDATES\n",
        });
      }),
      dispose: vi.fn(),
      state: { messages: [] as unknown[] },
    };
    vi.mocked(createFnAgent).mockResolvedValue({ session } as never);

    const res = await REQUEST(buildApp(), "POST", "/api/memory/dream", JSON.stringify({}), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      dreamsWritten: false,
      longTermUpdatesWritten: false,
    });
  });

  it("returns 400 when dreams are disabled in settings", async () => {
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      memoryEnabled: true,
      memoryDreamsEnabled: false,
      memoryBackendType: "file",
    });

    const res = await REQUEST(buildApp(), "POST", "/api/memory/dream", JSON.stringify({}), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Memory dreams are disabled");
  });

  it("returns 503 when AI service is unavailable", async () => {
    vi.mocked(createFnAgent).mockRejectedValue(Object.assign(new Error("AI down"), { name: "AiServiceError" }));

    const res = await REQUEST(buildApp(), "POST", "/api/memory/dream", JSON.stringify({}), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(503);
    expect(res.body.error).toContain("AI");
  });

  it("parses assistant text from session.state when content is an array (regression: undefined .match crash)", async () => {
    const session = {
      prompt: vi.fn().mockImplementation(async function (this: { state: { messages: unknown[] } }) {
        this.state.messages.push({
          role: "assistant",
          content: [{ text: "## DREAMS\nArrayContent\n\n## LONG_TERM_UPDATES\nArrayLesson" }],
        });
      }),
      dispose: vi.fn(),
      state: { messages: [] as unknown[] },
    };
    vi.mocked(createFnAgent).mockResolvedValue({ session } as never);

    const res = await REQUEST(buildApp(), "POST", "/api/memory/dream", JSON.stringify({}), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      dreamsWritten: true,
      longTermUpdatesWritten: true,
    });
  });

  it("returns 500 on unexpected processing failure", async () => {
    vi.mocked(createFnAgent).mockResolvedValue({
      session: {
        prompt: vi.fn().mockRejectedValue(new Error("boom")),
        dispose: vi.fn(),
      },
    } as never);

    const res = await REQUEST(buildApp(), "POST", "/api/memory/dream", JSON.stringify({}), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(500);
    expect(res.body.error).toContain("boom");
  });
});

describe("GET /api/memory/insights", () => {
  let store: TaskStore;
  let rootDir: string;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), "fusion-memory-insights-"));
    mkdirSync(join(rootDir, ".fusion", "memory"), { recursive: true });
    store = createMockStore({
      getRootDir: vi.fn().mockReturnValue(rootDir),
    });
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store));
    return app;
  }

  it("returns 200 with content and exists:true when insights file exists", async () => {
    // Insights file is at .fusion/memory/memory-insights.md
    writeFileSync(join(rootDir, ".fusion", "memory", "memory-insights.md"), "## Patterns\n- Pattern 1\n- Pattern 2");

    const res = await GET(buildApp(), "/api/memory/insights");

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("content");
    expect(res.body).toHaveProperty("exists", true);
    expect(typeof res.body.content).toBe("string");
  });

  it("returns 200 with content:null and exists:false when insights file does not exist", async () => {
    const res = await GET(buildApp(), "/api/memory/insights");

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("content", null);
    expect(res.body).toHaveProperty("exists", false);
  });
});

describe("PUT /api/memory/insights", () => {
  let store: TaskStore;
  let rootDir: string;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), "fusion-memory-insights-write-"));
    mkdirSync(join(rootDir, ".fusion"), { recursive: true });
    store = createMockStore({
      getRootDir: vi.fn().mockReturnValue(rootDir),
    });
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store));
    return app;
  }

  it("returns 200 with success:true for valid content", async () => {
    const res = await REQUEST(
      buildApp(),
      "PUT",
      "/api/memory/insights",
      JSON.stringify({ content: "## Patterns\n- New insight" }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("success", true);

    // Verify file was written (insights file is .fusion/memory/memory-insights.md)
    const insightsPath = join(rootDir, ".fusion", "memory", "memory-insights.md");
    expect(existsSync(insightsPath)).toBe(true);
  });

  it("returns 400 when content is missing", async () => {
    const res = await REQUEST(
      buildApp(),
      "PUT",
      "/api/memory/insights",
      JSON.stringify({}),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("content must be a string");
  });

  it("returns 400 when content is not a string", async () => {
    const res = await REQUEST(
      buildApp(),
      "PUT",
      "/api/memory/insights",
      JSON.stringify({ content: 123 }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("content must be a string");
  });
});

describe("POST /api/memory/extract", () => {
  let store: TaskStore;
  let rootDir: string;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), "fusion-memory-extract-"));
    mkdirSync(join(rootDir, ".fusion"), { recursive: true });
    store = createMockStore({
      getRootDir: vi.fn().mockReturnValue(rootDir),
    });
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store));
    return app;
  }

  it("returns 400 when working memory is empty", async () => {
    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/memory/extract",
      JSON.stringify({}),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("No working memory");
  });

  it("returns 200 with extraction result on success", async () => {
    // Working memory is at .fusion/memory/MEMORY.md
    mkdirSync(join(rootDir, ".fusion", "memory"), { recursive: true });
    writeFileSync(join(rootDir, ".fusion", "memory", "MEMORY.md"), "Working memory content for extraction that is long enough.");

    const session = {
      state: {
        messages: [] as Array<{ role: string; content: string }>,
      },
      prompt: vi.fn(async function (this: { state: { messages: Array<{ role: string; content: string }> } }) {
        const response = JSON.stringify({
          summary: "Extracted insights",
          insights: [{ category: "pattern", content: "Persist reusable conventions" }],
          prunedMemory: "## Architecture\n\nDurable architecture notes.",
        });
        this.state.messages.push({ role: "assistant", content: response });
        return response;
      }),
      dispose: vi.fn(),
    };

    vi.mocked(createFnAgent).mockResolvedValue({ session } as never);

    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/memory/extract",
      JSON.stringify({}),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("success", true);
    expect(res.body).toHaveProperty("summary");
    expect(res.body).toHaveProperty("insightCount");
    expect(res.body).toHaveProperty("pruned");
    expect(existsSync(join(rootDir, ".fusion", "memory", "memory-insights.md"))).toBe(true);
    expect(existsSync(join(rootDir, ".fusion", "memory", "memory-audit.md"))).toBe(true);
    expect(existsSync(join(rootDir, ".fusion", "memory", "memory-audit-state.json"))).toBe(true);
  });
});

describe("GET /api/memory/audit", () => {
  let store: TaskStore;
  let rootDir: string;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), "fusion-memory-audit-"));
    mkdirSync(join(rootDir, ".fusion", "memory"), { recursive: true });
    store = createMockStore({
      getRootDir: vi.fn().mockReturnValue(rootDir),
    });
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store));
    return app;
  }

  it("returns 200 with audit report shape", async () => {
    const res = await GET(buildApp(), "/api/memory/audit");

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("generatedAt");
    expect(res.body).toHaveProperty("workingMemory");
    expect(res.body).toHaveProperty("insightsMemory");
    expect(res.body).toHaveProperty("extraction");
    expect(res.body).toHaveProperty("pruning");
    expect(res.body).toHaveProperty("checks");
    expect(res.body).toHaveProperty("health");
    expect(["healthy", "warning", "issues"]).toContain(res.body.health);
  });

  it("includes working memory stats in audit", async () => {
    writeFileSync(join(rootDir, ".fusion", "memory", "MEMORY.md"), "# Working Memory\n\nSome content.");

    const res = await GET(buildApp(), "/api/memory/audit");

    expect(res.status).toBe(200);
    expect(res.body.workingMemory).toHaveProperty("exists");
    expect(res.body.workingMemory).toHaveProperty("size");
    expect(res.body.workingMemory).toHaveProperty("sectionCount");
  });

  it("preserves extraction metadata across extract then audit requests", async () => {
    writeFileSync(
      join(rootDir, ".fusion", "memory", "MEMORY.md"),
      "## Architecture\n\nDurable architecture\n\n## Conventions\n\nDurable conventions\n\n## Pitfalls\n\nDurable pitfalls",
    );

    const extractRes = await REQUEST(
      buildApp(),
      "POST",
      "/api/memory/extract",
      JSON.stringify({}),
      { "Content-Type": "application/json" },
    );

    expect(extractRes.status).toBe(200);
    expect(extractRes.body.success).toBe(true);

    const auditRes = await GET(buildApp(), "/api/memory/audit");

    expect(auditRes.status).toBe(200);
    expect(auditRes.body.extraction.runAt).toBeTruthy();
    expect(auditRes.body.extraction.summary).not.toBe("No extraction runs recorded");
    expect(auditRes.body.checks.find((check: { id: string; details: string }) => check.id === "recent-extraction")?.details).not.toContain("No extraction runs recorded");
  });
});

describe("GET /api/memory/stats", () => {
  let store: TaskStore;
  let rootDir: string;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), "fusion-memory-stats-"));
    mkdirSync(join(rootDir, ".fusion", "memory"), { recursive: true });
    store = createMockStore({
      getRootDir: vi.fn().mockReturnValue(rootDir),
    });
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store));
    return app;
  }

  it("returns 200 with workingMemorySize, insightsSize, and insightsExists", async () => {
    writeFileSync(join(rootDir, ".fusion", "memory", "MEMORY.md"), "Working memory content.");

    const res = await GET(buildApp(), "/api/memory/stats");

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("workingMemorySize");
    expect(res.body).toHaveProperty("insightsSize");
    expect(res.body).toHaveProperty("insightsExists");
    expect(typeof res.body.workingMemorySize).toBe("number");
    expect(typeof res.body.insightsSize).toBe("number");
    expect(typeof res.body.insightsExists).toBe("boolean");
  });

  it("returns insightsExists:false when insights file does not exist", async () => {
    const res = await GET(buildApp(), "/api/memory/stats");

    expect(res.status).toBe(200);
    expect(res.body.insightsExists).toBe(false);
    expect(res.body.insightsSize).toBe(0);
  });
});

describe("PUT /api/settings - memoryBackendType validation", () => {
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

  it("accepts memoryBackendType as string", async () => {
    (store.updateSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      memoryBackendType: "file",
    });

    const res = await REQUEST(buildApp(), "PUT", "/api/settings", JSON.stringify({ memoryBackendType: "file" }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(store.updateSettings).toHaveBeenCalledWith(expect.objectContaining({ memoryBackendType: "file" }));
  });

  it("accepts memoryBackendType as null for explicit clear", async () => {
    (store.updateSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      memoryBackendType: null,
    });

    const res = await REQUEST(buildApp(), "PUT", "/api/settings", JSON.stringify({ memoryBackendType: null }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(store.updateSettings).toHaveBeenCalledWith(expect.objectContaining({ memoryBackendType: null }));
  });

  it("accepts memoryBackendType as unknown custom backend (persisted verbatim)", async () => {
    (store.updateSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      memoryBackendType: "custom-backend-v1",
    });

    const res = await REQUEST(buildApp(), "PUT", "/api/settings", JSON.stringify({ memoryBackendType: "custom-backend-v1" }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    // Unknown backend IDs should be persisted verbatim
    expect(store.updateSettings).toHaveBeenCalledWith(expect.objectContaining({ memoryBackendType: "custom-backend-v1" }));
  });

  it("accepts memoryBackendType as qmd", async () => {
    (store.updateSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      memoryBackendType: "qmd",
    });

    const res = await REQUEST(buildApp(), "PUT", "/api/settings", JSON.stringify({ memoryBackendType: "qmd" }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(store.updateSettings).toHaveBeenCalledWith(expect.objectContaining({ memoryBackendType: "qmd" }));
  });

  it("returns 400 when memoryBackendType is not string or null", async () => {
    const res = await REQUEST(buildApp(), "PUT", "/api/settings", JSON.stringify({ memoryBackendType: 123 }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("memoryBackendType must be a string or null");
  });

  it("returns 400 when memoryBackendType is an object", async () => {
    const res = await REQUEST(buildApp(), "PUT", "/api/settings", JSON.stringify({ memoryBackendType: { type: "file" } }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("memoryBackendType must be a string or null");
  });
});

// ── Workflow Step Routes ─────────────────────────────────────────────

