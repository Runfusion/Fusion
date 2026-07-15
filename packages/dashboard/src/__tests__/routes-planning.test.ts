// @vitest-environment node

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from "vitest";
import express from "express";
import http from "node:http";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
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
import {
  PLANNING_DEEPEN_CHECKPOINT_ID,
  PLANNING_DEEPEN_CHECKPOINT_QUESTION,
  PLANNING_DEEPEN_PROCEED_OPTION_ID,
} from "@fusion/core";
import type { TaskStore, TaskAttachment, Routine, RoutineCreateInput, RoutineUpdateInput, RoutineExecutionResult, ChatSession, ChatMessage } from "@fusion/core";
import type { TaskDetail } from "@fusion/core";
import type { AuthStorageLike, ModelRegistryLike } from "../routes.js";
import { __resetBatchImportRateLimiter, __setCreateFnAgentForRefine } from "../routes.js";
import * as agentGenerationModule from "../agent-generation.js";
import {
  __resetPlanningState,
  __setCreateFnAgent,
  planningStreamManager,
  rehydrateFromStore,
  setAiSessionStore,
} from "../planning.js";
import * as planningModule from "../planning.js";
import { __resetSubtaskBreakdownState, subtaskStreamManager } from "../subtask-breakdown.js";
import * as subtaskBreakdownModule from "../subtask-breakdown.js";
import { AiSessionStore, SESSION_CLEANUP_DEFAULT_MAX_AGE_MS, type AiSessionRow } from "../ai-session-store.js";
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
  const branchGroups = new Map<string, {
    id: string;
    sourceType: "planning" | "mission" | "new-task";
    sourceId: string;
    branchName: string;
    autoMerge: boolean;
    prState: "none";
    status: "open";
    createdAt: number;
    updatedAt: number;
  }>();

  return {
    // FNXC:PostgresCutover 2026-07-05-16:50: routes borrow the AsyncDataLayer
    // from the scoped store; null = legacy mode for this mock.
    getAsyncLayer: vi.fn().mockReturnValue(null),
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
    getSettings: vi.fn().mockResolvedValue({ autoMerge: false, defaultBranch: "main" }),
    getSettingsFast: vi.fn().mockResolvedValue({ autoMerge: false, defaultBranch: "main" }),
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
    ensureBranchGroupForSource: vi.fn(function (this: TaskStore, sourceType: "planning" | "mission" | "new-task", sourceId: string, init: { branchName: string; autoMerge?: boolean }) {
      const existing = this.getBranchGroupBySource(sourceType, sourceId);
      if (existing) {
        return existing;
      }
      const created = {
        id: `BG-${sourceType}-${sourceId}`,
        sourceType,
        sourceId,
        branchName: init.branchName,
        autoMerge: Boolean(init.autoMerge),
        prState: "none" as const,
        status: "open" as const,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      branchGroups.set(`${sourceType}:${sourceId}`, created);
      return created;
    }),
    getBranchGroupBySource: vi.fn((sourceType: "planning" | "mission" | "new-task", sourceId: string) =>
      branchGroups.get(`${sourceType}:${sourceId}`) ?? null
    ),
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

class MockAiSessionStore extends EventEmitter {
  rows = new Map<string, AiSessionRow>();

  async upsert(row: AiSessionRow): Promise<void> {
    this.rows.set(row.id, row);
  }

  async updateThinking(id: string, thinkingOutput: string): Promise<void> {
    const row = this.rows.get(id);
    if (!row) return;
    this.rows.set(id, { ...row, thinkingOutput, updatedAt: new Date().toISOString() });
  }

  async delete(id: string): Promise<void> {
    this.rows.delete(id);
    this.emit("ai_session:deleted", id);
  }

  async get(id: string): Promise<AiSessionRow | null> {
    return this.rows.get(id) ?? null;
  }

  async listRecoverable(): Promise<AiSessionRow[]> {
    return [...this.rows.values()].filter(
      (row) => row.status === "awaiting_input" || row.status === "generating" || row.status === "error",
    );
  }

  on(event: "ai_session:deleted", listener: (sessionId: string) => void): this {
    return super.on(event, listener);
  }

  off(event: "ai_session:deleted", listener: (sessionId: string) => void): this {
    return super.off(event, listener);
  }
}

function buildPlanningRow(
  overrides: Partial<AiSessionRow> & Pick<AiSessionRow, "id" | "status">,
): AiSessionRow {
  const now = new Date().toISOString();
  return {
    id: overrides.id,
    type: "planning",
    status: overrides.status,
    title: overrides.title ?? "Recovered planning session",
    inputPayload:
      overrides.inputPayload
      ?? JSON.stringify({ ip: "127.0.0.1", initialPlan: "Recovered planning session" }),
    conversationHistory:
      overrides.conversationHistory
      ?? JSON.stringify([
        {
          question: {
            id: "q-existing",
            type: "text",
            question: "What should we build?",
            description: "baseline",
          },
          response: { "q-existing": "A useful feature" },
        },
      ]),
    currentQuestion:
      overrides.currentQuestion
      ?? JSON.stringify({
        id: "q-next",
        type: "text",
        question: "Any constraints?",
        description: "detail",
      }),
    result: overrides.result ?? null,
    thinkingOutput: overrides.thinkingOutput ?? "thinking",
    error: overrides.error ?? null,
    projectId: overrides.projectId ?? null,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
  };
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


describe("Planning Mode Routes", () => {
    let store: TaskStore;

    function buildApp() {
      const app = express();
      app.use(express.json());
      app.use("/api", createApiRoutes(store));
      return app;
    }

    async function createCompletedPlanningSession(initialPlan = "Build a user auth system"): Promise<string> {
      const startRes = await REQUEST(
        buildApp(),
        "POST",
        "/api/planning/start",
        JSON.stringify({ initialPlan }),
        { "Content-Type": "application/json" }
      );
      const sessionId = startRes.body.sessionId;

      await REQUEST(buildApp(), "POST", "/api/planning/respond", JSON.stringify({ sessionId, responses: { scope: "medium" } }), { "Content-Type": "application/json" });
      await REQUEST(buildApp(), "POST", "/api/planning/respond", JSON.stringify({ sessionId, responses: { requirements: "Must have login" } }), { "Content-Type": "application/json" });
      await REQUEST(buildApp(), "POST", "/api/planning/respond", JSON.stringify({ sessionId, responses: { confirm: true } }), { "Content-Type": "application/json" });
      await REQUEST(buildApp(), "POST", "/api/planning/respond", JSON.stringify({
        sessionId,
        responses: { [PLANNING_DEEPEN_CHECKPOINT_ID]: [PLANNING_DEEPEN_PROCEED_OPTION_ID] },
      }), { "Content-Type": "application/json" });

      return sessionId;
    }

    async function connectPlanningStreamUntilComplete(sessionId: string): Promise<void> {
      const streamPromise = REQUEST(buildApp(), "GET", `/api/planning/${sessionId}/stream`);
      setTimeout(() => {
        planningStreamManager.broadcast(sessionId, { type: "complete" });
      }, 0);
      await streamPromise;
    }

    /** Mock agent for planning session tests */
    function setupPlanningMockAgent() {
      const questionResponses = [
        JSON.stringify({
          type: "question",
          data: {
            id: "q-scope",
            type: "single_select",
            question: "What is the scope of this plan?",
            description: "This helps estimate the size and complexity of the task.",
            options: [
              { id: "small", label: "Small", description: "Quick" },
              { id: "medium", label: "Medium", description: "Standard" },
              { id: "large", label: "Large", description: "Complex" },
            ],
          },
        }),
        JSON.stringify({
          type: "question",
          data: {
            id: "q-requirements",
            type: "text",
            question: "What are the key requirements?",
            description: "List acceptance criteria.",
          },
        }),
        JSON.stringify({
          type: "question",
          data: {
            id: "q-confirm",
            type: "confirm",
            question: "Are there specific technologies to use?",
            description: "Answer yes if you have preferences.",
          },
        }),
        JSON.stringify({
          type: "complete",
          data: {
            title: "Build a user auth system",
            description: "Build a user authentication system\n\nRequirements: Standard implementation\n\nGenerated via Planning Mode",
            suggestedSize: "M",
            suggestedDependencies: [],
            keyDeliverables: ["Implementation", "Tests", "Documentation"],
          },
        }),
      ];

      const messages: Array<{ role: string; content: string }> = [];
      let callIndex = 0;
      const mockAgent = {
        session: {
          state: { messages },
          prompt: vi.fn(async (msg: string) => {
            messages.push({ role: "user", content: msg });
            const response = questionResponses[callIndex++] ?? questionResponses[questionResponses.length - 1];
            messages.push({ role: "assistant", content: response });
          }),
          dispose: vi.fn(),
        },
      };
      __setCreateFnAgent(async () => mockAgent);
    }

    async function rehydratePlanningSessionRow(row: AiSessionRow): Promise<string> {
      const mockStore = new MockAiSessionStore();
      await mockStore.upsert(row);
      setAiSessionStore(mockStore as unknown as Parameters<typeof setAiSessionStore>[0]);
      const recoveredCount = await rehydrateFromStore(mockStore as unknown as Parameters<typeof rehydrateFromStore>[0]);
      expect(recoveredCount).toBe(1);
      return row.id;
    }

    beforeEach(() => {
      // Reset planning state before each test to avoid cross-test contamination
      store = createMockStore();
      __resetPlanningState();
      setupPlanningMockAgent();
    });

    afterEach(() => {
      __setCreateFnAgent(undefined as any);
    });

    describe("POST /planning/start", () => {
      it("creates a new planning session", async () => {
        const res = await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/start",
          JSON.stringify({ initialPlan: "Build a user auth system" }),
          { "Content-Type": "application/json" }
        );

        expect(res.status).toBe(201);
        expect(res.body.sessionId).toBeDefined();
        expect(typeof res.body.sessionId).toBe("string");
        expect(res.body.firstQuestion).toBeDefined();
        expect(res.body.firstQuestion.id).toBe("q-scope");
        expect(res.body.firstQuestion.type).toBe("single_select");
      });

      it("requires initialPlan in body", async () => {
        const res = await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/start",
          JSON.stringify({}),
          { "Content-Type": "application/json" }
        );

        expect(res.status).toBe(400);
        expect(res.body.error).toContain("initialPlan is required");
      });

      it("accepts long initialPlan (no character limit)", async () => {
        // Test that the server accepts long initialPlan values (removed 500-char limit)
        const longPlan = "a".repeat(2000);
        const res = await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/start",
          JSON.stringify({ initialPlan: longPlan }),
          { "Content-Type": "application/json" }
        );

        expect(res.status).toBe(201);
        expect(res.body.sessionId).toBeDefined();
      });

      it("returns an API error instead of terminating when the first AI response is unparsable", async () => {
        const messages: Array<{ role: string; content: string }> = [];
        const dispose = vi.fn();
        __setCreateFnAgent(async () => ({
          session: {
            state: { messages },
            prompt: vi.fn(async (msg: string) => {
              messages.push({ role: "user", content: msg });
              messages.push({ role: "assistant", content: "" });
            }),
            dispose,
          },
        }));
        const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
          throw new Error("process.exit should not be called");
        }) as never);

        try {
          const res = await REQUEST(
            buildApp(),
            "POST",
            "/api/planning/start",
            JSON.stringify({ initialPlan: "Investigate dashboard crash" }),
            { "Content-Type": "application/json" },
          );

          expect(res.status).toBe(500);
          expect(res.body.error).toContain("Failed to get first question from AI");
          expect(exitSpy).not.toHaveBeenCalled();
          expect(dispose).toHaveBeenCalledTimes(1);
        } finally {
          exitSpy.mockRestore();
        }
      });

      it("enforces rate limiting (1000 sessions per hour per IP)", async () => {
        // Seed the in-memory limiter directly so this boundary test still proves
        // the 1000th HTTP request is accepted and the 1001st is rejected without
        // spending seconds creating 999 duplicate full planning sessions.
        const candidateIps = ["::ffff:127.0.0.1", "127.0.0.1", "unknown"];
        for (const ip of candidateIps) {
          for (let i = 0; i < 999; i += 1) {
            expect(planningModule.checkRateLimit(ip)).toBe(true);
          }
        }

        const allowed = await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/start",
          JSON.stringify({ initialPlan: "Plan 1000" }),
          { "Content-Type": "application/json" }
        );
        expect(allowed.status).toBe(201);

        const res = await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/start",
          JSON.stringify({ initialPlan: "Plan 1001" }),
          { "Content-Type": "application/json" }
        );

        expect(res.status).toBe(429);
        expect(res.body.error).toContain("Rate limit exceeded");
      });
    });

    describe("POST /planning/start-streaming", () => {
      it("rejects invalid planning depth", async () => {
        const res = await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/start-streaming",
          JSON.stringify({
            initialPlan: "Build a user auth system",
            planningDepth: "extra-large",
          }),
          { "Content-Type": "application/json" },
        );

        expect(res.status).toBe(400);
        expect(res.body.error).toContain("planningDepth");
      });

      it("rejects out-of-range custom question count", async () => {
        const res = await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/start-streaming",
          JSON.stringify({
            initialPlan: "Build a user auth system",
            customQuestionCount: 21,
          }),
          { "Content-Type": "application/json" },
        );

        expect(res.status).toBe(400);
        expect(res.body.error).toContain("customQuestionCount");
      });

      it("rejects invalid thinkingLevel", async () => {
        const res = await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/start-streaming",
          JSON.stringify({ initialPlan: "Build a user auth system", thinkingLevel: "maximum" }),
          { "Content-Type": "application/json" },
        );

        expect(res.status).toBe(400);
        expect(res.body.error).toContain("thinkingLevel");
      });

      it("accepts optional model params and thinkingLevel in request body", async () => {
        const messages: Array<{ role: string; content: string }> = [];
        const mockAgent = {
          session: {
            state: { messages },
            prompt: vi.fn(async (msg: string) => {
              messages.push({ role: "user", content: msg });
              messages.push({
                role: "assistant",
                content: JSON.stringify({
                  type: "question",
                  data: {
                    id: "q-scope",
                    type: "text",
                    question: "What should we plan first?",
                  },
                }),
              });
            }),
            dispose: vi.fn(),
          },
        };

        const createFnAgentSpy = vi.fn(async () => mockAgent);
        __setCreateFnAgent(createFnAgentSpy as any);

        const res = await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/start-streaming",
          JSON.stringify({
            initialPlan: "Build a user auth system",
            planningModelProvider: "google",
            planningModelId: "gemini-2.5-pro",
            thinkingLevel: "high",
          }),
          { "Content-Type": "application/json" },
        );

        expect(res.status).toBe(201);
        expect(res.body.sessionId).toBeDefined();
        await connectPlanningStreamUntilComplete(res.body.sessionId);

        await vi.waitFor(() => {
          expect(createFnAgentSpy).toHaveBeenCalledWith(
            expect.objectContaining({
              defaultProvider: "google",
              defaultModelId: "gemini-2.5-pro",
              defaultThinkingLevel: "high",
            }),
          );
        });
      });

      // ── Lane Precedence Regression Tests ────────────────────────────────────────
      // Tests for FN-1730: ensure model resolution follows the documented hierarchy:
      // 1. Request body planningModelProvider + planningModelId (explicit override)
      // 2. Project settings planningProvider + planningModelId (project lane)
      // 3. Global settings planningGlobalProvider + planningGlobalModelId (global lane)
      // 4. Default settings defaultProvider + defaultModelId (default fallback)
      // 5. No explicit model (automatic resolution)

      it("uses request body model override when both provider and modelId provided", async () => {
        const mockAgent = {
          session: {
            state: { messages: [] },
            prompt: vi.fn(),
            dispose: vi.fn(),
          },
        };
        const createFnAgentSpy = vi.fn(async () => mockAgent);
        __setCreateFnAgent(createFnAgentSpy as any);

        const res = await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/start-streaming",
          JSON.stringify({
            initialPlan: "Test plan",
            planningModelProvider: "google",
            planningModelId: "gemini-2.5-pro",
          }),
          { "Content-Type": "application/json" },
        );

        expect(res.status).toBe(201);
        await connectPlanningStreamUntilComplete(res.body.sessionId);
        await vi.waitFor(() => {
          expect(createFnAgentSpy).toHaveBeenCalledWith(
            expect.objectContaining({
              defaultProvider: "google",
              defaultModelId: "gemini-2.5-pro",
            }),
          );
        });
      });

      it("falls back to project planning lane when no request override", async () => {
        const mockAgent = {
          session: {
            state: { messages: [] },
            prompt: vi.fn(),
            dispose: vi.fn(),
          },
        };
        const createFnAgentSpy = vi.fn(async () => mockAgent);
        __setCreateFnAgent(createFnAgentSpy as any);

        // Mock project settings with planningProvider + planningModelId
        (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
          planningProvider: "anthropic",
          planningModelId: "claude-sonnet-4-5",
        });

        const res = await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/start-streaming",
          JSON.stringify({ initialPlan: "Test plan" }),
          { "Content-Type": "application/json" },
        );

        expect(res.status).toBe(201);
        await connectPlanningStreamUntilComplete(res.body.sessionId);
        await vi.waitFor(() => {
          expect(createFnAgentSpy).toHaveBeenCalledWith(
            expect.objectContaining({
              defaultProvider: "anthropic",
              defaultModelId: "claude-sonnet-4-5",
            }),
          );
        });
      });

      it("falls back to global planning lane when project lane unset", async () => {
        const mockAgent = {
          session: {
            state: { messages: [] },
            prompt: vi.fn(),
            dispose: vi.fn(),
          },
        };
        const createFnAgentSpy = vi.fn(async () => mockAgent);
        __setCreateFnAgent(createFnAgentSpy as any);

        // Mock project settings with planningGlobalProvider + planningGlobalModelId (no project lane)
        (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
          planningGlobalProvider: "openai",
          planningGlobalModelId: "gpt-4o",
        });

        const res = await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/start-streaming",
          JSON.stringify({ initialPlan: "Test plan" }),
          { "Content-Type": "application/json" },
        );

        expect(res.status).toBe(201);
        await connectPlanningStreamUntilComplete(res.body.sessionId);
        await vi.waitFor(() => {
          expect(createFnAgentSpy).toHaveBeenCalledWith(
            expect.objectContaining({
              defaultProvider: "openai",
              defaultModelId: "gpt-4o",
            }),
          );
        });
      });

      it("falls back to default lane when all planning lanes unset", async () => {
        const mockAgent = {
          session: {
            state: { messages: [] },
            prompt: vi.fn(),
            dispose: vi.fn(),
          },
        };
        const createFnAgentSpy = vi.fn(async () => mockAgent);
        __setCreateFnAgent(createFnAgentSpy as any);

        // Mock project settings with only defaultProvider + defaultModelId
        (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
          defaultProvider: "mistral",
          defaultModelId: "mistral-large",
        });

        const res = await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/start-streaming",
          JSON.stringify({ initialPlan: "Test plan" }),
          { "Content-Type": "application/json" },
        );

        expect(res.status).toBe(201);
        await connectPlanningStreamUntilComplete(res.body.sessionId);
        await vi.waitFor(() => {
          expect(createFnAgentSpy).toHaveBeenCalledWith(
            expect.objectContaining({
              defaultProvider: "mistral",
              defaultModelId: "mistral-large",
            }),
          );
        });
      });

      it("passes no model when all lanes unset (automatic resolution)", async () => {
        const mockAgent = {
          session: {
            state: { messages: [] },
            prompt: vi.fn(),
            dispose: vi.fn(),
          },
        };
        const createFnAgentSpy = vi.fn(async () => mockAgent);
        __setCreateFnAgent(createFnAgentSpy as any);

        // Mock project settings with no model configuration
        (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({});

        const res = await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/start-streaming",
          JSON.stringify({ initialPlan: "Test plan" }),
          { "Content-Type": "application/json" },
        );

        expect(res.status).toBe(201);
        await connectPlanningStreamUntilComplete(res.body.sessionId);
        await vi.waitFor(() => {
          // No explicit defaultProvider/defaultModelId means automatic resolution
          expect(createFnAgentSpy).toHaveBeenCalledWith(
            expect.not.objectContaining({
              defaultProvider: expect.anything(),
              defaultModelId: expect.anything(),
            }),
          );
        });
      });

      it("rejects partial request override (provider only, no modelId)", async () => {
        const res = await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/start-streaming",
          JSON.stringify({
            initialPlan: "Test plan",
            planningModelProvider: "google",
            // missing planningModelId
          }),
          { "Content-Type": "application/json" },
        );

        // Partial overrides should be treated as no override
        // The route validates individual fields, not pair consistency
        // Request override is ignored when modelId is missing
        expect(res.status).toBe(201);
      });

      it("ignores partial project lane (provider only, no modelId)", async () => {
        const mockAgent = {
          session: {
            state: { messages: [] },
            prompt: vi.fn(),
            dispose: vi.fn(),
          },
        };
        const createFnAgentSpy = vi.fn(async () => mockAgent);
        __setCreateFnAgent(createFnAgentSpy as any);

        // Mock project settings with partial provider (no modelId)
        (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
          planningProvider: "anthropic",
          // missing planningModelId
        });

        const res = await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/start-streaming",
          JSON.stringify({ initialPlan: "Test plan" }),
          { "Content-Type": "application/json" },
        );

        expect(res.status).toBe(201);
        await connectPlanningStreamUntilComplete(res.body.sessionId);
        // Partial project lane should be ignored, falls through to next tier
        await vi.waitFor(() => {
          // Should NOT use the partial provider
          expect(createFnAgentSpy).toHaveBeenCalledWith(
            expect.not.objectContaining({
              defaultProvider: "anthropic",
            }),
          );
        });
      });
    });

    describe("GET /planning/:sessionId/stream", () => {
      function setupStreamingPlanningAgent() {
        const promptCalls: string[] = [];
        const messages: Array<{ role: string; content: string }> = [];
        const createFnAgentSpy = vi.fn(async (options?: { onThinking?: (delta: string) => void }) => ({
          session: {
            state: { messages },
            prompt: vi.fn(async (message: string) => {
              promptCalls.push(message);
              await new Promise<void>((resolve) => {
                setTimeout(() => {
                  options?.onThinking?.("live first-turn reasoning");
                  messages.push({ role: "user", content: message });
                  messages.push({
                    role: "assistant",
                    content: JSON.stringify({
                      type: "question",
                      data: {
                        id: "q-live-first-turn",
                        type: "text",
                        question: "What should the plan prioritize first?",
                      },
                    }),
                  });
                  resolve();
                }, 1);
              });
            }),
            dispose: vi.fn(),
          },
        }));

        __setCreateFnAgent(createFnAgentSpy as any);
        return { createFnAgentSpy, promptCalls };
      }

      it("replays buffered events when Last-Event-ID header is provided", async () => {
        const startRes = await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/start",
          JSON.stringify({ initialPlan: "Reconnect planning stream" }),
          { "Content-Type": "application/json" },
        );

        const sessionId = startRes.body.sessionId as string;

        planningStreamManager.broadcast(sessionId, { type: "thinking", data: "first" });
        planningStreamManager.broadcast(sessionId, { type: "thinking", data: "second" });

        setTimeout(() => {
          planningStreamManager.broadcast(sessionId, { type: "complete" });
        }, 0);

        const streamRes = await REQUEST(
          buildApp(),
          "GET",
          `/api/planning/${sessionId}/stream`,
          undefined,
          { "Last-Event-ID": "1" },
        );

        expect(streamRes.status).toBe(200);
        expect(typeof streamRes.body).toBe("string");
        expect(streamRes.body).toContain("id: 2");
        expect(streamRes.body).toContain("event: thinking");
        expect(streamRes.body).toContain("id: 3");
        expect(streamRes.body).toContain("event: complete");
        expect(streamRes.body).not.toContain("id: 1\nevent: thinking");
      });

      it("replays buffered thinking when Last-Event-ID is missing", async () => {
        const startRes = await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/start",
          JSON.stringify({ initialPlan: "No replay planning stream" }),
          { "Content-Type": "application/json" },
        );

        const sessionId = startRes.body.sessionId as string;

        planningStreamManager.broadcast(sessionId, { type: "thinking", data: "first" });

        setTimeout(() => {
          planningStreamManager.broadcast(sessionId, { type: "complete" });
        }, 0);

        const streamRes = await REQUEST(buildApp(), "GET", `/api/planning/${sessionId}/stream`);

        expect(streamRes.status).toBe(200);
        expect(streamRes.body).toContain("id: 1\nevent: thinking");
        expect(streamRes.body).toContain("id: 2");
        expect(streamRes.body).toContain("event: complete");
      });

      it("defers the first streamed turn until SSE connect for new sessions", async () => {
        vi.useFakeTimers();
        try {
          const { promptCalls } = setupStreamingPlanningAgent();

          const startRes = await REQUEST(
            buildApp(),
            "POST",
            "/api/planning/start-streaming",
            JSON.stringify({ initialPlan: "Stream the first planning turn live" }),
            { "Content-Type": "application/json" },
          );

          expect(startRes.status).toBe(201);
          const sessionId = startRes.body.sessionId as string;
          expect(promptCalls).toHaveLength(0);
          expect(
            planningStreamManager.getBufferedEvents(sessionId, 0).filter((event) => event.event === "thinking"),
          ).toHaveLength(0);

          const streamPromise = REQUEST(buildApp(), "GET", `/api/planning/${sessionId}/stream`);
          await Promise.resolve();

          await vi.advanceTimersByTimeAsync(1);
          planningStreamManager.broadcast(sessionId, { type: "complete" });

          const streamRes = await streamPromise;
          expect(streamRes.status).toBe(200);
          expect(promptCalls).toHaveLength(1);
          expect(streamRes.body).toContain("event: thinking");
          expect(streamRes.body).toContain("live first-turn reasoning");
          expect(streamRes.body).toContain("event: question");
        } finally {
          vi.useRealTimers();
        }
      });

      it("defers the first streamed turn until SSE connect when starting an existing draft session", async () => {
        vi.useFakeTimers();
        try {
          const { promptCalls } = setupStreamingPlanningAgent();

          const draftRes = await REQUEST(
            buildApp(),
            "POST",
            "/api/planning/create-draft",
            JSON.stringify({ initialPlan: "Draft that will be started later" }),
            { "Content-Type": "application/json" },
          );

          expect(draftRes.status).toBe(201);
          const sessionId = draftRes.body.sessionId as string;

          const startPromise = REQUEST(
            buildApp(),
            "POST",
            "/api/planning/start-streaming",
            JSON.stringify({
              initialPlan: "Draft that will be started later",
              existingSessionId: sessionId,
            }),
            { "Content-Type": "application/json" },
          );

          await vi.advanceTimersByTimeAsync(1);
          const startRes = await startPromise;
          expect(startRes.status).toBe(201);
          expect(promptCalls).toHaveLength(0);
          expect(
            planningStreamManager.getBufferedEvents(sessionId, 0).filter((event) => event.event === "thinking"),
          ).toHaveLength(0);

          const streamPromise = REQUEST(buildApp(), "GET", `/api/planning/${sessionId}/stream`);
          await Promise.resolve();

          await vi.advanceTimersByTimeAsync(1);
          planningStreamManager.broadcast(sessionId, { type: "complete" });

          const streamRes = await streamPromise;
          expect(streamRes.status).toBe(200);
          expect(promptCalls).toHaveLength(1);
          expect(streamRes.body).toContain("event: thinking");
          expect(streamRes.body).toContain("live first-turn reasoning");
          expect(streamRes.body).toContain("event: question");
        } finally {
          vi.useRealTimers();
        }
      });

      it("starts the deferred first turn exactly once even with concurrent subscribers", async () => {
        vi.useFakeTimers();
        try {
          const { promptCalls } = setupStreamingPlanningAgent();

          const startRes = await REQUEST(
            buildApp(),
            "POST",
            "/api/planning/start-streaming",
            JSON.stringify({ initialPlan: "Only start the first turn once" }),
            { "Content-Type": "application/json" },
          );

          expect(startRes.status).toBe(201);
          const sessionId = startRes.body.sessionId as string;
          expect(promptCalls).toHaveLength(0);

          const firstStreamPromise = REQUEST(buildApp(), "GET", `/api/planning/${sessionId}/stream`);
          const secondStreamPromise = REQUEST(buildApp(), "GET", `/api/planning/${sessionId}/stream`);
          await Promise.resolve();

          await vi.advanceTimersByTimeAsync(1);
          planningStreamManager.broadcast(sessionId, { type: "complete" });

          const [firstStreamRes, secondStreamRes] = await Promise.all([firstStreamPromise, secondStreamPromise]);
          expect(promptCalls).toHaveLength(1);
          expect(firstStreamRes.status).toBe(200);
          expect(secondStreamRes.status).toBe(200);
          expect(firstStreamRes.body).toContain("live first-turn reasoning");
          expect(secondStreamRes.body).toContain("live first-turn reasoning");
        } finally {
          vi.useRealTimers();
        }
      });

      it("treats invalid Last-Event-ID values as first connect", async () => {
        const startRes = await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/start",
          JSON.stringify({ initialPlan: "Invalid last event id" }),
          { "Content-Type": "application/json" },
        );

        const sessionId = startRes.body.sessionId as string;

        planningStreamManager.broadcast(sessionId, { type: "thinking", data: "first" });

        setTimeout(() => {
          planningStreamManager.broadcast(sessionId, { type: "complete" });
        }, 0);

        const streamRes = await REQUEST(
          buildApp(),
          "GET",
          `/api/planning/${sessionId}/stream`,
          undefined,
          { "Last-Event-ID": "not-a-number" },
        );

        expect(streamRes.status).toBe(200);
        expect(streamRes.body).toContain("id: 1\nevent: thinking");
        expect(streamRes.body).toContain("id: 2");
        expect(streamRes.body).toContain("event: complete");
      });

      it("replays buffered thinking on first connect when session already has currentQuestion", async () => {
        const startRes = await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/start",
          JSON.stringify({ initialPlan: "Catch-up thinking before question" }),
          { "Content-Type": "application/json" },
        );
        const sessionId = startRes.body.sessionId as string;

        const { planningStreamManager, getSession } = await import("../planning.js");
        const session = await getSession(sessionId);
        expect(session).toBeDefined();

        planningStreamManager.broadcast(sessionId, { type: "thinking", data: "first buffered thought" });

        const mockQuestion = {
          id: "q-catchup-thinking",
          type: "text",
          question: "What is your preference?",
          description: "Please choose",
        };
        // @ts-expect-error - test setup mutates in-memory session state
        session!.currentQuestion = mockQuestion;

        planningStreamManager.broadcast(sessionId, { type: "question", data: mockQuestion });

        setTimeout(() => {
          planningStreamManager.broadcast(sessionId, { type: "complete" });
        }, 10);

        const streamRes = await REQUEST(
          buildApp(),
          "GET",
          `/api/planning/${sessionId}/stream`,
        );

        expect(streamRes.status).toBe(200);
        expect(typeof streamRes.body).toBe("string");
        expect(streamRes.body).toContain("event: thinking");
        expect(streamRes.body).toContain("first buffered thought");
        expect(streamRes.body).toContain("event: question");
        expect(streamRes.body).toContain("What is your preference?");
      });

      it("emits catch-up question event for awaiting_input sessions", async () => {
        // This test verifies the fix for the mismatch where a session was advertised as
        // needing input but the resume path initially entered loading state.
        // When a session is already awaiting input, the stream should emit a catch-up
        // question event immediately so late subscribers don't miss the transition.
        const startRes = await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/start",
          JSON.stringify({ initialPlan: "Catch-up test planning" }),
          { "Content-Type": "application/json" },
        );
        const sessionId = startRes.body.sessionId as string;

        // Manually simulate an awaiting_input session by updating the session state
        // In the real app, this happens via respondToPlanning which sets currentQuestion
        const { planningStreamManager, getSession } = await import("../planning.js");
        const session = await getSession(sessionId);
        expect(session).toBeDefined();

        // Simulate the session being in awaiting_input state with a question
        const mockQuestion = {
          id: "q-catchup",
          type: "text",
          question: "What is your preference?",
          description: "Please choose",
        };
        // @ts-expect-error - accessing internal state for testing
        session!.currentQuestion = mockQuestion;

        // Broadcast a complete event after a short delay so the stream ends
        setTimeout(() => {
          planningStreamManager.broadcast(sessionId, { type: "complete" });
        }, 10);

        // Connect to the stream - should receive catch-up question immediately
        const streamRes = await REQUEST(
          buildApp(),
          "GET",
          `/api/planning/${sessionId}/stream`,
        );

        expect(streamRes.status).toBe(200);
        expect(typeof streamRes.body).toBe("string");

        // Should emit the question as a catch-up event
        expect(streamRes.body).toContain("event: question");
        expect(streamRes.body).toContain("What is your preference?");

        // Should also emit complete
        expect(streamRes.body).toContain("event: complete");
      });
    });

    describe("POST /planning/respond", () => {
      it("processes response and returns next question", async () => {
        // First create a session
        const startRes = await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/start",
          JSON.stringify({ initialPlan: "Build a user auth system" }),
          { "Content-Type": "application/json" }
        );
        expect(startRes.status).toBe(201);
        const sessionId = startRes.body.sessionId;

        // Submit a response
        const res = await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/respond",
          JSON.stringify({ sessionId, responses: { scope: "medium" } }),
          { "Content-Type": "application/json" }
        );

        expect(res.status).toBe(200);
        expect(res.body.type).toBe("question");
        expect(res.body.data).toBeDefined();
      });

      it("returns checkpoint before summary, then completes only after explicit proceed", async () => {
        // Create a session
        const startRes = await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/start",
          JSON.stringify({ initialPlan: "Build a user auth system" }),
          { "Content-Type": "application/json" }
        );
        const sessionId = startRes.body.sessionId;

        // Submit 3 responses to complete the session
        await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/respond",
          JSON.stringify({ sessionId, responses: { scope: "medium" } }),
          { "Content-Type": "application/json" }
        );

        await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/respond",
          JSON.stringify({ sessionId, responses: { requirements: "Must have login" } }),
          { "Content-Type": "application/json" }
        );

        const checkpointRes = await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/respond",
          JSON.stringify({ sessionId, responses: { confirm: true } }),
          { "Content-Type": "application/json" }
        );

        expect(checkpointRes.status).toBe(200);
        expect(checkpointRes.body.type).toBe("question");
        expect(checkpointRes.body.data.id).toBe(PLANNING_DEEPEN_CHECKPOINT_ID);
        expect(checkpointRes.body.data.question).toBe(PLANNING_DEEPEN_CHECKPOINT_QUESTION);

        const finalRes = await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/respond",
          JSON.stringify({
            sessionId,
            responses: { [PLANNING_DEEPEN_CHECKPOINT_ID]: [PLANNING_DEEPEN_PROCEED_OPTION_ID] },
          }),
          { "Content-Type": "application/json" }
        );

        expect(finalRes.status).toBe(200);
        expect(finalRes.body.type).toBe("complete");
        expect(finalRes.body.data.title).toBeDefined();
        expect(finalRes.body.data.description).toBeDefined();
        expect(finalRes.body.data.suggestedSize).toBeDefined();
        expect(finalRes.body.data.keyDeliverables).toBeInstanceOf(Array);
      });

      it("FN-6977 normalizes omitted summary arrays from live AI completion", async () => {
        const responses = [
          JSON.stringify({
            type: "question",
            data: {
              id: "q-one",
              type: "text",
              question: "What should be planned?",
            },
          }),
          JSON.stringify({
            type: "complete",
            data: {
              title: "Malformed AI summary",
              description: "AI omitted array fields but completion is otherwise recoverable",
              suggestedSize: "M",
              suggestedDependencies: ["FN-100", "FN-100", 12],
            },
          }),
        ];
        let callIndex = 0;
        __setCreateFnAgent(async () => ({
          session: {
            state: { messages: [] },
            prompt: vi.fn(async function (this: { state: { messages: Array<{ role: string; content: string }> } }, message: string) {
              this.state.messages.push({ role: "user", content: message });
              this.state.messages.push({ role: "assistant", content: responses[callIndex++] ?? responses[responses.length - 1] });
            }),
            dispose: vi.fn(),
          },
        }));

        const startRes = await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/start",
          JSON.stringify({ initialPlan: "Normalize malformed AI completion" }),
          { "Content-Type": "application/json" },
        );
        const sessionId = startRes.body.sessionId;

        const checkpointRes = await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/respond",
          JSON.stringify({ sessionId, responses: { "q-one": "Finish" } }),
          { "Content-Type": "application/json" },
        );

        expect(checkpointRes.status).toBe(200);
        expect(checkpointRes.body).toMatchObject({
          type: "question",
          data: {
            id: PLANNING_DEEPEN_CHECKPOINT_ID,
            question: PLANNING_DEEPEN_CHECKPOINT_QUESTION,
          },
        });
        expect(planningModule.getSummary(sessionId)).toBeUndefined();

        const finalRes = await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/respond",
          JSON.stringify({
            sessionId,
            responses: { [PLANNING_DEEPEN_CHECKPOINT_ID]: [PLANNING_DEEPEN_PROCEED_OPTION_ID] },
          }),
          { "Content-Type": "application/json" },
        );
        expect(finalRes.body).toMatchObject({
          type: "complete",
          data: {
            title: "Malformed AI summary",
            suggestedDependencies: ["FN-100"],
            keyDeliverables: [],
          },
        });
        expect(planningModule.getSummary(sessionId)).toMatchObject({
          suggestedDependencies: ["FN-100"],
          keyDeliverables: [],
        });
      });

      it("continues agent conversation when checkpoint themes or custom topics are selected", async () => {
        const responses = [
          JSON.stringify({
            type: "question",
            data: { id: "q-one", type: "text", question: "What should be planned?" },
          }),
          JSON.stringify({
            type: "complete",
            data: {
              title: "Plan mobile UX",
              description: "Improve responsive mobile UX and add tests.",
              suggestedSize: "M",
              suggestedDependencies: [],
              keyDeliverables: ["Mobile UX", "Tests"],
            },
          }),
          JSON.stringify({
            type: "question",
            data: { id: "q-deeper", type: "text", question: "Which mobile edge cases matter?" },
          }),
          JSON.stringify({
            type: "complete",
            data: {
              title: "Plan mobile UX deeply",
              description: "Improve responsive mobile UX after exploring custom rollout risks.",
              suggestedSize: "M",
              suggestedDependencies: [],
              keyDeliverables: ["Mobile UX", "Tests", "Rollout notes"],
            },
          }),
        ];
        const messages: Array<{ role: string; content: string }> = [];
        let callIndex = 0;
        __setCreateFnAgent(async () => ({
          session: {
            state: { messages },
            prompt: vi.fn(async (message: string) => {
              messages.push({ role: "user", content: message });
              messages.push({ role: "assistant", content: responses[callIndex++] ?? responses[responses.length - 1] });
            }),
            dispose: vi.fn(),
          },
        }));

        const startRes = await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/start",
          JSON.stringify({ initialPlan: "Plan a mobile UX change" }),
          { "Content-Type": "application/json" },
        );
        const sessionId = startRes.body.sessionId;

        const checkpointRes = await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/respond",
          JSON.stringify({ sessionId, responses: { "q-one": "Make it responsive and tested" } }),
          { "Content-Type": "application/json" },
        );
        expect(checkpointRes.body.data.question).toBe(PLANNING_DEEPEN_CHECKPOINT_QUESTION);

        const deepeningRes = await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/respond",
          JSON.stringify({
            sessionId,
            responses: {
              [PLANNING_DEEPEN_CHECKPOINT_ID]: ["theme-ux"],
              _other: "Explore rollout risk",
            },
          }),
          { "Content-Type": "application/json" },
        );
        expect(deepeningRes.body).toMatchObject({
          type: "question",
          data: { id: "q-deeper", question: "Which mobile edge cases matter?" },
        });
        expect(messages.some((message) => message.role === "user" && message.content.includes("Explore rollout risk"))).toBe(true);

        const secondCheckpointRes = await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/respond",
          JSON.stringify({ sessionId, responses: { "q-deeper": "Keyboard and touch interactions" } }),
          { "Content-Type": "application/json" },
        );
        expect(secondCheckpointRes.body).toMatchObject({
          type: "question",
          data: { id: PLANNING_DEEPEN_CHECKPOINT_ID, question: PLANNING_DEEPEN_CHECKPOINT_QUESTION },
        });

        const finalRes = await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/respond",
          JSON.stringify({
            sessionId,
            responses: { [PLANNING_DEEPEN_CHECKPOINT_ID]: [PLANNING_DEEPEN_PROCEED_OPTION_ID] },
          }),
          { "Content-Type": "application/json" },
        );
        expect(finalRes.body).toMatchObject({
          type: "complete",
          data: { title: "Plan mobile UX deeply" },
        });
      });

      it("prefers AI-authored deepeningThemes over generic themes on both completion paths", async () => {
        const responses = [
          JSON.stringify({
            type: "complete",
            data: {
              title: "Plan offline sync",
              description: "Add offline-first sync support.",
              suggestedSize: "M",
              suggestedDependencies: [],
              keyDeliverables: ["Sync engine"],
              deepeningThemes: [
                { label: "Conflict resolution strategy", description: "How concurrent offline edits reconcile." },
              ],
            },
          }),
        ];
        const messages: Array<{ role: string; content: string }> = [];
        let callIndex = 0;
        __setCreateFnAgent(async () => ({
          session: {
            state: { messages },
            prompt: vi.fn(async (message: string) => {
              messages.push({ role: "user", content: message });
              messages.push({ role: "assistant", content: responses[Math.min(callIndex++, responses.length - 1)] });
            }),
            dispose: vi.fn(),
          },
        }));

        const startRes = await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/start",
          JSON.stringify({ initialPlan: "Plan offline sync support" }),
          { "Content-Type": "application/json" },
        );
        const sessionId = startRes.body.sessionId;

        expect(startRes.body.firstQuestion.question).toBe(PLANNING_DEEPEN_CHECKPOINT_QUESTION);
        expect(startRes.body.firstQuestion.options?.[0]?.id).toBe(PLANNING_DEEPEN_PROCEED_OPTION_ID);
        expect(startRes.body.firstQuestion.options?.map((option: { label: string }) => option.label)).toEqual([
          "Proceed to final plan",
          "Conflict resolution strategy",
        ]);

        const deepeningRes = await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/respond",
          JSON.stringify({
            sessionId,
            responses: { [PLANNING_DEEPEN_CHECKPOINT_ID]: [PLANNING_DEEPEN_PROCEED_OPTION_ID] },
          }),
          { "Content-Type": "application/json" },
        );
        expect(deepeningRes.body).toMatchObject({
          type: "complete",
          data: { title: "Plan offline sync" },
        });
      });

      it("allows refine requests from completed sessions", async () => {
        const startRes = await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/start",
          JSON.stringify({ initialPlan: "Build a user auth system" }),
          { "Content-Type": "application/json" }
        );
        const sessionId = startRes.body.sessionId;

        await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/respond",
          JSON.stringify({ sessionId, responses: { scope: "medium" } }),
          { "Content-Type": "application/json" }
        );
        await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/respond",
          JSON.stringify({ sessionId, responses: { requirements: "Must have login" } }),
          { "Content-Type": "application/json" }
        );
        await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/respond",
          JSON.stringify({ sessionId, responses: { confirm: true } }),
          { "Content-Type": "application/json" }
        );
        await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/respond",
          JSON.stringify({
            sessionId,
            responses: { [PLANNING_DEEPEN_CHECKPOINT_ID]: [PLANNING_DEEPEN_PROCEED_OPTION_ID] },
          }),
          { "Content-Type": "application/json" }
        );

        const refineRes = await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/respond",
          JSON.stringify({ sessionId, responses: { refine: true } }),
          { "Content-Type": "application/json" }
        );

        expect(refineRes.status).toBe(200);
        expect(["question", "complete"]).toContain(refineRes.body.type);
      });

      it("returns 404 for invalid session ID", async () => {
        const res = await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/respond",
          JSON.stringify({ sessionId: "invalid-session-id", responses: {} }),
          { "Content-Type": "application/json" }
        );

        expect(res.status).toBe(404);
        expect(res.body.error).toContain("not found");
      });

      it("requires sessionId in body", async () => {
        const res = await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/respond",
          JSON.stringify({ responses: {} }),
          { "Content-Type": "application/json" }
        );

        expect(res.status).toBe(400);
        expect(res.body.error).toContain("sessionId is required");
      });

      it("requires responses object", async () => {
        const res = await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/respond",
          JSON.stringify({ sessionId: "some-id" }),
          { "Content-Type": "application/json" }
        );

        expect(res.status).toBe(400);
        expect(res.body.error).toContain("responses is required");
      });
    });

    describe("POST /api/planning resume after restart (rehydrated session)", () => {
      it("respond route resumes with scoped store after rehydrate", async () => {
        const sessionId = await rehydratePlanningSessionRow(
          buildPlanningRow({ id: "resume-respond", status: "awaiting_input" }),
        );

        const res = await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/respond",
          JSON.stringify({ sessionId, responses: { constraints: "none" } }),
          { "Content-Type": "application/json" },
        );

        expect(res.status).toBe(200);
        expect(JSON.stringify(res.body)).not.toContain("has no task store");
        expect(JSON.stringify(res.body)).not.toContain("cannot be resumed without project context");
      });

      it("back route resumes with scoped store after rehydrate", async () => {
        const sessionId = await rehydratePlanningSessionRow(
          buildPlanningRow({ id: "resume-back", status: "awaiting_input" }),
        );

        const res = await REQUEST(buildApp(), "POST", `/api/planning/${sessionId}/back`);

        expect(res.status).toBe(200);
        expect(JSON.stringify(res.body)).not.toContain("has no task store");
        expect(JSON.stringify(res.body)).not.toContain("cannot be resumed without project context");
      });

      it("retry route resumes with scoped store after rehydrate", async () => {
        const sessionId = await rehydratePlanningSessionRow(
          buildPlanningRow({
            id: "resume-retry",
            status: "error",
            error: "temporary failure",
            currentQuestion: null,
          }),
        );

        const res = await REQUEST(buildApp(), "POST", `/api/planning/${sessionId}/retry`);

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ success: true, sessionId });
      });
    });

    describe("POST /planning/:sessionId/back", () => {
      it("rewinds an active planning session", async () => {
        const rewindSpy = vi.spyOn(planningModule, "rewindSession").mockResolvedValue({
          currentQuestion: {
            id: "q-scope",
            type: "single_select",
            question: "What is the scope of this plan?",
            options: [],
          },
          history: [],
        });

        const res = await REQUEST(buildApp(), "POST", "/api/planning/session-123/back");

        expect(res.status).toBe(200);
        expect(res.body.currentQuestion.id).toBe("q-scope");
        expect(rewindSpy).toHaveBeenCalledWith("session-123", expect.any(String), undefined, expect.any(Object));
      });

      it("returns 400 when there is no previous question", async () => {
        vi.spyOn(planningModule, "rewindSession").mockRejectedValueOnce(
          new planningModule.InvalidSessionStateError("Planning session has no previous question to rewind to"),
        );

        const res = await REQUEST(buildApp(), "POST", "/api/planning/session-400/back");

        expect(res.status).toBe(400);
        expect(res.body.error).toContain("no previous question");
      });
    });

    describe("POST /planning/:sessionId/retry", () => {
      it("retries a failed planning session", async () => {
        const retrySpy = vi.spyOn(planningModule, "retrySession").mockResolvedValue();

        const res = await REQUEST(buildApp(), "POST", "/api/planning/session-123/retry");

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ success: true, sessionId: "session-123" });
        expect(retrySpy).toHaveBeenCalledWith("session-123", expect.any(String), undefined, expect.any(Object));
      });

      it("returns 404 when planning retry session is missing", async () => {
        vi.spyOn(planningModule, "retrySession").mockRejectedValueOnce(
          new planningModule.SessionNotFoundError("Planning session missing"),
        );

        const res = await REQUEST(buildApp(), "POST", "/api/planning/session-404/retry");

        expect(res.status).toBe(404);
        expect(res.body.error).toContain("Planning session missing");
      });

      it("returns 400 when planning retry session is not in error state", async () => {
        vi.spyOn(planningModule, "retrySession").mockRejectedValueOnce(
          new planningModule.InvalidSessionStateError("Planning session is not in an error state"),
        );

        const res = await REQUEST(buildApp(), "POST", "/api/planning/session-400/retry");

        expect(res.status).toBe(400);
        expect(res.body.error).toContain("not in an error state");
      });
    });

    describe("POST /planning/:sessionId/stop", () => {
      it("stops an active generation", async () => {
        const stopSpy = vi.spyOn(planningModule, "stopGeneration").mockReturnValue(true);

        const res = await REQUEST(buildApp(), "POST", "/api/planning/session-123/stop");

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ success: true });
        expect(stopSpy).toHaveBeenCalledWith("session-123");
      });

      it("returns 404 when session is missing", async () => {
        vi.spyOn(planningModule, "stopGeneration").mockReturnValue(false);

        const res = await REQUEST(buildApp(), "POST", "/api/planning/session-404/stop");

        expect(res.status).toBe(404);
        expect(res.body.error).toContain("not found");
      });
    });

    describe("POST /planning/cancel", () => {
      it("cancels an active session", async () => {
        // Create a session first
        const startRes = await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/start",
          JSON.stringify({ initialPlan: "Build a user auth system" }),
          { "Content-Type": "application/json" }
        );
        const sessionId = startRes.body.sessionId;

        const res = await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/cancel",
          JSON.stringify({ sessionId }),
          { "Content-Type": "application/json" }
        );

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
      });

      it("returns 404 for non-existent session", async () => {
        const res = await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/cancel",
          JSON.stringify({ sessionId: "non-existent-id" }),
          { "Content-Type": "application/json" }
        );

        expect(res.status).toBe(404);
        expect(res.body.error).toContain("not found");
      });

      it("requires sessionId in body", async () => {
        const res = await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/cancel",
          JSON.stringify({}),
          { "Content-Type": "application/json" }
        );

        expect(res.status).toBe(400);
        expect(res.body.error).toContain("sessionId is required");
      });
    });

    describe("POST /planning/start-breakdown", () => {
      it("uses summary override when generating subtasks", async () => {
        const startRes = await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/start",
          JSON.stringify({ initialPlan: "Build a user auth system" }),
          { "Content-Type": "application/json" }
        );
        const sessionId = startRes.body.sessionId;

        await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/respond",
          JSON.stringify({ sessionId, responses: { scope: "medium" } }),
          { "Content-Type": "application/json" }
        );
        await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/respond",
          JSON.stringify({ sessionId, responses: { requirements: "Must have login" } }),
          { "Content-Type": "application/json" }
        );
        await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/respond",
          JSON.stringify({ sessionId, responses: { confirm: true } }),
          { "Content-Type": "application/json" }
        );

        const res = await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/start-breakdown",
          JSON.stringify({
            sessionId,
            summary: {
              title: "Edited auth implementation",
              description: "Use OAuth providers and secure refresh tokens",
              suggestedSize: "L",
              suggestedDependencies: ["FN-321"],
              keyDeliverables: ["OAuth integration"],
            },
          }),
          { "Content-Type": "application/json" }
        );

        expect(res.status).toBe(200);
        expect(res.body.sessionId).toBe(sessionId);
        expect(res.body.subtasks).toHaveLength(2);
        expect(res.body.subtasks[0]).toEqual(
          expect.objectContaining({
            title: "OAuth integration",
          }),
        );
        expect(res.body.subtasks[0].description).toContain("Use OAuth providers and secure refresh tokens");
        expect(res.body.subtasks[1]).toEqual(
          expect.objectContaining({
            id: "subtask-2",
            title: "Verify end-to-end",
            dependsOn: ["subtask-1"],
            suggestedSize: "S",
          }),
        );
      });

      it("FN-6977 returns fallback subtasks when summary override omits deliverables", async () => {
        const sessionId = await createCompletedPlanningSession("Break down malformed planning summary");

        const res = await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/start-breakdown",
          JSON.stringify({
            sessionId,
            summary: {
              title: "Malformed breakdown summary",
              description: "Deliverables were omitted by the AI or persisted session",
              suggestedSize: "M",
            },
          }),
          { "Content-Type": "application/json" },
        );

        expect(res.status).toBe(200);
        expect(res.body.subtasks).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: "subtask-1", title: "Define implementation approach", dependsOn: [] }),
            expect.objectContaining({ id: "subtask-2", title: "Implement core changes", dependsOn: ["subtask-1"] }),
            expect.objectContaining({ id: "subtask-3", title: "Verify and polish", dependsOn: ["subtask-2"] }),
          ]),
        );
      });
    });

    describe("POST /planning/create-task", () => {
      it("creates a task from completed planning session", async () => {
        // Setup mock store for task creation
        (store.createTask as ReturnType<typeof vi.fn>).mockResolvedValue({
          id: "FN-042",
          description: "Build a user auth system",
          column: "triage",
          dependencies: [],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        });
        (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValue({});
        (store.logEntry as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

        // Create a session and complete it
        const startRes = await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/start",
          JSON.stringify({ initialPlan: "Build a user auth system" }),
          { "Content-Type": "application/json" }
        );
        const sessionId = startRes.body.sessionId;

        // Complete the session
        await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/respond",
          JSON.stringify({ sessionId, responses: { scope: "medium" } }),
          { "Content-Type": "application/json" }
        );
        await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/respond",
          JSON.stringify({ sessionId, responses: { requirements: "Must have login" } }),
          { "Content-Type": "application/json" }
        );
        await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/respond",
          JSON.stringify({ sessionId, responses: { confirm: true } }),
          { "Content-Type": "application/json" }
        );
        await REQUEST(buildApp(), "POST", "/api/planning/respond", JSON.stringify({
          sessionId,
          responses: { [PLANNING_DEEPEN_CHECKPOINT_ID]: [PLANNING_DEEPEN_PROCEED_OPTION_ID] },
        }), { "Content-Type": "application/json" });

        // Create task from planning
        const res = await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/create-task",
          JSON.stringify({ sessionId }),
          { "Content-Type": "application/json" }
        );

        expect(res.status).toBe(201);
        expect(store.createTask).toHaveBeenCalled();
      });

      it("uses summary override when provided", async () => {
        (store.createTask as ReturnType<typeof vi.fn>).mockResolvedValue({
          id: "FN-099",
          description: "Edited task description",
          column: "triage",
          dependencies: ["FN-500"],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        });
        (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValue({});
        (store.logEntry as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

        const startRes = await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/start",
          JSON.stringify({ initialPlan: "Build a user auth system" }),
          { "Content-Type": "application/json" }
        );
        const sessionId = startRes.body.sessionId;

        await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/respond",
          JSON.stringify({ sessionId, responses: { scope: "medium" } }),
          { "Content-Type": "application/json" }
        );
        await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/respond",
          JSON.stringify({ sessionId, responses: { requirements: "Must have login" } }),
          { "Content-Type": "application/json" }
        );
        await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/respond",
          JSON.stringify({ sessionId, responses: { confirm: true } }),
          { "Content-Type": "application/json" }
        );

        const res = await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/create-task",
          JSON.stringify({
            sessionId,
            summary: {
              title: "Edited auth task",
              description: "Edited description from summary view",
              suggestedSize: "S",
              suggestedDependencies: ["FN-500"],
              keyDeliverables: ["Login flow"],
            },
          }),
          { "Content-Type": "application/json" }
        );

        expect(res.status).toBe(201);
        expect(store.createTask).toHaveBeenCalledWith(
          expect.objectContaining({
            title: "Edited auth task",
            description: "Edited description from summary view",
            dependencies: ["FN-500"],
            priority: "normal",
          }),
        );
        expect(store.updateTask).toHaveBeenCalledWith("FN-099", { size: "S" });
      });

      it("creates a task from a persisted complete session when in-memory session is missing and keeps the completed session fetchable", async () => {
        (store.createTask as ReturnType<typeof vi.fn>).mockResolvedValue({
          id: "FN-043",
          description: "Build a resumable planning flow",
          column: "triage",
          dependencies: [],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        });
        (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValue({});
        (store.logEntry as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

        const sessionId = "session-from-sqlite";
        const persistedSession = {
          id: sessionId,
          type: "planning",
          status: "complete",
          title: "Build resumable planning",
          inputPayload: JSON.stringify({ initialPlan: "Build resumable planning sessions" }),
          conversationHistory: "[]",
          currentQuestion: null,
          result: JSON.stringify({
            title: "Build resumable planning flow",
            description: "Persist planning results so users can create tasks later",
            suggestedSize: "M",
            suggestedDependencies: ["FN-100"],
            keyDeliverables: ["Persist sessions", "Support resume"],
          }),
          thinkingOutput: "",
          error: null,
          projectId: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          archived: 0,
        };
        let storedSession: typeof persistedSession | undefined = persistedSession;
        const mockAiSessionStore = {
          get: vi.fn((id: string) => (id === sessionId ? storedSession ?? null : null)),
          listAll: vi.fn(() =>
            storedSession
              ? [
                  {
                    id: storedSession.id,
                    type: storedSession.type,
                    status: storedSession.status,
                    title: storedSession.title,
                    projectId: storedSession.projectId,
                    lockedByTab: null,
                    updatedAt: storedSession.updatedAt,
                    archived: false,
                  },
                ]
              : [],
          ),
          delete: vi.fn(() => {
            storedSession = undefined;
          }),
        };

        const appWithAiSessionStore = express();
        appWithAiSessionStore.use(express.json());
        appWithAiSessionStore.use(
          "/api",
          createApiRoutes(store, { aiSessionStore: mockAiSessionStore as any }),
        );

        const res = await REQUEST(
          appWithAiSessionStore,
          "POST",
          "/api/planning/create-task",
          JSON.stringify({ sessionId }),
          { "Content-Type": "application/json" }
        );

        expect(res.status).toBe(201);
        expect(store.createTask).toHaveBeenCalledWith(
          expect.objectContaining({
            title: "Build resumable planning flow",
            dependencies: ["FN-100"],
          }),
        );
        expect(store.logEntry).toHaveBeenCalledWith(
          "FN-043",
          "Created via Planning Mode",
          expect.stringContaining("Initial plan: Build resumable planning sessions"),
        );

        const listRes = await REQUEST(appWithAiSessionStore, "GET", "/api/ai-sessions?includeCompleted=1");
        expect(listRes.status).toBe(200);
        expect(listRes.body.sessions).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: sessionId,
              status: "complete",
              title: "Build resumable planning",
            }),
          ]),
        );

        const sessionRes = await REQUEST(appWithAiSessionStore, "GET", `/api/ai-sessions/${sessionId}`);
        expect(sessionRes.status).toBe(200);
        expect(sessionRes.body).toMatchObject({
          id: sessionId,
          status: "complete",
        });
        expect(JSON.parse(sessionRes.body.result)).toMatchObject(JSON.parse(storedSession?.result ?? "{}"));
      });

      it("FN-6977 returns normalized persisted planning summary rows for resume", async () => {
        const sessionId = "session-fn-6977-persisted-resume";
        const mockAiSessionStore = {
          get: vi.fn((id: string) => id === sessionId ? buildPlanningRow({
            id: sessionId,
            status: "complete",
            title: "Malformed persisted summary",
            result: JSON.stringify({
              title: "Malformed persisted summary",
              description: "Persisted row omitted keyDeliverables and included duplicate dependencies",
              suggestedSize: "M",
              suggestedDependencies: ["FN-100", "FN-100", "", 7],
            }),
          }) : null),
          listAll: vi.fn(() => []),
          listActive: vi.fn(() => []),
        };
        const appWithAiSessionStore = express();
        appWithAiSessionStore.use(express.json());
        appWithAiSessionStore.use("/api", createApiRoutes(store, { aiSessionStore: mockAiSessionStore as any }));

        const sessionRes = await REQUEST(appWithAiSessionStore, "GET", `/api/ai-sessions/${sessionId}`);

        expect(sessionRes.status).toBe(200);
        expect(JSON.parse(sessionRes.body.result)).toMatchObject({
          suggestedDependencies: ["FN-100"],
          keyDeliverables: [],
        });
      });

      it.each([
        {
          sessionSource: "live",
          useSummaryOverride: false,
          branchSelection: { mode: "project-default" },
          expectedBranch: undefined,
          expectedBaseBranch: undefined,
        },
        {
          sessionSource: "live",
          useSummaryOverride: true,
          branchSelection: { mode: "auto-new", baseBranch: "develop" },
          expectedBranch: undefined,
          expectedBaseBranch: "develop",
        },
        {
          sessionSource: "persisted",
          useSummaryOverride: false,
          branchSelection: { mode: "existing", branchName: "feature/shared-auth", baseBranch: "develop" },
          expectedBranch: "feature/shared-auth",
          expectedBaseBranch: "develop",
        },
        {
          sessionSource: "persisted",
          useSummaryOverride: true,
          branchSelection: { mode: "custom-new", branchName: "feature/planned-auth", baseBranch: "main" },
          expectedBranch: "feature/planned-auth",
          expectedBaseBranch: "main",
        },
      ])("returns 201 for $sessionSource create-task sessions across branch selection surfaces (summary override: $useSummaryOverride)", async ({
        sessionSource,
        useSummaryOverride,
        branchSelection,
        expectedBranch,
        expectedBaseBranch,
      }) => {
        (store.createTask as ReturnType<typeof vi.fn>).mockResolvedValue({
          id: `FN-${sessionSource}-${branchSelection.mode}`,
          description: "Build auth flow",
          column: "triage",
          dependencies: [],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        });
        (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValue({});
        (store.logEntry as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

        let app = buildApp();
        let sessionId: string;

        if (sessionSource === "live") {
          sessionId = await createCompletedPlanningSession();
        } else {
          sessionId = `persisted-${branchSelection.mode}-${useSummaryOverride ? "override" : "default"}`;
          const persistedSession = {
            id: sessionId,
            type: "planning",
            status: "complete",
            title: "Build persisted planning",
            inputPayload: JSON.stringify({ initialPlan: "Build resumable planning sessions" }),
            conversationHistory: "[]",
            currentQuestion: null,
            result: JSON.stringify({
              title: "Persisted planning output",
              description: "Persist planning results so users can create tasks later",
              suggestedSize: "M",
              priority: "normal",
              suggestedDependencies: ["FN-100"],
              keyDeliverables: ["Persist sessions"],
            }),
            thinkingOutput: "",
            error: null,
            projectId: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            archived: 0,
          };
          const mockAiSessionStore = {
            get: vi.fn((id: string) => (id === sessionId ? persistedSession : null)),
            listAll: vi.fn(() => []),
            delete: vi.fn(),
          };
          app = express();
          app.use(express.json());
          app.use("/api", createApiRoutes(store, { aiSessionStore: mockAiSessionStore as any }));
        }

        const summary = useSummaryOverride
          ? {
              title: "Edited auth task",
              description: "Edited description from summary view",
              suggestedSize: "S",
              suggestedDependencies: ["FN-500"],
              keyDeliverables: ["Login flow"],
            }
          : undefined;

        const res = await REQUEST(
          app,
          "POST",
          "/api/planning/create-task",
          JSON.stringify({ sessionId, branchSelection, ...(summary ? { summary } : {}) }),
          { "Content-Type": "application/json" }
        );

        expect(res.status).toBe(201);
        expect(store.createTask).toHaveBeenCalledWith(
          expect.objectContaining({
            title: useSummaryOverride ? "Edited auth task" : expect.any(String),
            branch: expectedBranch,
            baseBranch: expectedBaseBranch,
          }),
        );
      });

      it.each([
        { label: "size update rejection", configure: () => (store.updateTask as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("size update failed")) },
        { label: "log entry rejection", configure: () => (store.logEntry as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("log entry failed")) },
      ])("still returns 201 when planning create-task post-create side effects fail (%s)", async ({ configure }) => {
        (store.createTask as ReturnType<typeof vi.fn>).mockResolvedValue({
          id: "FN-250",
          description: "Build a user auth system",
          column: "triage",
          dependencies: [],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        });
        (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValue({});
        (store.logEntry as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
        configure();

        const sessionId = await createCompletedPlanningSession();
        const res = await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/create-task",
          JSON.stringify({ sessionId }),
          { "Content-Type": "application/json" }
        );

        expect(res.status).toBe(201);
      });

      it("still returns 201 when planning create-task session release throws", async () => {
        (store.createTask as ReturnType<typeof vi.fn>).mockResolvedValue({
          id: "FN-251",
          description: "Build a user auth system",
          column: "triage",
          dependencies: [],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        });
        (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValue({});
        (store.logEntry as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
        const releaseSessionSpy = vi.spyOn(planningModule, "releaseSession").mockImplementation(() => {
          throw new Error("release exploded");
        });

        try {
          const sessionId = await createCompletedPlanningSession();
          const res = await REQUEST(
            buildApp(),
            "POST",
            "/api/planning/create-task",
            JSON.stringify({ sessionId }),
            { "Content-Type": "application/json" }
          );

          expect(res.status).toBe(201);
        } finally {
          releaseSessionSpy.mockRestore();
        }
      });

      it("still returns 201 when planning create-tasks post-create updates fail", async () => {
        (store.createTask as ReturnType<typeof vi.fn>)
          .mockResolvedValueOnce({
            id: "FN-260",
            description: "First",
            column: "triage",
            dependencies: [],
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          })
          .mockResolvedValueOnce({
            id: "FN-261",
            description: "Second",
            column: "triage",
            dependencies: [],
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          });
        (store.updateTask as ReturnType<typeof vi.fn>)
          .mockRejectedValueOnce(new Error("size update failed"))
          .mockResolvedValueOnce({
            id: "FN-261",
            description: "Second",
            column: "triage",
            dependencies: ["FN-260"],
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          });
        (store.logEntry as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

        const planningSessionId = await createCompletedPlanningSession();
        const breakdownRes = await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/start-breakdown",
          JSON.stringify({ sessionId: planningSessionId }),
          { "Content-Type": "application/json" }
        );

        const generatedSubtasks = breakdownRes.body.subtasks as Array<{
          id: string;
          title: string;
          description: string;
          suggestedSize: "S" | "M" | "L";
          dependsOn: string[];
        }>;

        const res = await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/create-tasks",
          JSON.stringify({
            planningSessionId,
            subtasks: [
              {
                id: generatedSubtasks[0]!.id,
                title: "Auth backend",
                description: "Implement backend",
                suggestedSize: "L",
                dependsOn: [],
              },
              {
                id: generatedSubtasks[1]!.id,
                title: "Auth frontend",
                description: "Implement frontend",
                dependsOn: [generatedSubtasks[0]!.id],
              },
            ],
          }),
          { "Content-Type": "application/json" }
        );

        expect(res.status).toBe(201);
        expect(res.body.tasks).toHaveLength(2);
      });

      it("keeps the completed planning session in history after multi-task creation", async () => {
        // Bug C: /planning/create-tasks used cleanupSession() which deleted the
        // persisted ai_sessions row, so a session that ran to completion AND
        // created tasks vanished from the saved-sessions history. It must instead
        // release only the in-memory runtime (like single-task create-task) and
        // keep the persisted completed row.
        const mockStore = new MockAiSessionStore();
        setAiSessionStore(mockStore as unknown as Parameters<typeof setAiSessionStore>[0]);

        (store.createTask as ReturnType<typeof vi.fn>)
          .mockResolvedValueOnce({
            id: "FN-270",
            description: "First",
            column: "triage",
            dependencies: [],
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          })
          .mockResolvedValueOnce({
            id: "FN-271",
            description: "Second",
            column: "triage",
            dependencies: [],
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          });
        (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValue({});
        (store.logEntry as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

        const planningSessionId = await createCompletedPlanningSession();

        // Precondition: the completed planning session is persisted as history.
        const persistedBefore = mockStore.get(planningSessionId);
        expect(persistedBefore).not.toBeNull();
        expect(persistedBefore?.type).toBe("planning");
        expect(persistedBefore?.status).toBe("complete");

        const breakdownRes = await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/start-breakdown",
          JSON.stringify({ sessionId: planningSessionId }),
          { "Content-Type": "application/json" }
        );
        const generatedSubtasks = breakdownRes.body.subtasks as Array<{ id: string }>;

        const res = await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/create-tasks",
          JSON.stringify({
            planningSessionId,
            subtasks: [
              { id: generatedSubtasks[0]!.id, title: "Auth backend", description: "Implement backend", suggestedSize: "L", dependsOn: [] },
              { id: generatedSubtasks[1]!.id, title: "Auth frontend", description: "Implement frontend", dependsOn: [generatedSubtasks[0]!.id] },
            ],
          }),
          { "Content-Type": "application/json" }
        );

        expect(res.status).toBe(201);
        expect(res.body.tasks).toHaveLength(2);

        // Regression assertion: the completed planning session row must survive
        // task creation so it remains listable/restorable in history.
        const persistedAfter = mockStore.get(planningSessionId);
        expect(persistedAfter).not.toBeNull();
        expect(persistedAfter?.type).toBe("planning");
        expect(persistedAfter?.status).toBe("complete");
      });

      it("creates task with explicit summary priority", async () => {
        (store.createTask as ReturnType<typeof vi.fn>).mockResolvedValue({
          id: "FN-100",
          description: "Priority task",
          column: "triage",
          dependencies: [],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        });
        (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValue({});
        (store.logEntry as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

        const startRes = await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/start",
          JSON.stringify({ initialPlan: "Build a user auth system" }),
          { "Content-Type": "application/json" }
        );
        const sessionId = startRes.body.sessionId;

        await REQUEST(buildApp(), "POST", "/api/planning/respond", JSON.stringify({ sessionId, responses: { scope: "medium" } }), { "Content-Type": "application/json" });
        await REQUEST(buildApp(), "POST", "/api/planning/respond", JSON.stringify({ sessionId, responses: { requirements: "Must have login" } }), { "Content-Type": "application/json" });
        await REQUEST(buildApp(), "POST", "/api/planning/respond", JSON.stringify({ sessionId, responses: { confirm: true } }), { "Content-Type": "application/json" });
        await REQUEST(buildApp(), "POST", "/api/planning/respond", JSON.stringify({
          sessionId: sessionId,
          responses: { [PLANNING_DEEPEN_CHECKPOINT_ID]: [PLANNING_DEEPEN_PROCEED_OPTION_ID] },
        }), { "Content-Type": "application/json" });

        const res = await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/create-task",
          JSON.stringify({
            sessionId,
            summary: {
              title: "Priority auth task",
              description: "High-priority planning output",
              suggestedSize: "M",
              priority: "high",
              suggestedDependencies: [],
              keyDeliverables: ["Login flow"],
            },
          }),
          { "Content-Type": "application/json" }
        );

        expect(res.status).toBe(201);
        expect(store.createTask).toHaveBeenCalledWith(
          expect.objectContaining({
            title: "Priority auth task",
            priority: "high",
          }),
        );
      });

      it("creates multiple planning tasks from compact subtask drafts while preserving edited fields", async () => {
        (store.createTask as ReturnType<typeof vi.fn>)
          .mockResolvedValueOnce({
            id: "FN-201",
            description: "First",
            column: "triage",
            dependencies: [],
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          })
          .mockResolvedValueOnce({
            id: "FN-202",
            description: "Second",
            column: "triage",
            dependencies: [],
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          })
          .mockResolvedValueOnce({
            id: "FN-203",
            description: "Third",
            column: "triage",
            dependencies: [],
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          });
        (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValue({});
        (store.logEntry as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

        const startRes = await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/start",
          JSON.stringify({ initialPlan: "Build a user auth system" }),
          { "Content-Type": "application/json" }
        );
        const planningSessionId = startRes.body.sessionId;

        await REQUEST(buildApp(), "POST", "/api/planning/respond", JSON.stringify({ sessionId: planningSessionId, responses: { scope: "medium" } }), { "Content-Type": "application/json" });
        await REQUEST(buildApp(), "POST", "/api/planning/respond", JSON.stringify({ sessionId: planningSessionId, responses: { requirements: "Must have login" } }), { "Content-Type": "application/json" });
        await REQUEST(buildApp(), "POST", "/api/planning/respond", JSON.stringify({ sessionId: planningSessionId, responses: { confirm: true } }), { "Content-Type": "application/json" });
        await REQUEST(buildApp(), "POST", "/api/planning/respond", JSON.stringify({
          sessionId: planningSessionId,
          responses: { [PLANNING_DEEPEN_CHECKPOINT_ID]: [PLANNING_DEEPEN_PROCEED_OPTION_ID] },
        }), { "Content-Type": "application/json" });

        const breakdownRes = await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/start-breakdown",
          JSON.stringify({ sessionId: planningSessionId }),
          { "Content-Type": "application/json" }
        );
        expect(breakdownRes.status).toBe(200);

        const generatedSubtasks = breakdownRes.body.subtasks as Array<{
          id: string;
          title: string;
          description: string;
          suggestedSize: "S" | "M" | "L";
          priority?: string;
          dependsOn: string[];
        }>;

        const res = await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/create-tasks",
          JSON.stringify({
            planningSessionId,
            subtasks: [
              {
                id: generatedSubtasks[0]!.id,
                title: "Auth backend",
                description: "Implement backend",
                suggestedSize: "L",
                priority: "urgent",
                dependsOn: [],
              },
              {
                id: generatedSubtasks[1]!.id,
              },
              {
                id: generatedSubtasks[2]!.id,
                dependsOn: [generatedSubtasks[0]!.id, generatedSubtasks[1]!.id],
              },
            ],
          }),
          { "Content-Type": "application/json" }
        );

        expect(res.status).toBe(201);
        expect(store.createTask).toHaveBeenNthCalledWith(
          1,
          expect.objectContaining({ title: "Auth backend", description: "Implement backend", priority: "urgent" }),
        );
        expect(store.createTask).toHaveBeenNthCalledWith(
          2,
          expect.objectContaining({
            title: generatedSubtasks[1]!.title,
            description: generatedSubtasks[1]!.description,
            priority: "normal",
          }),
        );
        expect(store.createTask).toHaveBeenNthCalledWith(
          3,
          expect.objectContaining({
            title: generatedSubtasks[2]!.title,
            description: generatedSubtasks[2]!.description,
            priority: "normal",
          }),
        );
        expect(store.updateTask).toHaveBeenCalledWith("FN-201", { size: "L" });
        expect(store.updateTask).toHaveBeenCalledWith("FN-203", { dependencies: ["FN-201", "FN-202"] });
      });

      it("supports client-added subtasks and omitted generated subtasks in compact breakdown payloads", async () => {
        (store.createTask as ReturnType<typeof vi.fn>)
          .mockResolvedValueOnce({
            id: "FN-210",
            description: "Generated task",
            column: "triage",
            dependencies: [],
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          })
          .mockResolvedValueOnce({
            id: "FN-211",
            description: "Client-added task",
            column: "triage",
            dependencies: [],
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          });
        (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValue({});
        (store.logEntry as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

        const startRes = await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/start",
          JSON.stringify({ initialPlan: "Build a user auth system" }),
          { "Content-Type": "application/json" }
        );
        const planningSessionId = startRes.body.sessionId;

        await REQUEST(buildApp(), "POST", "/api/planning/respond", JSON.stringify({ sessionId: planningSessionId, responses: { scope: "medium" } }), { "Content-Type": "application/json" });
        await REQUEST(buildApp(), "POST", "/api/planning/respond", JSON.stringify({ sessionId: planningSessionId, responses: { requirements: "Must have login" } }), { "Content-Type": "application/json" });
        await REQUEST(buildApp(), "POST", "/api/planning/respond", JSON.stringify({ sessionId: planningSessionId, responses: { confirm: true } }), { "Content-Type": "application/json" });
        await REQUEST(buildApp(), "POST", "/api/planning/respond", JSON.stringify({
          sessionId: planningSessionId,
          responses: { [PLANNING_DEEPEN_CHECKPOINT_ID]: [PLANNING_DEEPEN_PROCEED_OPTION_ID] },
        }), { "Content-Type": "application/json" });

        const breakdownRes = await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/start-breakdown",
          JSON.stringify({ sessionId: planningSessionId }),
          { "Content-Type": "application/json" }
        );
        expect(breakdownRes.status).toBe(200);
        const generatedSubtasks = breakdownRes.body.subtasks as Array<{
          id: string;
          title: string;
          description: string;
          suggestedSize: "S" | "M" | "L";
          priority?: string;
          dependsOn: string[];
        }>;

        const res = await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/create-tasks",
          JSON.stringify({
            planningSessionId,
            subtasks: [
              { id: generatedSubtasks[0]!.id },
              {
                id: "subtask-99",
                title: "Rollout follow-up",
                description: "Prepare rollout notes",
                suggestedSize: "S",
                priority: "high",
                dependsOn: [generatedSubtasks[0]!.id],
              },
            ],
          }),
          { "Content-Type": "application/json" }
        );

        expect(res.status).toBe(201);
        expect(store.createTask).toHaveBeenCalledTimes(2);
        expect(store.createTask).toHaveBeenNthCalledWith(
          1,
          expect.objectContaining({
            title: generatedSubtasks[0]!.title,
            description: generatedSubtasks[0]!.description,
          }),
        );
        expect(store.createTask).toHaveBeenNthCalledWith(
          2,
          expect.objectContaining({
            title: "Rollout follow-up",
            description: "Prepare rollout notes",
            priority: "high",
          }),
        );
        expect(store.updateTask).toHaveBeenCalledWith("FN-211", { size: "S" });
        expect(store.updateTask).toHaveBeenCalledWith("FN-211", { dependencies: ["FN-210"] });
      });

      it("accepts compact breakdown payloads that avoid oversized planning create-tasks requests", async () => {
        const createdTaskBase = {
          column: "triage",
          dependencies: [],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        };
        for (let index = 0; index < 16; index += 1) {
          (store.createTask as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
            ...createdTaskBase,
            id: `FN-${300 + index}`,
            description: `Task ${index + 1}`,
          });
        }
        (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValue({});
        (store.logEntry as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

        const startRes = await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/start",
          JSON.stringify({ initialPlan: "Break a large platform plan into many tasks" }),
          { "Content-Type": "application/json" }
        );
        const planningSessionId = startRes.body.sessionId;

        await REQUEST(buildApp(), "POST", "/api/planning/respond", JSON.stringify({ sessionId: planningSessionId, responses: { scope: "large" } }), { "Content-Type": "application/json" });
        await REQUEST(buildApp(), "POST", "/api/planning/respond", JSON.stringify({ sessionId: planningSessionId, responses: { requirements: "Must support auth, settings, dashboards, workflows, imports, sync, audits, search, mobile, docs, QA, releases, telemetry, reliability, and security." } }), { "Content-Type": "application/json" });
        await REQUEST(buildApp(), "POST", "/api/planning/respond", JSON.stringify({ sessionId: planningSessionId, responses: { confirm: true } }), { "Content-Type": "application/json" });
        await REQUEST(buildApp(), "POST", "/api/planning/respond", JSON.stringify({
          sessionId: planningSessionId,
          responses: { [PLANNING_DEEPEN_CHECKPOINT_ID]: [PLANNING_DEEPEN_PROCEED_OPTION_ID] },
        }), { "Content-Type": "application/json" });

        const summaryOverride = {
          title: "Large planning summary",
          description: `${"Large planning context. ".repeat(400)}${"Detailed implementation note. ".repeat(400)}`,
          suggestedSize: "L",
          suggestedDependencies: [],
          keyDeliverables: Array.from({ length: 15 }, (_, index) => `Deliverable ${index + 1}`),
        };

        const breakdownRes = await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/start-breakdown",
          JSON.stringify({ sessionId: planningSessionId, summary: summaryOverride }),
          { "Content-Type": "application/json" }
        );
        expect(breakdownRes.status).toBe(200);

        const generatedSubtasks = breakdownRes.body.subtasks as Array<{
          id: string;
          title: string;
          description: string;
          suggestedSize: "S" | "M" | "L";
          priority?: string;
          dependsOn: string[];
        }>;
        expect(generatedSubtasks).toHaveLength(16);
        expect(generatedSubtasks[15]).toEqual(
          expect.objectContaining({
            id: "subtask-16",
            title: "Verify end-to-end",
            dependsOn: ["subtask-15"],
            suggestedSize: "S",
          }),
        );

        const oversizedLegacyPayload = JSON.stringify({ planningSessionId, subtasks: generatedSubtasks });
        const compactPayload = JSON.stringify({
          planningSessionId,
          subtasks: generatedSubtasks.map((subtask) => ({ id: subtask.id })),
        });
        expect(Buffer.byteLength(oversizedLegacyPayload)).toBeGreaterThan(100 * 1024);
        expect(Buffer.byteLength(compactPayload)).toBeLessThan(8 * 1024);

        const res = await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/create-tasks",
          compactPayload,
          { "Content-Type": "application/json" }
        );

        expect(res.status).toBe(201);
        expect(store.createTask).toHaveBeenCalledTimes(16);
        expect(store.createTask).toHaveBeenNthCalledWith(
          1,
          expect.objectContaining({
            title: generatedSubtasks[0]!.title,
            description: generatedSubtasks[0]!.description,
          }),
        );
        expect(store.createTask).toHaveBeenNthCalledWith(
          16,
          expect.objectContaining({
            title: generatedSubtasks[15]!.title,
            description: generatedSubtasks[15]!.description,
          }),
        );
        expect(store.logEntry).toHaveBeenCalledTimes(16);
      });

      it("applies branchSelection when creating a planning task", async () => {
        (store.createTask as ReturnType<typeof vi.fn>).mockResolvedValue({
          id: "FN-200",
          description: "A task created from planning",
          column: "triage",
          dependencies: [],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        });

        const startRes = await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/start",
          JSON.stringify({ initialPlan: "Build a user auth system" }),
          { "Content-Type": "application/json" }
        );
        const sessionId = startRes.body.sessionId;

        await REQUEST(buildApp(), "POST", "/api/planning/respond", JSON.stringify({ sessionId, responses: { scope: "medium" } }), { "Content-Type": "application/json" });
        await REQUEST(buildApp(), "POST", "/api/planning/respond", JSON.stringify({ sessionId, responses: { requirements: "Must have login" } }), { "Content-Type": "application/json" });
        await REQUEST(buildApp(), "POST", "/api/planning/respond", JSON.stringify({ sessionId, responses: { confirm: true } }), { "Content-Type": "application/json" });
        await REQUEST(buildApp(), "POST", "/api/planning/respond", JSON.stringify({
          sessionId: sessionId,
          responses: { [PLANNING_DEEPEN_CHECKPOINT_ID]: [PLANNING_DEEPEN_PROCEED_OPTION_ID] },
        }), { "Content-Type": "application/json" });

        const res = await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/create-task",
          JSON.stringify({
            sessionId,
            branchSelection: {
              mode: "existing",
              branchName: "feature/shared-auth",
              baseBranch: "develop",
            },
          }),
          { "Content-Type": "application/json" }
        );

        expect(res.status).toBe(201);
        expect(store.createTask).toHaveBeenCalledWith(
          expect.objectContaining({
            branch: "feature/shared-auth",
            baseBranch: "develop",
          }),
        );
      });

      it("keeps per-task branch unset for project-default branchSelection", async () => {
        (store.createTask as ReturnType<typeof vi.fn>).mockResolvedValue({
          id: "FN-200b",
          description: "A task created from planning",
          column: "triage",
          dependencies: [],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        });

        const startRes = await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/start",
          JSON.stringify({ initialPlan: "Build a user auth system" }),
          { "Content-Type": "application/json" }
        );
        const sessionId = startRes.body.sessionId;

        await REQUEST(buildApp(), "POST", "/api/planning/respond", JSON.stringify({ sessionId, responses: { scope: "medium" } }), { "Content-Type": "application/json" });
        await REQUEST(buildApp(), "POST", "/api/planning/respond", JSON.stringify({ sessionId, responses: { requirements: "Must have login" } }), { "Content-Type": "application/json" });
        await REQUEST(buildApp(), "POST", "/api/planning/respond", JSON.stringify({ sessionId, responses: { confirm: true } }), { "Content-Type": "application/json" });
        await REQUEST(buildApp(), "POST", "/api/planning/respond", JSON.stringify({
          sessionId: sessionId,
          responses: { [PLANNING_DEEPEN_CHECKPOINT_ID]: [PLANNING_DEEPEN_PROCEED_OPTION_ID] },
        }), { "Content-Type": "application/json" });

        const res = await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/create-task",
          JSON.stringify({
            sessionId,
            branchSelection: {
              mode: "project-default",
            },
          }),
          { "Content-Type": "application/json" }
        );

        expect(res.status).toBe(201);
        expect(store.createTask).toHaveBeenCalledWith(
          expect.objectContaining({
            branch: undefined,
            baseBranch: undefined,
          }),
        );
      });

      it("applies shared branchSelection to all planning subtasks", async () => {
        (store.createTask as ReturnType<typeof vi.fn>)
          .mockResolvedValueOnce({
            id: "FN-201",
            description: "First",
            column: "triage",
            dependencies: [],
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          })
          .mockResolvedValueOnce({
            id: "FN-202",
            description: "Second",
            column: "triage",
            dependencies: [],
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          });
        (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValue({});
        (store.logEntry as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

        const startRes = await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/start",
          JSON.stringify({ initialPlan: "Build a user auth system" }),
          { "Content-Type": "application/json" }
        );
        const planningSessionId = startRes.body.sessionId;

        await REQUEST(buildApp(), "POST", "/api/planning/respond", JSON.stringify({ sessionId: planningSessionId, responses: { scope: "medium" } }), { "Content-Type": "application/json" });
        await REQUEST(buildApp(), "POST", "/api/planning/respond", JSON.stringify({ sessionId: planningSessionId, responses: { requirements: "Must have login" } }), { "Content-Type": "application/json" });
        await REQUEST(buildApp(), "POST", "/api/planning/respond", JSON.stringify({ sessionId: planningSessionId, responses: { confirm: true } }), { "Content-Type": "application/json" });
        await REQUEST(buildApp(), "POST", "/api/planning/respond", JSON.stringify({
          sessionId: planningSessionId,
          responses: { [PLANNING_DEEPEN_CHECKPOINT_ID]: [PLANNING_DEEPEN_PROCEED_OPTION_ID] },
        }), { "Content-Type": "application/json" });

        const res = await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/create-tasks",
          JSON.stringify({
            planningSessionId,
            branchSelection: { mode: "custom-new", branchName: "feature/auth-slice", baseBranch: "main" },
            branchAssignment: { mode: "shared" },
            subtasks: [
              {
                id: "subtask-1",
                title: "Auth backend",
                description: "Implement backend",
                suggestedSize: "M",
                priority: "urgent",
                dependsOn: [],
              },
              {
                id: "subtask-2",
                title: "Auth UI",
                description: "Implement UI",
                suggestedSize: "S",
                dependsOn: ["subtask-1"],
              },
            ],
          }),
          { "Content-Type": "application/json" }
        );

        expect(res.status).toBe(201);
        expect(store.ensureBranchGroupForSource).toHaveBeenCalledWith(
          "planning",
          planningSessionId,
          expect.objectContaining({ branchName: "feature/auth-slice", autoMerge: false }),
        );
        expect(store.getBranchGroupBySource).toHaveBeenCalledWith("planning", planningSessionId);
        const firstCreateCall = (store.createTask as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
        const secondCreateCall = (store.createTask as ReturnType<typeof vi.fn>).mock.calls[1]?.[0];

        // U1: branchContext.groupId carries the real BranchGroup id, not the synthetic `planning:<id>` string.
        expect(firstCreateCall).toMatchObject({
          branch: "feature/auth-slice/auth-backend",
          baseBranch: "main",
          branchContext: {
            groupId: `BG-planning-${planningSessionId}`,
            source: "planning",
            assignmentMode: "shared",
            inheritedBaseBranch: "main",
          },
        });
        expect(secondCreateCall).toMatchObject({
          branch: "feature/auth-slice/auth-ui",
          baseBranch: "main",
          branchContext: {
            groupId: `BG-planning-${planningSessionId}`,
            source: "planning",
            assignmentMode: "shared",
            inheritedBaseBranch: "main",
          },
        });
        expect(firstCreateCall?.branch).not.toBe("feature/auth-slice");
        expect(secondCreateCall?.branch).not.toBe("feature/auth-slice");
        expect(firstCreateCall?.branch).not.toBe(secondCreateCall?.branch);
      });

      it("ensures shared branch groups when creating subtask breakdown tasks", async () => {
        (store.createTask as ReturnType<typeof vi.fn>)
          .mockResolvedValueOnce({
            id: "FN-281",
            description: "First",
            column: "triage",
            dependencies: [],
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          })
          .mockResolvedValueOnce({
            id: "FN-282",
            description: "Second",
            column: "triage",
            dependencies: [],
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          });

        const subtaskRes = await REQUEST(
          buildApp(),
          "POST",
          "/api/subtasks/start-streaming",
          JSON.stringify({ description: "Break down auth scope" }),
          { "Content-Type": "application/json" },
        );
        expect(subtaskRes.status).toBe(201);

        const sessionId = subtaskRes.body.sessionId as string;
        const createRes = await REQUEST(
          buildApp(),
          "POST",
          "/api/subtasks/create-tasks",
          JSON.stringify({
            sessionId,
            branchSelection: { mode: "custom-new", branchName: "feature/auth-breakdown", baseBranch: "main" },
            branchAssignment: { mode: "shared" },
            subtasks: [
              { tempId: "temp-1", title: "Auth backend", description: "Implement backend" },
              { tempId: "temp-2", title: "Auth UI", description: "Implement UI", dependsOn: ["temp-1"] },
            ],
          }),
          { "Content-Type": "application/json" },
        );

        expect(createRes.status).toBe(201);
        expect(store.ensureBranchGroupForSource).toHaveBeenCalledWith(
          "planning",
          sessionId,
          expect.objectContaining({ branchName: "feature/auth-breakdown", autoMerge: false }),
        );
        expect(store.getBranchGroupBySource).toHaveBeenCalledWith("planning", sessionId);
        const firstCreateCall = (store.createTask as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
        const secondCreateCall = (store.createTask as ReturnType<typeof vi.fn>).mock.calls[1]?.[0];
        expect(firstCreateCall?.branch).toBe("feature/auth-breakdown/auth-backend");
        expect(secondCreateCall?.branch).toBe("feature/auth-breakdown/auth-ui");
        expect(firstCreateCall?.branch).not.toBe("feature/auth-breakdown");
        expect(secondCreateCall?.branch).not.toBe("feature/auth-breakdown");
        expect(firstCreateCall?.branch).not.toBe(secondCreateCall?.branch);
        // U1: branchContext.groupId carries the real BranchGroup id, not the synthetic `planning:<id>` string.
        expect(firstCreateCall?.branchContext).toMatchObject({
          groupId: `BG-planning-${sessionId}`,
          source: "planning",
          assignmentMode: "shared",
        });
        expect(secondCreateCall?.branchContext).toMatchObject({
          groupId: `BG-planning-${sessionId}`,
          source: "planning",
          assignmentMode: "shared",
        });
      });

      it("prefers session autoMerge override when creating shared planning subtasks", async () => {
        (store.createTask as ReturnType<typeof vi.fn>)
          .mockResolvedValueOnce({
            id: "FN-301",
            description: "First",
            column: "triage",
            dependencies: [],
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          })
          .mockResolvedValueOnce({
            id: "FN-302",
            description: "Second",
            column: "triage",
            dependencies: [],
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          });

        const startRes = await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/start",
          JSON.stringify({ initialPlan: "Build a user auth system" }),
          { "Content-Type": "application/json" }
        );
        const planningSessionId = startRes.body.sessionId;

        await REQUEST(buildApp(), "POST", "/api/planning/respond", JSON.stringify({ sessionId: planningSessionId, responses: { scope: "medium" } }), { "Content-Type": "application/json" });
        await REQUEST(buildApp(), "POST", "/api/planning/respond", JSON.stringify({ sessionId: planningSessionId, responses: { requirements: "Must have login" } }), { "Content-Type": "application/json" });
        await REQUEST(buildApp(), "POST", "/api/planning/respond", JSON.stringify({ sessionId: planningSessionId, responses: { confirm: true } }), { "Content-Type": "application/json" });
        await REQUEST(buildApp(), "POST", "/api/planning/respond", JSON.stringify({
          sessionId: planningSessionId,
          responses: { [PLANNING_DEEPEN_CHECKPOINT_ID]: [PLANNING_DEEPEN_PROCEED_OPTION_ID] },
        }), { "Content-Type": "application/json" });

        const session = await planningModule.getSession(planningSessionId);
        if (!session) {
          throw new Error("Expected planning session to exist");
        }
        session.autoMerge = true;

        const res = await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/create-tasks",
          JSON.stringify({
            planningSessionId,
            branchSelection: { mode: "custom-new", branchName: "feature/auth-slice", baseBranch: "main" },
            branchAssignment: { mode: "shared" },
            subtasks: [
              { id: "subtask-1", title: "Auth backend", description: "Implement backend", dependsOn: [] },
              { id: "subtask-2", title: "Auth UI", description: "Implement UI", dependsOn: [] },
            ],
          }),
          { "Content-Type": "application/json" }
        );

        expect(res.status).toBe(201);
        expect(store.ensureBranchGroupForSource).toHaveBeenCalledWith(
          "planning",
          planningSessionId,
          expect.objectContaining({ branchName: "feature/auth-slice", autoMerge: true }),
        );
      });

      it("returns 400 if session is not complete", async () => {
        // Create a session but don't complete it
        const startRes = await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/start",
          JSON.stringify({ initialPlan: "Build a user auth system" }),
          { "Content-Type": "application/json" }
        );
        const sessionId = startRes.body.sessionId;

        const res = await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/create-task",
          JSON.stringify({ sessionId }),
          { "Content-Type": "application/json" }
        );

        expect(res.status).toBe(400);
        expect(res.body.error).toContain("not complete");
      });

      it("returns 404 for invalid session ID", async () => {
        const res = await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/create-task",
          JSON.stringify({ sessionId: "invalid-session-id" }),
          { "Content-Type": "application/json" }
        );

        expect(res.status).toBe(404);
        expect(res.body.error).toContain("not found");
      });

      it("requires sessionId in body", async () => {
        const res = await REQUEST(
          buildApp(),
          "POST",
          "/api/planning/create-task",
          JSON.stringify({}),
          { "Content-Type": "application/json" }
        );

        expect(res.status).toBe(400);
        expect(res.body.error).toContain("sessionId is required");
      });
    });
});

