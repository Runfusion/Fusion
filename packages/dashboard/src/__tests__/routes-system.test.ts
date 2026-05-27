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
const {
  mockPerformUpdateCheck,
  mockClearUpdateCheckCache,
  mockExecSync,
  mockExecFile,
  mockReloadExemptTools,
  mockGetExemptToolNames,
} = vi.hoisted(() => ({
  mockPerformUpdateCheck: vi.fn(),
  mockClearUpdateCheckCache: vi.fn(),
  mockExecSync: vi.fn(),
  mockExecFile: vi.fn(),
  mockReloadExemptTools: vi.fn(),
  mockGetExemptToolNames: vi.fn().mockReturnValue(["read", "find"]),
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
  reloadExemptTools: mockReloadExemptTools,
  getExemptToolNames: mockGetExemptToolNames,
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

describe("route registrar ordering invariants", () => {
  it("keeps project, node settings, and mesh/discovery precedence-sensitive routes ordered", () => {
    const router = createApiRoutes(createMockStore());
    const orderedKeys = collectOrderedRouteKeys(router);

    const indexOf = (routeKey: string): number => orderedKeys.indexOf(routeKey);

    expect(indexOf("GET /projects/across-nodes")).toBeGreaterThan(-1);
    expect(indexOf("POST /projects/detect")).toBeGreaterThan(-1);
    expect(indexOf("GET /projects/:id")).toBeGreaterThan(-1);
    expect(indexOf("GET /projects/across-nodes")).toBeLessThan(indexOf("GET /projects/:id"));
    expect(indexOf("POST /projects/detect")).toBeLessThan(indexOf("GET /projects/:id"));

    expect(indexOf("GET /nodes/:id/settings")).toBeLessThan(indexOf("POST /nodes/:id/settings/push"));
    expect(indexOf("GET /nodes/:id/settings")).toBeLessThan(indexOf("POST /nodes/:id/settings/pull"));
    expect(indexOf("GET /nodes/:id/settings")).toBeLessThan(indexOf("GET /nodes/:id/settings/sync-status"));
    expect(indexOf("GET /nodes/:id/settings")).toBeLessThan(indexOf("POST /nodes/:id/auth/sync"));

    expect(indexOf("GET /mesh/state")).toBeLessThan(indexOf("POST /mesh/sync"));
    expect(indexOf("GET /discovery/status")).toBeGreaterThan(indexOf("POST /mesh/sync"));
  });
});

describe("POST /api/action-gate/reload", () => {
  function buildApp(store: TaskStore, options?: Parameters<typeof createApiRoutes>[1]) {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store, options));
    return app;
  }

  beforeEach(() => {
    mockReloadExemptTools.mockReset();
    mockGetExemptToolNames.mockReset();
    mockGetExemptToolNames.mockReturnValue(["read", "find"]);
  });

  it("reloads defaults when no tools body is provided", async () => {
    const store = createMockStore();
    const res = await REQUEST(buildApp(store), "POST", "/api/action-gate/reload", JSON.stringify({}), {
      "content-type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(mockReloadExemptTools).toHaveBeenCalledWith();
    expect(res.body).toEqual({ ok: true, tools: ["read", "find"] });
  });

  it("reloads explicit tool list when tools are provided", async () => {
    const store = createMockStore();
    mockGetExemptToolNames.mockReturnValue(["custom_tool"]);
    const res = await REQUEST(buildApp(store), "POST", "/api/action-gate/reload", JSON.stringify({ tools: ["custom_tool"] }), {
      "content-type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(mockReloadExemptTools).toHaveBeenCalledWith(["custom_tool"]);
    expect(res.body).toEqual({ ok: true, tools: ["custom_tool"] });
  });

  it("returns bad request when tools is not a string array", async () => {
    const store = createMockStore();
    const res = await REQUEST(buildApp(store), "POST", "/api/action-gate/reload", JSON.stringify({ tools: ["ok", 1] }), {
      "content-type": "application/json",
    });

    expect(res.status).toBe(400);
    expect(mockReloadExemptTools).not.toHaveBeenCalled();
  });
});

describe("GET /api/system-stats", () => {
  const projectId = "proj-system-stats";

  function buildApp(store: TaskStore, options?: Parameters<typeof createApiRoutes>[1]) {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store, options));
    return app;
  }

  it("returns process/system metrics with task and agent aggregates", async () => {
    const cpuUsageSpy = vi.spyOn(process, "cpuUsage");
    const dateNowSpy = vi.spyOn(Date, "now");
    cpuUsageSpy
      .mockReturnValueOnce({ user: 1_000_000, system: 500_000 })
      .mockImplementation((previousValue?: NodeJS.CpuUsage) => {
        if (previousValue) {
          return { user: 200_000, system: 100_000 };
        }
        return { user: 1_200_000, system: 600_000 };
      });
    let now = 1_000;
    dateNowSpy.mockImplementation(() => {
      now += 1_000;
      return now;
    });

    const store = createMockStore({
      listTasks: vi.fn().mockResolvedValue([
        { id: "FN-1", column: "triage" },
        { id: "FN-2", column: "in-progress" },
        { id: "FN-3", column: "in-review" },
      ]),
      getFusionDir: vi.fn().mockReturnValue("/fake/default"),
    });

    mockExecFile.mockImplementation((...callArgs: unknown[]) => {
      const cb = callArgs[callArgs.length - 1] as (err: unknown, stdout?: string, stderr?: string) => void;
      cb(null, `${process.pid}\n111\n222\n`, "");
    });

    vi.spyOn(AgentStore.prototype, "init").mockResolvedValue(undefined);
    vi.spyOn(AgentStore.prototype, "listAgents").mockResolvedValue([
      { id: "agent-1", state: "idle" },
      { id: "agent-2", state: "active" },
      { id: "agent-3", state: "running" },
      { id: "agent-4", state: "error" },
    ] as Array<Awaited<ReturnType<AgentStore["listAgents"]>>[number]>);

    const app = buildApp(store);
    const res = await GET(app, "/api/system-stats");

    expect(res.status).toBe(200);
    expect(res.body.systemStats).toEqual(
      expect.objectContaining({
        rss: expect.any(Number),
        heapUsed: expect.any(Number),
        heapTotal: expect.any(Number),
        heapLimit: expect.any(Number),
        external: expect.any(Number),
        arrayBuffers: expect.any(Number),
        cpuPercent: null,
        loadAvg: expect.arrayContaining([expect.any(Number)]),
        cpuCount: expect.any(Number),
        systemTotalMem: expect.any(Number),
        systemFreeMem: expect.any(Number),
        pid: expect.any(Number),
        nodeVersion: expect.stringMatching(/^v/),
        platform: expect.stringContaining("/"),
      }),
    );

    const secondRes = await GET(app, "/api/system-stats");
    expect(secondRes.status).toBe(200);
    expect(secondRes.body.systemStats.cpuPercent).toBe(30);

    expect(res.body.taskStats).toEqual({
      total: 3,
      byColumn: {
        triage: 1,
        todo: 0,
        "in-progress": 1,
        "in-review": 1,
        done: 0,
        archived: 0,
      },
      active: 2,
      agents: {
        idle: 1,
        active: 1,
        running: 1,
        error: 1,
      },
    });
    expect(res.body.vitestProcessCount).toBe(2);
    expect(res.body.vitestLastAutoKillAt).toBeNull();

    cpuUsageSpy.mockRestore();
    dateNowSpy.mockRestore();
    mockExecFile.mockClear();
  });

  it("includes last auto-kill timestamp when available in global settings", async () => {
    const store = createMockStore({
      listTasks: vi.fn().mockResolvedValue([]),
      getFusionDir: vi.fn().mockReturnValue("/fake/default"),
      getGlobalSettingsStore: vi.fn().mockReturnValue({
        getSettings: vi.fn().mockResolvedValue({ vitestLastAutoKillAt: "2026-04-27T12:00:00.000Z" }),
      }),
    });

    vi.spyOn(AgentStore.prototype, "init").mockResolvedValue(undefined);
    vi.spyOn(AgentStore.prototype, "listAgents").mockResolvedValue([]);

    const res = await GET(buildApp(store), "/api/system-stats");

    expect(res.status).toBe(200);
    expect(res.body.vitestLastAutoKillAt).toBe("2026-04-27T12:00:00.000Z");
  });

  it("uses project-scoped store when projectId query param is provided", async () => {
    const defaultStore = createMockStore({
      listTasks: vi.fn().mockResolvedValue([{ id: "FN-default", column: "triage" }]),
      getFusionDir: vi.fn().mockReturnValue("/fake/default"),
    });
    const scopedStore = createMockStore({
      listTasks: vi.fn().mockResolvedValue([{ id: "FN-scoped", column: "todo" }]),
      getFusionDir: vi.fn().mockReturnValue("/fake/scoped"),
    });

    vi.spyOn(projectStoreResolver, "getOrCreateProjectStore").mockResolvedValue(scopedStore);
    vi.spyOn(AgentStore.prototype, "init").mockResolvedValue(undefined);
    vi.spyOn(AgentStore.prototype, "listAgents").mockResolvedValue([]);

    const res = await GET(buildApp(defaultStore), `/api/system-stats?projectId=${projectId}`);

    expect(res.status).toBe(200);
    expect(projectStoreResolver.getOrCreateProjectStore).toHaveBeenCalledWith(projectId);
    expect(scopedStore.listTasks).toHaveBeenCalledTimes(1);
    expect(defaultStore.listTasks).not.toHaveBeenCalled();
    expect(res.body.taskStats.byColumn.todo).toBe(1);
  });

  it("returns system stats with zeroed task stats when scoped project resolution fails", async () => {
    const defaultStore = createMockStore({
      listTasks: vi.fn().mockResolvedValue([{ id: "FN-default", column: "triage" }]),
      getFusionDir: vi.fn().mockReturnValue("/fake/default"),
    });

    vi.spyOn(projectStoreResolver, "getOrCreateProjectStore").mockRejectedValue(
      new Error(`Project "${projectId}" not found`),
    );
    const initSpy = vi.spyOn(AgentStore.prototype, "init").mockResolvedValue(undefined);
    const listAgentsSpy = vi.spyOn(AgentStore.prototype, "listAgents").mockResolvedValue([]);

    const res = await GET(buildApp(defaultStore), `/api/system-stats?projectId=${projectId}`);

    expect(res.status).toBe(200);
    expect(projectStoreResolver.getOrCreateProjectStore).toHaveBeenCalledWith(projectId);
    expect(defaultStore.listTasks).not.toHaveBeenCalled();
    expect(initSpy).not.toHaveBeenCalled();
    expect(listAgentsSpy).not.toHaveBeenCalled();
    expect(res.body.systemStats).toEqual(
      expect.objectContaining({
        rss: expect.any(Number),
        heapUsed: expect.any(Number),
        cpuPercent: expect.toSatisfy((value: unknown) => value === null || typeof value === "number"),
      }),
    );
    expect(res.body.taskStats).toEqual({
      total: 0,
      byColumn: {
        triage: 0,
        todo: 0,
        "in-progress": 0,
        "in-review": 0,
        done: 0,
        archived: 0,
      },
      active: 0,
      agents: {
        idle: 0,
        active: 0,
        running: 0,
        error: 0,
      },
    });
    expect(res.body.vitestLastAutoKillAt).toBeNull();
  });
});

describe("POST /api/kill-vitest", () => {
  function buildApp(store: TaskStore) {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store));
    return app;
  }

  it("returns killed: 0 when no vitest processes are found", async () => {
    const store = createMockStore();
    mockExecFile.mockImplementationOnce((...callArgs: unknown[]) => {
      const cb = callArgs[callArgs.length - 1] as (err: unknown, stdout?: string, stderr?: string) => void;
      cb(null, "", "");
    });

    const res = await REQUEST(buildApp(store), "POST", "/api/kill-vitest");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ killed: 0, pids: [] });
    mockExecFile.mockClear();
  });

  it("kills all matched vitest pids except the current dashboard process", async () => {
    const store = createMockStore();
    mockExecFile.mockImplementationOnce((...callArgs: unknown[]) => {
      const cb = callArgs[callArgs.length - 1] as (err: unknown, stdout?: string, stderr?: string) => void;
      cb(null, `${process.pid}\n1001\n1002\nnot-a-pid\n`, "");
    });
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const res = await REQUEST(buildApp(store), "POST", "/api/kill-vitest");

    expect(res.status).toBe(200);
    expect(killSpy).toHaveBeenCalledTimes(2);
    expect(killSpy).toHaveBeenNthCalledWith(1, 1001, "SIGKILL");
    expect(killSpy).toHaveBeenNthCalledWith(2, 1002, "SIGKILL");
    expect(res.body).toEqual({ killed: 2, pids: [1001, 1002] });

    killSpy.mockRestore();
    mockExecFile.mockClear();
  });

  it("returns killed: 0 when pgrep exits with no matches", async () => {
    const store = createMockStore();
    mockExecFile.mockImplementationOnce((...callArgs: unknown[]) => {
      const cb = callArgs[callArgs.length - 1] as (err: unknown, stdout?: string, stderr?: string) => void;
      const err = Object.assign(new Error("pgrep exited 1"), { code: 1 });
      cb(err);
    });

    const res = await REQUEST(buildApp(store), "POST", "/api/kill-vitest");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ killed: 0, pids: [] });
    mockExecFile.mockClear();
  });
});

