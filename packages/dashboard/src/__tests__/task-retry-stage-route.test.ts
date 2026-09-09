// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  getTaskMergeBlocker,
  PRE_MERGE_STEPS_NOT_RUN_BLOCKER,
  registerTaskResetDisposer,
  RESTART_STAGE_FENCE_REASON,
  type Task,
  type TaskStore,
} from "@fusion/core";
import { createApiRoutes } from "../routes.js";
import { request as performRequest } from "../test-request.js";

const LEGACY_V1_IR = {
  version: "v1",
  name: "legacy retry route",
  nodes: [],
  edges: [],
} as never;

const RESTART_IR = {
  version: "v2",
  name: "restart-route",
  columns: [
    { id: "planning", name: "Planning", traits: [{ trait: "intake" }, { trait: "hold" }] },
    { id: "building", name: "Building", traits: [{ trait: "wip" }] },
    { id: "signoff", name: "Signoff", traits: [{ trait: "merge-blocker" }, { trait: "human-review" }] },
    { id: "done", name: "Done", traits: [{ trait: "complete" }] },
  ],
  nodes: [
    { id: "start", kind: "start" },
    { id: "plan", kind: "prompt", column: "planning" },
    { id: "implement", kind: "execute", column: "building" },
    { id: "code-review", kind: "prompt", column: "signoff" },
    { id: "post-review", kind: "prompt", column: "signoff", config: { phase: "post-merge" } },
  ],
  edges: [
    { from: "start", to: "plan" },
    { from: "plan", to: "implement" },
    { from: "implement", to: "code-review" },
    { from: "code-review", to: "post-review" },
  ],
} as never;

function taskFixture(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-204",
    title: "Restart fixture",
    description: "Restart the current stage",
    column: "planning",
    dependencies: [],
    steps: [],
    currentStep: 0,
    workflowStepResults: [],
    createdAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:00:00.000Z",
    ...overrides,
  } as Task;
}

function workspaceWorktreesFixture(): NonNullable<Task["workspaceWorktrees"]> {
  return {
    api: {
      worktreePath: "/workspace/api/.worktrees/fn-204",
      branch: "fusion/fn-204-api",
      baseCommitSha: "base-api",
      landedSha: "landed-api",
    },
    web: {
      worktreePath: "/workspace/web/.worktrees/fn-204",
      branch: "fusion/fn-204-web",
      baseCommitSha: "base-web",
      landFailure: {
        category: "content-conflict",
        message: "Repository could not be landed",
        at: "2026-08-28T00:00:00.000Z",
      },
    },
  };
}

function createApp(store: TaskStore) {
  const app = express();
  app.use(express.json());
  app.use("/api", createApiRoutes(store));
  app.use((_req, res) => res.status(404).json({ error: "Not found" }));
  return app;
}

