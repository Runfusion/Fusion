// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fusionCore from "@fusion/core";
import type { Task, TaskStore } from "@fusion/core";

const { mockResolvePrConflicts } = vi.hoisted(() => ({
  mockResolvePrConflicts: vi.fn(),
}));

vi.mock("../pr-conflict-resolver.js", () => ({
  resolvePrConflicts: mockResolvePrConflicts,
}));

import { prRouteCommandRunner } from "../routes/register-git-github.js";
import { createServer } from "../server.js";
import { request as performRequest } from "../test-request.js";

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-001",
    title: "Task",
    description: "desc",
    column: "in-review",
    status: "in-review",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    prInfo: {
      url: "https://github.com/owner/repo/pull/1",
      number: 1,
      status: "open",
      title: "PR",
      headBranch: "fusion/fn-001",
      baseBranch: "main",
      commentCount: 0,
    },
    comments: [],
    ...overrides,
  } as Task;
}

function createStore(task: Task): TaskStore {
  return {
    getTask: vi.fn().mockResolvedValue(task),
    listTasks: vi.fn().mockResolvedValue([]),
    createTask: vi.fn(),
    moveTask: vi.fn(),
    updateTask: vi.fn(),
    deleteTask: vi.fn(),
    mergeTask: vi.fn(),
    archiveTask: vi.fn(),
    unarchiveTask: vi.fn(),
    getSettings: vi.fn().mockResolvedValue({ defaultProvider: "mock", defaultModelId: "scripted" }),
    updateSettings: vi.fn(),
    logEntry: vi.fn().mockResolvedValue(undefined),
    getAgentLogs: vi.fn().mockResolvedValue([]),
    addSteeringComment: vi.fn(),
    updatePrInfo: vi.fn().mockResolvedValue(undefined),
    updatePrInfoByNumber: vi.fn().mockResolvedValue(undefined),
    addPrInfo: vi.fn().mockResolvedValue(undefined),
    removePrInfoByNumber: vi.fn().mockResolvedValue(undefined),
    updateIssueInfo: vi.fn().mockResolvedValue(undefined),
    getRootDir: vi.fn().mockReturnValue("/tmp/project"),
    getFusionDir: vi.fn().mockReturnValue("/tmp/project/.fusion"),
    getDatabase: vi.fn().mockReturnValue({
      exec: vi.fn(),
      prepare: vi.fn().mockReturnValue({ run: vi.fn().mockReturnValue({ changes: 0 }), get: vi.fn(), all: vi.fn().mockReturnValue([]) }),
    }),
    getMissionStore: vi.fn().mockReturnValue({ listMissions: vi.fn().mockReturnValue([]) }),
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as TaskStore;
}

type TryRunResult = Awaited<ReturnType<typeof prRouteCommandRunner.tryRun>>;
const runQueue: Array<{ ok: true; value: string } | { ok: false; error: Error }> = [];
const tryRunQueue: TryRunResult[] = [];

function queueRunSuccess(value = "") {
  runQueue.push({ ok: true, value });
}

function queueTryRunSuccess(value = "") {
  tryRunQueue.push({ ok: true, stdout: value });
}

describe("POST /pr/resolve-conflicts", () => {
  const originalRepoEnv = process.env.GITHUB_REPOSITORY;

  beforeEach(() => {
    vi.clearAllMocks();
    runQueue.length = 0;
    tryRunQueue.length = 0;
    process.env.GITHUB_REPOSITORY = "owner/repo";
    vi.spyOn(fusionCore, "getCurrentRepo").mockReturnValue({ owner: "owner", repo: "repo" });
    vi.spyOn(fusionCore, "isGhAuthenticated").mockReturnValue(true);
    vi.spyOn(prRouteCommandRunner, "run").mockImplementation(async () => {
      const next = runQueue.shift();
      if (!next) throw new Error("Unexpected run command");
      if (next.ok) return next.value;
      throw next.error;
    });
    vi.spyOn(prRouteCommandRunner, "tryRun").mockImplementation(async () => {
      const next = tryRunQueue.shift();
      if (!next) throw new Error("Unexpected tryRun command");
      return next;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalRepoEnv === undefined) {
      delete process.env.GITHUB_REPOSITORY;
    } else {
      process.env.GITHUB_REPOSITORY = originalRepoEnv;
    }
  });

  it("rejects non in-review tasks", async () => {
    const app = createServer(createStore(createTask({ column: "todo", status: "todo" })));
    const response = await performRequest(app, "POST", "/api/tasks/FN-001/pr/resolve-conflicts", JSON.stringify({ base: "main" }), { "content-type": "application/json" });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain("Task must be in 'in-review' column");
    expect(mockResolvePrConflicts).not.toHaveBeenCalled();
  });

  it("returns updated preflight after successful resolution and logs the push path", async () => {
    queueTryRunSuccess("main"); // resolvePrBaseRef local base check
    queueTryRunSuccess("main"); // computePrPreflight base check
    queueTryRunSuccess("refs/heads/fusion/fn-001\n"); // remote branch exists
    queueRunSuccess("2\n"); // git rev-list --count
    queueTryRunSuccess("tree-oid\n"); // git merge-tree --write-tree --name-only (clean exit 0)
    queueRunSuccess("abc123\tResolve conflicts\tDev\n"); // git log
    queueRunSuccess("3\t1\tsrc/a.ts\n"); // git diff --numstat
    queueRunSuccess("M\tsrc/a.ts\n"); // git diff --name-status
    mockResolvePrConflicts.mockResolvedValue({
      resolved: true,
      pushed: true,
      conflictedFiles: ["src/a.ts"],
      message: "Resolved conflicts and pushed branch.",
    });

    const store = createStore(createTask());
    const app = createServer(store);
    const response = await performRequest(app, "POST", "/api/tasks/FN-001/pr/resolve-conflicts", JSON.stringify({ base: "main" }), { "content-type": "application/json" });

    expect(response.status).toBe(200);
    expect(mockResolvePrConflicts).toHaveBeenCalledWith(expect.objectContaining({
      taskId: "FN-001",
      baseRef: "main",
      rootDir: "/tmp/project",
    }));
    expect(response.body.result).toMatchObject({ resolved: true, pushed: true });
    expect(response.body.preflight.conflictsWithBase).toBe(false);
    expect(store.logEntry).toHaveBeenCalledWith("FN-001", "AI resolved PR conflicts", expect.stringContaining("fusion/fn-001"));
    expect(store.logEntry).toHaveBeenCalledWith("FN-001", "Pushed branch after PR conflict resolution", "fusion/fn-001");
    expect(tryRunQueue).toHaveLength(0);
    expect(runQueue).toHaveLength(0);
  });

  it("returns a structured retryable error when markers remain unresolved", async () => {
    queueTryRunSuccess("main"); // resolvePrBaseRef local base check
    mockResolvePrConflicts.mockResolvedValue({
      resolved: false,
      pushed: false,
      conflictedFiles: ["src/conflicted.ts"],
      message: "AI conflict resolution left unresolved markers in 1 file(s).",
    });

    const app = createServer(createStore(createTask()));
    const response = await performRequest(app, "POST", "/api/tasks/FN-001/pr/resolve-conflicts", JSON.stringify({ base: "main" }), { "content-type": "application/json" });

    expect(response.status).toBe(409);
    expect(response.body.error).toContain("unresolved markers");
    expect(response.body.details).toMatchObject({
      code: "conflict-resolution-failed",
      retryable: true,
      unresolvedFiles: ["src/conflicted.ts"],
      head: "fusion/fn-001",
      base: "main",
    });
    expect(tryRunQueue).toHaveLength(0);
    expect(runQueue).toHaveLength(0);
  });
});
