import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type { Task } from "@fusion/core";

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execSync: vi.fn(),
  };
});

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: vi.fn(),
  };
});

const childProcess = await import("node:child_process");
const fs = await import("node:fs");
const mockExecSync = vi.mocked(childProcess.execSync);
const mockExistsSync = vi.mocked(fs.existsSync);

class MockStore extends EventEmitter {
  private tasks = new Map<string, Task>();

  getRootDir(): string {
    return process.cwd();
  }

  async getTask(id: string): Promise<Task> {
    const task = this.tasks.get(id);
    if (!task) {
      const error = Object.assign(new Error("Task not found"), { code: "ENOENT" });
      throw error;
    }
    return task;
  }

  addTask(task: Task): void {
    this.tasks.set(task.id, task);
  }

  getMissionStore() {
    return new EventEmitter();
  }

  async listTasks(): Promise<Task[]> {
    return [];
  }
}

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "KB-651",
    title: "Test task",
    description: "Test description",
    column: "in-progress",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
    columnMovedAt: "2026-04-01T00:00:00.000Z",
    worktree: "/tmp/kb-651",
    baseBranch: "main",
    ...overrides,
  };
}

async function getFileDiffsHandler(store: MockStore) {
  vi.resetModules();
  const { createApiRoutes } = await import("../routes.js");
  const router = createApiRoutes(store as any);
  const layer = (router as any).stack.find(
    (candidate: any) =>
      candidate.route?.path === "/tasks/:id/file-diffs" &&
      candidate.route?.methods?.get,
  );

  if (!layer) {
    throw new Error("GET /tasks/:id/file-diffs route not found");
  }

  return layer.route.stack[layer.route.stack.length - 1].handle as (req: any, res: any) => Promise<void>;
}

function createMockResponse() {
  return {
    statusCode: 200,
    body: undefined as any,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: any) {
      this.body = payload;
      return this;
    },
  };
}

async function requestFileDiffs(store: MockStore, taskId = "KB-651"): Promise<{ status: number; body: any }> {
  const handler = await getFileDiffsHandler(store);
  return requestFileDiffsWithHandler(handler, taskId);
}

async function requestFileDiffsWithHandler(
  handler: (req: any, res: any) => Promise<void>,
  taskId = "KB-651",
): Promise<{ status: number; body: any }> {
  const req = { params: { id: taskId } };
  const res = createMockResponse();
  await handler(req, res);
  return { status: res.statusCode, body: res.body };
}

