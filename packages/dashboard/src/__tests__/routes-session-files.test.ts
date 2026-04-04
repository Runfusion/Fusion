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
    id: "FN-675",
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
    worktree: "/tmp/fn-675",
    ...overrides,
  };
}

async function getSessionFilesHandler(store: MockStore) {
  vi.resetModules();
  const { createApiRoutes } = await import("../routes.js");
  const router = createApiRoutes(store as any);
  const layer = (router as any).stack.find(
    (candidate: any) =>
      candidate.route?.path === "/tasks/:id/session-files" &&
      candidate.route?.methods?.get,
  );

  if (!layer) {
    throw new Error("GET /tasks/:id/session-files route not found");
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

async function requestSessionFiles(store: MockStore, taskId = "FN-675"): Promise<{ status: number; body: any }> {
  const handler = await getSessionFilesHandler(store);
  return requestSessionFilesWithHandler(handler, taskId);
}

async function requestSessionFilesWithHandler(
  handler: (req: any, res: any) => Promise<void>,
  taskId = "FN-675",
): Promise<{ status: number; body: any }> {
  const req = { params: { id: taskId } };
  const res = createMockResponse();
  await handler(req, res);
  return { status: res.statusCode, body: res.body };
}

describe("GET /api/tasks/:id/session-files", () => {
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

  it("uses merge-base against the task base branch and includes working-tree changes", async () => {
    const store = new MockStore();
    store.addTask(createTask({ id: "FN-675-base", baseCommitSha: "abc123" }));
    mockExecSync.mockImplementation((command) => {
      if (String(command) === "git merge-base HEAD origin/main 2>/dev/null || git merge-base HEAD main") {
        return "mergebase123\n" as any;
      }
      if (String(command) === "git diff --name-only mergebase123..HEAD") {
        return "src/a.ts\n" as any;
      }
      if (String(command) === "git diff --name-only") {
        return "src/b.ts\n" as any;
      }
      throw new Error(`Unexpected command: ${String(command)}`);
    });

    const response = await requestSessionFiles(store, "FN-675-base");

    expect(response.status).toBe(200);
    expect(response.body).toEqual(["src/a.ts", "src/b.ts"]);
    expect(mockExecSync).toHaveBeenNthCalledWith(
      1,
      "git merge-base HEAD origin/main 2>/dev/null || git merge-base HEAD main",
      expect.objectContaining({ cwd: "/tmp/fn-675" }),
    );
    expect(mockExecSync).toHaveBeenNthCalledWith(
      2,
      "git diff --name-only mergebase123..HEAD",
      expect.objectContaining({ cwd: "/tmp/fn-675" }),
    );
    expect(mockExecSync).toHaveBeenNthCalledWith(
      3,
      "git diff --name-only",
      expect.objectContaining({ cwd: "/tmp/fn-675" }),
    );
  });

  it("ignores stale baseCommitSha values and uses current branch merge-base", async () => {
    const store = new MockStore();
    store.addTask(createTask({ id: "FN-675-stale-base", baseCommitSha: "stale123" }));
    mockExecSync.mockImplementation((command) => {
      if (String(command) === "git merge-base HEAD origin/main 2>/dev/null || git merge-base HEAD main") {
        return "mergebase123\n" as any;
      }
      if (String(command) === "git diff --name-only mergebase123..HEAD") {
        return "packages/engine/src/executor.ts\n" as any;
      }
      if (String(command) === "git diff --name-only") {
        return "" as any;
      }
      throw new Error(`Unexpected command: ${String(command)}`);
    });

    const response = await requestSessionFiles(store, "FN-675-stale-base");

    expect(response.status).toBe(200);
    expect(response.body).toEqual(["packages/engine/src/executor.ts"]);
    expect(mockExecSync).toHaveBeenNthCalledWith(
      1,
      "git merge-base HEAD origin/main 2>/dev/null || git merge-base HEAD main",
      expect.objectContaining({ cwd: "/tmp/fn-675" }),
    );
    expect(mockExecSync).toHaveBeenNthCalledWith(
      2,
      "git diff --name-only mergebase123..HEAD",
      expect.objectContaining({ cwd: "/tmp/fn-675" }),
    );
    expect(mockExecSync).toHaveBeenNthCalledWith(
      3,
      "git diff --name-only",
      expect.objectContaining({ cwd: "/tmp/fn-675" }),
    );
  });

  it("computes fallback base ref with merge-base and returns matching file list", async () => {
    const store = new MockStore();
    store.addTask(createTask({ id: "FN-675-merge-base", baseCommitSha: undefined }));
    mockExecSync.mockImplementation((command) => {
      if (String(command) === "git merge-base HEAD origin/main 2>/dev/null || git merge-base HEAD main") {
        return "mergebase123\n" as any;
      }
      if (String(command) === "git diff --name-only mergebase123..HEAD") {
        return "packages/dashboard/src/routes.ts\npackages/dashboard/app/components/TaskCard.tsx\n" as any;
      }
      if (String(command) === "git diff --name-only") {
        return "" as any;
      }
      throw new Error(`Unexpected command: ${String(command)}`);
    });

    const response = await requestSessionFiles(store, "FN-675-merge-base");

    expect(response.status).toBe(200);
    expect(response.body).toEqual([
      "packages/dashboard/src/routes.ts",
      "packages/dashboard/app/components/TaskCard.tsx",
    ]);
    expect(mockExecSync).toHaveBeenNthCalledWith(
      1,
      "git merge-base HEAD origin/main 2>/dev/null || git merge-base HEAD main",
      expect.objectContaining({ cwd: "/tmp/fn-675" }),
    );
    expect(mockExecSync).toHaveBeenNthCalledWith(
      2,
      "git diff --name-only mergebase123..HEAD",
      expect.objectContaining({ cwd: "/tmp/fn-675" }),
    );
    expect(mockExecSync).toHaveBeenNthCalledWith(
      3,
      "git diff --name-only",
      expect.objectContaining({ cwd: "/tmp/fn-675" }),
    );
  });

  it("falls back to HEAD~1 when merge-base fails", async () => {
    const store = new MockStore();
    store.addTask(createTask({ id: "FN-675-head-parent", baseCommitSha: undefined }));
    mockExecSync.mockImplementation((command) => {
      if (String(command) === "git merge-base HEAD origin/main 2>/dev/null || git merge-base HEAD main") {
        throw new Error("merge-base failed");
      }
      if (String(command) === "git rev-parse HEAD~1") {
        return "parent123\n" as any;
      }
      if (String(command) === "git diff --name-only parent123..HEAD") {
        return "src/only.ts\n" as any;
      }
      if (String(command) === "git diff --name-only") {
        return "" as any;
      }
      throw new Error(`Unexpected command: ${String(command)}`);
    });

    const response = await requestSessionFiles(store, "FN-675-head-parent");

    expect(response.status).toBe(200);
    expect(response.body).toEqual(["src/only.ts"]);
  });

  it("returns empty array when worktree is missing", async () => {
    const store = new MockStore();
    store.addTask(createTask({ id: "FN-675-missing", worktree: undefined }));

    const response = await requestSessionFiles(store, "FN-675-missing");

    expect(response.status).toBe(200);
    expect(response.body).toEqual([]);
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it("returns empty array when there are no committed or working-tree changes", async () => {
    const store = new MockStore();
    store.addTask(createTask({ id: "FN-675-empty", baseCommitSha: undefined }));
    mockExecSync.mockImplementation((command) => {
      if (String(command) === "git merge-base HEAD origin/main 2>/dev/null || git merge-base HEAD main") {
        return "mergebase123\n" as any;
      }
      if (String(command) === "git diff --name-only mergebase123..HEAD") {
        return "" as any;
      }
      if (String(command) === "git diff --name-only") {
        return "" as any;
      }
      throw new Error(`Unexpected command: ${String(command)}`);
    });

    const response = await requestSessionFiles(store, "FN-675-empty");

    expect(response.status).toBe(200);
    expect(response.body).toEqual([]);
  });

  it("uses the 10-second cache before recomputing", async () => {
    const store = new MockStore();
    store.addTask(createTask({ id: "FN-675-cache", baseCommitSha: "cachebase" }));
    mockExecSync.mockImplementation((command) => {
      if (String(command) === "git merge-base HEAD origin/main 2>/dev/null || git merge-base HEAD main") {
        return "mergebase123\n" as any;
      }
      if (String(command) === "git diff --name-only mergebase123..HEAD") {
        return "cached/file.ts\n" as any;
      }
      if (String(command) === "git diff --name-only") {
        return "" as any;
      }
      throw new Error(`Unexpected command: ${String(command)}`);
    });
    const handler = await getSessionFilesHandler(store);

    const first = await requestSessionFilesWithHandler(handler, "FN-675-cache");
    const second = await requestSessionFilesWithHandler(handler, "FN-675-cache");

    expect(first.body).toEqual(["cached/file.ts"]);
    expect(second.body).toEqual(["cached/file.ts"]);
    expect(mockExecSync).toHaveBeenCalledTimes(3);

    vi.advanceTimersByTime(10001);
    const third = await requestSessionFilesWithHandler(handler, "FN-675-cache");

    expect(third.body).toEqual(["cached/file.ts"]);
    expect(mockExecSync).toHaveBeenCalledTimes(6);
  });
});
