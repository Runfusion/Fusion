import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { EventEmitter } from "node:events";
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Task } from "@fusion/core";

import { createApiRoutes } from "../routes.js";

class MockStore extends EventEmitter {
  private tasks = new Map<string, Task>();

  getRootDir(): string { return process.cwd(); }
  async getTask(id: string): Promise<Task> {
    const task = this.tasks.get(id);
    if (!task) throw Object.assign(new Error("Task not found"), { code: "ENOENT" });
    return task;
  }
  addTask(task: Task): void { this.tasks.set(task.id, task); }
  getMissionStore() { return new EventEmitter(); }
  async listTasks(): Promise<Task[]> { return []; }
  /*
  FNXC:PluginMcpServers 2026-07-24-02:05:
  FN-8491 (3cd023fa4) made resolveProjectContext bind a project-scoped plugin
  MCP provider on every getProjectContext call; a store exposing
  getProjectScopedPluginMcpServers is treated as runtime-owned and skips the
  binder (which would otherwise 500 on getPluginStore()).
  */
  getProjectScopedPluginMcpServers = vi.fn().mockResolvedValue([]);
}

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-675", title: "Test task", description: "Test description",
    column: "in-progress", dependencies: [], steps: [], currentStep: 0, log: [],
    createdAt: "2026-04-01T00:00:00.000Z", updatedAt: "2026-04-01T00:00:00.000Z",
    columnMovedAt: "2026-04-01T00:00:00.000Z", worktree: "/tmp/fn-675",
    ...overrides,
  };
}

describe("Session files endpoint", () => {
  let testWorktree: string;
  let firstCommit: string;

  beforeAll(() => {
    // Create a test git repository
    testWorktree = join(tmpdir(), `fn-test-${Date.now()}`);
    mkdirSync(testWorktree, { recursive: true });

    // Initialize git repo
    execSync("git init --initial-branch=main", { cwd: testWorktree });
    execSync("git config user.email test@test.com", { cwd: testWorktree });
    execSync("git config user.name Test", { cwd: testWorktree });

    // Create a commit
    writeFileSync(join(testWorktree, "test.txt"), "initial content");
    execSync("git add .", { cwd: testWorktree });
    execSync("git commit -m 'initial'", { cwd: testWorktree });

    // Get the first commit SHA
    firstCommit = execSync("git rev-parse HEAD", { cwd: testWorktree }).toString().trim();

    // Create a second commit with changes
    writeFileSync(join(testWorktree, "changed.txt"), "new content");
    execSync("git add .", { cwd: testWorktree });
    execSync("git commit -m 'second commit'", { cwd: testWorktree });

    console.log("Test worktree:", testWorktree);
    console.log("First commit:", firstCommit);
  });

  afterAll(() => {
    // Clean up
    try {
      rmSync(testWorktree, { recursive: true, force: true });
    } catch (e) {
      // Ignore cleanup errors
    }
  });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    vi.setSystemTime(new Date("2026-04-01T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("endpoint should return files from git using real baseCommitSha", async () => {
    const store = new MockStore();

    store.addTask(createTask({
      id: "FN-TEST", title: "Test", description: "Test",
      column: "in-progress", dependencies: [], steps: [], currentStep: 0, log: [],
      createdAt: "2026-04-01T00:00:00.000Z", updatedAt: "2026-04-01T00:00:00.000Z",
      columnMovedAt: "2026-04-01T00:00:00.000Z", worktree: testWorktree, baseCommitSha: firstCommit,
    }));

    const router = createApiRoutes(store);
    const layer = (router as any).stack.find(
      (c: any) => c.route?.path === "/tasks/:id/session-files" && c.route?.methods?.get,
    );

    const handler = layer.route.stack[layer.route.stack.length - 1].handle;

    const res: any = {
      statusCode: 200,
      body: undefined,
      status(code: number) { this.statusCode = code; return this; },
      json(payload: any) { this.body = payload; return this; }
    };

    await handler({ params: { id: "FN-TEST" } }, res);

    console.log("Response body:", res.body);

    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    // Should have changed.txt as a changed file
    expect(res.body).toContain("changed.txt");
  });
});
