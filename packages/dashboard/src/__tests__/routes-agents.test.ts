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


import { DEFAULT_SETTINGS } from "@fusion/core";

afterEach(() => {
  resetDiagnosticsSink();
});


describe("GET /workflow-steps", () => {
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

  it("returns empty array when no workflow steps exist", async () => {
    const res = await GET(buildApp(), "/api/workflow-steps");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("returns workflow steps", async () => {
    const steps = [
      { id: "WS-001", name: "Docs", description: "Check docs", prompt: "Review docs", enabled: true, createdAt: "2026-01-01", updatedAt: "2026-01-01" },
    ];
    (store.listWorkflowSteps as ReturnType<typeof vi.fn>).mockResolvedValueOnce(steps);

    const res = await GET(buildApp(), "/api/workflow-steps");
    expect(res.status).toBe(200);
    expect(res.body).toEqual(steps);
  });
});

describe("POST /workflow-steps", () => {
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

  it("creates a workflow step", async () => {
    const created = { id: "WS-001", name: "Docs", description: "Check docs", mode: "prompt", prompt: "", enabled: true, createdAt: "2026-01-01", updatedAt: "2026-01-01" };
    (store.createWorkflowStep as ReturnType<typeof vi.fn>).mockResolvedValueOnce(created);

    const res = await REQUEST(buildApp(), "POST", "/api/workflow-steps", JSON.stringify({
      name: "Docs",
      description: "Check docs",
    }), { "Content-Type": "application/json" });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe("WS-001");
    expect(store.createWorkflowStep).toHaveBeenCalledWith({
      name: "Docs",
      description: "Check docs",
      mode: "prompt",
      phase: undefined,
      prompt: undefined,
      scriptName: undefined,
      enabled: undefined,
      defaultOn: false,
    });
  });

  it("returns 400 when name is missing", async () => {
    const res = await REQUEST(buildApp(), "POST", "/api/workflow-steps", JSON.stringify({
      description: "Check docs",
    }), { "Content-Type": "application/json" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("name");
  });

  it("returns 400 when description is missing", async () => {
    const res = await REQUEST(buildApp(), "POST", "/api/workflow-steps", JSON.stringify({
      name: "Docs",
    }), { "Content-Type": "application/json" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("description");
  });

  it("returns 409 when name already exists", async () => {
    (store.listWorkflowSteps as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { id: "WS-001", name: "Docs", description: "Check docs", prompt: "", enabled: true, createdAt: "2026-01-01", updatedAt: "2026-01-01" },
    ]);

    const res = await REQUEST(buildApp(), "POST", "/api/workflow-steps", JSON.stringify({
      name: "Docs",
      description: "Another docs step",
    }), { "Content-Type": "application/json" });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("already exists");
  });

  it("creates a workflow step with model override", async () => {
    const created = { id: "WS-002", name: "Security", description: "Security audit", prompt: "", enabled: true, modelProvider: "anthropic", modelId: "claude-sonnet-4-5", createdAt: "2026-01-01", updatedAt: "2026-01-01" };
    (store.createWorkflowStep as ReturnType<typeof vi.fn>).mockResolvedValueOnce(created);

    const res = await REQUEST(buildApp(), "POST", "/api/workflow-steps", JSON.stringify({
      name: "Security",
      description: "Security audit",
      modelProvider: "anthropic",
      modelId: "claude-sonnet-4-5",
    }), { "Content-Type": "application/json" });

    expect(res.status).toBe(201);
    expect(store.createWorkflowStep).toHaveBeenCalledWith({
      name: "Security",
      description: "Security audit",
      mode: "prompt",
      phase: undefined,
      prompt: undefined,
      scriptName: undefined,
      enabled: undefined,
      defaultOn: false,
      modelProvider: "anthropic",
      modelId: "claude-sonnet-4-5",
    });
  });

  it("returns 400 when model provider is set without modelId", async () => {
    const res = await REQUEST(buildApp(), "POST", "/api/workflow-steps", JSON.stringify({
      name: "Security",
      description: "Security audit",
      modelProvider: "anthropic",
    }), { "Content-Type": "application/json" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("must include both provider and modelId");
  });

  it("returns 400 when modelId is set without model provider", async () => {
    const res = await REQUEST(buildApp(), "POST", "/api/workflow-steps", JSON.stringify({
      name: "Security",
      description: "Security audit",
      modelId: "claude-sonnet-4-5",
    }), { "Content-Type": "application/json" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("must include both provider and modelId");
  });

  it("creates a workflow step without model fields when both empty strings", async () => {
    const created = { id: "WS-001", name: "Docs", description: "Check docs", mode: "prompt", prompt: "", enabled: true, createdAt: "2026-01-01", updatedAt: "2026-01-01" };
    (store.createWorkflowStep as ReturnType<typeof vi.fn>).mockResolvedValueOnce(created);

    const res = await REQUEST(buildApp(), "POST", "/api/workflow-steps", JSON.stringify({
      name: "Docs",
      description: "Check docs",
      modelProvider: "",
      modelId: "",
    }), { "Content-Type": "application/json" });

    expect(res.status).toBe(201);
    expect(store.createWorkflowStep).toHaveBeenCalledWith({
      name: "Docs",
      description: "Check docs",
      mode: "prompt",
      phase: undefined,
      prompt: undefined,
      scriptName: undefined,
      enabled: undefined,
      defaultOn: false,
      modelProvider: undefined,
      modelId: undefined,
    });
  });

  it("creates a script-mode workflow step with valid scriptName", async () => {
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      scripts: { test: "pnpm test", lint: "pnpm lint" },
    });
    const created = { id: "WS-001", name: "Run Tests", description: "Execute tests", mode: "script", scriptName: "test", prompt: "", enabled: true, createdAt: "2026-01-01", updatedAt: "2026-01-01" };
    (store.createWorkflowStep as ReturnType<typeof vi.fn>).mockResolvedValueOnce(created);

    const res = await REQUEST(buildApp(), "POST", "/api/workflow-steps", JSON.stringify({
      name: "Run Tests",
      description: "Execute tests",
      mode: "script",
      scriptName: "test",
    }), { "Content-Type": "application/json" });

    expect(res.status).toBe(201);
    expect(store.createWorkflowStep).toHaveBeenCalledWith({
      name: "Run Tests",
      description: "Execute tests",
      mode: "script",
      phase: undefined,
      prompt: undefined,
      scriptName: "test",
      enabled: undefined,
      defaultOn: false,
    });
  });

  it("returns 400 for script mode without scriptName", async () => {
    const res = await REQUEST(buildApp(), "POST", "/api/workflow-steps", JSON.stringify({
      name: "Run Tests",
      description: "Execute tests",
      mode: "script",
    }), { "Content-Type": "application/json" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("scriptName is required");
  });

  it("returns 400 for script mode with scriptName not in project scripts", async () => {
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      scripts: { lint: "pnpm lint" },
    });

    const res = await REQUEST(buildApp(), "POST", "/api/workflow-steps", JSON.stringify({
      name: "Run Tests",
      description: "Execute tests",
      mode: "script",
      scriptName: "nonexistent",
    }), { "Content-Type": "application/json" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("not found in project settings");
  });

  it("returns 400 for invalid mode value", async () => {
    const res = await REQUEST(buildApp(), "POST", "/api/workflow-steps", JSON.stringify({
      name: "Test",
      description: "Test",
      mode: "invalid",
    }), { "Content-Type": "application/json" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("mode must be");
  });

  it("creates a workflow step with 'post-merge' phase", async () => {
    const created = { id: "WS-001", name: "Post Merge", description: "After merge", mode: "prompt", phase: "post-merge", prompt: "", enabled: true, createdAt: "2026-01-01", updatedAt: "2026-01-01" };
    (store.createWorkflowStep as ReturnType<typeof vi.fn>).mockResolvedValueOnce(created);

    const res = await REQUEST(buildApp(), "POST", "/api/workflow-steps", JSON.stringify({
      name: "Post Merge",
      description: "After merge",
      phase: "post-merge",
    }), { "Content-Type": "application/json" });

    expect(res.status).toBe(201);
    expect(store.createWorkflowStep).toHaveBeenCalledWith({
      name: "Post Merge",
      description: "After merge",
      mode: "prompt",
      phase: "post-merge",
      prompt: undefined,
      scriptName: undefined,
      enabled: undefined,
      defaultOn: false,
    });
  });

  it("returns 400 for invalid phase value", async () => {
    const res = await REQUEST(buildApp(), "POST", "/api/workflow-steps", JSON.stringify({
      name: "Test",
      description: "Test",
      phase: "during-merge",
    }), { "Content-Type": "application/json" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("phase must be");
  });

  it("creates a workflow step with defaultOn true", async () => {
    const created = { id: "WS-010", name: "Auto Step", description: "Auto-enabled", mode: "prompt", prompt: "", enabled: true, defaultOn: true, createdAt: "2026-01-01", updatedAt: "2026-01-01" };
    (store.createWorkflowStep as ReturnType<typeof vi.fn>).mockResolvedValueOnce(created);

    const res = await REQUEST(buildApp(), "POST", "/api/workflow-steps", JSON.stringify({
      name: "Auto Step",
      description: "Auto-enabled",
      defaultOn: true,
    }), { "Content-Type": "application/json" });

    expect(res.status).toBe(201);
    expect(store.createWorkflowStep).toHaveBeenCalledWith({
      name: "Auto Step",
      description: "Auto-enabled",
      mode: "prompt",
      phase: undefined,
      prompt: undefined,
      scriptName: undefined,
      enabled: undefined,
      defaultOn: true,
    });
  });

  it("defaults defaultOn to false when not specified", async () => {
    const created = { id: "WS-011", name: "Manual Step", description: "Manual only", mode: "prompt", prompt: "", enabled: true, createdAt: "2026-01-01", updatedAt: "2026-01-01" };
    (store.createWorkflowStep as ReturnType<typeof vi.fn>).mockResolvedValueOnce(created);

    const res = await REQUEST(buildApp(), "POST", "/api/workflow-steps", JSON.stringify({
      name: "Manual Step",
      description: "Manual only",
    }), { "Content-Type": "application/json" });

    expect(res.status).toBe(201);
    expect(store.createWorkflowStep).toHaveBeenCalledWith(
      expect.objectContaining({ defaultOn: false })
    );
  });

  it("returns 400 when defaultOn is not a boolean", async () => {
    const res = await REQUEST(buildApp(), "POST", "/api/workflow-steps", JSON.stringify({
      name: "Bad Step",
      description: "Bad defaultOn",
      defaultOn: "yes",
    }), { "Content-Type": "application/json" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("defaultOn");
  });
});

describe("PATCH /workflow-steps/:id", () => {
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

  it("updates a workflow step", async () => {
    const updated = { id: "WS-001", name: "Updated", description: "Updated desc", prompt: "Updated prompt", enabled: false, createdAt: "2026-01-01", updatedAt: "2026-01-02" };
    (store.updateWorkflowStep as ReturnType<typeof vi.fn>).mockResolvedValueOnce(updated);

    const res = await REQUEST(buildApp(), "PATCH", "/api/workflow-steps/WS-001", JSON.stringify({
      name: "Updated",
      enabled: false,
    }), { "Content-Type": "application/json" });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe("Updated");
  });

  it("returns 404 for non-existent step", async () => {
    (store.updateWorkflowStep as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("Workflow step 'WS-999' not found"));

    const res = await REQUEST(buildApp(), "PATCH", "/api/workflow-steps/WS-999", JSON.stringify({
      name: "Nope",
    }), { "Content-Type": "application/json" });

    expect(res.status).toBe(404);
    expect(res.body.error).toContain("not found");
  });

  it("updates a workflow step with model override", async () => {
    const updated = { id: "WS-001", name: "Security", description: "Audit", prompt: "", enabled: true, modelProvider: "anthropic", modelId: "claude-sonnet-4-5", createdAt: "2026-01-01", updatedAt: "2026-01-02" };
    (store.updateWorkflowStep as ReturnType<typeof vi.fn>).mockResolvedValueOnce(updated);

    const res = await REQUEST(buildApp(), "PATCH", "/api/workflow-steps/WS-001", JSON.stringify({
      modelProvider: "anthropic",
      modelId: "claude-sonnet-4-5",
    }), { "Content-Type": "application/json" });

    expect(res.status).toBe(200);
    expect(store.updateWorkflowStep).toHaveBeenCalledWith("WS-001", expect.objectContaining({
      modelProvider: "anthropic",
      modelId: "claude-sonnet-4-5",
    }));
  });

  it("returns 400 when updating with only modelProvider", async () => {
    const res = await REQUEST(buildApp(), "PATCH", "/api/workflow-steps/WS-001", JSON.stringify({
      modelProvider: "anthropic",
    }), { "Content-Type": "application/json" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("must include both provider and modelId");
  });

  it("returns 400 when updating with only modelId", async () => {
    const res = await REQUEST(buildApp(), "PATCH", "/api/workflow-steps/WS-001", JSON.stringify({
      modelId: "claude-sonnet-4-5",
    }), { "Content-Type": "application/json" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("must include both provider and modelId");
  });

  it("returns 400 when updating scriptName to nonexistent on existing script-mode step", async () => {
    // Simulate an existing script-mode step
    (store.getWorkflowStep as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: "WS-001",
      name: "Run Tests",
      description: "Test runner",
      mode: "script",
      scriptName: "test",
      prompt: "",
      enabled: true,
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
    });
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      scripts: { test: "pnpm test", lint: "pnpm lint" },
    });

    const res = await REQUEST(buildApp(), "PATCH", "/api/workflow-steps/WS-001", JSON.stringify({
      scriptName: "nonexistent",
    }), { "Content-Type": "application/json" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("not found in project settings");
    // Should NOT have called updateWorkflowStep since validation failed
    expect(store.updateWorkflowStep).not.toHaveBeenCalled();
  });

  it("returns 400 when updating script-mode step without scriptName (resulting state)", async () => {
    // Simulate an existing script-mode step with scriptName cleared
    (store.getWorkflowStep as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: "WS-001",
      name: "Run Tests",
      description: "Test runner",
      mode: "script",
      scriptName: "",
      prompt: "",
      enabled: true,
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
    });

    const res = await REQUEST(buildApp(), "PATCH", "/api/workflow-steps/WS-001", JSON.stringify({
      name: "Updated Name",
    }), { "Content-Type": "application/json" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("scriptName is required when mode is 'script'");
  });

  it("updates a workflow step phase", async () => {
    const updated = { id: "WS-001", name: "Post Merge", description: "After merge", phase: "post-merge", createdAt: "2026-01-01", updatedAt: "2026-01-02" };
    (store.updateWorkflowStep as ReturnType<typeof vi.fn>).mockResolvedValueOnce(updated);
    (store.getWorkflowStep as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: "WS-001", name: "Pre Merge", description: "Before merge", mode: "prompt", prompt: "", enabled: true, createdAt: "2026-01-01", updatedAt: "2026-01-01",
    });

    const res = await REQUEST(buildApp(), "PATCH", "/api/workflow-steps/WS-001", JSON.stringify({
      phase: "post-merge",
    }), { "Content-Type": "application/json" });

    expect(res.status).toBe(200);
    expect(store.updateWorkflowStep).toHaveBeenCalledWith("WS-001", expect.objectContaining({
      phase: "post-merge",
    }));
  });

  it("returns 400 for invalid phase value on update", async () => {
    (store.getWorkflowStep as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: "WS-001", name: "Test", description: "Test", mode: "prompt", prompt: "", enabled: true, createdAt: "2026-01-01", updatedAt: "2026-01-01",
    });

    const res = await REQUEST(buildApp(), "PATCH", "/api/workflow-steps/WS-001", JSON.stringify({
      phase: "during-merge",
    }), { "Content-Type": "application/json" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("phase must be");
  });

  it("updates defaultOn to true", async () => {
    const updated = { id: "WS-001", name: "Docs", description: "Check docs", mode: "prompt", prompt: "", enabled: true, defaultOn: true, createdAt: "2026-01-01", updatedAt: "2026-01-01" };
    (store.updateWorkflowStep as ReturnType<typeof vi.fn>).mockResolvedValueOnce(updated);

    const res = await REQUEST(buildApp(), "PATCH", "/api/workflow-steps/WS-001", JSON.stringify({
      defaultOn: true,
    }), { "Content-Type": "application/json" });

    expect(res.status).toBe(200);
    expect(store.updateWorkflowStep).toHaveBeenCalledWith("WS-001", expect.objectContaining({ defaultOn: true }));
  });

  it("updates defaultOn to false", async () => {
    const updated = { id: "WS-001", name: "Docs", description: "Check docs", mode: "prompt", prompt: "", enabled: true, defaultOn: false, createdAt: "2026-01-01", updatedAt: "2026-01-01" };
    (store.updateWorkflowStep as ReturnType<typeof vi.fn>).mockResolvedValueOnce(updated);

    const res = await REQUEST(buildApp(), "PATCH", "/api/workflow-steps/WS-001", JSON.stringify({
      defaultOn: false,
    }), { "Content-Type": "application/json" });

    expect(res.status).toBe(200);
    expect(store.updateWorkflowStep).toHaveBeenCalledWith("WS-001", expect.objectContaining({ defaultOn: false }));
  });

  it("returns 400 when defaultOn is not a boolean in PATCH", async () => {
    const res = await REQUEST(buildApp(), "PATCH", "/api/workflow-steps/WS-001", JSON.stringify({
      defaultOn: "yes",
    }), { "Content-Type": "application/json" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("defaultOn");
  });
});

describe("DELETE /workflow-steps/:id", () => {
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

  it("deletes a workflow step", async () => {
    (store.deleteWorkflowStep as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);

    const res = await REQUEST(buildApp(), "DELETE", "/api/workflow-steps/WS-001", undefined, {});

    expect(res.status).toBe(204);
  });

  it("returns 404 for non-existent step", async () => {
    (store.deleteWorkflowStep as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("Workflow step 'WS-999' not found"));

    const res = await REQUEST(buildApp(), "DELETE", "/api/workflow-steps/WS-999", undefined, {});

    expect(res.status).toBe(404);
    expect(res.body.error).toContain("not found");
  });
});

describe("POST /workflow-steps/:id/refine", () => {
  let store: TaskStore;

  beforeEach(() => {
    store = createMockStore();
  });

  afterEach(() => {
    __setCreateFnAgentForRefine(undefined);
  });

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store));
    return app;
  }

  it("returns 404 when workflow step not found", async () => {
    (store.getWorkflowStep as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);

    const res = await REQUEST(buildApp(), "POST", "/api/workflow-steps/WS-999/refine", JSON.stringify({}), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(404);
    expect(res.body.error).toContain("not found");
  });

  it("returns 400 when workflow step has no description", async () => {
    (store.getWorkflowStep as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: "WS-001", name: "Empty", description: "  ", mode: "prompt", prompt: "", enabled: true, createdAt: "2026-01-01", updatedAt: "2026-01-01",
    });

    const res = await REQUEST(buildApp(), "POST", "/api/workflow-steps/WS-001/refine", JSON.stringify({}), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("no description");
  });

  it("returns 400 when workflow step is in script mode", async () => {
    (store.getWorkflowStep as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: "WS-001", name: "Run Tests", description: "Execute test suite", mode: "script", scriptName: "test", prompt: "", enabled: true, createdAt: "2026-01-01", updatedAt: "2026-01-01",
    });

    const res = await REQUEST(buildApp(), "POST", "/api/workflow-steps/WS-001/refine", JSON.stringify({}), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Cannot refine prompt for script-mode");
  });

  it("returns AI-refined prompt when engine is available", async () => {
    const ws = { id: "WS-001", name: "Docs", description: "Check docs", mode: "prompt", prompt: "", enabled: true, createdAt: "2026-01-01", updatedAt: "2026-01-01" };
    (store.getWorkflowStep as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ws);
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      planningProvider: "anthropic",
      planningModelId: "claude-sonnet-4-5",
    });

    const updatedWs = { ...ws, prompt: "Refined prompt from AI" };
    (store.updateWorkflowStep as ReturnType<typeof vi.fn>).mockResolvedValueOnce(updatedWs);

    let onText: ((delta: string) => void) | undefined;
    const session = {
      on: vi.fn((event: string, cb: (delta: string) => void) => {
        if (event === "text") {
          onText = cb;
        }
      }),
      prompt: vi.fn(async () => {
        onText?.("Refined ");
        onText?.("prompt from AI");
      }),
      dispose: vi.fn(),
    };

    const createFnAgentMock = vi.fn(async () => ({ session }));
    __setCreateFnAgentForRefine(createFnAgentMock);

    const res = await REQUEST(buildApp(), "POST", "/api/workflow-steps/WS-001/refine", JSON.stringify({}), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(res.body.prompt).toBe("Refined prompt from AI");
    expect(res.body.workflowStep.prompt).toBe("Refined prompt from AI");
    expect(createFnAgentMock).toHaveBeenCalledTimes(1);
    expect(session.prompt).toHaveBeenCalledWith(expect.stringContaining("Name: Docs"));
    expect(session.dispose).toHaveBeenCalledTimes(1);
    expect(store.updateWorkflowStep).toHaveBeenCalledWith("WS-001", { prompt: "Refined prompt from AI" });
  });

  it("falls back to description when AI is unavailable", async () => {
    const ws = { id: "WS-001", name: "Docs", description: "Check docs", mode: "prompt", prompt: "", enabled: true, createdAt: "2026-01-01", updatedAt: "2026-01-01" };
    (store.getWorkflowStep as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ws);
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({});
    const updatedWs = { ...ws, prompt: "Check docs" };
    (store.updateWorkflowStep as ReturnType<typeof vi.fn>).mockResolvedValueOnce(updatedWs);

    __setCreateFnAgentForRefine(async () => {
      throw new Error("AI unavailable");
    });

    const res = await REQUEST(buildApp(), "POST", "/api/workflow-steps/WS-001/refine", JSON.stringify({}), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(res.body.prompt).toBe("Check docs");
    expect(res.body.workflowStep.prompt).toBe("Check docs");
    expect(store.updateWorkflowStep).toHaveBeenCalledWith("WS-001", { prompt: "Check docs" });
  });

  it("uses custom prompt from promptOverrides when provided", async () => {
    const ws = { id: "WS-001", name: "Docs", description: "Check docs", mode: "prompt", prompt: "", enabled: true, createdAt: "2026-01-01", updatedAt: "2026-01-01" };
    (store.getWorkflowStep as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ws);
    const customPrompt = "CUSTOM WORKFLOW STEP REFINE PROMPT";
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      promptOverrides: {
        "workflow-step-refine": customPrompt,
      },
    });

    const updatedWs = { ...ws, prompt: "Refined prompt from AI" };
    (store.updateWorkflowStep as ReturnType<typeof vi.fn>).mockResolvedValueOnce(updatedWs);

    let capturedSystemPrompt: string | undefined;
    const session = {
      on: vi.fn((event: string, cb: (delta: string) => void) => {
        if (event === "text") {
          cb("Refined ");
          cb("prompt from AI");
        }
      }),
      prompt: vi.fn(async () => {}),
      dispose: vi.fn(),
    };

    const createFnAgentMock = vi.fn(async (options: { cwd: string; systemPrompt: string; tools: string }) => {
      capturedSystemPrompt = options.systemPrompt;
      return { session };
    });
    __setCreateFnAgentForRefine(createFnAgentMock);

    const res = await REQUEST(buildApp(), "POST", "/api/workflow-steps/WS-001/refine", JSON.stringify({}), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(createFnAgentMock).toHaveBeenCalledTimes(1);
    // Verify the custom prompt was passed
    expect(capturedSystemPrompt).toBe(customPrompt);
  });

  it("uses default prompt when promptOverrides does not contain workflow-step-refine", async () => {
    const ws = { id: "WS-001", name: "Docs", description: "Check docs", mode: "prompt", prompt: "", enabled: true, createdAt: "2026-01-01", updatedAt: "2026-01-01" };
    (store.getWorkflowStep as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ws);
    // Settings with other overrides but not workflow-step-refine
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      promptOverrides: {
        "executor-welcome": "Some other prompt",
      },
    });

    const updatedWs = { ...ws, prompt: "Refined prompt from AI" };
    (store.updateWorkflowStep as ReturnType<typeof vi.fn>).mockResolvedValueOnce(updatedWs);

    let capturedSystemPrompt: string | undefined;
    const session = {
      on: vi.fn((event: string, cb: (delta: string) => void) => {
        if (event === "text") {
          cb("Refined ");
          cb("prompt from AI");
        }
      }),
      prompt: vi.fn(async () => {}),
      dispose: vi.fn(),
    };

    const createFnAgentMock = vi.fn(async (options: { cwd: string; systemPrompt: string; tools: string }) => {
      capturedSystemPrompt = options.systemPrompt;
      return { session };
    });
    __setCreateFnAgentForRefine(createFnAgentMock);

    const res = await REQUEST(buildApp(), "POST", "/api/workflow-steps/WS-001/refine", JSON.stringify({}), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(createFnAgentMock).toHaveBeenCalledTimes(1);
    // Should use the default prompt (contains "You are an expert at creating")
    expect(capturedSystemPrompt).toContain("You are an expert at creating");
    expect(capturedSystemPrompt).toContain("workflow steps");
  });

  // ── Lane Precedence Regression Tests ────────────────────────────────────────
  // Tests for FN-1730: ensure model resolution follows the documented hierarchy:
  // 1. Project settings planningProvider + planningModelId (project lane)
  // 2. Global settings planningGlobalProvider + planningGlobalModelId (global lane)
  // 3. Default settings defaultProvider + defaultModelId (default fallback)

  it("uses project planning lane when configured", async () => {
    const ws = { id: "WS-001", name: "Docs", description: "Check docs", mode: "prompt", prompt: "", enabled: true, createdAt: "2026-01-01", updatedAt: "2026-01-01" };
    (store.getWorkflowStep as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ws);
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      planningProvider: "anthropic",
      planningModelId: "claude-sonnet-4-5",
    });

    const updatedWs = { ...ws, prompt: "Refined prompt from AI" };
    (store.updateWorkflowStep as ReturnType<typeof vi.fn>).mockResolvedValueOnce(updatedWs);

    let capturedModel: { defaultProvider?: string; defaultModelId?: string } = {};
    const session = {
      on: vi.fn(),
      prompt: vi.fn(async () => {}),
      dispose: vi.fn(),
    };

    const createFnAgentMock = vi.fn(async (options: { defaultProvider?: string; defaultModelId?: string }) => {
      capturedModel = options;
      return { session };
    });
    __setCreateFnAgentForRefine(createFnAgentMock);

    const res = await REQUEST(buildApp(), "POST", "/api/workflow-steps/WS-001/refine", JSON.stringify({}), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(createFnAgentMock).toHaveBeenCalledTimes(1);
    expect(capturedModel.defaultProvider).toBe("anthropic");
    expect(capturedModel.defaultModelId).toBe("claude-sonnet-4-5");
  });

  it("falls back to global planning lane when project lane unset", async () => {
    const ws = { id: "WS-001", name: "Docs", description: "Check docs", mode: "prompt", prompt: "", enabled: true, createdAt: "2026-01-01", updatedAt: "2026-01-01" };
    (store.getWorkflowStep as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ws);
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      planningGlobalProvider: "openai",
      planningGlobalModelId: "gpt-4o",
    });

    const updatedWs = { ...ws, prompt: "Refined prompt from AI" };
    (store.updateWorkflowStep as ReturnType<typeof vi.fn>).mockResolvedValueOnce(updatedWs);

    let capturedModel: { defaultProvider?: string; defaultModelId?: string } = {};
    const session = {
      on: vi.fn(),
      prompt: vi.fn(async () => {}),
      dispose: vi.fn(),
    };

    const createFnAgentMock = vi.fn(async (options: { defaultProvider?: string; defaultModelId?: string }) => {
      capturedModel = options;
      return { session };
    });
    __setCreateFnAgentForRefine(createFnAgentMock);

    const res = await REQUEST(buildApp(), "POST", "/api/workflow-steps/WS-001/refine", JSON.stringify({}), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(createFnAgentMock).toHaveBeenCalledTimes(1);
    expect(capturedModel.defaultProvider).toBe("openai");
    expect(capturedModel.defaultModelId).toBe("gpt-4o");
  });

  it("falls back to default lane when all planning lanes unset", async () => {
    const ws = { id: "WS-001", name: "Docs", description: "Check docs", mode: "prompt", prompt: "", enabled: true, createdAt: "2026-01-01", updatedAt: "2026-01-01" };
    (store.getWorkflowStep as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ws);
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      defaultProvider: "mistral",
      defaultModelId: "mistral-large",
    });

    const updatedWs = { ...ws, prompt: "Refined prompt from AI" };
    (store.updateWorkflowStep as ReturnType<typeof vi.fn>).mockResolvedValueOnce(updatedWs);

    let capturedModel: { defaultProvider?: string; defaultModelId?: string } = {};
    const session = {
      on: vi.fn(),
      prompt: vi.fn(async () => {}),
      dispose: vi.fn(),
    };

    const createFnAgentMock = vi.fn(async (options: { defaultProvider?: string; defaultModelId?: string }) => {
      capturedModel = options;
      return { session };
    });
    __setCreateFnAgentForRefine(createFnAgentMock);

    const res = await REQUEST(buildApp(), "POST", "/api/workflow-steps/WS-001/refine", JSON.stringify({}), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(createFnAgentMock).toHaveBeenCalledTimes(1);
    expect(capturedModel.defaultProvider).toBe("mistral");
    expect(capturedModel.defaultModelId).toBe("mistral-large");
  });

  it("falls back to the project default override before the global default lane", async () => {
    const ws = { id: "WS-001", name: "Docs", description: "Check docs", mode: "prompt", prompt: "", enabled: true, createdAt: "2026-01-01", updatedAt: "2026-01-01" };
    (store.getWorkflowStep as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ws);
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      defaultProviderOverride: "openai",
      defaultModelIdOverride: "gpt-4o",
      defaultProvider: "mistral",
      defaultModelId: "mistral-large",
    });

    const updatedWs = { ...ws, prompt: "Refined prompt from AI" };
    (store.updateWorkflowStep as ReturnType<typeof vi.fn>).mockResolvedValueOnce(updatedWs);

    let capturedModel: { defaultProvider?: string; defaultModelId?: string } = {};
    const session = {
      on: vi.fn(),
      prompt: vi.fn(async () => {}),
      dispose: vi.fn(),
    };

    const createFnAgentMock = vi.fn(async (options: { defaultProvider?: string; defaultModelId?: string }) => {
      capturedModel = options;
      return { session };
    });
    __setCreateFnAgentForRefine(createFnAgentMock);

    const res = await REQUEST(buildApp(), "POST", "/api/workflow-steps/WS-001/refine", JSON.stringify({}), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(capturedModel.defaultProvider).toBe("openai");
    expect(capturedModel.defaultModelId).toBe("gpt-4o");
  });

  it("ignores partial project lane (provider only, no modelId)", async () => {
    const ws = { id: "WS-001", name: "Docs", description: "Check docs", mode: "prompt", prompt: "", enabled: true, createdAt: "2026-01-01", updatedAt: "2026-01-01" };
    (store.getWorkflowStep as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ws);
    // Partial project lane: provider only, no modelId
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      planningProvider: "anthropic",
      // missing planningModelId
      planningGlobalProvider: "openai",
      planningGlobalModelId: "gpt-4o",
    });

    const updatedWs = { ...ws, prompt: "Refined prompt from AI" };
    (store.updateWorkflowStep as ReturnType<typeof vi.fn>).mockResolvedValueOnce(updatedWs);

    let capturedModel: { defaultProvider?: string; defaultModelId?: string } = {};
    const session = {
      on: vi.fn(),
      prompt: vi.fn(async () => {}),
      dispose: vi.fn(),
    };

    const createFnAgentMock = vi.fn(async (options: { defaultProvider?: string; defaultModelId?: string }) => {
      capturedModel = options;
      return { session };
    });
    __setCreateFnAgentForRefine(createFnAgentMock);

    const res = await REQUEST(buildApp(), "POST", "/api/workflow-steps/WS-001/refine", JSON.stringify({}), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    // Partial project lane should be ignored, falls through to global lane
    expect(capturedModel.defaultProvider).toBe("openai");
    expect(capturedModel.defaultModelId).toBe("gpt-4o");
  });
});

// ── Workflow Step Refine with Scoped Settings (projectId) ──────────────────

describe("POST /workflow-steps/:id/refine with projectId scoping", () => {
  const projectId = "proj-refine-scoped";

  let defaultStore: TaskStore;
  let scopedStore: TaskStore;

  beforeEach(() => {
    defaultStore = createMockStore();
    scopedStore = createMockStore();

    vi.spyOn(projectStoreResolver, "getOrCreateProjectStore").mockResolvedValue(scopedStore);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    __setCreateFnAgentForRefine(undefined);
  });

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(defaultStore));
    return app;
  }

  it("uses scoped settings from project store when projectId is provided", async () => {
    const ws = { id: "WS-001", name: "Docs", description: "Check docs", mode: "prompt", prompt: "", enabled: true, createdAt: "2026-01-01", updatedAt: "2026-01-01" };
    (scopedStore.getWorkflowStep as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ws);

    const customPrompt = "CUSTOM SCOPED WORKFLOW REFINE PROMPT";
    (scopedStore.getSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      promptOverrides: {
        "workflow-step-refine": customPrompt,
      },
    });

    const updatedWs = { ...ws, prompt: "Refined prompt from AI" };
    (scopedStore.updateWorkflowStep as ReturnType<typeof vi.fn>).mockResolvedValueOnce(updatedWs);

    let capturedSystemPrompt: string | undefined;
    const session = {
      on: vi.fn((event: string, cb: (delta: string) => void) => {
        if (event === "text") {
          cb("Refined ");
          cb("prompt from AI");
        }
      }),
      prompt: vi.fn(async () => {}),
      dispose: vi.fn(),
    };

    const createFnAgentMock = vi.fn(async (options: { cwd: string; systemPrompt: string; tools: string }) => {
      capturedSystemPrompt = options.systemPrompt;
      return { session };
    });
    __setCreateFnAgentForRefine(createFnAgentMock);

    const res = await REQUEST(
      buildApp(),
      "POST",
      `/api/workflow-steps/WS-001/refine?projectId=${projectId}`,
      JSON.stringify({}),
      { "Content-Type": "application/json" }
    );

    expect(res.status).toBe(200);
    expect(projectStoreResolver.getOrCreateProjectStore).toHaveBeenCalledWith(projectId);
    expect(scopedStore.getWorkflowStep).toHaveBeenCalledWith("WS-001");
    expect(scopedStore.getSettings).toHaveBeenCalled();
    expect(scopedStore.updateWorkflowStep).toHaveBeenCalledWith("WS-001", { prompt: "Refined prompt from AI" });
    // Verify the custom prompt from scoped settings was used
    expect(capturedSystemPrompt).toBe(customPrompt);
  });

  it("uses default prompt from scoped settings when no workflow-step-refine override", async () => {
    const ws = { id: "WS-001", name: "Docs", description: "Check docs", mode: "prompt", prompt: "", enabled: true, createdAt: "2026-01-01", updatedAt: "2026-01-01" };
    (scopedStore.getWorkflowStep as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ws);

    // Scoped settings with other overrides but not workflow-step-refine
    (scopedStore.getSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      promptOverrides: {
        "executor-welcome": "Some other prompt",
      },
    });

    const updatedWs = { ...ws, prompt: "Refined prompt from AI" };
    (scopedStore.updateWorkflowStep as ReturnType<typeof vi.fn>).mockResolvedValueOnce(updatedWs);

    let capturedSystemPrompt: string | undefined;
    const session = {
      on: vi.fn((event: string, cb: (delta: string) => void) => {
        if (event === "text") {
          cb("Refined ");
          cb("prompt from AI");
        }
      }),
      prompt: vi.fn(async () => {}),
      dispose: vi.fn(),
    };

    const createFnAgentMock = vi.fn(async (options: { cwd: string; systemPrompt: string; tools: string }) => {
      capturedSystemPrompt = options.systemPrompt;
      return { session };
    });
    __setCreateFnAgentForRefine(createFnAgentMock);

    const res = await REQUEST(
      buildApp(),
      "POST",
      `/api/workflow-steps/WS-001/refine?projectId=${projectId}`,
      JSON.stringify({}),
      { "Content-Type": "application/json" }
    );

    expect(res.status).toBe(200);
    expect(projectStoreResolver.getOrCreateProjectStore).toHaveBeenCalledWith(projectId);
    // Should use the default prompt from scoped settings
    expect(capturedSystemPrompt).toContain("You are an expert at creating");
    expect(capturedSystemPrompt).toContain("workflow steps");
  });
});

// ── Agent Generation Routes ────────────────────────────────────────────────

describe("POST /api/agents/generate/* diagnostics", () => {
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

  function captureDiagnostics(): LogEntry[] {
    const entries: LogEntry[] = [];
    setDiagnosticsSink((level, scope, message, context) => {
      entries.push({
        level,
        scope,
        message,
        context,
        timestamp: new Date(),
      });
    });
    return entries;
  }

  it("emits structured diagnostics when /agents/generate/start fails unexpectedly", async () => {
    const diagnostics = captureDiagnostics();
    vi.spyOn(agentGenerationModule, "startAgentGeneration").mockRejectedValueOnce(new Error("start failed"));

    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/agents/generate/start",
      JSON.stringify({ role: "Senior frontend reviewer" }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(500);
    expect(res.body.error).toContain("start failed");
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        level: "error",
        scope: "agent-generation",
        message: "Error starting session",
        context: expect.objectContaining({
          operation: "generate-start",
          error: expect.objectContaining({ message: "start failed" }),
        }),
      }),
    );
  });

  it("emits structured diagnostics when /agents/generate/spec fails unexpectedly", async () => {
    const diagnostics = captureDiagnostics();
    vi.spyOn(agentGenerationModule, "generateAgentSpec").mockRejectedValueOnce(new Error("spec failed"));

    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/agents/generate/spec",
      JSON.stringify({ sessionId: "session-123" }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(500);
    expect(res.body.error).toContain("spec failed");
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        level: "error",
        scope: "agent-generation",
        message: "Error generating spec",
        context: expect.objectContaining({
          operation: "generate-spec",
          error: expect.objectContaining({ message: "spec failed" }),
        }),
      }),
    );
  });
});

describe("POST /agents/generate/spec with projectId scoping", () => {
  const projectId = "proj-agent-gen-scoped";

  let defaultStore: TaskStore;
  let scopedStore: TaskStore;

  beforeEach(() => {
    defaultStore = createMockStore();
    scopedStore = createMockStore({
      getAgentGenerationSession: vi.fn().mockImplementation((sessionId: string) => {
        if (sessionId === "test-session-id") {
          return {
            id: "test-session-id",
            roleDescription: "Test role",
            createdAt: new Date(),
            updatedAt: new Date(),
          };
        }
        return undefined;
      }),
    });

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

  it("uses scoped settings for prompt resolution when projectId is provided", async () => {
    const customPrompt = "CUSTOM SCOPED AGENT GENERATION PROMPT";
    (scopedStore.getSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      promptOverrides: {
        "agent-generation-system": customPrompt,
      },
    });

    let capturedSystemPrompt: string | undefined;
    const mockSession = {
      state: { messages: [] },
      prompt: vi.fn(async () => {
        capturedSystemPrompt = "mock-prompt-captured";
      }),
      dispose: vi.fn(),
    };
    const mockAgent = {
      session: mockSession,
    };

    // Mock createFnAgent at the module level for agent-generation
    vi.doMock("@fusion/engine", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@fusion/engine")>();
      return {
        ...actual,
        createFnAgent: vi.fn(async () => mockAgent),
      };
    });

    const res = await REQUEST(
      buildApp(),
      "POST",
      `/api/agents/generate/spec?projectId=${projectId}`,
      JSON.stringify({ sessionId: "test-session-id" }),
      { "Content-Type": "application/json" }
    );

    // Should use scoped store's settings for prompt resolution
    expect(projectStoreResolver.getOrCreateProjectStore).toHaveBeenCalledWith(projectId);
    expect(scopedStore.getSettings).toHaveBeenCalled();

    vi.restoreAllMocks();
  });

  it("falls back to default prompt when scoped settings has no agent-generation-system override", async () => {
    // Scoped settings with other overrides but not agent-generation-system
    (scopedStore.getSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      promptOverrides: {
        "executor-welcome": "Some other prompt",
      },
    });

    const mockSession = {
      state: { messages: [] },
      prompt: vi.fn(async () => {}),
      dispose: vi.fn(),
    };
    const mockAgent = {
      session: mockSession,
    };

    // Mock createFnAgent at the module level for agent-generation
    vi.doMock("@fusion/engine", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@fusion/engine")>();
      return {
        ...actual,
        createFnAgent: vi.fn(async () => mockAgent),
      };
    });

    const res = await REQUEST(
      buildApp(),
      "POST",
      `/api/agents/generate/spec?projectId=${projectId}`,
      JSON.stringify({ sessionId: "test-session-id" }),
      { "Content-Type": "application/json" }
    );

    // Should use scoped store's settings (which will fall back to default)
    expect(projectStoreResolver.getOrCreateProjectStore).toHaveBeenCalledWith(projectId);
    expect(scopedStore.getSettings).toHaveBeenCalled();

    vi.restoreAllMocks();
  });
});

// ── Workflow Step Template Tests ──────────────────────────────────────────

describe("GET /workflow-step-templates", () => {
  let store: TaskStore;
  let pluginRunner: { getPluginWorkflowStepTemplates?: () => Array<{ pluginId: string; template: { id: string; name: string; description: string; prompt: string; toolMode: "readonly" | "coding"; category: string; icon: string } }> };

  beforeEach(() => {
    store = createMockStore();
    pluginRunner = {};
  });

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store, { pluginRunner: pluginRunner as any }));
    return app;
  }

  it("returns all built-in templates", async () => {
    const res = await GET(buildApp(), "/api/workflow-step-templates");

    expect(res.status).toBe(200);
    expect(res.body.templates).toBeDefined();
    expect(Array.isArray(res.body.templates)).toBe(true);
    expect(res.body.templates.length).toBeGreaterThanOrEqual(5);

    // Check that templates have required fields
    for (const template of res.body.templates) {
      expect(template.id).toBeDefined();
      expect(template.name).toBeDefined();
      expect(template.description).toBeDefined();
      expect(template.category).toBeDefined();
      expect(template.prompt).toBeDefined();
    }
  });

  it("includes expected template IDs", async () => {
    const res = await GET(buildApp(), "/api/workflow-step-templates");

    expect(res.status).toBe(200);
    const ids = res.body.templates.map((t: { id: string }) => t.id);
    expect(ids).toContain("documentation-review");
    expect(ids).toContain("qa-check");
    expect(ids).toContain("security-audit");
    expect(ids).toContain("performance-review");
    expect(ids).toContain("accessibility-check");
    expect(ids).toContain("browser-verification");
    expect(ids).toContain("frontend-ux-design");
  });

  it("merges plugin templates into workflow-step-templates response", async () => {
    pluginRunner.getPluginWorkflowStepTemplates = () => [
      {
        pluginId: "my-plugin",
        template: {
          id: "plugin:my-plugin:my-step",
          name: "My Plugin Step",
          description: "Plugin contributed step",
          prompt: "Run plugin checks",
          toolMode: "readonly",
          category: "Plugin",
          icon: "puzzle",
        },
      },
    ];

    const res = await GET(buildApp(), "/api/workflow-step-templates");

    expect(res.status).toBe(200);
    expect(res.body.templates.some((t: { id: string }) => t.id === "plugin:my-plugin:my-step")).toBe(true);
  });

  it("returns plugin-only templates endpoint", async () => {
    pluginRunner.getPluginWorkflowStepTemplates = () => [
      {
        pluginId: "my-plugin",
        template: {
          id: "plugin:my-plugin:my-step",
          name: "My Plugin Step",
          description: "Plugin contributed step",
          prompt: "Run plugin checks",
          toolMode: "readonly",
          category: "Plugin",
          icon: "puzzle",
        },
      },
    ];

    const res = await GET(buildApp(), "/api/plugin-workflow-step-templates");

    expect(res.status).toBe(200);
    expect(res.body.templates).toHaveLength(1);
    expect(res.body.templates[0].pluginId).toBe("my-plugin");
    expect(res.body.templates[0].template.id).toBe("plugin:my-plugin:my-step");
  });
});

