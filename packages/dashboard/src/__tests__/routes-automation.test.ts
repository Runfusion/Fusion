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
  // FNXC:DatabaseBackup 2026-07-04-00:00:
  // FN-7537: route.ts's manual-run in-process backup interception statically imports
  // isInProcessBackupCommand/isInProcessMemoryBackupCommand/formatInProcessBackupError from
  // @fusion/engine. This module mock has no real `actual` behind it (see mockCoreEngine.js), so those
  // three must be the REAL implementations (via vi.importActual) rather than the default vi.fn()
  // fallback, or the interception would never match any command in these route tests.
  const actualEngine = await vi.importActual<typeof import("@fusion/engine")>("@fusion/engine");
  return createEngineMock({
  isInProcessBackupCommand: actualEngine.isInProcessBackupCommand,
  isInProcessMemoryBackupCommand: actualEngine.isInProcessMemoryBackupCommand,
  formatInProcessBackupError: actualEngine.formatInProcessBackupError,
  createFnAgent: vi.fn(async (options?: { onText?: (delta: string) => void; onToolStart?: (name: string, args?: Record<string, unknown>) => void; onToolEnd?: (name: string, isError: boolean, result?: unknown) => void }) => ({
    session: {
      state: {
        messages: [] as Array<{ role: string; content: string }>,
      },
      prompt: vi.fn(async function (this: { state?: { messages?: Array<{ role: string; content: string }> } }, message: string) {
        options?.onToolStart?.("Read", { path: "README.md" });
        options?.onText?.("mock-ai-output");
        options?.onToolEnd?.("Read", false, "read result");
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
  resolveMcpServersForStore: vi.fn(async () => ({ servers: [], errors: [] })),
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


describe("Terminal session routes", () => {
  let store: TaskStore;

  beforeEach(() => {
    store = createMockStore({
      getRootDir: vi.fn().mockReturnValue("/test/project"),
    } as any);
  });

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store));
    return app;
  }

  describe("GET /api/terminal/sessions", () => {
    it("returns lastActivityAt in session listing", async () => {
      const now = new Date();
      const mockSessions = [
        { id: "term-123", cwd: "/test", createdAt: now, lastActivityAt: now, shell: "/bin/zsh" },
      ];
      const mockService = {
        getAllSessions: vi.fn().mockReturnValue(mockSessions),
      };
      const terminalServiceSpy = vi.spyOn(terminalServiceModule, "getTerminalService").mockReturnValue(mockService as any);

      const res = await GET(buildApp(), "/api/terminal/sessions");

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].id).toBe("term-123");
      expect(res.body[0].lastActivityAt).toBe(now.toISOString());
      expect(res.body[0].createdAt).toBe(now.toISOString());
      // Ensure no sensitive data is exposed
      expect(res.body[0].scrollbackBuffer).toBeUndefined();
      expect(res.body[0].env).toBeUndefined();

      terminalServiceSpy.mockRestore();
    });
  });

  describe("POST /api/terminal/sessions", () => {
    it("returns 503 with specific max sessions error", async () => {
      const mockService = {
        createSession: vi.fn().mockResolvedValue({
          success: false,
          code: "max_sessions",
          error: "Maximum terminal sessions reached. Please close an existing terminal and try again.",
        }),
      };
      const terminalServiceSpy = vi.spyOn(terminalServiceModule, "getTerminalService").mockReturnValue(mockService as any);

      const res = await REQUEST(
        buildApp(),
        "POST",
        "/api/terminal/sessions",
        JSON.stringify({}),
        { "Content-Type": "application/json" },
      );

      expect(res.status).toBe(503);
      expect(res.body).toEqual({
        error: "Maximum terminal sessions reached. Please close an existing terminal and try again.",
        details: { code: "max_sessions" },
      });

      terminalServiceSpy.mockRestore();
    });

    it.each([
      ["invalid_shell", 400, "Shell not allowed. Please use a supported shell (bash, zsh, sh, cmd, powershell)."],
      ["invalid_cwd", 400, "Terminal working directory is not an authorized project or task worktree."],
      ["pty_load_failed", 503, "Terminal service unavailable. The PTY module could not be loaded."],
      ["pty_spawn_failed", 500, terminalServiceModule.WINDOWS_TERMINAL_EMBEDDED_STARTUP_ERROR],
    ] as const)("returns %s errors with the correct status and body", async (code, status, error) => {
      const mockService = {
        createSession: vi.fn().mockResolvedValue({
          success: false,
          code,
          error,
        }),
      };
      const terminalServiceSpy = vi.spyOn(terminalServiceModule, "getTerminalService").mockReturnValue(mockService as any);

      const res = await REQUEST(
        buildApp(),
        "POST",
        "/api/terminal/sessions",
        JSON.stringify({ shell: "/bad/shell" }),
        { "Content-Type": "application/json" },
      );

      expect(res.status).toBe(status);
      expect(res.body).toEqual({ error, details: { code } });

      terminalServiceSpy.mockRestore();
    });

    it("returns an actionable structured error instead of raw Windows Terminal version text", async () => {
      const mockService = {
        createSession: vi.fn().mockResolvedValue({
          success: false,
          code: "pty_spawn_failed",
          error: terminalServiceModule.WINDOWS_TERMINAL_EMBEDDED_STARTUP_ERROR,
        }),
      };
      const terminalServiceSpy = vi.spyOn(terminalServiceModule, "getTerminalService").mockReturnValue(mockService as any);

      const res = await REQUEST(
        buildApp(),
        "POST",
        "/api/terminal/sessions",
        JSON.stringify({}),
        { "Content-Type": "application/json" },
      );

      expect(res.status).toBe(500);
      expect(res.body).toEqual({
        error: terminalServiceModule.WINDOWS_TERMINAL_EMBEDDED_STARTUP_ERROR,
        details: { code: "pty_spawn_failed" },
      });
      expect(JSON.stringify(res.body)).not.toContain("Windows Terminal\\n1.24.11321.0");
      expect(mockService.createSession).toHaveBeenCalledTimes(1);

      terminalServiceSpy.mockRestore();
    });

    it("returns 201 for a successful session creation", async () => {
      const mockService = {
        createSession: vi.fn().mockResolvedValue({
          success: true,
          session: {
            id: "term-123",
            shell: "/bin/zsh",
            cwd: "/fake/root",
          },
        }),
      };
      const terminalServiceSpy = vi.spyOn(terminalServiceModule, "getTerminalService").mockReturnValue(mockService as any);

      const res = await REQUEST(
        buildApp(),
        "POST",
        "/api/terminal/sessions",
        JSON.stringify({ cwd: "/fake/root", cols: 120, rows: 40 }),
        { "Content-Type": "application/json" },
      );

      expect(res.status).toBe(201);
      expect(mockService.createSession).toHaveBeenCalledWith({
        cwd: "/fake/root",
        cols: 120,
        rows: 40,
      });
      expect(res.body).toEqual({
        sessionId: "term-123",
        shell: "/bin/zsh",
        cwd: "/fake/root",
      });

      terminalServiceSpy.mockRestore();
    });
  });
});

describe("Terminal WebSocket close handler", () => {
  it("does NOT kill PTY session when WebSocket closes (session persists for reconnect)", async () => {
    // After FN-762, closing a WebSocket must not destroy the PTY session.
    // The session survives transient disconnects and modal close/reopen cycles.
    const killSessionMock = vi.fn().mockReturnValue(true);
    const getSessionMock = vi.fn().mockReturnValue({
      id: "term-ws-test",
      shell: "/bin/zsh",
      cwd: "/fake/root",
      scrollbackBuffer: "hello",
      lastActivityAt: new Date(),
    });
    const getScrollbackAndClearPendingMock = vi.fn().mockReturnValue("scrollback data");
    const onDataMock = vi.fn().mockReturnValue(() => {});
    const onExitMock = vi.fn().mockReturnValue(() => {});

    const mockService = {
      getSession: getSessionMock,
      getScrollbackAndClearPending: getScrollbackAndClearPendingMock,
      killSession: killSessionMock,
      write: vi.fn(),
      resize: vi.fn(),
      onData: onDataMock,
      onExit: onExitMock,
    };

    const terminalServiceSpy = vi.spyOn(terminalServiceModule, "getTerminalService").mockReturnValue(mockService as any);

    const { setupTerminalWebSocket } = await import("../server.js");

    const app = express();
    const server = http.createServer(app);
    const store = createMockStore();

    setupTerminalWebSocket(app, server, store);
    class FakeWebSocket extends EventEmitter {
      send = vi.fn();
      close = vi.fn(() => this.emit("close"));
      terminate = vi.fn();
    }

    const ws = new FakeWebSocket();
    const wss = (app as express.Express & { terminalWsServer?: EventEmitter }).terminalWsServer;
    expect(wss).toBeTruthy();

    wss!.emit("connection", ws, {
      url: "/api/terminal/ws?sessionId=term-ws-test",
      headers: { host: "127.0.0.1" },
    });

    ws.close();

    // The session must NOT be killed on WebSocket close
    expect(killSessionMock).not.toHaveBeenCalled();

    terminalServiceSpy.mockRestore();
  });

  it("does NOT kill PTY session when WebSocket encounters an error (session persists for reconnect)", async () => {
    const killSessionMock = vi.fn().mockReturnValue(true);
    const getSessionMock = vi.fn().mockReturnValue({
      id: "term-ws-err",
      shell: "/bin/zsh",
      cwd: "/fake/root",
      lastActivityAt: new Date(),
    });
    const getScrollbackAndClearPendingMock = vi.fn().mockReturnValue(null);
    const onDataMock = vi.fn().mockReturnValue(() => {});
    const onExitMock = vi.fn().mockReturnValue(() => {});

    const mockService = {
      getSession: getSessionMock,
      getScrollbackAndClearPending: getScrollbackAndClearPendingMock,
      killSession: killSessionMock,
      write: vi.fn(),
      resize: vi.fn(),
      onData: onDataMock,
      onExit: onExitMock,
    };

    const terminalServiceSpy = vi.spyOn(terminalServiceModule, "getTerminalService").mockReturnValue(mockService as any);

    const { setupTerminalWebSocket } = await import("../server.js");

    const app = express();
    const server = http.createServer(app);
    const store = createMockStore();

    setupTerminalWebSocket(app, server, store);
    class FakeWebSocket extends EventEmitter {
      send = vi.fn();
      close = vi.fn(() => this.emit("close"));
      terminate = vi.fn();
    }

    const ws = new FakeWebSocket();
    const wss = (app as express.Express & { terminalWsServer?: EventEmitter }).terminalWsServer;
    expect(wss).toBeTruthy();

    wss!.emit("connection", ws, {
      url: "/api/terminal/ws?sessionId=term-ws-err",
      headers: { host: "127.0.0.1" },
    });

    ws.emit("error", new Error("synthetic websocket failure"));

    // The session must NOT be killed on WebSocket error
    expect(killSessionMock).not.toHaveBeenCalled();

    terminalServiceSpy.mockRestore();
  });

  it("cleans up data/exit subscriptions on WebSocket close without killing session", async () => {
    // Verify that WebSocket close properly unsubscribes from terminal service
    // events without destroying the underlying PTY session.
    const killSessionMock = vi.fn().mockReturnValue(true);
    const dataUnsub = vi.fn();
    const exitUnsub = vi.fn();
    const getSessionMock = vi.fn().mockReturnValue({
      id: "term-ws-unsub",
      shell: "/bin/zsh",
      cwd: "/fake/root",
      lastActivityAt: new Date(),
    });
    const getScrollbackAndClearPendingMock = vi.fn().mockReturnValue(null);
    const onDataMock = vi.fn().mockReturnValue(dataUnsub);
    const onExitMock = vi.fn().mockReturnValue(exitUnsub);

    const mockService = {
      getSession: getSessionMock,
      getScrollbackAndClearPending: getScrollbackAndClearPendingMock,
      killSession: killSessionMock,
      write: vi.fn(),
      resize: vi.fn(),
      onData: onDataMock,
      onExit: onExitMock,
    };

    const terminalServiceSpy = vi.spyOn(terminalServiceModule, "getTerminalService").mockReturnValue(mockService as any);

    const { setupTerminalWebSocket } = await import("../server.js");

    const app = express();
    const server = http.createServer(app);
    const store = createMockStore();

    setupTerminalWebSocket(app, server, store);
    class FakeWebSocket extends EventEmitter {
      send = vi.fn();
      close = vi.fn(() => this.emit("close"));
      terminate = vi.fn();
    }

    const ws = new FakeWebSocket();
    const wss = (app as express.Express & { terminalWsServer?: EventEmitter }).terminalWsServer;
    expect(wss).toBeTruthy();

    wss!.emit("connection", ws, {
      url: "/api/terminal/ws?sessionId=term-ws-unsub",
      headers: { host: "127.0.0.1" },
    });

    ws.close();

    // Subscriptions should be cleaned up
    expect(dataUnsub).toHaveBeenCalled();
    expect(exitUnsub).toHaveBeenCalled();
    // But session should NOT be killed
    expect(killSessionMock).not.toHaveBeenCalled();

    terminalServiceSpy.mockRestore();
  });
});

// ── Automation Routes ─────────────────────────────────────────────

describe("Automation routes", () => {
  const FAKE_SCHEDULE = {
    id: "sched-001",
    name: "Test Schedule",
    description: "A test schedule",
    scheduleType: "hourly",
    cronExpression: "0 * * * *",
    command: "echo hello",
    enabled: true,
    runCount: 0,
    runHistory: [],
    nextRunAt: "2026-04-01T00:00:00.000Z",
    createdAt: "2026-03-30T00:00:00.000Z",
    updatedAt: "2026-03-30T00:00:00.000Z",
    scope: "project" as const,
  };

  function createMockAutomationStore() {
    return {
      listSchedules: vi.fn().mockResolvedValue([FAKE_SCHEDULE]),
      createSchedule: vi.fn().mockResolvedValue(FAKE_SCHEDULE),
      getSchedule: vi.fn().mockResolvedValue(FAKE_SCHEDULE),
      updateSchedule: vi.fn().mockResolvedValue(FAKE_SCHEDULE),
      deleteSchedule: vi.fn().mockResolvedValue(FAKE_SCHEDULE),
      recordRun: vi.fn().mockResolvedValue(FAKE_SCHEDULE),
    };
  }

  function buildApp(automationStoreOverride?: ReturnType<typeof createMockAutomationStore>) {
    const store = createMockStore();
    const automationStore = automationStoreOverride ?? createMockAutomationStore();
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store, { automationStore: automationStore as any }));
    return { app, automationStore, store };
  }

  describe("GET /automations", () => {
    it("returns all schedules", async () => {
      const { app, automationStore } = buildApp();
      const res = await GET(app, "/api/automations");
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(automationStore.listSchedules).toHaveBeenCalledTimes(1);
    });

    it("returns empty array when no automationStore provided", async () => {
      const store = createMockStore();
      const app = express();
      app.use(express.json());
      app.use("/api", createApiRoutes(store));
      const res = await GET(app, "/api/automations");
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });
  });

  describe("POST /automations", () => {
    it("creates a schedule", async () => {
      const { app, automationStore } = buildApp();
      const res = await REQUEST(app, "POST", "/api/automations", JSON.stringify({
        name: "Test",
        command: "echo test",
        scheduleType: "hourly",
      }), { "Content-Type": "application/json" });
      expect(res.status).toBe(201);
      expect(automationStore.createSchedule).toHaveBeenCalledTimes(1);
    });

    it("returns 400 for missing name", async () => {
      const { app } = buildApp();
      const res = await REQUEST(app, "POST", "/api/automations", JSON.stringify({
        command: "echo test",
        scheduleType: "hourly",
      }), { "Content-Type": "application/json" });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Name is required");
    });

    it("returns 400 for missing command", async () => {
      const { app } = buildApp();
      const res = await REQUEST(app, "POST", "/api/automations", JSON.stringify({
        name: "Test",
        scheduleType: "hourly",
      }), { "Content-Type": "application/json" });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Command is required");
    });

    it("returns 400 for invalid schedule type", async () => {
      const { app } = buildApp();
      const res = await REQUEST(app, "POST", "/api/automations", JSON.stringify({
        name: "Test",
        command: "echo test",
        scheduleType: "invalid",
      }), { "Content-Type": "application/json" });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Invalid schedule type");
    });

    it("returns 400 for ai-prompt allowedTools with an unknown tool", async () => {
      const { app } = buildApp();
      const res = await REQUEST(app, "POST", "/api/automations", JSON.stringify({
        name: "Test",
        command: "",
        scheduleType: "hourly",
        steps: [
          {
            id: "step-ai",
            type: "ai-prompt",
            name: "AI",
            prompt: "Summarize",
            allowedTools: ["Read", "UnknownTool"],
          },
        ],
      }), { "Content-Type": "application/json" });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("allowedTools contains unknown tool");
    });

    it("returns 400 for custom type with missing cron", async () => {
      const { app } = buildApp();
      const res = await REQUEST(app, "POST", "/api/automations", JSON.stringify({
        name: "Test",
        command: "echo test",
        scheduleType: "custom",
      }), { "Content-Type": "application/json" });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Cron expression is required");
    });
  });

  describe("GET /automations/:id", () => {
    it("returns a schedule by id", async () => {
      const { app } = buildApp();
      const res = await GET(app, "/api/automations/sched-001");
      expect(res.status).toBe(200);
      expect(res.body.id).toBe("sched-001");
    });

    it("returns 404 for missing schedule", async () => {
      const mockStore = createMockAutomationStore();
      mockStore.getSchedule.mockRejectedValue(Object.assign(new Error("not found"), { code: "ENOENT" }));
      const { app } = buildApp(mockStore);
      const res = await GET(app, "/api/automations/missing");
      expect(res.status).toBe(404);
    });
  });

  describe("PATCH /automations/:id", () => {
    it("updates a schedule", async () => {
      const { app, automationStore } = buildApp();
      const res = await REQUEST(app, "PATCH", "/api/automations/sched-001", JSON.stringify({
        name: "Updated",
      }), { "Content-Type": "application/json" });
      expect(res.status).toBe(200);
      expect(automationStore.updateSchedule).toHaveBeenCalledWith("sched-001", expect.objectContaining({ name: "Updated" }));
    });

    it("returns 404 for missing schedule", async () => {
      const mockStore = createMockAutomationStore();
      mockStore.updateSchedule.mockRejectedValue(Object.assign(new Error("not found"), { code: "ENOENT" }));
      const { app } = buildApp(mockStore);
      const res = await REQUEST(app, "PATCH", "/api/automations/missing", JSON.stringify({
        name: "Updated",
      }), { "Content-Type": "application/json" });
      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /automations/:id", () => {
    it("deletes a schedule", async () => {
      const { app, automationStore } = buildApp();
      const res = await REQUEST(app, "DELETE", "/api/automations/sched-001");
      expect(res.status).toBe(200);
      expect(automationStore.deleteSchedule).toHaveBeenCalledWith("sched-001");
    });

    it("returns 404 for missing schedule", async () => {
      const mockStore = createMockAutomationStore();
      mockStore.deleteSchedule.mockRejectedValue(Object.assign(new Error("not found"), { code: "ENOENT" }));
      const { app } = buildApp(mockStore);
      const res = await REQUEST(app, "DELETE", "/api/automations/missing");
      expect(res.status).toBe(404);
    });
  });

  describe("POST /automations/:id/run", () => {
    it("runs a schedule and records the result", async () => {
      const mockStore = createMockAutomationStore();
      mockStore.getSchedule.mockResolvedValue({
        ...FAKE_SCHEDULE,
        command: "echo manual-run",
      });
      const { app } = buildApp(mockStore);
      const res = await REQUEST(app, "POST", "/api/automations/sched-001/run");
      expect(res.status).toBe(200);
      expect(res.body.result).toBeDefined();
      expect(res.body.result.startedAt).toBeTruthy();
      expect(res.body.result.completedAt).toBeTruthy();
      expect(mockStore.recordRun).toHaveBeenCalledWith(
        "sched-001",
        expect.objectContaining({
          success: expect.any(Boolean),
          startedAt: expect.any(String),
          completedAt: expect.any(String),
        }),
      );
    });

    it("executes ai-prompt steps during manual runs with the selected tool allowlist", async () => {
      vi.mocked(createFnAgent).mockClear();
      const mockStore = createMockAutomationStore();
      mockStore.getSchedule.mockResolvedValue({
        ...FAKE_SCHEDULE,
        command: "",
        steps: [
          {
            id: "step-ai",
            type: "ai-prompt",
            name: "AI analysis",
            prompt: "Summarize repository status",
            allowedTools: ["Read", "Grep"],
          },
        ],
      });

      const { app } = buildApp(mockStore);
      const res = await REQUEST(app, "POST", "/api/automations/sched-001/run");

      expect(res.status).toBe(200);
      expect(res.body.result.stepResults).toHaveLength(1);
      expect(res.body.result.stepResults[0]).toEqual(
        expect.objectContaining({
          stepName: "AI analysis",
          success: true,
          output: expect.stringContaining("mock-ai-output"),
        }),
      );
      expect(mockStore.recordRun).toHaveBeenCalledWith(
        "sched-001",
        expect.objectContaining({
          stepResults: expect.arrayContaining([
            expect.objectContaining({ stepName: "AI analysis", success: true }),
          ]),
        }),
      );
      expect(vi.mocked(createFnAgent)).toHaveBeenCalledWith(expect.objectContaining({
        tools: "coding",
        toolsAllowlist: ["Read", "Grep"],
      }));
    });

    it("streams buffered live events for a completed manual AI prompt run", async () => {
      vi.mocked(createFnAgent).mockClear();
      const mockStore = createMockAutomationStore();
      mockStore.getSchedule.mockResolvedValue({
        ...FAKE_SCHEDULE,
        command: "",
        steps: [
          {
            id: "step-ai",
            type: "ai-prompt",
            name: "Analyze",
            prompt: "Analyze recent activity",
          },
        ],
      });
      const { app } = buildApp(mockStore);

      const runRes = await REQUEST(app, "POST", "/api/automations/sched-001/run");
      expect(runRes.status).toBe(200);
      expect(runRes.body.liveRunId).toBeTruthy();
      expect(runRes.body.result.output).toContain("mock-ai-output");

      const streamRes = await performRequest(app, "GET", `/api/automations/sched-001/run/stream?runId=${runRes.body.liveRunId}`);
      expect(streamRes.status).toBe(200);
      const body = String(streamRes.body);
      expect(body).toContain("event: step");
      expect(body).toContain("event: output");
      expect(body).toContain("mock-ai-output");
      expect(body).toContain("event: tool");
      expect(body).toContain("Read");
      expect(body).toContain("event: complete");
      expect(runRes.body.result.stepResults).toHaveLength(1);
    });

    it("returns a terminal SSE error for an unknown manual run id", async () => {
      const mockStore = createMockAutomationStore();
      mockStore.getSchedule.mockResolvedValue({ ...FAKE_SCHEDULE });
      const { app } = buildApp(mockStore);

      const streamRes = await performRequest(app, "GET", "/api/automations/sched-001/run/stream?runId=missing-run");
      expect(streamRes.status).toBe(200);
      expect(String(streamRes.body)).toContain("event: error");
      expect(String(streamRes.body)).toContain("Live run not found or expired");
    });

    it("defaults manual ai-prompt runs to all tools when allowedTools is omitted", async () => {
      vi.mocked(createFnAgent).mockClear();
      const mockStore = createMockAutomationStore();
      mockStore.getSchedule.mockResolvedValue({
        ...FAKE_SCHEDULE,
        command: "",
        steps: [
          {
            id: "step-ai",
            type: "ai-prompt",
            name: "AI analysis",
            prompt: "Summarize repository status",
          },
        ],
      });

      const { app } = buildApp(mockStore);
      const res = await REQUEST(app, "POST", "/api/automations/sched-001/run");

      expect(res.status).toBe(200);
      expect(vi.mocked(createFnAgent)).toHaveBeenCalledWith(expect.objectContaining({
        tools: "coding",
        toolsAllowlist: undefined,
      }));
    });

    it("executes create-task steps during manual runs", async () => {
      const mockStore = createMockAutomationStore();
      mockStore.getSchedule.mockResolvedValue({
        ...FAKE_SCHEDULE,
        command: "",
        steps: [
          {
            id: "step-task",
            type: "create-task",
            name: "Create follow-up",
            taskTitle: "Weekly report",
            taskDescription: "Create weekly maintenance report",
            taskColumn: "todo",
          },
        ],
      });

      const { app, store } = buildApp(mockStore);
      (store.createTask as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "FN-9001",
        title: "Weekly report",
        description: "Create weekly maintenance report",
      });

      const res = await REQUEST(app, "POST", "/api/automations/sched-001/run");

      expect(res.status).toBe(200);
      expect(store.createTask).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Weekly report",
          description: "Create weekly maintenance report",
          column: "todo",
        }),
      );
      expect(res.body.result.stepResults[0]).toEqual(
        expect.objectContaining({
          stepName: "Create follow-up",
          success: true,
          output: expect.stringContaining("Created task FN-9001"),
        }),
      );
    });

    it("create-task automation step remains successful without explicit tracking issue creation", async () => {
      const createIssueSpy = vi.spyOn(GitHubClient.prototype, "createIssue").mockResolvedValue({
        owner: "task",
        repo: "repo",
        number: 17,
        htmlUrl: "https://github.com/task/repo/issues/17",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      const mockStore = createMockAutomationStore();
      mockStore.getSchedule.mockResolvedValue({
        ...FAKE_SCHEDULE,
        command: "",
        steps: [
          {
            id: "step-task",
            type: "create-task",
            name: "Create tracked task",
            taskTitle: "Tracked report",
            taskDescription: "Create tracked report",
            taskColumn: "todo",
          },
        ],
      });

      const linkGithubIssue = vi.fn().mockResolvedValue(undefined);
      const recordActivity = vi.fn().mockResolvedValue(undefined);
      const { app, store } = buildApp(mockStore);
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        githubTrackingDefaultRepo: "task/repo",
        githubAuthMode: "token",
        githubAuthToken: "tok",
      });
      (store.getGlobalSettingsStore as ReturnType<typeof vi.fn>).mockReturnValue({ getSettings: vi.fn().mockResolvedValue({}) });
      (store.createTask as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "FN-9002",
        title: "Tracked report",
        description: "Create tracked report",
        githubTracking: { enabled: true },
      });
      (store as unknown as { linkGithubIssue: typeof linkGithubIssue }).linkGithubIssue = linkGithubIssue;
      (store as unknown as { recordActivity: typeof recordActivity }).recordActivity = recordActivity;

      const res = await REQUEST(app, "POST", "/api/automations/sched-001/run");

      expect(res.status).toBe(200);
      expect(createIssueSpy).not.toHaveBeenCalled();
      expect(linkGithubIssue).not.toHaveBeenCalled();
      expect(recordActivity).not.toHaveBeenCalled();
      createIssueSpy.mockRestore();
    });

    it("create-task automation step keeps success even if GitHub client would fail", async () => {
      const createIssueSpy = vi.spyOn(GitHubClient.prototype, "createIssue").mockRejectedValue(new Error("github down"));
      const mockStore = createMockAutomationStore();
      mockStore.getSchedule.mockResolvedValue({
        ...FAKE_SCHEDULE,
        command: "",
        steps: [
          {
            id: "step-task",
            type: "create-task",
            name: "Create tracked task",
            taskDescription: "Create tracked report",
          },
        ],
      });

      const { app, store } = buildApp(mockStore);
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        githubTrackingDefaultRepo: "task/repo",
        githubAuthMode: "token",
        githubAuthToken: "tok",
      });
      (store.createTask as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "FN-9003",
        description: "Create tracked report",
        githubTracking: { enabled: true },
      });

      const res = await REQUEST(app, "POST", "/api/automations/sched-001/run");

      expect(res.status).toBe(200);
      expect(res.body.result.stepResults[0]).toEqual(expect.objectContaining({ success: true }));
      expect(createIssueSpy).not.toHaveBeenCalled();
      createIssueSpy.mockRestore();
    });
    it("does not create tracking issue in automation create-task when task already linked", async () => {
      const createIssueSpy = vi.spyOn(GitHubClient.prototype, "createIssue");
      const mockStore = createMockAutomationStore();
      mockStore.getSchedule.mockResolvedValue({
        ...FAKE_SCHEDULE,
        command: "",
        steps: [
          {
            id: "step-task",
            type: "create-task",
            name: "Create tracked task",
            taskDescription: "Create tracked report",
          },
        ],
      });

      const { app, store } = buildApp(mockStore);
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        githubTrackingDefaultRepo: "task/repo",
        githubAuthMode: "token",
        githubAuthToken: "tok",
      });
      (store.createTask as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "FN-9004",
        description: "Create tracked report",
        githubTracking: {
          enabled: true,
          issue: { owner: "task", repo: "repo", number: 3, url: "https://github.com/task/repo/issues/3" },
        },
      });

      const res = await REQUEST(app, "POST", "/api/automations/sched-001/run");

      expect(res.status).toBe(200);
      expect(res.body.result.stepResults[0]).toEqual(expect.objectContaining({ success: true }));
      expect(createIssueSpy).not.toHaveBeenCalled();
      createIssueSpy.mockRestore();
    });

    it("respects continueOnFailure for create-task failures", async () => {
      const mockStore = createMockAutomationStore();
      mockStore.getSchedule.mockResolvedValue({
        ...FAKE_SCHEDULE,
        command: "",
        steps: [
          {
            id: "step-bad-task",
            type: "create-task",
            name: "Broken task",
            taskDescription: "",
            continueOnFailure: true,
          },
          {
            id: "step-next",
            type: "command",
            name: "Still run command",
            command: "echo after-failure",
          },
        ],
      });

      const { app } = buildApp(mockStore);
      const res = await REQUEST(app, "POST", "/api/automations/sched-001/run");

      expect(res.status).toBe(200);
      expect(res.body.result.success).toBe(false);
      expect(res.body.result.stepResults).toHaveLength(2);
      expect(res.body.result.stepResults[0]).toEqual(
        expect.objectContaining({ stepName: "Broken task", success: false }),
      );
      expect(res.body.result.stepResults[1]).toEqual(
        expect.objectContaining({
          stepName: "Still run command",
          success: true,
          output: expect.stringContaining("after-failure"),
        }),
      );
    });

    it("returns 404 for missing schedule", async () => {
      const mockStore = createMockAutomationStore();
      mockStore.getSchedule.mockRejectedValue(Object.assign(new Error("not found"), { code: "ENOENT" }));
      const { app } = buildApp(mockStore);
      const res = await REQUEST(app, "POST", "/api/automations/missing/run");
      expect(res.status).toBe(404);
    });

    /*
    FNXC:DatabaseBackup 2026-07-04-00:00:
    FN-7537 Symptom Verification: the reported symptom was the "Database Backup" automation failing on a
    manual dashboard run while succeeding via cron. These tests drive the exact manual endpoint
    (POST /automations/:id/run) that previously always shelled out via exec() for every command —
    including the persisted `fn backup --create` command — and assert it now intercepts the in-process
    backup (matching the cron path's CronRunner.executeBackupInProcess result) instead of failing on hosts
    without a global `fn`/`runfusion.ai` binary.
    */
    describe("manual backup run parity (FN-7537)", () => {
      function writeTestDb(path: string): void {
        try {
          execFileSync("sqlite3", [path, "CREATE TABLE IF NOT EXISTS t(x); INSERT INTO t VALUES (1);"]);
        } catch {
          writeFileSync(path, "dummy database content");
        }
      }

      it("intercepts the in-process backup for a legacy single-command schedule and does not shell out", async () => {
        const tempDir = mkdtempSync(join(tmpdir(), "routes-automation-backup-"));
        const fusionDir = join(tempDir, ".fusion");
        mkdirSync(fusionDir, { recursive: true });
        writeTestDb(join(fusionDir, "fusion.db"));

        try {
          const mockStore = createMockAutomationStore();
          mockStore.getSchedule.mockResolvedValue({
            ...FAKE_SCHEDULE,
            command: "fn backup --create",
          });
          const store = createMockStore({ getFusionDir: vi.fn().mockReturnValue(fusionDir) } as any);
          const app = express();
          app.use(express.json());
          app.use("/api", createApiRoutes(store, { automationStore: mockStore as any }));
          mockExecFile.mockClear();

          const res = await REQUEST(app, "POST", "/api/automations/sched-001/run");

          expect(res.status).toBe(200);
          expect(res.body.result.success).toBe(true);
          expect(res.body.result.output).toContain("Backup created");
          // A shelled-out command would have gone through node:child_process exec — assert it did not.
          expect(mockExecFile).not.toHaveBeenCalledWith(
            expect.anything(),
            expect.arrayContaining([expect.stringContaining("backup")]),
            expect.anything(),
            expect.anything(),
          );
        } finally {
          rmSync(tempDir, { recursive: true, force: true });
        }
      });

      it("intercepts the in-process backup for a command-type schedule step", async () => {
        const tempDir = mkdtempSync(join(tmpdir(), "routes-automation-backup-step-"));
        const fusionDir = join(tempDir, ".fusion");
        mkdirSync(fusionDir, { recursive: true });
        writeTestDb(join(fusionDir, "fusion.db"));

        try {
          const mockStore = createMockAutomationStore();
          mockStore.getSchedule.mockResolvedValue({
            ...FAKE_SCHEDULE,
            command: "",
            steps: [
              {
                id: "step-backup",
                type: "command",
                name: "Run backup",
                command: "fn backup --create",
              },
            ],
          });
          const store = createMockStore({ getFusionDir: vi.fn().mockReturnValue(fusionDir) } as any);
          const app = express();
          app.use(express.json());
          app.use("/api", createApiRoutes(store, { automationStore: mockStore as any }));

          const res = await REQUEST(app, "POST", "/api/automations/sched-001/run");

          expect(res.status).toBe(200);
          expect(res.body.result.stepResults[0]).toEqual(
            expect.objectContaining({ stepName: "Run backup", success: true, output: expect.stringContaining("Backup created") }),
          );
        } finally {
          rmSync(tempDir, { recursive: true, force: true });
        }
      });

      it("streams a step-start live event before the terminal complete event for a manual backup run", async () => {
        const tempDir = mkdtempSync(join(tmpdir(), "routes-automation-backup-live-"));
        const fusionDir = join(tempDir, ".fusion");
        mkdirSync(fusionDir, { recursive: true });
        writeTestDb(join(fusionDir, "fusion.db"));

        try {
          const mockStore = createMockAutomationStore();
          mockStore.getSchedule.mockResolvedValue({
            ...FAKE_SCHEDULE,
            command: "fn backup --create",
          });
          const store = createMockStore({ getFusionDir: vi.fn().mockReturnValue(fusionDir) } as any);
          const app = express();
          app.use(express.json());
          app.use("/api", createApiRoutes(store, { automationStore: mockStore as any }));

          const runRes = await REQUEST(app, "POST", "/api/automations/sched-001/run");
          expect(runRes.status).toBe(200);
          expect(runRes.body.result.success).toBe(true);

          const streamRes = await performRequest(app, "GET", `/api/automations/sched-001/run/stream?runId=${runRes.body.liveRunId}`);
          expect(streamRes.status).toBe(200);
          const body = String(streamRes.body);
          const stepIndex = body.indexOf("event: step");
          const completeIndex = body.indexOf("event: complete");
          expect(stepIndex).toBeGreaterThanOrEqual(0);
          expect(completeIndex).toBeGreaterThan(stepIndex);
          expect(body).toContain("\"status\":\"started\"");
        } finally {
          rmSync(tempDir, { recursive: true, force: true });
        }
      });

      it("keeps memory-backup command parity on the manual run path", async () => {
        const tempDir = mkdtempSync(join(tmpdir(), "routes-automation-membackup-"));
        const fusionDir = join(tempDir, ".fusion");
        mkdirSync(fusionDir, { recursive: true });

        try {
          const mockStore = createMockAutomationStore();
          mockStore.getSchedule.mockResolvedValue({
            ...FAKE_SCHEDULE,
            command: "fn memory-backup --create",
          });
          const store = createMockStore({
            getFusionDir: vi.fn().mockReturnValue(fusionDir),
            getSettings: vi.fn().mockResolvedValue({ memoryEnabled: false }),
          } as any);
          const app = express();
          app.use(express.json());
          app.use("/api", createApiRoutes(store, { automationStore: mockStore as any }));
          mockExecFile.mockClear();

          const res = await REQUEST(app, "POST", "/api/automations/sched-001/run");

          expect(res.status).toBe(200);
          // Memory backups are a no-op success when memory is disabled; the important assertion is that
          // the in-process path ran (not a shell-out to a missing global binary).
          expect(typeof res.body.result.success).toBe("boolean");
          expect(mockExecFile).not.toHaveBeenCalledWith(
            expect.anything(),
            expect.arrayContaining([expect.stringContaining("memory-backup")]),
            expect.anything(),
            expect.anything(),
          );
        } finally {
          rmSync(tempDir, { recursive: true, force: true });
        }
      });
    });
  });

  describe("POST /automations/:id/toggle", () => {
    it("toggles enabled state", async () => {
      const mockStore = createMockAutomationStore();
      mockStore.getSchedule.mockResolvedValue({ ...FAKE_SCHEDULE, enabled: true });
      mockStore.updateSchedule.mockResolvedValue({ ...FAKE_SCHEDULE, enabled: false });
      const { app } = buildApp(mockStore);
      const res = await REQUEST(app, "POST", "/api/automations/sched-001/toggle");
      expect(res.status).toBe(200);
      expect(mockStore.updateSchedule).toHaveBeenCalledWith("sched-001", { enabled: false });
    });
  });

  // ── Scope-aware automation tests ─────────────────────────────────────

  describe("Scope-aware automation routes", () => {
    it("returns 400 for invalid scope value in query param", async () => {
      const { app } = buildApp();
      const res = await GET(app, "/api/automations?scope=invalid");
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Invalid scope value "invalid"');
    });

    it("returns 400 for invalid scope value in body", async () => {
      const { app } = buildApp();
      const res = await REQUEST(app, "POST", "/api/automations", JSON.stringify({
        name: "Test",
        command: "echo test",
        scheduleType: "hourly",
        scope: "invalid",
      }), { "Content-Type": "application/json" });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Invalid scope value "invalid"');
    });

    it("GET /automations filters by scope when scope=global is specified", async () => {
      const mockStore = createMockAutomationStore();
      const globalSchedule = { ...FAKE_SCHEDULE, scope: "global" as const };
      const projectSchedule = { ...FAKE_SCHEDULE, id: "sched-002", scope: "project" as const };
      mockStore.listSchedules.mockResolvedValue([globalSchedule, projectSchedule]);
      const { app } = buildApp(mockStore);
      const res = await GET(app, "/api/automations?scope=global");
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].scope).toBe("global");
    });

    it("GET /automations filters by scope when scope=project is specified", async () => {
      const mockStore = createMockAutomationStore();
      const globalSchedule = { ...FAKE_SCHEDULE, scope: "global" as const };
      const projectSchedule = { ...FAKE_SCHEDULE, id: "sched-002", scope: "project" as const };
      mockStore.listSchedules.mockResolvedValue([globalSchedule, projectSchedule]);
      const { app } = buildApp(mockStore);
      const res = await GET(app, "/api/automations?scope=project");
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].scope).toBe("project");
    });

    it("POST /automations creates schedule with project scope when scope=project is specified", async () => {
      const mockStore = createMockAutomationStore();
      const { app, automationStore } = buildApp(mockStore);
      const res = await REQUEST(app, "POST", "/api/automations", JSON.stringify({
        name: "Test",
        command: "echo test",
        scheduleType: "hourly",
        scope: "project",
      }), { "Content-Type": "application/json" });
      expect(res.status).toBe(201);
      expect(automationStore.createSchedule).toHaveBeenCalledWith(
        expect.objectContaining({ scope: "project" }),
      );
    });

    it("POST /automations creates schedule with global scope when scope=global is specified", async () => {
      const mockStore = createMockAutomationStore();
      const { app, automationStore } = buildApp(mockStore);
      const res = await REQUEST(app, "POST", "/api/automations", JSON.stringify({
        name: "Test",
        command: "echo test",
        scheduleType: "hourly",
        scope: "global",
      }), { "Content-Type": "application/json" });
      expect(res.status).toBe(201);
      expect(automationStore.createSchedule).toHaveBeenCalledWith(
        expect.objectContaining({ scope: "global" }),
      );
    });

    it("GET /automations/:id returns 404 for schedule with wrong scope", async () => {
      const mockStore = createMockAutomationStore();
      mockStore.getSchedule.mockResolvedValue({ ...FAKE_SCHEDULE, scope: "project" as const });
      const { app } = buildApp(mockStore);
      // Request with scope=global but schedule is project-scoped
      const res = await GET(app, "/api/automations/sched-001?scope=global");
      expect(res.status).toBe(404);
      expect(res.body.error).toContain("Schedule not found");
    });

    it("GET /automations/:id returns schedule when scope matches", async () => {
      const mockStore = createMockAutomationStore();
      mockStore.getSchedule.mockResolvedValue({ ...FAKE_SCHEDULE, scope: "global" as const });
      const { app } = buildApp(mockStore);
      const res = await GET(app, "/api/automations/sched-001?scope=global");
      expect(res.status).toBe(200);
      expect(res.body.id).toBe("sched-001");
    });

    it("PATCH /automations/:id returns 404 for schedule with wrong scope", async () => {
      const mockStore = createMockAutomationStore();
      mockStore.getSchedule.mockResolvedValue({ ...FAKE_SCHEDULE, scope: "project" as const });
      const { app } = buildApp(mockStore);
      const res = await REQUEST(app, "PATCH", "/api/automations/sched-001?scope=global", JSON.stringify({
        name: "Updated",
      }), { "Content-Type": "application/json" });
      expect(res.status).toBe(404);
      expect(res.body.error).toContain("Schedule not found");
    });

    it("DELETE /automations/:id returns 404 for schedule with wrong scope", async () => {
      const mockStore = createMockAutomationStore();
      mockStore.getSchedule.mockResolvedValue({ ...FAKE_SCHEDULE, scope: "project" as const });
      const { app } = buildApp(mockStore);
      const res = await REQUEST(app, "DELETE", "/api/automations/sched-001?scope=global");
      expect(res.status).toBe(404);
      expect(res.body.error).toContain("Schedule not found");
    });

    it("POST /automations/:id/run returns 404 for schedule with wrong scope", async () => {
      const mockStore = createMockAutomationStore();
      mockStore.getSchedule.mockResolvedValue({ ...FAKE_SCHEDULE, scope: "project" as const });
      const { app } = buildApp(mockStore);
      const res = await REQUEST(app, "POST", "/api/automations/sched-001/run?scope=global");
      expect(res.status).toBe(404);
      expect(res.body.error).toContain("Schedule not found");
    });

    it("POST /automations/:id/toggle returns 404 for schedule with wrong scope", async () => {
      const mockStore = createMockAutomationStore();
      mockStore.getSchedule.mockResolvedValue({ ...FAKE_SCHEDULE, scope: "project" as const });
      const { app } = buildApp(mockStore);
      const res = await REQUEST(app, "POST", "/api/automations/sched-001/toggle?scope=global");
      expect(res.status).toBe(404);
      expect(res.body.error).toContain("Schedule not found");
    });

    it("POST /automations/:id/steps/reorder returns 404 for schedule with wrong scope", async () => {
      const mockStore = createMockAutomationStore();
      mockStore.getSchedule.mockResolvedValue({ ...FAKE_SCHEDULE, scope: "project" as const });
      const { app } = buildApp(mockStore);
      const res = await REQUEST(app, "POST", "/api/automations/sched-001/steps/reorder?scope=global", JSON.stringify({
        stepIds: ["step-1", "step-2"],
      }), { "Content-Type": "application/json" });
      expect(res.status).toBe(404);
      expect(res.body.error).toContain("Schedule not found");
    });

    it("omitted scope defaults to project for POST /automations", async () => {
      const mockStore = createMockAutomationStore();
      const { app, automationStore } = buildApp(mockStore);
      const res = await REQUEST(app, "POST", "/api/automations", JSON.stringify({
        name: "Test",
        command: "echo test",
        scheduleType: "hourly",
        // No scope specified - should default to "project"
      }), { "Content-Type": "application/json" });
      expect(res.status).toBe(201);
      expect(automationStore.createSchedule).toHaveBeenCalledWith(
        expect.objectContaining({ scope: "project" }),
      );
    });

    it("omitted scope calls listSchedules without scope argument (legacy behavior)", async () => {
      const mockStore = createMockAutomationStore();
      const { app, automationStore } = buildApp(mockStore);
      const res = await GET(app, "/api/automations");
      expect(res.status).toBe(200);
      // Without scope, listSchedules should be called without scope argument
      expect(automationStore.listSchedules).toHaveBeenCalledWith();
    });

    // ── Additional scope regression coverage ──────────────────────

    it("POST /automations/:id/run with matching scope returns 200", async () => {
      const mockStore = createMockAutomationStore();
      mockStore.getSchedule.mockResolvedValue({ ...FAKE_SCHEDULE, scope: "global" as const });
      const { app } = buildApp(mockStore);
      const res = await REQUEST(app, "POST", "/api/automations/sched-001/run?scope=global");
      expect(res.status).toBe(200);
      expect(res.body.schedule).toBeDefined();
      expect(res.body.result).toBeDefined();
    });

    it("POST /automations/:id/run with scope mismatch returns 404", async () => {
      const mockStore = createMockAutomationStore();
      mockStore.getSchedule.mockResolvedValue({ ...FAKE_SCHEDULE, scope: "global" as const });
      const { app } = buildApp(mockStore);
      // Request with scope=project but schedule is global-scoped
      const res = await REQUEST(app, "POST", "/api/automations/sched-001/run?scope=project");
      expect(res.status).toBe(404);
      expect(res.body.error).toContain("Schedule not found");
    });

    it("POST /automations/:id/toggle with matching scope returns 200", async () => {
      const mockStore = createMockAutomationStore();
      mockStore.getSchedule.mockResolvedValue({ ...FAKE_SCHEDULE, scope: "project" as const });
      mockStore.updateSchedule.mockResolvedValue({ ...FAKE_SCHEDULE, scope: "project" as const, enabled: false });
      const { app } = buildApp(mockStore);
      const res = await REQUEST(app, "POST", "/api/automations/sched-001/toggle?scope=project");
      expect(res.status).toBe(200);
    });

    it("POST /automations/:id/toggle with scope mismatch returns 404", async () => {
      const mockStore = createMockAutomationStore();
      mockStore.getSchedule.mockResolvedValue({ ...FAKE_SCHEDULE, scope: "project" as const });
      const { app } = buildApp(mockStore);
      // Request with scope=global but schedule is project-scoped
      const res = await REQUEST(app, "POST", "/api/automations/sched-001/toggle?scope=global");
      expect(res.status).toBe(404);
      expect(res.body.error).toContain("Schedule not found");
    });

    it("POST /automations/:id/steps/reorder with matching scope returns 200", async () => {
      const mockStore = createMockAutomationStore();
      const scheduleWithSteps = {
        ...FAKE_SCHEDULE,
        scope: "global" as const,
        steps: [
          { id: "step-1", type: "command" as const, name: "Step 1", command: "echo 1" },
          { id: "step-2", type: "command" as const, name: "Step 2", command: "echo 2" },
        ],
      };
      mockStore.getSchedule.mockResolvedValue(scheduleWithSteps);
      mockStore.reorderSteps = vi.fn().mockResolvedValue(scheduleWithSteps);
      const { app } = buildApp(mockStore);
      const res = await REQUEST(app, "POST", "/api/automations/sched-001/steps/reorder?scope=global", JSON.stringify({
        stepIds: ["step-2", "step-1"],
      }), { "Content-Type": "application/json" });
      expect(res.status).toBe(200);
    });

    it("GET /automations returns all when scope is omitted (legacy)", async () => {
      const mockStore = createMockAutomationStore();
      const globalSchedule = { ...FAKE_SCHEDULE, id: "sched-001", scope: "global" as const };
      const projectSchedule = { ...FAKE_SCHEDULE, id: "sched-002", scope: "project" as const };
      mockStore.listSchedules.mockResolvedValue([globalSchedule, projectSchedule]);
      const { app } = buildApp(mockStore);
      const res = await GET(app, "/api/automations");
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
    });

    it("GET /automations returns empty array for scope with no matches", async () => {
      const mockStore = createMockAutomationStore();
      // Only project-scoped schedules exist
      const projectSchedule = { ...FAKE_SCHEDULE, scope: "project" as const };
      mockStore.listSchedules.mockResolvedValue([projectSchedule]);
      const { app } = buildApp(mockStore);
      // Filter by global scope, but only project schedules exist
      const res = await GET(app, "/api/automations?scope=global");
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(0);
    });

    // ── Cross-project isolation and fallback path tests ─────────────────

    it("cross-project isolation: scope=project never leaks global schedules into results", async () => {
      const mockStore = createMockAutomationStore();
      // Store returns mixed results
      const globalSchedule = { ...FAKE_SCHEDULE, id: "sched-global-1", scope: "global" as const };
      const projectSchedule = { ...FAKE_SCHEDULE, id: "sched-proj-a-1", scope: "project" as const };
      mockStore.listSchedules.mockResolvedValue([globalSchedule, projectSchedule]);
      const { app } = buildApp(mockStore);

      // Request for project scope (simulating proj-a request)
      const res = await GET(app, "/api/automations?scope=project");
      expect(res.status).toBe(200);
      // All results must be project-scoped - no leakage from global
      expect(res.body.every((s: any) => s.scope === "project")).toBe(true);
    });

    it("cross-project isolation: scope=global never includes project schedules", async () => {
      const mockStore = createMockAutomationStore();
      const globalSchedule = { ...FAKE_SCHEDULE, id: "sched-global-1", scope: "global" as const };
      const projectSchedule = { ...FAKE_SCHEDULE, id: "sched-proj-a-1", scope: "project" as const };
      mockStore.listSchedules.mockResolvedValue([globalSchedule, projectSchedule]);
      const { app } = buildApp(mockStore);

      // Request for global scope (simulating global request)
      const res = await GET(app, "/api/automations?scope=global");
      expect(res.status).toBe(200);
      // All results must be global-scoped - no leakage from project
      expect(res.body.every((s: any) => s.scope === "global")).toBe(true);
    });

    it("no opportunistic lane hopping: scope=project with empty results does not fall back to global", async () => {
      const mockStore = createMockAutomationStore();
      // Store only has global-scoped schedules
      const globalSchedule = { ...FAKE_SCHEDULE, id: "sched-global-1", scope: "global" as const };
      mockStore.listSchedules.mockResolvedValue([globalSchedule]);
      const { app } = buildApp(mockStore);

      // Request for project scope - should return empty, NOT switch to global
      const res = await GET(app, "/api/automations?scope=project");
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(0);
      // Results should NOT contain global schedules
      expect(res.body.some((s: any) => s.scope === "global")).toBe(false);
    });

    it("returns empty array when automation store unavailable (scope=project) - legacy fallback", async () => {
      // Build app WITHOUT automationStore option - routes return empty array for backward compatibility
      const store = createMockStore();
      const app = express();
      app.use(express.json());
      app.use("/api", createApiRoutes(store));

      const res = await GET(app, "/api/automations?scope=project");
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it("returns empty array when automation store unavailable (scope=global) - legacy fallback", async () => {
      // Build app WITHOUT automationStore option - routes return empty array for backward compatibility
      const store = createMockStore();
      const app = express();
      app.use(express.json());
      app.use("/api", createApiRoutes(store));

      const res = await GET(app, "/api/automations?scope=global");
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it("mutations with scope=project do not call global lane", async () => {
      const mockStore = createMockAutomationStore();
      mockStore.createSchedule.mockResolvedValue({ ...FAKE_SCHEDULE, id: "sched-proj-1", scope: "project" as const });
      const { app, automationStore } = buildApp(mockStore);

      const res = await REQUEST(app, "POST", "/api/automations", JSON.stringify({
        name: "Project Schedule",
        command: "echo project",
        scheduleType: "hourly",
        scope: "project",
      }), { "Content-Type": "application/json" });

      expect(res.status).toBe(201);
      // Verify scope was set to project (not global)
      expect(automationStore.createSchedule).toHaveBeenCalledWith(
        expect.objectContaining({ scope: "project" }),
      );
    });
  });
});