/**
 * Saturated-slot regression coverage for utility AI routes.
 * These tests prove that planning, subtask, and interview routes remain executable
 * when the task-lane is saturated (maxConcurrent = 0).
 *
 * UTILITY PATH contract: These routes are on the heartbeat control-plane lane
 * and must NOT be gated on task-lane saturation (maxConcurrent, semaphore, queue depth).
 *
 * See .fusion/memory/MEMORY.md "Heartbeat Control-Plane Lane (FN-1487)"
 */
describe("Saturated-slot regression: utility AI routes", () => {
  /**
   * Helper to create a store with saturated settings (maxConcurrent = 0).
   * This simulates the task-lane being fully saturated.
   */
  function createSaturatedStore(overrides: Partial<TaskStore> = {}): TaskStore {
    return createMockStore({
      getSettings: vi.fn().mockResolvedValue({
        maxConcurrent: 0, // SATURATED: zero task slots available
        promptOverrides: {},
      }),
      getSettingsFast: vi.fn().mockResolvedValue({
        maxConcurrent: 0,
      }),
      ...overrides,
    } as Partial<TaskStore>);
  }

  /**
   * Helper to create an app with saturated settings and optional aiSessionStore.
   */
  function buildSaturatedApp(options: { aiSessionStore?: any } = {}) {
    const store = createSaturatedStore();
    const app = express();
    app.use(express.json());
    const routeOptions = options.aiSessionStore ? { aiSessionStore: options.aiSessionStore } : undefined;
    app.use("/api", createApiRoutes(store, routeOptions as any));
    return { app, store };
  }

  /**
   * Setup a mock agent for planning session tests.
   */
  function setupSaturatedPlanningMockAgent() {
    const questionResponses = [
      JSON.stringify({
        type: "question",
        data: {
          id: "q-scope",
          type: "single_select",
          question: "What is the scope?",
          description: "Choose scope.",
          options: [
            { id: "small", label: "Small" },
            { id: "medium", label: "Medium" },
            { id: "large", label: "Large" },
          ],
        },
      }),
      JSON.stringify({
        type: "question",
        data: {
          id: "q-req",
          type: "text",
          question: "Requirements?",
        },
      }),
      JSON.stringify({
        type: "complete",
        data: {
          title: "Saturated Plan",
          description: "A plan created under saturation",
          suggestedSize: "M",
          suggestedDependencies: [],
          keyDeliverables: ["Item 1", "Item 2"],
        },
      }),
    ];

    const messages: Array<{ role: string; content: string }> = [];
    let callIndex = 0;
    const mockAgent = {
      session: {
        state: { messages },
        prompt: vi.fn(async (msg: string) => {
          messages.push({ role: "user", content: msg });
          const response = questionResponses[callIndex++] ?? questionResponses[questionResponses.length - 1];
          messages.push({ role: "assistant", content: response });
        }),
        dispose: vi.fn(),
      },
    };
    __setCreateFnAgent(async () => mockAgent);
  }

  describe("POST /api/planning/start — utility lane independence", () => {
    beforeEach(() => {
      __resetPlanningState();
      setupSaturatedPlanningMockAgent();
    });

    afterEach(() => {
      __setCreateFnAgent(undefined as any);
    });

    it("executes successfully when task-lane is saturated (maxConcurrent=0)", async () => {
      const { app } = buildSaturatedApp();

      const res = await REQUEST(
        app,
        "POST",
        "/api/planning/start",
        JSON.stringify({ initialPlan: "Plan a feature under saturated task-lane" }),
        { "Content-Type": "application/json" },
      );

      // UTILITY PATH: Planning start must NOT be gated on maxConcurrent
      expect(res.status).toBe(201);
      expect(res.body.sessionId).toBeDefined();
      expect(res.body.firstQuestion).toBeDefined();
    });
  });

  describe("POST /api/planning/start-streaming — utility lane independence", () => {
    beforeEach(() => {
      __resetPlanningState();
    });

    afterEach(() => {
      __setCreateFnAgent(undefined as any);
    });

    it("executes successfully when task-lane is saturated (maxConcurrent=0)", async () => {
      // Mock agent for streaming
      const messages: Array<{ role: string; content: string }> = [];
      const mockAgent = {
        session: {
          state: { messages },
          prompt: vi.fn(async (msg: string) => {
            messages.push({ role: "user", content: msg });
            messages.push({
              role: "assistant",
              content: JSON.stringify({
                type: "question",
                data: { id: "q-scope", type: "text", question: "What to plan?" },
              }),
            });
          }),
          dispose: vi.fn(),
        },
      };
      __setCreateFnAgent(async () => mockAgent);

      const { app } = buildSaturatedApp();

      const res = await REQUEST(
        app,
        "POST",
        "/api/planning/start-streaming",
        JSON.stringify({ initialPlan: "Streaming plan under saturation" }),
        { "Content-Type": "application/json" },
      );

      // UTILITY PATH: Planning streaming must NOT be gated on maxConcurrent
      expect(res.status).toBe(201);
      expect(res.body.sessionId).toBeDefined();
    });
  });

  describe("POST /api/planning/respond — utility lane independence", () => {
    beforeEach(() => {
      __resetPlanningState();
      setupSaturatedPlanningMockAgent();
    });

    afterEach(() => {
      __setCreateFnAgent(undefined as any);
    });

    it("executes successfully when task-lane is saturated (maxConcurrent=0)", async () => {
      const { app } = buildSaturatedApp();

      // First create a session
      const startRes = await REQUEST(
        app,
        "POST",
        "/api/planning/start",
        JSON.stringify({ initialPlan: "Test respond under saturation" }),
        { "Content-Type": "application/json" },
      );
      expect(startRes.status).toBe(201);
      const sessionId = startRes.body.sessionId;

      // Submit response - must NOT be blocked by maxConcurrent
      const res = await REQUEST(
        app,
        "POST",
        "/api/planning/respond",
        JSON.stringify({ sessionId, responses: { scope: "medium" } }),
        { "Content-Type": "application/json" },
      );

      expect(res.status).toBe(200);
      expect(res.body.type).toBe("question");
    });

    it("preserves lock-conflict 409 semantics when task-lane is saturated", async () => {
      // Create mock aiSessionStore that returns conflict on acquire
      const mockAiSessionStore = {
        acquireLock: vi.fn().mockReturnValue({ acquired: false, currentHolder: "tab-a" }),
        releaseLock: vi.fn(),
      };

      const { app } = buildSaturatedApp({ aiSessionStore: mockAiSessionStore });

      // Create session
      const startRes = await REQUEST(
        app,
        "POST",
        "/api/planning/start",
        JSON.stringify({ initialPlan: "Test respond lock under saturation" }),
        { "Content-Type": "application/json" },
      );
      expect(startRes.status).toBe(201);
      const sessionId = startRes.body.sessionId;

      // Respond with conflicting tabId - mock returns conflict
      const conflictRes = await REQUEST(
        app,
        "POST",
        "/api/planning/respond",
        JSON.stringify({ sessionId, responses: { scope: "medium" }, tabId: "tab-b" }),
        { "Content-Type": "application/json" },
      );

      expect(conflictRes.status).toBe(409);
      expect(conflictRes.body).toEqual({
        error: "Session locked by another tab",
        lockedByTab: "tab-a",
      });
    });
  });

  describe("POST /api/planning/:sessionId/retry — utility lane independence", () => {
    it("executes successfully when task-lane is saturated (maxConcurrent=0)", async () => {
      const retrySpy = vi.spyOn(planningModule, "retrySession").mockResolvedValue();
      const { app } = buildSaturatedApp();

      const res = await REQUEST(app, "POST", "/api/planning/session-sat-retry/retry");

      // UTILITY PATH: Planning retry must NOT be gated on maxConcurrent
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, sessionId: "session-sat-retry" });
      expect(retrySpy).toHaveBeenCalled();
    });

    it("preserves lock-conflict 409 semantics when task-lane is saturated", async () => {
      // Create mock that returns conflict
      const mockAiSessionStore = {
        acquireLock: vi.fn().mockReturnValue({ acquired: false, currentHolder: "tab-x" }),
        releaseLock: vi.fn(),
      };

      const { app } = buildSaturatedApp({ aiSessionStore: mockAiSessionStore });

      const conflictRes = await REQUEST(
        app,
        "POST",
        "/api/planning/session-locked-retry/retry",
        JSON.stringify({ tabId: "tab-y" }),
        { "Content-Type": "application/json" },
      );

      expect(conflictRes.status).toBe(409);
      expect(conflictRes.body).toEqual({
        error: "Session locked by another tab",
        lockedByTab: "tab-x",
      });
    });
  });

  describe("POST /api/subtasks/start-streaming — utility lane independence", () => {
    it("executes successfully when task-lane is saturated (maxConcurrent=0)", async () => {
      // Mock the subtask breakdown module to return proper format
      const mockCreateSubtaskSession = vi.fn().mockResolvedValue({ sessionId: "subtask-sat-session" });
      vi.spyOn(subtaskBreakdownModule, "createSubtaskSession").mockImplementation(mockCreateSubtaskSession);

      try {
        const { app } = buildSaturatedApp();

        const res = await REQUEST(
          app,
          "POST",
          "/api/subtasks/start-streaming",
          JSON.stringify({ description: "Break into subtasks under saturation" }),
          { "Content-Type": "application/json" },
        );

        // UTILITY PATH: Subtask start must NOT be gated on maxConcurrent
        expect(res.status).toBe(201);
        expect(res.body.sessionId).toBeDefined();
        expect(mockCreateSubtaskSession).toHaveBeenCalled();
      } finally {
        vi.restoreAllMocks();
      }
    });
  });

  describe("POST /api/subtasks/:sessionId/retry — utility lane independence", () => {
    it("executes successfully when task-lane is saturated (maxConcurrent=0)", async () => {
      const retrySpy = vi.spyOn(subtaskBreakdownModule, "retrySubtaskSession").mockResolvedValue();
      const { app } = buildSaturatedApp();

      const res = await REQUEST(app, "POST", "/api/subtasks/session-sat-retry/retry");

      // UTILITY PATH: Subtask retry must NOT be gated on maxConcurrent
      expect(res.status).toBe(200);
      expect(retrySpy).toHaveBeenCalled();
    });

    it("preserves lock-conflict 409 semantics when task-lane is saturated", async () => {
      // Create mock that returns conflict
      const mockAiSessionStore = {
        acquireLock: vi.fn().mockReturnValue({ acquired: false, currentHolder: "tab-locked" }),
        releaseLock: vi.fn(),
      };

      const { app } = buildSaturatedApp({ aiSessionStore: mockAiSessionStore });

      const conflictRes = await REQUEST(
        app,
        "POST",
        "/api/subtasks/subtask-locked-retry/retry",
        JSON.stringify({ tabId: "tab-conflict" }),
        { "Content-Type": "application/json" },
      );

      expect(conflictRes.status).toBe(409);
      expect(conflictRes.body).toEqual({
        error: "Session locked by another tab",
        lockedByTab: "tab-locked",
      });
    });
  });
});