describe("POST /workflow-step-templates/:id/create", () => {
  let store: TaskStore;
  let pluginRunner: { getPluginWorkflowStepTemplates?: () => Array<{ pluginId: string; template: { id: string; name: string; description: string; prompt: string; toolMode: "readonly" | "coding"; category: string; icon: string } }> };

  beforeEach(() => {
    store = createMockStore();
    pluginRunner = {};
  });

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store, { pluginRunner: pluginRunner as any }));
    return app;
  }

  it("creates workflow step from template", async () => {
    const created = {
      id: "WS-001",
      name: "Documentation Review",
      description: "Verify all public APIs, functions, and complex logic have appropriate documentation",
      prompt: expect.stringContaining("documentation reviewer"),
      enabled: true,
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
    };
    (store.listWorkflowSteps as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
    (store.createWorkflowStep as ReturnType<typeof vi.fn>).mockResolvedValueOnce(created);

    const res = await REQUEST(buildApp(), "POST", "/api/workflow-step-templates/documentation-review/create", JSON.stringify({}), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe("WS-001");
    expect(res.body.name).toBe("Documentation Review");
    expect(store.createWorkflowStep).toHaveBeenCalledWith({
      templateId: "documentation-review",
      name: "Documentation Review",
      description: "Verify all public APIs, functions, and complex logic have appropriate documentation",
      prompt: expect.stringContaining("documentation reviewer"),
      toolMode: "readonly",
      enabled: true,
    });
  });

  it("creates workflow step from qa-check template", async () => {
    const created = {
      id: "WS-002",
      name: "QA Check",
      description: "Run lint, tests, and typecheck; verify they pass and check for obvious bugs",
      prompt: expect.stringContaining("QA tester"),
      enabled: true,
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
    };
    (store.listWorkflowSteps as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
    (store.createWorkflowStep as ReturnType<typeof vi.fn>).mockResolvedValueOnce(created);

    const res = await REQUEST(buildApp(), "POST", "/api/workflow-step-templates/qa-check/create", JSON.stringify({}), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe("QA Check");
    expect(store.createWorkflowStep).toHaveBeenCalledWith({
      templateId: "qa-check",
      name: "QA Check",
      description: "Run lint, tests, and typecheck; verify they pass and check for obvious bugs",
      prompt: expect.stringContaining("QA tester"),
      toolMode: "coding",
      enabled: true,
    });
  });

  it("creates workflow step from frontend-ux-design template", async () => {
    const created = {
      id: "WS-003",
      name: "Frontend UX Design",
      description: "Verify visual polish and consistency with existing UI patterns and design tokens",
      prompt: expect.stringContaining("UX design reviewer"),
      toolMode: "readonly",
      enabled: true,
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
    };
    (store.listWorkflowSteps as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
    (store.createWorkflowStep as ReturnType<typeof vi.fn>).mockResolvedValueOnce(created);

    const res = await REQUEST(buildApp(), "POST", "/api/workflow-step-templates/frontend-ux-design/create", JSON.stringify({}), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe("Frontend UX Design");
    expect(res.body.toolMode).toBe("readonly");
    expect(store.createWorkflowStep).toHaveBeenCalledWith({
      templateId: "frontend-ux-design",
      name: "Frontend UX Design",
      description: "Verify visual polish and consistency with existing UI patterns and design tokens",
      prompt: expect.stringContaining("UX design reviewer"),
      toolMode: "readonly",
      enabled: true,
    });
  });

  it("creates workflow step from plugin template", async () => {
    pluginRunner.getPluginWorkflowStepTemplates = () => [
      {
        pluginId: "my-plugin",
        template: {
          id: "plugin:my-plugin:my-step",
          name: "My Plugin Step",
          description: "Plugin contributed step",
          prompt: "Run plugin checks",
          toolMode: "coding",
          category: "Plugin",
          icon: "puzzle",
        },
      },
    ];
    (store.listWorkflowSteps as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
    (store.createWorkflowStep as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: "WS-999",
      templateId: "plugin:my-plugin:my-step",
      name: "My Plugin Step",
      description: "Plugin contributed step",
      prompt: "Run plugin checks",
      toolMode: "coding",
      enabled: true,
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
    });

    const res = await REQUEST(buildApp(), "POST", "/api/workflow-step-templates/plugin:my-plugin:my-step/create", JSON.stringify({}), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(201);
    expect(store.createWorkflowStep).toHaveBeenCalledWith(expect.objectContaining({
      templateId: "plugin:my-plugin:my-step",
      name: "My Plugin Step",
    }));
  });

  it("returns 404 for non-existent template", async () => {
    const res = await REQUEST(buildApp(), "POST", "/api/workflow-step-templates/nonexistent/create", JSON.stringify({}), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(404);
    expect(res.body.error).toContain("not found");
  });

  it("returns 409 when workflow step with same name already exists", async () => {
    const existingSteps = [
      { id: "WS-001", name: "Documentation Review", description: "Check docs", prompt: "", enabled: true, createdAt: "2026-01-01", updatedAt: "2026-01-01" },
    ];
    (store.listWorkflowSteps as ReturnType<typeof vi.fn>).mockResolvedValueOnce(existingSteps);

    const res = await REQUEST(buildApp(), "POST", "/api/workflow-step-templates/documentation-review/create", JSON.stringify({}), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("already exists");
  });
});

describe("Agent create/update routes", () => {
  let tempDir: string;
  let fusionDir: string;
  let agentId: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "kb-routes-agents-fields-"));
    fusionDir = join(tempDir, ".fusion");
    mkdirSync(fusionDir, { recursive: true });

    const { AgentStore } = await import("@fusion/core");
    const agentStore = new AgentStore({ rootDir: fusionDir });
    await agentStore.init();
    const agent = await agentStore.createAgent({
      name: "Initial Agent",
      role: "executor",
    });
    agentId = agent.id;
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function buildAgentApp() {
    const store = createMockStore({
      getFusionDir: vi.fn().mockReturnValue(fusionDir),
    } as any);
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store));
    return app;
  }

  it("POST /api/agents accepts all AgentCreateInput fields", async () => {
    const res = await REQUEST(
      buildAgentApp(),
      "POST",
      "/api/agents",
      JSON.stringify({
        name: "Full Agent",
        role: "reviewer",
        metadata: { team: "qa" },
        title: "QA Reviewer",
        icon: "🧪",
        reportsTo: agentId,
        runtimeConfig: { heartbeatIntervalMs: 60000 },
        permissions: { read: true },
        instructionsPath: "docs/reviewer.md",
        instructionsText: "Check test quality.",
        soul: "Analytical and thorough.",
      }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      name: "Full Agent",
      role: "reviewer",
      metadata: { team: "qa" },
      title: "QA Reviewer",
      icon: "🧪",
      reportsTo: agentId,
      runtimeConfig: { heartbeatIntervalMs: 60000 },
      permissions: { read: true },
      instructionsPath: "docs/reviewer.md",
      instructionsText: "Check test quality.",
      soul: "Analytical and thorough.",
    });
  });

  it("PATCH /api/agents/:id accepts all AgentUpdateInput fields", async () => {
    const res = await REQUEST(
      buildAgentApp(),
      "PATCH",
      `/api/agents/${agentId}`,
      JSON.stringify({
        name: "Updated Agent",
        role: "engineer",
        metadata: { area: "infra" },
        title: "Infra Engineer",
        icon: "⚙️",
        reportsTo: "agent-parent",
        runtimeConfig: { heartbeatTimeoutMs: 120000 },
        pauseReason: "manual",
        permissions: { deploy: true },
        totalInputTokens: 42,
        totalOutputTokens: 21,
        instructionsPath: "agents/infra.md",
        instructionsText: "Focus on reliability.",
        soul: "Pragmatic and efficient.",
      }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: agentId,
      name: "Updated Agent",
      role: "engineer",
      metadata: { area: "infra" },
      title: "Infra Engineer",
      icon: "⚙️",
      reportsTo: "agent-parent",
      runtimeConfig: { heartbeatTimeoutMs: 120000 },
      pauseReason: "manual",
      permissions: { deploy: true },
      totalInputTokens: 42,
      totalOutputTokens: 21,
      instructionsPath: "agents/infra.md",
      instructionsText: "Focus on reliability.",
      soul: "Pragmatic and efficient.",
    });
  });

  it("POST /api/agents returns 409 for duplicate non-ephemeral names", async () => {
    const first = await REQUEST(
      buildAgentApp(),
      "POST",
      "/api/agents",
      JSON.stringify({
        name: "Duplicate Agent",
        role: "executor",
      }),
      { "Content-Type": "application/json" },
    );

    expect(first.status).toBe(201);

    const duplicate = await REQUEST(
      buildAgentApp(),
      "POST",
      "/api/agents",
      JSON.stringify({
        name: "Duplicate Agent",
        role: "reviewer",
      }),
      { "Content-Type": "application/json" },
    );

    expect(duplicate.status).toBe(409);
    expect(duplicate.body).toEqual({
      error: "Agent with this name already exists",
      name: "Duplicate Agent",
    });

    const differentName = await REQUEST(
      buildAgentApp(),
      "POST",
      "/api/agents",
      JSON.stringify({
        name: "Unique Agent",
        role: "reviewer",
      }),
      { "Content-Type": "application/json" },
    );

    expect(differentName.status).toBe(201);
  });

  it("POST /api/agents returns 400 when soul exceeds 10,000 characters", async () => {
    const longSoul = "x".repeat(10001);
    const res = await REQUEST(
      buildAgentApp(),
      "POST",
      "/api/agents",
      JSON.stringify({
        name: "Soul Test Agent",
        role: "executor",
        soul: longSoul,
      }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("soul must be at most 10,000 characters");
  });

  it("PATCH /api/agents/:id returns 400 when soul exceeds 10,000 characters", async () => {
    const longSoul = "x".repeat(10001);
    const res = await REQUEST(
      buildAgentApp(),
      "PATCH",
      `/api/agents/${agentId}`,
      JSON.stringify({
        soul: longSoul,
      }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("soul must be at most 10,000 characters");
  });

  it("POST /api/agents/:id/state pauses successfully without heartbeat monitor wiring", async () => {
    const { AgentStore } = await import("@fusion/core");
    const agentStore = new AgentStore({ rootDir: fusionDir });
    await agentStore.init();
    await agentStore.updateAgentState(agentId, "active");

    const res = await REQUEST(
      buildAgentApp(),
      "POST",
      `/api/agents/${agentId}/state`,
      JSON.stringify({ state: "paused" }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: agentId, state: "paused" });

    const updatedAgent = await agentStore.getAgent(agentId);
    expect(updatedAgent?.state).toBe("paused");
  });

  it("POST /api/agents/:id/state returns 400 for invalid state transitions", async () => {
    const res = await REQUEST(
      buildAgentApp(),
      "POST",
      `/api/agents/${agentId}/state`,
      JSON.stringify({ state: "paused" }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Invalid state transition");
  });
});

describe("POST /api/agents/:id/runs", () => {
  let tempDir: string;
  let fusionDir: string;
  let agentId: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "kb-routes-agent-runs-"));
    fusionDir = join(tempDir, ".fusion");
    mkdirSync(fusionDir, { recursive: true });

    // Create a real agent in the temp directory so AgentStore can find it
    const { AgentStore } = await import("@fusion/core");
    const agentStore = new AgentStore({ rootDir: fusionDir });
    await agentStore.init();
    const agent = await agentStore.createAgent({
      name: "Test Agent",
      role: "executor",
    });
    agentId = agent.id;
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function buildApp() {
    const store = createMockStore({
      getFusionDir: vi.fn().mockReturnValue(fusionDir),
    } as any);
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store));
    return app;
  }

  it("returns 201 with created run for valid agent", async () => {
    const res = await REQUEST(buildApp(), "POST", `/api/agents/${agentId}/runs`);

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id: expect.stringMatching(/^run-/),
      agentId,
      status: "active",
      endedAt: null,
      invocationSource: "on_demand",
    });
    expect(res.body.startedAt).toBeTruthy();
  });

  it("persists the run via saveRun", async () => {
    await REQUEST(buildApp(), "POST", `/api/agents/${agentId}/runs`);

    // Verify run was persisted to filesystem
    const { AgentStore } = await import("@fusion/core");
    const agentStore = new AgentStore({ rootDir: fusionDir });
    await agentStore.init();
    const runs = await agentStore.getRecentRuns(agentId);
    expect(runs).toHaveLength(1);
    expect(runs[0].invocationSource).toBe("on_demand");
  });

  it("returns 404 for non-existent agent", async () => {
    const res = await REQUEST(buildApp(), "POST", "/api/agents/agent-nonexistent/runs");

    expect(res.status).toBe(404);
    expect(res.body.error).toContain("not found");
  });

  it("uses default invocationSource when no body provided", async () => {
    const res = await REQUEST(buildApp(), "POST", `/api/agents/${agentId}/runs`);

    expect(res.status).toBe(201);
    expect(res.body.invocationSource).toBe("on_demand");
  });

  it("uses custom source and triggerDetail from body", async () => {
    const res = await REQUEST(
      buildApp(),
      "POST",
      `/api/agents/${agentId}/runs`,
      JSON.stringify({ source: "timer", triggerDetail: "cron schedule" }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(201);
    expect(res.body.invocationSource).toBe("timer");
    expect(res.body.triggerDetail).toBe("cron schedule");
  });

  it("returns 500 on store error", async () => {
    const store = createMockStore({
      getFusionDir: vi.fn().mockReturnValue("/nonexistent/path/that/does/not/exist"),
    } as any);
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store));

    // This should hit an error because the agent doesn't exist in that path
    const res = await REQUEST(app, "POST", `/api/agents/${agentId}/runs`);

    expect(res.status).toBe(500);
  });

  it("accepts taskId in body and includes it in contextSnapshot", async () => {
    const res = await REQUEST(
      buildApp(),
      "POST",
      `/api/agents/${agentId}/runs`,
      JSON.stringify({ source: "on_demand", triggerDetail: "manual", taskId: "FN-001" }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(201);
    expect(res.body.contextSnapshot).toMatchObject({
      wakeReason: "on_demand",
      triggerDetail: "manual",
      taskId: "FN-001",
    });
  });

  it("accepts triggering comment wake fields and persists them in contextSnapshot", async () => {
    const res = await REQUEST(
      buildApp(),
      "POST",
      `/api/agents/${agentId}/runs`,
      JSON.stringify({
        source: "on_demand",
        triggerDetail: "task-comment",
        taskId: "FN-001",
        triggeringCommentIds: ["c1", "c2"],
        triggeringCommentType: "task",
      }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(201);
    expect(res.body.contextSnapshot).toMatchObject({
      wakeReason: "on_demand",
      triggerDetail: "task-comment",
      taskId: "FN-001",
      triggeringCommentIds: ["c1", "c2"],
      triggeringCommentType: "task",
    });
  });

  it("returns 400 when triggeringCommentIds is not an array", async () => {
    const res = await REQUEST(
      buildApp(),
      "POST",
      `/api/agents/${agentId}/runs`,
      JSON.stringify({ triggeringCommentIds: "not-an-array" }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("triggeringCommentIds must be an array of strings");
  });

  it("returns 400 when triggeringCommentIds contains non-string values", async () => {
    const res = await REQUEST(
      buildApp(),
      "POST",
      `/api/agents/${agentId}/runs`,
      JSON.stringify({ triggeringCommentIds: ["c1", 42] }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("triggeringCommentIds must be an array of strings");
  });

  it("returns 400 when triggeringCommentType is invalid", async () => {
    const res = await REQUEST(
      buildApp(),
      "POST",
      `/api/agents/${agentId}/runs`,
      JSON.stringify({ triggeringCommentType: "invalid" }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("triggeringCommentType must be one of: steering, task, pr");
  });

  it("includes wake context without taskId when not provided", async () => {
    const res = await REQUEST(
      buildApp(),
      "POST",
      `/api/agents/${agentId}/runs`,
      JSON.stringify({ source: "timer", triggerDetail: "scheduled" }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(201);
    expect(res.body.contextSnapshot).toMatchObject({
      wakeReason: "timer",
      triggerDetail: "scheduled",
    });
    expect(res.body.contextSnapshot.taskId).toBeUndefined();
  });

  it("returns 409 when agent already has an active run", async () => {
    // Create first run
    const res1 = await REQUEST(buildApp(), "POST", `/api/agents/${agentId}/runs`);
    expect(res1.status).toBe(201);

    // Try to create second run — should conflict
    const res2 = await REQUEST(buildApp(), "POST", `/api/agents/${agentId}/runs`);
    expect(res2.status).toBe(409);
    expect(res2.body.error).toContain("active run");
    expect(res2.body.details?.runId).toBeTruthy();
  });

  it("returns 201 again after a prior run is completed via stop", async () => {
    // Create first run
    const res1 = await REQUEST(buildApp(), "POST", `/api/agents/${agentId}/runs`);
    expect(res1.status).toBe(201);
    const runId1 = res1.body.id;

    // Stop the run
    const stopRes = await REQUEST(buildApp(), "POST", `/api/agents/${agentId}/runs/stop`);
    expect(stopRes.status).toBe(200);
    expect(stopRes.body.runId).toBe(runId1);

    // Create second run — should succeed now that first is complete
    const res2 = await REQUEST(buildApp(), "POST", `/api/agents/${agentId}/runs`);
    expect(res2.status).toBe(201);
    expect(res2.body.id).not.toBe(runId1);
    expect(res2.body.status).toBe("active");
  });

  it("returns 201 again after a prior run is completed via AgentStore.endHeartbeatRun", async () => {
    // Create first run
    const res1 = await REQUEST(buildApp(), "POST", `/api/agents/${agentId}/runs`);
    expect(res1.status).toBe(201);
    const runId1 = res1.body.id;

    // Complete the run directly via AgentStore
    const { AgentStore } = await import("@fusion/core");
    const agentStore = new AgentStore({ rootDir: fusionDir });
    await agentStore.init();
    await agentStore.endHeartbeatRun(runId1, "completed");

    // Verify run is completed
    const activeRun = await agentStore.getActiveHeartbeatRun(agentId);
    expect(activeRun).toBeNull();

    // Create second run — should succeed now that first is complete
    const res2 = await REQUEST(buildApp(), "POST", `/api/agents/${agentId}/runs`);
    expect(res2.status).toBe(201);
    expect(res2.body.id).not.toBe(runId1);
    expect(res2.body.status).toBe("active");
  });
});

describe("GET /api/agents/:id/runs/:runId/logs", () => {
  let tempDir: string;
  let fusionDir: string;
  let agentId: string;
  let taskId: string;
  let runId: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "kb-routes-agent-run-logs-"));
    fusionDir = join(tempDir, ".fusion");
    mkdirSync(fusionDir, { recursive: true });

    const { AgentStore } = await import("@fusion/core");
    const agentStore = new AgentStore({ rootDir: fusionDir });
    await agentStore.init();

    const agent = await agentStore.createAgent({
      name: "Test Agent",
      role: "executor",
    });
    agentId = agent.id;

    // Start a run, complete it, and record its ID
    const run = await agentStore.startHeartbeatRun(agentId);
    runId = run.id;

    // End the run with a context snapshot containing a taskId
    run.endedAt = new Date().toISOString();
    run.status = "completed";
    run.contextSnapshot = { taskId: "FN-001", projectId: "test-project" };
    await agentStore.saveRun(run);

    taskId = "FN-001";
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function buildApp() {
    const store = createMockStore({
      getFusionDir: vi.fn().mockReturnValue(fusionDir),
      getAgentLogsByTimeRange: vi.fn().mockResolvedValue([
        {
          timestamp: "2024-01-01T00:01:00.000Z",
          taskId: "FN-001",
          text: "Starting task execution",
          type: "text",
        },
        {
          timestamp: "2024-01-01T00:02:00.000Z",
          taskId: "FN-001",
          text: "Read file: src/index.ts",
          type: "tool",
        },
      ]),
    } as any);
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store));
    return app;
  }

  it("returns logs for a valid run with contextSnapshot.taskId", async () => {
    const res = await REQUEST(buildApp(), "GET", `/api/agents/${agentId}/runs/${runId}/logs`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0]).toMatchObject({ taskId: "FN-001", type: "text" });
    expect(res.body[1]).toMatchObject({ taskId: "FN-001", type: "tool" });
  });

  it("returns synthesized logs for run without contextSnapshot.taskId", async () => {
    // Create a run without contextSnapshot
    const { AgentStore } = await import("@fusion/core");
    const agentStore = new AgentStore({ rootDir: fusionDir });
    await agentStore.init();
    const run = await agentStore.startHeartbeatRun(agentId);
    run.endedAt = new Date().toISOString();
    run.status = "completed";
    run.stdoutExcerpt = "Ambient heartbeat completed";
    // No contextSnapshot
    await agentStore.saveRun(run);

    const store = createMockStore({
      getFusionDir: vi.fn().mockReturnValue(fusionDir),
      getAgentLogsByTimeRange: vi.fn().mockResolvedValue([]),
    } as any);
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store));

    const res = await REQUEST(app, "GET", `/api/agents/${agentId}/runs/${run.id}/logs`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      expect.objectContaining({
        taskId: "agent-run",
        type: "text",
        text: "Ambient heartbeat completed",
      }),
    ]);
  });

  it("returns 404 for non-existent run", async () => {
    const res = await REQUEST(buildApp(), "GET", `/api/agents/${agentId}/runs/run-nonexistent/logs`);

    expect(res.status).toBe(404);
    expect(res.body.error).toContain("Run not found");
  });

  it("returns 404 for non-existent agent", async () => {
    const res = await REQUEST(buildApp(), "GET", `/api/agents/agent-nonexistent/runs/${runId}/logs`);

    expect(res.status).toBe(404);
  });

  it("handles store errors gracefully", async () => {
    const store = createMockStore({
      getFusionDir: vi.fn().mockReturnValue("/nonexistent/path"),
    } as any);
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store));

    const res = await REQUEST(app, "GET", `/api/agents/${agentId}/runs/${runId}/logs`);

    // Either 404 or 500 depending on where the error occurs
    expect([404, 500]).toContain(res.status);
  });
});

describe("Agent Budget routes", () => {
  let tempDir: string;
  let fusionDir: string;
  let agentId: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "kb-routes-budget-"));
    fusionDir = join(tempDir, ".fusion");
    mkdirSync(fusionDir, { recursive: true });

    const { AgentStore } = await import("@fusion/core");
    const agentStore = new AgentStore({ rootDir: fusionDir });
    await agentStore.init();
    const agent = await agentStore.createAgent({
      name: "Budget Test Agent",
      role: "executor",
    });
    agentId = agent.id;
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function buildApp() {
    const store = createMockStore({
      getFusionDir: vi.fn().mockReturnValue(fusionDir),
    } as any);
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store));
    return app;
  }

  describe("GET /api/agents/:id/budget", () => {
    it("returns budget status with no-limit when budget not configured", async () => {
      const res = await GET(buildApp(), `/api/agents/${agentId}/budget`);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        agentId,
        currentUsage: 0,
        budgetLimit: null,
        usagePercent: null,
        thresholdPercent: null,
        isOverBudget: false,
        isOverThreshold: false,
        lastResetAt: null,
        nextResetAt: null,
      });
    });

    it("returns budget status with values when budget is configured", async () => {
      // Configure budget via PATCH
      const patchRes = await REQUEST(
        buildApp(),
        "PATCH",
        `/api/agents/${agentId}`,
        JSON.stringify({
          runtimeConfig: {
            budgetConfig: {
              tokenBudget: 100000,
              usageThreshold: 0.8,
              budgetPeriod: "lifetime",
            },
          },
        }),
        { "Content-Type": "application/json" },
      );
      expect(patchRes.status).toBe(200);

      const res = await GET(buildApp(), `/api/agents/${agentId}/budget`);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        agentId,
        currentUsage: 0,
        budgetLimit: 100000,
        usagePercent: 0,
        thresholdPercent: 80, // stored as percentage (0.8 * 100)
        isOverBudget: false,
        isOverThreshold: false,
        lastResetAt: null,
        nextResetAt: null,
      });
    });

    it("returns 404 for nonexistent agent", async () => {
      const res = await GET(buildApp(), "/api/agents/nonexistent/budget");

      expect(res.status).toBe(404);
      expect(res.body.error).toContain("Agent not found");
    });

    it("reflects over-threshold status correctly", async () => {
      // Configure budget and set tokens to 85% usage
      await REQUEST(
        buildApp(),
        "PATCH",
        `/api/agents/${agentId}`,
        JSON.stringify({
          runtimeConfig: {
            budgetConfig: {
              tokenBudget: 100000,
              usageThreshold: 0.8,
              budgetPeriod: "lifetime",
            },
          },
          totalInputTokens: 42500,
          totalOutputTokens: 42500,
        }),
        { "Content-Type": "application/json" },
      );

      const res = await GET(buildApp(), `/api/agents/${agentId}/budget`);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        agentId,
        currentUsage: 85000,
        budgetLimit: 100000,
        usagePercent: 85,
        thresholdPercent: 80, // stored as percentage (0.8 * 100)
        isOverBudget: false,
        isOverThreshold: true, // 85% >= 80%
      });
    });

    it("reflects over-budget status correctly", async () => {
      // Configure budget and set tokens to 110% usage
      await REQUEST(
        buildApp(),
        "PATCH",
        `/api/agents/${agentId}`,
        JSON.stringify({
          runtimeConfig: {
            budgetConfig: {
              tokenBudget: 100000,
              usageThreshold: 0.8,
              budgetPeriod: "lifetime",
            },
          },
          totalInputTokens: 55000,
          totalOutputTokens: 55000,
        }),
        { "Content-Type": "application/json" },
      );

      const res = await GET(buildApp(), `/api/agents/${agentId}/budget`);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        agentId,
        currentUsage: 110000,
        budgetLimit: 100000,
        usagePercent: 100, // Clamped to 100
        thresholdPercent: 80, // stored as percentage (0.8 * 100)
        isOverBudget: true, // 110000 >= 100000
        isOverThreshold: true,
      });
    });

    it("computes nextResetAt for daily budget period", async () => {
      await REQUEST(
        buildApp(),
        "PATCH",
        `/api/agents/${agentId}`,
        JSON.stringify({
          runtimeConfig: {
            budgetConfig: {
              tokenBudget: 100000,
              usageThreshold: 0.8,
              budgetPeriod: "daily",
            },
          },
        }),
        { "Content-Type": "application/json" },
      );

      const res = await GET(buildApp(), `/api/agents/${agentId}/budget`);

      expect(res.status).toBe(200);
      expect(res.body.nextResetAt).toBeTruthy();
      expect(new Date(res.body.nextResetAt).getTime()).toBeGreaterThan(Date.now());
    });
  });

  describe("POST /api/agents/:id/budget/reset", () => {
    it("resets token counters and sets budgetResetAt", async () => {
      // First set some tokens
      await REQUEST(
        buildApp(),
        "PATCH",
        `/api/agents/${agentId}`,
        JSON.stringify({
          runtimeConfig: {
            budgetConfig: {
              tokenBudget: 100000,
              usageThreshold: 0.8,
            },
          },
          totalInputTokens: 50000,
          totalOutputTokens: 30000,
        }),
        { "Content-Type": "application/json" },
      );

      // Verify pre-reset state
      const preRes = await GET(buildApp(), `/api/agents/${agentId}/budget`);
      expect(preRes.body.currentUsage).toBe(80000);

      // Reset budget
      const resetRes = await REQUEST(
        buildApp(),
        "POST",
        `/api/agents/${agentId}/budget/reset`,
        undefined,
        {},
      );

      expect(resetRes.status).toBe(200);
      expect(resetRes.body).toEqual({ success: true });

      // Verify post-reset state
      const postRes = await GET(buildApp(), `/api/agents/${agentId}/budget`);
      expect(postRes.body.currentUsage).toBe(0);
      expect(postRes.body.lastResetAt).toBeTruthy();
      expect(new Date(postRes.body.lastResetAt).getTime()).toBeGreaterThanOrEqual(
        Date.now() - 5000, // Allow 5 second tolerance
      );
    });

    it("returns 404 for nonexistent agent", async () => {
      const res = await REQUEST(
        buildApp(),
        "POST",
        "/api/agents/nonexistent/budget/reset",
        undefined,
        {},
      );

      expect(res.status).toBe(404);
      expect(res.body.error).toContain("Agent not found");
    });

    it("allows reset when agent has no budget configured", async () => {
      const res = await REQUEST(
        buildApp(),
        "POST",
        `/api/agents/${agentId}/budget/reset`,
        undefined,
        {},
      );

      // Reset should succeed even without budget configured
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true });
    });

    it("clears usage percent back to zero after reset", async () => {
      // Set up with budget and usage
      await REQUEST(
        buildApp(),
        "PATCH",
        `/api/agents/${agentId}`,
        JSON.stringify({
          runtimeConfig: {
            budgetConfig: {
              tokenBudget: 100000,
              usageThreshold: 0.8,
            },
          },
          totalInputTokens: 90000,
          totalOutputTokens: 10000,
        }),
        { "Content-Type": "application/json" },
      );

      await REQUEST(
        buildApp(),
        "POST",
        `/api/agents/${agentId}/budget/reset`,
        undefined,
        {},
      );

      const res = await GET(buildApp(), `/api/agents/${agentId}/budget`);
      expect(res.body.usagePercent).toBe(0);
      expect(res.body.isOverThreshold).toBe(false);
      expect(res.body.isOverBudget).toBe(false);
    });
  });
});

