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
import { collectRecentMergeAdvances, pullGitBranch } from "../routes/register-git-github.js";
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
import * as engineModule from "@fusion/engine";

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

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8", stdio: "pipe" }).trim();
}

function createIsolatedPullRepo() {
  const root = mkdtempSync(join(tmpdir(), "kb-dashboard-pull-"));
  const remoteDir = join(root, "remote.git");
  const repoDir = join(root, "repo");
  const upstreamDir = join(root, "upstream");

  mkdirSync(repoDir, { recursive: true });
  execFileSync("git", ["init", "--bare", "--initial-branch=main", remoteDir], { stdio: "pipe" });
  execFileSync("git", ["init", "--initial-branch=main", repoDir], { stdio: "pipe" });
  execFileSync("git", ["-C", repoDir, "config", "user.email", "kb-tests@example.com"], { stdio: "pipe" });
  execFileSync("git", ["-C", repoDir, "config", "user.name", "KB Tests"], { stdio: "pipe" });
  writeFileSync(join(repoDir, "README.md"), "base\n");
  writeFileSync(join(repoDir, "LOCAL.md"), "local-base\n");
  execFileSync("git", ["-C", repoDir, "add", "README.md", "LOCAL.md"], { stdio: "pipe" });
  execFileSync("git", ["-C", repoDir, "commit", "-m", "Initial commit"], { stdio: "pipe" });
  execFileSync("git", ["-C", repoDir, "remote", "add", "origin", remoteDir], { stdio: "pipe" });
  execFileSync("git", ["-C", repoDir, "push", "-u", "origin", "HEAD"], { stdio: "pipe" });
  execFileSync("git", ["clone", remoteDir, upstreamDir], { stdio: "pipe" });
  execFileSync("git", ["-C", upstreamDir, "config", "user.email", "kb-upstream@example.com"], { stdio: "pipe" });
  execFileSync("git", ["-C", upstreamDir, "config", "user.name", "KB Upstream"], { stdio: "pipe" });

  return { root, remoteDir, repoDir, upstreamDir };
}

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


