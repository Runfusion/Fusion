// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Task, TaskStore } from "@fusion/core";
import { registerTaskMoveDisposer } from "@fusion/core";
import { getRegisteredWorktreeBranches } from "@fusion/engine";
import { createApiRoutes } from "../routes.js";
import { request as performRequest } from "../test-request.js";

vi.mock("@fusion/engine", async () => {
  const actual = await vi.importActual<typeof import("@fusion/engine")>("@fusion/engine");
  return {
    ...actual,
    removeWorktree: vi.fn(async (input: { worktreePath: string }) => {
      const { rm } = await import("node:fs/promises");
      await rm(input.worktreePath, { recursive: true, force: true });
      return { removed: true, classification: "removed" };
    }),
    pruneWorktreeAdminEntries: vi.fn().mockResolvedValue(undefined),
    getRegisteredWorktreeBranches: vi.fn().mockResolvedValue([]),
  };
});

const WORKFLOW_IR = {
  version: "v2",
  name: "Reset test workflow",
  columns: [
    { id: "triage", name: "Planning", traits: [{ trait: "intake" }] },
    { id: "hold", name: "Hold", traits: [{ trait: "hold" }] },
    { id: "in-progress", name: "In progress", traits: [{ trait: "wip" }] },
  ],
  nodes: [{ id: "start", kind: "start", column: "triage" }],
  edges: [],
};

