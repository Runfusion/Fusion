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
const mockCentralGetLocalNode = vi.fn().mockResolvedValue({ id: "node-local" });
const mockCentralListNodes = vi.fn().mockResolvedValue([]);
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
      getLocalNode: mockCentralGetLocalNode,
      listNodes: mockCentralListNodes,
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
    createTaskWithReservedId: undefined,
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
    getDistributedTaskIdAllocator: vi.fn().mockReturnValue({
      reserveDistributedTaskId: vi.fn().mockResolvedValue({ reservationId: "res-1", taskId: "FN-7001" }),
      commitDistributedTaskIdReservation: vi.fn().mockResolvedValue({}),
      abortDistributedTaskIdReservation: vi.fn().mockResolvedValue({}),
    }),
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


describe("GET /tasks", () => {
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

  it("returns tasks with optional pagination params", async () => {
    (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValueOnce([FAKE_TASK_DETAIL]);

    const res = await GET(buildApp(), "/api/tasks?limit=10&offset=5");

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(store.listTasks).toHaveBeenCalledWith({ limit: 10, offset: 5, slim: true, includeArchived: false });
  });

  it("returns tasks for search query", async () => {
    (store.searchTasks as ReturnType<typeof vi.fn>).mockResolvedValueOnce([FAKE_TASK_DETAIL]);

    const res = await GET(buildApp(), "/api/tasks?q=FN-001");

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(store.searchTasks).toHaveBeenCalledWith("FN-001", {
      limit: undefined,
      offset: undefined,
      slim: true,
      includeArchived: false,
    });
  });

  it("returns tasks for search query with limit", async () => {
    (store.searchTasks as ReturnType<typeof vi.fn>).mockResolvedValueOnce([FAKE_TASK_DETAIL]);

    const res = await GET(buildApp(), "/api/tasks?q=something&limit=5");

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(store.searchTasks).toHaveBeenCalledWith("something", {
      limit: 5,
      offset: undefined,
      slim: true,
      includeArchived: false,
    });
  });

  it("returns empty array for non-existent search query", async () => {
    (store.searchTasks as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);

    const res = await GET(buildApp(), "/api/tasks?q=nonexistent");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("falls back to listTasks for empty search query", async () => {
    (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValueOnce([FAKE_TASK_DETAIL]);

    const res = await GET(buildApp(), "/api/tasks?q=");

    expect(res.status).toBe(200);
    expect(store.listTasks).toHaveBeenCalled();
    expect(store.searchTasks).not.toHaveBeenCalled();
  });

  it("returns 400 for invalid pagination params", async () => {
    const res = await GET(buildApp(), "/api/tasks?limit=-1");

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("limit");
  });
});

describe("Standardized error responses", () => {
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

  it("returns 400 validation errors as { error } without success field", async () => {
    const res = await GET(buildApp(), "/api/tasks?limit=-1");

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: expect.stringContaining("limit") });
    expect(res.body).not.toHaveProperty("success");
  });

  it("returns 404 not-found errors as { error }", async () => {
    (store.getTask as ReturnType<typeof vi.fn>).mockRejectedValueOnce(Object.assign(new Error("Task NOPE not found"), { code: "ENOENT" }));

    const res = await GET(buildApp(), "/api/tasks/NOPE");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: expect.stringContaining("not found") });
  });

  it("returns 500 errors as { error } and logs to the runtime logger", async () => {
    const runtimeEvents: Array<{ level: string; scope: string; message: string; context?: Record<string, unknown> }> = [];
    setRuntimeLogSink((level, scope, message, context) => {
      runtimeEvents.push({ level, scope, message, context });
    });
    (store.getSettingsFast as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("Config read failed"));

    try {
      const res = await GET(buildApp(), "/api/settings");

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: "Config read failed" });
      expect(runtimeEvents).toContainEqual(
        expect.objectContaining({
          level: "error",
          scope: "api:error",
          message: "Request failed",
          context: expect.objectContaining({
            method: "GET",
            path: "/api/settings",
            statusCode: 500,
            message: "Config read failed",
          }),
        }),
      );
    } finally {
      resetRuntimeLogSink();
    }
  });
});

describe("GET /projects", () => {
  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(createMockStore()));
    return app;
  }

  beforeEach(() => {
    mockCentralListProjects.mockReset().mockResolvedValue([]);
    mockCentralInit.mockReset().mockResolvedValue(undefined);
    mockCentralClose.mockReset().mockResolvedValue(undefined);
  });

  it("prioritizes the project for the current working directory", async () => {
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue("/workspace/current-project");
    mockCentralListProjects.mockResolvedValueOnce([
      {
        id: "proj_other",
        name: "Other Project",
        path: "/workspace/other-project",
        status: "active",
        isolationMode: "in-process",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "proj_current",
        name: "Current Project",
        path: "/workspace/current-project",
        status: "active",
        isolationMode: "in-process",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);

    const res = await GET(buildApp(), "/api/projects");

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect((res.body as Array<{ id: string }>).map((project) => project.id)).toEqual([
      "proj_current",
      "proj_other",
    ]);
    cwdSpy.mockRestore();
  });

  it("prefers the deepest matching ancestor when cwd is nested inside a project", async () => {
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue("/workspace/current-project/packages/dashboard");
    mockCentralListProjects.mockResolvedValueOnce([
      {
        id: "proj_parent",
        name: "Parent",
        path: "/workspace",
        status: "active",
        isolationMode: "in-process",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "proj_current",
        name: "Current Project",
        path: "/workspace/current-project",
        status: "active",
        isolationMode: "in-process",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "proj_other",
        name: "Other Project",
        path: "/workspace/other-project",
        status: "active",
        isolationMode: "in-process",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);

    const res = await GET(buildApp(), "/api/projects");

    expect(res.status).toBe(200);
    expect((res.body as Array<{ id: string }>).map((project) => project.id)).toEqual([
      "proj_current",
      "proj_parent",
      "proj_other",
    ]);
    cwdSpy.mockRestore();
  });
});

describe("GET /tasks/:id", () => {
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

  it("returns task detail on success", async () => {
    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(FAKE_TASK_DETAIL);

    const res = await GET(buildApp(), "/api/tasks/KB-001");

    expect(res.status).toBe(200);
    expect(res.body.id).toBe("FN-001");
    expect(res.body.prompt).toBe("# KB-001\n\nTest task");
  });

  it("returns tokenUsage unchanged when task detail includes usage totals", async () => {
    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(FAKE_TASK_DETAIL);

    const res = await GET(buildApp(), "/api/tasks/KB-001");

    expect(res.status).toBe(200);
    expect(res.body.tokenUsage).toEqual({
      inputTokens: 1200,
      outputTokens: 450,
      cachedTokens: 210,
      totalTokens: 1860,
      firstUsedAt: "2026-04-24T09:00:00.000Z",
      lastUsedAt: "2026-04-24T10:15:00.000Z",
    });
  });

  it("leaves tokenUsage undefined when no task usage has been recorded", async () => {
    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...FAKE_TASK_DETAIL,
      tokenUsage: undefined,
    });

    const res = await GET(buildApp(), "/api/tasks/KB-001");

    expect(res.status).toBe(200);
    expect(res.body.tokenUsage).toBeUndefined();
  });

  it("caps task detail activity logs to keep the modal payload bounded", async () => {
    const log = Array.from({ length: 510 }, (_, index) => ({
      timestamp: `2026-01-01T00:${String(index % 60).padStart(2, "0")}:00.000Z`,
      action: `entry-${index}`,
    }));
    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...FAKE_TASK_DETAIL,
      log,
    });

    const res = await GET(buildApp(), "/api/tasks/KB-001");

    expect(res.status).toBe(200);
    expect(res.body.log).toHaveLength(500);
    expect(res.body.log[0].action).toBe("entry-10");
    expect(res.body.log[499].action).toBe("entry-509");
    expect(res.body.activityLogTotal).toBe(510);
    expect(res.body.activityLogTruncatedCount).toBe(10);
  });

  it("returns 404 when task genuinely does not exist (ENOENT)", async () => {
    const err: NodeJS.ErrnoException = new Error("ENOENT: no such file or directory");
    err.code = "ENOENT";
    (store.getTask as ReturnType<typeof vi.fn>).mockRejectedValue(err);

    const res = await GET(buildApp(), "/api/tasks/KB-999");

    expect(res.status).toBe(404);
    expect(res.body.error).toContain("not found");
  });

  it("returns 500 on transient/unexpected errors (non-ENOENT)", async () => {
    const err = new Error("Unexpected end of JSON input");
    (store.getTask as ReturnType<typeof vi.fn>).mockRejectedValue(err);

    const res = await GET(buildApp(), "/api/tasks/KB-001");

    expect(res.status).toBe(500);
    expect(res.body.error).toContain("Unexpected end of JSON input");
  });
});

