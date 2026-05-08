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

// Several nested describe blocks call `vi.restoreAllMocks()` in afterEach,
// which wipes the passthrough implementation installed in the `vi.mock` factory.
// Reinstalling here ensures real `git` / `pgrep` calls work for every test
// regardless of ordering.
beforeEach(async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
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
});


describe("POST /github/issues/fetch", () => {
  let store: TaskStore;
  let listIssuesSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    store = createMockStore();
    mockIsGhAuthenticated.mockReturnValue(true);
    listIssuesSpy = vi.fn();
    vi.spyOn(GitHubClient.prototype, "listIssues").mockImplementation(listIssuesSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store));
    return app;
  }

  const mockGitHubIssue = {
    number: 1,
    title: "Test Issue",
    body: "Test body",
    html_url: "https://github.com/owner/repo/issues/1",
    labels: [{ name: "bug" }],
  };

  it("fetches issues successfully", async () => {
    listIssuesSpy.mockResolvedValueOnce([mockGitHubIssue]);

    const res = await REQUEST(buildApp(), "POST", "/api/github/issues/fetch", JSON.stringify({ owner: "owner", repo: "repo" }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].number).toBe(1);
    expect(res.body[0].title).toBe("Test Issue");
  });

  it("returns 400 when owner is missing", async () => {
    const res = await REQUEST(buildApp(), "POST", "/api/github/issues/fetch", JSON.stringify({ repo: "repo" }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("owner is required");
  });

  it("returns 400 when repo is missing", async () => {
    const res = await REQUEST(buildApp(), "POST", "/api/github/issues/fetch", JSON.stringify({ owner: "owner" }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("repo is required");
  });

  it("returns 404 when repository not found", async () => {
    listIssuesSpy.mockRejectedValueOnce(new Error("Repository not found: owner/repo"));

    const res = await REQUEST(buildApp(), "POST", "/api/github/issues/fetch", JSON.stringify({ owner: "owner", repo: "repo" }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(404);
    expect(res.body.error).toContain("Repository not found");
  });

  it("returns 401 when gh not authenticated", async () => {
    mockIsGhAuthenticated.mockReturnValueOnce(false);

    const res = await REQUEST(buildApp(), "POST", "/api/github/issues/fetch", JSON.stringify({ owner: "owner", repo: "repo" }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(401);
    expect(res.body.error).toContain("Not authenticated with GitHub");
    expect(res.body.error).toContain("gh auth login");
  });

  it("returns 502 when gh CLI fails", async () => {
    listIssuesSpy.mockRejectedValueOnce(new Error("Some gh CLI error"));

    const res = await REQUEST(buildApp(), "POST", "/api/github/issues/fetch", JSON.stringify({ owner: "owner", repo: "repo" }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(502);
    expect(res.body.error).toContain("GitHub CLI error");
  });

  it("filters out pull requests (gh CLI already filters them)", async () => {
    // gh issue list already filters out PRs, so we just verify the response
    listIssuesSpy.mockResolvedValueOnce([mockGitHubIssue]);

    const res = await REQUEST(buildApp(), "POST", "/api/github/issues/fetch", JSON.stringify({ owner: "owner", repo: "repo", limit: 10 }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].number).toBe(1);
  });

  it("respects limit parameter", async () => {
    const manyIssues = Array.from({ length: 50 }, (_, i) => ({ ...mockGitHubIssue, number: i + 1 }));
    listIssuesSpy.mockResolvedValueOnce(manyIssues.slice(0, 10));

    const res = await REQUEST(buildApp(), "POST", "/api/github/issues/fetch", JSON.stringify({ owner: "owner", repo: "repo", limit: 10 }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(10);
  });
});

describe("POST /github/issues/import", () => {
  let store: TaskStore;
  let getIssueSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockIsGhAuthenticated.mockReturnValue(true);
    getIssueSpy = vi.fn();
    vi.spyOn(GitHubClient.prototype, "getIssue").mockImplementation(getIssueSpy);

    store = createMockStore({
      createTask: vi.fn().mockResolvedValue({
        id: "FN-001",
        title: "Test Issue",
        description: "Test body\n\nSource: https://github.com/owner/repo/issues/1",
        column: "triage",
      }),
      logEntry: vi.fn().mockResolvedValue(undefined),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store));
    return app;
  }

  const mockGitHubIssue = {
    number: 1,
    title: "Test Issue",
    body: "Test body",
    html_url: "https://github.com/owner/repo/issues/1",
    state: "open",
  };

  it("imports a single issue successfully", async () => {
    getIssueSpy.mockResolvedValueOnce(mockGitHubIssue);

    const res = await REQUEST(buildApp(), "POST", "/api/github/issues/import", JSON.stringify({ owner: "owner", repo: "repo", issueNumber: 1 }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe("FN-001");
    expect(store.createTask).toHaveBeenCalledWith({
      title: "Test Issue",
      description: "Test body\n\nSource: https://github.com/owner/repo/issues/1",
      column: "triage",
      dependencies: [],
      sourceIssue: {
        provider: "github",
        repository: "owner/repo",
        externalIssueId: "1",
        issueNumber: 1,
        url: "https://github.com/owner/repo/issues/1",
      },
      source: {
        sourceType: "github_import",
        sourceMetadata: {
          issueUrl: "https://github.com/owner/repo/issues/1",
          issueNumber: 1,
        },
      },
    });
  });

  it("logs the import action", async () => {
    getIssueSpy.mockResolvedValueOnce(mockGitHubIssue);

    await REQUEST(buildApp(), "POST", "/api/github/issues/import", JSON.stringify({ owner: "owner", repo: "repo", issueNumber: 1 }), {
      "Content-Type": "application/json",
    });

    expect(store.logEntry).toHaveBeenCalledWith("FN-001", "Imported from GitHub", "https://github.com/owner/repo/issues/1");
  });

  it("returns 400 when issueNumber is missing", async () => {
    const res = await REQUEST(buildApp(), "POST", "/api/github/issues/import", JSON.stringify({ owner: "owner", repo: "repo" }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("issueNumber is required");
  });

  it("returns 400 when issue not found or is a pull request", async () => {
    // getIssue returns null for both "not found" and "PR" cases
    getIssueSpy.mockResolvedValueOnce(null);

    const res = await REQUEST(buildApp(), "POST", "/api/github/issues/import", JSON.stringify({ owner: "owner", repo: "repo", issueNumber: 999 }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("is a pull request");
  });

  it("returns 401 when gh not authenticated", async () => {
    mockIsGhAuthenticated.mockReturnValueOnce(false);

    const res = await REQUEST(buildApp(), "POST", "/api/github/issues/import", JSON.stringify({ owner: "owner", repo: "repo", issueNumber: 1 }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(401);
    expect(res.body.error).toContain("Not authenticated with GitHub");
    expect(res.body.error).toContain("gh auth login");
  });

  it("returns 502 when gh CLI fails", async () => {
    getIssueSpy.mockRejectedValueOnce(new Error("Some gh CLI error"));

    const res = await REQUEST(buildApp(), "POST", "/api/github/issues/import", JSON.stringify({ owner: "owner", repo: "repo", issueNumber: 1 }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(502);
    expect(res.body.error).toContain("GitHub CLI error");
  });

  it("returns 409 when issue already imported", async () => {
    (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      {
        id: "FN-002",
        description: "Existing\n\nSource: https://github.com/owner/repo/issues/1",
        column: "triage",
      },
    ]);

    getIssueSpy.mockResolvedValueOnce(mockGitHubIssue);

    const res = await REQUEST(buildApp(), "POST", "/api/github/issues/import", JSON.stringify({ owner: "owner", repo: "repo", issueNumber: 1 }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("already imported");
    expect(res.body.details?.existingTaskId).toBe("FN-002");
    expect(store.createTask).not.toHaveBeenCalled();
  });

  it("truncates long titles to 200 chars", async () => {
    const longTitleIssue = {
      ...mockGitHubIssue,
      title: "A".repeat(250),
    };
    getIssueSpy.mockResolvedValueOnce(longTitleIssue);

    await REQUEST(buildApp(), "POST", "/api/github/issues/import", JSON.stringify({ owner: "owner", repo: "repo", issueNumber: 1 }), {
      "Content-Type": "application/json",
    });

    expect(store.createTask).toHaveBeenCalledWith({
      title: "A".repeat(200),
      description: expect.stringContaining("Source:"),
      column: "triage",
      dependencies: [],
      sourceIssue: {
        provider: "github",
        repository: "owner/repo",
        externalIssueId: "1",
        issueNumber: 1,
        url: "https://github.com/owner/repo/issues/1",
      },
      source: {
        sourceType: "github_import",
        sourceMetadata: {
          issueUrl: "https://github.com/owner/repo/issues/1",
          issueNumber: 1,
        },
      },
    });
  });
});

describe("POST /github/issues/batch-import", () => {
  let store: TaskStore;
  let fetchSpy: ReturnType<typeof vi.fn>;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    __resetBatchImportRateLimiter();

    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as any;

    store = createMockStore({
      listTasks: vi.fn().mockResolvedValue([]),
      createTask: vi.fn().mockImplementation((input) =>
        Promise.resolve({
          id: `KB-${String(Math.floor(Math.random() * 999)).padStart(3, "0")}`,
          title: input.title,
          description: input.description,
          column: "triage",
        })
      ),
      logEntry: vi.fn().mockResolvedValue(undefined),
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store));
    return app;
  }

  const mockGitHubIssue = (number: number, title = `Issue ${number}`) => ({
    number,
    title,
    body: `Body for issue ${number}`,
    html_url: `https://github.com/owner/repo/issues/${number}`,
    labels: [{ name: "bug" }],
  });

  it("imports multiple issues successfully", async () => {
    const throttledSpy = vi.spyOn(GitHubClient.prototype, "fetchThrottled")
      .mockResolvedValueOnce({
        success: true,
        data: mockGitHubIssue(1, "First Issue"),
      } as Awaited<ReturnType<GitHubClient["fetchThrottled"]>>)
      .mockResolvedValueOnce({
        success: true,
        data: mockGitHubIssue(2, "Second Issue"),
      } as Awaited<ReturnType<GitHubClient["fetchThrottled"]>>)
      .mockResolvedValueOnce({
        success: true,
        data: mockGitHubIssue(3, "Third Issue"),
      } as Awaited<ReturnType<GitHubClient["fetchThrottled"]>>);

    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/github/issues/batch-import",
      JSON.stringify({ owner: "owner", repo: "repo", issueNumbers: [1, 2, 3], delayMs: 1 }),
      { "Content-Type": "application/json" }
    );

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(3);
    expect(res.body.results.every((r: { success: boolean }) => r.success)).toBe(true);
    expect(throttledSpy).toHaveBeenCalledTimes(3);
    expect(store.createTask).toHaveBeenCalledTimes(3);
    expect(store.createTask).toHaveBeenNthCalledWith(1, expect.objectContaining({
      sourceIssue: {
        provider: "github",
        repository: "owner/repo",
        externalIssueId: "1",
        issueNumber: 1,
        url: "https://github.com/owner/repo/issues/1",
      },
    }));
    expect(store.createTask).toHaveBeenNthCalledWith(2, expect.objectContaining({
      sourceIssue: {
        provider: "github",
        repository: "owner/repo",
        externalIssueId: "2",
        issueNumber: 2,
        url: "https://github.com/owner/repo/issues/2",
      },
    }));
    expect(store.createTask).toHaveBeenNthCalledWith(3, expect.objectContaining({
      sourceIssue: {
        provider: "github",
        repository: "owner/repo",
        externalIssueId: "3",
        issueNumber: 3,
        url: "https://github.com/owner/repo/issues/3",
      },
    }));
  });

  it("skips already-imported issues", async () => {
    // Mock issue 1 fetch
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(mockGitHubIssue(1, "Already Imported Issue")),
    } as Response);

    // First import - should create a new task
    const res1 = await REQUEST(
      buildApp(),
      "POST",
      "/api/github/issues/batch-import",
      JSON.stringify({ owner: "owner", repo: "repo", issueNumbers: [1], delayMs: 1 }),
      { "Content-Type": "application/json" }
    );

    expect(res1.status).toBe(200);
    expect(res1.body.results).toHaveLength(1);
    expect(res1.body.results[0].success).toBe(true);
    expect(res1.body.results[0].skipped).toBeUndefined();
    const createdTaskId = res1.body.results[0].taskId;
    expect(createdTaskId).toBeDefined();

    // Now verify that if we import again with the task in the list, it gets skipped
    // Update the listTasks mock to return the created task
    const createdTaskDescription = `Already Imported Issue\n\nSource: https://github.com/owner/repo/issues/1`;
    store.listTasks = vi.fn().mockResolvedValue([
      {
        id: createdTaskId,
        description: createdTaskDescription,
        column: "triage",
      },
    ]);

    // Second import - should skip
    const res2 = await REQUEST(
      buildApp(),
      "POST",
      "/api/github/issues/batch-import",
      JSON.stringify({ owner: "owner", repo: "repo", issueNumbers: [1], delayMs: 1 }),
      { "Content-Type": "application/json" }
    );

    expect(res2.status).toBe(200);
    expect(res2.body.results).toHaveLength(1);
    expect(res2.body.results[0].success).toBe(true);
    expect(res2.body.results[0].skipped).toBe(true);
    expect(res2.body.results[0].taskId).toBe(createdTaskId);
  });

  it("returns 400 for empty issueNumbers array", async () => {
    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/github/issues/batch-import",
      JSON.stringify({ owner: "owner", repo: "repo", issueNumbers: [] }),
      { "Content-Type": "application/json" }
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("at least 1");
  });

  it("returns 400 for more than 50 issue numbers", async () => {
    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/github/issues/batch-import",
      JSON.stringify({ owner: "owner", repo: "repo", issueNumbers: Array.from({ length: 51 }, (_, i) => i + 1) }),
      { "Content-Type": "application/json" }
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("more than 50");
  });

  it("returns 400 for invalid issueNumbers (non-integers)", async () => {
    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/github/issues/batch-import",
      JSON.stringify({ owner: "owner", repo: "repo", issueNumbers: [1, "two", 3] }),
      { "Content-Type": "application/json" }
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("positive integers");
  });

  it("handles partial failures (some succeed, some fail)", async () => {
    const throttledSpy = vi.spyOn(GitHubClient.prototype, "fetchThrottled")
      .mockResolvedValueOnce({
        success: true,
        data: mockGitHubIssue(1),
      } as Awaited<ReturnType<GitHubClient["fetchThrottled"]>>)
      .mockResolvedValueOnce({
        success: false,
        error: "GitHub API error (404): Not Found",
      } as Awaited<ReturnType<GitHubClient["fetchThrottled"]>>)
      .mockResolvedValueOnce({
        success: true,
        data: mockGitHubIssue(3),
      } as Awaited<ReturnType<GitHubClient["fetchThrottled"]>>);

    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/github/issues/batch-import",
      JSON.stringify({ owner: "owner", repo: "repo", issueNumbers: [1, 2, 3], delayMs: 1 }),
      { "Content-Type": "application/json" }
    );

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(3);
    expect(res.body.results[0].success).toBe(true);
    expect(res.body.results[1].success).toBe(false);
    expect(res.body.results[1].error).toContain("404");
    expect(res.body.results[2].success).toBe(true);
    expect(throttledSpy).toHaveBeenCalledTimes(3);
  });

  it("rejects pull requests with appropriate error", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ ...mockGitHubIssue(1), pull_request: {} }),
    } as Response);

    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/github/issues/batch-import",
      JSON.stringify({ owner: "owner", repo: "repo", issueNumbers: [1], delayMs: 1 }),
      { "Content-Type": "application/json" }
    );

    expect(res.status).toBe(200);
    expect(res.body.results[0].success).toBe(false);
    expect(res.body.results[0].error).toContain("pull request");
  });

  it("handles rate limit (429) with retry and eventual success", async () => {
    const throttledSpy = vi.spyOn(GitHubClient.prototype, "fetchThrottled").mockResolvedValueOnce({
      success: true,
      data: mockGitHubIssue(1, "Issue After Rate Limit"),
    } as Awaited<ReturnType<GitHubClient["fetchThrottled"]>>);

    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/github/issues/batch-import",
      JSON.stringify({ owner: "owner", repo: "repo", issueNumbers: [1], delayMs: 1 }),
      { "Content-Type": "application/json" }
    );

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0].success).toBe(true);
    expect(res.body.results[0].taskId).toBeDefined();
    expect(throttledSpy).toHaveBeenCalledTimes(1);
  });

  it("returns error after max retries exceeded on 429", async () => {
    const throttledSpy = vi.spyOn(GitHubClient.prototype, "fetchThrottled").mockResolvedValueOnce({
      success: false,
      error: "GitHub API rate limit exceeded. Retry after 1 seconds.",
      retryAfter: 1,
    } as Awaited<ReturnType<GitHubClient["fetchThrottled"]>>);

    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/github/issues/batch-import",
      JSON.stringify({ owner: "owner", repo: "repo", issueNumbers: [1], delayMs: 1 }),
      { "Content-Type": "application/json" }
    );

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0].success).toBe(false);
    expect(res.body.results[0].error).toContain("rate limit");
    expect(res.body.results[0].retryAfter).toBe(1);
    expect(throttledSpy).toHaveBeenCalledTimes(1);
  });

  it("processes issues sequentially (not parallel)", async () => {
    const startedIssues: number[] = [];
    const resolvers = new Map<number, () => void>();

    vi.spyOn(GitHubClient.prototype, "fetchThrottled").mockImplementation(async (url) => {
      const issueNumber = Number(String(url).split("/").pop());
      startedIssues.push(issueNumber);
      await new Promise<void>((resolve) => {
        resolvers.set(issueNumber, resolve);
      });
      return {
        success: true,
        data: mockGitHubIssue(issueNumber),
      } as Awaited<ReturnType<GitHubClient["fetchThrottled"]>>;
    });

    const requestPromise = REQUEST(
      buildApp(),
      "POST",
      "/api/github/issues/batch-import",
      JSON.stringify({ owner: "owner", repo: "repo", issueNumbers: [1, 2, 3], delayMs: 1 }),
      { "Content-Type": "application/json" }
    );

    await vi.waitFor(() => expect(startedIssues).toEqual([1]));
    resolvers.get(1)?.();

    await vi.waitFor(() => expect(startedIssues).toEqual([1, 2]));
    resolvers.get(2)?.();

    await vi.waitFor(() => expect(startedIssues).toEqual([1, 2, 3]));
    resolvers.get(3)?.();

    const res = await requestPromise;

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(3);
  });

  it("requires owner parameter", async () => {
    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/github/issues/batch-import",
      JSON.stringify({ repo: "repo", issueNumbers: [1] }),
      { "Content-Type": "application/json" }
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("owner");
  });

  it("requires repo parameter", async () => {
    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/github/issues/batch-import",
      JSON.stringify({ owner: "owner", issueNumbers: [1] }),
      { "Content-Type": "application/json" }
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("repo");
  });

  it("logs import actions for created tasks", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(mockGitHubIssue(1)),
    } as Response);

    await REQUEST(
      buildApp(),
      "POST",
      "/api/github/issues/batch-import",
      JSON.stringify({ owner: "owner", repo: "repo", issueNumbers: [1], delayMs: 1 }),
      { "Content-Type": "application/json" }
    );

    expect(store.logEntry).toHaveBeenCalledWith(
      expect.any(String),
      "Imported from GitHub",
      "https://github.com/owner/repo/issues/1"
    );
  });
});