describe("Agent Reflection routes", () => {
  let tempDir: string;
  let fusionDir: string;
  let agentId: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "kb-routes-reflection-"));
    fusionDir = join(tempDir, ".fusion");
    mkdirSync(fusionDir, { recursive: true });

    // Create a real agent in the temp directory
    const { AgentStore } = await import("@fusion/core");
    const agentStore = new AgentStore({ rootDir: fusionDir });
    await agentStore.init();
    const agent = await agentStore.createAgent({
      name: "Test Agent",
      role: "executor",
    });
    agentId = agent.id;
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function buildApp() {
    const store = createMockStore({
      getRootDir: vi.fn().mockReturnValue(tempDir),
      getFusionDir: vi.fn().mockReturnValue(fusionDir),
    } as any);
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store));
    return app;
  }

  afterEach(async () => {
    const engine = await import("@fusion/engine");
    const reflectionService =
      "AgentReflectionService" in engine && typeof engine.AgentReflectionService === "function"
        ? (engine.AgentReflectionService as unknown as Parameters<typeof __setAgentReflectionServiceForTests>[0])
        : undefined;
    __setAgentReflectionServiceForTests(reflectionService);
  });

  describe("GET /api/agents/:id/reflections", () => {
    it("returns 200 for valid agent (uses real stores)", async () => {
      const res = await GET(buildApp(), `/api/agents/${agentId}/reflections`);

      // The route uses real stores, so it should return an empty array (no reflections created yet)
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it("returns 404 for non-existent agent", async () => {
      const res = await GET(buildApp(), "/api/agents/nonexistent-agent/reflections");

      expect(res.status).toBe(404);
      expect(res.body.error).toContain("not found");
    });

    it("accepts limit query param", async () => {
      const res = await GET(buildApp(), `/api/agents/${agentId}/reflections?limit=10`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });
  });

  describe("GET /api/agents/:id/reflections/latest", () => {
    it("returns 404 when no reflections exist", async () => {
      const res = await GET(buildApp(), `/api/agents/${agentId}/reflections/latest`);

      expect(res.status).toBe(404);
      expect(res.body.error).toContain("No reflections found");
    });

    it("returns 404 for non-existent agent", async () => {
      const res = await GET(buildApp(), "/api/agents/nonexistent-agent/reflections/latest");

      expect(res.status).toBe(404);
      expect(res.body.error).toContain("not found");
    });
  });

  describe("POST /api/agents/:id/reflections", () => {
    it("returns 500 when reflection generation fails for an existing agent", async () => {
      const res = await REQUEST(buildApp(), "POST", `/api/agents/${agentId}/reflections`);

      expect(res.status).toBe(500);
      expect(res.body.error).toMatch(/Unable to generate reflection|Reflection service unavailable/i);
    }, 15000);

    it("returns 500 with a clear message when reflection generation returns null", async () => {
      const engine = await import("@fusion/engine");
      __setAgentReflectionServiceForTests(engine.AgentReflectionService);
      const generateReflectionSpy = vi
        .spyOn(engine.AgentReflectionService.prototype, "generateReflection")
        .mockResolvedValueOnce(null);

      const res = await REQUEST(buildApp(), "POST", `/api/agents/${agentId}/reflections`);

      expect(res.status).toBe(500);
      expect(res.body.error).toContain("Unable to generate reflection");

      generateReflectionSpy.mockRestore();
    });

    it("returns 404 for a non-existent agent", async () => {
      const res = await REQUEST(buildApp(), "POST", "/api/agents/nonexistent-agent/reflections");

      expect(res.status).toBe(404);
      expect(res.body.error).toContain("not found");
    });
  });

  describe("GET /api/agents/:id/performance", () => {
    it("returns 200 with performance summary for valid agent", async () => {
      const res = await GET(buildApp(), `/api/agents/${agentId}/performance`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("agentId");
      expect(res.body).toHaveProperty("totalTasksCompleted");
      expect(res.body).toHaveProperty("successRate");
    });

    it("accepts windowMs query param", async () => {
      const res = await GET(buildApp(), `/api/agents/${agentId}/performance?windowMs=604800000`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("agentId");
    });

    it("returns 404 for non-existent agent", async () => {
      const res = await GET(buildApp(), "/api/agents/nonexistent-agent/performance");

      expect(res.status).toBe(404);
      expect(res.body.error).toContain("not found");
    });
  });

  describe("GET /api/agents/:id/reflection-context", () => {
    it("returns 503 when reflection service binding is unavailable", async () => {
      __setAgentReflectionServiceForTests(undefined);
      const res = await GET(buildApp(), `/api/agents/${agentId}/reflection-context`);

      expect(res.status).toBe(503);
      expect(res.body.error).toContain("Reflection service not available");
    });
    it("returns 200 when reflection context is available, otherwise 500/503", async () => {
      const res = await GET(buildApp(), `/api/agents/${agentId}/reflection-context`);

      expect([200, 500, 503]).toContain(res.status);
    });

    it("returns 404 or 500 for non-existent agent", async () => {
      const res = await GET(buildApp(), "/api/agents/nonexistent-agent/reflection-context");

      // The route either returns 404 (agent not found) or 500 (reflection service error)
      expect([404, 500]).toContain(res.status);
    });
  });

  it("does not create fusion.db or agents directory in project root for reflection endpoints", async () => {
    const app = buildApp();

    const rootDbPath = join(tempDir, "fusion.db");
    const rootDbWalPath = join(tempDir, "fusion.db-wal");
    const rootDbShmPath = join(tempDir, "fusion.db-shm");
    const rootAgentsDir = join(tempDir, "agents");

    expect(existsSync(rootDbPath)).toBe(false);
    expect(existsSync(rootDbWalPath)).toBe(false);
    expect(existsSync(rootDbShmPath)).toBe(false);
    expect(existsSync(rootAgentsDir)).toBe(false);

    const postRes = await REQUEST(app, "POST", `/api/agents/${agentId}/reflections`);
    expect(postRes.status).toBe(500);

    const contextRes = await GET(app, `/api/agents/${agentId}/reflection-context`);
    expect([200, 500, 503]).toContain(contextRes.status);

    expect(existsSync(rootDbPath)).toBe(false);
    expect(existsSync(rootDbWalPath)).toBe(false);
    expect(existsSync(rootDbShmPath)).toBe(false);
    expect(existsSync(rootAgentsDir)).toBe(false);
  });
});

// ── AI Refine Text Route with Scoped Settings ────────────────────────────────

describe("POST /api/ai/refine-text with projectId scoping", () => {
  const projectId = "proj-refine-test";

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
    (scopedStore.getSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      promptOverrides: {
        "ai-refine-system": "Custom AI refine prompt",
      },
    });

    // The route will call refineText which requires AI engine
    // We verify that scoped store is correctly used by checking settings was called
    const res = await REQUEST(
      buildApp(),
      "POST",
      `/api/ai/refine-text?projectId=${projectId}`,
      JSON.stringify({ text: "Task description", type: "clarify" }),
      { "Content-Type": "application/json" }
    );

    // The route should call scoped store's getSettings (it may fail on AI call but settings was checked)
    expect(projectStoreResolver.getOrCreateProjectStore).toHaveBeenCalledWith(projectId);
    expect(scopedStore.getSettings).toHaveBeenCalled();
    expect(scopedStore.getRootDir).toHaveBeenCalled();
  });

  it("returns 400 for missing text field", async () => {
    const res = await REQUEST(
      buildApp(),
      "POST",
      `/api/ai/refine-text?projectId=${projectId}`,
      JSON.stringify({ type: "clarify" }),
      { "Content-Type": "application/json" }
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("text is required");
  });

  it("returns 400 for missing type field", async () => {
    const res = await REQUEST(
      buildApp(),
      "POST",
      `/api/ai/refine-text?projectId=${projectId}`,
      JSON.stringify({ text: "Some text" }),
      { "Content-Type": "application/json" }
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("type is required");
  });

  it("returns 422 for invalid refinement type", async () => {
    const res = await REQUEST(
      buildApp(),
      "POST",
      `/api/ai/refine-text?projectId=${projectId}`,
      JSON.stringify({ text: "Some text", type: "invalid-type" }),
      { "Content-Type": "application/json" }
    );

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("type must be one of");
  });

  it("returns 400 when text is empty", async () => {
    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/ai/refine-text",
      JSON.stringify({ text: "", type: "clarify" }),
      { "Content-Type": "application/json" }
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("at least 1 character");
  });

  it("returns 400 when text exceeds 2000 characters", async () => {
    const longText = "a".repeat(2001);
    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/ai/refine-text",
      JSON.stringify({ text: longText, type: "clarify" }),
      { "Content-Type": "application/json" }
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("not exceed 2000 characters");
  });
});

describe("Messaging Routes", () => {
  let rootDir: string;
  let store: TaskStore;
  let app: express.Express;
  let messageStore: import("@fusion/core").MessageStore;

  beforeEach(async () => {
    rootDir = mkdtempSync(join(tmpdir(), "kb-message-routes-"));
    const { TaskStore, MessageStore } = await import("@fusion/core");

    store = new TaskStore(rootDir, join(rootDir, ".fusion-global-settings"), { inMemoryDb: true });
    await store.init();
    messageStore = new MessageStore(store.getDatabase());

    app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store));
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it("uses the engine MessageStore when available", async () => {
    const message = {
      id: "msg-runtime-1",
      fromId: "dashboard",
      fromType: "user",
      toId: "agent-1",
      toType: "agent",
      content: "runtime store message",
      type: "user-to-agent",
      read: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const runtimeMessageStore = {
      sendMessage: vi.fn().mockReturnValue(message),
    };
    const runtimeEngine = {
      getMessageStore: vi.fn().mockReturnValue(runtimeMessageStore),
    };

    const runtimeApp = express();
    runtimeApp.use(express.json());
    runtimeApp.use("/api", createApiRoutes(store, { engine: runtimeEngine as any }));

    const res = await REQUEST(
      runtimeApp,
      "POST",
      "/api/messages",
      JSON.stringify({
        toId: "agent-1",
        toType: "agent",
        content: "runtime store message",
        type: "user-to-agent",
      }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(201);
    expect(runtimeEngine.getMessageStore).toHaveBeenCalled();
    expect(runtimeMessageStore.sendMessage).toHaveBeenCalledWith({
      fromId: "dashboard",
      fromType: "user",
      toId: "agent-1",
      toType: "agent",
      content: "runtime store message",
      type: "user-to-agent",
      metadata: undefined,
    });
    expect(res.body.id).toBe("msg-runtime-1");
  });

  it("triggers executeHeartbeat when wakeImmediately is true for agent recipients", async () => {
    const executeHeartbeat = vi.fn().mockResolvedValue({ id: "run-1" });
    const wakeApp = express();
    wakeApp.use(express.json());
    wakeApp.use("/api", createApiRoutes(store, {
      heartbeatMonitor: { executeHeartbeat, rootDir } as any,
    }));

    const res = await REQUEST(
      wakeApp,
      "POST",
      "/api/messages",
      JSON.stringify({
        toId: "agent-wake-1",
        toType: "agent",
        content: "wake now",
        type: "user-to-agent",
        wakeImmediately: true,
      }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(201);
    expect(executeHeartbeat).toHaveBeenCalledWith({
      agentId: "agent-wake-1",
      source: "on_demand",
      triggerDetail: "wake-on-message",
    });
  });

  it("does not trigger executeHeartbeat when wakeImmediately is omitted/false or recipient is not an agent", async () => {
    const executeHeartbeat = vi.fn().mockResolvedValue({ id: "run-1" });
    const wakeApp = express();
    wakeApp.use(express.json());
    wakeApp.use("/api", createApiRoutes(store, {
      heartbeatMonitor: { executeHeartbeat, rootDir } as any,
    }));

    const noWake = await REQUEST(
      wakeApp,
      "POST",
      "/api/messages",
      JSON.stringify({
        toId: "agent-no-wake",
        toType: "agent",
        content: "normal message",
        type: "user-to-agent",
      }),
      { "Content-Type": "application/json" },
    );

    const userRecipient = await REQUEST(
      wakeApp,
      "POST",
      "/api/messages",
      JSON.stringify({
        toId: "dashboard",
        toType: "user",
        content: "user message",
        type: "system",
        wakeImmediately: true,
      }),
      { "Content-Type": "application/json" },
    );

    expect(noWake.status).toBe(201);
    expect(userRecipient.status).toBe(201);
    expect(executeHeartbeat).not.toHaveBeenCalled();
  });

  it("uses project-scoped heartbeat monitor resolution when default monitor belongs to another root", async () => {
    const defaultExecuteHeartbeat = vi.fn().mockResolvedValue({ id: "run-default" });
    const projectExecuteHeartbeat = vi.fn().mockResolvedValue({ id: "run-project" });

    const engineManager = {
      getAllEngines: vi.fn().mockReturnValue(new Map([
        [
          "project-1",
          {
            getWorkingDirectory: () => rootDir,
            getHeartbeatMonitor: () => ({
              executeHeartbeat: projectExecuteHeartbeat,
              startRun: vi.fn(),
              stopRun: vi.fn(),
            }),
          },
        ],
      ])),
    };

    const wakeApp = express();
    wakeApp.use(express.json());
    wakeApp.use("/api", createApiRoutes(store, {
      heartbeatMonitor: { executeHeartbeat: defaultExecuteHeartbeat, rootDir: join(rootDir, "other-project") } as any,
      engineManager: engineManager as any,
    }));

    const res = await REQUEST(
      wakeApp,
      "POST",
      "/api/messages",
      JSON.stringify({
        toId: "agent-project-scope",
        toType: "agent",
        content: "wake in scoped project",
        type: "user-to-agent",
        wakeImmediately: true,
      }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(201);
    expect(defaultExecuteHeartbeat).not.toHaveBeenCalled();
    expect(projectExecuteHeartbeat).toHaveBeenCalledWith({
      agentId: "agent-project-scope",
      source: "on_demand",
      triggerDetail: "wake-on-message",
    });
  });

  it("returns created message even when wakeImmediately execution throws", async () => {
    const executeHeartbeat = vi.fn().mockRejectedValue(new Error("wake failed"));
    const wakeApp = express();
    wakeApp.use(express.json());
    wakeApp.use("/api", createApiRoutes(store, {
      heartbeatMonitor: { executeHeartbeat, rootDir } as any,
    }));

    const res = await REQUEST(
      wakeApp,
      "POST",
      "/api/messages",
      JSON.stringify({
        toId: "agent-wake-failure",
        toType: "agent",
        content: "wake best effort",
        type: "user-to-agent",
        wakeImmediately: true,
      }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(201);
    expect(res.body.toId).toBe("agent-wake-failure");
    expect(executeHeartbeat).toHaveBeenCalledTimes(1);
  });

  it("supports metadata.wakeRecipient as an immediate-wake request", async () => {
    const executeHeartbeat = vi.fn().mockResolvedValue({ id: "run-1" });
    const wakeApp = express();
    wakeApp.use(express.json());
    wakeApp.use("/api", createApiRoutes(store, {
      heartbeatMonitor: { executeHeartbeat, rootDir } as any,
    }));

    const res = await REQUEST(
      wakeApp,
      "POST",
      "/api/messages",
      JSON.stringify({
        toId: "agent-wake-meta",
        toType: "agent",
        content: "wake via metadata",
        type: "user-to-agent",
        metadata: { wakeRecipient: true },
      }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(201);
    expect(executeHeartbeat).toHaveBeenCalledWith({
      agentId: "agent-wake-meta",
      source: "on_demand",
      triggerDetail: "wake-on-message",
    });
  });

  it("gracefully no-ops wakeImmediately when no heartbeat monitor is configured", async () => {
    const res = await REQUEST(
      app,
      "POST",
      "/api/messages",
      JSON.stringify({
        toId: "agent-no-monitor",
        toType: "agent",
        content: "wake request without monitor",
        type: "user-to-agent",
        wakeImmediately: true,
      }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(201);
    expect(res.body.toId).toBe("agent-no-monitor");
  });

  it("GET /api/messages/inbox returns dashboard inbox messages", async () => {
    const inboxMessage = messageStore.sendMessage({
      fromId: "agent-1",
      fromType: "agent",
      toId: "dashboard",
      toType: "user",
      content: "Hello dashboard",
      type: "agent-to-user",
    });
    messageStore.sendMessage({
      fromId: "agent-2",
      fromType: "agent",
      toId: "someone-else",
      toType: "user",
      content: "not for dashboard",
      type: "agent-to-user",
    });

    const res = await GET(app, "/api/messages/inbox");

    expect(res.status).toBe(200);
    expect(res.body.messages).toHaveLength(1);
    expect(res.body.messages[0].id).toBe(inboxMessage.id);
    expect(res.body.unreadCount).toBe(1);
  });

  it("dashboard inbox aggregates legacy dashboard user aliases", async () => {
    messageStore.sendMessage({ fromId: "agent-1", fromType: "agent", toId: "dashboard", toType: "user", content: "A", type: "agent-to-user" });
    messageStore.sendMessage({ fromId: "agent-1", fromType: "agent", toId: "user:dashboard", toType: "user", content: "B", type: "agent-to-user" });
    messageStore.sendMessage({ fromId: "agent-1", fromType: "agent", toId: "User: user:dashboard", toType: "user", content: "C", type: "agent-to-user" });

    const inbox = await GET(app, "/api/messages/inbox");
    expect(inbox.status).toBe(200);
    expect(inbox.body.messages).toHaveLength(3);

    const unread = await GET(app, "/api/messages/unread-count");
    expect(unread.body.unreadCount).toBe(3);

    const readAll = await REQUEST(app, "POST", "/api/messages/read-all");
    expect(readAll.status).toBe(200);
    expect(readAll.body.markedAsRead).toBe(3);
  });

  it("GET /api/messages/outbox returns dashboard sent messages", async () => {
    const sent = await REQUEST(
      app,
      "POST",
      "/api/messages",
      JSON.stringify({
        toId: "agent-7",
        toType: "agent",
        content: "Can you review this?",
        type: "user-to-agent",
      }),
      { "Content-Type": "application/json" },
    );
    expect(sent.status).toBe(201);

    const res = await GET(app, "/api/messages/outbox");

    expect(res.status).toBe(200);
    expect(res.body.messages).toHaveLength(1);
    expect(res.body.messages[0].id).toBe(sent.body.id);
    expect(res.body.messages[0].fromId).toBe("dashboard");
  });

  it("GET /api/messages/unread-count returns the unread count", async () => {
    const unread = messageStore.sendMessage({
      fromId: "agent-1",
      fromType: "agent",
      toId: "dashboard",
      toType: "user",
      content: "Unread",
      type: "agent-to-user",
    });
    const read = messageStore.sendMessage({
      fromId: "agent-2",
      fromType: "agent",
      toId: "dashboard",
      toType: "user",
      content: "Read",
      type: "agent-to-user",
    });
    messageStore.markAsRead(read.id);

    const res = await GET(app, "/api/messages/unread-count");

    expect(unread).toBeDefined();
    expect(res.status).toBe(200);
    expect(res.body.unreadCount).toBe(1);
  });

  it("POST /api/messages validates required fields and creates messages", async () => {
    const created = await REQUEST(
      app,
      "POST",
      "/api/messages",
      JSON.stringify({
        toId: "agent-3",
        toType: "agent",
        content: "Need your help",
        type: "user-to-agent",
      }),
      { "Content-Type": "application/json" },
    );

    expect(created.status).toBe(201);
    expect(created.body.toId).toBe("agent-3");
    expect(created.body.fromId).toBe("dashboard");

    const invalidCases = [
      { body: { toType: "agent", content: "x", type: "user-to-agent" }, message: "toId is required" },
      { body: { toId: "agent-1", content: "x", type: "user-to-agent", toType: "bad" }, message: "toType must be one of" },
      { body: { toId: "agent-1", toType: "agent", content: "", type: "user-to-agent" }, message: "content is required" },
      { body: { toId: "agent-1", toType: "agent", content: "a".repeat(2001), type: "user-to-agent" }, message: "content is required" },
      { body: { toId: "agent-1", toType: "agent", content: "x", type: "bad-type" }, message: "type must be one of" },
      { body: { toId: "agent-1", toType: "agent", content: "x", type: "user-to-agent", metadata: "bad" }, message: "metadata must be an object" },
      {
        body: {
          toId: "agent-1",
          toType: "agent",
          content: "x",
          type: "user-to-agent",
          metadata: { replyTo: { messageId: "" } },
        },
        message: "metadata.replyTo.messageId must be a non-empty string",
      },
      {
        body: {
          toId: "agent-1",
          toType: "agent",
          content: "x",
          type: "user-to-agent",
          wakeImmediately: "yes",
        },
        message: "wakeImmediately must be a boolean",
      },
    ];

    for (const testCase of invalidCases) {
      const res = await REQUEST(
        app,
        "POST",
        "/api/messages",
        JSON.stringify(testCase.body),
        { "Content-Type": "application/json" },
      );
      expect(res.status).toBe(400);
      expect(String(res.body.error)).toContain(testCase.message);
    }
  });

  it("preserves reply metadata for dashboard-sent messages", async () => {
    const original = messageStore.sendMessage({
      fromId: "agent-3",
      fromType: "agent",
      toId: "dashboard",
      toType: "user",
      content: "Lookup me",
      type: "agent-to-user",
    });

    const created = await REQUEST(
      app,
      "POST",
      "/api/messages",
      JSON.stringify({
        toId: "agent-3",
        toType: "agent",
        content: "Replying now",
        type: "user-to-agent",
        metadata: { replyTo: { messageId: original.id } },
      }),
      { "Content-Type": "application/json" },
    );

    expect(created.status).toBe(201);
    expect(created.body.metadata).toEqual({ replyTo: { messageId: original.id } });

    const outbox = await GET(app, "/api/messages/outbox");
    const sentReply = outbox.body.messages.find((msg: { id: string }) => msg.id === created.body.id);
    expect(sentReply?.metadata).toEqual({ replyTo: { messageId: original.id } });
  });

  it("GET /api/messages/:id returns a message and 404 when missing", async () => {
    const msg = messageStore.sendMessage({
      fromId: "agent-3",
      fromType: "agent",
      toId: "dashboard",
      toType: "user",
      content: "Lookup me",
      type: "agent-to-user",
    });

    const found = await GET(app, `/api/messages/${msg.id}`);
    const missing = await GET(app, "/api/messages/msg-missing");

    expect(found.status).toBe(200);
    expect(found.body.id).toBe(msg.id);
    expect(missing.status).toBe(404);
  });

  it("POST /api/messages/:id/read marks the message as read", async () => {
    const msg = messageStore.sendMessage({
      fromId: "agent-4",
      fromType: "agent",
      toId: "dashboard",
      toType: "user",
      content: "Mark me as read",
      type: "agent-to-user",
    });

    const res = await REQUEST(app, "POST", `/api/messages/${msg.id}/read`);

    expect(res.status).toBe(200);
    expect(res.body.read).toBe(true);
    expect(messageStore.getMessage(msg.id)?.read).toBe(true);
  });

  it("DELETE /api/messages/:id deletes the message", async () => {
    const msg = messageStore.sendMessage({
      fromId: "agent-5",
      fromType: "agent",
      toId: "dashboard",
      toType: "user",
      content: "Delete me",
      type: "agent-to-user",
    });

    const res = await REQUEST(app, "DELETE", `/api/messages/${msg.id}`);

    expect(res.status).toBe(204);
    expect(messageStore.getMessage(msg.id)).toBeNull();
  });

  it("POST /api/messages/read-all marks all dashboard inbox messages as read", async () => {
    messageStore.sendMessage({
      fromId: "agent-1",
      fromType: "agent",
      toId: "dashboard",
      toType: "user",
      content: "1",
      type: "agent-to-user",
    });
    messageStore.sendMessage({
      fromId: "agent-2",
      fromType: "agent",
      toId: "dashboard",
      toType: "user",
      content: "2",
      type: "agent-to-user",
    });

    const res = await REQUEST(app, "POST", "/api/messages/read-all");
    const unread = await GET(app, "/api/messages/unread-count");

    expect(res.status).toBe(200);
    expect(res.body.markedAsRead).toBe(2);
    expect(unread.body.unreadCount).toBe(0);
  });

  it("GET /api/messages/conversation/:participantType/:participantId returns the conversation thread", async () => {
    const outbound = messageStore.sendMessage({
      fromId: "dashboard",
      fromType: "user",
      toId: "agent-convo",
      toType: "agent",
      content: "Question",
      type: "user-to-agent",
    });
    const inbound = messageStore.sendMessage({
      fromId: "agent-convo",
      fromType: "agent",
      toId: "dashboard",
      toType: "user",
      content: "Answer",
      type: "agent-to-user",
    });
    messageStore.sendMessage({
      fromId: "agent-other",
      fromType: "agent",
      toId: "dashboard",
      toType: "user",
      content: "Other thread",
      type: "agent-to-user",
    });

    const res = await GET(app, "/api/messages/conversation/agent/agent-convo");

    expect(res.status).toBe(200);
    const ids = res.body.map((m: { id: string }) => m.id);
    expect(ids).toContain(outbound.id);
    expect(ids).toContain(inbound.id);
    expect(ids).toHaveLength(2);
  });

  it("GET /api/agents/:id/mailbox returns mailbox summary and inbox messages", async () => {
    const agentId = "agent-mailbox";
    const msg = messageStore.sendMessage({
      fromId: "dashboard",
      fromType: "user",
      toId: agentId,
      toType: "agent",
      content: "Ping",
      type: "user-to-agent",
    });

    const res = await GET(app, `/api/agents/${agentId}/mailbox`);

    expect(res.status).toBe(200);
    expect(res.body.ownerId).toBe(agentId);
    expect(res.body.ownerType).toBe("agent");
    expect(res.body.unreadCount).toBe(1);
    expect(res.body.messages).toHaveLength(1);
    expect(res.body.messages[0].id).toBe(msg.id);
  });
});

// Note: Project pause/resume route tests are in src/__tests__/project-pause-resume-routes.test.ts
// to avoid test isolation issues with vi.restoreAllMocks() from other tests in routes.test.ts

describe("Agent stale task-link sanitization", () => {
  let tempDir: string;
  let fusionDir: string;
  let agentId: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "kb-routes-agent-stale-"));
    fusionDir = join(tempDir, ".fusion");
    mkdirSync(fusionDir, { recursive: true });

    const { AgentStore } = await import("@fusion/core");
    const agentStore = new AgentStore({ rootDir: fusionDir });
    await agentStore.init();
    const agent = await agentStore.createAgent({
      name: "Test Agent",
      role: "executor",
    });
    agentId = agent.id;
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function buildAgentApp() {
    const store = createMockStore({
      getFusionDir: vi.fn().mockReturnValue(fusionDir),
    } as any);
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store));
    return app;
  }

  it("GET /api/agents omits taskId when linked task is done", async () => {
    const doneTaskId = "FN-DONE";
    const store = createMockStore({
      getFusionDir: vi.fn().mockReturnValue(fusionDir),
      getTask: vi.fn().mockResolvedValue({
        id: doneTaskId,
        column: "done",
        description: "Completed task",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        prompt: "# Done\n\nDone task",
      }),
    } as any);

    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store));

    // Assign done task to agent
    const { AgentStore } = await import("@fusion/core");
    const agentStore = new AgentStore({ rootDir: fusionDir });
    await agentStore.init();
    await agentStore.assignTask(agentId, doneTaskId);

    const res = await GET(app, "/api/agents");

    expect(res.status).toBe(200);
    const agents = Array.isArray(res.body) ? res.body : [res.body];
    const testAgent = agents.find((a: { id: string }) => a.id === agentId);
    expect(testAgent).toBeDefined();
    expect(testAgent).not.toHaveProperty("taskId");
  });

  it("GET /api/agents omits taskId when linked task is archived", async () => {
    const archivedTaskId = "FN-ARCHIVED";
    const store = createMockStore({
      getFusionDir: vi.fn().mockReturnValue(fusionDir),
      getTask: vi.fn().mockResolvedValue({
        id: archivedTaskId,
        column: "archived",
        description: "Archived task",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        prompt: "# Archived\n\nArchived task",
      }),
    } as any);

    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store));

    // Assign archived task to agent
    const { AgentStore } = await import("@fusion/core");
    const agentStore = new AgentStore({ rootDir: fusionDir });
    await agentStore.init();
    await agentStore.assignTask(agentId, archivedTaskId);

    const res = await GET(app, "/api/agents");

    expect(res.status).toBe(200);
    const agents = Array.isArray(res.body) ? res.body : [res.body];
    const testAgent = agents.find((a: { id: string }) => a.id === agentId);
    expect(testAgent).toBeDefined();
    expect(testAgent).not.toHaveProperty("taskId");
  });

  it("GET /api/agents preserves taskId for non-terminal linked tasks", async () => {
    const activeTaskId = "FN-ACTIVE";
    const store = createMockStore({
      getFusionDir: vi.fn().mockReturnValue(fusionDir),
      getTask: vi.fn().mockResolvedValue({
        id: activeTaskId,
        column: "in-progress",
        description: "Active task",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        prompt: "# Active\n\nActive task",
      }),
    } as any);

    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store));

    // Assign active task to agent
    const { AgentStore } = await import("@fusion/core");
    const agentStore = new AgentStore({ rootDir: fusionDir });
    await agentStore.init();
    await agentStore.assignTask(agentId, activeTaskId);

    const res = await GET(app, "/api/agents");

    expect(res.status).toBe(200);
    const agents = Array.isArray(res.body) ? res.body : [res.body];
    const testAgent = agents.find((a: { id: string }) => a.id === agentId);
    expect(testAgent).toBeDefined();
    expect(testAgent.taskId).toBe(activeTaskId);
  });

  it("GET /api/agents/:id omits taskId when linked task is done", async () => {
    const doneTaskId = "FN-DONE-DETAIL";
    const store = createMockStore({
      getFusionDir: vi.fn().mockReturnValue(fusionDir),
      getTask: vi.fn().mockResolvedValue({
        id: doneTaskId,
        column: "done",
        description: "Done task",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        prompt: "# Done\n\nDone task",
      }),
    } as any);

    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store));

    // Assign done task to agent
    const { AgentStore } = await import("@fusion/core");
    const agentStore = new AgentStore({ rootDir: fusionDir });
    await agentStore.init();
    await agentStore.assignTask(agentId, doneTaskId);

    const res = await GET(app, `/api/agents/${agentId}`);

    expect(res.status).toBe(200);
    expect(res.body).toBeDefined();
    expect(res.body.id).toBe(agentId);
    expect(res.body).not.toHaveProperty("taskId");
  });

  it("GET /api/agents/:id omits taskId when linked task is archived", async () => {
    const archivedTaskId = "FN-ARCHIVED-DETAIL";
    const store = createMockStore({
      getFusionDir: vi.fn().mockReturnValue(fusionDir),
      getTask: vi.fn().mockResolvedValue({
        id: archivedTaskId,
        column: "archived",
        description: "Archived task",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        prompt: "# Archived\n\nArchived task",
      }),
    } as any);

    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store));

    // Assign archived task to agent
    const { AgentStore } = await import("@fusion/core");
    const agentStore = new AgentStore({ rootDir: fusionDir });
    await agentStore.init();
    await agentStore.assignTask(agentId, archivedTaskId);

    const res = await GET(app, `/api/agents/${agentId}`);

    expect(res.status).toBe(200);
    expect(res.body).toBeDefined();
    expect(res.body.id).toBe(agentId);
    expect(res.body).not.toHaveProperty("taskId");
  });

  it("GET /api/agents/:id preserves taskId for in-review linked tasks", async () => {
    const inReviewTaskId = "FN-IN-REVIEW";
    const store = createMockStore({
      getFusionDir: vi.fn().mockReturnValue(fusionDir),
      getTask: vi.fn().mockResolvedValue({
        id: inReviewTaskId,
        column: "in-review",
        description: "In review task",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        prompt: "# In Review\n\nIn review task",
      }),
    } as any);

    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store));

    // Assign in-review task to agent
    const { AgentStore } = await import("@fusion/core");
    const agentStore = new AgentStore({ rootDir: fusionDir });
    await agentStore.init();
    await agentStore.assignTask(agentId, inReviewTaskId);

    const res = await GET(app, `/api/agents/${agentId}`);

    expect(res.status).toBe(200);
    expect(res.body).toBeDefined();
    expect(res.body.id).toBe(agentId);
    expect(res.body.taskId).toBe(inReviewTaskId);
  });

  it("GET /api/agents/stats excludes terminal task links from assignedTaskCount", async () => {
    const doneTaskId = "FN-STATS-DONE";
    const activeTaskId = "FN-STATS-ACTIVE";

    const store = createMockStore({
      getFusionDir: vi.fn().mockReturnValue(fusionDir),
      getTask: vi.fn().mockImplementation(async (taskId: string) => {
        if (taskId === doneTaskId) {
          return {
            id: doneTaskId,
            column: "done",
            description: "Done task",
            dependencies: [],
            steps: [],
            currentStep: 0,
            log: [],
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            prompt: "# Done\n\nDone task",
          };
        }
        if (taskId === activeTaskId) {
          return {
            id: activeTaskId,
            column: "in-progress",
            description: "Active task",
            dependencies: [],
            steps: [],
            currentStep: 0,
            log: [],
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            prompt: "# Active\n\nActive task",
          };
        }
        return null;
      }),
    } as any);

    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store));

    // Create two agents: one with done task, one with active task
    const { AgentStore } = await import("@fusion/core");
    const agentStore = new AgentStore({ rootDir: fusionDir });
    await agentStore.init();

    const agent1 = await agentStore.createAgent({ name: "Agent 1", role: "executor" });
    const agent2 = await agentStore.createAgent({ name: "Agent 2", role: "executor" });

    await agentStore.assignTask(agent1.id, doneTaskId);
    await agentStore.assignTask(agent2.id, activeTaskId);

    const res = await GET(app, "/api/agents/stats");

    expect(res.status).toBe(200);
    // Only agent2 should count (active task), agent1 should be excluded (done task)
    expect(res.body.assignedTaskCount).toBe(1);
  });

  it("GET /api/agents/stats preserves taskId for agents with no linked task", async () => {
    const store = createMockStore({
      getFusionDir: vi.fn().mockReturnValue(fusionDir),
    } as any);

    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store));

    // Agent already created in beforeEach with no task assigned
    const res = await GET(app, "/api/agents/stats");

    expect(res.status).toBe(200);
    // Agent has no task, so assignedTaskCount should be 0
    expect(res.body.assignedTaskCount).toBe(0);
  });

  it("GET /api/agents handles task lookup failure gracefully", async () => {
    const taskId = "FN-LOOKUP-FAIL";
    const store = createMockStore({
      getFusionDir: vi.fn().mockReturnValue(fusionDir),
      getTask: vi.fn().mockRejectedValue(new Error("Database error")),
    } as any);

    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store));

    // Assign task to agent
    const { AgentStore } = await import("@fusion/core");
    const agentStore = new AgentStore({ rootDir: fusionDir });
    await agentStore.init();
    await agentStore.assignTask(agentId, taskId);

    // Should not throw, taskId should be preserved on lookup failure
    const res = await GET(app, "/api/agents");

    expect(res.status).toBe(200);
    const agents = Array.isArray(res.body) ? res.body : [res.body];
    const testAgent = agents.find((a: { id: string }) => a.id === agentId);
    expect(testAgent).toBeDefined();
    // On lookup failure, taskId should be preserved (treated as non-terminal)
    expect(testAgent.taskId).toBe(taskId);
  });
});