describe("POST /tasks", () => {
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

  it("creates a task and forwards breakIntoSubtasks", async () => {
    const createdTask = {
      ...FAKE_TASK_DETAIL,
      column: "triage",
      breakIntoSubtasks: true,
    };
    (store.createTask as ReturnType<typeof vi.fn>).mockResolvedValue(createdTask);

    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/tasks",
      JSON.stringify({
        description: "Big initiative",
        breakIntoSubtasks: true,
      }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(201);
    expect(store.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        title: undefined,
        description: "Big initiative",
        column: undefined,
        dependencies: undefined,
        breakIntoSubtasks: true,
        summarize: false,
      }),
      expect.objectContaining({
        settings: { autoSummarizeTitles: undefined },
      }),
    );
  });

  it("uses distributed allocator flow when reserved-id create is available", async () => {
    const createTaskWithReservedId = vi.fn().mockResolvedValue({
      ...FAKE_TASK_DETAIL,
      id: "FN-7001",
      column: "triage",
      createdAt: "2026-05-05T00:00:00.000Z",
      updatedAt: "2026-05-05T00:00:00.000Z",
      nodeId: "node-target",
    });
    const storeWithReservedCreate = createMockStore({
      createTaskWithReservedId,
      getTask: vi.fn().mockResolvedValue({ ...FAKE_TASK_DETAIL, prompt: "# FN-7001\n\nBig initiative\n" }),
    });

    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(storeWithReservedCreate));

    const res = await REQUEST(
      app,
      "POST",
      "/api/tasks",
      JSON.stringify({ description: "Big initiative", nodeId: "node-target" }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(201);
    expect(createTaskWithReservedId).toHaveBeenCalledWith(
      expect.objectContaining({ description: "Big initiative", nodeId: "node-target" }),
      expect.objectContaining({ taskId: "FN-7001" }),
    );
    expect((storeWithReservedCreate.getDistributedTaskIdAllocator as ReturnType<typeof vi.fn>).mock.results[0]?.value.commitDistributedTaskIdReservation).toHaveBeenCalled();
  });

  it("returns 400 when nodeId is not a string", async () => {
    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/tasks",
      JSON.stringify({ description: "Task", nodeId: 123 }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("nodeId must be a string");
  });

  it("retries reserved-id create when first reservation overlaps an existing task id", async () => {
    const reserveDistributedTaskId = vi
      .fn()
      .mockResolvedValueOnce({ reservationId: "res-1", taskId: "FN-7001" })
      .mockResolvedValueOnce({ reservationId: "res-2", taskId: "FN-7002" });
    const commitDistributedTaskIdReservation = vi.fn().mockResolvedValue({});
    const abortDistributedTaskIdReservation = vi.fn().mockResolvedValue({});
    const createTaskWithReservedId = vi
      .fn()
      .mockRejectedValueOnce(new Error("Task ID already exists: FN-7001"))
      .mockResolvedValueOnce({
        ...FAKE_TASK_DETAIL,
        id: "FN-7002",
        column: "triage",
        createdAt: "2026-05-05T00:00:00.000Z",
        updatedAt: "2026-05-05T00:00:00.000Z",
      });
    const deleteTask = vi.fn().mockResolvedValue(undefined);
    const getTask = vi.fn().mockResolvedValue({ ...FAKE_TASK_DETAIL, prompt: "# FN-7002\n\nBig initiative\n" });
    const storeWithReservedCreate = createMockStore({
      createTaskWithReservedId,
      deleteTask,
      getTask,
      getDistributedTaskIdAllocator: vi.fn().mockReturnValue({
        reserveDistributedTaskId,
        commitDistributedTaskIdReservation,
        abortDistributedTaskIdReservation,
      }),
    });

    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(storeWithReservedCreate));

    const res = await REQUEST(
      app,
      "POST",
      "/api/tasks",
      JSON.stringify({ description: "Big initiative" }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(201);
    expect(createTaskWithReservedId).toHaveBeenCalledTimes(2);
    expect(createTaskWithReservedId).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ description: "Big initiative" }),
      expect.objectContaining({ taskId: "FN-7001" }),
    );
    expect(createTaskWithReservedId).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ description: "Big initiative" }),
      expect.objectContaining({ taskId: "FN-7002" }),
    );
    expect(abortDistributedTaskIdReservation).toHaveBeenCalledTimes(1);
    expect(abortDistributedTaskIdReservation).toHaveBeenCalledWith(expect.objectContaining({ reservationId: "res-1", reason: "failed-create" }));
    expect(commitDistributedTaskIdReservation).toHaveBeenCalledWith(expect.objectContaining({ reservationId: "res-2" }));
    expect(deleteTask).not.toHaveBeenCalled();
  });

  it("aborts reservation and deletes local task on replication failure", async () => {
    const reserveDistributedTaskId = vi.fn().mockResolvedValue({ reservationId: "res-1", taskId: "FN-7002" });
    const commitDistributedTaskIdReservation = vi.fn().mockResolvedValue({});
    const abortDistributedTaskIdReservation = vi.fn().mockResolvedValue({});
    const createTaskWithReservedId = vi.fn().mockResolvedValue({
      ...FAKE_TASK_DETAIL,
      id: "FN-7002",
      column: "triage",
      createdAt: "2026-05-05T00:00:00.000Z",
      updatedAt: "2026-05-05T00:00:00.000Z",
    });
    const deleteTask = vi.fn().mockResolvedValue(undefined);
    const storeWithReservedCreate = createMockStore({
      createTaskWithReservedId,
      deleteTask,
      getTask: vi.fn().mockResolvedValue({ ...FAKE_TASK_DETAIL, prompt: "# FN-7002\n\nBig initiative\n" }),
      getDistributedTaskIdAllocator: vi.fn().mockReturnValue({
        reserveDistributedTaskId,
        commitDistributedTaskIdReservation,
        abortDistributedTaskIdReservation,
      }),
    });
    mockCentralListNodes.mockResolvedValue([{ id: "node-remote", type: "remote", url: "https://remote.example.com", apiKey: "secret" }]);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(storeWithReservedCreate));

    const res = await REQUEST(
      app,
      "POST",
      "/api/tasks",
      JSON.stringify({ description: "Big initiative" }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(503);
    expect(abortDistributedTaskIdReservation).toHaveBeenCalledWith(expect.objectContaining({ reservationId: "res-1", reason: "failed-create" }));
    expect(deleteTask).toHaveBeenCalledWith("FN-7002");
    expect(commitDistributedTaskIdReservation).not.toHaveBeenCalled();
    expect(reserveDistributedTaskId).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
    mockCentralListNodes.mockResolvedValue([]);
  });

  it("forwards branch and baseBranch on create", async () => {
    const createdTask = {
      ...FAKE_TASK_DETAIL,
      column: "triage",
      branch: "fusion/fn-branch",
      baseBranch: "main",
    };
    (store.createTask as ReturnType<typeof vi.fn>).mockResolvedValue(createdTask);

    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/tasks",
      JSON.stringify({
        description: "Task with branch fields",
        branch: " fusion/fn-branch ",
        baseBranch: " main ",
      }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(201);
    expect(store.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        branch: "fusion/fn-branch",
        baseBranch: "main",
      }),
      expect.any(Object),
    );
  });

  it("returns 400 when create branch payload is not a string", async () => {
    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/tasks",
      JSON.stringify({ description: "Task", branch: 10 }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("branch must be a string");
    expect(store.createTask).not.toHaveBeenCalled();
  });

  it("forwards model overrides when both provider and id are supplied", async () => {
    const createdTask = {
      ...FAKE_TASK_DETAIL,
      column: "triage",
      modelProvider: "anthropic",
      modelId: "claude-sonnet-4-5",
      validatorModelProvider: "openai",
      validatorModelId: "gpt-4o",
    };
    (store.createTask as ReturnType<typeof vi.fn>).mockResolvedValue(createdTask);

    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/tasks",
      JSON.stringify({
        description: "Use explicit models",
        modelProvider: "anthropic",
        modelId: "claude-sonnet-4-5",
        validatorModelProvider: "openai",
        validatorModelId: "gpt-4o",
      }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(201);
    expect(store.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        title: undefined,
        description: "Use explicit models",
        column: undefined,
        dependencies: undefined,
        breakIntoSubtasks: undefined,
        modelProvider: "anthropic",
        modelId: "claude-sonnet-4-5",
        validatorModelProvider: "openai",
        validatorModelId: "gpt-4o",
        summarize: false,
      }),
      expect.objectContaining({
        settings: { autoSummarizeTitles: undefined },
      }),
    );
  });

  it("normalizes partial model overrides back to defaults", async () => {
    const createdTask = {
      ...FAKE_TASK_DETAIL,
      column: "triage",
    };
    (store.createTask as ReturnType<typeof vi.fn>).mockResolvedValue(createdTask);

    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/tasks",
      JSON.stringify({
        description: "Ignore partial model selection",
        modelProvider: "anthropic",
        validatorModelId: "gpt-4o",
      }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(201);
    expect(store.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        title: undefined,
        description: "Ignore partial model selection",
        column: undefined,
        dependencies: undefined,
        breakIntoSubtasks: undefined,
        modelProvider: undefined,
        modelId: undefined,
        validatorModelProvider: undefined,
        validatorModelId: undefined,
        summarize: false,
      }),
      expect.objectContaining({
        settings: { autoSummarizeTitles: undefined },
      }),
    );
  });

  it("returns 400 when model fields are not strings", async () => {
    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/tasks",
      JSON.stringify({
        description: "Invalid model payload",
        modelProvider: ["anthropic"],
      }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("modelProvider must be a string");
    expect(store.createTask).not.toHaveBeenCalled();
  });

  it("returns 400 when description is missing", async () => {
    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/tasks",
      JSON.stringify({ breakIntoSubtasks: true }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("description is required");
    expect(store.createTask).not.toHaveBeenCalled();
  });

  it("returns 400 when breakIntoSubtasks is not a boolean", async () => {
    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/tasks",
      JSON.stringify({ description: "Big initiative", breakIntoSubtasks: "yes" }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("breakIntoSubtasks must be a boolean");
    expect(store.createTask).not.toHaveBeenCalled();
  });

  it("forwards thinkingLevel when provided", async () => {
    const createdTask = {
      ...FAKE_TASK_DETAIL,
      column: "triage",
      thinkingLevel: "high",
    };
    (store.createTask as ReturnType<typeof vi.fn>).mockResolvedValue(createdTask);

    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/tasks",
      JSON.stringify({
        description: "Deep reasoning task",
        thinkingLevel: "high",
      }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(201);
    expect(store.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        description: "Deep reasoning task",
        thinkingLevel: "high",
      }),
      expect.objectContaining({
        settings: { autoSummarizeTitles: undefined },
      }),
    );
  });

  it("returns 400 for invalid thinkingLevel value", async () => {
    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/tasks",
      JSON.stringify({
        description: "Bad thinking level",
        thinkingLevel: "ultra",
      }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("thinkingLevel must be one of");
    expect(store.createTask).not.toHaveBeenCalled();
  });

  it("forwards reviewLevel when provided", async () => {
    const createdTask = { ...FAKE_TASK_DETAIL, column: "triage" };
    (store.createTask as ReturnType<typeof vi.fn>).mockResolvedValue(createdTask);

    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/tasks",
      JSON.stringify({ description: "Test task", reviewLevel: 2 }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(201);
    expect(store.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ reviewLevel: 2 }),
      expect.any(Object),
    );
  });

  it("accepts reviewLevel 0 (None) via POST", async () => {
    const createdTask = { ...FAKE_TASK_DETAIL, column: "triage", reviewLevel: 0 };
    (store.createTask as ReturnType<typeof vi.fn>).mockResolvedValue(createdTask);

    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/tasks",
      JSON.stringify({ description: "Test task", reviewLevel: 0 }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(201);
    expect(store.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ reviewLevel: 0 }),
      expect.any(Object),
    );
  });

  it("returns 400 for invalid reviewLevel value via POST", async () => {
    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/tasks",
      JSON.stringify({ description: "Test task", reviewLevel: 5 }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("reviewLevel must be an integer between 0 and 3");
    expect(store.createTask).not.toHaveBeenCalled();
  });

  it("returns 400 for non-integer reviewLevel via POST", async () => {
    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/tasks",
      JSON.stringify({ description: "Test task", reviewLevel: 1.5 }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("reviewLevel must be an integer between 0 and 3");
    expect(store.createTask).not.toHaveBeenCalled();
  });

  it("forwards priority when provided", async () => {
    const createdTask = {
      ...FAKE_TASK_DETAIL,
      column: "triage",
      priority: "high" as const,
    };
    (store.createTask as ReturnType<typeof vi.fn>).mockResolvedValue(createdTask);

    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/tasks",
      JSON.stringify({
        description: "Priority task",
        priority: "high",
      }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(201);
    expect(store.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        description: "Priority task",
        priority: "high",
      }),
      expect.any(Object),
    );
  });

  it("returns 400 for invalid priority value", async () => {
    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/tasks",
      JSON.stringify({
        description: "Bad priority",
        priority: "medium",
      }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("priority must be one of");
    expect(store.createTask).not.toHaveBeenCalled();
  });

  it("forwards executionMode when provided with 'fast'", async () => {
    const createdTask = {
      ...FAKE_TASK_DETAIL,
      column: "triage",
      executionMode: "fast",
    };
    (store.createTask as ReturnType<typeof vi.fn>).mockResolvedValue(createdTask);

    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/tasks",
      JSON.stringify({
        description: "Fast task",
        executionMode: "fast",
      }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(201);
    expect(store.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        description: "Fast task",
        executionMode: "fast",
      }),
      expect.any(Object),
    );
  });

  it("forwards executionMode when provided with 'standard'", async () => {
    const createdTask = {
      ...FAKE_TASK_DETAIL,
      column: "triage",
      executionMode: "standard",
    };
    (store.createTask as ReturnType<typeof vi.fn>).mockResolvedValue(createdTask);

    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/tasks",
      JSON.stringify({
        description: "Standard task",
        executionMode: "standard",
      }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(201);
    expect(store.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        description: "Standard task",
        executionMode: "standard",
      }),
      expect.any(Object),
    );
  });

  it("returns 400 for invalid executionMode value", async () => {
    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/tasks",
      JSON.stringify({
        description: "Bad execution mode",
        executionMode: "turbo",
      }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("executionMode must be one of");
    expect(store.createTask).not.toHaveBeenCalled();
  });

  it("forwards planningModelProvider and planningModelId when provided", async () => {
    const createdTask = {
      ...FAKE_TASK_DETAIL,
      column: "triage",
      planningModelProvider: "google",
      planningModelId: "gemini-2.5-pro",
    };
    (store.createTask as ReturnType<typeof vi.fn>).mockResolvedValue(createdTask);

    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/tasks",
      JSON.stringify({
        description: "Use planning model",
        planningModelProvider: "google",
        planningModelId: "gemini-2.5-pro",
      }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(201);
    expect(store.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        description: "Use planning model",
        planningModelProvider: "google",
        planningModelId: "gemini-2.5-pro",
      }),
      expect.objectContaining({
        settings: { autoSummarizeTitles: undefined },
      }),
    );
  });

  it("passes onSummarize callback when autoSummarizeTitles is enabled", async () => {
    // Mock getSettingsFast to return autoSummarizeTitles: true
    (store.getSettingsFast as ReturnType<typeof vi.fn>).mockResolvedValue({ autoSummarizeTitles: true });

    const createdTask = {
      ...FAKE_TASK_DETAIL,
      column: "triage",
    };
    (store.createTask as ReturnType<typeof vi.fn>).mockResolvedValue(createdTask);

    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/tasks",
      JSON.stringify({
        description: "x".repeat(300), // Long description > 200 chars
      }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(201);
    // Verify onSummarize callback is passed - the route should pass it when autoSummarizeTitles is enabled
    expect(store.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        title: undefined,
        description: "x".repeat(300),
        summarize: false,
      }),
      expect.objectContaining({
        settings: { autoSummarizeTitles: true },
        onSummarize: expect.any(Function),
      }),
    );
  });

  it("does not create onSummarize callback when autoSummarizeTitles is disabled", async () => {
    // Mock getSettingsFast to return autoSummarizeTitles: false (default)
    (store.getSettingsFast as ReturnType<typeof vi.fn>).mockResolvedValue({ autoSummarizeTitles: false });

    const createdTask = {
      ...FAKE_TASK_DETAIL,
      column: "triage",
    };
    (store.createTask as ReturnType<typeof vi.fn>).mockResolvedValue(createdTask);

    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/tasks",
      JSON.stringify({
        description: "x".repeat(300), // Long description > 200 chars
      }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(201);
    expect(store.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        title: undefined,
        description: "x".repeat(300),
        summarize: false,
      }),
      expect.objectContaining({
        settings: { autoSummarizeTitles: false },
        onSummarize: undefined,
      }),
    );
  });

  it("passes onSummarize callback when summarize flag is explicitly true", async () => {
    // Mock getSettingsFast to return autoSummarizeTitles: false
    (store.getSettingsFast as ReturnType<typeof vi.fn>).mockResolvedValue({ autoSummarizeTitles: false });

    const createdTask = {
      ...FAKE_TASK_DETAIL,
      column: "triage",
    };
    (store.createTask as ReturnType<typeof vi.fn>).mockResolvedValue(createdTask);

    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/tasks",
      JSON.stringify({
        description: "x".repeat(300),
        summarize: true,
      }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(201);
    // Verify onSummarize callback is passed - explicit summarize flag should trigger it even when auto is off
    expect(store.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        summarize: true,
      }),
      expect.objectContaining({
        settings: { autoSummarizeTitles: false },
        onSummarize: expect.any(Function),
      }),
    );
  });

  it("forwards summarize field when provided in request body", async () => {
    const createdTask = {
      ...FAKE_TASK_DETAIL,
      column: "triage",
      summarize: true,
    };
    (store.createTask as ReturnType<typeof vi.fn>).mockResolvedValue(createdTask);

    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/tasks",
      JSON.stringify({
        description: "Test task",
        summarize: true,
      }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(201);
    expect(store.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        summarize: true,
      }),
      expect.any(Object),
    );
  });

  // ── Lane Precedence Regression Tests for onSummarize Callback ─────────────────
  // Tests for FN-1730: ensure onSummarize callback resolves models following the hierarchy:
  // 1. Project titleSummarizerProvider + titleSummarizerModelId (project lane)
  // 2. Global titleSummarizerGlobalProvider + titleSummarizerGlobalModelId (global lane)
  // 3. Default defaultProvider + defaultModelId (default fallback)
  //
  // Note: These tests verify that the route passes the correct settings to createTask
  // and that the onSummarize callback is invoked with the expected settings.
  // The actual AI summarization behavior is tested separately.

  it("invokes onSummarize callback when autoSummarizeTitles is enabled", async () => {
    // Mock project settings with autoSummarizeTitles: true (using getSettingsFast)
    (store.getSettingsFast as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      autoSummarizeTitles: true,
    });

    const createdTask = {
      ...FAKE_TASK_DETAIL,
      column: "triage",
    };
    (store.createTask as ReturnType<typeof vi.fn>).mockResolvedValue(createdTask);

    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/tasks",
      JSON.stringify({
        description: "x".repeat(300),
      }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(201);
    expect(store.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        summarize: false,
      }),
      expect.objectContaining({
        settings: { autoSummarizeTitles: true },
        onSummarize: expect.any(Function),
      }),
    );
  });

  it("passes correct settings to onSummarize callback when project title lane is configured", async () => {
    // Mock project settings with titleSummarizerProvider + titleSummarizerModelId (using getSettingsFast)
    (store.getSettingsFast as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      autoSummarizeTitles: true,
      titleSummarizerProvider: "anthropic",
      titleSummarizerModelId: "claude-sonnet-4-5",
    });

    const createdTask = {
      ...FAKE_TASK_DETAIL,
      column: "triage",
    };
    (store.createTask as ReturnType<typeof vi.fn>).mockResolvedValue(createdTask);

    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/tasks",
      JSON.stringify({
        description: "x".repeat(300),
      }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(201);
    // Verify the callback was passed with autoSummarizeTitles setting
    expect(store.createTask).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        settings: { autoSummarizeTitles: true },
        onSummarize: expect.any(Function),
      }),
    );
  });

  it("passes correct settings to onSummarize callback when global title lane is configured", async () => {
    // Mock project settings with global titleSummarizerGlobalProvider + titleSummarizerGlobalModelId (using getSettingsFast)
    (store.getSettingsFast as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      autoSummarizeTitles: true,
      titleSummarizerGlobalProvider: "openai",
      titleSummarizerGlobalModelId: "gpt-4o",
    });

    const createdTask = {
      ...FAKE_TASK_DETAIL,
      column: "triage",
    };
    (store.createTask as ReturnType<typeof vi.fn>).mockResolvedValue(createdTask);

    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/tasks",
      JSON.stringify({
        description: "x".repeat(300),
      }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(201);
    expect(store.createTask).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        settings: { autoSummarizeTitles: true },
        onSummarize: expect.any(Function),
      }),
    );
  });

  it("passes correct settings to onSummarize callback when default lane is configured", async () => {
    // Mock project settings with only defaultProvider + defaultModelId (using getSettingsFast)
    (store.getSettingsFast as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      autoSummarizeTitles: true,
      defaultProvider: "mistral",
      defaultModelId: "mistral-large",
    });

    const createdTask = {
      ...FAKE_TASK_DETAIL,
      column: "triage",
    };
    (store.createTask as ReturnType<typeof vi.fn>).mockResolvedValue(createdTask);

    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/tasks",
      JSON.stringify({
        description: "x".repeat(300),
      }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(201);
    expect(store.createTask).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        settings: { autoSummarizeTitles: true },
        onSummarize: expect.any(Function),
      }),
    );
  });

  it("passes correct settings to onSummarize callback when project default override is configured", async () => {
    (store.getSettingsFast as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      autoSummarizeTitles: true,
      defaultProviderOverride: "openai",
      defaultModelIdOverride: "gpt-4o",
      defaultProvider: "mistral",
      defaultModelId: "mistral-large",
    });

    const createdTask = {
      ...FAKE_TASK_DETAIL,
      column: "triage",
    };
    (store.createTask as ReturnType<typeof vi.fn>).mockResolvedValue(createdTask);

    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/tasks",
      JSON.stringify({
        description: "x".repeat(300),
      }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(201);
    expect(store.createTask).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        settings: { autoSummarizeTitles: true },
        onSummarize: expect.any(Function),
      }),
    );
  });
});

