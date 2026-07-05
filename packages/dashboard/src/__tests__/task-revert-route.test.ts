// @vitest-environment node

/*
FNXC:TaskRevert 2026-07-04-00:00:
API-level coverage for POST /tasks/:id/revert (FN-7523). The real git dry-run/
classify/apply behavior is proven in packages/engine/src/__tests__/task-revert.real-git.test.ts —
this suite stubs `performTaskRevert` at the route boundary and asserts:
  - the done/archived guard (4xx for other columns, before the engine service is even called);
  - the response contract shapes for clean / alreadyReverted / conflicting outcomes;
  - error mapping (TaskRevertError -> 409 for dirty-working-tree, 500 otherwise).
*/
import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import type { Task, TaskStore } from "@fusion/core";
import { createApiRoutes } from "../routes.js";
import { request as performRequest } from "../test-request.js";

// FNXC:TaskRevert 2026-07-04-00:00: the route now guards against `rootDir`
// (the shared user checkout) sitting on a branch other than the resolved
// base branch (see the branch-mismatch check in register-task-workflow-routes.ts).
// A real repo checked out on "main" (the integration-branch fallback with no
// `integrationBranch`/`baseBranch` setting) satisfies that guard for the
// success-path tests below.
function makeGitRepoOnMain(): string {
  const dir = mkdtempSync(join(tmpdir(), "kb-task-revert-route-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: dir });
  return dir;
}

const performTaskRevertMock = vi.fn();

vi.mock("@fusion/engine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@fusion/engine")>();
  return {
    ...actual,
    performTaskRevert: (...args: unknown[]) => performTaskRevertMock(...args),
  };
});

function makeTask(overrides: Partial<Task>): Task {
  return {
    id: "FN-100",
    lineageId: "FN-100",
    description: "revert me",
    column: "done",
    dependencies: [],
    steps: [],
    currentStep: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as Task;
}

function createMockStore(task: Task): TaskStore {
  return {
    getSettings: vi.fn().mockResolvedValue({}),
    getSettingsFast: vi.fn().mockResolvedValue({ autoMerge: true }),
    getRootDir: vi.fn().mockReturnValue(makeGitRepoOnMain()),
    getTask: vi.fn().mockResolvedValue(task),
    getTaskCommitAssociationsByLineageId: vi.fn().mockResolvedValue([]),
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as TaskStore;
}

function createApp(store: TaskStore) {
  const app = express();
  app.use(express.json());
  app.use("/api", createApiRoutes(store));
  return app;
}

async function REQUEST(app: express.Express, method: string, path: string) {
  return performRequest(app, method, path);
}

describe("POST /tasks/:id/revert", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns a clean revert result for a done task", async () => {
    const task = makeTask({ column: "done" });
    const store = createMockStore(task);
    performTaskRevertMock.mockResolvedValue({ mode: "git", clean: true, revertCommitSha: "abc123" });

    const res = await REQUEST(createApp(store), "POST", `/api/tasks/${task.id}/revert`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ mode: "git", clean: true, revertCommitSha: "abc123" });
    expect(performTaskRevertMock).toHaveBeenCalledTimes(1);
  });

  it("returns an alreadyReverted result without invoking a second commit", async () => {
    const task = makeTask({ column: "archived" });
    const store = createMockStore(task);
    performTaskRevertMock.mockResolvedValue({ mode: "git", clean: true, alreadyReverted: true });

    const res = await REQUEST(createApp(store), "POST", `/api/tasks/${task.id}/revert`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ mode: "git", clean: true, alreadyReverted: true });
  });

  it("returns a conflicting result without creating an AI-undo follow-up task", async () => {
    const task = makeTask({ column: "done" });
    const store = createMockStore(task);
    performTaskRevertMock.mockResolvedValue({
      mode: "git",
      clean: false,
      conflicts: [{ file: "foo.ts", status: "UU" }],
    });

    const res = await REQUEST(createApp(store), "POST", `/api/tasks/${task.id}/revert`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      mode: "git",
      clean: false,
      conflicts: [{ file: "foo.ts", status: "UU" }],
    });
  });

  it("rejects a non-done/archived task with a 4xx guard before invoking the engine service", async () => {
    const task = makeTask({ column: "in-progress" });
    const store = createMockStore(task);

    const res = await REQUEST(createApp(store), "POST", `/api/tasks/${task.id}/revert`);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(String((res.body as { error?: string }).error ?? "")).toMatch(/done\/archived/i);
    expect(performTaskRevertMock).not.toHaveBeenCalled();
  });

  it("returns 404 when the task does not exist", async () => {
    const store = createMockStore(makeTask({}));
    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    const res = await REQUEST(createApp(store), "POST", "/api/tasks/FN-999/revert");
    expect(res.status).toBe(404);
    expect(performTaskRevertMock).not.toHaveBeenCalled();
  });

  it("maps a dirty-working-tree TaskRevertError to 409", async () => {
    const task = makeTask({ column: "done" });
    const store = createMockStore(task);
    const { TaskRevertError } = await import("@fusion/engine");
    performTaskRevertMock.mockRejectedValue(new TaskRevertError("working tree is dirty", "dirty-working-tree"));

    const res = await REQUEST(createApp(store), "POST", `/api/tasks/${task.id}/revert`);
    expect(res.status).toBe(409);
  });

  it("maps an unexpected TaskRevertError to 500", async () => {
    const task = makeTask({ column: "done" });
    const store = createMockStore(task);
    const { TaskRevertError } = await import("@fusion/engine");
    performTaskRevertMock.mockRejectedValue(new TaskRevertError("git log failed", "git-log-failed"));

    const res = await REQUEST(createApp(store), "POST", `/api/tasks/${task.id}/revert`);
    expect(res.status).toBe(500);
  });

  it("rejects with a branch-mismatch 409 when rootDir is checked out on a different branch than the resolved base branch, without invoking the engine service", async () => {
    const task = makeTask({ column: "done" });
    const store = createMockStore(task);
    const rootDir = (store.getRootDir as () => string)();
    execFileSync("git", ["checkout", "-b", "some-other-branch"], { cwd: rootDir });

    const res = await REQUEST(createApp(store), "POST", `/api/tasks/${task.id}/revert`);
    expect(res.status).toBe(409);
    expect((res.body as { details?: { code?: string } }).details?.code ?? (res.body as { error?: string }).error).toBeTruthy();
    expect(performTaskRevertMock).not.toHaveBeenCalled();
  });
});