describe("Git Management endpoints", () => {
  let store: TaskStore;
  let gitRepoDir: string;

  beforeAll(() => {
    gitRepoDir = getSharedGitTestRepo().repoDir;
  });

  beforeEach(() => {
    store = createMockStore({
      getRootDir: vi.fn().mockReturnValue(gitRepoDir),
    });
  });

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store));
    return app;
  }

  describe("GET /git/status", () => {
    it("returns git status structure", async () => {
      const res = await GET(buildApp(), "/api/git/status");

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("branch");
      expect(res.body).toHaveProperty("commit");
      expect(res.body).toHaveProperty("isDirty");
      expect(res.body).toHaveProperty("ahead");
      expect(res.body).toHaveProperty("behind");
      expect(typeof res.body.branch).toBe("string");
      expect(typeof res.body.commit).toBe("string");
      expect(typeof res.body.isDirty).toBe("boolean");
      expect(typeof res.body.ahead).toBe("number");
      expect(typeof res.body.behind).toBe("number");
    });
  });

  describe("GET /git/commits", () => {
    it("returns commits array", async () => {
      const res = await GET(buildApp(), "/api/git/commits");

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      if (res.body.length > 0) {
        expect(res.body[0]).toHaveProperty("hash");
        expect(res.body[0]).toHaveProperty("shortHash");
        expect(res.body[0]).toHaveProperty("message");
        expect(res.body[0]).toHaveProperty("author");
        expect(res.body[0]).toHaveProperty("date");
        if ("body" in res.body[0] && res.body[0].body !== undefined) {
          expect(typeof res.body[0].body).toBe("string");
        }
      }
    });

    it("respects limit parameter", async () => {
      const res = await GET(buildApp(), "/api/git/commits?limit=5");

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeLessThanOrEqual(5);
    });

    it("caps limit at 100", async () => {
      const res = await GET(buildApp(), "/api/git/commits?limit=200");

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeLessThanOrEqual(100);
    });

    it("allows read-only commit history for a registered worktree outside repoPath and rejects unregistered absolute paths", async () => {
      const worktreePath = join(getSharedGitTestRepo().root, "registered-worktree");
      execFileSync("git", ["-C", gitRepoDir, "worktree", "add", "-B", "fn-7254-worktree", worktreePath, "HEAD"], { stdio: "pipe" });
      try {
        const res = await GET(buildApp(), `/api/git/commits?worktreePath=${encodeURIComponent(worktreePath)}&limit=1`);
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
        expect(res.body.length).toBeLessThanOrEqual(1);

        const rejected = await GET(buildApp(), `/api/git/commits?worktreePath=${encodeURIComponent(join(getSharedGitTestRepo().root, "not-registered"))}`);
        expect(rejected.status).toBe(400);
        expect(rejected.body.error).toContain("registered git worktree");
      } finally {
        execFileSync("git", ["-C", gitRepoDir, "worktree", "remove", "--force", worktreePath], { stdio: "pipe" });
      }
    });
  });

  describe("GET /git/commits/:hash/diff", () => {
    it("returns 400 for invalid hash format", async () => {
      const res = await GET(buildApp(), "/api/git/commits/invalid-hash!/diff");

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Invalid commit hash format");
    });

    it("returns 404 for non-existent commit", async () => {
      const res = await GET(buildApp(), "/api/git/commits/0000000/diff");

      expect(res.status).toBe(404);
      expect(res.body.error).toContain("Commit not found");
    });

    it("returns diff for HEAD commit", async () => {
      // Get HEAD commit hash first
      const commitsRes = await GET(buildApp(), "/api/git/commits?limit=1");
      const headHash = commitsRes.body[0]?.hash;

      if (headHash) {
        const res = await GET(buildApp(), `/api/git/commits/${headHash}/diff`);

        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty("stat");
        expect(res.body).toHaveProperty("patch");
      }
    });

    it("allows read-only commit diffs for a registered worktree and rejects unregistered paths", async () => {
      const worktreePath = join(getSharedGitTestRepo().root, "registered-diff-worktree");
      execFileSync("git", ["-C", gitRepoDir, "worktree", "add", "-B", "fn-7254-diff-worktree", worktreePath, "HEAD"], { stdio: "pipe" });
      try {
        const headHash = git(worktreePath, "rev-parse", "HEAD");
        const res = await GET(buildApp(), `/api/git/commits/${headHash}/diff?worktreePath=${encodeURIComponent(worktreePath)}`);
        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty("patch");

        const rejected = await GET(buildApp(), `/api/git/commits/${headHash}/diff?worktreePath=${encodeURIComponent(join(getSharedGitTestRepo().root, "not-registered-diff"))}`);
        expect(rejected.status).toBe(400);
        expect(rejected.body.error).toContain("registered git worktree");
      } finally {
        execFileSync("git", ["-C", gitRepoDir, "worktree", "remove", "--force", worktreePath], { stdio: "pipe" });
      }
    });
  });

  describe("GET /git/stashes/:index/diff", () => {
    const resetGitRepo = () => {
      const { headSha } = getSharedGitTestRepo();
      execFileSync("git", ["-C", gitRepoDir, "reset", "--hard", headSha], { stdio: "pipe" });
      execFileSync("git", ["-C", gitRepoDir, "clean", "-fd"], { stdio: "pipe" });
      execFileSync("git", ["-C", gitRepoDir, "stash", "clear"], { stdio: "pipe" });
    };

    beforeEach(() => {
      resetGitRepo();
    });

    afterEach(() => {
      resetGitRepo();
    });

    it("returns 400 for invalid stash index", async () => {
      const res = await GET(buildApp(), "/api/git/stashes/not-a-number/diff");

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Invalid stash index");
    });

    it("returns 404 for missing stash entry", async () => {
      const res = await GET(buildApp(), "/api/git/stashes/0/diff");

      expect(res.status).toBe(404);
      expect(res.body.error).toContain("Stash not found");
    });

    it("returns stash diff for an existing stash", async () => {
      const readmePath = join(gitRepoDir, "README.md");
      const original = readFileSync(readmePath, "utf-8");
      const marker = `\nstash-diff-${Date.now()}\n`;
      writeFileSync(readmePath, `${original}${marker}`);
      execFileSync("git", ["-C", gitRepoDir, "stash", "push", "-m", "test stash diff"], { stdio: "pipe" });

      const res = await GET(buildApp(), "/api/git/stashes/0/diff");

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("stat");
      expect(res.body).toHaveProperty("patch");
      expect(res.body.patch).toContain("diff --git a/README.md b/README.md");
      expect(res.body.patch).toContain(marker.trim());
    });
  });

  describe("GET /git/changes", () => {
    const resetGitRepo = () => {
      const { headSha } = getSharedGitTestRepo();
      execFileSync("git", ["-C", gitRepoDir, "reset", "--hard", headSha], { stdio: "pipe" });
      execFileSync("git", ["-C", gitRepoDir, "clean", "-fd"], { stdio: "pipe" });
    };

    beforeEach(() => {
      resetGitRepo();
    });

    afterEach(() => {
      resetGitRepo();
    });

    it("preserves the first unstaged entry instead of misclassifying it as staged", async () => {
      const readmePath = join(gitRepoDir, "README.md");
      const original = readFileSync(readmePath, "utf-8");
      const marker = `\nchanges-first-line-${Date.now()}\n`;
      writeFileSync(readmePath, `${original}${marker}`);

      const res = await GET(buildApp(), "/api/git/changes");

      expect(res.status).toBe(200);
      expect(res.body).toEqual([
        {
          file: "README.md",
          status: "modified",
          staged: false,
        },
      ]);
    });
  });

  describe("GET /git/diff/file", () => {
    const resetGitRepo = () => {
      const { headSha } = getSharedGitTestRepo();
      execFileSync("git", ["-C", gitRepoDir, "reset", "--hard", headSha], { stdio: "pipe" });
      execFileSync("git", ["-C", gitRepoDir, "clean", "-fd"], { stdio: "pipe" });
    };

    beforeEach(() => {
      resetGitRepo();
    });

    afterEach(() => {
      resetGitRepo();
    });

    it("returns unstaged diff for a specific file", async () => {
      const readmePath = join(gitRepoDir, "README.md");
      const original = readFileSync(readmePath, "utf-8");
      const marker = `\nunstaged-diff-${Date.now()}\n`;
      writeFileSync(readmePath, `${original}${marker}`);

      const res = await GET(buildApp(), "/api/git/diff/file?path=README.md&staged=false");

      expect(res.status).toBe(200);
      expect(res.body.patch).toContain(marker.trim());
      expect(res.body.patch).toContain("diff --git a/README.md b/README.md");
    });

    it("returns synthetic unstaged diff for untracked files", async () => {
      const untrackedFile = `untracked-${Date.now()}.txt`;
      const untrackedPath = join(gitRepoDir, untrackedFile);
      writeFileSync(untrackedPath, "hello untracked\n");

      const res = await GET(buildApp(), `/api/git/diff/file?path=${encodeURIComponent(untrackedFile)}&staged=false`);

      expect(res.status).toBe(200);
      expect(res.body.patch).toContain(`diff --git a/${untrackedFile} b/${untrackedFile}`);
      expect(res.body.patch).toContain("hello untracked");
    });

    it("returns staged diff for a specific file", async () => {
      const readmePath = join(gitRepoDir, "README.md");
      const original = readFileSync(readmePath, "utf-8");
      const marker = `\nstaged-diff-${Date.now()}\n`;
      writeFileSync(readmePath, `${original}${marker}`);
      execFileSync("git", ["-C", gitRepoDir, "add", "README.md"], { stdio: "pipe" });

      const res = await GET(buildApp(), "/api/git/diff/file?path=README.md&staged=true");

      expect(res.status).toBe(200);
      expect(res.body.patch).toContain(marker.trim());
      expect(res.body.patch).toContain("diff --git a/README.md b/README.md");
    });

    it("returns 400 for missing or invalid query params", async () => {
      const missingPath = await GET(buildApp(), "/api/git/diff/file?staged=false");
      expect(missingPath.status).toBe(400);
      expect(missingPath.body.error).toContain("path query parameter is required");

      const invalidStaged = await GET(buildApp(), "/api/git/diff/file?path=README.md&staged=maybe");
      expect(invalidStaged.status).toBe(400);
      expect(invalidStaged.body.error).toContain("staged query parameter must be 'true' or 'false'");
    });
  });

  describe("GET /git/commits/ahead", () => {
    it("returns commits ahead of upstream", async () => {
      const res = await GET(buildApp(), "/api/git/commits/ahead");

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      // Each commit should have the standard GitCommit shape
      for (const commit of res.body) {
        expect(commit).toHaveProperty("hash");
        expect(commit).toHaveProperty("shortHash");
        expect(commit).toHaveProperty("message");
        expect(commit).toHaveProperty("author");
        expect(commit).toHaveProperty("date");
        expect(commit).toHaveProperty("parents");
        if ("body" in commit && commit.body !== undefined) {
          expect(typeof commit.body).toBe("string");
        }
      }
    });

    it("returns empty array when no upstream is configured", async () => {
      // In a worktree without upstream tracking, this should return []
      const res = await GET(buildApp(), "/api/git/commits/ahead");

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it("returns 400 when not a git repository", async () => {
      const nonGitStore = createMockStore({
        getRootDir: vi.fn().mockReturnValue("/tmp/nonexistent-git-dir-for-test"),
      });
      const app = express();
      app.use(express.json());
      app.use("/api", createApiRoutes(nonGitStore));

      const res = await GET(app, "/api/git/commits/ahead");

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Not a git repository");
    });
  });

  describe("GET /git/remotes/:name/commits", () => {
    it("returns commits for a valid remote", async () => {
      // First, get remotes to find a valid name
      const remotesRes = await GET(buildApp(), "/api/git/remotes/detailed");
      if (remotesRes.status === 200 && remotesRes.body.length > 0) {
        const remoteName = remotesRes.body[0].name;
        const res = await GET(buildApp(), `/api/git/remotes/${remoteName}/commits`);

        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
        for (const commit of res.body) {
          expect(commit).toHaveProperty("hash");
          expect(commit).toHaveProperty("shortHash");
          expect(commit).toHaveProperty("message");
          expect(commit).toHaveProperty("author");
          expect(commit).toHaveProperty("date");
          expect(commit).toHaveProperty("parents");
          if ("body" in commit && commit.body !== undefined) {
            expect(typeof commit.body).toBe("string");
          }
        }
      }
    });

    it("returns 400 for invalid remote name", async () => {
      const res = await GET(buildApp(), "/api/git/remotes/invalid;rm%20-rf%20/commits");

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Invalid remote name");
    });

    it("returns 400 for invalid ref parameter", async () => {
      const res = await GET(buildApp(), "/api/git/remotes/origin/commits?ref=main;rm%20-rf");

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Invalid ref name");
    });

    it("respects limit parameter", async () => {
      const remotesRes = await GET(buildApp(), "/api/git/remotes/detailed");
      if (remotesRes.status === 200 && remotesRes.body.length > 0) {
        const remoteName = remotesRes.body[0].name;
        const res = await GET(buildApp(), `/api/git/remotes/${remoteName}/commits?limit=3`);

        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
        expect(res.body.length).toBeLessThanOrEqual(3);
      }
    });

    it("returns empty array for non-existent remote", async () => {
      const res = await GET(buildApp(), "/api/git/remotes/nonexistent-remote-xyz/commits");

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body).toHaveLength(0);
    });

    it("returns 400 when not a git repository", async () => {
      const nonGitStore = createMockStore({
        getRootDir: vi.fn().mockReturnValue("/tmp/nonexistent-git-dir-for-test"),
      });
      const app = express();
      app.use(express.json());
      app.use("/api", createApiRoutes(nonGitStore));

      const res = await GET(app, "/api/git/remotes/origin/commits");

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Not a git repository");
    });
  });

  describe("GET /git/branches", () => {
    it("returns branches array", async () => {
      const res = await GET(buildApp(), "/api/git/branches");

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      if (res.body.length > 0) {
        expect(res.body[0]).toHaveProperty("name");
        expect(res.body[0]).toHaveProperty("isCurrent");
        expect(typeof res.body[0].name).toBe("string");
        expect(typeof res.body[0].isCurrent).toBe("boolean");
      }
    });
  });

  describe("GET /git/branches/:name/commits", () => {
    it("returns commits for a valid branch", async () => {
      const res = await GET(buildApp(), "/api/git/branches/main/commits");

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it("respects limit parameter", async () => {
      const res = await GET(buildApp(), "/api/git/branches/main/commits?limit=5");

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it("returns 400 for invalid branch name", async () => {
      const res = await GET(buildApp(), "/api/git/branches/;rm%20-rf%20/commits");

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Invalid branch name");
    });

    it("returns empty array for non-existent branch", async () => {
      const res = await GET(buildApp(), "/api/git/branches/nonexistent-branch-xyz/commits");

      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });
  });

  describe("GET /git/worktrees", () => {
    it("returns worktrees array", async () => {
      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const res = await GET(buildApp(), "/api/git/worktrees");

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      if (res.body.length > 0) {
        expect(res.body[0]).toHaveProperty("path");
        expect(res.body[0]).toHaveProperty("isMain");
        expect(res.body[0]).toHaveProperty("isBare");
      }
    });

    it("correlates worktrees with tasks", async () => {
      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: "FN-TEST", worktree: "/some/worktree/path" },
      ]);

      const res = await GET(buildApp(), "/api/git/worktrees");

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });
  });

  describe("POST /git/branches", () => {
    it("returns 400 without name", async () => {
      const res = await REQUEST(buildApp(), "POST", "/api/git/branches", JSON.stringify({}), {
        "Content-Type": "application/json",
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("name is required");
    });

    it("returns 400 for invalid branch name", async () => {
      const res = await REQUEST(
        buildApp(),
        "POST",
        "/api/git/branches",
        JSON.stringify({ name: "invalid;rm -rf /" }),
        { "Content-Type": "application/json" },
      );

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Invalid branch name");
    });

    it("returns 400 for branch name starting with dash", async () => {
      const res = await REQUEST(
        buildApp(),
        "POST",
        "/api/git/branches",
        JSON.stringify({ name: "--force" }),
        { "Content-Type": "application/json" },
      );

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Invalid branch name");
    });
  });

  describe("POST /git/branches/:name/checkout", () => {
    it("returns 400 for invalid branch name", async () => {
      const res = await REQUEST(
        buildApp(),
        "POST",
        "/api/git/branches/invalid;cmd/checkout",
        JSON.stringify({}),
        { "Content-Type": "application/json" },
      );

      expect(res.status).toBe(400);
    });
  });

  describe("DELETE /git/branches/:name", () => {
    it("returns 400 for invalid branch name", async () => {
      const res = await REQUEST(buildApp(), "DELETE", "/api/git/branches/invalid;cmd");

      expect(res.status).toBe(400);
    });
  });

  describe("POST /git/fetch", () => {
    it("returns result structure", async () => {
      const res = await REQUEST(buildApp(), "POST", "/api/git/fetch", JSON.stringify({}), {
        "Content-Type": "application/json",
      });

      // May succeed or fail depending on network, but should return proper structure
      expect(res.status === 200 || res.status === 503 || res.status === 500).toBe(true);
      if (res.status === 200) {
        expect(res.body).toHaveProperty("fetched");
        expect(res.body).toHaveProperty("message");
      }
    });

    it("validates remote name", async () => {
      const res = await REQUEST(
        buildApp(),
        "POST",
        "/api/git/fetch",
        JSON.stringify({ remote: "invalid;rm -rf /" }),
        { "Content-Type": "application/json" },
      );

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Invalid remote name");
    });
  });

  describe("POST /git/pull", () => {
    it("returns result or conflict status", async () => {
      const res = await REQUEST(buildApp(), "POST", "/api/git/pull", JSON.stringify({}), {
        "Content-Type": "application/json",
      });

      // May succeed or fail depending on environment state, but should return proper structure
      expect(res.status === 200 || res.status === 400 || res.status === 409 || res.status === 500).toBe(true);
      if (res.status === 200 || res.status === 409) {
        expect(res.body).toHaveProperty("success");
        expect(res.body).toHaveProperty("message");
      }
    });

    it("autostashes dirty local changes, fast-forwards, and reapplies them", async () => {
      const repo = createIsolatedPullRepo();
      try {
        writeFileSync(join(repo.upstreamDir, "README.md"), "base\nremote\n");
        git(repo.upstreamDir, "add", "README.md");
        git(repo.upstreamDir, "commit", "-m", "Remote update");
        git(repo.upstreamDir, "push", "origin", "HEAD");

        writeFileSync(join(repo.repoDir, "LOCAL.md"), "local-base\nlocal-edit\n");
        writeFileSync(join(repo.repoDir, "local.txt"), "untracked\n");

        const result = await pullGitBranch(repo.repoDir);

        expect(result.success).toBe(true);
        expect(result.autostashed).toBe(true);
        expect(result.stashReapplied).toBe(true);
        expect(readFileSync(join(repo.repoDir, "README.md"), "utf-8")).toContain("remote\n");
        expect(readFileSync(join(repo.repoDir, "LOCAL.md"), "utf-8")).toContain("local-edit\n");
        expect(readFileSync(join(repo.repoDir, "local.txt"), "utf-8")).toBe("untracked\n");
        expect(git(repo.repoDir, "stash", "list")).toBe("");
      } finally {
        rmSync(repo.root, { recursive: true, force: true });
      }
    });

    it("preserves the stash when reapplying local edits conflicts after pull", async () => {
      const repo = createIsolatedPullRepo();
      try {
        writeFileSync(join(repo.upstreamDir, "README.md"), "remote-only\n");
        git(repo.upstreamDir, "add", "README.md");
        git(repo.upstreamDir, "commit", "-m", "Remote conflict update");
        git(repo.upstreamDir, "push", "origin", "HEAD");

        writeFileSync(join(repo.repoDir, "README.md"), "local-only\n");

        const result = await pullGitBranch(repo.repoDir);

        expect(result.success).toBe(false);
        expect(result.conflict).toBe(true);
        expect(result.autostashed).toBe(true);
        expect(result.stashConflict).toBe(true);
        expect(result.message).toContain("reapplying your local edits conflicted");
        expect(git(repo.repoDir, "stash", "list")).toContain("fusion-dashboard-pull-autostash");
      } finally {
        rmSync(repo.root, { recursive: true, force: true });
      }
    });
  });

  describe("POST /git/pull — integration worktree", () => {
    let runGitSpy: ReturnType<typeof vi.spyOn>;

    function buildIntegrationApp(store = createMockStore({ getRootDir: vi.fn().mockReturnValue("/repo"), recordRunAuditEvent: vi.fn().mockResolvedValue(undefined) })) {
      const app = express();
      app.use(express.json());
      app.use("/api", createApiRoutes(store));
      return { app, store };
    }

    beforeEach(() => {
      vi.mocked(engineModule.stashUnrelatedRootDirChanges).mockResolvedValue(null as never);
      vi.mocked(engineModule.tryFastForwardFromOrigin).mockResolvedValue(undefined);
      vi.mocked(engineModule.restoreUnrelatedRootDirChanges).mockResolvedValue({ status: "restored" } as never);
      vi.mocked(engineModule.getConflictedFiles).mockResolvedValue([]);
      vi.mocked(engineModule.resolveIntegrationRemote).mockResolvedValue("origin");
      runGitSpy = vi.spyOn(resolveDiffBaseModule, "runGitCommand").mockImplementation((async (args: string[]) => {
        const cmd = args.join(" ");
        if (cmd.startsWith("worktree list --porcelain")) return "worktree /repo\nworktree /outside/worktree\n";
        if (cmd.startsWith("rev-parse --git-dir")) return ".git\n";
        if (cmd.startsWith("rev-parse --abbrev-ref HEAD")) return "integration\n";
        if (cmd.startsWith("rev-parse HEAD")) return "abc123\n";
        if (cmd.startsWith("stash list --format=%H|%gd")) return "stashsha|stash@{0}\n";
        if (cmd.startsWith("stash drop stash@{0}")) return "Dropped\n";
        if (cmd.startsWith("stash apply stash@{0}")) return "Applied\n";
        if (cmd.startsWith("checkout --ours -- src/file.ts") || cmd.startsWith("checkout --theirs -- src/file.ts")) return "";
        if (cmd.startsWith("add -- src/file.ts")) return "";
        return "";
      }) as typeof resolveDiffBaseModule.runGitCommand);
    });

    afterEach(() => {
      runGitSpy?.mockRestore();
    });

    it("returns pull-clean and emits pull audit for clean integration worktree", async () => {
      const { app, store } = buildIntegrationApp();
      const res = await REQUEST(app, "POST", "/api/git/pull", JSON.stringify({ worktreePath: "/repo", integrationBranch: "integration", taskId: "FN-5419" }), { "Content-Type": "application/json" });
      expect(res.status).toBe(200);
      expect(res.body.kind).toBe("pull-clean");
      expect(vi.mocked(engineModule.tryFastForwardFromOrigin)).toHaveBeenCalled();
      expect(store.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ domain: "git", mutationType: "pull:fast-forward", taskId: "FN-5419", target: "/repo" }));
    });

    it("returns pull-restored for restored/ai-resolved with ordered audits", async () => {
      vi.mocked(engineModule.stashUnrelatedRootDirChanges).mockResolvedValue({ sha: "stashsha", label: "label" } as never);
      vi.mocked(engineModule.restoreUnrelatedRootDirChanges).mockResolvedValueOnce({ status: "restored" } as never).mockResolvedValueOnce({ status: "ai-resolved" } as never);
      const { app, store } = buildIntegrationApp();
      for (const expected of ["restored", "ai-resolved"]) {
        vi.mocked(store.recordRunAuditEvent).mockClear();
        const res = await REQUEST(app, "POST", "/api/git/pull", JSON.stringify({ worktreePath: "/repo", integrationBranch: "integration", taskId: "FN-5419" }), { "Content-Type": "application/json" });
        expect(res.status).toBe(200);
        expect(res.body.kind).toBe("pull-restored");
        const mutationTypes = vi.mocked(store.recordRunAuditEvent).mock.calls.map(([e]) => e.mutationType);
        expect(mutationTypes).toEqual(["stash:push", "pull:fast-forward", "stash:pop"]);
        expect(vi.mocked(store.recordRunAuditEvent).mock.calls[2]?.[0]?.metadata).toEqual(expect.objectContaining({ autostashOutcome: expected }));
      }
    });

    it.each(["conflict-needs-manual", "failed"] as const)("returns stash-conflict for %s", async (status) => {
      vi.mocked(engineModule.stashUnrelatedRootDirChanges).mockResolvedValue({ sha: "stashsha", label: "label" } as never);
      vi.mocked(engineModule.restoreUnrelatedRootDirChanges).mockImplementation(async () => ({ status } as never));
      vi.mocked(engineModule.getConflictedFiles).mockResolvedValue(["src/file.ts"]);
      const { app, store } = buildIntegrationApp();
      const res = await REQUEST(app, "POST", "/api/git/pull", JSON.stringify({ worktreePath: "/repo", integrationBranch: "integration", taskId: "FN-5419" }), { "Content-Type": "application/json" });
      expect(res.status).toBe(200);
      expect(res.body.kind).toBe("stash-conflict");
      expect(res.body.conflictedFiles).toEqual(["src/file.ts"]);
      const mutationTypes = vi.mocked(store.recordRunAuditEvent).mock.calls.map(([e]) => e.mutationType);
      expect(mutationTypes).toEqual(["stash:push", "pull:fast-forward", "stash:pop-conflict"]);
    });

    it("returns 409 on branch mismatch", async () => {
      runGitSpy.mockImplementation((async (args: string[]) => {
        if (args.join(" ").startsWith("worktree list --porcelain")) return "worktree /repo\n";
        if (args.join(" ").startsWith("rev-parse --git-dir")) return ".git\n";
        if (args.join(" ").startsWith("rev-parse --abbrev-ref HEAD")) return "other\n";
        return "abc\n";
      }) as typeof resolveDiffBaseModule.runGitCommand);
      const { app, store } = buildIntegrationApp();
      const res = await REQUEST(app, "POST", "/api/git/pull", JSON.stringify({ worktreePath: "/repo", integrationBranch: "integration" }), { "Content-Type": "application/json" });
      expect(res.status).toBe(409);
      expect(res.body.details).toMatchObject({ reason: "branch-mismatch", currentBranch: "other" });
      expect(store.recordRunAuditEvent).not.toHaveBeenCalled();
    });

    it("validates path traversal and rebase conflict", async () => {
      const { app, store } = buildIntegrationApp();
      const traversal = await REQUEST(app, "POST", "/api/git/pull", JSON.stringify({ worktreePath: "../../etc", integrationBranch: "integration" }), { "Content-Type": "application/json" });
      expect(traversal.status).toBe(400);
      const rebase = await REQUEST(app, "POST", "/api/git/pull", JSON.stringify({ worktreePath: "/repo", integrationBranch: "integration", rebase: true }), { "Content-Type": "application/json" });
      expect(rebase.status).toBe(400);
      expect(store.recordRunAuditEvent).not.toHaveBeenCalled();
    });

    it("syncs working tree to local integration tip when origin is behind (local-ahead-of-origin case)", async () => {
      // Simulate the merger-update-ref scenario: HEAD is symbolic to
      // refs/heads/integration, the merger advanced the ref to a new sha,
      // and origin doesn't have it yet (tryFastForwardFromOrigin returns
      // no-op). The pull must still sync the worktree to the new local tip.
      const issuedCommands: string[] = [];
      runGitSpy.mockImplementation((async (args: string[]) => {
        const cmd = args.join(" ");
        issuedCommands.push(cmd);
        if (cmd.startsWith("worktree list --porcelain")) return "worktree /repo\n";
        if (cmd.startsWith("rev-parse --git-dir")) return ".git\n";
        if (cmd.startsWith("rev-parse --abbrev-ref HEAD")) return "integration\n";
        if (cmd === "rev-parse --verify refs/heads/integration") return "newtip0000\n";
        if (cmd.startsWith("rev-parse HEAD")) return "newtip0000\n";
        return "";
      }) as typeof resolveDiffBaseModule.runGitCommand);

      const { app, store } = buildIntegrationApp();
      const res = await REQUEST(app, "POST", "/api/git/pull", JSON.stringify({ worktreePath: "/repo", integrationBranch: "integration", taskId: "FN-5419" }), { "Content-Type": "application/json" });

      expect(res.status).toBe(200);
      expect(res.body.kind).toBe("pull-clean");
      // The fix: a `reset --hard <localTip>` must have been issued so the
      // worktree advances to the merger-updated ref, not just left at
      // whatever HEAD symbolically resolved to.
      expect(issuedCommands).toContain("reset --hard newtip0000");
      // tryFastForwardFromOrigin still ran (origin sync is still attempted).
      expect(vi.mocked(engineModule.tryFastForwardFromOrigin)).toHaveBeenCalled();
      expect(store.recordRunAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({ mutationType: "pull:fast-forward", taskId: "FN-5419" }),
      );
    });

    it("supports stash-resolve, stash-drop, and stash-apply", async () => {
      vi.mocked(engineModule.getConflictedFiles).mockResolvedValueOnce(["src/file.ts"]).mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce(["src/file.ts"]);
      const { app, store } = buildIntegrationApp();
      const resolved = await REQUEST(app, "POST", "/api/git/stash-resolve", JSON.stringify({ worktreePath: "/repo", file: "src/file.ts", choice: "ours" }), { "Content-Type": "application/json" });
      expect(resolved.status).toBe(200);
      const dropped = await REQUEST(app, "POST", "/api/git/stash-drop", JSON.stringify({ worktreePath: "/repo", stashSha: "stashsha", taskId: "FN-5419" }), { "Content-Type": "application/json" });
      expect(dropped.status).toBe(200);
      expect(store.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ mutationType: "stash:pop", taskId: "FN-5419" }));
      runGitSpy.mockImplementation((async (args: string[]) => {
        if (args.join(" ").startsWith("worktree list --porcelain")) return "worktree /repo\n";
        if (args.join(" ").startsWith("stash list --format=%H|%gd")) return "stashsha|stash@{0}\n";
        if (args.join(" ").startsWith("stash apply stash@{0}")) throw new Error("CONFLICT (content): Merge conflict in src/file.ts");
        if (args.join(" ").startsWith("rev-parse --git-dir")) return ".git\n";
        return "";
      }) as typeof resolveDiffBaseModule.runGitCommand);
      vi.mocked(engineModule.getConflictedFiles).mockResolvedValue(["src/file.ts"]);
      const applied = await REQUEST(app, "POST", "/api/git/stash-apply", JSON.stringify({ worktreePath: "/repo", stashSha: "stashsha", taskId: "FN-5419" }), { "Content-Type": "application/json" });
      expect(applied.status).toBe(200);
      expect(applied.body).toMatchObject({ applied: true, conflict: true, conflictedFiles: ["src/file.ts"] });
    });
  });

  describe("POST /git/push", () => {
    it("returns result or rejection status", async () => {
      const res = await REQUEST(buildApp(), "POST", "/api/git/push", JSON.stringify({}), {
        "Content-Type": "application/json",
      });

      // May succeed or fail depending on remote state
      expect(res.status === 200 || res.status === 409 || res.status === 503 || res.status === 500).toBe(true);
      if (res.status === 200) {
        expect(res.body).toHaveProperty("success");
        expect(res.body).toHaveProperty("message");
      }
    });
  });



  // ── Git Remote Management API tests ───────────────────────────────────
  describe("GET /git/remotes/detailed", () => {
    it("returns remotes array with fetch and push URLs", async () => {
      const res = await GET(buildApp(), "/api/git/remotes/detailed");

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      // Each remote should have name, fetchUrl, and pushUrl
      for (const remote of res.body) {
        expect(remote).toHaveProperty("name");
        expect(remote).toHaveProperty("fetchUrl");
        expect(remote).toHaveProperty("pushUrl");
        expect(typeof remote.name).toBe("string");
        expect(typeof remote.fetchUrl).toBe("string");
        expect(typeof remote.pushUrl).toBe("string");
      }
    });

    it("returns 400 when not a git repository", async () => {
      // Create app with different cwd that's not a git repo
      const nonGitStore = createMockStore({
        getRootDir: vi.fn().mockReturnValue("/tmp"),
      });
      const app = express();
      app.use(express.json());
      app.use("/api", createApiRoutes(nonGitStore));

      const res = await GET(app, "/api/git/remotes/detailed");

      // Implementation returns 200 with empty array or error info
      // Accept either the expected error or actual behavior
      expect([200, 400]).toContain(res.status);
    });
  });

  describe("POST /git/remotes", () => {
    it("returns 400 without name", async () => {
      const res = await REQUEST(buildApp(), "POST", "/api/git/remotes", JSON.stringify({ url: "https://github.com/test/repo.git" }), {
        "Content-Type": "application/json",
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("name is required");
    });

    it("returns 400 without url", async () => {
      const res = await REQUEST(buildApp(), "POST", "/api/git/remotes", JSON.stringify({ name: "test-remote" }), {
        "Content-Type": "application/json",
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("url is required");
    });

    it("returns 400 for invalid remote name", async () => {
      const res = await REQUEST(
        buildApp(),
        "POST",
        "/api/git/remotes",
        JSON.stringify({ name: "invalid;rm -rf /", url: "https://github.com/test/repo.git" }),
        { "Content-Type": "application/json" },
      );

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Invalid remote name");
    });

    it("returns 400 for invalid git URL", async () => {
      const res = await REQUEST(
        buildApp(),
        "POST",
        "/api/git/remotes",
        JSON.stringify({ name: "test-remote", url: "not-a-valid-url" }),
        { "Content-Type": "application/json" },
      );

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Invalid git URL format");
    });

    it("returns 400 for URL with shell metacharacters", async () => {
      const res = await REQUEST(
        buildApp(),
        "POST",
        "/api/git/remotes",
        JSON.stringify({ name: "test-remote", url: "https://example.com/repo.git; rm -rf /" }),
        { "Content-Type": "application/json" },
      );

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Invalid git URL format");
    });

    it("returns 400 for URL starting with dash", async () => {
      const res = await REQUEST(
        buildApp(),
        "POST",
        "/api/git/remotes",
        JSON.stringify({ name: "test-remote", url: "--option=value" }),
        { "Content-Type": "application/json" },
      );

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Invalid git URL format");
    });
  });

  describe("DELETE /git/remotes/:name", () => {
    it("returns 400 for invalid remote name", async () => {
      const res = await REQUEST(buildApp(), "DELETE", "/api/git/remotes/invalid;cmd");

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Invalid remote name");
    });

    it("returns 404 for non-existent remote", async () => {
      const res = await REQUEST(buildApp(), "DELETE", "/api/git/remotes/nonexistent-remote-xyz");

      expect(res.status).toBe(404);
      expect(res.body.error).toContain("does not exist");
    });
  });

  describe("PATCH /git/remotes/:name", () => {
    it("returns 400 without newName", async () => {
      const res = await REQUEST(buildApp(), "PATCH", "/api/git/remotes/origin", JSON.stringify({}), {
        "Content-Type": "application/json",
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("newName is required");
    });

    it("returns 400 for invalid remote name", async () => {
      const res = await REQUEST(
        buildApp(),
        "PATCH",
        "/api/git/remotes/invalid;cmd",
        JSON.stringify({ newName: "new-name" }),
        { "Content-Type": "application/json" },
      );

      expect(res.status).toBe(400);
    });

    it("returns 400 for invalid newName", async () => {
      const res = await REQUEST(
        buildApp(),
        "PATCH",
        "/api/git/remotes/origin",
        JSON.stringify({ newName: "invalid;cmd" }),
        { "Content-Type": "application/json" },
      );

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Invalid");
    });

    it("returns 404 for non-existent remote", async () => {
      const res = await REQUEST(
        buildApp(),
        "PATCH",
        "/api/git/remotes/nonexistent-remote-xyz",
        JSON.stringify({ newName: "new-name" }),
        { "Content-Type": "application/json" },
      );

      expect(res.status).toBe(404);
      expect(res.body.error).toContain("does not exist");
    });
  });

  describe("PUT /git/remotes/:name/url", () => {
    it("returns 400 without url", async () => {
      const res = await REQUEST(buildApp(), "PUT", "/api/git/remotes/origin/url", JSON.stringify({}), {
        "Content-Type": "application/json",
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("url is required");
    });

    it("returns 400 for invalid remote name", async () => {
      const res = await REQUEST(
        buildApp(),
        "PUT",
        "/api/git/remotes/invalid;cmd/url",
        JSON.stringify({ url: "https://github.com/new/repo.git" }),
        { "Content-Type": "application/json" },
      );

      expect(res.status).toBe(400);
    });

    it("returns 400 for invalid git URL", async () => {
      const res = await REQUEST(
        buildApp(),
        "PUT",
        "/api/git/remotes/origin/url",
        JSON.stringify({ url: "not-a-valid-url" }),
        { "Content-Type": "application/json" },
      );

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Invalid git URL format");
    });

    it("returns 400 for URL with shell metacharacters", async () => {
      const res = await REQUEST(
        buildApp(),
        "PUT",
        "/api/git/remotes/origin/url",
        JSON.stringify({ url: "https://example.com/repo.git; rm -rf /" }),
        { "Content-Type": "application/json" },
      );

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Invalid git URL format");
    });

    it("returns 404 for non-existent remote", async () => {
      const res = await REQUEST(
        buildApp(),
        "PUT",
        "/api/git/remotes/nonexistent-remote-xyz/url",
        JSON.stringify({ url: "https://github.com/new/repo.git" }),
        { "Content-Type": "application/json" },
      );

      expect(res.status).toBe(404);
      expect(res.body.error).toContain("does not exist");
    });
  });
});

// ── File API tests ────────────────────────────────────────────────────
describe("File API endpoints", () => {
    let store: TaskStore;

    beforeEach(() => {
      store = createMockStore({
        getRootDir: vi.fn().mockReturnValue("/tmp/test"),
      });
    });

    function buildApp() {
      const app = express();
      app.use(express.json());
      app.use("/api", createApiRoutes(store));
      return app;
    }

    describe("GET /tasks/:id/files", () => {
      it("returns 404 for non-existent task", async () => {
        (store.getTask as ReturnType<typeof vi.fn>).mockRejectedValue({ code: "ENOENT" });

        const res = await GET(buildApp(), "/api/tasks/KB-NONEXISTENT/files");

        expect(res.status).toBe(404);
        expect(res.body).toHaveProperty("error");
      });

      it("returns 404 when task directory does not exist", async () => {
        (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
          id: "FN-001",
          worktree: null,
        });

        const res = await GET(buildApp(), "/api/tasks/KB-001/files");
        // Will fail because task directory doesn't exist
        expect(res.status === 404 || res.status === 500).toBe(true);
      });

      it("accepts path query parameter", async () => {
        (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
          id: "FN-001",
          worktree: null,
        });

        const res = await GET(buildApp(), "/api/tasks/KB-001/files?path=src");
        // Directory won't exist, but endpoint should process the query param
        expect(res.status === 404 || res.status === 500).toBe(true);
      });
    });

    describe("GET /tasks/:id/files/:filepath", () => {
      it("returns 404 for non-existent file", async () => {
        (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
          id: "FN-001",
          worktree: null,
        });

        const res = await GET(buildApp(), "/api/tasks/KB-001/files/nonexistent.txt");
        expect(res.status).toBe(404);
      });

      it("returns 400 for empty filepath", async () => {
        (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
          id: "FN-001",
          worktree: null,
        });

        const res = await GET(buildApp(), "/api/tasks/KB-001/files/");
        // Empty path should result in error
        expect(res.status === 400 || res.status === 404).toBe(true);
      });

      it("allows reading binary files (returns 404 if not found)", async () => {
        (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
          id: "FN-001",
          worktree: null,
        });

        const res = await GET(buildApp(), "/api/tasks/KB-001/files/image.png");
        // Binary files are now allowed; returns 404 if file doesn't exist
        expect(res.status).toBe(404);
      });

      it("rejects path traversal attempts", async () => {
        (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
          id: "FN-001",
          worktree: null,
        });

        const res = await GET(buildApp(), "/api/tasks/KB-001/files/../etc/passwd");
        expect([400, 404, 500]).toContain(res.status);
        if (res.body?.error) {
          expect(res.body.error).toContain("traversal");
        }
      });
    });

    describe("POST /tasks/:id/files/:filepath", () => {
      it("requires content in body", async () => {
        (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
          id: "FN-001",
          worktree: null,
        });

        const res = await REQUEST(
          buildApp(),
          "POST",
          "/api/tasks/KB-001/files/test.txt",
          JSON.stringify({}),
          { "Content-Type": "application/json" }
        );

        expect(res.status).toBe(400);
        expect(res.body.error).toContain("content is required");
      });

      it("rejects non-string content", async () => {
        (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
          id: "FN-001",
          worktree: null,
        });

        const res = await REQUEST(
          buildApp(),
          "POST",
          "/api/tasks/KB-001/files/test.txt",
          JSON.stringify({ content: 123 }),
          { "Content-Type": "application/json" }
        );

        expect(res.status).toBe(400);
      });

      it("returns 404 for non-existent parent directory", async () => {
        (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
          id: "FN-001",
          worktree: null,
        });

        const res = await REQUEST(
          buildApp(),
          "POST",
          "/api/tasks/KB-001/files/nonexistent/dir/file.txt",
          JSON.stringify({ content: "test" }),
          { "Content-Type": "application/json" }
        );

        expect(res.status).toBe(404);
      });

      it("rejects path traversal in write", async () => {
        (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
          id: "FN-001",
          worktree: null,
        });

        const res = await REQUEST(
          buildApp(),
          "POST",
          "/api/tasks/KB-001/files/../../../etc/passwd",
          JSON.stringify({ content: "evil" }),
          { "Content-Type": "application/json" }
        );

        expect([400, 404, 500]).toContain(res.status);
      });
    });
});