describe("Routine routes", () => {
  const FAKE_ROUTINE = {
    id: "routine-001",
    name: "Test Routine",
    description: "A test routine",
    trigger: { type: "cron" as const, cronExpression: "0 * * * *" },
    catchUpPolicy: "skip" as const,
    executionPolicy: "queue" as const,
    enabled: true,
    runCount: 0,
    runHistory: [] as RoutineExecutionResult[],
    nextRunAt: "2026-04-01T00:00:00.000Z",
    createdAt: "2026-03-30T00:00:00.000Z",
    updatedAt: "2026-03-30T00:00:00.000Z",
    scope: "project" as const,
  };

  function createMockRoutineStore() {
    return {
      listRoutines: vi.fn().mockResolvedValue([FAKE_ROUTINE]),
      createRoutine: vi.fn().mockResolvedValue(FAKE_ROUTINE),
      getRoutine: vi.fn().mockResolvedValue(FAKE_ROUTINE),
      updateRoutine: vi.fn().mockResolvedValue(FAKE_ROUTINE),
      deleteRoutine: vi.fn().mockResolvedValue(FAKE_ROUTINE),
      recordRun: vi.fn().mockResolvedValue(FAKE_ROUTINE),
      isValidCron: (expr: string) => expr === "0 * * * *",
    };
  }

  function createMockRoutineRunner() {
    return {
      triggerManual: vi.fn().mockImplementation(async (_id: string, liveCallbacks?: { onStep?: (data: Record<string, unknown>) => void; onText?: (delta: string) => void; onToolStart?: (name: string) => void; onToolEnd?: (name: string, isError: boolean, result?: unknown) => void }) => {
        liveCallbacks?.onStep?.({ stepIndex: 0, stepId: "step-1", stepName: "Mock step", status: "started" });
        liveCallbacks?.onToolStart?.("Read");
        liveCallbacks?.onText?.("routine-live-output");
        liveCallbacks?.onToolEnd?.("Read", false, "ok");
        liveCallbacks?.onStep?.({ stepIndex: 0, stepId: "step-1", stepName: "Mock step", status: "completed", success: true });
        return {
          routineId: "routine-001",
          success: true,
          output: "routine-live-output",
          triggerType: "cron" as const,
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        } satisfies RoutineExecutionResult;
      }),
      triggerWebhook: vi.fn().mockResolvedValue({
        routineId: "routine-001",
        success: true,
        output: "",
        triggerType: "webhook" as const,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      } satisfies RoutineExecutionResult),
    };
  }

  function buildRoutineApp(routineStoreOverride?: ReturnType<typeof createMockRoutineStore>) {
    const store = createMockStore();
    const routineStore = routineStoreOverride ?? createMockRoutineStore();
    const routineRunner = createMockRoutineRunner();
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store, { routineStore: routineStore as any, routineRunner }));
    return { app, routineStore, routineRunner };
  }

  describe("GET /routines", () => {
    it("returns all routines", async () => {
      const { app, routineStore } = buildRoutineApp();
      const res = await GET(app, "/api/routines");
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(routineStore.listRoutines).toHaveBeenCalledTimes(1);
    });

    it("returns empty array when no routineStore provided", async () => {
      const store = createMockStore();
      const app = express();
      app.use(express.json());
      app.use("/api", createApiRoutes(store));
      const res = await GET(app, "/api/routines");
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });
  });

  describe("POST /routines", () => {
    it("creates a routine with cron trigger", async () => {
      const { app, routineStore } = buildRoutineApp();
      const res = await REQUEST(app, "POST", "/api/routines", JSON.stringify({
        name: "Test",
        trigger: { type: "cron", cronExpression: "0 * * * *" },
      }), { "Content-Type": "application/json" });
      expect(res.status).toBe(201);
      expect(routineStore.createRoutine).toHaveBeenCalledTimes(1);
      expect(routineStore.createRoutine).toHaveBeenCalledWith(expect.objectContaining({
        name: "Test",
        trigger: { type: "cron", cronExpression: "0 * * * *" },
      }));
    });

    it("creates a routine with webhook trigger (requires secret)", async () => {
      const { app, routineStore } = buildRoutineApp();
      const res = await REQUEST(app, "POST", "/api/routines", JSON.stringify({
        name: "Webhook Routine",
        trigger: { type: "webhook", webhookPath: "/trigger/test", secret: "s".repeat(16) },
      }), { "Content-Type": "application/json" });
      expect(res.status).toBe(201);
      expect(routineStore.createRoutine).toHaveBeenCalledWith(expect.objectContaining({
        trigger: { type: "webhook", webhookPath: "/trigger/test", secret: "s".repeat(16) },
      }));
    });

    it("rejects a webhook trigger without a secret", async () => {
      const { app } = buildRoutineApp();
      const res = await REQUEST(app, "POST", "/api/routines", JSON.stringify({
        name: "Webhook Routine",
        trigger: { type: "webhook", webhookPath: "/trigger/test" },
      }), { "Content-Type": "application/json" });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("secret");
    });

    it("creates a routine with api trigger", async () => {
      const { app, routineStore } = buildRoutineApp();
      const res = await REQUEST(app, "POST", "/api/routines", JSON.stringify({
        name: "API Routine",
        trigger: { type: "api", endpoint: "/api/my-routine" },
      }), { "Content-Type": "application/json" });
      expect(res.status).toBe(201);
      expect(routineStore.createRoutine).toHaveBeenCalledWith(expect.objectContaining({
        trigger: { type: "api", endpoint: "/api/my-routine" },
      }));
    });

    it("returns 400 for missing name", async () => {
      const { app } = buildRoutineApp();
      const res = await REQUEST(app, "POST", "/api/routines", JSON.stringify({
        trigger: { type: "cron", cronExpression: "0 * * * *" },
      }), { "Content-Type": "application/json" });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Name is required");
    });

    it("returns 400 for missing trigger", async () => {
      const { app } = buildRoutineApp();
      const res = await REQUEST(app, "POST", "/api/routines", JSON.stringify({
        name: "Test",
      }), { "Content-Type": "application/json" });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Trigger is required");
    });

    it("returns 400 for invalid trigger type", async () => {
      const { app } = buildRoutineApp();
      const res = await REQUEST(app, "POST", "/api/routines", JSON.stringify({
        name: "Test",
        trigger: { type: "invalid" },
      }), { "Content-Type": "application/json" });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Invalid trigger type");
    });

    it("returns 400 for cron trigger without cronExpression", async () => {
      const { app } = buildRoutineApp();
      const res = await REQUEST(app, "POST", "/api/routines", JSON.stringify({
        name: "Test",
        trigger: { type: "cron" },
      }), { "Content-Type": "application/json" });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Cron expression is required");
    });

    it("returns 400 for invalid cron expression", async () => {
      const { app } = buildRoutineApp();
      const res = await REQUEST(app, "POST", "/api/routines", JSON.stringify({
        name: "Test",
        trigger: { type: "cron", cronExpression: "not-a-cron" },
      }), { "Content-Type": "application/json" });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Invalid cron expression");
    });

    it("returns 400 for invalid catchUpPolicy", async () => {
      const { app } = buildRoutineApp();
      const res = await REQUEST(app, "POST", "/api/routines", JSON.stringify({
        name: "Test",
        trigger: { type: "manual" },
        catchUpPolicy: "bad",
      }), { "Content-Type": "application/json" });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Invalid catchUpPolicy");
    });

    it("returns 400 for invalid executionPolicy", async () => {
      const { app } = buildRoutineApp();
      const res = await REQUEST(app, "POST", "/api/routines", JSON.stringify({
        name: "Test",
        trigger: { type: "manual" },
        executionPolicy: "bad",
      }), { "Content-Type": "application/json" });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Invalid executionPolicy");
    });

    it("returns 503 when routineStore not available", async () => {
      const store = createMockStore();
      const app = express();
      app.use(express.json());
      app.use("/api", createApiRoutes(store));
      const res = await REQUEST(app, "POST", "/api/routines", JSON.stringify({
        name: "Test",
        trigger: { type: "manual" },
      }), { "Content-Type": "application/json" });
      expect(res.status).toBe(503);
    });
  });

  describe("GET /routines/:id", () => {
    it("returns a routine by id", async () => {
      const { app } = buildRoutineApp();
      const res = await GET(app, "/api/routines/routine-001");
      expect(res.status).toBe(200);
      expect(res.body.id).toBe("routine-001");
    });

    it("returns 404 for missing routine", async () => {
      const mockStore = createMockRoutineStore();
      mockStore.getRoutine.mockRejectedValue(Object.assign(new Error("not found"), { code: "ENOENT" }));
      const { app } = buildRoutineApp(mockStore);
      const res = await GET(app, "/api/routines/missing");
      expect(res.status).toBe(404);
    });

    it("returns 503 when routineStore not available", async () => {
      const store = createMockStore();
      const app = express();
      app.use(express.json());
      app.use("/api", createApiRoutes(store));
      const res = await GET(app, "/api/routines/routine-001");
      expect(res.status).toBe(503);
    });
  });

  describe("PATCH /routines/:id", () => {
    it("updates a routine", async () => {
      const { app, routineStore } = buildRoutineApp();
      const res = await REQUEST(app, "PATCH", "/api/routines/routine-001", JSON.stringify({
        name: "Updated",
      }), { "Content-Type": "application/json" });
      expect(res.status).toBe(200);
      expect(routineStore.updateRoutine).toHaveBeenCalledWith("routine-001", expect.objectContaining({ name: "Updated" }));
    });

    it("returns 404 for missing routine", async () => {
      const mockStore = createMockRoutineStore();
      mockStore.updateRoutine.mockRejectedValue(Object.assign(new Error("not found"), { code: "ENOENT" }));
      const { app } = buildRoutineApp(mockStore);
      const res = await REQUEST(app, "PATCH", "/api/routines/missing", JSON.stringify({
        name: "Updated",
      }), { "Content-Type": "application/json" });
      expect(res.status).toBe(404);
    });

    it("returns 400 for invalid trigger type in update", async () => {
      const { app } = buildRoutineApp();
      const res = await REQUEST(app, "PATCH", "/api/routines/routine-001", JSON.stringify({
        trigger: { type: "bad" },
      }), { "Content-Type": "application/json" });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Invalid trigger type");
    });

    it("returns 400 for empty name in update", async () => {
      const { app } = buildRoutineApp();
      const res = await REQUEST(app, "PATCH", "/api/routines/routine-001", JSON.stringify({
        name: "",
      }), { "Content-Type": "application/json" });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Name cannot be empty");
    });

    it("returns 503 when routineStore not available", async () => {
      const store = createMockStore();
      const app = express();
      app.use(express.json());
      app.use("/api", createApiRoutes(store));
      const res = await REQUEST(app, "PATCH", "/api/routines/routine-001", JSON.stringify({
        name: "Updated",
      }), { "Content-Type": "application/json" });
      expect(res.status).toBe(503);
    });
  });

  describe("DELETE /routines/:id", () => {
    it("deletes a routine", async () => {
      const { app, routineStore } = buildRoutineApp();
      const res = await REQUEST(app, "DELETE", "/api/routines/routine-001");
      expect(res.status).toBe(200);
      expect(routineStore.deleteRoutine).toHaveBeenCalledWith("routine-001");
    });

    it("returns 404 for missing routine", async () => {
      const mockStore = createMockRoutineStore();
      mockStore.deleteRoutine.mockRejectedValue(Object.assign(new Error("not found"), { code: "ENOENT" }));
      const { app } = buildRoutineApp(mockStore);
      const res = await REQUEST(app, "DELETE", "/api/routines/missing");
      expect(res.status).toBe(404);
    });

    it("returns 503 when routineStore not available", async () => {
      const store = createMockStore();
      const app = express();
      app.use(express.json());
      app.use("/api", createApiRoutes(store));
      const res = await REQUEST(app, "DELETE", "/api/routines/routine-001");
      expect(res.status).toBe(503);
    });
  });

  describe("POST /routines/:id/run", () => {
    it("runs a routine via RoutineRunner.triggerManual (double-persist fix)", async () => {
      const mockStore = createMockRoutineStore();
      const { app, routineRunner } = buildRoutineApp(mockStore);
      const res = await REQUEST(app, "POST", "/api/routines/routine-001/run");
      expect(res.status).toBe(200);
      expect(res.body.result).toBeDefined();
      expect(res.body.result.triggerType).toBe("cron");
      // Verify triggerManual was called (persistence handled by RoutineRunner)
      expect(routineRunner.triggerManual).toHaveBeenCalledWith("routine-001", expect.any(Object));
      // Verify recordRun was NOT called (double-persist fix)
      expect(mockStore.recordRun).not.toHaveBeenCalled();
    });

    it("streams buffered live events for completed routine manual runs", async () => {
      const mockStore = createMockRoutineStore();
      const { app } = buildRoutineApp(mockStore);

      const runRes = await REQUEST(app, "POST", "/api/routines/routine-001/run");
      expect(runRes.status).toBe(200);
      expect(runRes.body.liveRunId).toBeTruthy();

      const streamRes = await performRequest(app, "GET", `/api/routines/routine-001/run/stream?runId=${runRes.body.liveRunId}`);
      expect(streamRes.status).toBe(200);
      const body = String(streamRes.body);
      expect(body).toContain("event: step");
      expect(body).toContain("event: output");
      expect(body).toContain("routine-live-output");
      expect(body).toContain("event: tool");
      expect(body).toContain("event: complete");
      expect(runRes.body.result.output).toBe("routine-live-output");
    });

    it("returns 404 for missing routine", async () => {
      const mockStore = createMockRoutineStore();
      mockStore.getRoutine.mockRejectedValue(Object.assign(new Error("not found"), { code: "ENOENT" }));
      const { app } = buildRoutineApp(mockStore);
      const res = await REQUEST(app, "POST", "/api/routines/missing/run");
      expect(res.status).toBe(404);
    });

    it("returns 503 when routineStore not available", async () => {
      const store = createMockStore();
      const app = express();
      app.use(express.json());
      app.use("/api", createApiRoutes(store));
      const res = await REQUEST(app, "POST", "/api/routines/routine-001/run");
      expect(res.status).toBe(503);
    });

    it("returns 400 when routine is disabled", async () => {
      const mockStore = createMockRoutineStore();
      mockStore.getRoutine.mockResolvedValue({
        ...FAKE_ROUTINE,
        enabled: false,
      });
      const { app } = buildRoutineApp(mockStore);
      const res = await REQUEST(app, "POST", "/api/routines/routine-001/run");
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("disabled");
    });

    it("returns 503 when routineRunner not available", async () => {
      const store = createMockStore();
      const routineStore = createMockRoutineStore();
      const app = express();
      app.use(express.json());
      app.use("/api", createApiRoutes(store, { routineStore: routineStore as any }));
      const res = await REQUEST(app, "POST", "/api/routines/routine-001/run");
      expect(res.status).toBe(503);
    });
  });

  describe("POST /routines/:id/trigger", () => {
    it("returns 200 with routine and result on success", async () => {
      const mockStore = createMockRoutineStore();
      const { app, routineRunner } = buildRoutineApp(mockStore);
      const res = await REQUEST(app, "POST", "/api/routines/routine-001/trigger");
      expect(res.status).toBe(200);
      expect(res.body.routine).toBeDefined();
      expect(res.body.result).toBeDefined();
      expect(routineRunner.triggerManual).toHaveBeenCalledWith("routine-001", expect.any(Object));
    });

    it("returns 404 for missing routine (ENOENT)", async () => {
      const mockStore = createMockRoutineStore();
      mockStore.getRoutine.mockRejectedValue(Object.assign(new Error("not found"), { code: "ENOENT" }));
      const { app } = buildRoutineApp(mockStore);
      const res = await REQUEST(app, "POST", "/api/routines/missing/trigger");
      expect(res.status).toBe(404);
    });

    it("returns 400 for disabled routine", async () => {
      const mockStore = createMockRoutineStore();
      mockStore.getRoutine.mockResolvedValue({
        ...FAKE_ROUTINE,
        enabled: false,
      });
      const { app } = buildRoutineApp(mockStore);
      const res = await REQUEST(app, "POST", "/api/routines/routine-001/trigger");
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("disabled");
    });

    it("returns 503 when routineStore not available", async () => {
      const store = createMockStore();
      const app = express();
      app.use(express.json());
      app.use("/api", createApiRoutes(store));
      const res = await REQUEST(app, "POST", "/api/routines/routine-001/trigger");
      expect(res.status).toBe(503);
    });

    it("returns 503 when routineRunner not available", async () => {
      const store = createMockStore();
      const routineStore = createMockRoutineStore();
      const app = express();
      app.use(express.json());
      app.use("/api", createApiRoutes(store, { routineStore: routineStore as any }));
      const res = await REQUEST(app, "POST", "/api/routines/routine-001/trigger");
      expect(res.status).toBe(503);
    });

    it("does NOT call recordRun (double-persist fix)", async () => {
      const mockStore = createMockRoutineStore();
      const { app } = buildRoutineApp(mockStore);
      await REQUEST(app, "POST", "/api/routines/routine-001/trigger");
      expect(mockStore.recordRun).not.toHaveBeenCalled();
    });
  });

  describe("GET /routines/:id/runs", () => {
    it("returns run history", async () => {
      const mockStore = createMockRoutineStore();
      mockStore.getRoutine.mockResolvedValue({
        ...FAKE_ROUTINE,
        runHistory: [
          { routineId: "routine-001", startedAt: "2026-03-30T00:00:00.000Z", completedAt: "2026-03-30T00:01:00.000Z", success: true, output: "Test" },
        ],
      });
      const { app } = buildRoutineApp(mockStore);
      const res = await GET(app, "/api/routines/routine-001/runs");
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
    });

    it("returns 404 for missing routine", async () => {
      const mockStore = createMockRoutineStore();
      mockStore.getRoutine.mockRejectedValue(Object.assign(new Error("not found"), { code: "ENOENT" }));
      const { app } = buildRoutineApp(mockStore);
      const res = await GET(app, "/api/routines/missing/runs");
      expect(res.status).toBe(404);
    });

    it("returns 503 when routineStore not available", async () => {
      const store = createMockStore();
      const app = express();
      app.use(express.json());
      app.use("/api", createApiRoutes(store));
      const res = await GET(app, "/api/routines/routine-001/runs");
      expect(res.status).toBe(503);
    });
  });

  describe("POST /routines/:id/webhook", () => {
    function buildRoutineApp(routineStoreOverride?: ReturnType<typeof createMockRoutineStore>) {
      const store = createMockStore();
      const routineStore = routineStoreOverride ?? createMockRoutineStore();
      const routineRunner = createMockRoutineRunner();
      const app = express();
      app.use(express.json());
      app.use("/api", createApiRoutes(store, { routineStore: routineStore as any, routineRunner }));
      return { app, routineStore, routineRunner };
    }

    it("rejects a webhook trigger on a routine without a secret", async () => {
      // Webhook routines persisted before the secret requirement are still
      // accepted as stored objects but must be refused at trigger time —
      // otherwise unauthenticated callers could execute them.
      const mockStore = createMockRoutineStore();
      mockStore.getRoutine.mockResolvedValue({
        ...FAKE_ROUTINE,
        trigger: { type: "webhook" as const, webhookPath: "/trigger/test" },
      });
      const { app, routineRunner } = buildRoutineApp(mockStore);
      const res = await REQUEST(app, "POST", "/api/routines/routine-001/webhook", JSON.stringify({}), { "Content-Type": "application/json" });
      expect(res.status).toBe(401);
      expect(routineRunner.triggerWebhook).not.toHaveBeenCalled();
      expect(mockStore.recordRun).not.toHaveBeenCalled();
    });

    it("returns 400 when routine is not a webhook type", async () => {
      const mockStore = createMockRoutineStore();
      mockStore.getRoutine.mockResolvedValue({
        ...FAKE_ROUTINE,
        trigger: { type: "cron" as const, cronExpression: "0 * * * *" },
      });
      const { app } = buildRoutineApp(mockStore);
      const res = await REQUEST(app, "POST", "/api/routines/routine-001/webhook", JSON.stringify({}), { "Content-Type": "application/json" });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("webhook triggers");
    });

    it("returns 400 when routine is disabled", async () => {
      const mockStore = createMockRoutineStore();
      mockStore.getRoutine.mockResolvedValue({
        ...FAKE_ROUTINE,
        enabled: false,
        trigger: { type: "webhook" as const, webhookPath: "/trigger/test" },
      });
      const { app } = buildRoutineApp(mockStore);
      const res = await REQUEST(app, "POST", "/api/routines/routine-001/webhook", JSON.stringify({}), { "Content-Type": "application/json" });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("disabled");
    });

    it("returns 404 for missing routine", async () => {
      const mockStore = createMockRoutineStore();
      mockStore.getRoutine.mockRejectedValue(Object.assign(new Error("not found"), { code: "ENOENT" }));
      const { app } = buildRoutineApp(mockStore);
      const res = await REQUEST(app, "POST", "/api/routines/missing/webhook", JSON.stringify({}), { "Content-Type": "application/json" });
      expect(res.status).toBe(404);
    });

    it("returns 503 when routineStore not available", async () => {
      const store = createMockStore();
      const app = express();
      app.use(express.json());
      app.use("/api", createApiRoutes(store));
      const res = await REQUEST(app, "POST", "/api/routines/routine-001/webhook", JSON.stringify({}), { "Content-Type": "application/json" });
      expect(res.status).toBe(503);
    });

    it("refuses webhook routines that are missing a secret", async () => {
      const mockStore = createMockRoutineStore();
      mockStore.getRoutine.mockResolvedValue({
        ...FAKE_ROUTINE,
        trigger: { type: "webhook" as const, webhookPath: "/trigger/test" },
      });
      const { app } = buildRoutineApp(mockStore);
      const res = await REQUEST(app, "POST", "/api/routines/routine-001/webhook", JSON.stringify({}), { "Content-Type": "application/json" });
      expect(res.status).toBe(401);
    });

    it("returns 401 when secret is configured but signature header is missing (was 403)", async () => {
      const mockStore = createMockRoutineStore();
      mockStore.getRoutine.mockResolvedValue({
        ...FAKE_ROUTINE,
        trigger: { type: "webhook" as const, webhookPath: "/trigger/test", secret: "test-secret" },
      });
      // Set up rawBody via middleware so the route doesn't return 400 for missing rawBody
      const store = createMockStore();
      const routineStore = mockStore;
      const routineRunner = createMockRoutineRunner();
      const testApp = express();
      testApp.use(express.json());
      testApp.use((req, _res, next) => {
        // Simulate rawBody being set by middleware
        (req as any).rawBody = Buffer.from("{}");
        next();
      });
      testApp.use("/api", createApiRoutes(store, { routineStore: routineStore as any, routineRunner }));
      const res = await REQUEST(testApp, "POST", "/api/routines/routine-001/webhook", JSON.stringify({}), { "Content-Type": "application/json" });
      expect(res.status).toBe(401);
      expect(res.body.error).toContain("Missing signature header");
    });
  });

  // Note: The "invalid signature" webhook auth test is skipped because:
  // - vi.doMock persists across test files in the same worker
  // - The missing signature header test already verifies 401 behavior
  // - The Webhook HMAC verification tests verify verifyWebhookSignature works correctly
  // - Route-level 401 status code change is verified by the missing signature test

  describe("Webhook HMAC verification", () => {
    // These tests verify the verifyWebhookSignature function directly
    // since testing through HTTP requires complex middleware setup
    it("verifyWebhookSignature rejects missing signature header", async () => {
      const { verifyWebhookSignature } = await import("../github-webhooks.js");
      const result = verifyWebhookSignature(Buffer.from("{}"), undefined, "secret");
      expect(result.valid).toBe(false);
      expect(result.error).toBe("Missing signature header");
    });

    it("verifyWebhookSignature rejects wrong signature", async () => {
      const { verifyWebhookSignature } = await import("../github-webhooks.js");
      const body = Buffer.from('{"test":true}');
      const result = verifyWebhookSignature(body, "sha256=deadbeef", "secret");
      expect(result.valid).toBe(false);
      expect(result.error).toBe("Signature mismatch");
    });

    it("verifyWebhookSignature accepts valid HMAC", async () => {
      const { verifyWebhookSignature } = await import("../github-webhooks.js");
      const secret = "test-secret";
      const body = Buffer.from('{"test":true}');
      const sig = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
      const result = verifyWebhookSignature(body, sig, secret);
      expect(result.valid).toBe(true);
    });
  });

  // ── Scope-aware routine tests ─────────────────────────────────────

  describe("Scope-aware routine routes", () => {
    it("returns 400 for invalid scope value in query param", async () => {
      const { app } = buildRoutineApp();
      const res = await GET(app, "/api/routines?scope=invalid");
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Invalid scope value "invalid"');
    });

    it("returns 400 for invalid scope value in body", async () => {
      const { app } = buildRoutineApp();
      const res = await REQUEST(app, "POST", "/api/routines", JSON.stringify({
        name: "Test",
        trigger: { type: "cron", cronExpression: "0 * * * *" },
        scope: "invalid",
      }), { "Content-Type": "application/json" });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Invalid scope value "invalid"');
    });

    it("GET /routines filters by scope when scope=global is specified", async () => {
      const mockStore = createMockRoutineStore();
      const globalRoutine = { ...FAKE_ROUTINE, scope: "global" as const };
      const projectRoutine = { ...FAKE_ROUTINE, id: "routine-002", scope: "project" as const };
      mockStore.listRoutines.mockResolvedValue([globalRoutine, projectRoutine]);
      const { app } = buildRoutineApp(mockStore);
      const res = await GET(app, "/api/routines?scope=global");
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].scope).toBe("global");
    });

    it("GET /routines filters by scope when scope=project is specified", async () => {
      const mockStore = createMockRoutineStore();
      const globalRoutine = { ...FAKE_ROUTINE, scope: "global" as const };
      const projectRoutine = { ...FAKE_ROUTINE, id: "routine-002", scope: "project" as const };
      mockStore.listRoutines.mockResolvedValue([globalRoutine, projectRoutine]);
      const { app } = buildRoutineApp(mockStore);
      const res = await GET(app, "/api/routines?scope=project");
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].scope).toBe("project");
    });

    it("POST /routines creates routine with project scope when scope=project is specified", async () => {
      const mockStore = createMockRoutineStore();
      const { app, routineStore } = buildRoutineApp(mockStore);
      const res = await REQUEST(app, "POST", "/api/routines", JSON.stringify({
        name: "Test",
        trigger: { type: "cron", cronExpression: "0 * * * *" },
        scope: "project",
      }), { "Content-Type": "application/json" });
      expect(res.status).toBe(201);
      expect(routineStore.createRoutine).toHaveBeenCalledWith(
        expect.objectContaining({ scope: "project" }),
      );
    });

    it("POST /routines creates routine with global scope when scope=global is specified", async () => {
      const mockStore = createMockRoutineStore();
      const { app, routineStore } = buildRoutineApp(mockStore);
      const res = await REQUEST(app, "POST", "/api/routines", JSON.stringify({
        name: "Test",
        trigger: { type: "cron", cronExpression: "0 * * * *" },
        scope: "global",
      }), { "Content-Type": "application/json" });
      expect(res.status).toBe(201);
      expect(routineStore.createRoutine).toHaveBeenCalledWith(
        expect.objectContaining({ scope: "global" }),
      );
    });

    it("GET /routines/:id returns 404 for routine with wrong scope", async () => {
      const mockStore = createMockRoutineStore();
      mockStore.getRoutine.mockResolvedValue({ ...FAKE_ROUTINE, scope: "project" as const });
      const { app } = buildRoutineApp(mockStore);
      // Request with scope=global but routine is project-scoped
      const res = await GET(app, "/api/routines/routine-001?scope=global");
      expect(res.status).toBe(404);
      expect(res.body.error).toContain("Routine not found");
    });

    it("GET /routines/:id returns routine when scope matches", async () => {
      const mockStore = createMockRoutineStore();
      mockStore.getRoutine.mockResolvedValue({ ...FAKE_ROUTINE, scope: "global" as const });
      const { app } = buildRoutineApp(mockStore);
      const res = await GET(app, "/api/routines/routine-001?scope=global");
      expect(res.status).toBe(200);
      expect(res.body.id).toBe("routine-001");
    });

    it("PATCH /routines/:id returns 404 for routine with wrong scope", async () => {
      const mockStore = createMockRoutineStore();
      mockStore.getRoutine.mockResolvedValue({ ...FAKE_ROUTINE, scope: "project" as const });
      const { app } = buildRoutineApp(mockStore);
      const res = await REQUEST(app, "PATCH", "/api/routines/routine-001?scope=global", JSON.stringify({
        name: "Updated",
      }), { "Content-Type": "application/json" });
      expect(res.status).toBe(404);
      expect(res.body.error).toContain("Routine not found");
    });

    it("DELETE /routines/:id returns 404 for routine with wrong scope", async () => {
      const mockStore = createMockRoutineStore();
      mockStore.getRoutine.mockResolvedValue({ ...FAKE_ROUTINE, scope: "project" as const });
      const { app } = buildRoutineApp(mockStore);
      const res = await REQUEST(app, "DELETE", "/api/routines/routine-001?scope=global");
      expect(res.status).toBe(404);
      expect(res.body.error).toContain("Routine not found");
    });

    it("POST /routines/:id/run returns 404 for routine with wrong scope", async () => {
      const mockStore = createMockRoutineStore();
      mockStore.getRoutine.mockResolvedValue({ ...FAKE_ROUTINE, scope: "project" as const });
      const { app } = buildRoutineApp(mockStore);
      const res = await REQUEST(app, "POST", "/api/routines/routine-001/run?scope=global");
      expect(res.status).toBe(404);
      expect(res.body.error).toContain("Routine not found");
    });

    it("POST /routines/:id/trigger returns 404 for routine with wrong scope", async () => {
      const mockStore = createMockRoutineStore();
      mockStore.getRoutine.mockResolvedValue({ ...FAKE_ROUTINE, scope: "project" as const });
      const { app } = buildRoutineApp(mockStore);
      const res = await REQUEST(app, "POST", "/api/routines/routine-001/trigger?scope=global");
      expect(res.status).toBe(404);
      expect(res.body.error).toContain("Routine not found");
    });

    it("GET /routines/:id/runs returns 404 for routine with wrong scope", async () => {
      const mockStore = createMockRoutineStore();
      mockStore.getRoutine.mockResolvedValue({ ...FAKE_ROUTINE, scope: "project" as const });
      const { app } = buildRoutineApp(mockStore);
      const res = await GET(app, "/api/routines/routine-001/runs?scope=global");
      expect(res.status).toBe(404);
      expect(res.body.error).toContain("Routine not found");
    });

    it("omitted scope defaults to project for POST /routines", async () => {
      const mockStore = createMockRoutineStore();
      const { app, routineStore } = buildRoutineApp(mockStore);
      const res = await REQUEST(app, "POST", "/api/routines", JSON.stringify({
        name: "Test",
        trigger: { type: "cron", cronExpression: "0 * * * *" },
        // No scope specified - should default to "project"
      }), { "Content-Type": "application/json" });
      expect(res.status).toBe(201);
      expect(routineStore.createRoutine).toHaveBeenCalledWith(
        expect.objectContaining({ scope: "project" }),
      );
    });

    it("omitted scope calls listRoutines without scope argument (legacy behavior)", async () => {
      const mockStore = createMockRoutineStore();
      const { app, routineStore } = buildRoutineApp(mockStore);
      const res = await GET(app, "/api/routines");
      expect(res.status).toBe(200);
      // Without scope, listRoutines should be called without scope argument
      expect(routineStore.listRoutines).toHaveBeenCalledWith();
    });

    // ── Additional scope regression coverage ──────────────────────

    it("POST /routines/:id/webhook is scope-independent (webhooks use routine's own scope)", async () => {
      // Webhooks should NOT filter by request scope params - they use the routine's own scope.
      // Use a secret-configured trigger with a matching HMAC signature so the
      // request passes the authentication gate regardless of scope.
      const secret = "test-secret-test-secret";
      const payload = JSON.stringify({});
      const signature =
        "sha256=" +
        createHmac("sha256", secret).update(payload).digest("hex");

      const mockStore = createMockRoutineStore();
      mockStore.getRoutine.mockResolvedValue({
        ...FAKE_ROUTINE,
        scope: "project" as const,
        trigger: { type: "webhook" as const, webhookPath: "/trigger/test", secret },
      });
      const store = createMockStore();
      const routineRunner = createMockRoutineRunner();
      const testApp = express();
      testApp.use(express.json());
      testApp.use((req, _res, next) => {
        (req as any).rawBody = Buffer.from(payload);
        next();
      });
      testApp.use("/api", createApiRoutes(store, { routineStore: mockStore as any, routineRunner }));
      const res = await REQUEST(
        testApp,
        "POST",
        "/api/routines/routine-001/webhook",
        payload,
        { "Content-Type": "application/json", "x-hub-signature-256": signature },
      );
      expect(res.status).toBe(200);
      expect(res.body.result).toBeDefined();
      expect(routineRunner.triggerWebhook).toHaveBeenCalled();
    });

    it("POST /routines/:id/trigger with matching scope returns 200", async () => {
      const mockStore = createMockRoutineStore();
      mockStore.getRoutine.mockResolvedValue({ ...FAKE_ROUTINE, scope: "global" as const });
      const { app, routineRunner } = buildRoutineApp(mockStore);
      const res = await REQUEST(app, "POST", "/api/routines/routine-001/trigger?scope=global");
      expect(res.status).toBe(200);
      expect(res.body.routine).toBeDefined();
      expect(res.body.result).toBeDefined();
      expect(routineRunner.triggerManual).toHaveBeenCalledWith("routine-001", expect.any(Object));
    });

    it("POST /routines/:id/trigger with scope mismatch returns 404", async () => {
      const mockStore = createMockRoutineStore();
      mockStore.getRoutine.mockResolvedValue({ ...FAKE_ROUTINE, scope: "global" as const });
      const { app } = buildRoutineApp(mockStore);
      // Request with scope=project but routine is global-scoped
      const res = await REQUEST(app, "POST", "/api/routines/routine-001/trigger?scope=project");
      expect(res.status).toBe(404);
      expect(res.body.error).toContain("Routine not found");
    });

    it("GET /routines/:id/runs with matching scope returns 200", async () => {
      const mockStore = createMockRoutineStore();
      mockStore.getRoutine.mockResolvedValue({
        ...FAKE_ROUTINE,
        scope: "project" as const,
        runHistory: [
          { routineId: "routine-001", startedAt: "2026-03-30T00:00:00.000Z", completedAt: "2026-03-30T00:01:00.000Z", success: true, output: "Test" },
        ],
      });
      const { app } = buildRoutineApp(mockStore);
      const res = await GET(app, "/api/routines/routine-001/runs?scope=project");
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
    });

    it("GET /routines returns all when scope is omitted (legacy)", async () => {
      const mockStore = createMockRoutineStore();
      const globalRoutine = { ...FAKE_ROUTINE, id: "routine-001", scope: "global" as const };
      const projectRoutine = { ...FAKE_ROUTINE, id: "routine-002", scope: "project" as const };
      mockStore.listRoutines.mockResolvedValue([globalRoutine, projectRoutine]);
      const { app } = buildRoutineApp(mockStore);
      const res = await GET(app, "/api/routines");
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
    });

    it("GET /routines returns empty array for scope with no matches", async () => {
      const mockStore = createMockRoutineStore();
      // Only global-scoped routines exist
      const globalRoutine = { ...FAKE_ROUTINE, scope: "global" as const };
      mockStore.listRoutines.mockResolvedValue([globalRoutine]);
      const { app } = buildRoutineApp(mockStore);
      // Filter by project scope, but only global routines exist
      const res = await GET(app, "/api/routines?scope=project");
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(0);
    });

    // ── Cross-project isolation and fallback path tests ─────────────────

    it("cross-project isolation: scope=project never leaks global routines into results", async () => {
      const mockStore = createMockRoutineStore();
      // Store returns mixed results
      const globalRoutine = { ...FAKE_ROUTINE, id: "routine-global-1", scope: "global" as const };
      const projectRoutine = { ...FAKE_ROUTINE, id: "routine-proj-a-1", scope: "project" as const };
      mockStore.listRoutines.mockResolvedValue([globalRoutine, projectRoutine]);
      const { app } = buildRoutineApp(mockStore);

      // Request for project scope (simulating proj-a request)
      const res = await GET(app, "/api/routines?scope=project");
      expect(res.status).toBe(200);
      // All results must be project-scoped - no leakage from global
      expect(res.body.every((r: any) => r.scope === "project")).toBe(true);
    });

    it("cross-project isolation: scope=global never includes project routines", async () => {
      const mockStore = createMockRoutineStore();
      const globalRoutine = { ...FAKE_ROUTINE, id: "routine-global-1", scope: "global" as const };
      const projectRoutine = { ...FAKE_ROUTINE, id: "routine-proj-a-1", scope: "project" as const };
      mockStore.listRoutines.mockResolvedValue([globalRoutine, projectRoutine]);
      const { app } = buildRoutineApp(mockStore);

      // Request for global scope (simulating global request)
      const res = await GET(app, "/api/routines?scope=global");
      expect(res.status).toBe(200);
      // All results must be global-scoped - no leakage from project
      expect(res.body.every((r: any) => r.scope === "global")).toBe(true);
    });

    it("no opportunistic lane hopping: scope=project with empty results does not fall back to global", async () => {
      const mockStore = createMockRoutineStore();
      // Store only has global-scoped routines
      const globalRoutine = { ...FAKE_ROUTINE, id: "routine-global-1", scope: "global" as const };
      mockStore.listRoutines.mockResolvedValue([globalRoutine]);
      const { app } = buildRoutineApp(mockStore);

      // Request for project scope - should return empty, NOT switch to global
      const res = await GET(app, "/api/routines?scope=project");
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(0);
      // Results should NOT contain global routines
      expect(res.body.some((r: any) => r.scope === "global")).toBe(false);
    });

    it("returns empty array when routine store unavailable (scope=project) - legacy fallback", async () => {
      // Build app WITHOUT routineStore option - routes return empty array for backward compatibility
      const store = createMockStore();
      const app = express();
      app.use(express.json());
      app.use("/api", createApiRoutes(store));

      const res = await GET(app, "/api/routines?scope=project");
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it("returns empty array when routine store unavailable (scope=global) - legacy fallback", async () => {
      // Build app WITHOUT routineStore option - routes return empty array for backward compatibility
      const store = createMockStore();
      const app = express();
      app.use(express.json());
      app.use("/api", createApiRoutes(store));

      const res = await GET(app, "/api/routines?scope=global");
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it("mutations with scope=project do not call global lane", async () => {
      const mockStore = createMockRoutineStore();
      mockStore.createRoutine.mockResolvedValue({ ...FAKE_ROUTINE, id: "routine-proj-1", scope: "project" as const });
      const { app, routineStore } = buildRoutineApp(mockStore);

      const res = await REQUEST(app, "POST", "/api/routines", JSON.stringify({
        name: "Project Routine",
        trigger: { type: "cron", cronExpression: "0 * * * *" },
        scope: "project",
      }), { "Content-Type": "application/json" });

      expect(res.status).toBe(201);
      // Verify scope was set to project (not global)
      expect(routineStore.createRoutine).toHaveBeenCalledWith(
        expect.objectContaining({ scope: "project" }),
      );
    });

    it("POST /routines/:id/run with scope mismatch does NOT call RoutineRunner", async () => {
      const mockStore = createMockRoutineStore();
      const { app, routineRunner } = buildRoutineApp(mockStore);
      // Routine is global-scoped
      mockStore.getRoutine.mockResolvedValue({ ...FAKE_ROUTINE, scope: "global" as const });

      // Request with scope=project but routine is global
      const res = await REQUEST(app, "POST", "/api/routines/routine-001/run?scope=project");

      expect(res.status).toBe(404);
      // RoutineRunner should NOT be called for mismatched scope
      expect(routineRunner.triggerManual).not.toHaveBeenCalled();
    });

    it("POST /routines/:id/run when routine is disabled returns 400", async () => {
      const mockStore = createMockRoutineStore();
      // Set scope to project to match the default FAKE_ROUTINE scope
      mockStore.getRoutine.mockResolvedValue({ ...FAKE_ROUTINE, scope: "project" as const, enabled: false });
      const { app, routineRunner } = buildRoutineApp(mockStore);

      // Request without scope (defaults to project which matches the routine's scope)
      const res = await REQUEST(app, "POST", "/api/routines/routine-001/run");

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("disabled");
      // RoutineRunner should NOT be called when routine is disabled
      expect(routineRunner.triggerManual).not.toHaveBeenCalled();
    });

    it("POST /routines/:id/run when RoutineRunner unavailable returns 503", async () => {
      const mockStore = createMockRoutineStore();
      mockStore.getRoutine.mockResolvedValue({ ...FAKE_ROUTINE });
      // Build app without routineRunner option
      const store = createMockStore();
      const app = express();
      app.use(express.json());
      app.use("/api", createApiRoutes(store, { routineStore: mockStore as any }));

      const res = await REQUEST(app, "POST", "/api/routines/routine-001/run?scope=global");

      expect(res.status).toBe(503);
      expect(res.body.error).toContain("not available");
    });
  });
});


// --- Settings API Tests ---