describe("GET /api/plugins/runtimes", () => {
  function buildApp(pluginLoader?: { getPluginRuntimes?: () => Array<{ pluginId: string; runtime: { metadata: { runtimeId: string; name: string; description?: string; version?: string }; factory: () => unknown } }> }) {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(createMockStore(), { pluginLoader }));
    return app;
  }

  it("returns plugin runtime metadata with 200 status, with installed entries overriding bundled fallbacks by runtimeId", async () => {
    const pluginLoader = {
      getPluginRuntimes: () => [
        {
          pluginId: "plugin-openclaw",
          runtime: {
            metadata: {
              runtimeId: "openclaw",
              name: "OpenClaw Runtime",
              description: "Executes OpenClaw prompts",
              version: "1.2.3",
            },
            factory: () => ({ run: async () => undefined }),
          },
        },
      ],
    };

    const res = await GET(buildApp(pluginLoader), "/api/plugins/runtimes");

    expect(res.status).toBe(200);
    const body = res.body as Array<{ pluginId: string; runtimeId: string }>;
    // Installed runtime appears first and shadows the bundled openclaw entry.
    expect(body[0]).toEqual({
      pluginId: "plugin-openclaw",
      runtimeId: "openclaw",
      name: "OpenClaw Runtime",
      description: "Executes OpenClaw prompts",
      version: "1.2.3",
    });
    const ids = body.map((r) => r.runtimeId);
    expect(ids).toContain("hermes");
    expect(ids).toContain("paperclip");
    // Only one openclaw entry (installed wins over bundled).
    expect(ids.filter((id) => id === "openclaw")).toHaveLength(1);
  });

  it("returns the bundled plugin runtime fallbacks when no plugins are installed", async () => {
    const res = await GET(buildApp(), "/api/plugins/runtimes");

    expect(res.status).toBe(200);
    const body = res.body as Array<{ pluginId: string; runtimeId: string }>;
    const ids = body.map((r) => r.runtimeId).sort();
    expect(ids).toEqual(["hermes", "openclaw", "paperclip"]);
  });
});