/**
 * Saturated-slot regression coverage for heartbeat wake routes.
 * These tests prove that comment-triggered and steering-triggered heartbeat wake
 * paths remain executable when the task-lane is saturated.
 *
 * UTILITY PATH contract: Wake delegation (heartbeatMonitor.executeHeartbeat) is on
 * the heartbeat control-plane lane and must NOT be gated on task-lane saturation.
 *
 * See .fusion/memory/MEMORY.md "Heartbeat Control-Plane Lane (FN-1487)"
 */
describe("Saturated-slot regression: heartbeat wake routes", () => {
  /**
   * Helper to create a store with saturated settings (maxConcurrent = 0).
   */
  function createSaturatedStore(overrides: Partial<TaskStore> = {}): TaskStore {
    return createMockStore({
      getSettings: vi.fn().mockResolvedValue({
        maxConcurrent: 0, // SATURATED: zero task slots available
        promptOverrides: {},
      }),
      getSettingsFast: vi.fn().mockResolvedValue({
        maxConcurrent: 0,
      }),
      ...overrides,
    } as Partial<TaskStore>);
  }

  describe("POST /api/tasks/:id/comments — utility lane independence", () => {
    it("triggers heartbeat wake for assigned agent when task-lane is saturated", async () => {
      const fusionDir = "/fake/root/.fusion";

      try {
        const { AgentStore } = await import("@fusion/core");
      /*
      FNXC:PostgresCutover 2026-07-05-16:50:
      The legacy `new AgentStore({ rootDir })` runtime was removed
      (VAL-REMOVAL-005); spy on the prototype instead of seeding a real
      on-disk agent store. The invariant under test is lane independence of
      the ROUTE under maxConcurrent=0, not AgentStore persistence.
      */
        const agent = { id: "agent-sat-1", name: "Saturated Wake Agent", role: "executor", state: "idle", runtimeConfig: { messageResponseMode: "immediate" } };
        vi.spyOn(AgentStore.prototype, "init").mockResolvedValue(undefined);
        vi.spyOn(AgentStore.prototype, "getAgent").mockResolvedValue(agent as never);
        vi.spyOn(AgentStore.prototype, "getActiveHeartbeatRun").mockResolvedValue(null);

        const heartbeatMonitor = {
          executeHeartbeat: vi.fn().mockResolvedValue({ id: "run-sat-1" }),
        };

        const updatedTask = {
          ...FAKE_TASK_DETAIL,
          id: "KB-SAT-001",
          assignedAgentId: agent.id,
          comments: [{ id: "comment-sat-1", text: "Hello", author: "user", createdAt: "2026-01-01T00:00:00.000Z" }],
        };

        const store = createSaturatedStore({
          addTaskComment: vi.fn().mockResolvedValue(updatedTask),
          getFusionDir: vi.fn().mockReturnValue(fusionDir),
        });

        const app = express();
        app.use(express.json());
        app.use("/api", createApiRoutes(store, { heartbeatMonitor } as any));

        const res = await REQUEST(
          app,
          "POST",
          "/api/tasks/KB-SAT-001/comments",
          JSON.stringify({ text: "Hello" }),
          { "Content-Type": "application/json" },
        );

        expect(res.status).toBe(200);
        // UTILITY PATH: Wake must NOT be blocked by maxConcurrent=0
        await vi.waitFor(() => {
          expect(heartbeatMonitor.executeHeartbeat).toHaveBeenCalledWith(expect.objectContaining({
            agentId: agent.id,
            source: "on_demand",
            taskId: "KB-SAT-001",
            triggeringCommentIds: ["comment-sat-1"],
            triggeringCommentType: "task",
          }));
        }, { timeout: 1000 });
      } finally {
        vi.restoreAllMocks();
      }
    });

    it("preserves active-run conflict 409 semantics when task-lane is saturated", async () => {
      const fusionDir = "/fake/root/.fusion";

      try {
        const { AgentStore } = await import("@fusion/core");
      /*
      FNXC:PostgresCutover 2026-07-05-16:50:
      The legacy `new AgentStore({ rootDir })` runtime was removed
      (VAL-REMOVAL-005); spy on the prototype instead of seeding a real
      on-disk agent store. The invariant under test is lane independence of
      the ROUTE under maxConcurrent=0, not AgentStore persistence.
      */
        const agent = { id: "agent-sat-2", name: "Active Run Agent", role: "executor", state: "running", runtimeConfig: { messageResponseMode: "immediate" } };
        vi.spyOn(AgentStore.prototype, "init").mockResolvedValue(undefined);
        vi.spyOn(AgentStore.prototype, "getAgent").mockResolvedValue(agent as never);
        // Existing active heartbeat run: the wake helper must skip.
        vi.spyOn(AgentStore.prototype, "getActiveHeartbeatRun").mockResolvedValue({ id: "run-active" } as never);

        const heartbeatMonitor = {
          executeHeartbeat: vi.fn().mockResolvedValue({ id: "run-sat-2" }),
        };

        const updatedTask = {
          ...FAKE_TASK_DETAIL,
          id: "KB-SAT-002",
          assignedAgentId: agent.id,
          comments: [{ id: "comment-sat-2", text: "Hello", author: "user", createdAt: "2026-01-01T00:00:00.000Z" }],
        };

        const store = createSaturatedStore({
          addTaskComment: vi.fn().mockResolvedValue(updatedTask),
          getFusionDir: vi.fn().mockReturnValue(fusionDir),
        });

        const app = express();
        app.use(express.json());
        app.use("/api", createApiRoutes(store, { heartbeatMonitor } as any));

        const res = await REQUEST(
          app,
          "POST",
          "/api/tasks/KB-SAT-002/comments",
          JSON.stringify({ text: "Hello" }),
          { "Content-Type": "application/json" },
        );

        expect(res.status).toBe(200);
        await Promise.resolve();
        // Active run conflict must still work under saturation
        expect(heartbeatMonitor.executeHeartbeat).not.toHaveBeenCalled();
      } finally {
        vi.restoreAllMocks();
      }
    });
  });

  describe("POST /api/agents/:id/runs — utility lane independence", () => {
    it("accepts triggering comment wake fields when task-lane is saturated", async () => {
      const fusionDir = "/fake/root/.fusion";

      try {
        const { AgentStore } = await import("@fusion/core");
      /*
      FNXC:PostgresCutover 2026-07-05-16:50:
      The legacy `new AgentStore({ rootDir })` runtime was removed
      (VAL-REMOVAL-005); spy on the prototype instead of seeding a real
      on-disk agent store. The record-only run-creation path is exercised via
      startHeartbeatRun/saveRun spies; run enrichment stays real.
      */
        const agent = { id: "agent-sat-run-1", name: "Saturated Run Agent", role: "executor", state: "idle" };
        vi.spyOn(AgentStore.prototype, "init").mockResolvedValue(undefined);
        vi.spyOn(AgentStore.prototype, "getAgent").mockResolvedValue(agent as never);
        vi.spyOn(AgentStore.prototype, "getActiveHeartbeatRun").mockResolvedValue(null);
        vi.spyOn(AgentStore.prototype, "startHeartbeatRun").mockResolvedValue({
          id: "run-sat-created",
          agentId: agent.id,
          startedAt: "2026-01-01T00:00:00.000Z",
          status: "running",
        } as never);
        vi.spyOn(AgentStore.prototype, "saveRun").mockResolvedValue(undefined as never);

        const store = createSaturatedStore({
          getFusionDir: vi.fn().mockReturnValue(fusionDir),
        } as any);

        const app = express();
        app.use(express.json());
        app.use("/api", createApiRoutes(store));

        const res = await REQUEST(
          app,
          "POST",
          `/api/agents/${agent.id}/runs`,
          JSON.stringify({
            source: "on_demand",
            triggerDetail: "task-comment",
            taskId: "FN-SAT-001",
            triggeringCommentIds: ["c-sat-1", "c-sat-2"],
            triggeringCommentType: "task",
          }),
          { "Content-Type": "application/json" },
        );

        // UTILITY PATH: Agent run creation must NOT be blocked by maxConcurrent=0
        expect(res.status).toBe(201);
        expect(res.body.contextSnapshot).toMatchObject({
          wakeReason: "on_demand",
          triggerDetail: "task-comment",
          taskId: "FN-SAT-001",
          triggeringCommentIds: ["c-sat-1", "c-sat-2"],
          triggeringCommentType: "task",
        });
      } finally {
        vi.restoreAllMocks();
      }
    });

    it("preserves validation 400 for invalid triggeringCommentIds when task-lane is saturated", async () => {
      const fusionDir = "/fake/root/.fusion";

      try {
        // Validation rejects before any store/agent access, so no seeded
        // agent is required — a fixed id suffices (PostgresCutover port).
        const agent = { id: "agent-sat-validation-1" };

        const store = createSaturatedStore({
          getFusionDir: vi.fn().mockReturnValue(fusionDir),
        } as any);

        const app = express();
        app.use(express.json());
        app.use("/api", createApiRoutes(store));

        // Invalid: triggeringCommentIds is a string, not array
        const res = await REQUEST(
          app,
          "POST",
          `/api/agents/${agent.id}/runs`,
          JSON.stringify({
            source: "on_demand",
            triggeringCommentIds: "not-an-array",
          }),
          { "Content-Type": "application/json" },
        );

        // Validation must still work under saturation
        expect(res.status).toBe(400);
        expect(res.body.error).toContain("triggeringCommentIds must be an array");
      } finally {
        vi.restoreAllMocks();
      }
    }, 15_000);
  });
});

