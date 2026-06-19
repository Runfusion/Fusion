// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fusionCore from "@fusion/core";
import type { Task, TaskStore } from "@fusion/core";

const { mockGeneratePrMetadata } = vi.hoisted(() => ({
  mockGeneratePrMetadata: vi.fn(),
}));

vi.mock("../pr-metadata-generator.js", () => ({
  generatePrMetadata: mockGeneratePrMetadata,
}));

import { prRouteCommandRunner } from "../routes/register-git-github.js";
import { createServer } from "../server.js";
import { get as performGet, request as performRequest } from "../test-request.js";

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

function createStore(taskOrError: Task | Error): TaskStore {
  const getTask = taskOrError instanceof Error
    ? vi.fn().mockRejectedValue(taskOrError)
    : vi.fn().mockResolvedValue(taskOrError);

  return {
    getTask,
    listTasks: vi.fn().mockResolvedValue([]),
    createTask: vi.fn(),
    moveTask: vi.fn(),
    updateTask: vi.fn(),
    deleteTask: vi.fn(),
    mergeTask: vi.fn(),
    archiveTask: vi.fn(),
    unarchiveTask: vi.fn(),
    getSettings: vi.fn().mockResolvedValue({ directMergeCommitStrategy: "auto" }),
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

function queueRunFailure(message: string, code = 1) {
  runQueue.push({ ok: false, error: Object.assign(new Error(message), { code, stderr: message, stdout: "" }) });
}

function queueTryRunSuccess(value = "") {
  tryRunQueue.push({ ok: true, stdout: value });
}

function queueTryRunFailure(code: number, stderr = "failed", stdout = "") {
  tryRunQueue.push({ ok: false, error: Object.assign(new Error(stderr), { code, stderr, stdout }), code, stderr, stdout });
}

describe("PR metadata/preflight/options routes", () => {
  const originalRepoEnv = process.env.GITHUB_REPOSITORY;

  beforeEach(() => {
    vi.clearAllMocks();
    runQueue.length = 0;
    tryRunQueue.length = 0;
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
    process.env.GITHUB_REPOSITORY = "owner/repo";
    vi.spyOn(fusionCore, "getCurrentRepo").mockReturnValue({ owner: "owner", repo: "repo" });
    vi.spyOn(fusionCore, "isGhAuthenticated").mockReturnValue(true);
    mockGeneratePrMetadata.mockResolvedValue({
      title: "Generated title",
      body: "Generated body",
      templateUsed: true,
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

  it("POST /pr/generate-metadata returns generated metadata and forwards an abort signal", async () => {
    const app = createServer(createStore(createTask()));
    const response = await performRequest(app, "POST", "/api/tasks/FN-001/pr/generate-metadata", "{}", { "content-type": "application/json" });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ title: "Generated title", body: "Generated body", templateUsed: true });
    expect(mockGeneratePrMetadata).toHaveBeenCalledWith(expect.objectContaining({
      task: expect.objectContaining({ id: "FN-001" }),
      repoRoot: "/tmp/project",
      signal: expect.any(AbortSignal),
    }));
  });

  it("POST /pr/generate-metadata returns 404 for missing task", async () => {
    const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
    const app = createServer(createStore(missing));
    const response = await performRequest(app, "POST", "/api/tasks/FN-404/pr/generate-metadata", "{}", { "content-type": "application/json" });

    expect(response.status).toBe(404);
    expect(response.body.error).toContain("Task FN-404 not found");
  });

  it("POST /pr/generate-metadata wraps generator failures", async () => {
    mockGeneratePrMetadata.mockRejectedValueOnce(new Error("generator exploded"));
    const app = createServer(createStore(createTask()));
    const response = await performRequest(app, "POST", "/api/tasks/FN-001/pr/generate-metadata", "{}", { "content-type": "application/json" });

    expect(response.status).toBe(500);
    expect(response.body.error).toContain("generator exploded");
  });

  it("GET /pr/preflight returns clean branch diagnostics", async () => {
    queueTryRunSuccess("deadbeef\n");
    queueTryRunSuccess("refs/heads/fusion/fn-001\n");
    queueRunSuccess("2\n");
    queueTryRunSuccess("tree-oid\n");
    queueRunSuccess("abc123\tAdd feature\tDev\ndef456\tFix tests\tDev\n");
    queueRunSuccess("5\t1\tsrc/a.ts\n1\t1\told.ts => new.ts\n");
    queueRunSuccess("M\tsrc/a.ts\nR100\told.ts\tnew.ts\n");

    const app = createServer(createStore(createTask()));
    const response = await performGet(app, "/api/tasks/FN-001/pr/preflight");

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      branchOnRemote: true,
      commitsPresent: true,
      conflictsWithBase: false,
      ghAuthOk: true,
      defaultBaseBranch: "main",
      head: "fusion/fn-001",
      commits: [
        { sha: "abc123", subject: "Add feature", author: "Dev" },
        { sha: "def456", subject: "Fix tests", author: "Dev" },
      ],
    });
    expect(response.body.changedFiles).toEqual([
      { path: "src/a.ts", additions: 5, deletions: 1, status: "modified" },
      { path: "new.ts", additions: 1, deletions: 1, status: "renamed" },
    ]);
  });

  it("GET /pr/preflight degrades safely when branch is missing, auth fails, conflicts exist, and diff output is malformed", async () => {
    vi.spyOn(fusionCore, "isGhAuthenticated").mockReturnValue(false);
    queueTryRunSuccess("deadbeef\n");
    queueTryRunFailure(2, "missing remote branch");
    queueRunSuccess("0\n");
    queueTryRunFailure(1, "conflicted-file.ts\n");
    queueRunSuccess("");
    queueRunSuccess("not-a-numstat-line\n");
    queueRunSuccess("M\n\n");

    const app = createServer(createStore(createTask()));
    const response = await performGet(app, "/api/tasks/FN-001/pr/preflight");

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      branchOnRemote: false,
      commitsPresent: false,
      conflictsWithBase: true,
      ghAuthOk: false,
      commits: [],
      changedFiles: [],
    });
  });

  it("GET /pr/preflight treats non-conflict merge-tree errors as no conflict", async () => {
    queueTryRunSuccess("deadbeef\n");
    queueTryRunSuccess("refs/heads/fusion/fn-001\n");
    queueRunSuccess("2\n");
    queueTryRunFailure(128, "fatal: bad revision");
    queueRunSuccess("abc123\tAdd feature\tDev\n");
    queueRunSuccess("1\t0\tsrc/a.ts\n");
    queueRunSuccess("M\tsrc/a.ts\n");

    const app = createServer(createStore(createTask()));
    const response = await performGet(app, "/api/tasks/FN-001/pr/preflight");

    expect(response.status).toBe(200);
    expect(response.body.conflictsWithBase).toBe(false);
    expect(tryRunQueue).toHaveLength(0);
    expect(runQueue).toHaveLength(0);
  });

  it("GET /pr/preflight returns 404 for missing task", async () => {
    const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
    const app = createServer(createStore(missing));
    const response = await performGet(app, "/api/tasks/FN-404/pr/preflight");

    expect(response.status).toBe(404);
    expect(response.body.error).toContain("Task FN-404 not found");
  });

  it("GET /pr/options returns branches, collaborators, and labels", async () => {
    queueRunSuccess("main\nrelease\n");
    queueRunSuccess("origin/HEAD\norigin/main\norigin/develop\n");
    queueRunSuccess('{"login":"alice","name":"Alice"}\n{"login":"bob","name":"bob"}\n');
    queueRunSuccess('{"name":"bug","color":"ff0000"}\n{"name":"feature","color":"00ff00"}\n');

    const app = createServer(createStore(createTask()));
    const response = await performGet(app, "/api/tasks/FN-001/pr/options");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      baseBranches: ["main", "release", "develop"],
      reviewers: [{ login: "alice", name: "Alice" }, { login: "bob", name: "bob" }],
      assignees: [{ login: "alice", name: "Alice" }, { login: "bob", name: "bob" }],
      labels: [{ name: "bug", color: "ff0000" }, { name: "feature", color: "00ff00" }],
    });
  });

  it("GET /pr/options returns degraded but shaped responses when gh calls fail", async () => {
    queueRunFailure("gh branches failed");
    queueRunSuccess("origin/HEAD\norigin/main\norigin/release\n");
    queueRunFailure("gh collaborators failed");
    queueRunFailure("gh labels failed");

    const app = createServer(createStore(createTask()));
    const response = await performGet(app, "/api/tasks/FN-001/pr/options");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      baseBranches: ["main", "release"],
      reviewers: [],
      assignees: [],
      labels: [],
    });
  });

  it("GET /pr/options returns 400 when repository cannot be resolved", async () => {
    delete process.env.GITHUB_REPOSITORY;
    vi.spyOn(fusionCore, "getCurrentRepo").mockReturnValue(null);

    const app = createServer(createStore(createTask()));
    const response = await performGet(app, "/api/tasks/FN-001/pr/options");

    expect(response.status).toBe(400);
    expect(response.body.error).toContain("Could not determine GitHub repository");
  });

  it("GET /pr/options returns 404 for missing task", async () => {
    const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
    const app = createServer(createStore(missing));
    const response = await performGet(app, "/api/tasks/FN-404/pr/options");

    expect(response.status).toBe(404);
    expect(response.body.error).toContain("Task FN-404 not found");
  });
});