function createRestartStore(root: string, row: Task, options: { failAt?: "cancel" | "patch" | "replace"; moveOnSecondRead?: boolean; mergeOnFence?: boolean; ir?: unknown } = {}) {
  const calls: string[] = [];
  const items: Array<Record<string, unknown>> = [{ id: "old", taskId: row.id, kind: "task", nodeId: "old-node", state: "running" }];
  let reads = 0;
  let atomicWrites = 0;
  const store = {
    getRootDir: vi.fn(() => root),
    getSettings: vi.fn().mockResolvedValue({}),
    getTask: vi.fn(async () => {
      reads += 1;
      // FNXC:ExternalBlockResume 2026-08-28-04:56: the retry route now performs a locked external-block preflight read before the stage-restart reads; move after the publication fence to retain this race's production ordering.
      if (options.moveOnSecondRead && reads === 4) row.column = "building";
      return structuredClone(row);
    }),
    listTasks: vi.fn().mockResolvedValue([structuredClone(row)]),
    withPlanningLifecycleLock: vi.fn(async (_id: string, work: () => Promise<Task>) => await work()),
    getTaskWorkflowSelectionAsync: vi.fn().mockResolvedValue({ workflowId: "wf-restart" }),
    getWorkflowDefinition: vi.fn().mockResolvedValue({ id: "wf-restart", name: "Restart route", ir: options.ir ?? RESTART_IR }),
    updateTaskAtomic: vi.fn(async (_id: string, updater: (current: Task) => Partial<Task> | null | undefined | Promise<Partial<Task> | null | undefined>) => {
      atomicWrites += 1;
      if (options.mergeOnFence && atomicWrites === 1) {
        row.status = "reviewing";
        row.updatedAt = new Date().toISOString();
      }
      const patch = await updater(structuredClone(row));
      if (patch) Object.assign(row, patch);
      return structuredClone(row);
    }),
    pauseTask: vi.fn(async (_id: string, paused: boolean, _context?: unknown, pauseOptions?: { pausedReason?: string }) => {
      calls.push(paused ? "fence" : "unfence");
      row.paused = paused || undefined;
      if (paused) {
        row.pausedReason = pauseOptions?.pausedReason;
        if (row.column === "building" || row.column === "signoff") row.status = "paused";
      } else {
        row.pausedReason = undefined;
        row.userPaused = undefined;
        row.pausedByAgentId = undefined;
        if (row.column === "building" || row.column === "signoff") row.status = undefined;
      }
      return row;
    }),
    resetTerminalFailureAutoRecoveryBudget: vi.fn().mockResolvedValue(undefined),
    clearWorkflowRunStepInstancesAsync: vi.fn().mockResolvedValue(undefined),
    cancelActiveWorkflowWorkItemsForTask: vi.fn(async () => {
      calls.push("retire");
      if (options.failAt === "cancel") throw new Error("cancel failed");
      for (const item of items) {
        if (item.kind === "task" && ["runnable", "running", "held", "retrying"].includes(String(item.state))) item.state = "cancelled";
      }
    }),
    updateTask: vi.fn(async (_id: string, patch: Partial<Task>) => {
      calls.push("patch");
      if (options.failAt === "patch") throw new Error("patch failed");
      Object.assign(row, patch);
      return row;
    }),
    moveTask: vi.fn(async (_id: string, column: Task["column"]) => {
      row.column = column;
      return row;
    }),
    listWorkflowWorkItemsForTask: vi.fn(async () => items),
    replaceActiveTaskWorkflowContinuation: vi.fn(async (input: Record<string, unknown>) => {
      calls.push("arm");
      if (options.failAt === "replace") throw new Error("replace failed");
      items.push({ id: `restart-${items.length}`, ...input });
      return input;
    }),
    logEntry: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    off: vi.fn(),
    getProjectScopedPluginMcpServers: vi.fn().mockResolvedValue([]),
  };
  return { store: store as unknown as TaskStore, calls, items };
}

async function postRetry(app: ReturnType<typeof createApp>, taskId = "FN-204") {
  return performRequest(app, "POST", `/api/tasks/${taskId}/retry`);
}

async function createPrompt(root: string, id = "FN-204") {
  const taskDir = join(root, ".fusion", "tasks", id);
  await mkdir(taskDir, { recursive: true });
  const prompt = join(taskDir, "PROMPT.md");
  await writeFile(prompt, "# Existing plan\n");
  return prompt;
}

afterEach(() => vi.restoreAllMocks());