describe("GET /api/chat/sessions lookup=resume", () => {
  function makeSession(overrides: Partial<ChatSession> & Pick<ChatSession, "id" | "agentId">): ChatSession {
    const now = new Date().toISOString();
    return {
      id: overrides.id,
      agentId: overrides.agentId,
      title: overrides.title ?? null,
      status: overrides.status ?? "active",
      projectId: overrides.projectId ?? null,
      modelProvider: overrides.modelProvider ?? null,
      modelId: overrides.modelId ?? null,
      createdAt: overrides.createdAt ?? now,
      updatedAt: overrides.updatedAt ?? now,
    };
  }

  function buildChatApp(overrides?: {
    matchedSession?: ChatSession;
    lastMessage?: Pick<ChatMessage, "sessionId" | "content" | "createdAt">;
  }) {
    const store = createMockStore();
    const matchedSession = overrides?.matchedSession;
    const chatStore = {
      listSessions: vi.fn().mockReturnValue([]),
      findLatestActiveSessionForTarget: vi.fn().mockReturnValue(matchedSession),
      getLastMessageForSessions: vi.fn().mockImplementation((sessionIds: string[]) => {
        const map = new Map<string, ChatMessage>();
        if (overrides?.lastMessage && sessionIds.includes(overrides.lastMessage.sessionId)) {
          const now = new Date().toISOString();
          map.set(overrides.lastMessage.sessionId, {
            id: "msg-1",
            sessionId: overrides.lastMessage.sessionId,
            role: "assistant",
            content: overrides.lastMessage.content,
            thinkingOutput: null,
            metadata: null,
            createdAt: overrides.lastMessage.createdAt ?? now,
          });
        }
        return map;
      }),
    };

    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store, { chatStore } as any));

    return { app, chatStore };
  }

  it("returns only the targeted matched session when lookup=resume", async () => {
    const matchedSession = makeSession({
      id: "chat-match",
      agentId: "agent-1",
      projectId: "proj-1",
      modelProvider: "openai",
      modelId: "gpt-4o",
    });

    const { app, chatStore } = buildChatApp({
      matchedSession,
      lastMessage: {
        sessionId: matchedSession.id,
        content: "Most recent assistant reply",
        createdAt: new Date().toISOString(),
      },
    });

    const res = await GET(
      app,
      "/api/chat/sessions?lookup=resume&projectId=proj-1&agentId=agent-1&modelProvider=openai&modelId=gpt-4o",
    );

    expect(res.status).toBe(200);
    expect(chatStore.findLatestActiveSessionForTarget).toHaveBeenCalledWith({
      projectId: "proj-1",
      agentId: "agent-1",
      modelProvider: "openai",
      modelId: "gpt-4o",
    });
    expect(chatStore.listSessions).not.toHaveBeenCalled();
    expect(res.body.sessions).toHaveLength(1);
    expect(res.body.sessions[0].id).toBe("chat-match");
    expect(res.body.sessions[0].lastMessagePreview).toBe("Most recent assistant reply");
  });

  it("returns 400 when modelProvider/modelId are not both provided", async () => {
    const { app } = buildChatApp();

    const res = await GET(app, "/api/chat/sessions?lookup=resume&projectId=proj-1&agentId=agent-1&modelProvider=openai");

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Both modelProvider and modelId must be provided together");
  });

  it("returns 400 when lookup=resume is missing agentId", async () => {
    const { app } = buildChatApp();

    const res = await GET(app, "/api/chat/sessions?lookup=resume&projectId=proj-1");

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("agentId is required when lookup=resume");
  });

  it("preserves list behavior when lookup parameter is absent", async () => {
    const store = createMockStore();
    const listedSession = makeSession({ id: "chat-listed", agentId: "agent-1" });
    const chatStore = {
      listSessions: vi.fn().mockReturnValue([listedSession]),
      findLatestActiveSessionForTarget: vi.fn(),
      getLastMessageForSessions: vi.fn().mockReturnValue(new Map()),
    };

    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store, { chatStore } as any));

    const res = await GET(app, "/api/chat/sessions?status=active&agentId=agent-1");

    expect(res.status).toBe(200);
    expect(chatStore.listSessions).toHaveBeenCalledWith({ status: "active", agentId: "agent-1" });
    expect(chatStore.findLatestActiveSessionForTarget).not.toHaveBeenCalled();
    expect(res.body.sessions).toHaveLength(1);
    expect(res.body.sessions[0].id).toBe("chat-listed");
  });
});