describe("DELETE /api/ai-sessions/cleanup", () => {
  let store: TaskStore;

  beforeEach(() => {
    store = createMockStore();
  });

  it("returns cleanup summary with default maxAgeMs", async () => {
    const mockAiSessionStore = {
      cleanupStaleSessions: vi.fn().mockReturnValue({
        terminalDeleted: 5,
        orphanedDeleted: 2,
        totalDeleted: 7,
      }),
    };

    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store, { aiSessionStore: mockAiSessionStore as any }));

    const res = await REQUEST(app, "DELETE", "/api/ai-sessions/cleanup");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      terminalDeleted: 5,
      orphanedDeleted: 2,
      totalDeleted: 7,
      maxAgeMs: SESSION_CLEANUP_DEFAULT_MAX_AGE_MS,
    });
    expect(mockAiSessionStore.cleanupStaleSessions).toHaveBeenCalledWith(SESSION_CLEANUP_DEFAULT_MAX_AGE_MS);
  });

  it("respects maxAgeMs override and clamps values below one hour", async () => {
    const mockAiSessionStore = {
      cleanupStaleSessions: vi.fn().mockReturnValue({
        terminalDeleted: 1,
        orphanedDeleted: 1,
        totalDeleted: 2,
      }),
    };

    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store, { aiSessionStore: mockAiSessionStore as any }));

    const res = await REQUEST(app, "DELETE", "/api/ai-sessions/cleanup?maxAgeMs=1000");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      terminalDeleted: 1,
      orphanedDeleted: 1,
      totalDeleted: 2,
      maxAgeMs: 60 * 60 * 1000,
    });
    expect(mockAiSessionStore.cleanupStaleSessions).toHaveBeenCalledWith(60 * 60 * 1000);
  });

  it("returns 503 when aiSessionStore is unavailable", async () => {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store));

    const res = await REQUEST(app, "DELETE", "/api/ai-sessions/cleanup");

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: "Session store not available" });
  });
});