describe("routes/context project scoping helpers", () => {
  it("prefers query.projectId over body.projectId", () => {
    const req = {
      query: { projectId: "query-project" },
      body: { projectId: "body-project" },
    } as unknown as express.Request;

    expect(getProjectIdFromRouteRequest(req)).toBe("query-project");
  });

  it("falls back to body.projectId when query.projectId is absent", () => {
    const req = {
      query: {},
      body: { projectId: "body-project" },
    } as unknown as express.Request;

    expect(getProjectIdFromRouteRequest(req)).toBe("body-project");
  });

  it("getScopedStore returns root store when projectId is missing", async () => {
    const store = createMockStore();
    const req = { query: {}, body: {} } as unknown as express.Request;
    const getOrCreateSpy = vi.spyOn(projectStoreResolver, "getOrCreateProjectStore");

    const scopedStore = await resolveRouteScopedStore(req, store);

    expect(scopedStore).toBe(store);
    expect(getOrCreateSpy).not.toHaveBeenCalled();
  });

  it("getProjectContext triggers background engine start and falls back to scoped store for first request", async () => {
    const store = createMockStore();
    const fallbackStore = createMockStore();
    const getOrCreateSpy = vi.spyOn(projectStoreResolver, "getOrCreateProjectStore").mockResolvedValueOnce(fallbackStore);

    const req = { query: { projectId: "proj-123" }, body: {} } as unknown as express.Request;
    const onProjectAccessedMock = vi.fn();
    const options = {
      engineManager: {
        getEngine: vi.fn().mockReturnValue(undefined),
        onProjectAccessed: onProjectAccessedMock,
      },
    } as any;

    const context = await resolveRouteProjectContext(req, store, options);

    expect(context.projectId).toBe("proj-123");
    expect(context.engine).toBeUndefined();
    expect(context.store).toBe(fallbackStore);
    // Engine start is triggered as fire-and-forget — not blocking the request
    expect(onProjectAccessedMock).toHaveBeenCalledWith("proj-123");
    expect(getOrCreateSpy).toHaveBeenCalledWith("proj-123");
  });
});