describe("projectId store scoping regressions", () => {
  const projectId = "proj-scoped";
  let defaultStore: TaskStore;
  let scopedStore: TaskStore;

  beforeEach(() => {
    __resetBatchImportRateLimiter();
    __resetPlanningState();
    __resetSubtaskBreakdownState();
    mockIsGhAuthenticated.mockReturnValue(true);

    defaultStore = createMockStore({
      listTasks: vi.fn().mockResolvedValue([]),
      createTask: vi.fn(),
      updateTask: vi.fn(),
      logEntry: vi.fn().mockResolvedValue(undefined),
      getTask: vi.fn(),
      deleteTask: vi.fn(),
      getRootDir: vi.fn().mockReturnValue("/fake/default"),
    });

    scopedStore = createMockStore({
      listTasks: vi.fn().mockResolvedValue([]),
      createTask: vi.fn(),
      updateTask: vi.fn().mockImplementation(async (id: string, patch: Record<string, unknown>) => ({
        ...FAKE_TASK_DETAIL,
        id,
        column: "triage",
        ...patch,
      })),
      logEntry: vi.fn().mockResolvedValue(undefined),
      getTask: vi.fn().mockResolvedValue({
        ...FAKE_TASK_DETAIL,
        id: "FN-PARENT",
        column: "triage",
      }),
      deleteTask: vi.fn().mockResolvedValue(undefined),
      getRootDir: vi.fn().mockReturnValue("/fake/scoped"),
    });

    vi.spyOn(projectStoreResolver, "getOrCreateProjectStore").mockResolvedValue(scopedStore);
  });

  afterEach(() => {
    __setCreateFnAgent(undefined as any);
    vi.restoreAllMocks();
  });

  function buildApp(options?: Parameters<typeof createApiRoutes>[1]) {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(defaultStore, options));
    return app;
  }

  it("routes github issue import mutations to scoped store when projectId is provided", async () => {
    vi.spyOn(GitHubClient.prototype, "getIssue").mockResolvedValue({
      number: 1,
      title: "Scoped issue",
      body: "Body",
      html_url: "https://github.com/owner/repo/issues/1",
      state: "open",
    });
    (scopedStore.createTask as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...FAKE_TASK_DETAIL,
      id: "FN-SCOPE-1",
      column: "triage",
    });

    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/github/issues/import",
      JSON.stringify({ owner: "owner", repo: "repo", issueNumber: 1, projectId }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(201);
    expect(projectStoreResolver.getOrCreateProjectStore).toHaveBeenCalledWith(projectId);
    expect(scopedStore.createTask).toHaveBeenCalledTimes(1);
    expect(defaultStore.createTask).not.toHaveBeenCalled();
  });

  it("routes github batch-import mutations to scoped store when projectId is provided", async () => {
    vi.spyOn(GitHubClient.prototype, "fetchThrottled")
      .mockResolvedValueOnce({
        success: true,
        data: {
          number: 1,
          title: "One",
          body: "Body one",
          html_url: "https://github.com/owner/repo/issues/1",
        },
      } as Awaited<ReturnType<GitHubClient["fetchThrottled"]>>)
      .mockResolvedValueOnce({
        success: true,
        data: {
          number: 2,
          title: "Two",
          body: "Body two",
          html_url: "https://github.com/owner/repo/issues/2",
        },
      } as Awaited<ReturnType<GitHubClient["fetchThrottled"]>>);

    (scopedStore.createTask as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ ...FAKE_TASK_DETAIL, id: "FN-SCOPE-2", column: "triage" })
      .mockResolvedValueOnce({ ...FAKE_TASK_DETAIL, id: "FN-SCOPE-3", column: "triage" });

    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/github/issues/batch-import",
      JSON.stringify({ owner: "owner", repo: "repo", issueNumbers: [1, 2], delayMs: 1, projectId }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(200);
    expect(scopedStore.createTask).toHaveBeenCalledTimes(2);
    expect(defaultStore.createTask).not.toHaveBeenCalled();
  });

  it("routes github pull import mutations to scoped store when projectId is provided", async () => {
    vi.spyOn(GitHubClient.prototype, "getPullRequest").mockResolvedValue({
      number: 9,
      title: "Scoped pull",
      body: "PR body",
      html_url: "https://github.com/owner/repo/pull/9",
      headBranch: "feature/branch",
      baseBranch: "main",
      state: "open",
    });

    (scopedStore.createTask as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...FAKE_TASK_DETAIL,
      id: "FN-SCOPE-4",
      column: "triage",
    });

    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/github/pulls/import",
      JSON.stringify({ owner: "owner", repo: "repo", prNumber: 9, projectId }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(201);
    expect(scopedStore.createTask).toHaveBeenCalledTimes(1);
    expect(defaultStore.createTask).not.toHaveBeenCalled();
  });

  it("routes planning create-task mutations to scoped store when projectId is provided", async () => {
    vi.spyOn(planningModule, "getSession").mockReturnValue({
      id: "plan-session-1",
      initialPlan: "Scoped initial plan",
      history: [],
      thinkingOutput: "",
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any);
    vi.spyOn(planningModule, "getSummary").mockReturnValue({
      title: "Scoped planned task",
      description: "Create task in scoped project",
      suggestedSize: "M",
      suggestedDependencies: [],
      keyDeliverables: [],
    });
    vi.spyOn(planningModule, "cleanupSession").mockImplementation(() => {});

    (scopedStore.createTask as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...FAKE_TASK_DETAIL,
      id: "FN-SCOPE-5",
      column: "triage",
    });

    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/planning/create-task",
      JSON.stringify({ sessionId: "plan-session-1", projectId }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(201);
    expect(scopedStore.createTask).toHaveBeenCalledTimes(1);
    expect(defaultStore.createTask).not.toHaveBeenCalled();
  });

  it("routes planning create-tasks mutations to scoped store when projectId is provided", async () => {
    vi.spyOn(planningModule, "getSession").mockReturnValue({
      id: "plan-session-2",
      initialPlan: "Scoped multi task plan",
      history: [],
      summary: {
        title: "Plan",
        description: "Plan description",
        suggestedSize: "M",
        suggestedDependencies: [],
        keyDeliverables: ["Deliverable 1", "Deliverable 2"],
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any);
    vi.spyOn(planningModule, "formatInterviewQA").mockReturnValue("Q: Scope\nA: Medium");
    vi.spyOn(planningModule, "cleanupSession").mockImplementation(() => {});

    (scopedStore.createTask as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ ...FAKE_TASK_DETAIL, id: "FN-SCOPE-6", column: "triage" })
      .mockResolvedValueOnce({ ...FAKE_TASK_DETAIL, id: "FN-SCOPE-7", column: "triage" });

    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/planning/create-tasks",
      JSON.stringify({
        planningSessionId: "plan-session-2",
        projectId,
        subtasks: [
          { id: "sub-1", title: "First scoped task", description: "First", suggestedSize: "S", dependsOn: [] },
          { id: "sub-2", title: "Second scoped task", description: "Second", suggestedSize: "M", dependsOn: ["sub-1"] },
        ],
      }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(201);
    expect(scopedStore.createTask).toHaveBeenCalledTimes(2);
    expect(defaultStore.createTask).not.toHaveBeenCalled();
  });

  it("routes subtask create-tasks mutations to scoped store when projectId is provided", async () => {
    vi.spyOn(subtaskBreakdownModule, "getSubtaskSession").mockReturnValue({
      sessionId: "subtask-session-1",
      initialDescription: "Break down scoped work",
      subtasks: [],
      status: "complete",
      createdAt: new Date(),
      updatedAt: new Date(),
      thinkingOutput: "",
    } as any);
    vi.spyOn(subtaskBreakdownModule, "cleanupSubtaskSession").mockImplementation(() => {});

    (scopedStore.createTask as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ ...FAKE_TASK_DETAIL, id: "FN-SCOPE-8", column: "triage" })
      .mockResolvedValueOnce({ ...FAKE_TASK_DETAIL, id: "FN-SCOPE-9", column: "triage" });

    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/subtasks/create-tasks",
      JSON.stringify({
        sessionId: "subtask-session-1",
        projectId,
        parentTaskId: "FN-PARENT",
        subtasks: [
          { tempId: "temp-1", title: "Scoped subtask one", description: "One", size: "S", dependsOn: [] },
          { tempId: "temp-2", title: "Scoped subtask two", description: "Two", size: "M", dependsOn: ["temp-1"] },
        ],
      }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(201);
    expect(scopedStore.getTask).toHaveBeenCalledWith("FN-PARENT");
    expect(defaultStore.getTask).not.toHaveBeenCalled();
    expect(scopedStore.createTask).toHaveBeenCalledTimes(2);
    expect(defaultStore.createTask).not.toHaveBeenCalled();
    expect(scopedStore.deleteTask).toHaveBeenCalledWith("FN-PARENT");
    expect(defaultStore.deleteTask).not.toHaveBeenCalled();
  });
});

// --- Spec Revision route tests ---

describe("POST /tasks/:id/spec/revise", () => {
  let store: TaskStore;

  beforeEach(() => {
    store = createMockStore({
      getTask: vi.fn(),
      moveTask: vi.fn(),
      updateTask: vi.fn(),
      logEntry: vi.fn().mockResolvedValue(undefined),
    });
  });

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store));
    return app;
  }

  it("requests spec revision and moves task from todo to triage", async () => {
    const todoTask = { ...FAKE_TASK_DETAIL, column: "todo" as const };
    const movedTask = { ...FAKE_TASK_DETAIL, column: "triage" as const };
    const tempRoot = mkdtempSync(join(tmpdir(), "kb-spec-revise-"));
    const taskDir = join(tempRoot, ".fusion", "tasks", "FN-001");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "PROMPT.md"), "# stale spec\n");

    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(todoTask);
    (store.moveTask as ReturnType<typeof vi.fn>).mockResolvedValue(movedTask);
    (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValue(movedTask);
    (store.getRootDir as ReturnType<typeof vi.fn>).mockReturnValue(tempRoot);

    try {
      const res = await REQUEST(
        buildApp(),
        "POST",
        "/api/tasks/KB-001/spec/revise",
        JSON.stringify({ feedback: "Please add more details about error handling" }),
        { "Content-Type": "application/json" }
      );

      expect(res.status).toBe(200);
      expect(store.logEntry).toHaveBeenCalledWith(
        "FN-001",
        "AI spec revision requested",
        "Please add more details about error handling"
      );
      expect(store.moveTask).toHaveBeenCalledWith("FN-001", "triage");
      expect(existsSync(join(taskDir, "PROMPT.md"))).toBe(false);
      expect(store.updateTask).toHaveBeenCalledWith("FN-001", { status: "needs-replan" });
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("requests spec revision and moves task from in-progress to triage", async () => {
    const inProgressTask = { ...FAKE_TASK_DETAIL, column: "in-progress" as const };
    const movedTask = { ...FAKE_TASK_DETAIL, column: "triage" as const };

    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(inProgressTask);
    (store.moveTask as ReturnType<typeof vi.fn>).mockResolvedValue(movedTask);
    (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValue(movedTask);

    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/tasks/KB-001/spec/revise",
      JSON.stringify({ feedback: "Split this into smaller steps" }),
      { "Content-Type": "application/json" }
    );

    expect(res.status).toBe(200);
    expect(store.moveTask).toHaveBeenCalledWith("FN-001", "triage");
  });

  it("allows spec revision for task already in triage", async () => {
    const triageTask = { ...FAKE_TASK_DETAIL, column: "triage" as const };
    const updatedTask = { ...FAKE_TASK_DETAIL, column: "triage" as const, status: "needs-replan" as const };
    const tempRoot = mkdtempSync(join(tmpdir(), "kb-spec-revise-triage-"));
    const taskDir = join(tempRoot, ".fusion", "tasks", "FN-001");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "PROMPT.md"), "# stale spec\n");

    (store.getTask as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(triageTask)
      .mockResolvedValueOnce(updatedTask);
    (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValue(updatedTask);
    (store.getRootDir as ReturnType<typeof vi.fn>).mockReturnValue(tempRoot);

    try {
      const res = await REQUEST(
        buildApp(),
        "POST",
        "/api/tasks/KB-001/spec/revise",
        JSON.stringify({ feedback: "Some feedback" }),
        { "Content-Type": "application/json" }
      );

      expect(res.status).toBe(200);
      expect(store.logEntry).toHaveBeenCalledWith(
        "FN-001",
        "AI spec revision requested",
        "Some feedback"
      );
      expect(store.moveTask).not.toHaveBeenCalled();
      expect(existsSync(join(taskDir, "PROMPT.md"))).toBe(false);
      expect(store.updateTask).toHaveBeenCalledWith("FN-001", { status: "needs-replan" });
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("allows spec revision when task is in in-review (in-review can transition to triage)", async () => {
    const inReviewTask = { ...FAKE_TASK_DETAIL, column: "in-review" as const };
    const movedTask = { ...FAKE_TASK_DETAIL, column: "triage" as const };
    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(inReviewTask);
    (store.moveTask as ReturnType<typeof vi.fn>).mockResolvedValue(movedTask);
    (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValue(movedTask);

    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/tasks/KB-001/spec/revise",
      JSON.stringify({ feedback: "Some feedback" }),
      { "Content-Type": "application/json" }
    );

    expect(res.status).toBe(200);
    expect(store.moveTask).toHaveBeenCalledWith("FN-001", "triage");
    expect(store.updateTask).toHaveBeenCalledWith("FN-001", { status: "needs-replan" });
  });

  it("allows spec revision when task is in done (done can transition to triage)", async () => {
    const doneTask = { ...FAKE_TASK_DETAIL, column: "done" as const };
    const movedTask = { ...FAKE_TASK_DETAIL, column: "triage" as const };
    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(doneTask);
    (store.moveTask as ReturnType<typeof vi.fn>).mockResolvedValue(movedTask);
    (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValue(movedTask);

    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/tasks/KB-001/spec/revise",
      JSON.stringify({ feedback: "Some feedback" }),
      { "Content-Type": "application/json" }
    );

    expect(res.status).toBe(200);
    expect(store.moveTask).toHaveBeenCalledWith("FN-001", "triage");
  });

  it("returns 400 when feedback is missing", async () => {
    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/tasks/KB-001/spec/revise",
      JSON.stringify({}),
      { "Content-Type": "application/json" }
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("feedback is required");
  });

  it("returns 400 when feedback is empty string", async () => {
    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/tasks/KB-001/spec/revise",
      JSON.stringify({ feedback: "" }),
      { "Content-Type": "application/json" }
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("feedback is required");
  });

  it("returns 400 when feedback exceeds 2000 characters", async () => {
    const longFeedback = "a".repeat(2001);
    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/tasks/KB-001/spec/revise",
      JSON.stringify({ feedback: longFeedback }),
      { "Content-Type": "application/json" }
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("feedback must be between 1 and 2000");
  });

  it("returns 404 when task not found", async () => {
    const error = new Error("Task not found") as Error & { code?: string };
    error.code = "ENOENT";
    (store.getTask as ReturnType<typeof vi.fn>).mockRejectedValue(error);

    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/tasks/KB-999/spec/revise",
      JSON.stringify({ feedback: "Some feedback" }),
      { "Content-Type": "application/json" }
    );

    expect(res.status).toBe(404);
  });

  it("queues multiple revision requests as multiple log entries", async () => {
    const todoTask = { ...FAKE_TASK_DETAIL, column: "todo" as const };
    const movedTask = { ...FAKE_TASK_DETAIL, column: "triage" as const };

    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(todoTask);
    (store.moveTask as ReturnType<typeof vi.fn>).mockResolvedValue(movedTask);
    (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValue(movedTask);

    // First request
    await REQUEST(
      buildApp(),
      "POST",
      "/api/tasks/KB-001/spec/revise",
      JSON.stringify({ feedback: "First feedback" }),
      { "Content-Type": "application/json" }
    );

    // Second request
    await REQUEST(
      buildApp(),
      "POST",
      "/api/tasks/KB-001/spec/revise",
      JSON.stringify({ feedback: "Second feedback" }),
      { "Content-Type": "application/json" }
    );

    expect(store.logEntry).toHaveBeenCalledTimes(2);
    expect(store.logEntry).toHaveBeenNthCalledWith(1, "FN-001", "AI spec revision requested", "First feedback");
    expect(store.logEntry).toHaveBeenNthCalledWith(2, "FN-001", "AI spec revision requested", "Second feedback");
  });
});


// --- Spec Rebuild route tests ---

describe("POST /tasks/:id/spec/rebuild", () => {
  let store: TaskStore;

  beforeEach(() => {
    store = createMockStore({
      getTask: vi.fn(),
      moveTask: vi.fn(),
      updateTask: vi.fn(),
      logEntry: vi.fn().mockResolvedValue(undefined),
    });
  });

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store));
    return app;
  }

  it("rebuilds spec and moves task from todo to triage", async () => {
    const todoTask = { ...FAKE_TASK_DETAIL, column: "todo" as const };
    const movedTask = { ...FAKE_TASK_DETAIL, column: "triage" as const };
    const tempRoot = mkdtempSync(join(tmpdir(), "kb-spec-rebuild-"));
    const taskDir = join(tempRoot, ".fusion", "tasks", "FN-001");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "PROMPT.md"), "# stale spec\n");

    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(todoTask);
    (store.moveTask as ReturnType<typeof vi.fn>).mockResolvedValue(movedTask);
    (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValue(movedTask);
    (store.getRootDir as ReturnType<typeof vi.fn>).mockReturnValue(tempRoot);

    try {
      const res = await REQUEST(buildApp(), "POST", "/api/tasks/KB-001/spec/rebuild");

      expect(res.status).toBe(200);
      expect(store.logEntry).toHaveBeenCalledWith(
        "FN-001",
        "Specification rebuild requested by user"
      );
      expect(store.moveTask).toHaveBeenCalledWith("FN-001", "triage");
      expect(existsSync(join(taskDir, "PROMPT.md"))).toBe(false);
      expect(store.updateTask).toHaveBeenCalledWith("FN-001", { status: "needs-replan" });
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("rebuilds spec and moves task from in-progress to triage", async () => {
    const inProgressTask = { ...FAKE_TASK_DETAIL, column: "in-progress" as const };
    const movedTask = { ...FAKE_TASK_DETAIL, column: "triage" as const };

    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(inProgressTask);
    (store.moveTask as ReturnType<typeof vi.fn>).mockResolvedValue(movedTask);
    (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValue(movedTask);

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/KB-001/spec/rebuild");

    expect(res.status).toBe(200);
    expect(store.moveTask).toHaveBeenCalledWith("FN-001", "triage");
    expect(store.updateTask).toHaveBeenCalledWith("FN-001", { status: "needs-replan" });
  });

  it("rebuilds spec and moves task from done to triage", async () => {
    const doneTask = { ...FAKE_TASK_DETAIL, column: "done" as const };
    const movedTask = { ...FAKE_TASK_DETAIL, column: "triage" as const };

    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(doneTask);
    (store.moveTask as ReturnType<typeof vi.fn>).mockResolvedValue(movedTask);
    (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValue(movedTask);

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/KB-001/spec/rebuild");

    expect(res.status).toBe(200);
    expect(store.moveTask).toHaveBeenCalledWith("FN-001", "triage");
  });

  it("allows rebuild for task already in triage", async () => {
    const triageTask = { ...FAKE_TASK_DETAIL, column: "triage" as const };
    const updatedTask = { ...FAKE_TASK_DETAIL, column: "triage" as const, status: "needs-replan" as const };
    const tempRoot = mkdtempSync(join(tmpdir(), "kb-spec-rebuild-triage-"));
    const taskDir = join(tempRoot, ".fusion", "tasks", "FN-001");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "PROMPT.md"), "# stale spec\n");

    (store.getTask as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(triageTask)
      .mockResolvedValueOnce(updatedTask);
    (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValue(updatedTask);
    (store.getRootDir as ReturnType<typeof vi.fn>).mockReturnValue(tempRoot);

    try {
      const res = await REQUEST(buildApp(), "POST", "/api/tasks/KB-001/spec/rebuild");

      expect(res.status).toBe(200);
      expect(store.logEntry).toHaveBeenCalledWith(
        "FN-001",
        "Specification rebuild requested by user"
      );
      expect(store.moveTask).not.toHaveBeenCalled();
      expect(existsSync(join(taskDir, "PROMPT.md"))).toBe(false);
      expect(store.updateTask).toHaveBeenCalledWith("FN-001", { status: "needs-replan" });
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("allows spec rebuild when task is in in-review (in-review can transition to triage)", async () => {
    const inReviewTask = { ...FAKE_TASK_DETAIL, column: "in-review" as const };
    const movedTask = { ...FAKE_TASK_DETAIL, column: "triage" as const };
    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(inReviewTask);
    (store.moveTask as ReturnType<typeof vi.fn>).mockResolvedValue(movedTask);
    (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValue(movedTask);

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/KB-001/spec/rebuild");

    expect(res.status).toBe(200);
    expect(store.moveTask).toHaveBeenCalledWith("FN-001", "triage");
    expect(store.updateTask).toHaveBeenCalledWith("FN-001", { status: "needs-replan" });
  });

  it("returns 404 when task not found", async () => {
    const error = new Error("Task not found") as Error & { code?: string };
    error.code = "ENOENT";
    (store.getTask as ReturnType<typeof vi.fn>).mockRejectedValue(error);

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/KB-999/spec/rebuild");

    expect(res.status).toBe(404);
  });
});

// --- Plan Approval route tests ---

describe("POST /tasks/:id/approve-plan", () => {
  let store: TaskStore;

  beforeEach(() => {
    store = createMockStore({
      getTask: vi.fn(),
      moveTask: vi.fn(),
      updateTask: vi.fn(),
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

  it("approves plan and moves task from triage to todo", async () => {
    const awaitingTask = { ...FAKE_TASK_DETAIL, column: "triage" as const, status: "awaiting-approval" as const };
    const movedTask = { ...FAKE_TASK_DETAIL, column: "todo" as const };

    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(awaitingTask);
    (store.moveTask as ReturnType<typeof vi.fn>).mockResolvedValue(movedTask);
    (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValue({ ...movedTask, status: undefined });

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/KB-001/approve-plan");

    expect(res.status).toBe(200);
    expect(store.logEntry).toHaveBeenCalledWith("FN-001", "Plan approved by user");
    expect(store.moveTask).toHaveBeenCalledWith("FN-001", "todo");
    expect(store.updateTask).toHaveBeenCalledWith("FN-001", { status: undefined });
    expect(res.body.column).toBe("todo");
    expect(res.body.status).toBeUndefined();
  });

  it("returns 400 when task is not in triage column", async () => {
    const todoTask = { ...FAKE_TASK_DETAIL, column: "todo" as const, status: "awaiting-approval" as const };
    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(todoTask);

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/KB-001/approve-plan");

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("triage");
    expect(store.moveTask).not.toHaveBeenCalled();
  });

  it("returns 400 when task does not have awaiting-approval status", async () => {
    const triageTask = { ...FAKE_TASK_DETAIL, column: "triage" as const, status: "planning" as const };
    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(triageTask);

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/KB-001/approve-plan");

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("awaiting-approval");
    expect(store.moveTask).not.toHaveBeenCalled();
  });

  it("returns 404 when task not found", async () => {
    const error = new Error("Task not found") as Error & { code?: string };
    error.code = "ENOENT";
    (store.getTask as ReturnType<typeof vi.fn>).mockRejectedValue(error);

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/KB-999/approve-plan");

    expect(res.status).toBe(404);
  });

  it("returns 500 on unexpected errors", async () => {
    (store.getTask as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Database error"));

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/KB-001/approve-plan");

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Database error");
  });
});

describe("POST /tasks/:id/reject-plan", () => {
  let store: TaskStore;

  beforeEach(() => {
    store = createMockStore({
      getTask: vi.fn(),
      updateTask: vi.fn(),
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

  it("rejects plan and clears status for regeneration", async () => {
    const awaitingTask = { ...FAKE_TASK_DETAIL, column: "triage" as const, status: "awaiting-approval" as const };
    const updatedTask = { ...FAKE_TASK_DETAIL, column: "triage" as const, status: undefined };

    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(awaitingTask);
    (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValue(updatedTask);

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/KB-001/reject-plan");

    expect(res.status).toBe(200);
    expect(store.logEntry).toHaveBeenCalledWith("FN-001", "Plan rejected by user", "Specification will be regenerated");
    expect(store.updateTask).toHaveBeenCalledWith("FN-001", { status: undefined });
    expect(res.body.column).toBe("triage");
  });

  it("returns 400 when task is not in triage column", async () => {
    const todoTask = { ...FAKE_TASK_DETAIL, column: "todo" as const, status: "awaiting-approval" as const };
    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(todoTask);

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/KB-001/reject-plan");

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("triage");
    expect(store.updateTask).not.toHaveBeenCalled();
  });

  it("returns 400 when task does not have awaiting-approval status", async () => {
    const triageTask = { ...FAKE_TASK_DETAIL, column: "triage" as const, status: "planning" as const };
    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(triageTask);

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/KB-001/reject-plan");

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("awaiting-approval");
    expect(store.updateTask).not.toHaveBeenCalled();
  });

  it("returns 404 when task not found", async () => {
    const error = new Error("Task not found") as Error & { code?: string };
    error.code = "ENOENT";
    (store.getTask as ReturnType<typeof vi.fn>).mockRejectedValue(error);

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/KB-999/reject-plan");

    expect(res.status).toBe(404);
  });

  it("returns 500 on unexpected errors", async () => {
    (store.getTask as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Database error"));

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/KB-001/reject-plan");

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Database error");
  });
});

// --- Task diff route tests ---

describe("GET /tasks/:id/diff", () => {
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

  it("returns 404 when task not found", async () => {
    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    const res = await GET(buildApp(), "/api/tasks/FN-999/diff");

    expect(res.status).toBe(404);
    expect(res.body.error).toContain("Task not found");
  });

  describe("done tasks without commit SHA", () => {
    it("returns safe empty file list with merge summary stats", async () => {
      const doneTask = {
        ...FAKE_TASK_DETAIL,
        id: "FN-001",
        column: "done",
        mergeDetails: {
          filesChanged: 3,
          insertions: 10,
          deletions: 2,
        },
      };
      (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(doneTask);

      const res = await GET(buildApp(), "/api/tasks/FN-001/diff");

      expect(res.status).toBe(200);
      expect(res.body.files).toEqual([]);
      expect(res.body.stats).toEqual({
        filesChanged: 3,
        additions: 10,
        deletions: 2,
      });
    });

    it("returns zeros when mergeDetails has no summary numbers", async () => {
      const doneTask = {
        ...FAKE_TASK_DETAIL,
        id: "FN-001",
        column: "done",
        mergeDetails: {},
      };
      (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(doneTask);

      const res = await GET(buildApp(), "/api/tasks/FN-001/diff");

      expect(res.status).toBe(200);
      expect(res.body.files).toEqual([]);
      expect(res.body.stats).toEqual({
        filesChanged: 0,
        additions: 0,
        deletions: 0,
      });
    });

    it("returns zeros when mergeDetails is undefined", async () => {
      const doneTask = {
        ...FAKE_TASK_DETAIL,
        id: "FN-001",
        column: "done",
        mergeDetails: undefined,
      };
      (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(doneTask);

      const res = await GET(buildApp(), "/api/tasks/FN-001/diff");

      expect(res.status).toBe(200);
      expect(res.body.files).toEqual([]);
      expect(res.body.stats).toEqual({
        filesChanged: 0,
        additions: 0,
        deletions: 0,
      });
    });

    it("response is schema-compatible with TaskDiff type", async () => {
      const doneTask = {
        ...FAKE_TASK_DETAIL,
        id: "FN-001",
        column: "done",
        mergeDetails: { filesChanged: 5, insertions: 20, deletions: 3 },
      };
      (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(doneTask);

      const res = await GET(buildApp(), "/api/tasks/FN-001/diff");

      // Must have both `files` array and `stats` object
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.files)).toBe(true);
      expect(res.body.stats).toHaveProperty("filesChanged");
      expect(res.body.stats).toHaveProperty("additions");
      expect(res.body.stats).toHaveProperty("deletions");
    });
  });

  describe("done tasks with commit SHA", () => {
    it("attempts git diff when commitSha is present", async () => {
      const gitRepo = getSharedGitTestRepo();
      const localStore = createMockStore({
        getRootDir: vi.fn().mockReturnValue(gitRepo.repoDir),
      });
      const doneTask = {
        ...FAKE_TASK_DETAIL,
        id: "FN-001",
        column: "done",
        mergeDetails: { commitSha: gitRepo.headSha },
      };
      (localStore.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(doneTask);

      const app = express();
      app.use(express.json());
      app.use("/api", createApiRoutes(localStore));

      const res = await GET(app, "/api/tasks/FN-001/diff");
      expect(res.status).toBe(200);
      // The diff should be schema-compatible even if it returns empty
      expect(Array.isArray(res.body.files)).toBe(true);
      expect(res.body.stats).toHaveProperty("filesChanged");
    });
  });
});

describe("GET /tasks/:id/file-diffs", () => {
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

  describe("done tasks without commit SHA", () => {
    it("returns empty array instead of scanning repository", async () => {
      const doneTask = {
        ...FAKE_TASK_DETAIL,
        id: "FN-001",
        column: "done",
        mergeDetails: { filesChanged: 3 },
      };
      (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(doneTask);

      const res = await GET(buildApp(), "/api/tasks/FN-001/file-diffs");

      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it("returns empty array when mergeDetails is undefined", async () => {
      const doneTask = {
        ...FAKE_TASK_DETAIL,
        id: "FN-001",
        column: "done",
        mergeDetails: undefined,
      };
      (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(doneTask);

      const res = await GET(buildApp(), "/api/tasks/FN-001/file-diffs");

      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });
  });
});

describe("GET /tasks/:id/review", () => {
  let store: ReturnType<typeof createMockStore>;

  beforeEach(() => {
    store = createMockStore();
  });

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store));
    return app;
  }

  it("returns normalized reviewer-agent payload in direct mode", async () => {
    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...FAKE_TASK_DETAIL,
      reviewState: { source: "reviewer-agent", items: [], addressing: [] },
      log: [{ timestamp: "2026-05-01T10:00:00.000Z", action: "code review Step 2: REVISE" }],
    });
    (store.getAgentLogs as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        timestamp: "2026-05-01T10:00:01.000Z",
        taskId: "FN-001",
        type: "text",
        text: "## Code Review:\n\n### Verdict: REVISE\n\n### Summary\nNeeds null guard\n",
        agent: "reviewer",
      },
    ]);

    const res = await REQUEST(buildApp(), "GET", "/api/tasks/FN-001/review");
    expect(res.status).toBe(200);
    expect(res.body.reviewState.source).toBe("reviewer-agent");
    expect(res.body.reviewState.items[0].reviewType).toBe("code");
    expect(res.body.reviewState.items[0].verdict).toBe("REVISE");
  });

  it("returns exact empty payload/message when no reviewer feedback exists", async () => {
    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...FAKE_TASK_DETAIL,
      reviewState: { source: "reviewer-agent", items: [], addressing: [] },
      log: [],
    });
    (store.getAgentLogs as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const res = await REQUEST(buildApp(), "GET", "/api/tasks/FN-001/review");
    expect(res.status).toBe(200);
    expect(res.body.reviewState.items).toEqual([]);
    expect(res.body.emptyMessage).toBe("No reviewer feedback yet — this task has not produced reviewer-agent feedback in direct mode.");
  });

  it("falls back to task log summary when reviewer output is incomplete", async () => {
    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...FAKE_TASK_DETAIL,
      reviewState: { source: "reviewer-agent", items: [], addressing: [] },
      log: [{ timestamp: "2026-05-01T10:00:00.000Z", action: "plan review Step 1: APPROVE" }],
    });
    (store.getAgentLogs as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        timestamp: "2026-05-01T10:00:01.000Z",
        taskId: "FN-001",
        type: "text",
        text: "partial stream",
        agent: "reviewer",
      },
    ]);

    const res = await REQUEST(buildApp(), "GET", "/api/tasks/FN-001/review");
    expect(res.status).toBe(200);
    expect(res.body.reviewState.items[0].summary).toBe("plan review Step 1: APPROVE");
    expect(res.body.reviewState.items[0].step).toBe(1);
  });

  it("returns 404 when task is missing", async () => {
    (store.getTask as ReturnType<typeof vi.fn>).mockRejectedValue(Object.assign(new Error("not found"), { code: "ENOENT" }));
    const res = await REQUEST(buildApp(), "GET", "/api/tasks/FN-404/review");
    expect(res.status).toBe(404);
  });
});

describe("POST /tasks/:id/review/refresh", () => {
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

  it("refreshes PR-backed review payload", async () => {
    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...FAKE_TASK_DETAIL,
      prInfo: {
        url: "https://github.com/owner/repo/pull/42",
        number: 42,
        status: "open",
        title: "PR",
        headBranch: "fusion/fn-1",
        baseBranch: "main",
        commentCount: 0,
      },
    });
    vi.spyOn(GitHubClient.prototype, "getPrReviewSnapshot").mockResolvedValue({
      decision: "CHANGES_REQUESTED",
      checks: [],
      prInfo: {
        url: "https://github.com/owner/repo/pull/42",
        number: 42,
        status: "open",
        title: "PR",
        headBranch: "fusion/fn-1",
        baseBranch: "main",
        commentCount: 1,
      },
      commentCount: 1,
      summary: {
        reviewDecision: "CHANGES_REQUESTED",
        reviewers: [],
        blockingReasons: ["needs work"],
        checks: [],
      },
      items: [],
    });

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/FN-001/review/refresh", JSON.stringify({}), {
      "content-type": "application/json",
    });

    expect(res.status).toBe(200);
    expect((store.updateTask as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      "FN-001",
      expect.objectContaining({
        reviewState: expect.objectContaining({
          source: "pull-request",
          refreshSource: "manual",
          refreshStatus: "ready",
          lastRefreshedAt: expect.any(String),
        }),
      }),
    );
  });

  it("returns scoped refresh error payload in PR mode when GitHub refresh fails", async () => {
    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...FAKE_TASK_DETAIL,
      prInfo: {
        url: "https://github.com/owner/repo/pull/42",
        number: 42,
        status: "open",
        title: "PR",
        headBranch: "fusion/fn-1",
        baseBranch: "main",
        commentCount: 0,
      },
      reviewState: { source: "pull-request", items: [], addressing: [] },
    });
    vi.spyOn(GitHubClient.prototype, "getPrReviewSnapshot").mockRejectedValue(new Error("GitHub outage"));

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/FN-001/review/refresh", JSON.stringify({}), {
      "content-type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(res.body.reviewState.refreshStatus).toBe("error");
    expect(res.body.reviewState.refreshError).toContain("GitHub outage");
  });

  it("refreshes direct-mode review payload without PR", async () => {
    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...FAKE_TASK_DETAIL,
      reviewState: {
        source: "reviewer-agent",
        items: [],
        addressing: [],
      },
    });

    const getSnapshotSpy = vi.spyOn(GitHubClient.prototype, "getPrReviewSnapshot");

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/FN-001/review/refresh", JSON.stringify({}), {
      "content-type": "application/json",
    });

    expect(res.status).toBe(200);
    expect((store.updateTask as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      "FN-001",
      expect.objectContaining({
        reviewState: expect.objectContaining({
          source: "reviewer-agent",
          refreshSource: "manual",
          refreshStatus: "ready",
          lastRefreshedAt: expect.any(String),
        }),
      }),
    );
    expect(res.body.reviewState.source).toBe("reviewer-agent");
    expect(getSnapshotSpy).not.toHaveBeenCalled();
  });

  it("returns 404 when task is missing", async () => {
    (store.getTask as ReturnType<typeof vi.fn>).mockRejectedValue(Object.assign(new Error("not found"), { code: "ENOENT" }));
    const res = await REQUEST(buildApp(), "POST", "/api/tasks/FN-404/review/refresh", JSON.stringify({}), {
      "content-type": "application/json",
    });
    expect(res.status).toBe(404);
  });
});

// --- Git Management route tests ---
// These are integration tests that run against the actual git repository