// ── FN-7949: delete-mid-generation resurrection race ──────────────────────
// Reproduces the exact reported bug: deleting a Planning Mode session while
// its background generation is still in flight must not let a straggling
// write resurrect it. Uses a REAL AiSessionStore (backed by a temp SQLite
// db) wired the same way server.ts wires it — via setAiSessionStore() for
// planning.ts's internal persistSession() calls AND via the routes.ts
// aiSessionStore option for the DELETE endpoint — so the tombstone guard
// added to AiSessionStore.upsert() is exercised end-to-end, not mocked out.
describe("DELETE /api/ai-sessions/:id mid-generation (FN-7949)", () => {
  let store: TaskStore;
  let db: InstanceType<typeof Database>;
  let realAiSessionStore: AiSessionStore;
  let tmpRoot: string;

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store, { aiSessionStore: realAiSessionStore as any }));
    return app;
  }

  /**
   * Deferred-prompt mock agent: the FIRST prompt() call (triggered by
   * POST /api/planning/start) resolves immediately with a question, so the
   * session reaches `awaiting_input` normally. The SECOND prompt() call
   * (triggered by POST /api/planning/respond) does not resolve until the
   * test explicitly calls `resolveSecondPrompt()` — modeling the abandoned
   * `session.agent.session.prompt()` call that `runGenerationWithTimeout`'s
   * `Promise.race` only stops *awaiting*, not actually cancels.
   */
  function setupDeferredRespondAgent() {
    const messages: Array<{ role: string; content: string }> = [];
    let callIndex = 0;
    let resolveSecondPrompt: (() => void) | undefined;
    const secondPromptStarted = new Promise<void>((resolveStarted) => {
      const mockAgent = {
        session: {
          state: { messages },
          prompt: vi.fn(async (msg: string) => {
            messages.push({ role: "user", content: msg });
            if (callIndex === 0) {
              callIndex++;
              messages.push({
                role: "assistant",
                content: JSON.stringify({
                  type: "question",
                  data: { id: "q-scope", type: "text", question: "What is the scope?" },
                }),
              });
              return;
            }
            callIndex++;
            await new Promise<void>((resolve) => {
              resolveSecondPrompt = resolve;
              resolveStarted();
            });
            messages.push({
              role: "assistant",
              content: JSON.stringify({
                type: "complete",
                data: { title: "Late-landing plan", description: "Should never be seen", suggestedSize: "S" },
              }),
            });
          }),
          dispose: vi.fn(),
        },
      };
      __setCreateFnAgent(async () => mockAgent);
    });

    return {
      secondPromptStarted,
      resolveSecondPrompt: () => resolveSecondPrompt?.(),
    };
  }

  beforeEach(() => {
    store = createMockStore();
    __resetPlanningState();
    tmpRoot = mkdtempSync(join(tmpdir(), "kb-fn7949-ai-session-"));
    db = new Database(join(tmpRoot, ".fusion"));
    db.init();
    realAiSessionStore = new AiSessionStore(db as any);
    setAiSessionStore(realAiSessionStore);
  });

  afterEach(async () => {
    __setCreateFnAgent(undefined as any);
    __resetPlanningState();
    realAiSessionStore.stopScheduledCleanup();
    try {
      db.close();
    } catch {
      // no-op
    }
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("does not resurrect a session deleted while a generation is still in flight", async () => {
    const { secondPromptStarted, resolveSecondPrompt } = setupDeferredRespondAgent();

    const startRes = await REQUEST(
      buildApp(),
      "POST",
      "/api/planning/start",
      JSON.stringify({ initialPlan: "Deleted mid-generation planning session" }),
      { "Content-Type": "application/json" },
    );
    expect(startRes.status).toBe(201);
    const sessionId = startRes.body.sessionId as string;
    expect(realAiSessionStore.get(sessionId)).not.toBeNull();
    expect(realAiSessionStore.get(sessionId)?.status).toBe("awaiting_input");

    // Fire the respond call WITHOUT awaiting it — its underlying prompt()
    // call is deferred and will not resolve until we explicitly release it
    // below, simulating the straggling in-flight generation from FN-7949.
    const respondPromise = REQUEST(
      buildApp(),
      "POST",
      "/api/planning/respond",
      JSON.stringify({ sessionId, responses: { "q-scope": "medium" } }),
      { "Content-Type": "application/json" },
    );

    // Wait for the second prompt() call to actually start (i.e. respond's
    // synchronous persistSession(session, "generating") has already run and
    // execution is now parked awaiting the deferred prompt).
    await secondPromptStarted;

    // Delete the session while that generation is still in flight — the
    // exact FN-7949 reproduction step.
    const deleteRes = await REQUEST(buildApp(), "DELETE", `/api/ai-sessions/${sessionId}`);
    expect(deleteRes.status).toBe(200);
    expect(deleteRes.body).toEqual({ ok: true });
    expect(realAiSessionStore.get(sessionId)).toBeNull();

    const updatedEventIds: string[] = [];
    realAiSessionStore.on("ai_session:updated", (summary) => updatedEventIds.push(summary.id));

    // Let the abandoned prompt() call resolve — the straggling write lands
    // after the session was already deleted.
    resolveSecondPrompt();
    await respondPromise.catch(() => {
      // The request may resolve or reject depending on how far the aborted
      // in-memory session state got; either is fine — what matters is the
      // store-level assertion below.
    });

    // The deleted session must not have been resurrected, and no
    // ai_session:updated event should have fired for it.
    expect(realAiSessionStore.get(sessionId)).toBeNull();
    expect(updatedEventIds).not.toContain(sessionId);
  });

  it("a normal delete with no in-flight generation continues to work exactly as before", async () => {
    setupPlanningMockAgentForFn7949();

    const startRes = await REQUEST(
      buildApp(),
      "POST",
      "/api/planning/start",
      JSON.stringify({ initialPlan: "Ordinary planning session, deleted cleanly" }),
      { "Content-Type": "application/json" },
    );
    expect(startRes.status).toBe(201);
    const sessionId = startRes.body.sessionId as string;
    expect(realAiSessionStore.get(sessionId)).not.toBeNull();

    const deleteRes = await REQUEST(buildApp(), "DELETE", `/api/ai-sessions/${sessionId}`);

    expect(deleteRes.status).toBe(200);
    expect(deleteRes.body).toEqual({ ok: true });
    expect(realAiSessionStore.get(sessionId)).toBeNull();
  });

  function setupPlanningMockAgentForFn7949() {
    const messages: Array<{ role: string; content: string }> = [];
    const mockAgent = {
      session: {
        state: { messages },
        prompt: vi.fn(async (msg: string) => {
          messages.push({ role: "user", content: msg });
          messages.push({
            role: "assistant",
            content: JSON.stringify({
              type: "question",
              data: { id: "q-scope", type: "text", question: "What is the scope?" },
            }),
          });
        }),
        dispose: vi.fn(),
      },
    };
    __setCreateFnAgent(async () => mockAgent);
  }
});

