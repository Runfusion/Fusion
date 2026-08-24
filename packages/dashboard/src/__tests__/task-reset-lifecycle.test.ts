// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Task, TaskStore } from "@fusion/core";
import { registerTaskMoveDisposer, registerTaskResetDisposer } from "@fusion/core";
import { activeSessionRegistry, getRegisteredWorktreeBranches, registerPlanningLivenessProbe } from "@fusion/engine";
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
    removeTaskResetWorktree: vi.fn(async (input: Parameters<typeof actual.removeTaskResetWorktree>[0]) => await actual.removeTaskResetWorktree({
      ...input,
      remove: async ({ worktreePath }) => {
        const { rm } = await import("node:fs/promises");
        await rm(worktreePath, { recursive: true, force: true });
        return { removed: true, classification: "removed" };
      },
    })),
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

  it("resets a planning-owned worktree after the planner reset fence releases it", async () => {
    const root = await mkdtemp(join(tmpdir(), "fusion-reset-route-planning-"));
    const worktree = join(root, ".worktrees", "fn-400");
    const taskDir = join(root, ".fusion", "tasks", "FN-400");
    await mkdir(worktree, { recursive: true });
    await mkdir(taskDir, { recursive: true });
    await writeFile(join(taskDir, "PROMPT.md"), "# Discarded plan\n");
    const task = taskFixture(worktree);
    vi.mocked(getRegisteredWorktreeBranches).mockResolvedValue([{ branch: task.branch!, worktreePath: worktree }]);
    activeSessionRegistry.registerPath(worktree, { taskId: task.id, kind: "planning", ownerKey: `planning:${task.id}` });
    const publication = vi.fn().mockResolvedValue({ ...task, column: "triage", status: "needs-replan", worktree: undefined, branch: undefined });
    const store = createStore(root, task, [], publication);
    const unregister = registerTaskResetDisposer(store, async () => activeSessionRegistry.unregisterPath(worktree));
    try {
      const res = await performRequest(createApp(store), "POST", "/api/tasks/FN-400/reset", JSON.stringify({ confirm: true }), { "content-type": "application/json" });
      expect(res.status).toBe(200);
      expect(publication).toHaveBeenCalledOnce();
      expect(activeSessionRegistry.lookupByPath(worktree)).toBeNull();
      await expect(readFile(join(taskDir, "PROMPT.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(worktree)).rejects.toMatchObject({ code: "ENOENT" });
      expect(JSON.stringify(res.body)).not.toContain("cannot remove active-session worktree");
    } finally {
      unregister();
      activeSessionRegistry.unregisterPath(worktree);
    }
  });

  it("reconciles an aged orphaned planning registration when no disposer owns it", async () => {
    const root = await mkdtemp(join(tmpdir(), "fusion-reset-route-stale-planning-"));
    const worktree = join(root, ".worktrees", "fn-400");
    await mkdir(worktree, { recursive: true });
    await mkdir(join(root, ".fusion", "tasks", "FN-400"), { recursive: true });
    await writeFile(join(root, ".fusion", "tasks", "FN-400", "PROMPT.md"), "# Discarded plan\n");
    const task = taskFixture(worktree);
    vi.mocked(getRegisteredWorktreeBranches).mockResolvedValue([{ branch: task.branch!, worktreePath: worktree }]);
    activeSessionRegistry.registerPath(worktree, { taskId: task.id, kind: "planning", ownerKey: `planning:${task.id}` });
    (activeSessionRegistry.lookupByPath(worktree) as { registeredAt: number }).registeredAt = 0;
    const publication = vi.fn().mockResolvedValue({ ...task, column: "triage", status: "needs-replan", worktree: undefined, branch: undefined });
    const store = createStore(root, task, [], publication);
    try {
      const res = await performRequest(createApp(store), "POST", "/api/tasks/FN-400/reset", JSON.stringify({ confirm: true }), { "content-type": "application/json" });
      expect(res.status).toBe(200);
      expect(activeSessionRegistry.lookupByPath(worktree)).toBeNull();
      expect(publication).toHaveBeenCalledOnce();
    } finally {
      activeSessionRegistry.unregisterPath(worktree);
    }
  });

  it("reports a live planner as an actionable conflict without deleting its plan", async () => {
    const root = await mkdtemp(join(tmpdir(), "fusion-reset-route-live-planning-"));
    const worktree = join(root, ".worktrees", "fn-400");
    const promptPath = join(root, ".fusion", "tasks", "FN-400", "PROMPT.md");
    await mkdir(worktree, { recursive: true });
    await mkdir(join(root, ".fusion", "tasks", "FN-400"), { recursive: true });
    await writeFile(promptPath, "# Keep plan\n");
    const task = taskFixture(worktree);
    vi.mocked(getRegisteredWorktreeBranches).mockResolvedValue([{ branch: task.branch!, worktreePath: worktree }]);
    activeSessionRegistry.registerPath(worktree, { taskId: task.id, kind: "planning", ownerKey: `planning:${task.id}` });
    (activeSessionRegistry.lookupByPath(worktree) as { registeredAt: number }).registeredAt = 0;
    const unregisterProbe = registerPlanningLivenessProbe((id) => id === task.id);
    const publication = vi.fn();
    const store = createStore(root, task, [], publication);
    try {
      const res = await performRequest(createApp(store), "POST", "/api/tasks/FN-400/reset", JSON.stringify({ confirm: true }), { "content-type": "application/json" });
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/active task FN-400 \(planning\).*stop or finish/i);
      expect(publication).not.toHaveBeenCalled();
      await expect(readFile(promptPath, "utf8")).resolves.toBe("# Keep plan\n");
    } finally {
      unregisterProbe();
      activeSessionRegistry.unregisterPath(worktree);
    }
  });

  it("reports a foreign session holder as an actionable conflict", async () => {
    const root = await mkdtemp(join(tmpdir(), "fusion-reset-route-foreign-session-"));
    const worktree = join(root, ".worktrees", "fn-400");
    const promptPath = join(root, ".fusion", "tasks", "FN-400", "PROMPT.md");
    await mkdir(worktree, { recursive: true });
    await mkdir(join(root, ".fusion", "tasks", "FN-400"), { recursive: true });
    await writeFile(promptPath, "# Keep plan\n");
    const task = taskFixture(worktree);
    vi.mocked(getRegisteredWorktreeBranches).mockResolvedValue([{ branch: task.branch!, worktreePath: worktree }]);
    activeSessionRegistry.registerPath(worktree, { taskId: "FN-OTHER", kind: "planning", ownerKey: "planning:FN-OTHER" });
    const publication = vi.fn();
    const store = createStore(root, task, [], publication);
    try {
      const res = await performRequest(createApp(store), "POST", "/api/tasks/FN-400/reset", JSON.stringify({ confirm: true }), { "content-type": "application/json" });
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/active task FN-OTHER \(planning\).*stop or finish/i);
      expect(publication).not.toHaveBeenCalled();
      await expect(readFile(promptPath, "utf8")).resolves.toBe("# Keep plan\n");
    } finally {
      activeSessionRegistry.unregisterPath(worktree);
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
