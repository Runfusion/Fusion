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

  getMissionStore() {
    return {
      listMissions: vi.fn().mockResolvedValue([]),
      createMission: vi.fn(),
      getMission: vi.fn(),
      updateMission: vi.fn(),
      deleteMission: vi.fn(),
      listTemplates: vi.fn().mockResolvedValue([]),
      createTemplate: vi.fn(),
      getTemplate: vi.fn(),
      updateTemplate: vi.fn(),
      deleteTemplate: vi.fn(),
      instantiateMission: vi.fn(),
    };
  }

  async listTasks(): Promise<Task[]> {
    return Array.from(this.tasks.values());
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

async function requestFileDiffs(port: number, taskId = "KB-651"): Promise<{ status: number; body: any }> {
  return await new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: `/api/tasks/${taskId}/file-diffs`,
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

describe("GET /api/tasks/:id/file-diffs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockImplementation((path) => path === "/tmp/kb-651");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-01T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("returns changed files with per-file diffs and supports rename metadata", async () => {
    const store = new MockStore();
    store.addTask(createTask({ baseBranch: "main" }));

    mockExecSync.mockImplementation((command) => {
      const cmd = String(command);
      if (cmd === "git diff --name-status main...HEAD") {
        return "M\tsrc/updated.ts\nA\tsrc/added.ts\nD\tsrc/deleted.ts\nR100\tsrc/old-name.ts\tsrc/new-name.ts\n" as any;
      }
      if (cmd === "git diff main...HEAD -- \"src/updated.ts\"") {
        return "diff --git a/src/updated.ts b/src/updated.ts\n--- a/src/updated.ts\n+++ b/src/updated.ts\n+hello\n" as any;
      }
      if (cmd === "git diff main...HEAD -- \"src/added.ts\"") {
        return "diff --git a/src/added.ts b/src/added.ts\nnew file mode 100644\n+++ b/src/added.ts\n+added\n" as any;
      }
      if (cmd === "git diff main...HEAD -- \"src/deleted.ts\"") {
        return "diff --git a/src/deleted.ts b/src/deleted.ts\n--- a/src/deleted.ts\n+++ /dev/null\n-deleted\n" as any;
      }
      if (cmd === "git diff main...HEAD -- \"src/new-name.ts\"") {
        return "diff --git a/src/old-name.ts b/src/new-name.ts\nsimilarity index 100%\nrename from src/old-name.ts\nrename to src/new-name.ts\n" as any;
      }
      throw new Error(`Unexpected command: ${cmd}`);
    });

    const app = createServer(store as any);
    const server = app.listen(0);
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;

    const response = await requestFileDiffs(port);

    expect(response.status).toBe(200);
    expect(mockExecSync.mock.calls.map(([cmd]) => String(cmd))).toEqual([
      "git diff --name-status main...HEAD",
      'git diff main...HEAD -- "src/updated.ts"',
      'git diff main...HEAD -- "src/added.ts"',
      'git diff main...HEAD -- "src/deleted.ts"',
      'git diff main...HEAD -- "src/new-name.ts"',
    ]);
    expect(response.body).toEqual([
      { path: "src/updated.ts", status: "modified", diff: expect.stringContaining("+hello") },
      { path: "src/added.ts", status: "added", diff: expect.stringContaining("+added") },
      { path: "src/deleted.ts", status: "deleted", diff: expect.stringContaining("-deleted") },
      {
        path: "src/new-name.ts",
        status: "renamed",
        oldPath: "src/old-name.ts",
        diff: expect.stringContaining("rename from src/old-name.ts"),
      },
    ]);

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

    const response = await requestFileDiffs(port);

    expect(response.status).toBe(200);
    expect(response.body).toEqual([]);
    expect(mockExecSync).not.toHaveBeenCalled();

    server.close();
    await once(server, "close");
  });

  it("falls back to HEAD diff when base branch diff fails", async () => {
    const store = new MockStore();
    store.addTask(createTask({ baseBranch: "main" }));

    mockExecSync.mockImplementation((command) => {
      const cmd = String(command);
      if (cmd === "git diff --name-status main...HEAD") {
        throw new Error("bad base branch");
      }
      if (cmd === "git diff --name-status HEAD") {
        return "M\tsrc/local.ts\n" as any;
      }
      if (cmd === "git diff HEAD -- \"src/local.ts\"") {
        return "diff --git a/src/local.ts b/src/local.ts\n+local\n" as any;
      }
      throw new Error(`Unexpected command: ${cmd}`);
    });

    const app = createServer(store as any);
    const server = app.listen(0);
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;

    const response = await requestFileDiffs(port);

    expect(response.status).toBe(200);
    expect(mockExecSync.mock.calls.map(([cmd]) => String(cmd))).toEqual([
      "git diff --name-status main...HEAD",
      "git diff --name-status HEAD",
      'git diff HEAD -- "src/local.ts"',
    ]);
    expect(response.body).toEqual([{ path: "src/local.ts", status: "modified", diff: expect.stringContaining("+local") }]);

    server.close();
    await once(server, "close");
  });

  it("uses the 10-second cache before recomputing", async () => {
    const store = new MockStore();
    store.addTask(createTask({ baseBranch: "main" }));

    mockExecSync.mockImplementation((command) => {
      const cmd = String(command);
      if (cmd === "git diff --name-status main...HEAD") {
        return "M\tsrc/cached.ts\n" as any;
      }
      if (cmd === "git diff main...HEAD -- \"src/cached.ts\"") {
        return "diff --git a/src/cached.ts b/src/cached.ts\n+cached\n" as any;
      }
      throw new Error(`Unexpected command: ${cmd}`);
    });

    const app = createServer(store as any);
    const server = app.listen(0);
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;

    const first = await requestFileDiffs(port);
    const second = await requestFileDiffs(port);

    expect(first.body).toEqual([{ path: "src/cached.ts", status: "modified", diff: expect.stringContaining("+cached") }]);
    expect(second.body).toEqual([{ path: "src/cached.ts", status: "modified", diff: expect.stringContaining("+cached") }]);
    expect(mockExecSync.mock.calls.map(([cmd]) => String(cmd))).toEqual([
      "git diff --name-status main...HEAD",
      'git diff main...HEAD -- "src/cached.ts"',
    ]);

    vi.advanceTimersByTime(10001);
    const third = await requestFileDiffs(port);

    expect(third.body).toEqual([{ path: "src/cached.ts", status: "modified", diff: expect.stringContaining("+cached") }]);
    expect(mockExecSync.mock.calls.map(([cmd]) => String(cmd))).toEqual([
      "git diff --name-status main...HEAD",
      'git diff main...HEAD -- "src/cached.ts"',
      "git diff --name-status main...HEAD",
      'git diff main...HEAD -- "src/cached.ts"',
    ]);

    server.close();
    await once(server, "close");
  });
});