describe("POST /api/ai-sessions/:id/ping", () => {
  let store: TaskStore;

  beforeEach(() => {
    store = createMockStore();
  });

  it("returns 200 when the session exists", async () => {
    const mockAiSessionStore = {
      ping: vi.fn().mockReturnValue(true),
    };

    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store, { aiSessionStore: mockAiSessionStore as any }));

    const res = await REQUEST(app, "POST", "/api/ai-sessions/session-123/ping");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(mockAiSessionStore.ping).toHaveBeenCalledWith("session-123");
  });

  it("returns 404 when the session does not exist", async () => {
    const mockAiSessionStore = {
      ping: vi.fn().mockReturnValue(false),
    };

    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store, { aiSessionStore: mockAiSessionStore as any }));

    const res = await REQUEST(app, "POST", "/api/ai-sessions/missing-session/ping");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Session not found" });
    expect(mockAiSessionStore.ping).toHaveBeenCalledWith("missing-session");
  });
});

// ── AI Summarize Title Routes ───────────────────────────────────────────────
// Tests for FN-1730: Lane precedence regression for title summarization endpoint
// Model resolution hierarchy:
// 1. Request body provider + modelId (explicit override)
// 2. Project titleSummarizerProvider + titleSummarizerModelId (project lane)
// 3. Global titleSummarizerGlobalProvider + titleSummarizerGlobalModelId (global lane)
// 4. Default defaultProvider + defaultModelId (default fallback)
//
// Note: These tests verify that the route accepts the correct parameters and validates
// them properly. The actual AI summarization is tested separately in the core package.
// The lane precedence behavior is verified through integration tests.

