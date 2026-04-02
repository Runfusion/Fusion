import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter, once } from "node:events";
import http from "node:http";
import type { Task } from "@fusion/core";
import { createServer } from "../server.js";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";

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

async function requestSessionFiles(port: number, taskId = "FN-675"): Promise<{ status: number; body: any }> {
  return await new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: `/api/tasks/${taskId}/session-files`,
        method: "GET",
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(data) }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("GET /api/tasks/:id/session-files", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-01T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("uses baseCommitSha with double-dot syntax when available", async () => {
    const store = new MockStore();
    store.addTask(createTask({ baseCommitSha: "abc123" }));
    mockExecSync.mockImplementation((command) => {
      if (String(command) === "git diff --name-only abc123..HEAD") {
        return "src/a.ts\nsrc/b.ts\n" as any;
      }
      throw new Error(`Unexpected command: ${String(command)}`);
    });

    const app = createServer(store as any);
    const server = app.listen(0);
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;

    const response = await requestSessionFiles(port);

    expect(response.status).toBe(200);
    expect(response.body).toEqual(["src/a.ts", "src/b.ts"]);
    expect(mockExecSync).toHaveBeenCalledWith("git diff --name-only abc123..HEAD", expect.objectContaining({ cwd: "/tmp/fn-675" }));
    expect(mockExecSync).not.toHaveBeenCalledWith(expect.stringContaining("...HEAD"), expect.anything());

    server.close();
    await once(server, "close");
  });

  it("computes fallback base ref with merge-base and returns matching file list", async () => {
    const store = new MockStore();
    store.addTask(createTask({ baseCommitSha: undefined }));
    mockExecSync.mockImplementation((command) => {
      if (String(command) === "git merge-base HEAD origin/main 2>/dev/null || git merge-base HEAD main") {
        return "mergebase123\n" as any;
      }
      if (String(command) === "git diff --name-only mergebase123..HEAD") {
        return "packages/dashboard/src/routes.ts\npackages/dashboard/app/components/TaskCard.tsx\n" as any;
      }
      throw new Error(`Unexpected command: ${String(command)}`);
    });

    const app = createServer(store as any);
    const server = app.listen(0);
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;

    const response = await requestSessionFiles(port);

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

    server.close();
    await once(server, "close");
  });

  it("falls back to HEAD~1 when merge-base fails", async () => {
    const store = new MockStore();
    store.addTask(createTask({ baseCommitSha: undefined }));
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
      throw new Error(`Unexpected command: ${String(command)}`);
    });

    const app = createServer(store as any);
    const server = app.listen(0);
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;

    const response = await requestSessionFiles(port);

    expect(response.status).toBe(200);
    expect(response.body).toEqual(["src/only.ts"]);

    server.close();
    await once(server, "close");
  });

  it("returns empty array when worktree is missing", async () => {
    const store = new MockStore();
    store.addTask(createTask({ worktree: undefined }));

    const app = createServer(store as any);
    const server = app.listen(0);
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;

    const response = await requestSessionFiles(port);

    expect(response.status).toBe(200);
    expect(response.body).toEqual([]);
    expect(mockExecSync).not.toHaveBeenCalled();

    server.close();
    await once(server, "close");
  });

  it("uses the 10-second cache before recomputing", async () => {
    const store = new MockStore();
    store.addTask(createTask({ baseCommitSha: "cachebase" }));
    mockExecSync.mockReturnValue("cached/file.ts\n" as any);

    const app = createServer(store as any);
    const server = app.listen(0);
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;

    const first = await requestSessionFiles(port);
    const second = await requestSessionFiles(port);

    expect(first.body).toEqual(["cached/file.ts"]);
    expect(second.body).toEqual(["cached/file.ts"]);
    expect(mockExecSync).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(10001);
    const third = await requestSessionFiles(port);

    expect(third.body).toEqual(["cached/file.ts"]);
    expect(mockExecSync).toHaveBeenCalledTimes(2);

    server.close();
    await once(server, "close");
  });
});