describe("POST /tasks/:id/retry", () => {
  it("uses the registered core disposer and atomically publishes a planning restart through the HTTP route", async () => {
    const root = await mkdtemp(join(tmpdir(), "fusion-restart-stage-plan-"));
    const prompt = await createPrompt(root);
    const row = taskFixture({ workflowStepResults: [{ workflowStepId: "plan", status: "failed" }] });
    const { store, calls, items } = createRestartStore(root, row);
    const observed = vi.fn(async (beforeReset: Task) => {
      calls.push("dispose");
      expect(beforeReset).not.toBe(row);
      expect(beforeReset).toMatchObject({ paused: true, pausedReason: RESTART_STAGE_FENCE_REASON });
      expect(beforeReset.steps).toEqual([]);
      expect(beforeReset.workflowStepResults).toEqual([{ workflowStepId: "plan", status: "failed" }]);
    });
    const unregister = registerTaskResetDisposer(store, observed);

    try {
      const response = await postRetry(createApp(store));
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(observed).toHaveBeenCalledOnce();
      expect(row).toMatchObject({ column: "planning", status: "needs-replan", steps: [], paused: undefined, pausedReason: undefined });
      await expect(readFile(prompt, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      expect(calls).toEqual(["fence", "dispose", "retire", "patch", "arm", "unfence"]);
      expect(store.updateTask).toHaveBeenCalledWith("FN-204", expect.objectContaining({ paused: true, pausedReason: RESTART_STAGE_FENCE_REASON }));
      expect(items.filter((item) => item.kind === "task" && item.state === "runnable")).toEqual([
        expect.objectContaining({ nodeId: "plan", state: "runnable", waitReason: null, sourceColumn: "planning", targetColumn: "planning" }),
      ]);
      expect(items[0]).toMatchObject({ state: "cancelled" });
    } finally {
      unregister();
    }
  });

  it("restarts renamed implementation and review lanes while preserving earlier-stage artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "fusion-restart-stage-lanes-"));
    const implementation = taskFixture({
      column: "building",
      steps: [{ name: "Implement", status: "done" }, { name: "Verify", status: "done" }],
      currentStep: 2,
      worktree: "/worktree",
      branch: "fusion/fn-204",
      workflowStepResults: [{ workflowStepId: "implement", status: "failed" }],
    });
    const implementationStore = createRestartStore(root, implementation);
    const implementationResponse = await postRetry(createApp(implementationStore.store));
    expect(implementationResponse.status).toBe(200);
    expect(implementation).toMatchObject({ column: "building", currentStep: 0, worktree: null, branch: null, paused: undefined });
    expect(implementation.steps.map((step) => step.status)).toEqual(["pending", "pending"]);
    expect(implementationStore.store.clearWorkflowRunStepInstancesAsync).toHaveBeenCalledWith("FN-204");
    expect(implementationStore.items).toContainEqual(expect.objectContaining({ nodeId: "implement", state: "runnable" }));

    const review = taskFixture({
      column: "signoff",
      steps: [{ name: "Implement", status: "done" }],
      worktree: "/worktree",
      branch: "fusion/fn-204",
      summary: "Finished implementation",
      userPaused: true,
      workflowStepResults: [
        { workflowStepId: "code-review", status: "failed" },
        { workflowStepId: "post-review", status: "passed", phase: "post-merge" },
      ],
    });
    const reviewStore = createRestartStore(root, review);
    const reviewResponse = await postRetry(createApp(reviewStore.store));
    expect(reviewResponse.status).toBe(200);
    expect(review).toMatchObject({ column: "signoff", steps: [{ name: "Implement", status: "done" }], worktree: "/worktree", branch: "fusion/fn-204", summary: "Finished implementation", paused: undefined, userPaused: undefined });
    expect(review.workflowStepResults).toEqual([{ workflowStepId: "post-review", status: "passed", phase: "post-merge" }]);
    expect(reviewStore.items).toContainEqual(expect.objectContaining({ nodeId: "code-review", state: "runnable" }));
    expect(getTaskMergeBlocker(review, { requiredPreMergeStepIds: new Set(["code-review"]), reviewColumns: new Set(["signoff"]) })).toBe(PRE_MERGE_STEPS_NOT_RUN_BLOCKER);
  });

  it("refuses unsupported targets without invoking the disposer or publication writes", async () => {
    const root = await mkdtemp(join(tmpdir(), "fusion-restart-stage-refuse-"));
    const cases: Array<{ name: string; task: Task; status: number }> = [
      { name: "complete column", task: taskFixture({ column: "done" }), status: 400 },
      { name: "archived column", task: taskFixture({ column: "archive" }), status: 400 },
      { name: "active merge", task: taskFixture({ status: "merging", updatedAt: new Date().toISOString() }), status: 409 },
    ];
    for (const testCase of cases) {
      const { store, calls } = createRestartStore(root, testCase.task);
      const disposer = vi.fn();
      const unregister = registerTaskResetDisposer(store, disposer);
      try {
        const response = await postRetry(createApp(store), "FN-204");
        expect(response.status, testCase.name).toBe(testCase.status);
        expect(disposer, testCase.name).not.toHaveBeenCalled();
        expect(calls, testCase.name).toEqual([]);
        expect(store.updateTask, testCase.name).not.toHaveBeenCalled();
        expect(store.replaceActiveTaskWorkflowContinuation, testCase.name).not.toHaveBeenCalled();
      } finally {
        unregister();
      }
    }
  });

  it("retains the stage refusal for a non-retryable v1 workflow before legacy fallback", async () => {
    const root = await mkdtemp(join(tmpdir(), "fusion-retry-refusal-reason-"));
    const { store, calls } = createRestartStore(root, taskFixture(), { ir: LEGACY_V1_IR });

    const response = await postRetry(createApp(store));

    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).toContain("no-column-model");
    expect(store.withPlanningLifecycleLock).toHaveBeenCalledWith("FN-204", expect.any(Function));
    expect(calls).toEqual([]);
  });

  it("refuses a pure hold column whose graph can only resume in a later lane without touching its artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "fusion-restart-stage-no-entry-"));
    const prompt = await createPrompt(root);
    const irWithPureHold = {
      version: "v2",
      name: "pure hold",
      columns: [
        { id: "holding", name: "Holding", traits: [{ trait: "hold" }] },
        { id: "building", name: "Building", traits: [{ trait: "wip" }] },
      ],
      nodes: [{ id: "start", kind: "start" }, { id: "implement", kind: "execute", column: "building" }],
      edges: [{ from: "start", to: "implement" }],
    };
    const row = taskFixture({ column: "holding", workflowStepResults: [{ workflowStepId: "legacy", status: "failed" }] });
    const { store, calls, items } = createRestartStore(root, row, { ir: irWithPureHold });
    const response = await postRetry(createApp(store));
    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).toContain("no-entry-node-in-column");
    expect(row.workflowStepResults).toEqual([{ workflowStepId: "legacy", status: "failed" }]);
    await expect(readFile(prompt, "utf8")).resolves.toContain("Existing plan");
    expect(calls).toEqual([]);
    expect(items).toEqual([expect.objectContaining({ state: "running" })]);
  });

  it("keeps a rejected disposer behind the restart fence with no discarded artifacts or successor", async () => {
    const root = await mkdtemp(join(tmpdir(), "fusion-restart-stage-dispose-"));
    const row = taskFixture({ workflowStepResults: [{ workflowStepId: "plan", status: "failed" }] });
    const { store, calls, items } = createRestartStore(root, row);
    const unregister = registerTaskResetDisposer(store, async () => { throw new Error("owner is still live"); });
    try {
      const response = await postRetry(createApp(store));
      expect(response.status).toBe(409);
      expect(row).toMatchObject({ paused: true, pausedReason: RESTART_STAGE_FENCE_REASON, workflowStepResults: [{ workflowStepId: "plan", status: "failed" }] });
      expect(calls).toEqual(["fence"]);
      expect(items).not.toContainEqual(expect.objectContaining({ state: "runnable" }));
    } finally {
      unregister();
    }
  });

  it("discards failed review orphans but retains passed evidence and leaves merge fail-closed", async () => {
    const root = await mkdtemp(join(tmpdir(), "fusion-restart-stage-orphan-"));
    const row = taskFixture({
      column: "signoff",
      workflowStepResults: [
        { workflowStepId: "legacy-code-review", status: "failed" },
        { workflowStepId: "legacy-plan-review", status: "passed" },
      ],
    });
    const { store } = createRestartStore(root, row);
    expect(getTaskMergeBlocker(row, { requiredPreMergeStepIds: new Set(["code-review"]), reviewColumns: new Set(["signoff"]) })).toMatch(/pre-merge workflow steps/);
    const response = await postRetry(createApp(store));
    expect(response.status).toBe(200);
    expect(row.workflowStepResults).toEqual([{ workflowStepId: "legacy-plan-review", status: "passed" }]);
    expect(getTaskMergeBlocker(row, { requiredPreMergeStepIds: new Set(["code-review"]), reviewColumns: new Set(["signoff"]) })).toBe(PRE_MERGE_STEPS_NOT_RUN_BLOCKER);
  });

  it.each(["cancel", "patch", "replace"] as const)("keeps crash at %s fenced and a second HTTP request converges", async (failAt) => {
    const root = await mkdtemp(join(tmpdir(), `fusion-restart-stage-${failAt}-`));
    const row = taskFixture({ workflowStepResults: [{ workflowStepId: "plan", status: "failed" }] });
    const failed = createRestartStore(root, row, { failAt });
    const first = await postRetry(createApp(failed.store));
    expect(first.status).toBe(409);
    expect(row).toMatchObject({ paused: true, pausedReason: RESTART_STAGE_FENCE_REASON });
    expect(failed.items.some((item) => item.kind === "task" && ["runnable", "retrying"].includes(String(item.state)))).toBe(false);

    const retry = createRestartStore(root, row);
    retry.items.splice(0, retry.items.length, ...failed.items);
    const second = await postRetry(createApp(retry.store));
    expect(second.status).toBe(200);
    expect(row).toMatchObject({ status: "needs-replan", paused: undefined, pausedReason: undefined });
    expect(retry.items.filter((item) => item.kind === "task" && item.state === "runnable")).toEqual([expect.objectContaining({ nodeId: "plan" })]);
  });

  it("unfences a target changed during disposal without publishing a discard or continuation", async () => {
    const root = await mkdtemp(join(tmpdir(), "fusion-restart-stage-target-change-"));
    const row = taskFixture({ workflowStepResults: [{ workflowStepId: "plan", status: "failed" }] });
    const { store, calls } = createRestartStore(root, row, { moveOnSecondRead: true });
    const response = await postRetry(createApp(store));
    expect(response.status).toBe(409);
    expect(row).toMatchObject({ column: "building", paused: undefined, pausedReason: undefined, workflowStepResults: [{ workflowStepId: "plan", status: "failed" }] });
    expect(calls).toEqual(["fence", "unfence"]);
    expect(store.updateTask).not.toHaveBeenCalled();
    expect(store.replaceActiveTaskWorkflowContinuation).not.toHaveBeenCalled();
  });

  it("restarts workspace planning in place without changing repository landing records", async () => {
    const root = await mkdtemp(join(tmpdir(), "fusion-retry-workspace-plan-"));
    const prompt = await createPrompt(root);
    const workspaceWorktrees = workspaceWorktreesFixture();
    const before = structuredClone(workspaceWorktrees);
    const row = taskFixture({
      status: undefined,
      steps: [{ name: "Old plan", status: "done" }],
      workspaceWorktrees,
      workflowStepResults: [{ workflowStepId: "plan", status: "failed" }],
    });
    const { store, items } = createRestartStore(root, row);
    const response = await postRetry(createApp(store));

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(row).toMatchObject({ column: "planning", status: "needs-replan", steps: [] });
    expect(row.workspaceWorktrees).toEqual(before);
    expect(items).toContainEqual(expect.objectContaining({ nodeId: "plan", state: "runnable" }));
    expect(store.updateTask).toHaveBeenCalledWith("FN-204", expect.not.objectContaining({ workspaceWorktrees: expect.anything() }));
    for (const [, patch] of vi.mocked(store.updateTask).mock.calls) expect("workspaceWorktrees" in (patch as object)).toBe(false);
    expect(store.logEntry).toHaveBeenCalledWith("FN-204", expect.stringContaining("preserved 2 workspace repository record(s)"));
    await expect(readFile(prompt, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("restarts workspace implementation in place while clearing only singular checkout aliases", async () => {
    const root = await mkdtemp(join(tmpdir(), "fusion-retry-workspace-implementation-"));
    const workspaceWorktrees = workspaceWorktreesFixture();
    const before = structuredClone(workspaceWorktrees);
    const row = taskFixture({
      column: "building",
      status: undefined,
      steps: [{ name: "Implement", status: "done" }],
      currentStep: 1,
      worktree: workspaceWorktrees.api.worktreePath,
      branch: workspaceWorktrees.api.branch,
      workspaceWorktrees,
      workflowStepResults: [{ workflowStepId: "implement", status: "failed" }],
    });
    const { store, items } = createRestartStore(root, row);
    const response = await postRetry(createApp(store));

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(row).toMatchObject({ column: "building", status: undefined, currentStep: 0, worktree: null, branch: null, branchWriteOrigin: "engine" });
    expect(row.steps.map((step) => step.status)).toEqual(["pending"]);
    expect(row.workspaceWorktrees).toEqual(before);
    expect(items).toContainEqual(expect.objectContaining({ nodeId: "implement", state: "runnable" }));
    for (const [, patch] of vi.mocked(store.updateTask).mock.calls) expect("workspaceWorktrees" in (patch as object)).toBe(false);
  });

  it("restarts the reported status-none workspace review shape in place and keeps merge blocked", async () => {
    const root = await mkdtemp(join(tmpdir(), "fusion-retry-workspace-review-"));
    const workspaceWorktrees = workspaceWorktreesFixture();
    const before = structuredClone(workspaceWorktrees);
    const row = taskFixture({
      column: "signoff",
      status: null as Task["status"],
      steps: [{ name: "Implement", status: "done" }],
      mergeRetries: 0,
      workspaceWorktrees,
      workflowStepResults: [{ workflowStepId: "code-review", status: "passed" }],
    });
    const { store, items } = createRestartStore(root, row);
    const response = await postRetry(createApp(store));

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(row).toMatchObject({ column: "signoff", status: undefined, steps: [{ name: "Implement", status: "done" }] });
    expect(store.updateTask).toHaveBeenCalledWith("FN-204", expect.objectContaining({ status: null }));
    expect(row.workspaceWorktrees).toEqual(before);
    expect(items).toContainEqual(expect.objectContaining({ nodeId: "code-review", state: "runnable" }));
    expect(getTaskMergeBlocker(row, { requiredPreMergeStepIds: new Set(["code-review"]), reviewColumns: new Set(["signoff"]) })).toBe(PRE_MERGE_STEPS_NOT_RUN_BLOCKER);
    for (const [, patch] of vi.mocked(store.updateTask).mock.calls) expect("workspaceWorktrees" in (patch as object)).toBe(false);
    expect(JSON.stringify(response.body)).not.toContain("workspace-task");
    expect(JSON.stringify(vi.mocked(store.logEntry).mock.calls)).not.toContain("workspace-task");
  });

  it("produces the same route and continuation result for workspace and single-repository review twins", async () => {
    const root = await mkdtemp(join(tmpdir(), "fusion-retry-workspace-parity-"));
    const shared = {
      column: "signoff" as const,
      status: null as Task["status"],
      steps: [{ name: "Implement", status: "done" as const }],
      mergeRetries: 0,
      workflowStepResults: [{ workflowStepId: "code-review", status: "passed" as const }],
    };
    const single = taskFixture(shared);
    const workspace = taskFixture({ ...shared, workspaceWorktrees: workspaceWorktreesFixture() });
    const singleStore = createRestartStore(root, single);
    const workspaceStore = createRestartStore(root, workspace);

    const [singleResponse, workspaceResponse] = await Promise.all([
      postRetry(createApp(singleStore.store)),
      postRetry(createApp(workspaceStore.store)),
    ]);

    expect(workspaceResponse.status).toBe(singleResponse.status);
    expect(workspace.column).toBe(single.column);
    expect(workspace.status).toBe(single.status);
    expect(workspaceStore.items.find((item) => item.state === "runnable")?.nodeId)
      .toBe(singleStore.items.find((item) => item.state === "runnable")?.nodeId);
  });

  it("unfences and refuses when a merge becomes active while Retry claims its publication fence", async () => {
    const root = await mkdtemp(join(tmpdir(), "fusion-retry-reviewing-fence-race-"));
    const row = taskFixture({
      column: "signoff",
      status: null as Task["status"],
      steps: [{ name: "Implement", status: "done" }],
    });
    const { store, calls, items } = createRestartStore(root, row, { mergeOnFence: true });
    const disposer = vi.fn();
    const unregister = registerTaskResetDisposer(store, disposer);

    try {
      const response = await postRetry(createApp(store));

      expect(response.status).toBe(409);
      expect(JSON.stringify(response.body)).toContain("Retry is unavailable while a merge is active");
      expect(row).toMatchObject({ status: "reviewing" });
      expect(row.paused).toBeFalsy();
      expect(row.pausedReason).toBeFalsy();
      expect(store.updateTaskAtomic).toHaveBeenCalledTimes(2);
      expect(store.pauseTask).not.toHaveBeenCalled();
      expect(disposer).not.toHaveBeenCalled();
      expect(calls).toEqual([]);
      expect(items).toEqual([expect.objectContaining({ id: "old", state: "running" })]);
    } finally {
      unregister();
    }
  });

  it("protects a fresh reviewing phase but allows its stale orphaned stamp", async () => {
    const root = await mkdtemp(join(tmpdir(), "fusion-retry-reviewing-fence-"));
    const fresh = taskFixture({
      column: "signoff",
      status: "reviewing",
      updatedAt: new Date().toISOString(),
      steps: [{ name: "Implement", status: "done" }],
    });
    const stale = taskFixture({
      column: "signoff",
      status: "reviewing",
      updatedAt: "2026-01-01T00:00:00.000Z",
      steps: [{ name: "Implement", status: "done" }],
    });

    const freshResponse = await postRetry(createApp(createRestartStore(root, fresh).store));
    const staleResponse = await postRetry(createApp(createRestartStore(root, stale).store));

    expect(freshResponse.status).toBe(409);
    expect(JSON.stringify(freshResponse.body)).toContain("Retry is unavailable while a merge is active");
    expect(staleResponse.status).toBe(200);
  });

  it("does not route the removed restart-stage endpoint", async () => {
    const root = await mkdtemp(join(tmpdir(), "fusion-retry-route-removed-"));
    const { store } = createRestartStore(root, taskFixture());
    const response = await performRequest(createApp(store), "POST", "/api/tasks/FN-204/restart-stage");
    expect(response.status).toBe(404);
  });
});