describe("POST /api/ai/summarize-title", () => {
  let store: TaskStore;

  beforeEach(() => {
    store = createMockStore({
      getRootDir: vi.fn().mockReturnValue("/test/project"),
    });
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

  it("validates description is required", async () => {
    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/ai/summarize-title",
      JSON.stringify({}),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("description");
  });

  it("validates description must be a string", async () => {
    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/ai/summarize-title",
      JSON.stringify({ description: 123 }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("description");
  });

  it("validates description length (minimum 200 characters)", async () => {
    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/ai/summarize-title",
      JSON.stringify({
        description: "Short description",
      }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("at least 201 characters");
  });

  it("accepts optional provider and modelId parameters", async () => {
    const fusionCore = await import("@fusion/core");
    const summarizeTitleSpy = vi
      .spyOn(fusionCore, "summarizeTitle")
      .mockResolvedValueOnce("Generated title");

    const description = "x".repeat(300);
    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/ai/summarize-title",
      JSON.stringify({
        description,
        provider: "google",
        modelId: "gemini-2.5-pro",
      }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ title: "Generated title" });
    expect(summarizeTitleSpy).toHaveBeenCalledWith(
      description,
      "/test/project",
      "google",
      "gemini-2.5-pro",
    );
  });

  it("accepts descriptions longer than 2000 characters", async () => {
    const fusionCore = await import("@fusion/core");
    const summarizeTitleSpy = vi
      .spyOn(fusionCore, "summarizeTitle")
      .mockResolvedValueOnce("Generated title");

    const description = "x".repeat(5000);
    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/ai/summarize-title",
      JSON.stringify({ description }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ title: "Generated title" });
    expect(summarizeTitleSpy).toHaveBeenCalledWith(
      description,
      "/test/project",
      undefined,
      undefined,
    );
  });

  it("emits structured diagnostics for unexpected summarize failures", async () => {
    const diagnostics = captureDiagnostics();
    const fusionCore = await import("@fusion/core");
    vi.spyOn(fusionCore, "summarizeTitle").mockRejectedValueOnce(new Error("summarize boom"));

    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/ai/summarize-title",
      JSON.stringify({ description: "x".repeat(300) }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(500);
    expect(res.body.error).toContain("summarize boom");
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        level: "error",
        scope: "ai-summarize",
        message: "Unexpected summarize title error",
        context: expect.objectContaining({
          operation: "summarize-title",
          error: expect.objectContaining({ message: "summarize boom" }),
        }),
      }),
    );
  });

  it("emits debug-gated summarize request and model diagnostics when FUSION_DEBUG_AI is enabled", async () => {
    const diagnostics = captureDiagnostics();
    const fusionCore = await import("@fusion/core");
    vi.spyOn(fusionCore, "summarizeTitle").mockResolvedValueOnce("Generated title");

    const previousDebug = process.env.FUSION_DEBUG_AI;
    process.env.FUSION_DEBUG_AI = "1";

    try {
      const description = "x".repeat(320);
      const res = await REQUEST(
        buildApp(),
        "POST",
        "/api/ai/summarize-title",
        JSON.stringify({
          description,
          provider: "google",
          modelId: "gemini-2.5-pro",
        }),
        { "Content-Type": "application/json" },
      );

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ title: "Generated title" });
      expect(diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            level: "info",
            scope: "ai-summarize",
            message: "Summarize title request",
            context: expect.objectContaining({
              descriptionLength: description.length,
              operation: "summarize-title-request",
            }),
          }),
          expect.objectContaining({
            level: "info",
            scope: "ai-summarize",
            message: "Summarize title model resolved",
            context: expect.objectContaining({
              provider: "google",
              modelId: "gemini-2.5-pro",
              operation: "summarize-title-model-resolution",
            }),
          }),
        ]),
      );
    } finally {
      if (previousDebug === undefined) {
        delete process.env.FUSION_DEBUG_AI;
      } else {
        process.env.FUSION_DEBUG_AI = previousDebug;
      }
    }
  });

  it("uses the project default override for summarize-title when no higher lane is configured", async () => {
    const fusionCore = await import("@fusion/core");
    const summarizeTitleSpy = vi
      .spyOn(fusionCore, "summarizeTitle")
      .mockResolvedValueOnce("Generated title");

    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      defaultProviderOverride: "openai",
      defaultModelIdOverride: "gpt-4o",
      defaultProvider: "anthropic",
      defaultModelId: "claude-sonnet-4-5",
    });

    const description = "x".repeat(300);
    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/ai/summarize-title",
      JSON.stringify({ description }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(200);
    expect(summarizeTitleSpy).toHaveBeenCalledWith(
      description,
      "/test/project",
      "openai",
      "gpt-4o",
    );
  });
});