describe("GET /api/tasks/:id/file-diffs", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    vi.setSystemTime(new Date("2026-04-01T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("uses merge-base to resolve diff base and returns per-file diffs", async () => {
    const store = new MockStore();
    store.addTask(createTask({ baseBranch: "main", baseCommitSha: "taskbase456" }));

    mockExecSync.mockImplementation((command) => {
      const cmd = String(command);
      // Task-scoped baseCommitSha validation
      if (cmd === "git merge-base --is-ancestor taskbase456 HEAD") {
        return "" as any;
      }
      // Committed changes against baseCommitSha
      if (cmd === "git diff --name-status taskbase456..HEAD") {
        return "M\tsrc/updated.ts\nA\tsrc/added.ts\n" as any;
      }
      // Working tree changes
      if (cmd === "git diff --name-status") {
        return "" as any;
      }
      // Per-file diffs
      if (cmd === 'git diff taskbase456..HEAD -- "src/updated.ts"') {
        return "diff --git a/src/updated.ts b/src/updated.ts\n--- a/src/updated.ts\n+++ b/src/updated.ts\n+hello\n" as any;
      }
      if (cmd === 'git diff taskbase456..HEAD -- "src/added.ts"') {
        return "diff --git a/src/added.ts b/src/added.ts\nnew file mode 100644\n+++ b/src/added.ts\n+added\n" as any;
      }
      throw new Error(`Unexpected command: ${cmd}`);
    });

    const response = await requestFileDiffs(store);

    expect(response.status).toBe(200);
    expect(response.body).toHaveLength(2);
    expect(response.body[0]).toEqual({
      path: "src/updated.ts",
      status: "modified",
      diff: "diff --git a/src/updated.ts b/src/updated.ts\n--- a/src/updated.ts\n+++ b/src/updated.ts\n+hello\n",
    });
    expect(response.body[1]).toEqual({
      path: "src/added.ts",
      status: "added",
      diff: "diff --git a/src/added.ts b/src/added.ts\nnew file mode 100644\n+++ b/src/added.ts\n+added\n",
    });
  });

  it("supports rename metadata with merge-base strategy", async () => {
    const store = new MockStore();
    store.addTask(createTask({ baseBranch: "main", baseCommitSha: "taskbase456" }));

    mockExecSync.mockImplementation((command) => {
      const cmd = String(command);
      if (cmd === "git merge-base --is-ancestor taskbase456 HEAD") {
        return "" as any;
      }
      if (cmd === "git diff --name-status taskbase456..HEAD") {
        return "R100\tsrc/old-name.ts\tsrc/new-name.ts\n" as any;
      }
      if (cmd === "git diff --name-status") {
        return "" as any;
      }
      if (cmd === 'git diff taskbase456..HEAD -- "src/new-name.ts"') {
        return "diff --git a/src/old-name.ts b/src/new-name.ts\nsimilarity index 100%\nrename from src/old-name.ts\nrename to src/new-name.ts\n" as any;
      }
      throw new Error(`Unexpected command: ${cmd}`);
    });

    const response = await requestFileDiffs(store);

    expect(response.status).toBe(200);
    expect(response.body).toHaveLength(1);
    expect(response.body[0]).toEqual({
      path: "src/new-name.ts",
      status: "renamed",
      diff: "diff --git a/src/old-name.ts b/src/new-name.ts\nsimilarity index 100%\nrename from src/old-name.ts\nrename to src/new-name.ts\n",
      oldPath: "src/old-name.ts",
    });
  });

  it("falls back to HEAD~1 when merge-base fails", async () => {
    const store = new MockStore();
    store.addTask(createTask({ baseBranch: "main" }));

    mockExecSync.mockImplementation((command) => {
      const cmd = String(command);
      if (cmd === "git merge-base HEAD origin/main 2>/dev/null || git merge-base HEAD main") {
        throw new Error("merge-base failed");
      }
      if (cmd === "git rev-parse HEAD~1") {
        return "parent456\n" as any;
      }
      if (cmd === "git diff --name-status parent456..HEAD") {
        return "M\tsrc/fallback.ts\n" as any;
      }
      if (cmd === "git diff --name-status") {
        return "" as any;
      }
      if (cmd === 'git diff parent456..HEAD -- "src/fallback.ts"') {
        return "diff --git a/src/fallback.ts b/src/fallback.ts\n+fallback\n" as any;
      }
      throw new Error(`Unexpected command: ${cmd}`);
    });

    const response = await requestFileDiffs(store);

    expect(response.status).toBe(200);
    expect(response.body).toHaveLength(1);
    expect(response.body[0]).toEqual({
      path: "src/fallback.ts",
      status: "modified",
      diff: "diff --git a/src/fallback.ts b/src/fallback.ts\n+fallback\n",
    });
  });

  it("returns empty array when worktree is missing", async () => {
    const store = new MockStore();
    store.addTask(createTask({ worktree: undefined }));

    const response = await requestFileDiffs(store);

    expect(response.status).toBe(200);
    expect(response.body).toEqual([]);
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it("includes working-tree changes alongside committed changes", async () => {
    const store = new MockStore();
    store.addTask(createTask({ baseBranch: "main", baseCommitSha: "taskbase456" }));

    mockExecSync.mockImplementation((command) => {
      const cmd = String(command);
      if (cmd === "git merge-base --is-ancestor taskbase456 HEAD") {
        return "" as any;
      }
      if (cmd === "git diff --name-status taskbase456..HEAD") {
        return "M\tsrc/committed.ts\n" as any;
      }
      // Working tree has a different file
      if (cmd === "git diff --name-status") {
        return "A\tsrc/uncommitted.ts\n" as any;
      }
      if (cmd === 'git diff taskbase456..HEAD -- "src/committed.ts"') {
        return "diff --git a/src/committed.ts b/src/committed.ts\n+committed\n" as any;
      }
      if (cmd === 'git diff taskbase456..HEAD -- "src/uncommitted.ts"') {
        return "diff --git a/src/uncommitted.ts b/src/uncommitted.ts\n+uncommitted\n" as any;
      }
      throw new Error(`Unexpected command: ${cmd}`);
    });

    const response = await requestFileDiffs(store);

    expect(response.status).toBe(200);
    expect(response.body).toHaveLength(2);

    const paths = response.body.map((f: any) => f.path);
    expect(paths).toContain("src/committed.ts");
    expect(paths).toContain("src/uncommitted.ts");
  });

  it("deduplicates files that appear in both committed and working-tree diffs", async () => {
    const store = new MockStore();
    store.addTask(createTask({ baseBranch: "main", baseCommitSha: "taskbase456" }));

    mockExecSync.mockImplementation((command) => {
      const cmd = String(command);
      if (cmd === "git merge-base --is-ancestor taskbase456 HEAD") {
        return "" as any;
      }
      // Same file in both committed and working-tree
      if (cmd === "git diff --name-status taskbase456..HEAD") {
        return "M\tsrc/shared.ts\n" as any;
      }
      if (cmd === "git diff --name-status") {
        return "M\tsrc/shared.ts\n" as any;
      }
      if (cmd === 'git diff taskbase456..HEAD -- "src/shared.ts"') {
        return "diff --git a/src/shared.ts b/src/shared.ts\n+shared\n" as any;
      }
      throw new Error(`Unexpected command: ${cmd}`);
    });

    const response = await requestFileDiffs(store);

    expect(response.status).toBe(200);
    // Should deduplicate — only one entry for src/shared.ts
    expect(response.body).toHaveLength(1);
    expect(response.body[0].path).toBe("src/shared.ts");
  });

  it("returns empty array when no base ref and no working-tree changes", async () => {
    const store = new MockStore();
    store.addTask(createTask({ baseBranch: "main" }));

    mockExecSync.mockImplementation((command) => {
      const cmd = String(command);
      if (cmd === "git merge-base HEAD origin/main 2>/dev/null || git merge-base HEAD main") {
        throw new Error("no merge base");
      }
      if (cmd === "git rev-parse HEAD~1") {
        throw new Error("no parent");
      }
      if (cmd === "git diff --name-status") {
        return "" as any;
      }
      throw new Error(`Unexpected command: ${cmd}`);
    });

    const response = await requestFileDiffs(store);

    expect(response.status).toBe(200);
    expect(response.body).toEqual([]);
  });

  it("uses the 10-second cache before recomputing", async () => {
    const store = new MockStore();
    store.addTask(createTask({ baseBranch: "main", baseCommitSha: "taskbase456" }));

    let callCount = 0;
    mockExecSync.mockImplementation((command) => {
      callCount++;
      const cmd = String(command);
      if (cmd === "git merge-base --is-ancestor taskbase456 HEAD") {
        return "" as any;
      }
      if (cmd === "git diff --name-status taskbase456..HEAD") {
        return "M\tsrc/cached.ts\n" as any;
      }
      if (cmd === "git diff --name-status") {
        return "" as any;
      }
      if (cmd === 'git diff taskbase456..HEAD -- "src/cached.ts"') {
        return "diff --git a/src/cached.ts b/src/cached.ts\n+cached\n" as any;
      }
      throw new Error(`Unexpected command: ${cmd}`);
    });

    const handler = await getFileDiffsHandler(store);

    const first = await requestFileDiffsWithHandler(handler);
    expect(first.status).toBe(200);
    expect(first.body).toHaveLength(1);
    expect(first.body[0].path).toBe("src/cached.ts");

    const callsAfterFirst = callCount;

    // Second request within cache window should return cached data
    const second = await requestFileDiffsWithHandler(handler);
    expect(second.body).toEqual(first.body);
    // No additional execSync calls — served from cache
    expect(callCount).toBe(callsAfterFirst);

    // Advance past cache TTL
    vi.advanceTimersByTime(10001);
    const third = await requestFileDiffsWithHandler(handler);
    expect(third.body).toHaveLength(1);
    // Should have made fresh git calls
    expect(callCount).toBeGreaterThan(callsAfterFirst);
  });

  it("agrees with session-files on file list for the same task worktree", async () => {
    const store = new MockStore();
    store.addTask(createTask({ baseBranch: "main", id: "KB-AGREE" }));

    // Both routes use the same merge-base resolution strategy.
    // Set up mocks that exercise the shared merge-base + HEAD~1 fallback path.
    const mergeBaseCmd = "git merge-base HEAD origin/main 2>/dev/null || git merge-base HEAD main";
    const committedDiffNameOnly = "git diff --name-only mergebase456..HEAD";
    const committedDiffNameStatus = "git diff --name-status mergebase456..HEAD";
    const workingTreeNameOnly = "git diff --name-only";
    const workingTreeNameStatus = "git diff --name-status";

    mockExecSync.mockImplementation((command) => {
      const cmd = String(command);
      if (cmd === mergeBaseCmd) {
        return "mergebase456\n" as any;
      }
      // session-files uses --name-only
      if (cmd === committedDiffNameOnly) {
        return "src/a.ts\nsrc/b.ts\n" as any;
      }
      if (cmd === workingTreeNameOnly) {
        return "src/c.ts\n" as any;
      }
      // file-diffs uses --name-status
      if (cmd === committedDiffNameStatus) {
        return "M\tsrc/a.ts\nA\tsrc/b.ts\n" as any;
      }
      if (cmd === workingTreeNameStatus) {
        return "M\tsrc/c.ts\n" as any;
      }
      // Per-file diffs for file-diffs
      if (cmd.includes('git diff mergebase456..HEAD -- "src/a.ts"')) {
        return "diff a" as any;
      }
      if (cmd.includes('git diff mergebase456..HEAD -- "src/b.ts"')) {
        return "diff b" as any;
      }
      if (cmd.includes('git diff mergebase456..HEAD -- "src/c.ts"')) {
        return "diff c" as any;
      }
      throw new Error(`Unexpected command: ${cmd}`);
    });

    // Request session-files (card count)
    const sessionHandler = await import("../routes.js").then(({ createApiRoutes }) => {
      const router = createApiRoutes(store as any);
      const layer = (router as any).stack.find(
        (candidate: any) =>
          candidate.route?.path === "/tasks/:id/session-files" &&
          candidate.route?.methods?.get,
      );
      return layer.route.stack[layer.route.stack.length - 1].handle as (req: any, res: any) => Promise<void>;
    });

    const sessionReq = { params: { id: "KB-AGREE" } };
    const sessionRes = createMockResponse();
    await sessionHandler(sessionReq, sessionRes);

    expect(sessionRes.statusCode).toBe(200);
    const sessionFiles: string[] = sessionRes.body as string[];
    expect(sessionFiles).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);

    // Request file-diffs (modal viewer)
    const diffsHandler = await getFileDiffsHandler(store);
    const diffsRes = await requestFileDiffsWithHandler(diffsHandler, "KB-AGREE");

    expect(diffsRes.status).toBe(200);
    const diffFiles = diffsRes.body as Array<{ path: string }>;
    const diffPaths = diffFiles.map((f) => f.path);

    // Both endpoints must report the same set of files
    expect(diffPaths.sort()).toEqual(sessionFiles.sort());
  });

  // ── Done task file-diffs: first-parent computation ─────────────────────────────

  it("returns done-task file diffs from sha^..sha", async () => {
    const store = new MockStore();
    store.addTask(createTask({
      column: "done",
      mergeDetails: { commitSha: "done_merge_sha" },
      baseCommitSha: "ignored_base",
      worktree: undefined,
    }));

    mockExecSync.mockImplementation((command) => {
      const cmd = String(command);
      if (cmd === "git rev-parse done_merge_sha^") {
        return "done_parent\n" as any;
      }
      if (cmd === "git diff --name-status done_parent..done_merge_sha") {
        return "A\tsrc/done.ts\n" as any;
      }
      if (cmd === 'git diff done_parent..done_merge_sha -- "src/done.ts"') {
        return "diff --git a/src/done.ts b/src/done.ts\n+done\n" as any;
      }
      if (cmd.includes("git merge-base --is-ancestor")) {
        throw new Error("Done-task file-diffs must ignore baseCommitSha");
      }
      throw new Error(`Unexpected command: ${cmd}`);
    });

    const response = await requestFileDiffs(store);

    expect(response.status).toBe(200);
    expect(response.body).toEqual([
      {
        path: "src/done.ts",
        status: "added",
        diff: "diff --git a/src/done.ts b/src/done.ts\n+done\n",
      },
    ]);
    expect(mockExecSync).toHaveBeenCalledWith(
      "git rev-parse done_merge_sha^",
      expect.any(Object),
    );
  });

  it("ignores done-task baseCommitSha even when valid ancestor", async () => {
    const store = new MockStore();
    store.addTask(createTask({
      column: "done",
      mergeDetails: { commitSha: "task_a_merge" },
      baseCommitSha: "very_old_base",
      worktree: undefined,
    }));

    mockExecSync.mockImplementation((command) => {
      const cmd = String(command);
      // Task B was merged between Task A start and Task A merge.
      // sha^ keeps only Task A file and prevents a cross-task leak.
      if (cmd === "git rev-parse task_a_merge^") {
        return "task_a_parent\n" as any;
      }
      if (cmd === "git diff --name-status task_a_parent..task_a_merge") {
        return "A\ttask-a.ts\n" as any;
      }
      if (cmd === 'git diff task_a_parent..task_a_merge -- "task-a.ts"') {
        return "diff --git a/task-a.ts b/task-a.ts\n+task A\n" as any;
      }
      if (cmd.includes("git merge-base --is-ancestor")) {
        throw new Error("Done-task file-diffs must not validate baseCommitSha");
      }
      throw new Error(`Unexpected command: ${cmd}`);
    });

    const response = await requestFileDiffs(store);

    expect(response.status).toBe(200);
    expect(response.body).toHaveLength(1);
    expect(response.body[0].path).toBe("task-a.ts");
    expect(response.body.map((file: any) => file.path)).not.toContain("task-b.ts");
    expect(mockExecSync).not.toHaveBeenCalledWith(
      expect.stringContaining("git merge-base --is-ancestor"),
      expect.any(Object),
    );
  });

  it("returns empty array for done task without commitSha", async () => {
    const store = new MockStore();
    store.addTask(createTask({
      column: "done",
      mergeDetails: undefined,
      worktree: undefined,
    }));

    const response = await requestFileDiffs(store);

    expect(response.status).toBe(200);
    expect(response.body).toEqual([]);
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it("returns empty array when done-task sha^ cannot be resolved", async () => {
    const store = new MockStore();
    store.addTask(createTask({
      column: "done",
      mergeDetails: { commitSha: "broken_merge_sha" },
      worktree: undefined,
    }));

    mockExecSync.mockImplementation((command) => {
      const cmd = String(command);
      if (cmd === "git rev-parse broken_merge_sha^") {
        throw new Error("unknown revision");
      }
      throw new Error(`Unexpected command: ${cmd}`);
    });

    const response = await requestFileDiffs(store);

    expect(response.status).toBe(200);
    expect(response.body).toEqual([]);
  });

  // ── Regression: shared/recycled worktree produces broader file sets ─────────────────

  it("task-scoped baseCommitSha narrows file-diffs to this task's work", async () => {
    const store = new MockStore();
    // Scenario: previous task left commits A, B, C. Current task started after and added D, E.
    // baseCommitSha = commit C (the commit where the current task started).
    // merge-base would return commit A (oldest common ancestor), which would be broader.
    // With task-scoped diffing using baseCommitSha=C, we should only see D, E.
    store.addTask(createTask({
      id: "FN-REGDIFF",
      baseCommitSha: "commitC",
      worktree: "/tmp/worktree",
    }));

    mockExecSync.mockImplementation((command) => {
      const cmd = String(command);
      // baseCommitSha is valid — ancestor check passes
      if (cmd === "git merge-base --is-ancestor commitC HEAD") {
        return "" as any;
      }
      // Task-scoped diff shows only D, E
      if (cmd === "git diff --name-status commitC..HEAD") {
        return "M\tsrc/d.ts\nA\tsrc/e.ts\n" as any;
      }
      // No working tree changes
      if (cmd === "git diff --name-status") {
        return "" as any;
      }
      // Per-file diffs
      if (cmd === 'git diff commitC..HEAD -- "src/d.ts"') {
        return "diff d" as any;
      }
      if (cmd === 'git diff commitC..HEAD -- "src/e.ts"') {
        return "diff e" as any;
      }
      throw new Error(`Unexpected command: ${cmd}`);
    });

    const response = await requestFileDiffs(store, "FN-REGDIFF");

    expect(response.status).toBe(200);
    // Task-scoped: should only show files D and E, not A, B, C
    const paths = response.body.map((f: any) => f.path);
    expect(paths.sort()).toEqual(["src/d.ts", "src/e.ts"]);
  });

  it("filters out files with empty diffs (mode-only changes, binary files)", async () => {
    const store = new MockStore();
    store.addTask(createTask({ baseBranch: "main", baseCommitSha: "taskbase456" }));

    mockExecSync.mockImplementation((command) => {
      const cmd = String(command);
      if (cmd === "git merge-base --is-ancestor taskbase456 HEAD") {
        return "" as any;
      }
      // git reports the file as modified
      if (cmd === "git diff --name-status taskbase456..HEAD") {
        return "M\tsrc/mode-only.txt\n" as any;
      }
      if (cmd === "git diff --name-status") {
        return "" as any;
      }
      // but the diff is empty (mode-only change)
      if (cmd === 'git diff taskbase456..HEAD -- "src/mode-only.txt"') {
        return "" as any;
      }
      throw new Error(`Unexpected command: ${cmd}`);
    });

    const response = await requestFileDiffs(store);

    expect(response.status).toBe(200);
    // File should be filtered out because diff is empty
    expect(response.body).toHaveLength(0);
  });

  it("agrees with session-files under task-scoped base resolution", async () => {
    const store = new MockStore();
    // Both routes should produce the same file list when baseCommitSha is valid
    store.addTask(createTask({
      baseBranch: "main",
      id: "KB-AGREE-SCOPED",
      baseCommitSha: "scopedbase789",
      worktree: "/tmp/kb-agree-scoped",
    }));

    mockExecSync.mockImplementation((command) => {
      const cmd = String(command);
      // Task-scoped ancestor check
      if (cmd === "git merge-base --is-ancestor scopedbase789 HEAD") {
        return "" as any;
      }
      // session-files uses --name-only
      if (cmd === "git diff --name-only scopedbase789..HEAD") {
        return "src/x.ts\nsrc/y.ts\n" as any;
      }
      if (cmd === "git diff --name-only") {
        return "src/z.ts\n" as any;
      }
      // file-diffs uses --name-status
      if (cmd === "git diff --name-status scopedbase789..HEAD") {
        return "M\tsrc/x.ts\nA\tsrc/y.ts\n" as any;
      }
      if (cmd === "git diff --name-status") {
        return "M\tsrc/z.ts\n" as any;
      }
      // Per-file diffs for file-diffs
      if (cmd.includes('git diff scopedbase789..HEAD -- "src/x.ts"')) {
        return "diff x" as any;
      }
      if (cmd.includes('git diff scopedbase789..HEAD -- "src/y.ts"')) {
        return "diff y" as any;
      }
      if (cmd.includes('git diff scopedbase789..HEAD -- "src/z.ts"')) {
        return "diff z" as any;
      }
      throw new Error(`Unexpected command: ${cmd}`);
    });

    // Request session-files (card count)
    const sessionHandler = await import("../routes.js").then(({ createApiRoutes }) => {
      const router = createApiRoutes(store as any);
      const layer = (router as any).stack.find(
        (candidate: any) =>
          candidate.route?.path === "/tasks/:id/session-files" &&
          candidate.route?.methods?.get,
      );
      return layer.route.stack[layer.route.stack.length - 1].handle as (req: any, res: any) => Promise<void>;
    });

    const sessionReq = { params: { id: "KB-AGREE-SCOPED" } };
    const sessionRes = createMockResponse();
    await sessionHandler(sessionReq, sessionRes);

    expect(sessionRes.statusCode).toBe(200);
    const sessionFiles: string[] = sessionRes.body as string[];
    expect(sessionFiles).toEqual(["src/x.ts", "src/y.ts", "src/z.ts"]);

    // Request file-diffs (modal viewer)
    const diffsHandler = await getFileDiffsHandler(store);
    const diffsRes = await requestFileDiffsWithHandler(diffsHandler, "KB-AGREE-SCOPED");

    expect(diffsRes.status).toBe(200);
    const diffFiles = diffsRes.body as Array<{ path: string }>;
    const diffPaths = diffFiles.map((f) => f.path);

    // Both endpoints must report the same set of files under task-scoped base
    expect(diffPaths.sort()).toEqual(sessionFiles.sort());
  });
});