describe("remote access auth login-url endpoints", () => {
  let store: TaskStore;

  const remoteAccessSettings = {
    enabled: true,
    activeProvider: "cloudflare",
    providers: {
      tailscale: {
        enabled: false,
        hostname: "tail.example.ts.net",
        targetPort: 4040,
        acceptRoutes: false,
      },
      cloudflare: {
        enabled: true,
        quickTunnel: false,
        tunnelName: "tunnel",
        tunnelToken: "cf-secret",
        ingressUrl: "https://remote.example.com",
      },
    },
    tokenStrategy: {
      persistent: {
        enabled: true,
        token: null,
      },
      shortLived: {
        enabled: true,
        ttlMs: 120000,
        maxTtlMs: 86400000,
      },
    },
    lifecycle: {
      rememberLastRunning: false,
      wasRunningOnShutdown: false,
      lastRunningProvider: null,
    },
  };

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store));
    return app;
  }

  beforeEach(() => {
    store = createMockStore();
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      remoteAccess: remoteAccessSettings,
    });
  });

  it("creates persistent login URL payload and persists generated fallback token", async () => {
    (store.updateSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      remoteAccess: {
        ...remoteAccessSettings,
        tokenStrategy: {
          ...remoteAccessSettings.tokenStrategy,
          persistent: {
            ...remoteAccessSettings.tokenStrategy.persistent,
            token: "frt_generated_persistent",
          },
        },
      },
    });

    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/remote-access/auth/login-url",
      JSON.stringify({ mode: "persistent" }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(200);
    expect(res.body.tokenType).toBe("persistent");
    const persistentLoginUrl = new URL(String(res.body.loginUrl));
    expect(persistentLoginUrl.protocol).toBe("https:");
    expect(persistentLoginUrl.host).toBe("remote.example.com");
    expect(persistentLoginUrl.pathname).toBe("/remote-login");
    expect(persistentLoginUrl.searchParams.get("rt")).toMatch(/^frt_[A-Za-z0-9_-]+$/);
    expect(res.body.expiresAt).toBeUndefined();
    expect(store.updateGlobalSettings).toHaveBeenCalledWith(expect.objectContaining({
      remoteAccess: expect.objectContaining({
        tokenStrategy: expect.objectContaining({
          persistent: expect.objectContaining({
            token: expect.any(String),
          }),
        }),
      }),
    }));
  });

  it("creates short-lived login URL payload with expiresAt", async () => {
    const withPersistentToken = {
      ...remoteAccessSettings,
      tokenStrategy: {
        ...remoteAccessSettings.tokenStrategy,
        persistent: {
          ...remoteAccessSettings.tokenStrategy.persistent,
          token: "frt_persistent",
        },
      },
    };
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      remoteAccess: withPersistentToken,
    });

    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/remote-access/auth/login-url",
      JSON.stringify({ mode: "short-lived" }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(200);
    expect(res.body.tokenType).toBe("short-lived");
    expect(res.body.expiresAt).toEqual(expect.any(String));
    const shortLivedUrl = new URL(String(res.body.loginUrl));
    expect(shortLivedUrl.protocol).toBe("https:");
    expect(shortLivedUrl.host).toBe("remote.example.com");
    expect(shortLivedUrl.pathname).toBe("/remote-login");
    expect(shortLivedUrl.searchParams.get("rt")).toMatch(/^frt_[A-Za-z0-9_-]+$/);
    expect(Date.parse(String(res.body.expiresAt))).not.toBeNaN();
    expect(JSON.stringify(res.body)).not.toContain("cf-secret");
    expect(JSON.stringify(res.body)).not.toContain("frt_persistent");
  });

  it("rejects invalid login-url mode", async () => {
    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/remote-access/auth/login-url",
      JSON.stringify({ mode: "legacy" }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("mode must be");
    expect(res.body.details).toEqual({ code: "INVALID_REMOTE_AUTH_MODE" });
  });
});