/** Build a minimal multipart/form-data body */
function buildMultipart(fieldName: string, filename: string, contentType: string, content: Buffer): { body: Buffer; boundary: string } {
  const boundary = "----TestBoundary" + Date.now();
  const header = `--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`;
  const footer = `\r\n--${boundary}--\r\n`;
  const body = Buffer.concat([Buffer.from(header), content, Buffer.from(footer)]);
  return { body, boundary };
}

type GitTestRepo = {
  root: string;
  repoDir: string;
  headSha: string;
};

let sharedGitTestRepo: GitTestRepo | null = null;

function getSharedGitTestRepo(): GitTestRepo {
  if (sharedGitTestRepo) {
    return sharedGitTestRepo;
  }

  const root = mkdtempSync(join(tmpdir(), "kb-dashboard-git-"));
  const remoteDir = join(root, "remote.git");
  const repoDir = join(root, "repo");

  mkdirSync(repoDir, { recursive: true });
  execFileSync("git", ["init", "--bare", "--initial-branch=main", remoteDir], { stdio: "pipe" });
  execFileSync("git", ["init", "--initial-branch=main", repoDir], { stdio: "pipe" });
  execFileSync("git", ["-C", repoDir, "config", "user.email", "kb-tests@example.com"], { stdio: "pipe" });
  execFileSync("git", ["-C", repoDir, "config", "user.name", "KB Tests"], { stdio: "pipe" });
  writeFileSync(join(repoDir, "README.md"), "# Test Repo\n");
  execFileSync("git", ["-C", repoDir, "add", "README.md"], { stdio: "pipe" });
  execFileSync("git", ["-C", repoDir, "commit", "-m", "Initial commit"], { stdio: "pipe" });
  execFileSync("git", ["-C", repoDir, "branch", "-M", "main"], { stdio: "pipe" });
  execFileSync("git", ["-C", repoDir, "remote", "add", "origin", remoteDir], { stdio: "pipe" });
  execFileSync("git", ["-C", repoDir, "push", "-u", "origin", "HEAD"], { stdio: "pipe" });

  const headSha = execFileSync("git", ["-C", repoDir, "rev-parse", "HEAD"], { encoding: "utf-8", stdio: "pipe" }).trim();
  sharedGitTestRepo = { root, repoDir, headSha };
  return sharedGitTestRepo;
}

afterAll(() => {
  if (sharedGitTestRepo) {
    rmSync(sharedGitTestRepo.root, { recursive: true, force: true });
    sharedGitTestRepo = null;
  }
});

afterEach(() => {
  resetDiagnosticsSink();
});