describe("PATCH /tasks/:id branch fields", () => {
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

  it("forwards trimmed branch and baseBranch values", async () => {
    (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...FAKE_TASK_DETAIL,
      branch: "fusion/fn-123",
      baseBranch: "main",
    });

    const res = await REQUEST(
      buildApp(),
      "PATCH",
      "/api/tasks/FN-001",
      JSON.stringify({ branch: " fusion/fn-123 ", baseBranch: " main " }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(200);
    expect(store.updateTask).toHaveBeenCalledWith("FN-001", expect.objectContaining({
      branch: "fusion/fn-123",
      baseBranch: "main",
    }));
  });

  it("treats empty-string patch values as clears (null)", async () => {
    (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...FAKE_TASK_DETAIL,
      branch: undefined,
      baseBranch: undefined,
    });

    const res = await REQUEST(
      buildApp(),
      "PATCH",
      "/api/tasks/FN-001",
      JSON.stringify({ branch: "   ", baseBranch: "" }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(200);
    expect(store.updateTask).toHaveBeenCalledWith("FN-001", expect.objectContaining({
      branch: null,
      baseBranch: null,
    }));
  });

  it("returns 400 for invalid branch payload types", async () => {
    const res = await REQUEST(
      buildApp(),
      "PATCH",
      "/api/tasks/FN-001",
      JSON.stringify({ branch: 42 }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("branch must be a string or null");
    expect(store.updateTask).not.toHaveBeenCalled();
  });
});

describe("POST /subtasks/*", () => {
  let store: TaskStore;

  beforeEach(() => {
    store = createMockStore();
    __resetPlanningState();
    __resetSubtaskBreakdownState();
  });

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store));
    return app;
  }

  it("starts a subtask streaming session and returns sessionId", async () => {
    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/subtasks/start-streaming",
      JSON.stringify({ description: "Break this feature into subtasks" }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(201);
    expect(typeof res.body.sessionId).toBe("string");
  });

  it("accepts projectId query param without error", async () => {
    // Mock getOrCreateProjectStore for projectId scoping
    vi.spyOn(projectStoreResolver, "getOrCreateProjectStore").mockResolvedValue(store);

    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/subtasks/start-streaming?projectId=test-project-123",
      JSON.stringify({ description: "Break this feature into subtasks" }),
      { "Content-Type": "application/json" },
    );

    // Should return 201 without throwing an error (projectId is forwarded)
    expect(res.status).toBe(201);
    expect(typeof res.body.sessionId).toBe("string");
  });

  it("retries a failed subtask session", async () => {
    const retrySpy = vi.spyOn(subtaskBreakdownModule, "retrySubtaskSession").mockResolvedValue();

    const res = await REQUEST(buildApp(), "POST", "/api/subtasks/session-123/retry");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, sessionId: "session-123" });
    expect(retrySpy).toHaveBeenCalledWith("session-123", "/fake/root", undefined);
  });

  it("returns 404 when subtask retry session does not exist", async () => {
    vi.spyOn(subtaskBreakdownModule, "retrySubtaskSession").mockRejectedValueOnce(
      new subtaskBreakdownModule.SessionNotFoundError("Subtask session not found"),
    );

    const res = await REQUEST(buildApp(), "POST", "/api/subtasks/session-404/retry");

    expect(res.status).toBe(404);
    expect(res.body.error).toContain("Subtask session not found");
  });

  it("returns 400 when subtask retry session is not in error state", async () => {
    vi.spyOn(subtaskBreakdownModule, "retrySubtaskSession").mockRejectedValueOnce(
      new subtaskBreakdownModule.InvalidSessionStateError("Session is not in error state"),
    );

    const res = await REQUEST(buildApp(), "POST", "/api/subtasks/session-400/retry");

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("not in error state");
  });

  it("replays buffered subtask events using lastEventId query param", async () => {
    const start = await REQUEST(
      buildApp(),
      "POST",
      "/api/subtasks/start-streaming",
      JSON.stringify({ description: "Replay buffered subtask stream" }),
      { "Content-Type": "application/json" },
    );

    const sessionId = start.body.sessionId as string;

    // Reset any initial stream manager state from background generation.
    subtaskStreamManager.cleanupSession(sessionId);

    subtaskStreamManager.broadcast(sessionId, { type: "thinking", data: "first" });
    subtaskStreamManager.broadcast(sessionId, { type: "thinking", data: "second" });

    setTimeout(() => {
      subtaskStreamManager.broadcast(sessionId, { type: "complete" });
    }, 0);

    const streamRes = await REQUEST(
      buildApp(),
      "GET",
      `/api/subtasks/${sessionId}/stream?lastEventId=1`,
    );

    expect(streamRes.status).toBe(200);
    expect(streamRes.body).toContain("id: 2");
    expect(streamRes.body).toContain("event: thinking");
    expect(streamRes.body).toContain("event: complete");
    expect(streamRes.body).not.toContain("id: 1\nevent: thinking");
  });

  it("replays buffered subtask events using Last-Event-ID header", async () => {
    const start = await REQUEST(
      buildApp(),
      "POST",
      "/api/subtasks/start-streaming",
      JSON.stringify({ description: "Replay buffered subtask stream from header" }),
      { "Content-Type": "application/json" },
    );

    const sessionId = start.body.sessionId as string;

    subtaskStreamManager.cleanupSession(sessionId);
    subtaskStreamManager.broadcast(sessionId, { type: "thinking", data: "first" });
    subtaskStreamManager.broadcast(sessionId, { type: "thinking", data: "second" });

    setTimeout(() => {
      subtaskStreamManager.broadcast(sessionId, { type: "complete" });
    }, 0);

    const streamRes = await REQUEST(
      buildApp(),
      "GET",
      `/api/subtasks/${sessionId}/stream`,
      undefined,
      { "Last-Event-ID": "1" },
    );

    expect(streamRes.status).toBe(200);
    expect(streamRes.body).toContain("id: 2");
    expect(streamRes.body).toContain("event: thinking");
    expect(streamRes.body).toContain("event: complete");
    expect(streamRes.body).not.toContain("id: 1\nevent: thinking");
  });

  it("skips subtask replay when Last-Event-ID is missing", async () => {
    const start = await REQUEST(
      buildApp(),
      "POST",
      "/api/subtasks/start-streaming",
      JSON.stringify({ description: "No subtask replay without header" }),
      { "Content-Type": "application/json" },
    );

    const sessionId = start.body.sessionId as string;

    subtaskStreamManager.cleanupSession(sessionId);
    subtaskStreamManager.broadcast(sessionId, { type: "thinking", data: "first" });

    setTimeout(() => {
      subtaskStreamManager.broadcast(sessionId, { type: "complete" });
    }, 0);

    const streamRes = await REQUEST(
      buildApp(),
      "GET",
      `/api/subtasks/${sessionId}/stream`,
    );

    expect(streamRes.status).toBe(200);
    expect(streamRes.body).not.toContain("id: 1\nevent: thinking");
    expect(streamRes.body).toContain("id: 2");
    expect(streamRes.body).toContain("event: complete");
  });

  it("gracefully ignores invalid Last-Event-ID values for subtask streams", async () => {
    const start = await REQUEST(
      buildApp(),
      "POST",
      "/api/subtasks/start-streaming",
      JSON.stringify({ description: "Invalid subtask last event id" }),
      { "Content-Type": "application/json" },
    );

    const sessionId = start.body.sessionId as string;

    subtaskStreamManager.cleanupSession(sessionId);
    subtaskStreamManager.broadcast(sessionId, { type: "thinking", data: "first" });

    setTimeout(() => {
      subtaskStreamManager.broadcast(sessionId, { type: "complete" });
    }, 0);

    const streamRes = await REQUEST(
      buildApp(),
      "GET",
      `/api/subtasks/${sessionId}/stream`,
      undefined,
      { "Last-Event-ID": "not-a-number" },
    );

    expect(streamRes.status).toBe(200);
    expect(streamRes.body).not.toContain("id: 1\nevent: thinking");
    expect(streamRes.body).toContain("id: 2");
    expect(streamRes.body).toContain("event: complete");
  });

  it("creates tasks from a breakdown and resolves dependencies", async () => {
    (store.createTask as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ ...FAKE_TASK_DETAIL, id: "FN-101", title: "First", column: "triage" })
      .mockResolvedValueOnce({ ...FAKE_TASK_DETAIL, id: "FN-102", title: "Second", column: "triage" });
    (store.updateTask as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ ...FAKE_TASK_DETAIL, id: "FN-101", title: "First", column: "triage", size: "S" })
      .mockResolvedValueOnce({ ...FAKE_TASK_DETAIL, id: "FN-102", title: "Second", column: "triage", size: "M" })
      .mockResolvedValueOnce({ ...FAKE_TASK_DETAIL, id: "FN-102", title: "Second", column: "triage", dependencies: ["FN-101"] });

    const start = await REQUEST(
      buildApp(),
      "POST",
      "/api/subtasks/start-streaming",
      JSON.stringify({ description: "Break this feature into subtasks" }),
      { "Content-Type": "application/json" },
    );

    const createRes = await REQUEST(
      buildApp(),
      "POST",
      "/api/subtasks/create-tasks",
      JSON.stringify({
        sessionId: start.body.sessionId,
        subtasks: [
          { tempId: "subtask-1", title: "First", description: "Do first", size: "S", dependsOn: [] },
          { tempId: "subtask-2", title: "Second", description: "Do second", size: "M", dependsOn: ["subtask-1"] },
        ],
      }),
      { "Content-Type": "application/json" },
    );

    expect(createRes.status).toBe(201);
    expect(createRes.body.tasks).toHaveLength(2);
    expect(store.createTask).toHaveBeenNthCalledWith(1, expect.objectContaining({ title: "First", dependencies: undefined }));
    expect(store.createTask).toHaveBeenNthCalledWith(2, expect.objectContaining({ title: "Second", dependencies: undefined }));
    expect(store.updateTask).toHaveBeenCalledWith("FN-102", { dependencies: ["FN-101"] });
  });

  it("returns 404 for invalid subtask session during batch creation", async () => {
    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/subtasks/create-tasks",
      JSON.stringify({
        sessionId: "missing-session",
        subtasks: [{ tempId: "subtask-1", title: "First", description: "Do first" }],
      }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(404);
    expect(res.body.error).toContain("not found");
  });

  it("inherits parent task model settings when creating subtasks", async () => {
    const parentTask = {
      ...FAKE_TASK_DETAIL,
      id: "FN-100",
      title: "Parent Task",
      column: "triage",
      modelProvider: "anthropic",
      modelId: "claude-sonnet-4-5",
      validatorModelProvider: "openai",
      validatorModelId: "gpt-4o",
    };

    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(parentTask);
    (store.createTask as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ ...FAKE_TASK_DETAIL, id: "FN-101", title: "First", column: "triage" })
      .mockResolvedValueOnce({ ...FAKE_TASK_DETAIL, id: "FN-102", title: "Second", column: "triage" });
    (store.updateTask as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ ...FAKE_TASK_DETAIL, id: "FN-101", title: "First", column: "triage", size: "S" })
      .mockResolvedValueOnce({ ...FAKE_TASK_DETAIL, id: "FN-102", title: "Second", column: "triage", size: "M" });

    const start = await REQUEST(
      buildApp(),
      "POST",
      "/api/subtasks/start-streaming",
      JSON.stringify({ description: "Break this feature into subtasks" }),
      { "Content-Type": "application/json" },
    );

    const createRes = await REQUEST(
      buildApp(),
      "POST",
      "/api/subtasks/create-tasks",
      JSON.stringify({
        sessionId: start.body.sessionId,
        parentTaskId: "FN-100",
        subtasks: [
          { tempId: "subtask-1", title: "First", description: "Do first", size: "S", dependsOn: [] },
          { tempId: "subtask-2", title: "Second", description: "Do second", size: "M", dependsOn: ["subtask-1"] },
        ],
      }),
      { "Content-Type": "application/json" },
    );

    expect(createRes.status).toBe(201);
    expect(store.getTask).toHaveBeenCalledWith("FN-100");
    expect(store.createTask).toHaveBeenNthCalledWith(1, expect.objectContaining({
      title: "First",
      modelProvider: "anthropic",
      modelId: "claude-sonnet-4-5",
      validatorModelProvider: "openai",
      validatorModelId: "gpt-4o",
    }));
    expect(store.createTask).toHaveBeenNthCalledWith(2, expect.objectContaining({
      title: "Second",
      modelProvider: "anthropic",
      modelId: "claude-sonnet-4-5",
      validatorModelProvider: "openai",
      validatorModelId: "gpt-4o",
    }));
  });

  it("handles missing parent task gracefully when creating subtasks", async () => {
    (store.getTask as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Task not found"));
    (store.createTask as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ ...FAKE_TASK_DETAIL, id: "FN-101", title: "First", column: "triage" });
    (store.updateTask as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ ...FAKE_TASK_DETAIL, id: "FN-101", title: "First", column: "triage", size: "S" });

    const start = await REQUEST(
      buildApp(),
      "POST",
      "/api/subtasks/start-streaming",
      JSON.stringify({ description: "Break this feature into subtasks" }),
      { "Content-Type": "application/json" },
    );

    const createRes = await REQUEST(
      buildApp(),
      "POST",
      "/api/subtasks/create-tasks",
      JSON.stringify({
        sessionId: start.body.sessionId,
        parentTaskId: "FN-NONEXISTENT",
        subtasks: [
          { tempId: "subtask-1", title: "First", description: "Do first", size: "S", dependsOn: [] },
        ],
      }),
      { "Content-Type": "application/json" },
    );

    expect(createRes.status).toBe(201);
    expect(store.getTask).toHaveBeenCalledWith("FN-NONEXISTENT");
    // Subtask created without model inheritance (undefined values)
    expect(store.createTask).toHaveBeenCalledWith(expect.objectContaining({
      title: "First",
      modelProvider: undefined,
      modelId: undefined,
      validatorModelProvider: undefined,
      validatorModelId: undefined,
    }));
  });

  it("drops a subtask dependency that references the parent task being split", async () => {
    // Regression: the AI/UI sometimes emits `dependsOn: ["<parentId>"]` on a
    // child. Previously the child was created with a reference to the
    // parent id (via an existing-task lookup), then the parent was deleted,
    // leaving the child permanently blocked. We now drop parent-id deps and
    // surface them in the response.
    const parentTask = {
      ...FAKE_TASK_DETAIL,
      id: "FN-PARENT",
      title: "Parent",
      column: "triage",
    };
    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(parentTask);
    (store.createTask as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...FAKE_TASK_DETAIL,
      id: "FN-CHILD",
      title: "Child",
      column: "triage",
    });
    (store.deleteTask as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    const start = await REQUEST(
      buildApp(),
      "POST",
      "/api/subtasks/start-streaming",
      JSON.stringify({ description: "Break this feature into subtasks" }),
      { "Content-Type": "application/json" },
    );

    const createRes = await REQUEST(
      buildApp(),
      "POST",
      "/api/subtasks/create-tasks",
      JSON.stringify({
        sessionId: start.body.sessionId,
        parentTaskId: "FN-PARENT",
        subtasks: [
          { tempId: "subtask-1", title: "Child", description: "Do it", dependsOn: ["FN-PARENT"] },
        ],
      }),
      { "Content-Type": "application/json" },
    );

    expect(createRes.status).toBe(201);
    // Dependencies must NOT contain the parent id.
    // updateTask either isn't called for deps, or is called with an empty array.
    const depUpdateCalls = (store.updateTask as ReturnType<typeof vi.fn>).mock.calls
      .filter((args: unknown[]) => {
        const patch = args[1] as { dependencies?: string[] } | undefined;
        return patch?.dependencies !== undefined;
      });
    for (const call of depUpdateCalls) {
      expect((call[1] as { dependencies: string[] }).dependencies).not.toContain("FN-PARENT");
    }
    // The response surfaces the dropped dep instead of silently swallowing it.
    expect(createRes.body.droppedDependencies).toEqual([
      { taskId: "FN-CHILD", dropped: ["FN-PARENT"] },
    ]);
  });

  it("surfaces parent close errors when deleteTask refuses due to live dependents", async () => {
    // If a child still references the parent after the drop step (shouldn't
    // happen post-fix, but could via race or caller mistake), store.deleteTask
    // throws. The endpoint must not swallow that silently — parentTaskClosed
    // is false AND parentTaskCloseError names the reason.
    const parentTask = {
      ...FAKE_TASK_DETAIL,
      id: "FN-STUBBORN",
      title: "Parent",
      column: "triage",
    };
    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(parentTask);
    (store.createTask as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...FAKE_TASK_DETAIL,
      id: "FN-CHILD",
      title: "Child",
      column: "triage",
    });
    (store.deleteTask as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Cannot delete task FN-STUBBORN: still referenced as a dependency by FN-OTHER."),
    );

    const start = await REQUEST(
      buildApp(),
      "POST",
      "/api/subtasks/start-streaming",
      JSON.stringify({ description: "Break this feature into subtasks" }),
      { "Content-Type": "application/json" },
    );

    const createRes = await REQUEST(
      buildApp(),
      "POST",
      "/api/subtasks/create-tasks",
      JSON.stringify({
        sessionId: start.body.sessionId,
        parentTaskId: "FN-STUBBORN",
        subtasks: [
          { tempId: "subtask-1", title: "Child", description: "Do it", dependsOn: [] },
        ],
      }),
      { "Content-Type": "application/json" },
    );

    expect(createRes.status).toBe(201);
    expect(createRes.body.parentTaskClosed).toBe(false);
    expect(createRes.body.parentTaskCloseError).toContain("FN-OTHER");
  });
});