describe("POST /planning/start-streaming with projectId scoping", () => {
  const projectId = "proj-planning-scoped";

  let defaultStore: TaskStore;
  let scopedStore: TaskStore;

  beforeEach(() => {
    defaultStore = createMockStore();
    scopedStore = createMockStore({
      getRootDir: vi.fn().mockReturnValue("/scoped/planning/project"),
    });

    vi.spyOn(projectStoreResolver, "getOrCreateProjectStore").mockResolvedValue(scopedStore);
    __resetPlanningState();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    __setCreateFnAgent(undefined as any);
  });

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(defaultStore));
    return app;
  }

  it("uses scoped store settings for prompt resolution when projectId is provided", async () => {
    const customPlanningPrompt = "CUSTOM SCOPED PLANNING PROMPT";
    (scopedStore.getSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      promptOverrides: {
        "planning-system": customPlanningPrompt,
      },
      defaultProvider: "scoped-provider",
      defaultModelId: "scoped-model",
    });

    const mockAgent = {
      session: {
        state: { messages: [] },
        prompt: vi.fn(async () => {
          return JSON.stringify({
            type: "question",
            data: { id: "q-1", type: "text", question: "What is the scope?" },
          });
        }),
        dispose: vi.fn(),
      },
    };
    const createFnAgentSpy = vi.fn(async () => mockAgent);
    __setCreateFnAgent(createFnAgentSpy as any);

    const res = await REQUEST(
      buildApp(),
      "POST",
      `/api/planning/start-streaming?projectId=${projectId}`,
      JSON.stringify({ initialPlan: "Test planning" }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(201);
    const streamPromise = REQUEST(buildApp(), "GET", `/api/planning/${res.body.sessionId}/stream`);
    await Promise.resolve();
    planningStreamManager.broadcast(res.body.sessionId, { type: "complete" });
    await streamPromise;
    expect(projectStoreResolver.getOrCreateProjectStore).toHaveBeenCalledWith(projectId);
    expect(scopedStore.getSettings).toHaveBeenCalled();
    expect(scopedStore.getRootDir()).toBe("/scoped/planning/project");
    // Verify scoped settings were used for prompt resolution
    await vi.waitFor(() => {
      expect(createFnAgentSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          systemPrompt: customPlanningPrompt,
          defaultProvider: "scoped-provider",
          defaultModelId: "scoped-model",
        }),
      );
    });
  });

  it("uses request body model override when provided alongside projectId", async () => {
    (scopedStore.getSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      defaultProvider: "scoped-provider",
      defaultModelId: "scoped-model",
    });

    const mockAgent = {
      session: {
        state: { messages: [] },
        prompt: vi.fn(async () => {
          return JSON.stringify({
            type: "question",
            data: { id: "q-1", type: "text", question: "What is the scope?" },
          });
        }),
        dispose: vi.fn(),
      },
    };
    const createFnAgentSpy = vi.fn(async () => mockAgent);
    __setCreateFnAgent(createFnAgentSpy as any);

    const res = await REQUEST(
      buildApp(),
      "POST",
      `/api/planning/start-streaming?projectId=${projectId}`,
      JSON.stringify({
        initialPlan: "Test planning",
        planningModelProvider: "google",
        planningModelId: "gemini-2.5-pro",
      }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(201);
    const streamPromise = REQUEST(buildApp(), "GET", `/api/planning/${res.body.sessionId}/stream`);
    await Promise.resolve();
    planningStreamManager.broadcast(res.body.sessionId, { type: "complete" });
    await streamPromise;
    // Request body override takes precedence over scoped settings
    await vi.waitFor(() => {
      expect(createFnAgentSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          defaultProvider: "google",
          defaultModelId: "gemini-2.5-pro",
        }),
      );
    });
  });

  it("falls back to scoped settings when no request override provided", async () => {
    (scopedStore.getSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      planningProvider: "anthropic",
      planningModelId: "claude-sonnet-4",
    });

    const mockAgent = {
      session: {
        state: { messages: [] },
        prompt: vi.fn(async () => {
          return JSON.stringify({
            type: "question",
            data: { id: "q-1", type: "text", question: "What is the scope?" },
          });
        }),
        dispose: vi.fn(),
      },
    };
    const createFnAgentSpy = vi.fn(async () => mockAgent);
    __setCreateFnAgent(createFnAgentSpy as any);

    const res = await REQUEST(
      buildApp(),
      "POST",
      `/api/planning/start-streaming?projectId=${projectId}`,
      JSON.stringify({ initialPlan: "Test planning" }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(201);
    const streamPromise = REQUEST(buildApp(), "GET", `/api/planning/${res.body.sessionId}/stream`);
    await Promise.resolve();
    planningStreamManager.broadcast(res.body.sessionId, { type: "complete" });
    await streamPromise;
    // Scoped settings planning lane should be used
    await vi.waitFor(() => {
      expect(createFnAgentSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          defaultProvider: "anthropic",
          defaultModelId: "claude-sonnet-4",
        }),
      );
    });
  });

  it("uses default store when projectId is omitted", async () => {
    // When projectId is omitted, default store should be used
    const defaultRootDir = "/fake/root";
    (defaultStore.getRootDir as ReturnType<typeof vi.fn>).mockReturnValue(defaultRootDir);
    (defaultStore.getSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      defaultProvider: "default-provider",
      defaultModelId: "default-model",
    });

    const mockAgent = {
      session: {
        state: { messages: [] },
        prompt: vi.fn(async () => {
          return JSON.stringify({
            type: "question",
            data: { id: "q-1", type: "text", question: "What is the scope?" },
          });
        }),
        dispose: vi.fn(),
      },
    };
    const createFnAgentSpy = vi.fn(async () => mockAgent);
    __setCreateFnAgent(createFnAgentSpy as any);

    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/planning/start-streaming",
      JSON.stringify({ initialPlan: "Test planning" }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(201);
    const streamPromise = REQUEST(buildApp(), "GET", `/api/planning/${res.body.sessionId}/stream`);
    await Promise.resolve();
    planningStreamManager.broadcast(res.body.sessionId, { type: "complete" });
    await streamPromise;
    // Default store should be used (getOrCreateProjectStore should not be called)
    expect(projectStoreResolver.getOrCreateProjectStore).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(createFnAgentSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          defaultProvider: "default-provider",
          defaultModelId: "default-model",
        }),
      );
    });
  });
});

describe("POST /subtasks/start-streaming with projectId scoping", () => {
  const projectId = "proj-subtask-scoped";

  let defaultStore: TaskStore;
  let scopedStore: TaskStore;

  beforeEach(() => {
    defaultStore = createMockStore();
    scopedStore = createMockStore({
      getRootDir: vi.fn().mockReturnValue("/scoped/subtask/project"),
    });

    vi.spyOn(projectStoreResolver, "getOrCreateProjectStore").mockResolvedValue(scopedStore);
    __resetSubtaskBreakdownState();
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

  it("uses scoped store settings for prompt resolution when projectId is provided", async () => {
    const customSubtaskPrompt = "CUSTOM SCOPED SUBTASK BREAKDOWN PROMPT";
    (scopedStore.getSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      promptOverrides: {
        "subtask-breakdown-system": customSubtaskPrompt,
      },
    });

    const mockCreateSubtaskSession = vi.fn().mockResolvedValue({ sessionId: "scoped-subtask-session" });
    vi.spyOn(subtaskBreakdownModule, "createSubtaskSession").mockImplementation(mockCreateSubtaskSession);

    const res = await REQUEST(
      buildApp(),
      "POST",
      `/api/subtasks/start-streaming?projectId=${projectId}`,
      JSON.stringify({ description: "Break into subtasks" }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(201);
    expect(res.body.sessionId).toBe("scoped-subtask-session");
    expect(projectStoreResolver.getOrCreateProjectStore).toHaveBeenCalledWith(projectId);
    expect(scopedStore.getSettings).toHaveBeenCalled();
    expect(scopedStore.getRootDir()).toBe("/scoped/subtask/project");
    // Verify scoped settings were passed for prompt resolution
    expect(mockCreateSubtaskSession).toHaveBeenCalledWith(
      "Break into subtasks",
      scopedStore,
      "/scoped/subtask/project",
      expect.objectContaining({
        "subtask-breakdown-system": customSubtaskPrompt,
      }),
      projectId,
    );
  });

  it("uses scoped rootDir for subtask generation", async () => {
    const scopedRootDir = "/different/scoped/root";
    scopedStore = createMockStore({
      getRootDir: vi.fn().mockReturnValue(scopedRootDir),
    });
    vi.spyOn(projectStoreResolver, "getOrCreateProjectStore").mockResolvedValue(scopedStore);

    (scopedStore.getSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      promptOverrides: {},
    });

    const mockCreateSubtaskSession = vi.fn().mockResolvedValue({ sessionId: "session-2" });
    vi.spyOn(subtaskBreakdownModule, "createSubtaskSession").mockImplementation(mockCreateSubtaskSession);

    const res = await REQUEST(
      buildApp(),
      "POST",
      `/api/subtasks/start-streaming?projectId=${projectId}`,
      JSON.stringify({ description: "Break into subtasks" }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(201);
    expect(mockCreateSubtaskSession).toHaveBeenCalledWith(
      "Break into subtasks",
      scopedStore,
      scopedRootDir,
      expect.any(Object),
      projectId,
    );
  });

  it("uses default store when projectId is omitted", async () => {
    // When projectId is omitted, default store should be used
    const defaultRootDir = "/fake/root";
    (defaultStore.getRootDir as ReturnType<typeof vi.fn>).mockReturnValue(defaultRootDir);
    (defaultStore.getSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      promptOverrides: {
        "subtask-breakdown-system": "Default subtask prompt",
      },
    });

    const mockCreateSubtaskSession = vi.fn().mockResolvedValue({ sessionId: "default-session" });
    vi.spyOn(subtaskBreakdownModule, "createSubtaskSession").mockImplementation(mockCreateSubtaskSession);

    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/subtasks/start-streaming",
      JSON.stringify({ description: "Break into subtasks" }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(201);
    // Default store should be used (getOrCreateProjectStore should not be called)
    expect(projectStoreResolver.getOrCreateProjectStore).not.toHaveBeenCalled();
    expect(mockCreateSubtaskSession).toHaveBeenCalledWith(
      "Break into subtasks",
      defaultStore,
      defaultRootDir,
      expect.any(Object),
      undefined,
    );
  });

  it("passes projectId to subtask session for multi-project scoping", async () => {
    (scopedStore.getSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      promptOverrides: {},
    });

    const mockCreateSubtaskSession = vi.fn().mockResolvedValue({ sessionId: "session-with-projectid" });
    vi.spyOn(subtaskBreakdownModule, "createSubtaskSession").mockImplementation(mockCreateSubtaskSession);

    const res = await REQUEST(
      buildApp(),
      "POST",
      `/api/subtasks/start-streaming?projectId=${projectId}`,
      JSON.stringify({ description: "Scoped subtask" }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(201);
    // Ensure projectId is passed through for multi-project scoping
    expect(mockCreateSubtaskSession).toHaveBeenCalledWith(
      "Scoped subtask",
      scopedStore,
      "/scoped/subtask/project",
      expect.any(Object),
      projectId,
    );
  });
});

describe("POST /api/ai/summarize-title with projectId scoping", () => {
  const projectId = "proj-summarize-scoped";
  let defaultStore: TaskStore;
  let scopedStore: TaskStore;

  beforeEach(() => {
    defaultStore = createMockStore();
    scopedStore = createMockStore({
      getRootDir: vi.fn().mockReturnValue("/scoped/project"),
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

  it("uses scoped store when projectId is provided for rate limit check", async () => {
    // The route checks rate limit first using getOrCreateProjectStore
    const res = await REQUEST(
      buildApp(),
      "POST",
      `/api/ai/summarize-title?projectId=${projectId}`,
      JSON.stringify({
        description: "Short description", // Short to fail validation quickly
      }),
      { "Content-Type": "application/json" },
    );

    // Verify scoped store is used
    expect(projectStoreResolver.getOrCreateProjectStore).toHaveBeenCalledWith(projectId);
    // Verify request completes (either 400 validation or 503 AI unavailable)
    expect([400, 503]).toContain(res.status);
  });

  it("does not use default store when projectId is provided", async () => {
    const res = await REQUEST(
      buildApp(),
      "POST",
      `/api/ai/summarize-title?projectId=${projectId}`,
      JSON.stringify({
        description: "Short description", // Short to fail validation quickly
      }),
      { "Content-Type": "application/json" },
    );

    // Default store should not be used
    expect(defaultStore.getSettings).not.toHaveBeenCalled();
    expect([400, 503]).toContain(res.status);
  });
});