function taskFixture(worktree: string): Task {
  return {
    id: "FN-400",
    title: "Reset fixture",
    description: "A populated task",
    column: "in-progress",
    status: "failed",
    dependencies: [],
    steps: [
      { name: "Implement", status: "done" },
      { name: "Verify", status: "in-progress" },
    ],
    currentStep: 1,
    worktree,
    branch: "fusion/fn-400",
    workflowIrPin: "stale-pin",
    workflowStepResults: [{ workflowStepId: "plan-review", status: "failed" }],
    reviewState: { status: "changes-requested" } as never,
    awaitingApprovalReason: "plan-review-replan-cap",
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as unknown as Task;
}

function createApp(store: TaskStore) {
  const app = express();
  app.use(express.json());
  app.use("/api", createApiRoutes(store));
  return app;
}

function createStore(
  root: string,
  task: Task,
  events: string[],
  publish: (this: TaskStore, id: string, intake: string) => Promise<Task>,
) {
  return {
    getRootDir: vi.fn().mockReturnValue(root),
    getSettings: vi.fn().mockResolvedValue({ worktreesDir: ".worktrees" }),
    getTask: vi.fn().mockResolvedValue(task),
    listTasks: vi.fn().mockResolvedValue([task]),
    withPlanningLifecycleLock: vi.fn(async (_id: string, fn: () => Promise<Task>) => await fn()),
    getTaskWorkflowSelectionAsync: vi.fn().mockResolvedValue({ workflowId: "wf-reset" }),
    getWorkflowDefinition: vi.fn().mockResolvedValue({ id: "wf-reset", name: "Reset", ir: WORKFLOW_IR }),
    resetTaskPublication: vi.fn(publish),
    logEntry: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    off: vi.fn(),
    getProjectScopedPluginMcpServers: vi.fn().mockResolvedValue([]),
    events,
  } as unknown as TaskStore;
}

describe("POST /tasks/:id/reset", () => {
  afterEach(() => vi.restoreAllMocks());

  it("preserves the TaskStore receiver while publishing the confirmed reset", async () => {
    const root = await mkdtemp(join(tmpdir(), "fusion-reset-route-"));
    const worktree = join(root, ".worktrees", "fn-400");
    const taskDir = join(root, ".fusion", "tasks", "FN-400");
    await mkdir(worktree, { recursive: true });
    await mkdir(taskDir, { recursive: true });
    await writeFile(join(taskDir, "PROMPT.md"), "# Existing plan\n");
    const events: string[] = [];
    const task = taskFixture(worktree);
    vi.mocked(getRegisteredWorktreeBranches).mockResolvedValue([{ branch: task.branch!, worktreePath: worktree }]);
    const reset = { ...task, column: "triage", status: "needs-replan", worktree: undefined, branch: undefined, steps: task.steps.map((step) => ({ ...step, status: "pending" as const })) };
    let store!: TaskStore;
    store = createStore(root, task, events, async function (this: TaskStore, id, intake) {
      void (this as unknown as { asyncLayer: unknown }).asyncLayer;
      expect(this).toBe(store);
      expect(id).toBe("FN-400");
      expect(intake).toBe("triage");
      events.push("published");
      return reset;
    });
    const unregister = registerTaskMoveDisposer(store, async () => {
      events.push("cancelled");
    });

    try {
      const res = await performRequest(createApp(store), "POST", "/api/tasks/FN-400/reset", JSON.stringify({ confirm: true }), { "content-type": "application/json" });
      expect(res.status).toBe(200);
      expect(vi.mocked(store.resetTaskPublication)).toHaveBeenCalledWith("FN-400", "triage");
      expect(vi.mocked(store.resetTaskPublication).mock.contexts).toEqual([store]);
      expect(events).toEqual(["cancelled", "published"]);
      await expect(readFile(join(taskDir, "PROMPT.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(worktree, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      expect(res.body).toMatchObject({ id: "FN-400", column: "triage", status: "needs-replan" });
      expect(res.body.steps.every((step: { status: string }) => step.status === "pending")).toBe(true);
    } finally {
      unregister();
    }
  });

  it("keeps durable state non-replannable when prompt removal fails after worktree cleanup", async () => {
    const root = await mkdtemp(join(tmpdir(), "fusion-reset-route-failure-"));
    const worktree = join(root, ".worktrees", "fn-400");
    const taskDir = join(root, ".fusion", "tasks", "FN-400");
    await mkdir(worktree, { recursive: true });
    await mkdir(taskDir, { recursive: true });
    await mkdir(join(taskDir, "PROMPT.md"));
    const task = taskFixture(worktree);
    vi.mocked(getRegisteredWorktreeBranches).mockResolvedValue([{ branch: task.branch!, worktreePath: worktree }]);
    const publication = vi.fn().mockResolvedValue({ ...task, column: "triage", status: "needs-replan" });
    const store = createStore(root, task, [], publication);
    const res = await performRequest(createApp(store), "POST", "/api/tasks/FN-400/reset", JSON.stringify({ confirm: true }), { "content-type": "application/json" });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/partial cleanup; retry Reset/i);
    expect(publication).not.toHaveBeenCalled();
    await expect(readFile(join(taskDir, "PROMPT.md"), "utf8")).rejects.toMatchObject({ code: "EISDIR" });
    expect(store.updateTask).toBeUndefined();
  });

  it("rejects a registered foreign checkout before cancellation or deletion", async () => {
    const root = await mkdtemp(join(tmpdir(), "fusion-reset-route-foreign-"));
    const worktree = join(root, ".worktrees", "operator-checkout");
    const taskDir = join(root, ".fusion", "tasks", "FN-400");
    await mkdir(worktree, { recursive: true });
    await mkdir(taskDir, { recursive: true });
    await writeFile(join(taskDir, "PROMPT.md"), "# Keep this plan\n");
    const task = taskFixture(worktree);
    vi.mocked(getRegisteredWorktreeBranches).mockResolvedValue([{ branch: "operator/checkout", worktreePath: worktree }]);
    const events: string[] = [];
    const publication = vi.fn().mockResolvedValue({ ...task, column: "triage", status: "needs-replan" });
    const store = createStore(root, task, events, publication);
    const unregister = registerTaskMoveDisposer(store, async () => {
      events.push("cancelled");
    });

    try {
      const res = await performRequest(createApp(store), "POST", "/api/tasks/FN-400/reset", JSON.stringify({ confirm: true }), { "content-type": "application/json" });
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/ownership cannot be proven/i);
      expect(events).toEqual([]);
      expect(publication).not.toHaveBeenCalled();
      await expect(readFile(join(taskDir, "PROMPT.md"), "utf8")).resolves.toBe("# Keep this plan\n");
      expect((await stat(worktree)).isDirectory()).toBe(true);
    } finally {
      unregister();
    }
  });
});