describe("POST /tasks/:id/review/address", () => {
  let store: TaskStore;

  beforeEach(() => {
    store = createMockStore({ updateStep: vi.fn() } as unknown as Partial<TaskStore>);
  });

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store));
    return app;
  }

  it("resumes in-review tasks to in-progress using selected review payload", async () => {
    const taskWithReview = {
      ...FAKE_TASK_DETAIL,
      id: "FN-001",
      column: "in-review",
      status: "awaiting-user-review",
      assignedAgentId: null,
      steps: [{ id: "s1", title: "Step 1", status: "done" }],
      reviewState: {
        source: "reviewer-agent",
        items: [{ id: "ri-1", body: "Fix tests", summary: "Fix tests", author: { login: "reviewer" }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }],
        addressing: [],
      },
    };
    const movedTask = { ...taskWithReview, column: "in-progress", status: null, sessionFile: null, assignedAgentId: null };
    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValueOnce(taskWithReview).mockResolvedValueOnce({ ...taskWithReview, reviewState: { ...taskWithReview.reviewState, addressing: [{ itemId: "ri-1", status: "queued", selectedAt: new Date().toISOString() }] } });
    (store.addSteeringComment as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "sc-1" });
    (store.moveTask as ReturnType<typeof vi.fn>).mockResolvedValue(movedTask);

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/FN-001/review/address", JSON.stringify({ selectedItems: [{ id: "ri-1", source: "reviewer-agent", summary: "Fix tests", body: "Fix tests" }] }), { "Content-Type": "application/json" });

    expect(res.status).toBe(200);
    expect(store.moveTask).toHaveBeenCalledWith("FN-001", "in-progress", { preserveProgress: true });
    expect(store.updateStep).toHaveBeenCalledWith("FN-001", 0, "pending");
  });

  it("for in-progress tasks injects steering without moving task", async () => {
    const taskWithReview = {
      ...FAKE_TASK_DETAIL,
      id: "FN-001",
      column: "in-progress",
      sessionFile: "active.session.json",
      reviewState: {
        source: "pull-request",
        items: [{ id: "ri-1", body: "Fix tests", summary: "Fix tests", author: { login: "reviewer" }, createdAt: new Date().toISOString(), path: "src/a.ts", line: 4 }],
        addressing: [],
      },
    };
    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValueOnce(taskWithReview).mockResolvedValueOnce(taskWithReview);
    (store.addSteeringComment as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "sc-1" });

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/FN-001/review/address", JSON.stringify({ selectedItems: [{ id: "ri-1", source: "pr-review", summary: "Fix tests", body: "Fix tests", filePath: "src/a.ts", lineNumber: 4 }] }), { "Content-Type": "application/json" });

    expect(res.status).toBe(200);
    expect(store.moveTask).not.toHaveBeenCalled();
  });

  it("rejects empty selection", async () => {
    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({ ...FAKE_TASK_DETAIL, id: "FN-001", reviewState: { source: "reviewer-agent", items: [], addressing: [] } });
    const res = await REQUEST(buildApp(), "POST", "/api/tasks/FN-001/review/address", JSON.stringify({ selectedItems: [] }), { "Content-Type": "application/json" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("selectedItems must be a non-empty array");
  });

  it("rejects unsupported review source", async () => {
    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({ ...FAKE_TASK_DETAIL, id: "FN-001", reviewState: { source: "reviewer-agent", items: [{ id: "ri-1", body: "x", summary: "x", author: { login: "reviewer" }, createdAt: new Date().toISOString() }], addressing: [] } });
    const res = await REQUEST(buildApp(), "POST", "/api/tasks/FN-001/review/address", JSON.stringify({ selectedItems: [{ id: "ri-1", source: "other", summary: "x", body: "x" }] }), { "Content-Type": "application/json" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Unsupported review source");
  });

  it("rejects source mismatch and unknown item ids", async () => {
    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...FAKE_TASK_DETAIL,
      id: "FN-001",
      reviewState: { source: "pull-request", items: [{ id: "ri-1", body: "x", summary: "x", author: { login: "reviewer" }, createdAt: new Date().toISOString() }], addressing: [] },
    });

    const mismatch = await REQUEST(buildApp(), "POST", "/api/tasks/FN-001/review/address", JSON.stringify({ selectedItems: [{ id: "ri-1", source: "reviewer-agent", summary: "x", body: "x" }] }), { "Content-Type": "application/json" });
    expect(mismatch.status).toBe(400);
    expect(mismatch.body.error).toContain("does not match task review mode");

    const unknown = await REQUEST(buildApp(), "POST", "/api/tasks/FN-001/review/address", JSON.stringify({ selectedItems: [{ id: "ri-2", source: "pr-review", summary: "x", body: "x" }] }), { "Content-Type": "application/json" });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toContain("must reference existing review items");
    expect(store.createTask).not.toHaveBeenCalled();
  });
});
