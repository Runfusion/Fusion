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

import { AgentStore, Database, RoutineStore, TaskStore as CoreTaskStore, buildManualRetryResetPatch, isGhAvailable, isGhAuthenticated } from "@fusion/core";
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
    updateStep: vi.fn(),
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
    linkGithubIssue: vi.fn().mockResolvedValue(undefined),
    recordActivity: vi.fn().mockResolvedValue(undefined),
    recordRunAuditEvent: vi.fn().mockResolvedValue(undefined),
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
  title: "Test task",
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


/** Build a minimal multipart/form-data body */
function buildMultipart(fieldName: string, filename: string, contentType: string, content: Buffer): { body: Buffer; boundary: string } {
  const boundary = "----TestBoundary" + Date.now();
  const header = `--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`;
  const footer = `\r\n--${boundary}--\r\n`;
  const body = Buffer.concat([Buffer.from(header), content, Buffer.from(footer)]);
  return { body, boundary };
}


afterEach(() => {
  resetDiagnosticsSink();
});


describe("POST /tasks/:id/retry", () => {
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

  it("retries a failed task and moves it to todo", async () => {
    const failedTask = { ...FAKE_TASK_DETAIL, status: "failed" };
    const movedTask = { ...FAKE_TASK_DETAIL, column: "todo", status: undefined };
    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(failedTask);
    (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValue(failedTask);
    (store.moveTask as ReturnType<typeof vi.fn>).mockResolvedValue(movedTask);

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/KB-001/retry", JSON.stringify({}), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(store.updateTask).toHaveBeenCalledWith("KB-001", {
      status: null,
      error: null,
      worktree: null,
      branch: null,
      baseBranch: null,
      baseCommitSha: null,
      ...buildManualRetryResetPatch({ resetMergeRetries: true }),
    });
    expect(store.moveTask).toHaveBeenCalledWith("KB-001", "todo");
  });

  it("returns 400 when task is not in a retryable state", async () => {
    const activeTask = { ...FAKE_TASK_DETAIL, status: "executing" };
    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(activeTask);

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/KB-001/retry", JSON.stringify({}), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("not in a retryable state");
  });

  it("retries a failed task in any column (not just in-progress)", async () => {
    const failedTaskInTodo = { ...FAKE_TASK_DETAIL, column: "todo", status: "failed" };
    const movedTask = { ...FAKE_TASK_DETAIL, column: "todo", status: undefined };
    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(failedTaskInTodo);
    (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValue(failedTaskInTodo);
    (store.moveTask as ReturnType<typeof vi.fn>).mockResolvedValue(movedTask);

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/KB-001/retry", JSON.stringify({}), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(store.updateTask).toHaveBeenCalledWith("KB-001", {
      status: null,
      error: null,
      worktree: null,
      branch: null,
      baseBranch: null,
      baseCommitSha: null,
      ...buildManualRetryResetPatch({ resetMergeRetries: true }),
    });
    expect(store.moveTask).toHaveBeenCalledWith("KB-001", "todo");
  });

  it("retries a stuck-killed task and moves it to todo", async () => {
    const stuckTask = { ...FAKE_TASK_DETAIL, status: "stuck-killed", column: "in-progress" };
    const movedTask = { ...FAKE_TASK_DETAIL, column: "todo", status: undefined };
    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(stuckTask);
    (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValue(stuckTask);
    (store.moveTask as ReturnType<typeof vi.fn>).mockResolvedValue(movedTask);

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/KB-001/retry", JSON.stringify({}), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(store.updateTask).toHaveBeenCalledWith("KB-001", {
      status: null,
      error: null,
      worktree: null,
      branch: null,
      baseBranch: null,
      baseCommitSha: null,
      ...buildManualRetryResetPatch({ resetMergeRetries: true }),
    });
    expect(store.moveTask).toHaveBeenCalledWith("KB-001", "todo");
    expect(store.logEntry).toHaveBeenCalledWith("KB-001", "Retry requested from dashboard (stuck kill budget reset)");
  });

  it("retries a failed zero-step in-review task with no merge attempts by moving to todo", async () => {
    const reviewTask = {
      ...FAKE_TASK_DETAIL,
      column: "in-review",
      status: "failed",
      steps: [],
      mergeRetries: 0,
    };
    const movedTask = { ...reviewTask, column: "todo", status: undefined };
    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValueOnce(reviewTask);
    (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValue(reviewTask);
    (store.moveTask as ReturnType<typeof vi.fn>).mockResolvedValue(movedTask);

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/KB-001/retry", JSON.stringify({}), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(store.updateTask).toHaveBeenCalledWith("KB-001", {
      status: null,
      error: null,
      ...buildManualRetryResetPatch(),
    });
    expect(store.moveTask).toHaveBeenCalledWith("KB-001", "todo", { preserveProgress: true });
    expect(store.logEntry).toHaveBeenCalledWith(
      "KB-001",
      "Retry requested from dashboard (execution failure in-review → todo, preserving progress)",
    );
    const updateCall = (store.updateTask as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(updateCall).not.toHaveProperty("mergeRetries");
  });

  it("retries a stuck-killed zero-step in-review task with no merge attempts by moving to todo", async () => {
    const reviewTask = {
      ...FAKE_TASK_DETAIL,
      column: "in-review",
      status: "stuck-killed",
      steps: [],
    };
    const movedTask = { ...reviewTask, column: "todo", status: undefined };
    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValueOnce(reviewTask);
    (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValue(reviewTask);
    (store.moveTask as ReturnType<typeof vi.fn>).mockResolvedValue(movedTask);

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/KB-001/retry", JSON.stringify({}), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(store.updateTask).toHaveBeenCalledWith("KB-001", {
      status: null,
      error: null,
      ...buildManualRetryResetPatch(),
    });
    expect(store.moveTask).toHaveBeenCalledWith("KB-001", "todo", { preserveProgress: true });
    expect(store.logEntry).toHaveBeenCalledWith(
      "KB-001",
      "Retry requested from dashboard (execution failure in-review → todo, preserving progress)",
    );
    const updateCall = (store.updateTask as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(updateCall).not.toHaveProperty("mergeRetries");
  });

  it("preserves worktree/branch when retrying in-review task", async () => {
    const reviewTask = {
      ...FAKE_TASK_DETAIL,
      column: "in-review",
      status: "failed",
      worktree: "/path/to/worktree",
      branch: "fusion/fn-001",
      baseBranch: "main",
      baseCommitSha: "abc123",
    };
    (store.getTask as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(reviewTask)
      .mockResolvedValueOnce(reviewTask);
    (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValue(reviewTask);

    await REQUEST(buildApp(), "POST", "/api/tasks/KB-001/retry", JSON.stringify({}), {
      "Content-Type": "application/json",
    });

    const updateCall = (store.updateTask as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(updateCall).not.toHaveProperty("worktree");
    expect(updateCall).not.toHaveProperty("branch");
    expect(updateCall).not.toHaveProperty("baseBranch");
    expect(updateCall).not.toHaveProperty("baseCommitSha");
    expect(updateCall.recoveryRetryCount).toBe(0);
    expect(updateCall.nextRecoveryAt).toBeNull();
  });

  it("retries execution-failed in-review task by moving to todo with progress preserved", async () => {
    const executionFailedTask = {
      ...FAKE_TASK_DETAIL,
      column: "in-review" as const,
      status: "failed",
      steps: [
        { name: "Step 0", status: "done" },
        { name: "Step 1", status: "in-progress" },
        { name: "Step 2", status: "pending" },
      ],
    };
    const movedTask = { ...executionFailedTask, column: "todo" as const, status: undefined };
    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValueOnce(executionFailedTask);
    (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValue(executionFailedTask);
    (store.moveTask as ReturnType<typeof vi.fn>).mockResolvedValue(movedTask);

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/KB-001/retry", JSON.stringify({}), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(store.updateTask).toHaveBeenCalledWith("KB-001", {
      status: null,
      error: null,
      ...buildManualRetryResetPatch(),
    });
    expect(store.moveTask).toHaveBeenCalledWith("KB-001", "todo", { preserveProgress: true });
    expect(store.logEntry).toHaveBeenCalledWith(
      "KB-001",
      "Retry requested from dashboard (execution failure in-review → todo, preserving progress)",
    );
  });

  it("retries merge-failed in-review task by staying in-review with mergeRetries reset", async () => {
    const mergeFailedTask = {
      ...FAKE_TASK_DETAIL,
      column: "in-review" as const,
      status: "failed",
      steps: [
        { name: "Step 0", status: "done" },
        { name: "Step 1", status: "done" },
        { name: "Step 2", status: "done" },
      ],
    };
    (store.getTask as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(mergeFailedTask)
      .mockResolvedValueOnce(mergeFailedTask);
    (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValue(mergeFailedTask);

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/KB-001/retry", JSON.stringify({}), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(store.updateTask).toHaveBeenCalledWith("KB-001", {
      status: null,
      error: null,
      ...buildManualRetryResetPatch({ resetMergeRetries: true }),
    });
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(store.logEntry).toHaveBeenCalledWith(
      "KB-001",
      "Retry requested from dashboard (in-review merge retry, mergeRetries reset)",
    );
  });

  it("retries zero-step merge-failed in-review task with prior merge attempts by staying in-review", async () => {
    const mergeFailedTask = {
      ...FAKE_TASK_DETAIL,
      column: "in-review" as const,
      status: "failed",
      steps: [],
      mergeRetries: 2,
    };
    (store.getTask as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(mergeFailedTask)
      .mockResolvedValueOnce(mergeFailedTask);
    (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValue(mergeFailedTask);

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/KB-001/retry", JSON.stringify({}), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(store.updateTask).toHaveBeenCalledWith("KB-001", {
      status: null,
      error: null,
      ...buildManualRetryResetPatch({ resetMergeRetries: true }),
    });
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(store.logEntry).toHaveBeenCalledWith(
      "KB-001",
      "Retry requested from dashboard (in-review merge retry, mergeRetries reset)",
    );
  });

  it("retries stuck-killed in-review task with incomplete steps moves to todo", async () => {
    const stuckTask = {
      ...FAKE_TASK_DETAIL,
      column: "in-review" as const,
      status: "stuck-killed",
      steps: [
        { name: "Step 0", status: "done" },
        { name: "Step 1", status: "pending" },
      ],
    };
    const movedTask = { ...stuckTask, column: "todo" as const, status: undefined };
    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValueOnce(stuckTask);
    (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValue(stuckTask);
    (store.moveTask as ReturnType<typeof vi.fn>).mockResolvedValue(movedTask);

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/KB-001/retry", JSON.stringify({}), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(store.moveTask).toHaveBeenCalledWith("KB-001", "todo", { preserveProgress: true });
    expect(store.logEntry).toHaveBeenCalledWith(
      "KB-001",
      "Retry requested from dashboard (execution failure in-review → todo, preserving progress)",
    );
    const updateCall = (store.updateTask as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(updateCall).not.toHaveProperty("mergeRetries");
  });

  it("retries a stranded planning triage task in triage and removes stale prompt", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "kb-task-retry-spec-"));
    const taskDir = join(tempRoot, ".fusion", "tasks", "FN-001");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "PROMPT.md"), "# stale spec\n");

    const planningTask = {
      ...FAKE_TASK_DETAIL,
      column: "triage" as const,
      status: "planning",
      stuckKillCount: 6,
      recoveryRetryCount: 2,
      nextRecoveryAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const retriedTask = {
      ...planningTask,
      status: "needs-replan",
      stuckKillCount: 0,
      recoveryRetryCount: undefined,
      nextRecoveryAt: undefined,
    };

    (store.getTask as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(planningTask)
      .mockResolvedValueOnce(retriedTask);
    (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValue(retriedTask);
    (store.getRootDir as ReturnType<typeof vi.fn>).mockReturnValue(tempRoot);

    try {
      const res = await REQUEST(buildApp(), "POST", "/api/tasks/KB-001/retry", JSON.stringify({}), {
        "Content-Type": "application/json",
      });

      expect(res.status).toBe(200);
      expect(store.updateTask).toHaveBeenCalledWith("KB-001", {
        status: "needs-replan",
        error: null,
        worktree: null,
        branch: null,
        baseBranch: null,
        baseCommitSha: null,
        ...buildManualRetryResetPatch({ resetMergeRetries: true }),
      });
      expect(store.moveTask).not.toHaveBeenCalled();
      expect(existsSync(join(taskDir, "PROMPT.md"))).toBe(false);
      expect(store.logEntry).toHaveBeenCalledWith(
        "KB-001",
        "Retry requested from dashboard (planning retry budget reset)",
      );
      expect(res.body.status).toBe("needs-replan");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

describe("POST /tasks/:id/duplicate", () => {
  let store: TaskStore;

  beforeEach(() => {
    store = createMockStore({
      duplicateTask: vi.fn(),
    });
  });

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store));
    return app;
  }

  it("duplicates a task, returns 201, and attempts tracking issue creation", async () => {
    const createIssueSpy = vi.spyOn(GitHubClient.prototype, "createIssue").mockResolvedValue({
      owner: "task",
      repo: "repo",
      number: 91,
      htmlUrl: "https://github.com/task/repo/issues/91",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      githubTrackingDefaultRepo: "task/repo",
      githubAuthMode: "token",
      githubAuthToken: "tok",
    });

    const newTask = {
      ...FAKE_TASK_DETAIL,
      id: "FN-002",
      column: "triage",
      githubTracking: { enabled: true, repoOverride: "task/repo" },
    };
    (store.duplicateTask as ReturnType<typeof vi.fn>).mockResolvedValue(newTask);

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/KB-001/duplicate", JSON.stringify({}), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe("FN-002");
    expect(store.duplicateTask).toHaveBeenCalledWith("KB-001");
    expect(createIssueSpy).toHaveBeenCalledWith(expect.objectContaining({ owner: "task", repo: "repo" }));
    expect(store.linkGithubIssue).toHaveBeenCalledWith("FN-002", expect.objectContaining({ owner: "task", repo: "repo", number: 91 }));
    createIssueSpy.mockRestore();
  });

  it("duplicate remains successful when tracking issue creation fails", async () => {
    const createIssueSpy = vi.spyOn(GitHubClient.prototype, "createIssue").mockRejectedValue(new Error("boom"));
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      githubTrackingDefaultRepo: "task/repo",
      githubAuthMode: "token",
      githubAuthToken: "tok",
    });

    const newTask = {
      ...FAKE_TASK_DETAIL,
      id: "FN-002",
      column: "triage",
      githubTracking: { enabled: true, repoOverride: "task/repo" },
    };
    (store.duplicateTask as ReturnType<typeof vi.fn>).mockResolvedValue(newTask);

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/KB-001/duplicate", JSON.stringify({}), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe("FN-002");
    expect(createIssueSpy).toHaveBeenCalledTimes(1);
    createIssueSpy.mockRestore();
  });

  it("returns 404 when source task not found", async () => {
    const error = new Error("Task not found") as NodeJS.ErrnoException;
    error.code = "ENOENT";
    (store.duplicateTask as ReturnType<typeof vi.fn>).mockRejectedValue(error);

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/KB-999/duplicate", JSON.stringify({}), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(404);
    expect(res.body.error).toContain("not found");
  });

  it("returns 500 on unexpected errors", async () => {
    (store.duplicateTask as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Database error"));

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/KB-001/duplicate", JSON.stringify({}), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(500);
    expect(res.body.error).toContain("Database error");
  });
});

describe("POST /tasks/:id/refine", () => {
  let store: TaskStore;

  beforeEach(() => {
    store = createMockStore({
      refineTask: vi.fn(),
      logEntry: vi.fn(),
    });
  });

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store));
    return app;
  }

  it("creates refinement task from done task, returns 201, and attempts tracking issue creation", async () => {
    const createIssueSpy = vi.spyOn(GitHubClient.prototype, "createIssue").mockResolvedValue({
      owner: "task",
      repo: "repo",
      number: 92,
      htmlUrl: "https://github.com/task/repo/issues/92",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      githubTrackingDefaultRepo: "task/repo",
      githubAuthMode: "token",
      githubAuthToken: "tok",
    });

    const refinedTask = {
      ...FAKE_TASK_DETAIL,
      id: "FN-002",
      column: "triage",
      title: "Refinement: KB-001",
      githubTracking: { enabled: true, repoOverride: "task/repo" },
    };
    (store.refineTask as ReturnType<typeof vi.fn>).mockResolvedValue(refinedTask);
    (store.logEntry as ReturnType<typeof vi.fn>).mockResolvedValue(FAKE_TASK_DETAIL);

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/KB-001/refine", JSON.stringify({ feedback: "Need improvements" }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe("FN-002");
    expect(store.refineTask).toHaveBeenCalledWith("KB-001", "Need improvements");
    expect(store.logEntry).toHaveBeenCalledWith("KB-001", "Refinement requested", "Need improvements");
    expect(createIssueSpy).toHaveBeenCalledWith(expect.objectContaining({ owner: "task", repo: "repo" }));
    expect(store.linkGithubIssue).toHaveBeenCalledWith("FN-002", expect.objectContaining({ owner: "task", repo: "repo", number: 92 }));
    createIssueSpy.mockRestore();
  });

  it("refine remains successful when tracking issue creation fails", async () => {
    const createIssueSpy = vi.spyOn(GitHubClient.prototype, "createIssue").mockRejectedValue(new Error("boom"));
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      githubTrackingDefaultRepo: "task/repo",
      githubAuthMode: "token",
      githubAuthToken: "tok",
    });

    const refinedTask = {
      ...FAKE_TASK_DETAIL,
      id: "FN-002",
      column: "triage",
      title: "Refinement: KB-001",
      githubTracking: { enabled: true, repoOverride: "task/repo" },
    };
    (store.refineTask as ReturnType<typeof vi.fn>).mockResolvedValue(refinedTask);
    (store.logEntry as ReturnType<typeof vi.fn>).mockResolvedValue(FAKE_TASK_DETAIL);

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/KB-001/refine", JSON.stringify({ feedback: "Need improvements" }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe("FN-002");
    expect(createIssueSpy).toHaveBeenCalledTimes(1);
    createIssueSpy.mockRestore();
  });

  it("creates refinement task from in-review task and returns 201", async () => {
    const refinedTask = { ...FAKE_TASK_DETAIL, id: "FN-002", column: "triage", title: "Refinement: My Feature" };
    (store.refineTask as ReturnType<typeof vi.fn>).mockResolvedValue(refinedTask);
    (store.logEntry as ReturnType<typeof vi.fn>).mockResolvedValue(FAKE_TASK_DETAIL);

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/KB-001/refine", JSON.stringify({ feedback: "Fix edge cases" }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(201);
    expect(res.body.column).toBe("triage");
    expect(store.refineTask).toHaveBeenCalledWith("KB-001", "Fix edge cases");
  });

  it("returns 400 when task is not in done or in-review column", async () => {
    (store.refineTask as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Cannot refine FN-001: task is in 'triage', must be in 'done' or 'in-review'"));

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/KB-001/refine", JSON.stringify({ feedback: "Need improvements" }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("must be in 'done' or 'in-review'");
  });

  it("returns 400 when feedback is missing", async () => {
    const res = await REQUEST(buildApp(), "POST", "/api/tasks/KB-001/refine", JSON.stringify({}), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("feedback is required");
    expect(store.refineTask).not.toHaveBeenCalled();
  });

  it("returns 400 when feedback is empty string", async () => {
    const res = await REQUEST(buildApp(), "POST", "/api/tasks/KB-001/refine", JSON.stringify({ feedback: "" }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("feedback is required");
    expect(store.refineTask).not.toHaveBeenCalled();
  });

  it("returns 400 when feedback exceeds 2000 characters", async () => {
    const longFeedback = "x".repeat(2001);
    const res = await REQUEST(buildApp(), "POST", "/api/tasks/KB-001/refine", JSON.stringify({ feedback: longFeedback }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("feedback must be between 1 and 2000 characters");
    expect(store.refineTask).not.toHaveBeenCalled();
  });

  it("returns 404 when source task not found", async () => {
    const error = new Error("Task not found") as NodeJS.ErrnoException;
    error.code = "ENOENT";
    (store.refineTask as ReturnType<typeof vi.fn>).mockRejectedValue(error);

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/KB-999/refine", JSON.stringify({ feedback: "Need improvements" }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(404);
    expect(res.body.error).toContain("not found");
  });

  it("returns 400 when feedback is whitespace only (caught at validation)", async () => {
    // Route-level validation now catches whitespace-only input before it reaches the store
    const res = await REQUEST(buildApp(), "POST", "/api/tasks/KB-001/refine", JSON.stringify({ feedback: "   " }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("feedback must be between 1 and 2000 characters");
    expect(store.refineTask).not.toHaveBeenCalled();
  });

  it("returns 500 on unexpected errors", async () => {
    (store.refineTask as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Database error"));

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/KB-001/refine", JSON.stringify({ feedback: "Need improvements" }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(500);
    expect(res.body.error).toContain("Database error");
  });
});

describe("POST /tasks/:id/reset", () => {
  let store: TaskStore;

  beforeEach(() => {
    store = createMockStore({
      updateStep: vi.fn(),
      updateTask: vi.fn(),
      moveTask: vi.fn(),
      logEntry: vi.fn(),
      getTask: vi.fn(),
    });
  });

  function buildApp(engine?: { getTaskStore: () => TaskStore; getAgentStore: () => { listAgents: ReturnType<typeof vi.fn>; syncExecutionTaskLink: ReturnType<typeof vi.fn>; deleteAgent: ReturnType<typeof vi.fn> } }) {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store, engine ? { engine: engine as any } as any : undefined));
    return app;
  }

  it("resets cleanly when moveTask already returns todo with cleared bindings", async () => {
    const agentStore = {
      listAgents: vi.fn().mockResolvedValue([
        { id: "agent-durable", taskId: "FN-5200" },
        { id: "agent-ephemeral", taskId: "FN-5200", name: "executor-FN-5200", role: "executor", reportsTo: null },
      ]),
      syncExecutionTaskLink: vi.fn().mockResolvedValue(undefined),
      deleteAgent: vi.fn().mockResolvedValue(undefined),
    };
    const engine = {
      getTaskStore: () => store,
      getAgentStore: () => agentStore,
    };
    const staleTask = {
      ...FAKE_TASK_DETAIL,
      id: "FN-5200",
      column: "in-progress" as const,
      branch: "fusion/fn-5200",
      worktree: "/tmp/missing-worktree",
      steps: [{ title: "one", status: "done" }],
    };
    const cleanResetTask = {
      ...staleTask,
      column: "todo" as const,
      branch: null,
      worktree: null,
      checkedOutBy: null,
      executionStartedAt: null,
      sessionFile: null,
      steps: [{ title: "one", status: "pending" }],
    };

    (store.getTask as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(staleTask)
      .mockResolvedValueOnce(cleanResetTask);
    (store.moveTask as ReturnType<typeof vi.fn>).mockResolvedValue(cleanResetTask);

    const res = await REQUEST(buildApp(engine), "POST", "/api/tasks/FN-5200/reset", JSON.stringify({ confirm: true }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(store.updateTask).toHaveBeenCalledTimes(1);
    expect(store.logEntry).toHaveBeenCalledTimes(1);
    expect(store.recordRunAuditEvent).not.toHaveBeenCalled();
    expect(agentStore.syncExecutionTaskLink).toHaveBeenCalledWith("agent-durable", undefined);
    expect(agentStore.deleteAgent).toHaveBeenCalledWith("agent-ephemeral");
    expect(res.body.column).toBe("todo");
    expect(res.body.branch ?? null).toBeNull();
    expect(res.body.worktree ?? null).toBeNull();
  });

  it("FN-5149: reset with stale missing worktree should not return in-progress limbo state", async () => {
    const agentStore = {
      listAgents: vi.fn().mockResolvedValue([
        { id: "agent-durable", taskId: "FN-5149" },
        { id: "agent-ephemeral", taskId: "FN-5149", name: "executor-FN-5149", role: "executor", reportsTo: null },
      ]),
      syncExecutionTaskLink: vi.fn().mockResolvedValue(undefined),
      deleteAgent: vi.fn().mockResolvedValue(undefined),
    };
    const engine = {
      getTaskStore: () => store,
      getAgentStore: () => agentStore,
    };
    const staleTask = {
      ...FAKE_TASK_DETAIL,
      id: "FN-5149",
      column: "in-progress" as const,
      branch: "fusion/fn-5149",
      worktree: "/tmp/missing-worktree",
      checkedOutBy: "agent-reset",
      checkedOutAt: "2026-05-19T00:00:00.000Z",
      checkoutNodeId: "node-1",
      checkoutRunId: "run-1",
      checkoutLeaseRenewedAt: "2026-05-19T00:01:00.000Z",
      checkoutLeaseEpoch: 2,
      executionStartedAt: "2026-05-19T00:00:00.000Z",
      sessionFile: "/tmp/session.json",
      taskDoneRetryCount: 2,
      worktreeSessionRetryCount: 1,
      steps: [
        { title: "one", status: "done" },
        { title: "two", status: "in-progress" },
      ],
    };
    const driftedAfterReset = {
      ...staleTask,
      branch: null,
      worktree: "/tmp/missing-worktree",
      column: "in-progress" as const,
      steps: staleTask.steps.map((step) => ({ ...step, status: "pending" })),
    };
    const correctedAfterReset = {
      ...driftedAfterReset,
      column: "todo" as const,
      worktree: null,
      checkedOutBy: null,
      checkedOutAt: null,
      checkoutNodeId: null,
      checkoutRunId: null,
      checkoutLeaseRenewedAt: null,
      checkoutLeaseEpoch: null,
      executionStartedAt: null,
      taskDoneRetryCount: 0,
      worktreeSessionRetryCount: null,
      sessionFile: null,
    };

    (store.getTask as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(staleTask)
      .mockResolvedValueOnce(driftedAfterReset)
      .mockResolvedValueOnce(correctedAfterReset);
    (store.moveTask as ReturnType<typeof vi.fn>).mockResolvedValue(driftedAfterReset);
    (store.updateTask as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(staleTask)
      .mockResolvedValueOnce(correctedAfterReset);

    const res = await REQUEST(buildApp(engine), "POST", "/api/tasks/FN-5149/reset", JSON.stringify({ confirm: true }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(store.updateStep).toHaveBeenNthCalledWith(1, "FN-5149", 0, "pending");
    expect(store.updateStep).toHaveBeenNthCalledWith(2, "FN-5149", 1, "pending");
    expect(store.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      domain: "database",
      mutationType: "task:auto-recover-reset-drift",
      target: "FN-5149",
    }));
    expect(agentStore.syncExecutionTaskLink).toHaveBeenCalledWith("agent-durable", undefined);
    expect(agentStore.deleteAgent).toHaveBeenCalledWith("agent-ephemeral");
    expect(store.logEntry).toHaveBeenNthCalledWith(
      2,
      "FN-5149",
      "Auto-corrected reset drift after moveTask — normalized task back to todo with cleared worktree/branch bindings",
      expect.any(String),
    );
    expect(res.body.column).toBe("todo");
    expect(res.body.branch ?? null).toBeNull();
    expect(res.body.worktree ?? null).toBeNull();
    expect(res.body.steps.map((step: { status: string }) => step.status)).toEqual(["pending", "pending"]);
    expect(res.body.checkedOutBy).toBeFalsy();
    expect(res.body.executionStartedAt).toBeFalsy();
  });
});

describe("DELETE /tasks/:id", () => {
  let store: TaskStore;

  beforeEach(() => {
    store = createMockStore({
      deleteTask: vi.fn(),
    });
  });

  function buildApp(engine?: { getTaskStore: () => TaskStore; getAgentStore: () => { listAgents: ReturnType<typeof vi.fn>; syncExecutionTaskLink: ReturnType<typeof vi.fn>; deleteAgent: ReturnType<typeof vi.fn> } }) {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store, engine ? { engine: engine as any } as any : undefined));
    return app;
  }

  it("deletes a task with the default safe mode", async () => {
    const agentStore = {
      listAgents: vi.fn().mockResolvedValue([
        { id: "agent-durable", taskId: "KB-001" },
        { id: "agent-ephemeral", taskId: "KB-001", name: "executor-KB-001", role: "executor", reportsTo: null },
      ]),
      syncExecutionTaskLink: vi.fn().mockResolvedValue(undefined),
      deleteAgent: vi.fn().mockResolvedValue(undefined),
    };
    const engine = {
      getTaskStore: () => store,
      getAgentStore: () => agentStore,
    };
    const deletedTask = { ...FAKE_TASK_DETAIL, id: "KB-001" };
    (store.deleteTask as ReturnType<typeof vi.fn>).mockResolvedValue(deletedTask);

    const res = await REQUEST(buildApp(engine), "DELETE", "/api/tasks/KB-001");

    expect(res.status).toBe(200);
    expect(res.body.id).toBe("KB-001");
    expect(store.deleteTask).toHaveBeenCalledWith("KB-001", expect.objectContaining({
      allowResurrection: false,
      removeDependencyReferences: false,
      removeLineageReferences: false,
      githubIssueAction: undefined,
      auditContext: expect.objectContaining({
        agentId: "system",
        runId: expect.stringMatching(/^synthetic-dashboard-delete-KB-001-/),
      }),
    }));
    expect(agentStore.syncExecutionTaskLink).toHaveBeenCalledWith("agent-durable", undefined);
    expect(agentStore.deleteAgent).toHaveBeenCalledWith("agent-ephemeral");
  });

  it("returns structured 409 conflict when delete is blocked by dependents", async () => {
    const err = new Error("Cannot delete task KB-001: still referenced as a dependency by KB-002.");
    err.name = "TaskHasDependentsError";
    (err as Error & { dependentIds: string[] }).dependentIds = ["KB-002", "KB-003"];
    (store.deleteTask as ReturnType<typeof vi.fn>).mockRejectedValue(err);

    const res = await REQUEST(buildApp(), "DELETE", "/api/tasks/KB-001");

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("Cannot delete task KB-001");
    expect(res.body.details).toEqual({
      code: "TASK_HAS_DEPENDENTS",
      taskId: "KB-001",
      dependentIds: ["KB-002", "KB-003"],
    });
  });

  it("passes the removeDependencyReferences flag when explicitly requested", async () => {
    const deletedTask = { ...FAKE_TASK_DETAIL, id: "KB-001" };
    (store.deleteTask as ReturnType<typeof vi.fn>).mockResolvedValue(deletedTask);

    const res = await REQUEST(buildApp(), "DELETE", "/api/tasks/KB-001?removeDependencyReferences=true");

    expect(res.status).toBe(200);
    expect(store.deleteTask).toHaveBeenCalledWith("KB-001", expect.objectContaining({
      removeDependencyReferences: true,
      removeLineageReferences: false,
      githubIssueAction: undefined,
      auditContext: expect.objectContaining({
        agentId: "system",
        runId: expect.stringMatching(/^synthetic-dashboard-delete-KB-001-/),
      }),
    }));
  });

  it("passes the removeLineageReferences flag when explicitly requested", async () => {
    const deletedTask = { ...FAKE_TASK_DETAIL, id: "KB-001" };
    (store.deleteTask as ReturnType<typeof vi.fn>).mockResolvedValue(deletedTask);

    const res = await REQUEST(buildApp(), "DELETE", "/api/tasks/KB-001?removeLineageReferences=true");

    expect(res.status).toBe(200);
    expect(store.deleteTask).toHaveBeenCalledWith("KB-001", expect.objectContaining({
      removeDependencyReferences: false,
      removeLineageReferences: true,
      githubIssueAction: undefined,
      auditContext: expect.objectContaining({
        agentId: "system",
        runId: expect.stringMatching(/^synthetic-dashboard-delete-KB-001-/),
      }),
    }));
  });

  it("passes allowResurrection when explicitly requested", async () => {
    const deletedTask = { ...FAKE_TASK_DETAIL, id: "KB-001" };
    (store.deleteTask as ReturnType<typeof vi.fn>).mockResolvedValue(deletedTask);

    const res = await REQUEST(buildApp(), "DELETE", "/api/tasks/KB-001?allowResurrection=true");

    expect(res.status).toBe(200);
    expect(store.deleteTask).toHaveBeenCalledWith("KB-001", expect.objectContaining({
      allowResurrection: true,
      removeDependencyReferences: false,
      removeLineageReferences: false,
    }));
  });

  it.each(["close", "delete", "leave", "auto"] as const)("forwards githubIssueAction=%s", async (githubIssueAction) => {
    const deletedTask = { ...FAKE_TASK_DETAIL, id: "KB-001" };
    (store.deleteTask as ReturnType<typeof vi.fn>).mockResolvedValue(deletedTask);

    const res = await REQUEST(buildApp(), "DELETE", `/api/tasks/KB-001?githubIssueAction=${githubIssueAction}`);

    expect(res.status).toBe(200);
    expect(store.deleteTask).toHaveBeenCalledWith("KB-001", expect.objectContaining({
      removeDependencyReferences: false,
      removeLineageReferences: false,
      githubIssueAction,
      auditContext: expect.objectContaining({
        agentId: "system",
        runId: expect.stringMatching(/^synthetic-dashboard-delete-KB-001-/),
      }),
    }));
  });

  it("returns structured 409 conflict when delete is blocked by lineage children", async () => {
    const err = new Error("Cannot delete task KB-001: still referenced as a lineage parent by KB-002.");
    err.name = "TaskHasLineageChildrenError";
    (err as Error & { childIds: string[] }).childIds = ["KB-002", "KB-003"];
    (store.deleteTask as ReturnType<typeof vi.fn>).mockRejectedValue(err);

    const res = await REQUEST(buildApp(), "DELETE", "/api/tasks/KB-001");

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("Cannot delete task KB-001");
    expect(res.body.details).toEqual({
      code: "TASK_HAS_LINEAGE_CHILDREN",
      taskId: "KB-001",
      lineageChildIds: ["KB-002", "KB-003"],
    });
  });

  it("rejects invalid githubIssueAction values", async () => {
    const res = await REQUEST(buildApp(), "DELETE", "/api/tasks/KB-001?githubIssueAction=bad-value");

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("githubIssueAction must be one of: close, delete, leave, auto");
    expect(store.deleteTask).not.toHaveBeenCalled();
  });
});

describe("POST /tasks/:id/archive", () => {
  let store: TaskStore;

  beforeEach(() => {
    store = createMockStore({
      archiveTask: vi.fn(),
    });
  });

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store));
    return app;
  }

  it("archives a done task and returns the updated task", async () => {
    const archivedTask = { ...FAKE_TASK_DETAIL, column: "archived" };
    (store.archiveTask as ReturnType<typeof vi.fn>).mockResolvedValue(archivedTask);

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/KB-001/archive", JSON.stringify({}), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(res.body.column).toBe("archived");
    expect(store.archiveTask).toHaveBeenCalledWith("KB-001", {
      cleanup: true,
      removeLineageReferences: false,
    });
  });

  it("passes removeLineageReferences to archive when explicitly requested", async () => {
    const archivedTask = { ...FAKE_TASK_DETAIL, column: "archived" };
    (store.archiveTask as ReturnType<typeof vi.fn>).mockResolvedValue(archivedTask);

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/KB-001/archive?removeLineageReferences=true", JSON.stringify({}), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(store.archiveTask).toHaveBeenCalledWith("KB-001", {
      cleanup: true,
      removeLineageReferences: true,
    });
  });

  it("returns structured 409 conflict when archive is blocked by lineage children", async () => {
    const err = new Error("Cannot archive task KB-001: still referenced as a lineage parent by KB-002.");
    err.name = "TaskHasLineageChildrenError";
    (err as Error & { childIds: string[] }).childIds = ["KB-002", "KB-003"];
    (store.archiveTask as ReturnType<typeof vi.fn>).mockRejectedValue(err);

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/KB-001/archive", JSON.stringify({}), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("Cannot archive task KB-001");
    expect(res.body.details).toEqual({
      code: "TASK_HAS_LINEAGE_CHILDREN",
      taskId: "KB-001",
      lineageChildIds: ["KB-002", "KB-003"],
    });
  });

  it("returns 400 when task is not in done column", async () => {
    (store.archiveTask as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Cannot archive FN-001: task is in 'triage', must be in 'done'"));

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/KB-001/archive", JSON.stringify({}), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("must be in 'done'");
  });

  it("returns 500 on unexpected errors", async () => {
    (store.archiveTask as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Database error"));

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/KB-001/archive", JSON.stringify({}), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(500);
    expect(res.body.error).toContain("Database error");
  });
});

describe("POST /tasks/:id/unarchive", () => {
  let store: TaskStore;

  beforeEach(() => {
    store = createMockStore({
      unarchiveTask: vi.fn(),
    });
  });

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store));
    return app;
  }

  it("unarchives an archived task and returns the updated task", async () => {
    const unarchivedTask = { ...FAKE_TASK_DETAIL, column: "done" };
    (store.unarchiveTask as ReturnType<typeof vi.fn>).mockResolvedValue(unarchivedTask);

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/KB-001/unarchive", JSON.stringify({}), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(res.body.column).toBe("done");
    expect(store.unarchiveTask).toHaveBeenCalledWith("KB-001");
  });

  it("returns 400 when task is not in archived column", async () => {
    (store.unarchiveTask as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Cannot unarchive FN-001: task is in 'done', must be in 'archived'"));

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/KB-001/unarchive", JSON.stringify({}), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("must be in 'archived'");
  });

  it("returns 500 on unexpected errors", async () => {
    (store.unarchiveTask as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Database error"));

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/KB-001/unarchive", JSON.stringify({}), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(500);
    expect(res.body.error).toContain("Database error");
  });
});

describe("POST /tasks/archive-all-done", () => {
  let store: TaskStore;

  beforeEach(() => {
    store = createMockStore({
      archiveAllDone: vi.fn(),
    });
  });

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store));
    return app;
  }

  it("archives all done tasks and returns the archived array", async () => {
    const archivedTasks = [
      { ...FAKE_TASK_DETAIL, id: "FN-001", column: "archived" },
      { ...FAKE_TASK_DETAIL, id: "FN-002", column: "archived" },
    ];
    (store.archiveAllDone as ReturnType<typeof vi.fn>).mockResolvedValue(archivedTasks);

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/archive-all-done", JSON.stringify({}), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(res.body.archived).toHaveLength(2);
    expect(res.body.archived[0].column).toBe("archived");
    expect(res.body.archived[1].column).toBe("archived");
    expect(store.archiveAllDone).toHaveBeenCalled();
  });

  it("returns empty array when no done tasks exist", async () => {
    (store.archiveAllDone as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/archive-all-done", JSON.stringify({}), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(res.body.archived).toEqual([]);
  });

  it("returns 500 on unexpected errors", async () => {
    (store.archiveAllDone as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Database error"));

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/archive-all-done", JSON.stringify({}), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(500);
    expect(res.body.error).toContain("Database error");
  });
});

describe("POST /tasks/batch-update-models", () => {
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

  it("updates multiple tasks with executor and validator models", async () => {
    const task1 = { ...FAKE_TASK_DETAIL, id: "FN-001" };
    const task2 = { ...FAKE_TASK_DETAIL, id: "FN-002" };
    const updated1 = { ...task1, modelProvider: "openai", modelId: "gpt-4o", validatorModelProvider: "anthropic", validatorModelId: "claude-sonnet-4-5" };
    const updated2 = { ...task2, modelProvider: "openai", modelId: "gpt-4o", validatorModelProvider: "anthropic", validatorModelId: "claude-sonnet-4-5" };

    (store.getTask as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(task1)
      .mockResolvedValueOnce(task2);
    (store.updateTask as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(updated1)
      .mockResolvedValueOnce(updated2);

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/batch-update-models", JSON.stringify({
      taskIds: ["FN-001", "FN-002"],
      modelProvider: "openai",
      modelId: "gpt-4o",
      validatorModelProvider: "anthropic",
      validatorModelId: "claude-sonnet-4-5",
    }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    expect(res.body.updated).toHaveLength(2);
    expect(store.updateTask).toHaveBeenCalledWith("FN-001", {
      modelProvider: "openai",
      modelId: "gpt-4o",
      validatorModelProvider: "anthropic",
      validatorModelId: "claude-sonnet-4-5",
    });
    expect(store.updateTask).toHaveBeenCalledWith("FN-002", {
      modelProvider: "openai",
      modelId: "gpt-4o",
      validatorModelProvider: "anthropic",
      validatorModelId: "claude-sonnet-4-5",
    });
  });

  it("updates only executor model when only executor fields provided", async () => {
    const task1 = { ...FAKE_TASK_DETAIL, id: "FN-001" };
    const updated1 = { ...task1, modelProvider: "openai", modelId: "gpt-4o" };

    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValueOnce(task1);
    (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValueOnce(updated1);

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/batch-update-models", JSON.stringify({
      taskIds: ["FN-001"],
      modelProvider: "openai",
      modelId: "gpt-4o",
    }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(store.updateTask).toHaveBeenCalledWith("FN-001", {
      modelProvider: "openai",
      modelId: "gpt-4o",
    });
  });

  it("updates only validator model when only validator fields provided", async () => {
    const task1 = { ...FAKE_TASK_DETAIL, id: "FN-001" };
    const updated1 = { ...task1, validatorModelProvider: "anthropic", validatorModelId: "claude-sonnet-4-5" };

    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValueOnce(task1);
    (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValueOnce(updated1);

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/batch-update-models", JSON.stringify({
      taskIds: ["FN-001"],
      validatorModelProvider: "anthropic",
      validatorModelId: "claude-sonnet-4-5",
    }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(store.updateTask).toHaveBeenCalledWith("FN-001", {
      validatorModelProvider: "anthropic",
      validatorModelId: "claude-sonnet-4-5",
    });
  });

  it("clears models when null values provided", async () => {
    const task1 = { ...FAKE_TASK_DETAIL, id: "FN-001", modelProvider: "openai", modelId: "gpt-4o" };
    const updated1 = { ...task1, modelProvider: undefined, modelId: undefined };

    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValueOnce(task1);
    (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValueOnce(updated1);

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/batch-update-models", JSON.stringify({
      taskIds: ["FN-001"],
      modelProvider: null,
      modelId: null,
    }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(store.updateTask).toHaveBeenCalledWith("FN-001", {
      modelProvider: null,
      modelId: null,
    });
  });

  it("returns 400 when taskIds is not an array", async () => {
    const res = await REQUEST(buildApp(), "POST", "/api/tasks/batch-update-models", JSON.stringify({
      taskIds: "FN-001",
      modelProvider: "openai",
      modelId: "gpt-4o",
    }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("taskIds must be an array");
  });

  it("returns 400 when taskIds is empty", async () => {
    const res = await REQUEST(buildApp(), "POST", "/api/tasks/batch-update-models", JSON.stringify({
      taskIds: [],
      modelProvider: "openai",
      modelId: "gpt-4o",
    }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("at least one task ID");
  });

  it("returns 400 when taskIds contains non-string values", async () => {
    const res = await REQUEST(buildApp(), "POST", "/api/tasks/batch-update-models", JSON.stringify({
      taskIds: ["FN-001", 123],
      modelProvider: "openai",
      modelId: "gpt-4o",
    }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("non-empty strings");
  });

  it("bulk sets nodeId", async () => {
    const task1 = { ...FAKE_TASK_DETAIL, id: "FN-001" };
    const updated1 = { ...task1, nodeId: "node-abc" };

    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValueOnce(task1);
    (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValueOnce(updated1);

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/batch-update-models", JSON.stringify({
      taskIds: ["FN-001"],
      nodeId: "node-abc",
    }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.updated[0].nodeId).toBe("node-abc");
    expect(store.updateTask).toHaveBeenCalledWith("FN-001", expect.objectContaining({ nodeId: "node-abc" }));
  });

  it("bulk clears nodeId", async () => {
    const task1 = { ...FAKE_TASK_DETAIL, id: "FN-001", nodeId: "node-abc" };
    const updated1 = { ...task1, nodeId: undefined };

    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValueOnce(task1);
    (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValueOnce(updated1);

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/batch-update-models", JSON.stringify({
      taskIds: ["FN-001"],
      nodeId: null,
    }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(res.body.updated[0].nodeId).toBeUndefined();
    expect(store.updateTask).toHaveBeenCalledWith("FN-001", expect.objectContaining({ nodeId: null }));
  });

  it("accepts nodeId without model fields", async () => {
    const task1 = { ...FAKE_TASK_DETAIL, id: "FN-001" };
    const updated1 = { ...task1, nodeId: "node-abc" };

    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValueOnce(task1);
    (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValueOnce(updated1);

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/batch-update-models", JSON.stringify({
      taskIds: ["FN-001"],
      nodeId: "node-abc",
    }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
  });

  it("returns 400 for invalid nodeId type", async () => {
    const res = await REQUEST(buildApp(), "POST", "/api/tasks/batch-update-models", JSON.stringify({
      taskIds: ["FN-001"],
      nodeId: 123,
    }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("nodeId must be a string, null, or undefined");
  });

  it("updates nodeId across multiple tasks", async () => {
    const task1 = { ...FAKE_TASK_DETAIL, id: "FN-001" };
    const task2 = { ...FAKE_TASK_DETAIL, id: "FN-002" };
    const updated1 = { ...task1, nodeId: "node-xyz" };
    const updated2 = { ...task2, nodeId: "node-xyz" };

    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValueOnce(task1).mockResolvedValueOnce(task2);
    (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValueOnce(updated1).mockResolvedValueOnce(updated2);

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/batch-update-models", JSON.stringify({
      taskIds: ["FN-001", "FN-002"],
      nodeId: "node-xyz",
    }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    expect(res.body.updated).toHaveLength(2);
  });

  it("returns 400 when no model fields provided", async () => {
    const res = await REQUEST(buildApp(), "POST", "/api/tasks/batch-update-models", JSON.stringify({
      taskIds: ["FN-001"],
    }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("At least one model field");
  });

  it("returns 400 when only executor provider provided (missing modelId)", async () => {
    const res = await REQUEST(buildApp(), "POST", "/api/tasks/batch-update-models", JSON.stringify({
      taskIds: ["FN-001"],
      modelProvider: "openai",
    }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Executor model must include both provider and modelId");
  });

  it("returns 400 when only executor modelId provided (missing provider)", async () => {
    const res = await REQUEST(buildApp(), "POST", "/api/tasks/batch-update-models", JSON.stringify({
      taskIds: ["FN-001"],
      modelId: "gpt-4o",
    }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Executor model must include both provider and modelId");
  });

  it("returns 400 when only validator provider provided (missing modelId)", async () => {
    const res = await REQUEST(buildApp(), "POST", "/api/tasks/batch-update-models", JSON.stringify({
      taskIds: ["FN-001"],
      validatorModelProvider: "anthropic",
    }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Validator model must include both provider and modelId");
  });

  it("returns 400 when only validator modelId provided (missing provider)", async () => {
    const res = await REQUEST(buildApp(), "POST", "/api/tasks/batch-update-models", JSON.stringify({
      taskIds: ["FN-001"],
      validatorModelId: "claude-sonnet-4-5",
    }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Validator model must include both provider and modelId");
  });

  it("returns 404 when task does not exist", async () => {
    const err = new Error("Task KB-999 not found") as Error & { code: string };
    err.code = "ENOENT";
    (store.getTask as ReturnType<typeof vi.fn>).mockRejectedValueOnce(err);

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/batch-update-models", JSON.stringify({
      taskIds: ["KB-999"],
      modelProvider: "openai",
      modelId: "gpt-4o",
    }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(404);
    expect(res.body.error).toContain("KB-999 not found");
  });

  it("continues with other tasks when individual update fails", async () => {
    const task1 = { ...FAKE_TASK_DETAIL, id: "FN-001" };
    const task2 = { ...FAKE_TASK_DETAIL, id: "FN-002" };
    const updated1 = { ...task1, modelProvider: "openai", modelId: "gpt-4o" };

    (store.getTask as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(task1)
      .mockResolvedValueOnce(task2);
    (store.updateTask as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(updated1)
      .mockRejectedValueOnce(new Error("Update failed"));

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/batch-update-models", JSON.stringify({
      taskIds: ["FN-001", "FN-002"],
      modelProvider: "openai",
      modelId: "gpt-4o",
    }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.updated).toHaveLength(1);
    expect(consoleSpy).toHaveBeenCalled();

    consoleSpy.mockRestore();
  });

  it("updates only planning model when only planning fields provided", async () => {
    const task1 = { ...FAKE_TASK_DETAIL, id: "FN-001" };
    const updated1 = { ...task1, planningModelProvider: "google", planningModelId: "gemini-2.5-pro" };

    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValueOnce(task1);
    (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValueOnce(updated1);

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/batch-update-models", JSON.stringify({
      taskIds: ["FN-001"],
      planningModelProvider: "google",
      planningModelId: "gemini-2.5-pro",
    }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(store.updateTask).toHaveBeenCalledWith("FN-001", {
      planningModelProvider: "google",
      planningModelId: "gemini-2.5-pro",
    });
  });

  it("updates executor, validator, and planning models together", async () => {
    const task1 = { ...FAKE_TASK_DETAIL, id: "FN-001" };
    const updated1 = { ...task1, modelProvider: "openai", modelId: "gpt-4o", validatorModelProvider: "anthropic", validatorModelId: "claude-sonnet-4-5", planningModelProvider: "google", planningModelId: "gemini-2.5-pro" };

    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValueOnce(task1);
    (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValueOnce(updated1);

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/batch-update-models", JSON.stringify({
      taskIds: ["FN-001"],
      modelProvider: "openai",
      modelId: "gpt-4o",
      validatorModelProvider: "anthropic",
      validatorModelId: "claude-sonnet-4-5",
      planningModelProvider: "google",
      planningModelId: "gemini-2.5-pro",
    }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(store.updateTask).toHaveBeenCalledWith("FN-001", {
      modelProvider: "openai",
      modelId: "gpt-4o",
      validatorModelProvider: "anthropic",
      validatorModelId: "claude-sonnet-4-5",
      planningModelProvider: "google",
      planningModelId: "gemini-2.5-pro",
    });
  });

  it("returns 400 when only planning provider provided (missing modelId)", async () => {
    const res = await REQUEST(buildApp(), "POST", "/api/tasks/batch-update-models", JSON.stringify({
      taskIds: ["FN-001"],
      planningModelProvider: "google",
    }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Planning model must include both provider and modelId");
  });
});

describe("PATCH /tasks/:id", () => {
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

  it("forwards dependencies to store.updateTask", async () => {
    const updatedTask = { ...FAKE_TASK_DETAIL, dependencies: ["FN-002"] };
    (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValue(updatedTask);

    const res = await REQUEST(buildApp(), "PATCH", "/api/tasks/KB-001", JSON.stringify({ dependencies: ["FN-002"] }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(store.updateTask).toHaveBeenCalledWith("KB-001", {
      dependencies: ["FN-002"],
    });
    expect(res.body.dependencies).toEqual(["FN-002"]);
  });

  it("clears overlapBlockedBy when null is provided", async () => {
    const updatedTask = { ...FAKE_TASK_DETAIL, overlapBlockedBy: undefined };
    (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValue(updatedTask);

    const res = await REQUEST(buildApp(), "PATCH", "/api/tasks/KB-001", JSON.stringify({ overlapBlockedBy: null }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(store.updateTask).toHaveBeenCalledWith("KB-001", {
      overlapBlockedBy: null,
    });
  });

  it("clears status when null is provided", async () => {
    const updatedTask = { ...FAKE_TASK_DETAIL, status: undefined };
    (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValue(updatedTask);

    const res = await REQUEST(buildApp(), "PATCH", "/api/tasks/KB-001", JSON.stringify({ status: null }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(store.updateTask).toHaveBeenCalledWith("KB-001", {
      status: null,
    });
  });

  it("accepts overlapBlockedBy clear and status clear together", async () => {
    const updatedTask = { ...FAKE_TASK_DETAIL, overlapBlockedBy: undefined, status: undefined };
    (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValue(updatedTask);

    const res = await REQUEST(
      buildApp(),
      "PATCH",
      "/api/tasks/KB-001",
      JSON.stringify({ overlapBlockedBy: null, status: null }),
      {
        "Content-Type": "application/json",
      },
    );

    expect(res.status).toBe(200);
    expect(store.updateTask).toHaveBeenCalledWith("KB-001", {
      overlapBlockedBy: null,
      status: null,
    });
  });

  it("rejects non-null status values", async () => {
    const res = await REQUEST(buildApp(), "PATCH", "/api/tasks/KB-001", JSON.stringify({ status: "queued" }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("status may only be cleared via this endpoint (must be null)");
    expect(store.updateTask).not.toHaveBeenCalled();
  });

  it("rejects non-string non-null overlapBlockedBy values", async () => {
    const res = await REQUEST(buildApp(), "PATCH", "/api/tasks/KB-001", JSON.stringify({ overlapBlockedBy: 123 }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("overlapBlockedBy must be a string or null");
    expect(store.updateTask).not.toHaveBeenCalled();
  });

  it("forwards priority to store.updateTask without changing task column", async () => {
    const triageTask = { ...FAKE_TASK_DETAIL, column: "triage" as const, status: "awaiting-approval" as const };
    const updatedTask = { ...triageTask, priority: "high" as const };
    (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValue(updatedTask);

    const res = await REQUEST(buildApp(), "PATCH", "/api/tasks/KB-001", JSON.stringify({ priority: "high" }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(store.updateTask).toHaveBeenCalledWith("KB-001", { priority: "high" });
    expect(res.body.priority).toBe("high");
    expect(res.body.column).toBe("triage");
    expect(res.body.status).toBe("awaiting-approval");
  });

  it("forwards priority=null to store.updateTask (resets to default)", async () => {
    const updatedTask = { ...FAKE_TASK_DETAIL, priority: "normal" as const };
    (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValue(updatedTask);

    const res = await REQUEST(buildApp(), "PATCH", "/api/tasks/KB-001", JSON.stringify({ priority: null }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(store.updateTask).toHaveBeenCalledWith("KB-001", { priority: null });
  });

  it("rejects unknown priority values with 400", async () => {
    const res = await REQUEST(buildApp(), "PATCH", "/api/tasks/KB-001", JSON.stringify({ priority: "medium" }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(400);
    expect(store.updateTask).not.toHaveBeenCalled();
  });

  it("returns 409 when changing nodeId on an in-progress task", async () => {
    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...FAKE_TASK_DETAIL,
      id: "KB-001",
      column: "in-progress",
      nodeId: "node-old",
    });

    const res = await REQUEST(buildApp(), "PATCH", "/api/tasks/KB-001", JSON.stringify({ nodeId: "node-xyz" }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("in progress");
    expect(store.updateTask).not.toHaveBeenCalled();
  });

  it("allows changing nodeId on a todo task", async () => {
    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...FAKE_TASK_DETAIL,
      id: "KB-001",
      column: "todo",
    });
    (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValue({ ...FAKE_TASK_DETAIL, nodeId: "node-xyz" });

    const res = await REQUEST(buildApp(), "PATCH", "/api/tasks/KB-001", JSON.stringify({ nodeId: "node-xyz" }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(store.updateTask).toHaveBeenCalledWith("KB-001", { nodeId: "node-xyz" });
  });

  it("allows clearing nodeId on a todo task", async () => {
    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...FAKE_TASK_DETAIL,
      id: "KB-001",
      column: "todo",
      nodeId: "node-old",
    });
    (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValue({ ...FAKE_TASK_DETAIL, nodeId: undefined });

    const res = await REQUEST(buildApp(), "PATCH", "/api/tasks/KB-001", JSON.stringify({ nodeId: null }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(store.updateTask).toHaveBeenCalledWith("KB-001", { nodeId: null });
  });

  it("allows changing nodeId on a triage task", async () => {
    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...FAKE_TASK_DETAIL,
      id: "KB-001",
      column: "triage",
    });
    (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValue({ ...FAKE_TASK_DETAIL, nodeId: "node-xyz" });

    const res = await REQUEST(buildApp(), "PATCH", "/api/tasks/KB-001", JSON.stringify({ nodeId: "node-xyz" }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(store.updateTask).toHaveBeenCalledWith("KB-001", { nodeId: "node-xyz" });
  });

  it("allows changing nodeId on an in-review task", async () => {
    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...FAKE_TASK_DETAIL,
      id: "KB-001",
      column: "in-review",
    });
    (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValue({ ...FAKE_TASK_DETAIL, nodeId: "node-xyz" });

    const res = await REQUEST(buildApp(), "PATCH", "/api/tasks/KB-001", JSON.stringify({ nodeId: "node-xyz" }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(store.updateTask).toHaveBeenCalledWith("KB-001", { nodeId: "node-xyz" });
  });

  it("allows changing nodeId on a done task", async () => {
    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...FAKE_TASK_DETAIL,
      id: "KB-001",
      column: "done",
    });
    (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValue({ ...FAKE_TASK_DETAIL, nodeId: "node-xyz" });

    const res = await REQUEST(buildApp(), "PATCH", "/api/tasks/KB-001", JSON.stringify({ nodeId: "node-xyz" }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(store.updateTask).toHaveBeenCalledWith("KB-001", { nodeId: "node-xyz" });
  });

  it("allows clearing nodeId on a triage task", async () => {
    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...FAKE_TASK_DETAIL,
      id: "KB-001",
      column: "triage",
      nodeId: "node-old",
    });
    (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValue({ ...FAKE_TASK_DETAIL, nodeId: undefined });

    const res = await REQUEST(buildApp(), "PATCH", "/api/tasks/KB-001", JSON.stringify({ nodeId: null }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(store.updateTask).toHaveBeenCalledWith("KB-001", { nodeId: null });
  });

  it("allows clearing nodeId on an in-review task", async () => {
    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...FAKE_TASK_DETAIL,
      id: "KB-001",
      column: "in-review",
      nodeId: "node-old",
    });
    (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValue({ ...FAKE_TASK_DETAIL, nodeId: undefined });

    const res = await REQUEST(buildApp(), "PATCH", "/api/tasks/KB-001", JSON.stringify({ nodeId: null }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(store.updateTask).toHaveBeenCalledWith("KB-001", { nodeId: null });
  });

  it("allows clearing nodeId on a done task", async () => {
    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...FAKE_TASK_DETAIL,
      id: "KB-001",
      column: "done",
      nodeId: "node-old",
    });
    (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValue({ ...FAKE_TASK_DETAIL, nodeId: undefined });

    const res = await REQUEST(buildApp(), "PATCH", "/api/tasks/KB-001", JSON.stringify({ nodeId: null }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(store.updateTask).toHaveBeenCalledWith("KB-001", { nodeId: null });
  });

  it("returns 409 when clearing nodeId on an in-progress task", async () => {
    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...FAKE_TASK_DETAIL,
      id: "KB-001",
      column: "in-progress",
      nodeId: "node-old",
    });

    const res = await REQUEST(buildApp(), "PATCH", "/api/tasks/KB-001", JSON.stringify({ nodeId: null }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("in progress");
    expect(store.updateTask).not.toHaveBeenCalled();
  });

  it("returns 400 for empty nodeId string", async () => {
    const res = await REQUEST(buildApp(), "PATCH", "/api/tasks/KB-001", JSON.stringify({ nodeId: "" }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("nodeId must be a non-empty string");
    expect(store.updateTask).not.toHaveBeenCalled();
  });

  it("returns 400 for non-string nodeId", async () => {
    const res = await REQUEST(buildApp(), "PATCH", "/api/tasks/KB-001", JSON.stringify({ nodeId: 123 }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("nodeId must be a string or null");
    expect(store.updateTask).not.toHaveBeenCalled();
  });

  it("forwards sourceIssue object updates to store.updateTask", async () => {
    const sourceIssue = {
      provider: "github",
      repository: "runfusion/fusion",
      externalIssueId: "I_kgDOExample",
      issueNumber: 2473,
      url: "https://github.com/runfusion/fusion/issues/2473",
    };
    const updatedTask = { ...FAKE_TASK_DETAIL, sourceIssue };
    (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValue(updatedTask);

    const res = await REQUEST(buildApp(), "PATCH", "/api/tasks/KB-001", JSON.stringify({ sourceIssue }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(store.updateTask).toHaveBeenCalledWith("KB-001", {
      sourceIssue,
    });
    expect(res.body.sourceIssue).toEqual(sourceIssue);
  });

  it("forwards sourceIssue: null to clear existing source metadata", async () => {
    const updatedTask = { ...FAKE_TASK_DETAIL, sourceIssue: undefined };
    (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValue(updatedTask);

    const res = await REQUEST(buildApp(), "PATCH", "/api/tasks/KB-001", JSON.stringify({ sourceIssue: null }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(store.updateTask).toHaveBeenCalledWith("KB-001", {
      sourceIssue: null,
    });
  });

  it("returns 400 when sourceIssue payload is incomplete", async () => {
    const res = await REQUEST(buildApp(), "PATCH", "/api/tasks/KB-001", JSON.stringify({
      sourceIssue: {
        provider: "github",
        repository: "runfusion/fusion",
      },
    }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("sourceIssue.externalIssueId");
  });

  it("forwards githubTracking updates including null issue unlink", async () => {
    (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValue({ ...FAKE_TASK_DETAIL });

    const res = await REQUEST(buildApp(), "PATCH", "/api/tasks/KB-001", JSON.stringify({
      githubTracking: {
        enabled: true,
        repoOverride: "runfusion/fusion",
        issue: null,
      },
    }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(store.updateTask).toHaveBeenCalledWith("KB-001", {
      githubTracking: {
        enabled: true,
        repoOverride: "runfusion/fusion",
        issue: null,
      },
    });
  });

  it("creates and links a tracking issue when enabling tracking on an existing task with resolvable repo", async () => {
    const createIssueSpy = vi.spyOn(GitHubClient.prototype, "createIssue").mockResolvedValue({
      owner: "runfusion",
      repo: "fusion",
      number: 73,
      htmlUrl: "https://github.com/runfusion/fusion/issues/73",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({ githubAuthMode: "token", githubAuthToken: "tok" });
    (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...FAKE_TASK_DETAIL,
      id: "KB-001",
      githubTracking: { enabled: true, repoOverride: "runfusion/fusion" },
    });
    // First getTask (inside createTrackingIssueForTask) returns the task
    // pre-issue. Subsequent getTask (route refresh after creation) returns
    // the task with the linked issue so the response body reflects it.
    (store.getTask as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        ...FAKE_TASK_DETAIL,
        id: "KB-001",
        githubTracking: { enabled: true, repoOverride: "runfusion/fusion" },
      })
      .mockResolvedValue({
        ...FAKE_TASK_DETAIL,
        id: "KB-001",
        githubTracking: {
          enabled: true,
          repoOverride: "runfusion/fusion",
          issue: { owner: "runfusion", repo: "fusion", number: 73, url: "https://github.com/runfusion/fusion/issues/73", createdAt: "2026-01-01T00:00:00.000Z" },
        },
      });

    const res = await REQUEST(buildApp(), "PATCH", "/api/tasks/KB-001", JSON.stringify({
      githubTracking: {
        enabled: true,
        repoOverride: "runfusion/fusion",
      },
    }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(createIssueSpy).toHaveBeenCalledWith(expect.objectContaining({ owner: "runfusion", repo: "fusion" }));
    expect(store.linkGithubIssue).toHaveBeenCalledWith("KB-001", expect.objectContaining({ owner: "runfusion", repo: "fusion", number: 73 }));
    createIssueSpy.mockRestore();
  });

  it("PATCH persists githubTracking for existing tasks and links created issue with a real store", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "kb-routes-patch-github-tracking-"));
    const globalDir = mkdtempSync(join(tmpdir(), "kb-routes-patch-github-tracking-global-"));
    const realStore = new CoreTaskStore(rootDir, globalDir, { inMemoryDb: true });
    await realStore.init();

    const createIssueSpy = vi.spyOn(GitHubClient.prototype, "createIssue").mockResolvedValue({
      owner: "runfusion",
      repo: "fusion",
      number: 74,
      htmlUrl: "https://github.com/runfusion/fusion/issues/74",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    try {
      await realStore.updateSettings({
        githubAuthMode: "token",
        githubAuthToken: "tok",
        githubTrackingDefaultRepo: "runfusion/fusion",
      });
      const created = await realStore.createTask({ description: "route patch flow", column: "todo" });

      const app = express();
      app.use(express.json());
      app.use("/api", createApiRoutes(realStore));

      const res = await REQUEST(app, "PATCH", `/api/tasks/${created.id}`, JSON.stringify({
        githubTracking: { enabled: true },
      }), {
        "Content-Type": "application/json",
      });

      expect(res.status).toBe(200);
      expect(createIssueSpy).toHaveBeenCalledWith(expect.objectContaining({ owner: "runfusion", repo: "fusion" }));
      expect(res.body.githubTracking?.enabled).toBe(true);
      expect(res.body.githubTracking?.issue).toMatchObject({
        owner: "runfusion",
        repo: "fusion",
        number: 74,
      });

      const persisted = await realStore.getTask(created.id);
      expect(persisted.githubTracking?.enabled).toBe(true);
      expect(persisted.githubTracking?.issue?.number).toBe(74);
    } finally {
      createIssueSpy.mockRestore();
      realStore.close();
      rmSync(rootDir, { recursive: true, force: true });
      rmSync(globalDir, { recursive: true, force: true });
    }
  });

  it("PATCH disable unlinks and persists disabled githubTracking without recreating issue", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "kb-routes-disable-github-tracking-"));
    const globalDir = mkdtempSync(join(tmpdir(), "kb-routes-disable-github-tracking-global-"));
    const realStore = new CoreTaskStore(rootDir, globalDir, { inMemoryDb: true });
    await realStore.init();

    const createIssueSpy = vi.spyOn(GitHubClient.prototype, "createIssue").mockResolvedValue({
      owner: "runfusion",
      repo: "fusion",
      number: 99,
      htmlUrl: "https://github.com/runfusion/fusion/issues/99",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    try {
      const created = await realStore.createTask({ description: "route disable flow", column: "todo" });
      await realStore.updateGithubTracking(created.id, {
        enabled: true,
        repoOverride: "runfusion/fusion",
        issue: {
          owner: "runfusion",
          repo: "fusion",
          number: 12,
          url: "https://github.com/runfusion/fusion/issues/12",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      });

      const app = express();
      app.use(express.json());
      app.use("/api", createApiRoutes(realStore));

      const patchRes = await REQUEST(app, "PATCH", `/api/tasks/${created.id}`, JSON.stringify({
        githubTracking: { enabled: false },
      }), {
        "Content-Type": "application/json",
      });

      expect(patchRes.status).toBe(200);
      expect(patchRes.body.githubTracking?.enabled).toBe(false);
      expect(patchRes.body.githubTracking?.issue).toBeUndefined();
      expect(createIssueSpy).not.toHaveBeenCalled();

      const getRes = await REQUEST(app, "GET", `/api/tasks/${created.id}`);
      expect(getRes.status).toBe(200);
      expect(getRes.body.githubTracking?.enabled).toBe(false);
      expect(getRes.body.githubTracking?.issue).toBeUndefined();
    } finally {
      createIssueSpy.mockRestore();
      realStore.close();
      rmSync(rootDir, { recursive: true, force: true });
      rmSync(globalDir, { recursive: true, force: true });
    }
  });

  it("does not recreate tracking issue during explicit manual unlink patch", async () => {
    const createIssueSpy = vi.spyOn(GitHubClient.prototype, "createIssue").mockResolvedValue({
      owner: "runfusion",
      repo: "fusion",
      number: 99,
      htmlUrl: "https://github.com/runfusion/fusion/issues/99",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValue({ ...FAKE_TASK_DETAIL });

    const res = await REQUEST(buildApp(), "PATCH", "/api/tasks/KB-001", JSON.stringify({
      githubTracking: { issue: null },
    }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(createIssueSpy).not.toHaveBeenCalled();
    expect(store.getTask).not.toHaveBeenCalled();
    createIssueSpy.mockRestore();
  });

  it("does not create tracking issue when disabling tracking", async () => {
    const createIssueSpy = vi.spyOn(GitHubClient.prototype, "createIssue").mockResolvedValue({
      owner: "runfusion",
      repo: "fusion",
      number: 100,
      htmlUrl: "https://github.com/runfusion/fusion/issues/100",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...FAKE_TASK_DETAIL,
      id: "KB-001",
      githubTracking: { enabled: false, repoOverride: "runfusion/fusion" },
    });
    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...FAKE_TASK_DETAIL,
      id: "KB-001",
      githubTracking: { enabled: false, repoOverride: "runfusion/fusion" },
    });

    const res = await REQUEST(buildApp(), "PATCH", "/api/tasks/KB-001", JSON.stringify({
      githubTracking: { enabled: false },
    }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(createIssueSpy).not.toHaveBeenCalled();
    createIssueSpy.mockRestore();
  });

  it("retries tracking issue creation on non-tracking patch when task is enabled but unlinked", async () => {
    const createIssueSpy = vi.spyOn(GitHubClient.prototype, "createIssue").mockResolvedValue({
      owner: "runfusion",
      repo: "fusion",
      number: 101,
      htmlUrl: "https://github.com/runfusion/fusion/issues/101",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({ githubAuthMode: "token", githubAuthToken: "tok" });
    (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...FAKE_TASK_DETAIL,
      id: "KB-001",
      title: "Retitled",
      githubTracking: { enabled: true, repoOverride: "runfusion/fusion" },
    });
    // First getTask (inside createTrackingIssueForTask) returns the task
    // pre-issue. Subsequent getTask (route refresh) returns the linked state.
    (store.getTask as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        ...FAKE_TASK_DETAIL,
        id: "KB-001",
        title: "Retitled",
        githubTracking: { enabled: true, repoOverride: "runfusion/fusion" },
      })
      .mockResolvedValue({
        ...FAKE_TASK_DETAIL,
        id: "KB-001",
        title: "Retitled",
        githubTracking: {
          enabled: true,
          repoOverride: "runfusion/fusion",
          issue: { owner: "runfusion", repo: "fusion", number: 101, url: "https://github.com/runfusion/fusion/issues/101", createdAt: "2026-01-01T00:00:00.000Z" },
        },
      });

    const res = await REQUEST(buildApp(), "PATCH", "/api/tasks/KB-001", JSON.stringify({ title: "Retitled" }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(createIssueSpy).toHaveBeenCalledWith(expect.objectContaining({ owner: "runfusion", repo: "fusion" }));
    expect(store.linkGithubIssue).toHaveBeenCalledWith("KB-001", expect.objectContaining({ number: 101 }));
    createIssueSpy.mockRestore();
  });

  it("returns 400 for invalid githubTracking repo override format", async () => {
    const res = await REQUEST(buildApp(), "PATCH", "/api/tasks/KB-001", JSON.stringify({
      githubTracking: {
        repoOverride: "invalid repo",
      },
    }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("owner/repo");
  });

  it("does not clear model or assignee fields when they are omitted", async () => {
    (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValue({ ...FAKE_TASK_DETAIL, title: "New" });

    const res = await REQUEST(buildApp(), "PATCH", "/api/tasks/KB-001", JSON.stringify({ title: "New" }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(store.updateTask).toHaveBeenCalledWith("KB-001", { title: "New" });
    expect(store.updateTask).not.toHaveBeenCalledWith(
      "KB-001",
      expect.objectContaining({
        modelProvider: null,
        modelId: null,
        assigneeUserId: null,
      }),
    );
  });

  it("forwards title and description without dependencies", async () => {
    (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValue({ ...FAKE_TASK_DETAIL, title: "New" });

    const res = await REQUEST(buildApp(), "PATCH", "/api/tasks/KB-001", JSON.stringify({ title: "New" }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(store.updateTask).toHaveBeenCalledWith("KB-001", {
      title: "New",
    });
  });

  it("forwards model override fields to store.updateTask", async () => {
    (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...FAKE_TASK_DETAIL,
      modelProvider: "anthropic",
      modelId: "claude-sonnet-4-5",
      validatorModelProvider: "openai",
      validatorModelId: "gpt-4o",
    });

    const res = await REQUEST(buildApp(), "PATCH", "/api/tasks/KB-001", JSON.stringify({
      modelProvider: "anthropic",
      modelId: "claude-sonnet-4-5",
      validatorModelProvider: "openai",
      validatorModelId: "gpt-4o",
    }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(store.updateTask).toHaveBeenCalledWith("KB-001", {
      modelProvider: "anthropic",
      modelId: "claude-sonnet-4-5",
      validatorModelProvider: "openai",
      validatorModelId: "gpt-4o",
    });
  });

  it("forwards assigneeUserId to store.updateTask", async () => {
    (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...FAKE_TASK_DETAIL,
      assigneeUserId: "requesting-user",
    });

    const res = await REQUEST(buildApp(), "PATCH", "/api/tasks/KB-001", JSON.stringify({
      assigneeUserId: "requesting-user",
    }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(store.updateTask).toHaveBeenCalledWith("KB-001", {
      assigneeUserId: "requesting-user",
    });
  });

  it("returns 400 for invalid modelProvider type", async () => {
    const res = await REQUEST(buildApp(), "PATCH", "/api/tasks/KB-001", JSON.stringify({
      modelProvider: 123,
    }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("modelProvider must be a string");
  });

  it("returns 400 for invalid modelId type", async () => {
    const res = await REQUEST(buildApp(), "PATCH", "/api/tasks/KB-001", JSON.stringify({
      modelId: true,
    }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("modelId must be a string");
  });

  it("accepts null to clear model fields", async () => {
    (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...FAKE_TASK_DETAIL,
      modelProvider: undefined,
      modelId: undefined,
    });

    const res = await REQUEST(buildApp(), "PATCH", "/api/tasks/KB-001", JSON.stringify({
      modelProvider: null,
      modelId: null,
    }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(store.updateTask).toHaveBeenCalledWith("KB-001", {
      modelProvider: null,
      modelId: null,
    });
  });

  it("forwards planning model override fields to store.updateTask", async () => {
    (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...FAKE_TASK_DETAIL,
      planningModelProvider: "google",
      planningModelId: "gemini-2.5-pro",
      thinkingLevel: undefined,
      assigneeUserId: null,
    });

    const res = await REQUEST(buildApp(), "PATCH", "/api/tasks/KB-001", JSON.stringify({
      planningModelProvider: "google",
      planningModelId: "gemini-2.5-pro",
    }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(store.updateTask).toHaveBeenCalledWith("KB-001", {
      planningModelProvider: "google",
      planningModelId: "gemini-2.5-pro",
    });
  });

  it("returns 400 for invalid planningModelProvider type", async () => {
    const res = await REQUEST(buildApp(), "PATCH", "/api/tasks/KB-001", JSON.stringify({
      planningModelProvider: 123,
    }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("planningModelProvider must be a string");
  });

  it("returns 400 for invalid planningModelId type", async () => {
    const res = await REQUEST(buildApp(), "PATCH", "/api/tasks/KB-001", JSON.stringify({
      planningModelId: true,
    }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("planningModelId must be a string");
  });

  it("accepts null to clear planning model fields", async () => {
    (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...FAKE_TASK_DETAIL,
      planningModelProvider: undefined,
      planningModelId: undefined,
    });

    const res = await REQUEST(buildApp(), "PATCH", "/api/tasks/KB-001", JSON.stringify({
      planningModelProvider: null,
      planningModelId: null,
    }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(store.updateTask).toHaveBeenCalledWith("KB-001", {
      planningModelProvider: null,
      planningModelId: null,
    });
  });

  it("forwards enabledWorkflowSteps to store.updateTask", async () => {
    (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...FAKE_TASK_DETAIL,
      enabledWorkflowSteps: ["browser-verification"],
    });

    const res = await REQUEST(buildApp(), "PATCH", "/api/tasks/KB-001", JSON.stringify({
      enabledWorkflowSteps: ["browser-verification"],
    }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(store.updateTask).toHaveBeenCalledWith("KB-001", {
      enabledWorkflowSteps: ["browser-verification"],
    });
  });

  it("returns 400 for invalid enabledWorkflowSteps type", async () => {
    const res = await REQUEST(buildApp(), "PATCH", "/api/tasks/KB-001", JSON.stringify({
      enabledWorkflowSteps: [123],
    }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("enabledWorkflowSteps must be an array of strings");
  });

  it("forwards thinkingLevel to store.updateTask", async () => {
    (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...FAKE_TASK_DETAIL,
      thinkingLevel: "high",
    });

    const res = await REQUEST(buildApp(), "PATCH", "/api/tasks/KB-001", JSON.stringify({
      thinkingLevel: "high",
    }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(store.updateTask).toHaveBeenCalledWith("KB-001", {
      thinkingLevel: "high",
    });
  });

  it("accepts null to clear thinkingLevel via PATCH", async () => {
    (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...FAKE_TASK_DETAIL,
      thinkingLevel: undefined,
      assigneeUserId: null,
    });

    const res = await REQUEST(buildApp(), "PATCH", "/api/tasks/KB-001", JSON.stringify({
      thinkingLevel: null,
    }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(store.updateTask).toHaveBeenCalledWith("KB-001", {
      thinkingLevel: null,
    });
  });

  it("returns 400 for invalid thinkingLevel value via PATCH", async () => {
    const res = await REQUEST(buildApp(), "PATCH", "/api/tasks/KB-001", JSON.stringify({
      thinkingLevel: "invalid",
    }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("thinkingLevel must be one of");
  });

  it("forwards reviewLevel to store.updateTask", async () => {
    (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...FAKE_TASK_DETAIL,
      reviewLevel: 2,
    });

    const res = await REQUEST(buildApp(), "PATCH", "/api/tasks/KB-001", JSON.stringify({
      reviewLevel: 2,
    }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(store.updateTask).toHaveBeenCalledWith("KB-001", {
      reviewLevel: 2,
    });
  });

  it("accepts null to clear reviewLevel via PATCH", async () => {
    (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...FAKE_TASK_DETAIL,
      reviewLevel: undefined,
    });

    const res = await REQUEST(buildApp(), "PATCH", "/api/tasks/KB-001", JSON.stringify({
      reviewLevel: null,
    }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(store.updateTask).toHaveBeenCalledWith("KB-001", {
      reviewLevel: null,
    });
  });

  it("returns 400 for invalid reviewLevel value via PATCH", async () => {
    const res = await REQUEST(buildApp(), "PATCH", "/api/tasks/KB-001", JSON.stringify({
      reviewLevel: 5,
    }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("reviewLevel must be an integer between 0 and 3");
  });

  it("returns 400 for non-integer reviewLevel via PATCH", async () => {
    const res = await REQUEST(buildApp(), "PATCH", "/api/tasks/KB-001", JSON.stringify({
      reviewLevel: 1.5,
    }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("reviewLevel must be an integer between 0 and 3");
  });

  it("forwards executionMode to store.updateTask", async () => {
    (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...FAKE_TASK_DETAIL,
      executionMode: "fast",
    });

    const res = await REQUEST(buildApp(), "PATCH", "/api/tasks/KB-001", JSON.stringify({
      executionMode: "fast",
    }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(store.updateTask).toHaveBeenCalledWith("KB-001", {
      executionMode: "fast",
    });
  });

  it("accepts null to clear executionMode via PATCH", async () => {
    (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...FAKE_TASK_DETAIL,
      executionMode: undefined,
    });

    const res = await REQUEST(buildApp(), "PATCH", "/api/tasks/KB-001", JSON.stringify({
      executionMode: null,
    }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(store.updateTask).toHaveBeenCalledWith("KB-001", {
      executionMode: null,
    });
  });

  it("returns 400 for invalid executionMode value via PATCH", async () => {
    const res = await REQUEST(buildApp(), "PATCH", "/api/tasks/KB-001", JSON.stringify({
      executionMode: "turbo",
    }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("executionMode must be one of");
  });

  it("omission does not overwrite executionMode via PATCH", async () => {
    // When executionMode is not in the request body, it should not be passed to updateTask
    const existingTask = {
      ...FAKE_TASK_DETAIL,
      executionMode: "fast",
    };
    (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValue(existingTask);

    const res = await REQUEST(buildApp(), "PATCH", "/api/tasks/KB-001", JSON.stringify({
      title: "Updated Title",  // Only update title, not executionMode
    }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    // Verify executionMode was NOT included in the update
    expect(store.updateTask).toHaveBeenCalledWith("KB-001", {
      title: "Updated Title",
    });
    // The call should NOT include executionMode
    const updateArg = (store.updateTask as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(updateArg).not.toHaveProperty("executionMode");
  });
});


describe("PATCH /tasks/:id/assign and GET /agents/:id/tasks", () => {
  let tempDir: string;
  let fusionDir: string;
  let agentId: string;
  let reviewerAgentId: string;
  let engineerAgentId: string;
  let store: TaskStore;

  // Agent store init + createAgent is ~50ms per call; hoisted to beforeAll
  // because no test in this block mutates the agent row.
  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "kb-routes-task-assign-"));
    fusionDir = join(tempDir, ".fusion");
    mkdirSync(fusionDir, { recursive: true });

    const { AgentStore } = await import("@fusion/core");
    const agentStore = new AgentStore({ rootDir: fusionDir });
    await agentStore.init();
    const agent = await agentStore.createAgent({
      name: "Assignment test agent",
      role: "executor",
    });
    const reviewer = await agentStore.createAgent({
      name: "Assignment reviewer agent",
      role: "reviewer",
    });
    const engineer = await agentStore.createAgent({
      name: "Assignment engineer agent",
      role: "engineer",
    });
    agentId = agent.id;
    reviewerAgentId = reviewer.id;
    engineerAgentId = engineer.id;
  }, 30_000);

  beforeEach(() => {
    store = createMockStore({
      getFusionDir: vi.fn().mockReturnValue(fusionDir),
      updateTask: vi.fn(),
      getTask: vi.fn().mockResolvedValue({ ...FAKE_TASK_DETAIL, id: "FN-200", column: "todo" }),
      listTasks: vi.fn().mockResolvedValue([]),
      selectNextTaskForAgent: vi.fn().mockResolvedValue(null),
    } as any);
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store));
    return app;
  }

  it("assigns a task to an existing agent", async () => {
    (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...FAKE_TASK_DETAIL,
      id: "FN-200",
      assignedAgentId: agentId,
    });

    const res = await REQUEST(buildApp(), "PATCH", "/api/tasks/FN-200/assign", JSON.stringify({ agentId }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(store.updateTask).toHaveBeenCalledWith("FN-200", { assignedAgentId: agentId });
    expect(res.body.assignedAgentId).toBe(agentId);
  }, 20000);

  it("allows assigning implementation task to durable engineer without override", async () => {
    (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...FAKE_TASK_DETAIL,
      id: "FN-200",
      assignedAgentId: engineerAgentId,
    });

    const res = await REQUEST(
      buildApp(),
      "PATCH",
      "/api/tasks/FN-200/assign",
      JSON.stringify({ agentId: engineerAgentId }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(200);
    expect(store.updateTask).toHaveBeenCalledWith("FN-200", { assignedAgentId: engineerAgentId });
  }, 20000);

  it("returns 409 when assigning implementation task to reviewer without override", async () => {
    const res = await REQUEST(
      buildApp(),
      "PATCH",
      "/api/tasks/FN-200/assign",
      JSON.stringify({ agentId: reviewerAgentId }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("requires an \"executor\"-role agent");
    expect(store.updateTask).not.toHaveBeenCalled();
  }, 20000);

  it("allows non-executor assignment when override is true", async () => {
    (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...FAKE_TASK_DETAIL,
      id: "FN-200",
      assignedAgentId: reviewerAgentId,
    });

    const res = await REQUEST(
      buildApp(),
      "PATCH",
      "/api/tasks/FN-200/assign",
      JSON.stringify({ agentId: reviewerAgentId, override: true }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(200);
    expect(store.updateTask).toHaveBeenCalledWith("FN-200", { assignedAgentId: reviewerAgentId });
  }, 20000);

  it("returns 404 when assigning to a non-existent agent", async () => {
    const res = await REQUEST(
      buildApp(),
      "PATCH",
      "/api/tasks/FN-200/assign",
      JSON.stringify({ agentId: "agent-missing" }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Agent not found");
    expect(store.updateTask).not.toHaveBeenCalled();
  }, 20000);

  it("unassigns a task when agentId is null", async () => {
    (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...FAKE_TASK_DETAIL,
      id: "FN-200",
      assignedAgentId: undefined,
    });

    const res = await REQUEST(
      buildApp(),
      "PATCH",
      "/api/tasks/FN-200/assign",
      JSON.stringify({ agentId: null }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(200);
    expect(store.updateTask).toHaveBeenCalledWith("FN-200", { assignedAgentId: null });
    expect(res.body.assignedAgentId).toBeUndefined();
  }, 20000);

  it("returns tasks assigned to the specified agent", async () => {
    (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
      { ...FAKE_TASK_DETAIL, id: "FN-001", assignedAgentId: agentId },
      { ...FAKE_TASK_DETAIL, id: "FN-002", assignedAgentId: "agent-other" },
      { ...FAKE_TASK_DETAIL, id: "FN-003" },
    ]);

    const res = await GET(buildApp(), `/api/agents/${agentId}/tasks`);

    expect(res.status).toBe(200);
    expect(res.body.map((task: { id: string }) => task.id)).toEqual(["FN-001"]);
  }, 20000);

  it("returns 404 for /api/agents/:id/tasks when agent does not exist", async () => {
    const res = await GET(buildApp(), "/api/agents/agent-missing/tasks");

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Agent not found");
    expect(store.listTasks).not.toHaveBeenCalled();
  }, 30_000);

  it("PATCH /tasks/:id/assign-user assigns user to task", async () => {
    (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...FAKE_TASK_DETAIL,
      id: "FN-200",
      assigneeUserId: "requesting-user",
    });

    const res = await REQUEST(
      buildApp(),
      "PATCH",
      "/api/tasks/FN-200/assign-user",
      JSON.stringify({ userId: "requesting-user" }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(200);
    expect(store.updateTask).toHaveBeenCalledWith("FN-200", {
      assigneeUserId: "requesting-user",
      status: null, // clears awaiting-user-review status
    });
    expect(res.body.assigneeUserId).toBe("requesting-user");
  }, 20000);

  it("PATCH /tasks/:id/assign-user clears user assignment when userId is null", async () => {
    (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...FAKE_TASK_DETAIL,
      id: "FN-200",
      assigneeUserId: undefined,
    });

    const res = await REQUEST(
      buildApp(),
      "PATCH",
      "/api/tasks/FN-200/assign-user",
      JSON.stringify({ userId: null }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(200);
    expect(store.updateTask).toHaveBeenCalledWith("FN-200", { assigneeUserId: null });
    expect(res.body.assigneeUserId).toBeUndefined();
  }, 20000);

  it("POST /tasks/:id/accept-review clears assignee and status", async () => {
    (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...FAKE_TASK_DETAIL,
      id: "FN-200",
      column: "in-review",
      assigneeUserId: undefined,
      status: undefined,
    });

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/FN-200/accept-review");

    expect(res.status).toBe(200);
    expect(store.updateTask).toHaveBeenCalledWith("FN-200", {
      assigneeUserId: null,
      status: null,
    });
  }, 20000);

  it("POST /tasks/:id/return-to-agent clears assignee and status, moves to todo", async () => {
    (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...FAKE_TASK_DETAIL,
      id: "FN-200",
      assigneeUserId: undefined,
      status: undefined,
    });
    (store.moveTask as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...FAKE_TASK_DETAIL,
      id: "FN-200",
      column: "todo",
    });

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/FN-200/return-to-agent");

    expect(res.status).toBe(200);
    expect(store.updateTask).toHaveBeenCalledWith("FN-200", {
      assigneeUserId: null,
      status: null,
    });
    expect(store.moveTask).toHaveBeenCalledWith("FN-200", "todo");
  }, 20000);

  it("POST /api/agents/:id/inbox returns next selection when work exists", async () => {
    const inboxTask = {
      ...FAKE_TASK_DETAIL,
      id: "FN-500",
      assignedAgentId: agentId,
    };

    (store.selectNextTaskForAgent as ReturnType<typeof vi.fn>).mockResolvedValue({
      task: inboxTask,
      priority: "todo",
      reason: "Selecting oldest ready todo task assigned to this agent",
    });

    const res = await REQUEST(buildApp(), "POST", `/api/agents/${agentId}/inbox`);

    expect(res.status).toBe(200);
    expect(store.selectNextTaskForAgent).toHaveBeenCalledWith(agentId);
    expect(res.body).toEqual({
      task: expect.objectContaining({ id: "FN-500" }),
      priority: "todo",
      reason: "Selecting oldest ready todo task assigned to this agent",
    });
  }, 30_000);

  it("POST /api/agents/:id/inbox returns task:null when no work exists", async () => {
    (store.selectNextTaskForAgent as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const res = await REQUEST(buildApp(), "POST", `/api/agents/${agentId}/inbox`);

    expect(res.status).toBe(200);
    expect(store.selectNextTaskForAgent).toHaveBeenCalledWith(agentId);
    expect(res.body).toEqual({ task: null });
  }, 30_000);

  it("POST /api/agents/:id/inbox returns 404 for missing agent", async () => {
    const res = await REQUEST(buildApp(), "POST", "/api/agents/agent-missing/inbox");

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Agent not found");
    expect(store.selectNextTaskForAgent).not.toHaveBeenCalled();
  }, 30_000);
});

describe("Task checkout routes", () => {
  let tempDir: string;
  let fusionDir: string;
  let store: TaskStore;
  let agentAId: string;
  let agentBId: string;
  let taskState: TaskDetail;

  // Agent store init + createAgent is ~50ms per call; hoisted to beforeAll
  // because no test in this block mutates the agent rows.
  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "kb-routes-task-checkout-"));
    fusionDir = join(tempDir, ".fusion");
    mkdirSync(fusionDir, { recursive: true });

    const { AgentStore } = await import("@fusion/core");
    const agentStore = new AgentStore({ rootDir: fusionDir });
    await agentStore.init();

    const agentA = await agentStore.createAgent({
      name: "Checkout Agent A",
      role: "executor",
    });
    const agentB = await agentStore.createAgent({
      name: "Checkout Agent B",
      role: "executor",
    });

    agentAId = agentA.id;
    agentBId = agentB.id;
  }, 30_000);

  beforeEach(() => {
    taskState = {
      ...FAKE_TASK_DETAIL,
      id: "FN-300",
      checkedOutBy: undefined,
      checkedOutAt: undefined,
    };

    store = createMockStore({
      getFusionDir: vi.fn().mockReturnValue(fusionDir),
      getTask: vi.fn().mockImplementation(async (id: string) => {
        if (id !== taskState.id) {
          return null;
        }
        return { ...taskState };
      }),
      updateTask: vi.fn().mockImplementation(async (id: string, updates: { checkedOutBy?: string | null; checkedOutAt?: string | null }) => {
        if (id !== taskState.id) {
          throw new Error(`Task ${id} not found`);
        }

        if (updates.checkedOutBy === null) {
          taskState.checkedOutBy = undefined;
          taskState.checkedOutAt = undefined;
        } else if (updates.checkedOutBy !== undefined) {
          taskState.checkedOutBy = updates.checkedOutBy;
          taskState.checkedOutAt = updates.checkedOutAt ?? new Date().toISOString();
        }

        return { ...taskState };
      }),
      logEntry: vi.fn().mockResolvedValue(undefined),
    } as any);
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store));
    return app;
  }

  it("POST /tasks/:id/checkout — returns 200 on success", async () => {
    const res = await REQUEST(
      buildApp(),
      "POST",
      `/api/tasks/${taskState.id}/checkout`,
      JSON.stringify({ agentId: agentAId }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(200);
    expect(res.body.checkedOutBy).toBe(agentAId);
    expect(res.body.checkedOutAt).toBeTruthy();
  }, 20_000);

  it("POST /tasks/:id/checkout — returns 409 on conflict", async () => {
    await REQUEST(
      buildApp(),
      "POST",
      `/api/tasks/${taskState.id}/checkout`,
      JSON.stringify({ agentId: agentAId }),
      { "Content-Type": "application/json" },
    );

    const res = await REQUEST(
      buildApp(),
      "POST",
      `/api/tasks/${taskState.id}/checkout`,
      JSON.stringify({ agentId: agentBId }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Task is already checked out");
    expect(res.body.currentHolder).toBe(agentAId);
    expect(res.body.taskId).toBe(taskState.id);
  }, 20_000);

  it("POST /tasks/:id/checkout — returns 400 when agentId is missing", async () => {
    const res = await REQUEST(
      buildApp(),
      "POST",
      `/api/tasks/${taskState.id}/checkout`,
      JSON.stringify({}),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("agentId is required");
  }, 20_000);

  it("POST /tasks/:id/release — returns 200 on success", async () => {
    await REQUEST(
      buildApp(),
      "POST",
      `/api/tasks/${taskState.id}/checkout`,
      JSON.stringify({ agentId: agentAId }),
      { "Content-Type": "application/json" },
    );

    const res = await REQUEST(
      buildApp(),
      "POST",
      `/api/tasks/${taskState.id}/release`,
      JSON.stringify({ agentId: agentAId }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(200);
    expect(res.body.checkedOutBy).toBeUndefined();

    const statusRes = await GET(buildApp(), `/api/tasks/${taskState.id}/checkout`);
    expect(statusRes.status).toBe(200);
    expect(statusRes.body.checkedOutBy).toBeNull();
    expect(statusRes.body.checkedOutAt).toBeNull();
  }, 20_000);

  it("POST /tasks/:id/release — returns 403 for wrong holder", async () => {
    await REQUEST(
      buildApp(),
      "POST",
      `/api/tasks/${taskState.id}/checkout`,
      JSON.stringify({ agentId: agentAId }),
      { "Content-Type": "application/json" },
    );

    const res = await REQUEST(
      buildApp(),
      "POST",
      `/api/tasks/${taskState.id}/release`,
      JSON.stringify({ agentId: agentBId }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Not the checkout holder");
  }, 20_000);

  it("POST /tasks/:id/release — returns 400 when agentId is missing", async () => {
    const res = await REQUEST(
      buildApp(),
      "POST",
      `/api/tasks/${taskState.id}/release`,
      JSON.stringify({}),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("agentId is required");
  }, 20_000);

  it("GET /tasks/:id/checkout — returns checkout status", async () => {
    await REQUEST(
      buildApp(),
      "POST",
      `/api/tasks/${taskState.id}/checkout`,
      JSON.stringify({ agentId: agentAId }),
      { "Content-Type": "application/json" },
    );

    const res = await GET(buildApp(), `/api/tasks/${taskState.id}/checkout`);

    expect(res.status).toBe(200);
    expect(res.body.checkedOutBy).toBe(agentAId);
    expect(res.body.checkedOutAt).toBeTruthy();
  }, 20_000);

  it("POST /tasks/:id/force-release — clears active checkout", async () => {
    await REQUEST(
      buildApp(),
      "POST",
      `/api/tasks/${taskState.id}/checkout`,
      JSON.stringify({ agentId: agentAId }),
      { "Content-Type": "application/json" },
    );

    const res = await REQUEST(
      buildApp(),
      "POST",
      `/api/tasks/${taskState.id}/force-release`,
    );

    expect(res.status).toBe(200);

    const statusRes = await GET(buildApp(), `/api/tasks/${taskState.id}/checkout`);
    expect(statusRes.status).toBe(200);
    expect(statusRes.body.checkedOutBy).toBeNull();
    expect(statusRes.body.checkedOutAt).toBeNull();
  }, 20_000);
});

describe("Attachment routes", () => {
  const FAKE_ATTACHMENT: TaskAttachment = {
    filename: "1234-screenshot.png",
    originalName: "screenshot.png",
    mimeType: "image/png",
    size: 100,
    createdAt: "2026-01-01T00:00:00.000Z",
  };

  let store: TaskStore;

  beforeEach(() => {
    store = createMockStore({
      addAttachment: vi.fn().mockResolvedValue(FAKE_ATTACHMENT),
      getAttachment: vi.fn(),
      deleteAttachment: vi.fn().mockResolvedValue({ ...FAKE_TASK_DETAIL, attachments: [] }),
    });
  });

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store));
    return app;
  }

  it("POST /tasks/:id/attachments — uploads a valid image", async () => {
    const content = Buffer.from("fake png content");
    const { body, boundary } = buildMultipart("file", "screenshot.png", "image/png", content);

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/KB-001/attachments", body, {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    });

    expect(res.status).toBe(201);
    expect(res.body.filename).toBe("1234-screenshot.png");
    expect((store.addAttachment as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      "KB-001",
      "screenshot.png",
      expect.any(Buffer),
      "image/png",
    );
  });

  it("POST /tasks/:id/attachments — returns 400 for invalid mime type", async () => {
    (store.addAttachment as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Invalid mime type 'text/plain'. Allowed: image/png, image/jpeg, image/gif, image/webp"),
    );

    const content = Buffer.from("not an image");
    const { body, boundary } = buildMultipart("file", "file.txt", "text/plain", content);

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/KB-001/attachments", body, {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Invalid mime type");
  });

  it("POST /tasks/:id/attachments — returns 400 for oversized file", async () => {
    (store.addAttachment as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("File too large"),
    );

    const content = Buffer.from("small but store rejects");
    const { body, boundary } = buildMultipart("file", "big.png", "image/png", content);

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/KB-001/attachments", body, {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("File too large");
  });

  it("DELETE /tasks/:id/attachments/:filename — deletes attachment", async () => {
    const res = await REQUEST(buildApp(), "DELETE", "/api/tasks/KB-001/attachments/1234-screenshot.png");

    expect(res.status).toBe(200);
    expect((store.deleteAttachment as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith("KB-001", "1234-screenshot.png");
  });

  it("DELETE /tasks/:id/attachments/:filename — returns 404 for missing", async () => {
    const err: NodeJS.ErrnoException = new Error("Attachment not found");
    err.code = "ENOENT";
    (store.deleteAttachment as ReturnType<typeof vi.fn>).mockRejectedValue(err);

    const res = await REQUEST(buildApp(), "DELETE", "/api/tasks/KB-001/attachments/nope.png");

    expect(res.status).toBe(404);
  });

  it("GET /tasks/:id/logs — returns agent logs", async () => {
    const fakeLogs = [
      { timestamp: "2026-01-01T00:00:00Z", taskId: "FN-001", text: "Hello", type: "text" },
      { timestamp: "2026-01-01T00:00:01Z", taskId: "FN-001", text: "Read", type: "tool" },
    ];
    (store.getAgentLogs as ReturnType<typeof vi.fn>).mockResolvedValue(fakeLogs);

    const res = await GET(buildApp(), "/api/tasks/KB-001/logs");

    expect(res.status).toBe(200);
    expect(res.body).toEqual(fakeLogs);
    expect(store.getAgentLogs).toHaveBeenCalledWith("KB-001", undefined);
  });

  it("GET /tasks/:id/logs — includes pagination headers on bounded initial load", async () => {
    const fakeLogs = [
      { timestamp: "2026-01-01T00:00:00Z", taskId: "FN-001", text: "Hello", type: "text" },
      { timestamp: "2026-01-01T00:00:01Z", taskId: "FN-001", text: "Read", type: "tool" },
    ];
    (store.getAgentLogs as ReturnType<typeof vi.fn>).mockResolvedValue(fakeLogs);
    (store.getAgentLogCount as ReturnType<typeof vi.fn>).mockResolvedValue(5);

    const res = await performGet(buildApp(), "/api/tasks/KB-001/logs?limit=2");

    expect(res.status).toBe(200);
    expect(res.body).toEqual(fakeLogs);
    expect(store.getAgentLogs).toHaveBeenCalledWith("KB-001", { limit: 2 });
    expect(res.headers["x-total-count"]).toBe("5");
    expect(res.headers["x-has-more"]).toBe("true");
  });

  it("GET /tasks/:id/logs — returns empty array when no logs", async () => {
    (store.getAgentLogs as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const res = await GET(buildApp(), "/api/tasks/KB-001/logs");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("GET /tasks/:id/logs — returns 500 on store error", async () => {
    (store.getAgentLogs as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("disk error"));

    const res = await GET(buildApp(), "/api/tasks/KB-001/logs");

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("disk error");
  });

  it("GET /tasks/:id/logs — preserves long text and detail without truncation", async () => {
    const longText = "A".repeat(5000);
    const longDetail = "B".repeat(5000);
    const fakeLogs = [
      { timestamp: "2026-01-01T00:00:00Z", taskId: "KB-001", text: longText, type: "text" },
      { timestamp: "2026-01-01T00:00:01Z", taskId: "KB-001", text: "Read", type: "tool", detail: longDetail },
    ];
    (store.getAgentLogs as ReturnType<typeof vi.fn>).mockResolvedValue(fakeLogs);

    const res = await GET(buildApp(), "/api/tasks/KB-001/logs");

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].text).toBe(longText);
    expect(res.body[0].text.length).toBe(5000);
    expect(res.body[1].detail).toBe(longDetail);
    expect(res.body[1].detail.length).toBe(5000);
  });

  it("GET /activity — defaults to a bounded limit when none is provided", async () => {
    const fakeEntries = [
      {
        id: "activity-1",
        timestamp: "2026-01-01T00:00:00Z",
        type: "task:created",
        details: "Created task",
      },
    ];
    const activityStore = createMockStore({
      getActivityLog: vi.fn().mockResolvedValue(fakeEntries),
    });

    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(activityStore));

    const res = await GET(app, "/api/activity");

    expect(res.status).toBe(200);
    expect(res.body).toEqual(fakeEntries);
    expect(activityStore.getActivityLog).toHaveBeenCalledWith({
      limit: 100,
      since: undefined,
      type: undefined,
    });
  });
});