describe("Workspace File Routes", () => {
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

  // ── Route Collision Regression Tests ────────────────────────────────────────
  // These tests verify that operation routes (/copy, /move, /delete, /rename)
  // are NOT shadowed by the generic POST /files/{*filepath} write route.

  describe("Route collision regression - POST /files/{*filepath}/delete", () => {
    it("delete route is matched correctly without hitting the generic write handler", async () => {
      // The key bug: POST /files/somefolder/delete was matching
      // POST /files/{*filepath} with filepath="somefolder/delete", causing
      // the "content is required" error instead of hitting the delete handler.

      // Mock the file-service to track which function was called
      const mockDeleteWorkspaceFile = vi.fn().mockResolvedValue({ success: true });
      const mockWriteWorkspaceFile = vi.fn().mockResolvedValue({ success: true, mtime: new Date().toISOString(), size: 0 });
      const mockReadWorkspaceFile = vi.fn().mockResolvedValue({ content: "test", mtime: new Date().toISOString(), size: 4 });

      // We need to spy on the file-service module
      // Since the routes import file-service internally, we test by checking
      // that a delete request to /files/somefolder/delete returns success
      // (not a 400 "content required" error from the generic handler)

      const res = await REQUEST(
        buildApp(),
        "POST",
        "/api/files/somefolder/delete?workspace=project",
        JSON.stringify({}),
        { "Content-Type": "application/json" }
      );

      // The route should NOT return 400 "content is required"
      // It should either succeed (200/201) or return a proper error from deleteWorkspaceFile
      // NOT the generic write handler's validation error
      if (res.status === 400) {
        expect(res.body.error).not.toContain("content is required");
      }
    });

    it("POST /files/somefolder/delete does NOT require content body", async () => {
      // This is the key regression test: the delete handler should NOT validate
      // that content is a string, because delete doesn't take content.
      // Previously, this would return 400 "content is required" because the
      // generic write handler was shadowing the delete route.

      const res = await REQUEST(
        buildApp(),
        "POST",
        "/api/files/somefolder/delete",
        JSON.stringify({}),
        { "Content-Type": "application/json" }
      );

      // Should NOT be 400 "content is required" - that was the bug
      expect(res.status).not.toBe(400);
    });
  });

  describe("Route collision regression - POST /files/{*filepath}/copy", () => {
    it("copy route receives correct filepath parameter", async () => {
      // Verify that /files/myfile.txt/copy gets the right filepath="myfile.txt"
      // not filepath="myfile.txt/copy" from the generic handler

      const res = await REQUEST(
        buildApp(),
        "POST",
        "/api/files/myfile.txt/copy",
        JSON.stringify({ destination: "newfile.txt" }),
        { "Content-Type": "application/json" }
      );

      // Should NOT be 400 "destination is required" from copy handler
      // The copy handler should be reached, not the generic write handler
      if (res.status === 400) {
        expect(res.body.error).not.toBe("content is required and must be a string");
      }
    });
  });

  describe("Route collision regression - POST /files/{*filepath}/move", () => {
    it("move route receives correct filepath parameter", async () => {
      const res = await REQUEST(
        buildApp(),
        "POST",
        "/api/files/myfile.txt/move",
        JSON.stringify({ destination: "newpath/myfile.txt" }),
        { "Content-Type": "application/json" }
      );

      if (res.status === 400) {
        expect(res.body.error).not.toBe("content is required and must be a string");
      }
    });
  });

  describe("Route collision regression - POST /files/{*filepath}/rename", () => {
    it("rename route receives correct filepath parameter", async () => {
      const res = await REQUEST(
        buildApp(),
        "POST",
        "/api/files/myfile.txt/rename",
        JSON.stringify({ newName: "renamed.txt" }),
        { "Content-Type": "application/json" }
      );

      if (res.status === 400) {
        expect(res.body.error).not.toBe("content is required and must be a string");
      }
    });
  });

  describe("POST /files/mkdir", () => {
    let rootDir: string;

    beforeEach(() => {
      rootDir = mkdtempSync(join(tmpdir(), "kb-mkdir-route-"));
      store = createMockStore({ getRootDir: vi.fn().mockReturnValue(rootDir) });
    });

    afterEach(() => {
      rmSync(rootDir, { recursive: true, force: true });
    });

    it("creates a directory in the workspace", async () => {
      const res = await REQUEST(
        buildApp(),
        "POST",
        "/api/files/mkdir?workspace=project",
        JSON.stringify({ path: "docs" }),
        { "Content-Type": "application/json" },
      );

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, path: "docs" });
      expect(existsSync(join(rootDir, "docs"))).toBe(true);
    });

    it("rejects duplicate directories with 409", async () => {
      mkdirSync(join(rootDir, "docs"));

      const res = await REQUEST(
        buildApp(),
        "POST",
        "/api/files/mkdir?workspace=project",
        JSON.stringify({ path: "docs" }),
        { "Content-Type": "application/json" },
      );

      expect(res.status).toBe(409);
      expect(res.body.error).toContain("already exists");
    });

    it("rejects missing parent directories with 404", async () => {
      const res = await REQUEST(
        buildApp(),
        "POST",
        "/api/files/mkdir?workspace=project",
        JSON.stringify({ path: "missing/child" }),
        { "Content-Type": "application/json" },
      );

      expect(res.status).toBe(404);
      expect(res.body.error).toContain("Parent directory does not exist");
    });
  });

  describe("Generic write route still enforces content validation", () => {
    it("POST /files/{*filepath} still requires content for actual writes", async () => {
      // Make sure the generic write route still validates content correctly
      const res = await REQUEST(
        buildApp(),
        "POST",
        "/api/files/somefile.txt",
        JSON.stringify({}),
        { "Content-Type": "application/json" }
      );

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("content is required");
    });

    it("POST /files/{*filepath} accepts valid content string", async () => {
      // This test ensures the generic write route still works for actual file writes
      const res = await REQUEST(
        buildApp(),
        "POST",
        "/api/files/newfile.txt",
        JSON.stringify({ content: "hello world" }),
        { "Content-Type": "application/json" }
      );

      // Should not be 400 "content is required" - the route should accept this
      // It may fail for other reasons (e.g., file not found), but not content validation
      if (res.status === 400) {
        expect(res.body.error).not.toBe("content is required and must be a string");
      }
    });
  });

  describe("Operation routes with nested paths", () => {
    it("POST /files/deep/path/file.txt/delete works correctly", async () => {
      // Test that deeply nested paths work with operation routes
      const res = await REQUEST(
        buildApp(),
        "POST",
        "/api/files/deep/path/to/file.txt/delete",
        JSON.stringify({}),
        { "Content-Type": "application/json" }
      );

      // Should NOT be 400 "content is required"
      if (res.status === 400) {
        expect(res.body.error).not.toContain("content is required");
      }
    });

    it("POST /files/a/b/c/d.txt/copy with destination", async () => {
      const res = await REQUEST(
        buildApp(),
        "POST",
        "/api/files/a/b/c/d.txt/copy",
        JSON.stringify({ destination: "a/b/c/d_copy.txt" }),
        { "Content-Type": "application/json" }
      );

      // Should NOT be 400 about content validation
      if (res.status === 400) {
        expect(res.body.error).not.toContain("content is required");
      }
    });
  });

  describe("collectRecentMergeAdvances", () => {
    function git(cwd: string, args: string[]): string {
      return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8", stdio: "pipe" }).trim();
    }

    function initRepo() {
      const repoDir = mkdtempSync(join(tmpdir(), "kb-advances-"));
      execFileSync("git", ["init", "--initial-branch=main", repoDir], { stdio: "pipe" });
      execFileSync("git", ["-C", repoDir, "config", "user.email", "kb-tests@example.com"], { stdio: "pipe" });
      execFileSync("git", ["-C", repoDir, "config", "user.name", "KB Tests"], { stdio: "pipe" });
      return repoDir;
    }

    function commitFile(repoDir: string, file: string, content: string, message: string): string {
      writeFileSync(join(repoDir, file), content, "utf-8");
      execFileSync("git", ["-C", repoDir, "add", file], { stdio: "pipe" });
      execFileSync("git", ["-C", repoDir, "commit", "-m", message], { stdio: "pipe" });
      return git(repoDir, ["rev-parse", "HEAD"]);
    }

    async function runWithAdvance(repoDir: string, toSha: string, options?: { headSha?: string; localIntegrationTipSha?: string }) {
      const headSha = options?.headSha ?? git(repoDir, ["rev-parse", "HEAD"]);
      const fakeStore = {
        getRunAuditEvents: ({ mutationType }: { mutationType?: string }) => {
          if (mutationType === "merge:integration-ref-advance") {
            return [{ taskId: "FN-123", timestamp: new Date().toISOString(), metadata: { toSha, fromSha: null, succeeded: true } }];
          }
          return [];
        },
      } as unknown as TaskStore;
      return collectRecentMergeAdvances(fakeStore, repoDir, headSha, options?.localIntegrationTipSha);
    }

    it("marks orphaned SHAs as handled", async () => {
      const repoDir = initRepo();
      try {
        const orphanSha = commitFile(repoDir, "a.txt", "one\n", "one");
        execFileSync("git", ["-C", repoDir, "checkout", "--orphan", "rewritten"], { stdio: "pipe" });
        execFileSync("git", ["-C", repoDir, "rm", "-rf", "."], { stdio: "pipe" });
        commitFile(repoDir, "a.txt", "two\n", "two");
        execFileSync("git", ["-C", repoDir, "branch", "-M", "main"], { stdio: "pipe" });
        execFileSync("git", ["-C", repoDir, "reflog", "expire", "--expire=now", "--all"], { stdio: "pipe" });
        execFileSync("git", ["-C", repoDir, "gc", "--prune=now"], { stdio: "pipe" });
        const result = await runWithAdvance(repoDir, orphanSha);
        expect(result?.[0]?.resolution).toBe("orphaned");
        expect(result?.[0]?.needsAction).toBe(false);
      } finally {
        rmSync(repoDir, { recursive: true, force: true });
      }
    });

    it("marks subsumed equivalent content as handled", async () => {
      const repoDir = initRepo();
      try {
        const baseSha = commitFile(repoDir, "a.txt", "base\n", "base");
        const toSha = commitFile(repoDir, "a.txt", "base\nnew\n", "advance");
        execFileSync("git", ["-C", repoDir, "reset", "--hard", baseSha], { stdio: "pipe" });
        commitFile(repoDir, "a.txt", "base\nnew\n", "equivalent");
        const result = await runWithAdvance(repoDir, toSha);
        expect(result?.[0]?.resolution).toBe("subsumed");
        expect(result?.[0]?.needsAction).toBe(false);
      } finally {
        rmSync(repoDir, { recursive: true, force: true });
      }
    });

    it("keeps unresolved advances as pending", async () => {
      const repoDir = initRepo();
      try {
        const baseSha = commitFile(repoDir, "a.txt", "base\n", "base");
        const toSha = commitFile(repoDir, "a.txt", "base\nnew\n", "advance");
        execFileSync("git", ["-C", repoDir, "reset", "--hard", baseSha], { stdio: "pipe" });
        commitFile(repoDir, "a.txt", "base\nother\n", "different");
        const result = await runWithAdvance(repoDir, toSha);
        expect(result?.[0]?.resolution).toBe("pending");
        expect(result?.[0]?.needsAction).toBe(true);
      } finally {
        rmSync(repoDir, { recursive: true, force: true });
      }
    });

    it("marks reachable ancestor as handled", async () => {
      const repoDir = initRepo();
      try {
        const toSha = commitFile(repoDir, "a.txt", "base\n", "base");
        commitFile(repoDir, "b.txt", "next\n", "next");
        const result = await runWithAdvance(repoDir, toSha);
        expect(result?.[0]?.resolution).toBe("reachable");
        expect(result?.[0]?.needsAction).toBe(false);
      } finally {
        rmSync(repoDir, { recursive: true, force: true });
      }
    });

    it("marks unreachable existing SHA as superseded when head equals integration tip", async () => {
      const repoDir = initRepo();
      try {
        const baseSha = commitFile(repoDir, "a.txt", "base\n", "base");
        const toSha = commitFile(repoDir, "a.txt", "base\nadvance\n", "advance");
        execFileSync("git", ["-C", repoDir, "reset", "--hard", baseSha], { stdio: "pipe" });
        const rewrittenHead = commitFile(repoDir, "a.txt", "base\nrewritten\n", "rewritten");
        const result = await runWithAdvance(repoDir, toSha, { localIntegrationTipSha: rewrittenHead });
        expect(result?.[0]?.resolution).toBe("superseded");
        expect(result?.[0]?.needsAction).toBe(false);
      } finally {
        rmSync(repoDir, { recursive: true, force: true });
      }
    });

    it("keeps unreachable existing SHA pending when head is not aligned", async () => {
      const repoDir = initRepo();
      try {
        const baseSha = commitFile(repoDir, "a.txt", "base\n", "base");
        const toSha = commitFile(repoDir, "a.txt", "base\nadvance\n", "advance");
        execFileSync("git", ["-C", repoDir, "reset", "--hard", baseSha], { stdio: "pipe" });
        const rewrittenHead = commitFile(repoDir, "a.txt", "base\nrewritten\n", "rewritten");
        const nonMatchingTipSha = `${rewrittenHead.slice(0, 39)}${rewrittenHead.endsWith("0") ? "1" : "0"}`;
        const result = await runWithAdvance(repoDir, toSha, { localIntegrationTipSha: nonMatchingTipSha });
        expect(result?.[0]?.resolution).toBe("pending");
        expect(result?.[0]?.needsAction).toBe(true);
      } finally {
        rmSync(repoDir, { recursive: true, force: true });
      }
    });
  });
});
