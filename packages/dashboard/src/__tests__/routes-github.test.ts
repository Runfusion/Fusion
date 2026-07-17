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
  mockGetCachedImportTranslation,
  mockResolveTargetLocale,
} = vi.hoisted(() => ({
  mockPerformUpdateCheck: vi.fn(),
  mockClearUpdateCheckCache: vi.fn(),
  mockExecSync: vi.fn(),
  mockExecFile: vi.fn(),
  mockGetCachedImportTranslation: vi.fn(),
  mockResolveTargetLocale: vi.fn(),
}));

vi.mock("../update-check.js", async () => {
  const actual = await vi.importActual<typeof import("../update-check.js")>("../update-check.js");
  return {
    ...actual,
    performUpdateCheck: mockPerformUpdateCheck,
    clearUpdateCheckCache: mockClearUpdateCheckCache,
  };
});

vi.mock("../import-translate-service.js", async () => {
  const actual = await vi.importActual<typeof import("../import-translate-service.js")>(
    "../import-translate-service.js",
  );
  mockGetCachedImportTranslation.mockImplementation(actual.getCachedImportTranslation);
  mockResolveTargetLocale.mockImplementation(actual.resolveTargetLocale);
  return {
    ...actual,
    getCachedImportTranslation: mockGetCachedImportTranslation,
    resolveTargetLocale: mockResolveTargetLocale,
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
    // FNXC:GitHubImportAttachments 2026-07-15-11:20: import downloads issue screenshots into task attachments.
    addAttachment: vi.fn().mockResolvedValue(undefined),
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
    addPrInfo: vi.fn().mockResolvedValue(undefined),
    updatePrInfoByNumber: vi.fn().mockResolvedValue(undefined),
    removePrInfoByNumber: vi.fn().mockResolvedValue(undefined),
    updateIssueInfo: vi.fn().mockResolvedValue(undefined),
    getRootDir: vi.fn().mockReturnValue("/fake/root"),
    listWorkflowSteps: vi.fn().mockResolvedValue([]),
    createWorkflowStep: vi.fn(),
    getWorkflowStep: vi.fn(),
    updateWorkflowStep: vi.fn(),
    deleteWorkflowStep: vi.fn(),
    clearWorkflowRunStepInstancesAsync: vi.fn().mockResolvedValue(undefined),
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


describe("GET /github/issues/recent", () => {
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

  it("returns filtered recent issues and caches responses", async () => {
    const gitRepo = getSharedGitTestRepo();
    execFileSync("git", ["-C", gitRepo.repoDir, "remote", "set-url", "origin", "https://github.com/owner/repo.git"], { stdio: "pipe" });
    store.getRootDir = vi.fn().mockReturnValue(gitRepo.repoDir);

    listIssuesSpy.mockResolvedValue([
      { number: 42, title: "Feature polish", body: null, html_url: "https://github.com/owner/repo/issues/42", labels: [], state: "open", updatedAt: "2026-05-16T00:00:00Z" },
      { number: 12, title: "Fix tests", body: null, html_url: "https://github.com/owner/repo/issues/12", labels: [], state: "closed", updatedAt: "2026-05-15T00:00:00Z" },
      { number: 99, title: "Draft PR", body: null, html_url: "https://github.com/owner/repo/pull/99", labels: [], state: "open", updatedAt: "2026-05-14T00:00:00Z" },
    ]);

    const first = await REQUEST(buildApp(), "GET", "/api/github/issues/recent?q=feat&limit=20");
    const second = await REQUEST(buildApp(), "GET", "/api/github/issues/recent?q=42&limit=20");

    expect(first.status).toBe(200);
    expect(first.body).toHaveLength(1);
    expect(first.body[0]).toMatchObject({ number: 42, repository: "owner/repo", state: "open" });

    expect(second.status).toBe(200);
    expect(second.body).toHaveLength(1);
    expect(second.body[0].number).toBe(42);

    const all = await REQUEST(buildApp(), "GET", "/api/github/issues/recent");
    expect(all.body.some((item: { number: number }) => item.number === 99)).toBe(false);
    expect(listIssuesSpy).toHaveBeenCalledTimes(1);
  });

  it("returns empty list when no remote exists", async () => {
    const res = await REQUEST(buildApp(), "GET", "/api/github/issues/recent");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
    expect(listIssuesSpy).not.toHaveBeenCalled();
  });

  it("returns empty list when not authenticated", async () => {
    const gitRepo = getSharedGitTestRepo();
    execFileSync("git", ["-C", gitRepo.repoDir, "remote", "set-url", "origin", "https://github.com/owner/repo.git"], { stdio: "pipe" });
    store.getRootDir = vi.fn().mockReturnValue(gitRepo.repoDir);
    mockIsGhAuthenticated.mockReturnValueOnce(false);

    const res = await REQUEST(buildApp(), "GET", "/api/github/issues/recent");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
    expect(listIssuesSpy).not.toHaveBeenCalled();
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
  let getIssueDetailSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockGetCachedImportTranslation.mockClear();
    mockResolveTargetLocale.mockClear();
    mockIsGhAuthenticated.mockReturnValue(true);
    getIssueSpy = vi.fn();
    vi.spyOn(GitHubClient.prototype, "getIssue").mockImplementation(getIssueSpy);
    /*
    FNXC:IssueImportAttachments 2026-07-15-13:40:
    Import scans comments for screenshots, so the comment fetch is stubbed here — unstubbed it would spawn a real `gh` subprocess per import test (slow + network-dependent, against the project's no-slow-tests rule).
    */
    getIssueDetailSpy = vi.fn().mockResolvedValue({ comments: [] });
    vi.spyOn(GitHubClient.prototype, "getIssueDetail").mockImplementation(getIssueDetailSpy);

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

  /*
  FNXC:GitHubImportTranslate 2026-07-16-11:22:
  FN-8115 requires a single project-settings read per single import even though translation and tracking both depend on it. The route test protects the request-scoped sharing invariant rather than the resolver internals.
  */
  it("reads project settings once for a single issue import", async () => {
    getIssueSpy.mockResolvedValueOnce(mockGitHubIssue);

    const res = await REQUEST(buildApp(), "POST", "/api/github/issues/import", JSON.stringify({ owner: "owner", repo: "repo", issueNumber: 1 }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(201);
    expect(store.getSettings).toHaveBeenCalledTimes(1);
  });

  it("uses cached translated prose for an open single issue", async () => {
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({ githubImportAutoTranslate: true });
    mockResolveTargetLocale.mockReturnValueOnce("en");
    mockGetCachedImportTranslation.mockResolvedValueOnce({ title: "Translated title", body: "Translated body" });
    getIssueSpy.mockResolvedValueOnce({ ...mockGitHubIssue, title: "Original title", body: "Original body" });

    const res = await REQUEST(buildApp(), "POST", "/api/github/issues/import", JSON.stringify({ owner: "owner", repo: "repo", issueNumber: 1 }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(201);
    expect(store.createTask).toHaveBeenCalledWith(expect.objectContaining({
      title: "Translated title",
      description: "Translated body\n\nSource: https://github.com/owner/repo/issues/1",
    }));
  });

  /*
  FNXC:GitHubImportAttachments 2026-07-15-11:20:
  Route-level proof that the import path itself downloads issue screenshots into task attachments — the executor's `## Attachments` section and triage's vision blocks only fire for attachments that actually exist on the task, so the wiring (not just the helper) is the invariant.
  */
  it("downloads issue images into task attachments so the agent can read them", async () => {
    const png = Buffer.from("89504e470d0a1a0a", "hex");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      headers: new Headers({ "content-type": "image/png", "content-length": String(png.length) }),
      arrayBuffer: async () => png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength),
    })) as unknown as typeof globalThis.fetch;

    getIssueSpy.mockResolvedValueOnce({
      ...mockGitHubIssue,
      body: "Broken here:\n\n![shot](https://github.com/user-attachments/assets/abc-123)",
    });

    try {
      const res = await REQUEST(buildApp(), "POST", "/api/github/issues/import", JSON.stringify({ owner: "owner", repo: "repo", issueNumber: 1 }), {
        "Content-Type": "application/json",
      });

      expect(res.status).toBe(201);
      expect(store.addAttachment).toHaveBeenCalledWith(
        "FN-001",
        "issue-image-1.png",
        expect.any(Buffer),
        "image/png",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  /*
  FNXC:IssueImportAttachments 2026-07-15-13:40:
  A screenshot posted in a comment is the common case ("here's the repro"), so the comment thread is a first-class image source at the route level, not just in the helper.
  */
  it("downloads images posted in issue comments", async () => {
    const png = Buffer.from("89504e470d0a1a0a", "hex");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      headers: new Headers({ "content-type": "image/png", "content-length": String(png.length) }),
      arrayBuffer: async () => png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength),
    })) as unknown as typeof globalThis.fetch;

    getIssueSpy.mockResolvedValueOnce({ ...mockGitHubIssue, body: "no image here" });
    getIssueDetailSpy.mockResolvedValueOnce({
      comments: [
        { author: "someone", body: "repro: ![shot](https://github.com/user-attachments/assets/from-comment)", createdAt: "", authorIsBot: false },
      ],
    });

    try {
      const res = await REQUEST(buildApp(), "POST", "/api/github/issues/import", JSON.stringify({ owner: "owner", repo: "repo", issueNumber: 1 }), {
        "Content-Type": "application/json",
      });

      expect(res.status).toBe(201);
      expect(store.addAttachment).toHaveBeenCalledWith("FN-001", "issue-image-1.png", expect.any(Buffer), "image/png");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("still imports body images when the comment fetch fails", async () => {
    const png = Buffer.from("89504e470d0a1a0a", "hex");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      headers: new Headers({ "content-type": "image/png", "content-length": String(png.length) }),
      arrayBuffer: async () => png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength),
    })) as unknown as typeof globalThis.fetch;
    vi.spyOn(console, "warn").mockImplementation(() => {});

    getIssueSpy.mockResolvedValueOnce({
      ...mockGitHubIssue,
      body: "![shot](https://github.com/user-attachments/assets/abc-123)",
    });
    getIssueDetailSpy.mockRejectedValueOnce(new Error("comments unavailable"));

    try {
      const res = await REQUEST(buildApp(), "POST", "/api/github/issues/import", JSON.stringify({ owner: "owner", repo: "repo", issueNumber: 1 }), {
        "Content-Type": "application/json",
      });

      expect(res.status).toBe(201);
      expect(store.addAttachment).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("still imports the issue when its image fails to download", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => { throw new Error("network down"); }) as unknown as typeof globalThis.fetch;
    vi.spyOn(console, "warn").mockImplementation(() => {});

    getIssueSpy.mockResolvedValueOnce({
      ...mockGitHubIssue,
      body: "![shot](https://github.com/user-attachments/assets/abc-123)",
    });

    try {
      const res = await REQUEST(buildApp(), "POST", "/api/github/issues/import", JSON.stringify({ owner: "owner", repo: "repo", issueNumber: 1 }), {
        "Content-Type": "application/json",
      });

      expect(res.status).toBe(201);
      expect(res.body.id).toBe("FN-001");
      expect(store.addAttachment).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  /*
   * FNXC:GithubImportTracking 2026-07-16-10:59: Single-import translation reads settings before
   * tracking resolution. Use persistent mocks so both reads mirror production's consistent settings.
   */
  it("marks a single imported issue as tracked when tracking defaults are on", async () => {
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({ githubTrackingEnabledByDefault: true });
    getIssueSpy.mockResolvedValueOnce(mockGitHubIssue);

    const res = await REQUEST(buildApp(), "POST", "/api/github/issues/import", JSON.stringify({ owner: "owner", repo: "repo", issueNumber: 1 }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(201);
    expect(store.createTask).toHaveBeenCalledWith(expect.objectContaining({
      githubTracking: { enabled: true },
      sourceIssue: expect.objectContaining({ provider: "github", repository: "owner/repo", issueNumber: 1 }),
    }));
  });

  it("marks a single imported issue as tracked when import linking is on and new-task defaults are off", async () => {
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      githubTrackingEnabledByDefault: false,
      githubLinkImportedIssuesToTracking: true,
    });
    getIssueSpy.mockResolvedValueOnce({ ...mockGitHubIssue, body: null });

    const res = await REQUEST(buildApp(), "POST", "/api/github/issues/import", JSON.stringify({ owner: "owner", repo: "repo", issueNumber: 1 }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(201);
    expect(store.createTask).toHaveBeenCalledWith(expect.objectContaining({
      description: "(no description)\n\nSource: https://github.com/owner/repo/issues/1",
      githubTracking: { enabled: true },
      sourceIssue: expect.objectContaining({ provider: "github", repository: "owner/repo", issueNumber: 1 }),
    }));
  });

  it("leaves a single imported issue unforced when tracking defaults are off", async () => {
    getIssueSpy.mockResolvedValueOnce(mockGitHubIssue);

    const res = await REQUEST(buildApp(), "POST", "/api/github/issues/import", JSON.stringify({ owner: "owner", repo: "repo", issueNumber: 1 }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(201);
    expect(store.createTask).toHaveBeenCalledWith(expect.not.objectContaining({
      githubTracking: expect.anything(),
    }));
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

  it("returns 409 when sourceIssue matches even if description URL was edited away", async () => {
    (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      {
        id: "FN-002",
        description: "Edited description without source URL",
        column: "triage",
        sourceIssue: {
          provider: "github",
          repository: "Owner/Repo",
          externalIssueId: "1",
          issueNumber: 1,
          url: "https://github.com/other/repo/issues/99",
        },
      },
    ]);

    getIssueSpy.mockResolvedValueOnce(mockGitHubIssue);

    const res = await REQUEST(buildApp(), "POST", "/api/github/issues/import", JSON.stringify({ owner: "owner", repo: "repo", issueNumber: 1 }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(409);
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
    mockGetCachedImportTranslation.mockClear();
    mockResolveTargetLocale.mockClear();

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

  /*
  FNXC:GitHubImportAttachments 2026-07-15-11:20:
  Batch import is a second surface for the same requirement — an issue's screenshots must reach the agent regardless of which import button the operator used (see the single-import counterpart above).
  */
  it("downloads issue images into task attachments on the batch surface too", async () => {
    const png = Buffer.from("89504e470d0a1a0a", "hex");
    const detailSpy = vi.spyOn(GitHubClient.prototype, "getIssueDetail").mockResolvedValue({ comments: [] });
    vi.spyOn(GitHubClient.prototype, "fetchThrottled").mockResolvedValueOnce({
      success: true,
      data: {
        ...mockGitHubIssue(1),
        body: "![shot](https://github.com/user-attachments/assets/abc-123)",
        comments: 0,
      },
    } as Awaited<ReturnType<GitHubClient["fetchThrottled"]>>);

    // The batch route's own fetch spy doubles as the image-download transport here.
    fetchSpy.mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "image/png", "content-length": String(png.length) }),
      arrayBuffer: async () => png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength),
    });

    const res = await REQUEST(buildApp(), "POST", "/api/github/issues/batch-import", JSON.stringify({ owner: "owner", repo: "repo", issueNumbers: [1] }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(res.body.results[0].success).toBe(true);
    expect(store.addAttachment).toHaveBeenCalledWith(
      res.body.results[0].taskId,
      "issue-image-1.png",
      expect.any(Buffer),
      "image/png",
    );
    // A 50-issue batch must not pay a comment round trip per issue to discover empty threads.
    expect(detailSpy).not.toHaveBeenCalled();
  });

  it("keeps the batch item successful when image attachment audit logging fails", async () => {
    const png = Buffer.from("89504e470d0a1a0a", "hex");
    vi.spyOn(GitHubClient.prototype, "fetchThrottled").mockResolvedValueOnce({
      success: true,
      data: {
        ...mockGitHubIssue(1),
        body: "![shot](https://github.com/user-attachments/assets/abc-123)",
        comments: 0,
      },
    } as Awaited<ReturnType<GitHubClient["fetchThrottled"]>>);
    fetchSpy.mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "image/png", "content-length": String(png.length) }),
      arrayBuffer: async () => png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength),
    });
    (store.logEntry as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("audit unavailable"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const res = await REQUEST(buildApp(), "POST", "/api/github/issues/batch-import", JSON.stringify({ owner: "owner", repo: "repo", issueNumbers: [1] }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(res.body.results[0].success).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Could not log image attachments"));
  });

  it("fetches comments on the batch surface only when the issue has any", async () => {
    const png = Buffer.from("89504e470d0a1a0a", "hex");
    const detailSpy = vi.spyOn(GitHubClient.prototype, "getIssueDetail").mockResolvedValue({
      comments: [
        { author: "someone", body: "![shot](https://github.com/user-attachments/assets/from-comment)", createdAt: "", authorIsBot: false },
      ],
    });
    vi.spyOn(GitHubClient.prototype, "fetchThrottled").mockResolvedValueOnce({
      success: true,
      data: { ...mockGitHubIssue(1), body: "no image here", comments: 2 },
    } as Awaited<ReturnType<GitHubClient["fetchThrottled"]>>);

    fetchSpy.mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "image/png", "content-length": String(png.length) }),
      arrayBuffer: async () => png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength),
    });

    const res = await REQUEST(buildApp(), "POST", "/api/github/issues/batch-import", JSON.stringify({ owner: "owner", repo: "repo", issueNumbers: [1] }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(detailSpy).toHaveBeenCalledTimes(1);
    expect(store.addAttachment).toHaveBeenCalledWith(
      res.body.results[0].taskId,
      "issue-image-1.png",
      expect.any(Buffer),
      "image/png",
    );
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
    expect(store.getSettings).toHaveBeenCalledTimes(1);
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

  /*
  FNXC:GitHubImportTranslate 2026-07-16-11:22:
  Batch imports reuse one request-scoped settings object for every item. Cached translations still apply to open issues, while closed issues always retain original prose even when the cache has a hit.
  */
  it("preserves open translations and closed original prose in a batch", async () => {
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({ githubImportAutoTranslate: true });
    mockResolveTargetLocale.mockReturnValueOnce("en").mockReturnValueOnce("en");
    mockGetCachedImportTranslation.mockResolvedValueOnce({ title: "Translated batch title", body: "Translated batch body" });
    vi.spyOn(GitHubClient.prototype, "fetchThrottled")
      .mockResolvedValueOnce({
        success: true,
        data: { ...mockGitHubIssue(1, "Original open title"), body: "Original open body", state: "open" },
      } as Awaited<ReturnType<GitHubClient["fetchThrottled"]>>)
      .mockResolvedValueOnce({
        success: true,
        data: { ...mockGitHubIssue(2, "Original closed title"), body: "Original closed body", state: "closed" },
      } as Awaited<ReturnType<GitHubClient["fetchThrottled"]>>);

    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/github/issues/batch-import",
      JSON.stringify({ owner: "owner", repo: "repo", issueNumbers: [1, 2], delayMs: 1 }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(200);
    expect(store.getSettings).toHaveBeenCalledTimes(1);
    expect(store.createTask).toHaveBeenNthCalledWith(1, expect.objectContaining({
      title: "Translated batch title",
      description: "Translated batch body\n\nSource: https://github.com/owner/repo/issues/1",
    }));
    expect(store.createTask).toHaveBeenNthCalledWith(2, expect.objectContaining({
      title: "Original closed title",
      description: "Original closed body\n\nSource: https://github.com/owner/repo/issues/2",
    }));
    expect(mockGetCachedImportTranslation).toHaveBeenCalledTimes(2);
    expect(mockGetCachedImportTranslation).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({ state: "closed" }),
    );
  });

  it("marks batch imported issues as tracked when global tracking defaults are on", async () => {
    const globalSettingsStore = { getSettings: vi.fn().mockResolvedValue({ githubTrackingDefaultEnabledForNewTasks: true }) };
    (store.getGlobalSettingsStore as ReturnType<typeof vi.fn>).mockReturnValueOnce(globalSettingsStore);
    const throttledSpy = vi.spyOn(GitHubClient.prototype, "fetchThrottled")
      .mockResolvedValueOnce({
        success: true,
        data: mockGitHubIssue(1, "Tracked Batch Issue"),
      } as Awaited<ReturnType<GitHubClient["fetchThrottled"]>>);

    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/github/issues/batch-import",
      JSON.stringify({ owner: "owner", repo: "repo", issueNumbers: [1], delayMs: 1 }),
      { "Content-Type": "application/json" }
    );

    expect(res.status).toBe(200);
    expect(throttledSpy).toHaveBeenCalledTimes(1);
    expect(store.createTask).toHaveBeenCalledWith(expect.objectContaining({
      githubTracking: { enabled: true },
      sourceIssue: expect.objectContaining({ provider: "github", repository: "owner/repo", issueNumber: 1 }),
    }));
  });

  it("marks batch imported issues as tracked when import linking is on and new-task defaults are off", async () => {
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      githubTrackingEnabledByDefault: false,
      githubLinkImportedIssuesToTracking: true,
    });
    vi.spyOn(GitHubClient.prototype, "fetchThrottled")
      .mockResolvedValueOnce({
        success: true,
        data: mockGitHubIssue(1, "Import-linked Batch Issue"),
      } as Awaited<ReturnType<GitHubClient["fetchThrottled"]>>);

    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/github/issues/batch-import",
      JSON.stringify({ owner: "owner", repo: "repo", issueNumbers: [1], delayMs: 1 }),
      { "Content-Type": "application/json" }
    );

    expect(res.status).toBe(200);
    expect(store.createTask).toHaveBeenCalledWith(expect.objectContaining({
      githubTracking: { enabled: true },
      sourceIssue: expect.objectContaining({ provider: "github", repository: "owner/repo", issueNumber: 1 }),
    }));
  });

  it("leaves batch imported issues unforced when tracking defaults are off", async () => {
    vi.spyOn(GitHubClient.prototype, "fetchThrottled")
      .mockResolvedValueOnce({
        success: true,
        data: mockGitHubIssue(1, "Untracked Batch Issue"),
      } as Awaited<ReturnType<GitHubClient["fetchThrottled"]>>);

    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/github/issues/batch-import",
      JSON.stringify({ owner: "owner", repo: "repo", issueNumbers: [1], delayMs: 1 }),
      { "Content-Type": "application/json" }
    );

    expect(res.status).toBe(200);
    expect(store.createTask).toHaveBeenCalledWith(expect.not.objectContaining({
      githubTracking: expect.anything(),
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

  it("skips batch issues whose sourceIssue already matches even if description URL was edited away", async () => {
    (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: "FN-200",
        description: "Edited description without source URL",
        column: "triage",
        sourceIssue: {
          provider: "github",
          repository: "Owner/Repo",
          externalIssueId: "1",
          issueNumber: 1,
          url: "https://github.com/other/repo/issues/99",
        },
      },
    ]);

    const throttledSpy = vi.spyOn(GitHubClient.prototype, "fetchThrottled")
      .mockResolvedValueOnce({
        success: true,
        data: mockGitHubIssue(1, "Already Imported Issue"),
      } as Awaited<ReturnType<GitHubClient["fetchThrottled"]>>)
      .mockResolvedValueOnce({
        success: true,
        data: mockGitHubIssue(2, "Fresh Issue"),
      } as Awaited<ReturnType<GitHubClient["fetchThrottled"]>>);

    const res = await REQUEST(
      buildApp(),
      "POST",
      "/api/github/issues/batch-import",
      JSON.stringify({ owner: "owner", repo: "repo", issueNumbers: [1, 2], delayMs: 1 }),
      { "Content-Type": "application/json" }
    );

    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([
      { issueNumber: 1, success: true, skipped: true, taskId: "FN-200" },
      { issueNumber: 2, success: true, taskId: expect.any(String) },
    ]);
    expect(store.createTask).toHaveBeenCalledTimes(1);
    expect(store.createTask).toHaveBeenCalledWith(expect.objectContaining({
      sourceIssue: expect.objectContaining({ issueNumber: 2 }),
    }));
    expect(throttledSpy).toHaveBeenCalledTimes(2);
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

describe("POST /github/pulls/import and /github/comments/import", () => {
  let store: TaskStore;

  beforeEach(() => {
    mockIsGhAuthenticated.mockReturnValue(true);
    store = createMockStore({
      listTasks: vi.fn().mockResolvedValue([]),
      createTask: vi.fn().mockResolvedValue({ ...FAKE_TASK_DETAIL, id: "FN-FEEDBACK", column: "triage" }),
      logEntry: vi.fn().mockResolvedValue(undefined),
    });
  });

  afterEach(() => vi.restoreAllMocks());

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store));
    return app;
  }

  it("creates resolve-feedback PR tasks while retaining provenance and deduplication", async () => {
    vi.spyOn(GitHubClient.prototype, "getPullRequest").mockResolvedValue({
      number: 9,
      title: "Feedback PR",
      body: "PR body",
      html_url: "https://github.com/owner/repo/pull/9",
      headBranch: "feature/feedback",
      baseBranch: "main",
      state: "open",
    });

    const res = await REQUEST(buildApp(), "POST", "/api/github/pulls/import", JSON.stringify({ owner: "owner", repo: "repo", prNumber: 9 }), {
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(201);
    expect(store.createTask).toHaveBeenCalledWith(expect.objectContaining({
      title: "Resolve feedback: PR #9 — Feedback PR",
      description: expect.stringContaining("Resolve the pull request review feedback and address any failed CI checks."),
    }));
    expect(store.createTask).toHaveBeenCalledWith(expect.objectContaining({
      description: expect.stringContaining("PR: https://github.com/owner/repo/pull/9\nBranch: feature/feedback → main\n\nPR body"),
    }));
  });

  it("creates comment feedback tasks without deduplicating repeated imports", async () => {
    const payload = { owner: "owner", repo: "repo", number: 9, type: "pull", comment: { author: "reviewer", body: "Please add coverage", createdAt: "2026-07-16T00:00:00Z" } };
    const first = await REQUEST(buildApp(), "POST", "/api/github/comments/import", JSON.stringify(payload), { "Content-Type": "application/json" });
    const second = await REQUEST(buildApp(), "POST", "/api/github/comments/import", JSON.stringify(payload), { "Content-Type": "application/json" });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(store.createTask).toHaveBeenCalledTimes(2);
    expect(store.createTask).toHaveBeenCalledWith(expect.objectContaining({
      title: "Resolve feedback from @reviewer on #9",
      description: "Resolve or address this feedback comment.\n\n> reviewer\n> Please add coverage\n\nSource: https://github.com/owner/repo/pull/9",
    }));
    expect(store.logEntry).toHaveBeenCalledWith("FN-FEEDBACK", "Imported PR/issue comment from GitHub", "https://github.com/owner/repo/pull/9");
  });

  it("requires GitHub authentication and complete comment payloads", async () => {
    const invalid = await REQUEST(buildApp(), "POST", "/api/github/comments/import", JSON.stringify({ owner: "owner" }), { "Content-Type": "application/json" });
    expect(invalid.status).toBe(400);

    mockIsGhAuthenticated.mockReturnValue(false);
    const unauthenticated = await REQUEST(buildApp(), "POST", "/api/github/comments/import", JSON.stringify({
      owner: "owner", repo: "repo", number: 1, type: "issue", comment: { author: "reviewer", body: "Fix it" },
    }), { "Content-Type": "application/json" });
    expect(unauthenticated.status).toBe(401);
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
          { id: "subtask-1", title: "First scoped task", description: "First", suggestedSize: "S", dependsOn: [] },
          { id: "subtask-2", title: "Second scoped task", description: "Second", suggestedSize: "M", dependsOn: ["subtask-1"] },
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
    expect(scopedStore.deleteTask).toHaveBeenCalledWith("FN-PARENT", expect.objectContaining({
      auditContext: expect.objectContaining({
        agentId: "system",
        runId: expect.stringMatching(/^synthetic-planning-delete-FN-PARENT-/),
        sessionId: "subtask-session-1",
      }),
    }));
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
      expect(store.moveTask).toHaveBeenCalledWith("FN-001", "triage", { moveSource: "user", recoveryRehome: true });
      expect((store as unknown as { clearWorkflowRunStepInstancesAsync: ReturnType<typeof vi.fn> }).clearWorkflowRunStepInstancesAsync).toHaveBeenCalledWith("FN-001");
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
    expect(store.moveTask).toHaveBeenCalledWith("FN-001", "triage", { moveSource: "user", recoveryRehome: true });
    expect((store as unknown as { clearWorkflowRunStepInstancesAsync: ReturnType<typeof vi.fn> }).clearWorkflowRunStepInstancesAsync).toHaveBeenCalledWith("FN-001");
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
    expect(store.moveTask).toHaveBeenCalledWith("FN-001", "triage", { moveSource: "user", recoveryRehome: true });
    expect((store as unknown as { clearWorkflowRunStepInstancesAsync: ReturnType<typeof vi.fn> }).clearWorkflowRunStepInstancesAsync).toHaveBeenCalledWith("FN-001");
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
      expect((store as unknown as { clearWorkflowRunStepInstancesAsync: ReturnType<typeof vi.fn> }).clearWorkflowRunStepInstancesAsync).toHaveBeenCalledWith("FN-001");
      expect(existsSync(join(taskDir, "PROMPT.md"))).toBe(false);
      expect(store.updateTask).toHaveBeenCalledWith("FN-001", { status: "needs-replan" });
      expect(res.body.status).toBe("needs-replan");
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
    expect(store.moveTask).toHaveBeenCalledWith("FN-001", "triage", { moveSource: "user", recoveryRehome: true });
    expect((store as unknown as { clearWorkflowRunStepInstancesAsync: ReturnType<typeof vi.fn> }).clearWorkflowRunStepInstancesAsync).toHaveBeenCalledWith("FN-001");
    expect(store.updateTask).toHaveBeenCalledWith("FN-001", { status: "needs-replan" });
  });

  function selectWorkflow(columns: Array<{ id: string; traits?: Array<{ trait: string }> }>) {
    const workflowIr = {
      version: 2,
      columns: columns.map((column) => ({ name: column.id, traits: [], ...column })),
      nodes: [],
      edges: [],
    };
    (store as unknown as { getTaskWorkflowSelection: ReturnType<typeof vi.fn> }).getTaskWorkflowSelection = vi.fn()
      .mockReturnValue({ workflowId: "WF-rebuild-test" });
    (store as unknown as { getWorkflowDefinition: ReturnType<typeof vi.fn> }).getWorkflowDefinition = vi.fn()
      .mockResolvedValue({ id: "WF-rebuild-test", ir: workflowIr });
  }

  it("rebuilds a no-triage/no-todo workflow through legacy triage recovery rehome", async () => {
    const customTask = { ...FAKE_TASK_DETAIL, column: "publish" as any };
    const movedTask = { ...customTask, column: "triage" as any };
    const tempRoot = mkdtempSync(join(tmpdir(), "kb-spec-rebuild-legacy-rehome-"));
    const taskDir = join(tempRoot, ".fusion", "tasks", "FN-001");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "PROMPT.md"), "# stale spec\n");
    selectWorkflow([{ id: "publish" }]);
    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(customTask);
    (store.moveTask as ReturnType<typeof vi.fn>).mockResolvedValue(movedTask);
    (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValue(movedTask);
    (store.getRootDir as ReturnType<typeof vi.fn>).mockReturnValue(tempRoot);

    try {
      const res = await REQUEST(buildApp(), "POST", "/api/tasks/KB-001/spec/rebuild");

      expect(res.status).toBe(200);
      expect(store.moveTask).toHaveBeenCalledWith("FN-001", "triage", { moveSource: "user", recoveryRehome: true });
      expect((store as unknown as { clearWorkflowRunStepInstancesAsync: ReturnType<typeof vi.fn> }).clearWorkflowRunStepInstancesAsync).toHaveBeenCalledWith("FN-001");
      expect(existsSync(join(taskDir, "PROMPT.md"))).toBe(false);
      expect(store.updateTask).toHaveBeenCalledWith("FN-001", { status: "needs-replan" });
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("returns the updated task when a plan-in-place workflow is already in todo", async () => {
    const todoTask = { ...FAKE_TASK_DETAIL, column: "todo" as any };
    const updatedTask = { ...todoTask, status: "needs-replan" as const };
    selectWorkflow([{ id: "todo" }, { id: "in-review" }]);
    (store.getTask as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(todoTask)
      .mockResolvedValueOnce(updatedTask);
    (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValue(updatedTask);

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/KB-001/spec/rebuild");

    expect(res.status).toBe(200);
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(store.updateTask).toHaveBeenCalledWith("FN-001", { status: "needs-replan" });
    expect(res.body.status).toBe("needs-replan");
  });

  it("rebuilds a plan-in-place workflow into todo", async () => {
    const customTask = { ...FAKE_TASK_DETAIL, column: "in-review" as any };
    const movedTask = { ...customTask, column: "todo" as any };
    selectWorkflow([{ id: "todo" }, { id: "in-review" }]);
    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(customTask);
    (store.moveTask as ReturnType<typeof vi.fn>).mockResolvedValue(movedTask);
    (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValue(movedTask);

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/KB-001/spec/rebuild");

    expect(res.status).toBe(200);
    expect(store.moveTask).toHaveBeenCalledWith("FN-001", "todo", { moveSource: "user", recoveryRehome: true });
    expect(store.updateTask).toHaveBeenCalledWith("FN-001", { status: "needs-replan" });
  });

  it("rejects legacy and semantic archived tasks before rebuilding", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "kb-spec-rebuild-archived-"));
    const taskDir = join(tempRoot, ".fusion", "tasks", "FN-001");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "PROMPT.md"), "# retained spec\n");
    const archivedTask = { ...FAKE_TASK_DETAIL, column: "cold-storage" as any };
    selectWorkflow([{ id: "cold-storage", traits: [{ trait: "archived" }] }]);
    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(archivedTask);
    (store.getRootDir as ReturnType<typeof vi.fn>).mockReturnValue(tempRoot);

    try {
      const res = await REQUEST(buildApp(), "POST", "/api/tasks/KB-001/spec/rebuild");

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("not available for archived tasks");
      expect(store.moveTask).not.toHaveBeenCalled();
      expect(store.updateTask).not.toHaveBeenCalled();
      expect(existsSync(join(taskDir, "PROMPT.md"))).toBe(true);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
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

  // FNXC:ReleaseAuthorizationGate 2026-07-09-00:00: the release-authorization gate
  // and its approve-plan guard were removed. A task still carrying the legacy
  // awaitingApprovalReason === "release-authorization" (parked by the old gate) must
  // now approve normally instead of being stranded with a 400 and no exit.
  it("approves a task carrying the legacy release-authorization hold", async () => {
    const releaseHoldTask = {
      ...FAKE_TASK_DETAIL,
      column: "triage" as const,
      status: "awaiting-approval" as const,
      awaitingApprovalReason: "release-authorization" as const,
    };
    const movedTask = { ...FAKE_TASK_DETAIL, column: "todo" as const };
    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(releaseHoldTask);
    (store.moveTask as ReturnType<typeof vi.fn>).mockResolvedValue(movedTask);
    (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValue({ ...movedTask, status: undefined });

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/KB-001/approve-plan");

    expect(res.status).toBe(200);
    expect(store.moveTask).toHaveBeenCalledWith("FN-001", "todo");
  });

  // Passthrough: an ordinary manual-approval hold (no awaitingApprovalReason)
  // must still approve exactly as before — the guard is scoped to release-authorization only.
  it("still approves a manual-approval hold with awaitingApprovalReason unset", async () => {
    const awaitingTask = {
      ...FAKE_TASK_DETAIL,
      column: "triage" as const,
      status: "awaiting-approval" as const,
      awaitingApprovalReason: undefined,
    };
    const movedTask = { ...FAKE_TASK_DETAIL, column: "todo" as const };

    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(awaitingTask);
    (store.moveTask as ReturnType<typeof vi.fn>).mockResolvedValue(movedTask);
    (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValue({ ...movedTask, status: undefined });

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/KB-001/approve-plan");

    expect(res.status).toBe(200);
    expect(store.moveTask).toHaveBeenCalledWith("FN-001", "todo");
  });

  /*
   * FNXC:PlanApproval 2026-07-04-22:41:
   * FN-7569 — approve-plan must persist an approvedPlanFingerprint hash of the current
   * on-disk PROMPT.md so a later re-specification of the SAME plan can skip re-asking.
   */
  it("records an approvedPlanFingerprint hash of the on-disk PROMPT.md", async () => {
    const root = mkdtempSync(join(tmpdir(), "kb-dashboard-approve-plan-"));
    try {
      mkdirSync(join(root, ".fusion", "tasks", "FN-001"), { recursive: true });
      writeFileSync(join(root, ".fusion", "tasks", "FN-001", "PROMPT.md"), "# Task: FN-001\n\nApproved plan body.\n");

      const localStore = createMockStore({
        getTask: vi.fn(),
        moveTask: vi.fn(),
        updateTask: vi.fn(),
        logEntry: vi.fn().mockResolvedValue(undefined),
        getRootDir: vi.fn().mockReturnValue(root),
      });
      const awaitingTask = { ...FAKE_TASK_DETAIL, column: "triage" as const, status: "awaiting-approval" as const };
      const movedTask = { ...FAKE_TASK_DETAIL, column: "todo" as const };
      (localStore.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(awaitingTask);
      (localStore.moveTask as ReturnType<typeof vi.fn>).mockResolvedValue(movedTask);
      (localStore.updateTask as ReturnType<typeof vi.fn>).mockResolvedValue({ ...movedTask, status: undefined });

      const app = express();
      app.use(express.json());
      app.use("/api", createApiRoutes(localStore));

      const res = await REQUEST(app, "POST", "/api/tasks/KB-001/approve-plan");

      expect(res.status).toBe(200);
      expect(localStore.updateTask).toHaveBeenCalledWith(
        "FN-001",
        expect.objectContaining({ status: undefined, approvedPlanFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/) }),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
    // FN-7569: reject-plan clears any previously-recorded approval fingerprint so a
    // regenerated plan is always treated as new and requires fresh manual approval.
    expect(store.updateTask).toHaveBeenCalledWith("FN-001", { status: undefined, approvedPlanFingerprint: null });
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

  // FNXC:ReleaseAuthorizationGate 2026-07-09-00:00: with the gate removed, a task
  // still carrying the legacy release-authorization hold must reject normally rather
  // than returning 400 — the old reject-plan guard was removed alongside the gate.
  it("rejects a task carrying the legacy release-authorization hold", async () => {
    const releaseHoldTask = {
      ...FAKE_TASK_DETAIL,
      column: "triage" as const,
      status: "awaiting-approval" as const,
      awaitingApprovalReason: "release-authorization" as const,
    };
    const updatedTask = { ...FAKE_TASK_DETAIL, column: "triage" as const, status: undefined };
    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(releaseHoldTask);
    (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValue(updatedTask);

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/KB-001/reject-plan");

    expect(res.status).toBe(200);
    expect(store.updateTask).toHaveBeenCalledWith("FN-001", { status: undefined, approvedPlanFingerprint: null });
  });

  // Passthrough: an ordinary manual-approval hold (no awaitingApprovalReason)
  // must still reject exactly as before — the guard is scoped to release-authorization only.
  it("still rejects a manual-approval hold with awaitingApprovalReason unset", async () => {
    const awaitingTask = {
      ...FAKE_TASK_DETAIL,
      column: "triage" as const,
      status: "awaiting-approval" as const,
      awaitingApprovalReason: undefined,
    };
    const updatedTask = { ...FAKE_TASK_DETAIL, column: "triage" as const, status: undefined };

    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(awaitingTask);
    (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValue(updatedTask);

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/KB-001/reject-plan");

    expect(res.status).toBe(200);
    expect(store.updateTask).toHaveBeenCalledWith("FN-001", { status: undefined, approvedPlanFingerprint: null });
  });

  /*
   * FNXC:PlanApproval 2026-07-04-22:41:
   * FN-7569 — reject-plan must clear a previously-recorded approval fingerprint
   * regardless of its prior value, so a regenerated plan never inherits it.
   */
  it("clears an existing approvedPlanFingerprint on reject", async () => {
    const awaitingTask = {
      ...FAKE_TASK_DETAIL,
      column: "triage" as const,
      status: "awaiting-approval" as const,
      approvedPlanFingerprint: "deadbeef",
    };
    const updatedTask = { ...FAKE_TASK_DETAIL, column: "triage" as const, status: undefined, approvedPlanFingerprint: undefined };

    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(awaitingTask);
    (store.updateTask as ReturnType<typeof vi.fn>).mockResolvedValue(updatedTask);

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/KB-001/reject-plan");

    expect(res.status).toBe(200);
    expect(store.updateTask).toHaveBeenCalledWith("FN-001", { status: undefined, approvedPlanFingerprint: null });
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
    it("returns safe empty file list with zero stats", async () => {
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
        filesChanged: 0,
        additions: 0,
        deletions: 0,
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

  it("resolves missing done-task commitSha from run-audit commit events", async () => {
    const root = mkdtempSync(join(tmpdir(), "kb-dashboard-done-audit-"));
    try {
      execFileSync("git", ["init", "--initial-branch=main", root], { stdio: "pipe" });
      execFileSync("git", ["-C", root, "config", "user.email", "kb-tests@example.com"], { stdio: "pipe" });
      execFileSync("git", ["-C", root, "config", "user.name", "KB Tests"], { stdio: "pipe" });
      writeFileSync(join(root, "tracked.ts"), "export const value = 1;\n");
      execFileSync("git", ["-C", root, "add", "tracked.ts"], { stdio: "pipe" });
      execFileSync("git", ["-C", root, "commit", "-m", "initial"], { stdio: "pipe" });
      writeFileSync(join(root, "tracked.ts"), "export const value = 2;\n");
      execFileSync("git", ["-C", root, "commit", "-am", "update"], { stdio: "pipe" });
      const mergeSha = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf-8", stdio: "pipe" }).trim();

      const localStore = createMockStore({
        getRootDir: vi.fn().mockReturnValue(root),
        getRunAuditEventsAsync: vi.fn().mockResolvedValue([{ mutationType: "commit:create", target: mergeSha }]),
        getTaskCommitAssociationsByLineageId: vi.fn().mockResolvedValue([]),
      });
      (localStore.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...FAKE_TASK_DETAIL,
        id: "FN-001",
        column: "done",
        mergeDetails: { filesChanged: 1, insertions: 1, deletions: 1 },
      });

      const app = express();
      app.use(express.json());
      app.use("/api", createApiRoutes(localStore));

      const res = await GET(app, "/api/tasks/FN-001/diff");
      expect(res.status).toBe(200);
      expect(res.body.stats.filesChanged).toBe(1);
      expect(res.body.stats.additions).toBeGreaterThan(0);
      expect(res.body.stats.deletions).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolves missing done-task commitSha from lineage associations when audit has no sha", async () => {
    const root = mkdtempSync(join(tmpdir(), "kb-dashboard-done-lineage-"));
    try {
      execFileSync("git", ["init", "--initial-branch=main", root], { stdio: "pipe" });
      execFileSync("git", ["-C", root, "config", "user.email", "kb-tests@example.com"], { stdio: "pipe" });
      execFileSync("git", ["-C", root, "config", "user.name", "KB Tests"], { stdio: "pipe" });
      writeFileSync(join(root, "tracked.ts"), "export const value = 1;\n");
      execFileSync("git", ["-C", root, "add", "tracked.ts"], { stdio: "pipe" });
      execFileSync("git", ["-C", root, "commit", "-m", "initial"], { stdio: "pipe" });
      writeFileSync(join(root, "tracked.ts"), "export const value = 3;\n");
      execFileSync("git", ["-C", root, "commit", "-am", "lineage change"], { stdio: "pipe" });
      const lineageSha = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf-8", stdio: "pipe" }).trim();

      const localStore = createMockStore({
        getRootDir: vi.fn().mockReturnValue(root),
        getRunAuditEventsAsync: vi.fn().mockResolvedValue([]),
        getTaskCommitAssociationsByLineageId: vi.fn().mockResolvedValue([{ commitSha: lineageSha, authoredAt: new Date().toISOString() }]),
      });
      (localStore.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...FAKE_TASK_DETAIL,
        id: "FN-001",
        lineageId: "lineage-1",
        column: "done",
        mergeDetails: { filesChanged: 1, insertions: 1, deletions: 1 },
      });

      const app = express();
      app.use(express.json());
      app.use("/api", createApiRoutes(localStore));

      const res = await GET(app, "/api/tasks/FN-001/diff");
      expect(res.status).toBe(200);
      expect(res.body.stats.filesChanged).toBe(1);
      expect(res.body.stats.additions).toBeGreaterThan(0);
      expect(res.body.stats.deletions).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns zero stats when no done-task commit sha can be resolved", async () => {
    const localStore = createMockStore({
      getRunAuditEventsAsync: vi.fn().mockResolvedValue([{ mutationType: "commit:create", target: "HEAD" }]),
      getTaskCommitAssociationsByLineageId: vi.fn().mockResolvedValue([]),
    });
    (localStore.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...FAKE_TASK_DETAIL,
      id: "FN-001",
      lineageId: "lineage-1",
      column: "done",
      mergeDetails: { filesChanged: 3, insertions: 10, deletions: 2 },
    });

    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(localStore));

    const res = await GET(app, "/api/tasks/FN-001/diff");
    expect(res.status).toBe(200);
    expect(res.body.files).toEqual([]);
    expect(res.body.stats).toEqual({ filesChanged: 0, additions: 0, deletions: 0 });
  });

  it("uses destination path for rename entries in active-task name-status parsing", async () => {
    const root = mkdtempSync(join(tmpdir(), "kb-dashboard-rename-"));
    try {
      execFileSync("git", ["init", "--initial-branch=main", root], { stdio: "pipe" });
      execFileSync("git", ["-C", root, "config", "user.email", "kb-tests@example.com"], { stdio: "pipe" });
      execFileSync("git", ["-C", root, "config", "user.name", "KB Tests"], { stdio: "pipe" });
      writeFileSync(join(root, "old.ts"), "export const value = 1;\n");
      execFileSync("git", ["-C", root, "add", "old.ts"], { stdio: "pipe" });
      execFileSync("git", ["-C", root, "commit", "-m", "add old"], { stdio: "pipe" });
      const baseSha = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf-8", stdio: "pipe" }).trim();
      execFileSync("git", ["-C", root, "mv", "old.ts", "new.ts"], { stdio: "pipe" });
      writeFileSync(join(root, "new.ts"), "export const value = 2;\n");

      const localStore = createMockStore({ getRootDir: vi.fn().mockReturnValue(root) });
      (localStore.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...FAKE_TASK_DETAIL,
        id: "FN-001",
        column: "in-progress",
        branch: "main",
        worktree: root,
        baseCommitSha: baseSha,
      });

      const app = express();
      app.use(express.json());
      app.use("/api", createApiRoutes(localStore));

      const res = await GET(app, "/api/tasks/FN-001/diff");
      expect(res.status).toBe(200);
      expect(res.body.files.map((file: { path: string }) => file.path)).toContain("new.ts");
      expect(res.body.files.map((file: { path: string }) => file.path)).not.toContain("old.ts");
      expect(res.body.stats.filesChanged).toBe(1);
      expect(Number.isInteger(res.body.stats.additions)).toBe(true);
      expect(Number.isInteger(res.body.stats.deletions)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
    /*
     * FNXC:DoneTaskDiffAudit 2026-07-15-18:00:
     * Done-task diff endpoints must resolve audit commit SHAs through the asynchronous
     * PostgreSQL-authoritative reader. Cover file-diffs as well as the sibling diff route.
     */
    it("returns changed files when the async audit commit SHA is available", async () => {
      const root = mkdtempSync(join(tmpdir(), "kb-dashboard-file-diffs-audit-"));
      try {
        execFileSync("git", ["init", "--initial-branch=main", root], { stdio: "pipe" });
        execFileSync("git", ["-C", root, "config", "user.email", "kb-tests@example.com"], { stdio: "pipe" });
        execFileSync("git", ["-C", root, "config", "user.name", "KB Tests"], { stdio: "pipe" });
        writeFileSync(join(root, "tracked.ts"), "export const value = 1;\n");
        execFileSync("git", ["-C", root, "add", "tracked.ts"], { stdio: "pipe" });
        execFileSync("git", ["-C", root, "commit", "-m", "initial"], { stdio: "pipe" });
        writeFileSync(join(root, "tracked.ts"), "export const value = 2;\n");
        execFileSync("git", ["-C", root, "commit", "-am", "update"], { stdio: "pipe" });
        const mergeSha = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf-8", stdio: "pipe" }).trim();

        store = createMockStore({
          getRootDir: vi.fn().mockReturnValue(root),
          getRunAuditEventsAsync: vi.fn().mockResolvedValue([{ mutationType: "commit:create", target: mergeSha }]),
          getTaskCommitAssociationsByLineageId: vi.fn().mockResolvedValue([]),
        });
        (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
          ...FAKE_TASK_DETAIL,
          id: "FN-001",
          column: "done",
          mergeDetails: { filesChanged: 1, insertions: 1, deletions: 1 },
        });

        const res = await GET(buildApp(), "/api/tasks/FN-001/file-diffs");

        expect(res.status).toBe(200);
        expect(res.body).toEqual(expect.arrayContaining([expect.objectContaining({ path: "tracked.ts" })]));
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

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
    expect(res.body.mode).toBe("reviewer-agent");
    expect(res.body.items[0].sourceMode).toBe("reviewer-agent");
    expect(res.body.items[0].reviewState).toBe("REVISE");
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
    expect(res.body.mode).toBe("reviewer-agent");
    expect(res.body.summary).toBeNull();
    expect(res.body.items).toEqual([]);
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
    expect(res.body.items[0].title).toContain("plan review APPROVE");
    expect(res.body.items[0].itemId).toContain("step-1");
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

  afterEach(() => {
    vi.restoreAllMocks();
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
    vi.spyOn(GitHubClient.prototype, "getPrReviewDetails").mockResolvedValue({
      mode: "pull-request",
      refreshable: true,
      fetchedAt: "2026-05-01T10:00:00.000Z",
      summary: { reviewDecision: "CHANGES_REQUESTED", reviewers: [], blockingReasons: ["needs work"], checks: [] },
      items: [],
    });

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/FN-001/review/refresh", JSON.stringify({}), {
      "content-type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(res.body.mode).toBe("pull-request");
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
    vi.spyOn(GitHubClient.prototype, "getPrReviewDetails").mockRejectedValue(new Error("GitHub outage"));

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/FN-001/review/refresh", JSON.stringify({}), {
      "content-type": "application/json",
    });

    expect(res.status).toBe(500);
    expect(res.body.error).toContain("GitHub outage");
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

    const getDetailsSpy = vi.spyOn(GitHubClient.prototype, "getPrReviewDetails");

    const res = await REQUEST(buildApp(), "POST", "/api/tasks/FN-001/review/refresh", JSON.stringify({}), {
      "content-type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(res.body.mode).toBe("reviewer-agent");
    expect(getDetailsSpy).not.toHaveBeenCalled();
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

describe("PR conflict refresh + reclaim routes", () => {
  let store: TaskStore;

  beforeEach(() => {
    store = createMockStore({
      getTask: vi.fn(),
      getSettings: vi.fn().mockResolvedValue({ directMergeCommitStrategy: "auto" }),
      updatePrInfo: vi.fn().mockResolvedValue(undefined),
      updatePrInfoByNumber: vi.fn().mockResolvedValue(undefined),
      addPrInfo: vi.fn().mockResolvedValue(undefined),
      removePrInfoByNumber: vi.fn().mockResolvedValue(undefined),
      applyPrMergedTransition: vi.fn().mockResolvedValue(undefined),
    });
    mockIsGhAuthenticated.mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function buildApp(options?: Parameters<typeof createApiRoutes>[1]) {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store, options));
    return app;
  }

  it("create-PR on a task with an existing PR appends instead of overwriting", async () => {
    process.env.GITHUB_REPOSITORY = "owner/repo";
    const existingPr = {
      url: "https://github.com/owner/repo/pull/900",
      number: 900,
      status: "open",
      title: "Existing",
      headBranch: "fusion/fn-900",
      baseBranch: "main",
      commentCount: 0,
    };
    const task = { ...FAKE_TASK_DETAIL, id: "FN-900", column: "in-review", prInfo: existingPr, prInfos: [existingPr] };
    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(task);

    vi.spyOn(GitHubClient.prototype, "findPrForBranch").mockResolvedValue({
      url: "https://github.com/owner/repo/pull/901",
      number: 901,
      status: "open",
      title: "New",
      headBranch: "fusion/fn-900",
      baseBranch: "main",
      commentCount: 0,
    } as any);

    const res = await REQUEST(buildApp(), "POST", `/api/tasks/${task.id}/pr/create`, JSON.stringify({ title: "New PR", body: "New PR body" }), { "content-type": "application/json" });

    expect(res.status).toBe(201);
    expect(store.addPrInfo).toHaveBeenCalledWith(task.id, expect.objectContaining({ number: 901, manual: true }));
    expect(store.updatePrInfo).not.toHaveBeenCalled();
  });

  it("create-PR stores freshly created PRs as manual handoffs", async () => {
    process.env.GITHUB_REPOSITORY = "owner/repo";
    const task = { ...FAKE_TASK_DETAIL, id: "FN-901", column: "in-review", prInfo: undefined, prInfos: undefined };
    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(task);

    vi.spyOn(GitHubClient.prototype, "findPrForBranch").mockResolvedValue(null);
    vi.spyOn(GitHubClient.prototype, "createPr").mockResolvedValue({
      url: "https://github.com/owner/repo/pull/902",
      number: 902,
      status: "open",
      title: "New",
      headBranch: "fusion/fn-901",
      baseBranch: "main",
      commentCount: 0,
    } as any);
    mockExecFile.mockImplementationOnce((file, argsOrCb, maybeOptions, maybeCb) => {
      const cb =
        typeof maybeCb === "function"
          ? maybeCb
          : typeof maybeOptions === "function"
            ? maybeOptions
            : typeof argsOrCb === "function"
              ? argsOrCb
              : null;
      expect(file).toBe("git");
      expect(Array.isArray(argsOrCb) ? argsOrCb : []).toEqual(["push", "-u", "origin", "fusion/fn-901"]);
      if (cb) queueMicrotask(() => cb(null, { stdout: "", stderr: "" }));
      return undefined as never;
    });

    const res = await REQUEST(buildApp(), "POST", `/api/tasks/${task.id}/pr/create`, JSON.stringify({ title: "New PR", body: "New PR body" }), { "content-type": "application/json" });

    expect(res.status).toBe(201);
    expect(store.updatePrInfo).toHaveBeenCalledWith(task.id, expect.objectContaining({ number: 902, manual: true }));
    expect(store.addPrInfo).not.toHaveBeenCalled();
  });

  it("queues conflict reclaim during refresh when mergeable is conflicting", async () => {
    const task = {
      ...FAKE_TASK_DETAIL,
      id: "FN-900",
      branch: "fusion/fn-900",
      worktree: "/tmp/test/.worktrees/fn-900",
      prInfo: {
        url: "https://github.com/owner/repo/pull/900",
        number: 900,
        status: "open",
        title: "PR",
        headBranch: "fusion/fn-900",
        baseBranch: "main",
        commentCount: 0,
      },
    };
    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(task);
    vi.spyOn(GitHubClient.prototype, "getPrReviewSnapshot").mockResolvedValue({
      decision: "approved",
      items: [],
      summary: { approved: 0, changesRequested: 0, commented: 0 },
    } as any);
    vi.spyOn(GitHubClient.prototype, "getPrMergeStatus").mockResolvedValue({
      mergeReady: false,
      blockingReasons: ["conflict"],
      checks: [],
      prInfo: { status: "open", merged: false, mergeable: "conflicting", headBranch: "fusion/fn-900", baseBranch: "main" },
    } as any);
    vi.spyOn(GitHubClient.prototype, "getPrConflictDiagnostics").mockResolvedValue({
      conflictingFiles: ["packages/dashboard/src/github.ts"],
      suggestedCommands: ["git fetch origin"],
      capturedAt: "2026-05-18T00:00:00.000Z",
    });

    const reclaimSpy = vi.fn().mockResolvedValue({ outcome: "reclaimed" });
    const engine = {
      getProjectId: () => "test-project",
      getTaskStore: () => store,
      getSelfHealingManager: () => ({ reclaimPrConflictForTask: reclaimSpy }),
    };

    const res = await REQUEST(buildApp({ engine } as any), "POST", `/api/tasks/${task.id}/pr/refresh`, JSON.stringify({}), { "content-type": "application/json" });
    expect(res.status).toBe(200);
    expect(res.body.conflictReclaimQueued).toBe(true);
    expect(store.updatePrInfoByNumber).toHaveBeenCalledWith(
      task.id,
      task.prInfo.number,
      expect.objectContaining({
        conflictDiagnostics: expect.objectContaining({
          conflictingFiles: ["packages/dashboard/src/github.ts"],
        }),
      }),
    );
    expect(reclaimSpy).toHaveBeenCalledWith(task.id);
  });

  it("does not queue reclaim during refresh for non-conflicting PR", async () => {
    const task = {
      ...FAKE_TASK_DETAIL,
      id: "FN-901",
      branch: "fusion/fn-901",
      worktree: "/tmp/test/.worktrees/fn-901",
      prInfo: {
        url: "https://github.com/owner/repo/pull/901",
        number: 901,
        status: "open",
        title: "PR",
        headBranch: "fusion/fn-901",
        baseBranch: "main",
        commentCount: 0,
        manual: true,
      },
    };
    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(task);
    vi.spyOn(GitHubClient.prototype, "getPrReviewSnapshot").mockResolvedValue({
      decision: "approved",
      items: [],
      summary: { approved: 0, changesRequested: 0, commented: 0 },
    } as any);
    vi.spyOn(GitHubClient.prototype, "getPrMergeStatus").mockResolvedValue({
      mergeReady: true,
      blockingReasons: [],
      checks: [],
      prInfo: { status: "open", merged: false, mergeable: "clean" },
    } as any);

    const reclaimSpy = vi.fn().mockResolvedValue({ outcome: "skipped" });
    const engine = {
      getTaskStore: () => store,
      getSelfHealingManager: () => ({ reclaimPrConflictForTask: reclaimSpy }),
    };

    const res = await REQUEST(buildApp({ engine } as any), "POST", `/api/tasks/${task.id}/pr/refresh`, JSON.stringify({}), { "content-type": "application/json" });
    expect(res.status).toBe(200);
    expect(res.body.conflictReclaimQueued).toBe(false);
    expect(store.updatePrInfoByNumber).toHaveBeenCalledWith(
      task.id,
      task.prInfo.number,
      expect.objectContaining({ manual: true }),
    );
    expect(reclaimSpy).not.toHaveBeenCalled();
  });

  it("clears persisted conflict diagnostics when PR becomes clean", async () => {
    const task = {
      ...FAKE_TASK_DETAIL,
      id: "FN-905",
      branch: "fusion/fn-905",
      worktree: "/tmp/test/.worktrees/fn-905",
      prInfo: {
        url: "https://github.com/owner/repo/pull/905",
        number: 905,
        status: "open",
        title: "PR",
        headBranch: "fusion/fn-905",
        baseBranch: "main",
        commentCount: 0,
        mergeable: "conflicting",
        conflictDiagnostics: {
          conflictingFiles: ["stale.txt"],
          suggestedCommands: ["git fetch origin"],
          capturedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    };
    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(task);
    vi.spyOn(GitHubClient.prototype, "getPrReviewSnapshot").mockResolvedValue({
      decision: "approved",
      items: [],
      summary: { approved: 0, changesRequested: 0, commented: 0 },
    } as any);
    vi.spyOn(GitHubClient.prototype, "getPrMergeStatus").mockResolvedValue({
      mergeReady: true,
      blockingReasons: [],
      checks: [],
      prInfo: { status: "open", merged: false, mergeable: "clean", headBranch: "fusion/fn-905", baseBranch: "main" },
    } as any);

    const res = await REQUEST(buildApp(), "POST", `/api/tasks/${task.id}/pr/refresh`, JSON.stringify({}), { "content-type": "application/json" });

    expect(res.status).toBe(200);
    expect(store.updatePrInfoByNumber).toHaveBeenCalledWith(
      task.id,
      task.prInfo.number,
      expect.objectContaining({
        mergeable: "clean",
        conflictDiagnostics: undefined,
      }),
    );
  });

  it("returns fallback diagnostics when repoRoot is unavailable", async () => {
    const task = {
      ...FAKE_TASK_DETAIL,
      id: "FN-906",
      branch: "fusion/fn-906",
      worktree: "/tmp/test/.worktrees/fn-906",
      prInfo: {
        url: "https://github.com/owner/repo/pull/906",
        number: 906,
        status: "open",
        title: "PR",
        headBranch: "fusion/fn-906",
        baseBranch: "main",
        commentCount: 0,
      },
    };
    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(task);
    vi.spyOn(GitHubClient.prototype, "getPrReviewSnapshot").mockResolvedValue({ decision: "approved", items: [], summary: { approved: 0, changesRequested: 0, commented: 0 } } as any);
    vi.spyOn(GitHubClient.prototype, "getPrMergeStatus").mockResolvedValue({
      mergeReady: false,
      blockingReasons: ["conflict"],
      checks: [],
      prInfo: { status: "open", merged: false, mergeable: "conflicting", headBranch: "fusion/fn-906", baseBranch: "main" },
    } as any);
    vi.spyOn(GitHubClient.prototype, "getPrConflictDiagnostics").mockResolvedValue({
      conflictingFiles: ["a.ts"],
      suggestedCommands: ["git fetch origin", "# Note: file list reflects PR changes; resolve conflicts as reported by git status during rebase."],
      capturedAt: "2026-05-18T00:00:00.000Z",
    });

    const res = await REQUEST(buildApp(), "POST", `/api/tasks/${task.id}/pr/refresh`, JSON.stringify({}), { "content-type": "application/json" });

    expect(res.status).toBe(200);
    expect(store.updatePrInfoByNumber).toHaveBeenCalledWith(
      task.id,
      task.prInfo.number,
      expect.objectContaining({
        conflictDiagnostics: expect.objectContaining({
          conflictingFiles: ["a.ts"],
          suggestedCommands: expect.any(Array),
        }),
      }),
    );
  });

  it("returns queued true for manual reclaim when conflict reclaim is available", async () => {
    const task = {
      ...FAKE_TASK_DETAIL,
      id: "FN-904",
      branch: "fusion/fn-904",
      worktree: "/tmp/test/.worktrees/fn-904",
      prInfo: {
        url: "https://github.com/owner/repo/pull/904",
        number: 904,
        status: "open",
        title: "PR",
        headBranch: "fusion/fn-904",
        baseBranch: "main",
        commentCount: 0,
        mergeable: "conflicting",
      },
    };
    const reclaimSpy = vi.fn().mockResolvedValue({ outcome: "reclaimed" });
    const engine = {
      getProjectId: () => "test-project",
      getTaskStore: () => store,
      getSelfHealingManager: () => ({ reclaimPrConflictForTask: reclaimSpy }),
    };
    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(task);
    const res = await REQUEST(buildApp({ engine } as any), "POST", `/api/tasks/${task.id}/pr/reclaim-conflict`, JSON.stringify({}), { "content-type": "application/json" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ queued: true });
  });

  it("returns 404 for manual reclaim when task has no PR", async () => {
    const task = { ...FAKE_TASK_DETAIL, id: "FN-902", prInfo: undefined };
    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(task);
    const res = await REQUEST(buildApp(), "POST", `/api/tasks/${task.id}/pr/reclaim-conflict`, JSON.stringify({}), { "content-type": "application/json" });
    expect(res.status).toBe(404);
  });

  it("returns 409 for manual reclaim when task has no branch/worktree", async () => {
    const task = {
      ...FAKE_TASK_DETAIL,
      id: "FN-903",
      branch: null,
      worktree: null,
      prInfo: {
        url: "https://github.com/owner/repo/pull/903",
        number: 903,
        status: "open",
        title: "PR",
        headBranch: "fusion/fn-903",
        baseBranch: "main",
        commentCount: 0,
        mergeable: "conflicting",
      },
    };
    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(task);
    const res = await REQUEST(buildApp(), "POST", `/api/tasks/${task.id}/pr/reclaim-conflict`, JSON.stringify({}), { "content-type": "application/json" });
    expect(res.status).toBe(409);
  });

  it("refresh returns primary/all for multi-pr tasks", async () => {
    const task = {
      ...FAKE_TASK_DETAIL,
      id: "FN-920",
      branch: "fusion/fn-920",
      worktree: "/tmp/test/.worktrees/fn-920",
      prInfo: { url: "https://github.com/owner/repo/pull/920", number: 920, status: "open", title: "PR920", commentCount: 0 },
      prInfos: [
        { url: "https://github.com/owner/repo/pull/920", number: 920, status: "open", title: "PR920", commentCount: 0 },
        { url: "https://github.com/owner/repo/pull/921", number: 921, status: "open", title: "PR921", commentCount: 0 },
      ],
    };
    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(task);
    vi.spyOn(GitHubClient.prototype, "getPrReviewSnapshot").mockResolvedValue({ decision: "approved", items: [], summary: { approved: 0, changesRequested: 0, commented: 0 } } as any);
    vi.spyOn(GitHubClient.prototype, "getPrMergeStatus").mockResolvedValue({ mergeReady: true, blockingReasons: [], checks: [], prInfo: { status: "open", mergeable: "clean" } } as any);

    const res = await REQUEST(buildApp(), "POST", `/api/tasks/${task.id}/pr/refresh`, JSON.stringify({}), { "content-type": "application/json" });
    expect(res.status).toBe(200);
    expect(res.body.all).toHaveLength(2);
    expect(res.body.primary.prInfo.number).toBe(res.body.prInfo.number);
    expect(res.body.mergeReady).toBe(res.body.primary.mergeReady);
  });

  it("unlink removes targeted PR without closing github PR", async () => {
    const task = {
      ...FAKE_TASK_DETAIL,
      id: "FN-930",
      prInfo: { url: "https://github.com/owner/repo/pull/930", number: 930, status: "open", title: "PR930" },
      prInfos: [
        { url: "https://github.com/owner/repo/pull/930", number: 930, status: "open", title: "PR930" },
        { url: "https://github.com/owner/repo/pull/931", number: 931, status: "open", title: "PR931" },
      ],
    };
    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(task);
    (store.removePrInfoByNumber as ReturnType<typeof vi.fn>).mockResolvedValue({ ...task, prInfo: task.prInfos[1], prInfos: [task.prInfos[1]] });
    const mergeSpy = vi.spyOn(GitHubClient.prototype, "mergePr");

    const res = await REQUEST(buildApp(), "POST", `/api/tasks/${task.id}/pr/930/unlink`, JSON.stringify({}), { "content-type": "application/json" });
    expect(res.status).toBe(200);
    expect(store.removePrInfoByNumber).toHaveBeenCalledWith(task.id, 930);
    expect(mergeSpy).not.toHaveBeenCalled();
  });
});
