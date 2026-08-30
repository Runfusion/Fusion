// @vitest-environment node
/*
FNXC:MergeReliability 2026-07-15-22:05 (FN-8004 follow-up):

## Symptom Verification

Original symptom: FN-8004's AI merge was killed mid-flight, leaving `status: "landing"` stamped on
the task. `POST /api/tasks/FN-8004/retry` then answered
  400 — "Task is not in a retryable state (current status: landing)"
for the full self-healing sweep delay. The automatic sweep DID recover it minutes later, so the
operator's manual escape hatch was blocked at exactly the moment it was needed.

Exact reproduction: an in-review task with a merge-active status, no live merge lease, and an
`updatedAt` older than the staleness floor.

Assertion it is gone: that POST now succeeds AND takes the merge-retry branch — status/error
cleared, mergeRetries reset, task STAYS in in-review. Staying put is load-bearing: routing a
fully-executed task to `todo` would re-run finished work, which is the bug this fix could easily
have introduced.

## Surface Enumeration

- Every status in ACTIVE_MERGE_STATUSES (merging / merging-pr / merging-fix / reviewing / landing),
  since a merger can die in any phase — not just the reported `landing`.
- Live-merge protection via BOTH independent signals: the in-process lease, and a fresh updatedAt.
- The pre-existing retry paths (failed / status-none merge stall) must be unchanged.
*/
import { describe, expect, it, vi } from "vitest";
import express from "express";
import type { Task, TaskStore } from "@fusion/core";
import { registerTaskWorkflowRoutes } from "../routes/register-task-workflow-routes.js";
import { request as performRequest } from "../test-request.js";
import { ApiError, sendErrorResponse } from "../api-error.js";
import { ACTIVE_MERGE_STATUSES, DEFAULT_STALE_MERGING_STATUS_MIN_AGE_MS } from "@fusion/engine";

const NOW = Date.now();
const STALE_AT = new Date(NOW - DEFAULT_STALE_MERGING_STATUS_MIN_AGE_MS - 60_000).toISOString();
const FRESH_AT = new Date(NOW - 5_000).toISOString();

const LEGACY_V1_IR = {
  version: "v1",
  name: "legacy retry route",
  nodes: [],
  edges: [],
} as never;

const RESTART_IR = {
  version: "v2",
  name: "retry stale merge route",
  columns: [
    { id: "in-review", name: "In Review", traits: [{ trait: "merge-blocker" }, { trait: "human-review" }] },
    { id: "done", name: "Done", traits: [{ trait: "complete" }] },
  ],
  nodes: [
    { id: "start", kind: "start" },
    { id: "code-review", kind: "prompt", column: "in-review" },
  ],
  edges: [{ from: "start", to: "code-review" }],
} as never;

/** An in-review task whose implementation is complete — the FN-8004 shape. */
function mkMergeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-8004",
    title: "soft-delete heartbeat race",
    description: "d",
    column: "in-review",
    status: "landing",
    dependencies: [],
    createdAt: "2026-07-15T09:00:00.000Z",
    updatedAt: STALE_AT,
    size: "M",
    subtasks: [],
    log: [],
    tags: [],
    blockedBy: [],
    mergeRetries: 3,
    // All steps complete: this is a merge failure, not an execution failure.
    steps: [{ status: "done" }, { status: "done" }],
    source: { sourceType: "api" },
    ...overrides,
  } as unknown as Task;
}

function buildApp(input: {
  task: Task;
  activeMergeTaskId?: string | null;
  staleMergingStatusMinAgeMs?: number;
  settings?: { autoMerge?: boolean };
  engine?: { isMergePending: ReturnType<typeof vi.fn>; enqueueMerge: ReturnType<typeof vi.fn> };
  workflowIr?: unknown;
}) {
  const updateTask = vi.fn(async (_id: string, patch: Partial<Task>) => Object.assign(input.task, patch));
  const moveTask = vi.fn(async () => input.task);
  const logEntry = vi.fn(async () => {});
  const workflowItems: Array<Record<string, unknown>> = [];
  const store = {
    getTask: async () => input.task,
    getTaskDetail: async () => input.task,
    updateTask,
    moveTask,
    logEntry,
    getSettings: async () => ({ autoMerge: true, ...input.settings }),
    getSettingsFast: async () => ({ autoMerge: true, ...input.settings }),
    getRootDir: () => "/tmp/does-not-exist",
    listTasks: async () => [input.task],
    withPlanningLifecycleLock: async (_taskId: string, work: () => Promise<unknown>) => work(),
    updateTaskAtomic: async (_taskId: string, updater: (current: Task) => Partial<Task> | null | undefined | Promise<Partial<Task> | null | undefined>) => {
      const patch = await updater(structuredClone(input.task));
      if (patch) Object.assign(input.task, patch);
      return input.task;
    },
    pauseTask: async (_taskId: string, paused: boolean, _context?: unknown, options?: { pausedReason?: string }) => {
      input.task.paused = paused || undefined;
      input.task.pausedReason = paused ? options?.pausedReason : undefined;
      return input.task;
    },
    cancelActiveWorkflowWorkItemsForTask: async () => {},
    replaceActiveTaskWorkflowContinuation: async (item: Record<string, unknown>) => {
      workflowItems.push(item);
      return item;
    },
    listWorkflowWorkItemsForTask: async () => workflowItems,
    clearWorkflowRunStepInstancesAsync: async () => {},
    getTaskWorkflowSelectionAsync: async () => ({ workflowId: "wf-retry-stage" }),
    getWorkflowDefinition: async () => ({ id: "wf-retry-stage", name: "Retry stage", ir: input.workflowIr ?? RESTART_IR }),
    // FNXC:TaskWedgeNotifications 2026-08-15-05:10: dashboard Retry now clears the spent generic-terminal auto-recovery budget before mutating task state; the fixture must expose the seam or every retry 500s.
    resetTerminalFailureAutoRecoveryBudget: async () => {},
  } as unknown as TaskStore;

  const runtimeLogger = { warn: vi.fn(), error: vi.fn(), log: vi.fn() };
  const router = express.Router();
  registerTaskWorkflowRoutes({
    router,
    store,
    options: {},
    runtimeLogger: runtimeLogger as never,
    planningLogger: runtimeLogger as never,
    chatLogger: runtimeLogger as never,
    getProjectIdFromRequest: () => undefined,
    getScopedStore: async () => store,
    getProjectContext: async () => ({ store, engine: input.engine as never, projectId: "p-1" }),
    prioritizeProjectsForCurrentDirectory: (projects: unknown) => projects,
    emitRemoteRouteDiagnostic: () => {},
    emitAuthSyncAuditLog: () => {},
    parseScopeParam: () => undefined,
    resolveAutomationStore: () => ({}) as never,
    resolveRoutineStore: () => ({}) as never,
    resolveRoutineRunner: () => ({}) as never,
    registerDispose: () => {},
    dispose: () => {},
    rethrowAsApiError: (error: unknown): never => {
      if (error instanceof ApiError) throw error;
      throw new ApiError(500, error instanceof Error ? error.message : "Internal server error");
    },
  } as never, {
    runtimeLogger,
    upload: { single: () => (_req: unknown, _res: unknown, next: () => void) => next() },
    taskDetailActivityLogLimit: 100,
    validateOptionalModelField: (value: unknown) => (typeof value === "string" ? value : undefined),
    normalizeModelSelectionPair: (provider: string | null, modelId: string | null) => ({ provider: provider ?? null, modelId: modelId ?? null }),
    runGitCommand: async () => "",
    isGitRepo: async () => true,
    resolveIntegrationBranch: async () => "main",
    trimTaskDetailActivityLog: (task: unknown) => task,
    triggerCommentWakeForAssignedAgent: async () => {},
    // The seam the fix reads for live-merge proof.
    resolveSelfHealingManager: () => ({
      getActiveMergeTaskId: () => input.activeMergeTaskId ?? null,
      getStaleMergingStatusMinAgeMs: () => input.staleMergingStatusMinAgeMs ?? DEFAULT_STALE_MERGING_STATUS_MIN_AGE_MS,
    }),
  } as never);

  const app = express();
  app.use(express.json());
  app.use("/api", router);
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof ApiError) {
      sendErrorResponse(res, error.statusCode, error.message, { details: error.details });
      return;
    }
    sendErrorResponse(res, 500, error instanceof Error ? error.message : "Internal server error");
  });
  return { app, updateTask, moveTask, logEntry, workflowItems };
}

/** The reported zero-land workspace lease-loss state, with completed execution progress. */
function mkFailedWorkspaceTask(overrides: Partial<Task> = {}): Task {
  return mkMergeTask({
    id: "MRG-040",
    status: "failed",
    error: "Workspace partial land for MRG-040: 0 repo(s) landed, 1 failed — Merge: Workspace lease is no longer valid",
    workspaceWorktrees: {
      Merge: { worktreePath: "/workspace/Merge/.worktrees/fast-olive", branch: "fusion/mrg-040" },
      "Merge-Auth": { worktreePath: "/workspace/Merge-Auth/.worktrees/swift-eagle", branch: "fusion/mrg-040" },
    },
    ...overrides,
  } as Partial<Task>);
}

type WorkspaceRetryGateInput = {
  pending?: boolean;
  settings?: { autoMerge?: boolean };
  task?: Partial<Task>;
  probeError?: Error;
};

const workspaceRetrySafetyCases: Array<[string, WorkspaceRetryGateInput]> = [
  ["a pending local or remote merge owner", { pending: true }],
  ["an effective auto-merge hold", { settings: { autoMerge: false } }],
  ["a user-controlled pause", { task: { userPaused: true } }],
  ["an unreadable pending-owner probe", { probeError: new Error("remote lease unavailable") }],
];

describe("POST /api/tasks/:id/retry — orphaned merge-active status (FN-8004)", () => {
  it("retries a task stranded in 'landing' by a killed merger", async () => {
    const { app, updateTask, moveTask } = buildApp({ task: mkMergeTask() });

    const res = await performRequest(app, "POST", "/api/tasks/FN-8004/retry", "{}", { "content-type": "application/json" });

    // The regression: this used to be 400 "not in a retryable state (current status: landing)".
    expect(res.status).toBe(200);
    // Merge-retry branch: clear the stamp and reset the budget...
    expect(updateTask).toHaveBeenCalledWith(
      "FN-8004",
      expect.objectContaining({ status: null, error: null }),
    );
    // ...and STAY in in-review. Moving completed work to todo would re-run it.
    expect(moveTask).not.toHaveBeenCalled();
  });

  it("retries a task stranded in ANY merge-active phase, not just the reported one", async () => {
    for (const status of [...ACTIVE_MERGE_STATUSES]) {
      const { app } = buildApp({ task: mkMergeTask({ status } as Partial<Task>) });
      const res = await performRequest(app, "POST", "/api/tasks/FN-8004/retry", "{}", { "content-type": "application/json" });
      expect(res.status, `status=${status} must be retryable when orphaned`).toBe(200);
    }
  });

  it("uses the configured staleness floor, matching automatic recovery", async () => {
    const twoMinutesAgo = new Date(Date.now() - 2 * 60_000).toISOString();
    const { app } = buildApp({
      task: mkMergeTask({ updatedAt: twoMinutesAgo }),
      staleMergingStatusMinAgeMs: 60_000,
    });

    const res = await performRequest(app, "POST", "/api/tasks/FN-8004/retry", "{}", { "content-type": "application/json" });

    expect(res.status).toBe(200);
  });

  it.each([...ACTIVE_MERGE_STATUSES])("refuses %s retry while a merge holds the live in-process lease", async (status) => {
    const { app } = buildApp({ task: mkMergeTask({ status }), activeMergeTaskId: "FN-8004" });

    const res = await performRequest(app, "POST", "/api/tasks/FN-8004/retry", "{}", { "content-type": "application/json" });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(JSON.stringify(res.body)).toContain("Retry is unavailable while a merge is active");
  });

  it.each([...ACTIVE_MERGE_STATUSES])("refuses %s retry while the phase is progressing with a fresh updatedAt", async (status) => {
    // Each merge phase writes a log entry, refreshing updatedAt — this is what stops
    // an operator from yanking a slow-but-live merge.
    const { app } = buildApp({ task: mkMergeTask({ status, updatedAt: FRESH_AT }) });

    const res = await performRequest(app, "POST", "/api/tasks/FN-8004/retry", "{}", { "content-type": "application/json" });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(JSON.stringify(res.body)).toContain("Retry is unavailable while a merge is active");
  });

  it("leaves the pre-existing failed-merge retry path unchanged", async () => {
    const { app, updateTask, moveTask } = buildApp({
      task: mkMergeTask({ status: "failed", updatedAt: FRESH_AT }),
    });

    const res = await performRequest(app, "POST", "/api/tasks/FN-8004/retry", "{}", { "content-type": "application/json" });

    expect(res.status).toBe(200);
    expect(updateTask).toHaveBeenCalledWith(
      "FN-8004",
      expect.objectContaining({ status: null, error: null }),
    );
    expect(moveTask).not.toHaveBeenCalled();
  });

  it("promptly queues a failed zero-land workspace retry after a clear pending-owner probe", async () => {
    const task = mkFailedWorkspaceTask();
    const workspaceWorktrees = task.workspaceWorktrees;
    const engine = { isMergePending: vi.fn().mockResolvedValue(false), enqueueMerge: vi.fn().mockReturnValue(true) };
    const { app, updateTask, moveTask } = buildApp({ task, engine, workflowIr: LEGACY_V1_IR });

    const res = await performRequest(app, "POST", "/api/tasks/MRG-040/retry", "{}", { "content-type": "application/json" });

    expect(res.status).toBe(200);
    expect(updateTask).toHaveBeenCalledWith("MRG-040", expect.objectContaining({ status: null, error: null, mergeRetries: 0 }));
    expect(task.column).toBe("in-review");
    expect(task.steps.every((step) => step.status === "done")).toBe(true);
    expect(task.workspaceWorktrees).toBe(workspaceWorktrees);
    expect(moveTask).not.toHaveBeenCalled();
    expect(engine.isMergePending).toHaveBeenCalledOnce();
    expect(engine.isMergePending).toHaveBeenCalledWith("MRG-040");
    expect(engine.enqueueMerge).toHaveBeenCalledOnce();
    expect(engine.enqueueMerge).toHaveBeenCalledWith("MRG-040");
  });

  it("keeps a workspace retry successful when no engine is available", async () => {
    const task = mkFailedWorkspaceTask();
    const workspaceWorktrees = task.workspaceWorktrees;
    const { app, moveTask } = buildApp({ task, workflowIr: LEGACY_V1_IR });

    const res = await performRequest(app, "POST", "/api/tasks/MRG-040/retry", "{}", { "content-type": "application/json" });

    expect(res.status).toBe(200);
    expect(task.status).toBeNull();
    expect(task.workspaceWorktrees).toBe(workspaceWorktrees);
    expect(moveTask).not.toHaveBeenCalled();
  });

  it("restarts a v2 workspace review in place without dispatching the legacy merge queue", async () => {
    const task = mkFailedWorkspaceTask({ status: undefined, error: undefined, mergeRetries: 0 });
    const before = structuredClone(task.workspaceWorktrees);
    const engine = { isMergePending: vi.fn().mockResolvedValue(false), enqueueMerge: vi.fn().mockReturnValue(true) };
    const { app, updateTask, workflowItems } = buildApp({ task, engine });

    const res = await performRequest(app, "POST", "/api/tasks/MRG-040/retry", "{}", { "content-type": "application/json" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(task.column).toBe("in-review");
    expect(task.workspaceWorktrees).toEqual(before);
    expect(workflowItems).toContainEqual(expect.objectContaining({ nodeId: "code-review", state: "runnable" }));
    for (const [, patch] of updateTask.mock.calls) expect("workspaceWorktrees" in (patch as object)).toBe(false);
    expect(engine.isMergePending).not.toHaveBeenCalled();
    expect(engine.enqueueMerge).not.toHaveBeenCalled();
  });

  it("does not send a non-workspace merge retry through the workspace queue", async () => {
    const engine = { isMergePending: vi.fn().mockResolvedValue(false), enqueueMerge: vi.fn().mockReturnValue(true) };
    const { app } = buildApp({ task: mkMergeTask({ status: "failed" }), engine });

    const res = await performRequest(app, "POST", "/api/tasks/FN-8004/retry", "{}", { "content-type": "application/json" });

    expect(res.status).toBe(200);
    expect(engine.isMergePending).not.toHaveBeenCalled();
    expect(engine.enqueueMerge).not.toHaveBeenCalled();
  });

  it.each(workspaceRetrySafetyCases)("does not double-dispatch a workspace retry with %s", async (_label, input) => {
    const engine = {
      isMergePending: input.probeError ? vi.fn().mockRejectedValue(input.probeError) : vi.fn().mockResolvedValue(input.pending === true),
      enqueueMerge: vi.fn().mockReturnValue(true),
    };
    const task = mkFailedWorkspaceTask(input.task);
    const workspaceWorktrees = task.workspaceWorktrees;
    const { app, moveTask } = buildApp({ task, engine, settings: input.settings, workflowIr: LEGACY_V1_IR });

    const res = await performRequest(app, "POST", "/api/tasks/MRG-040/retry", "{}", { "content-type": "application/json" });

    expect(res.status).toBe(200);
    expect(task.status).toBeNull();
    expect(task.error).toBeNull();
    expect(task.column).toBe("in-review");
    expect(task.workspaceWorktrees).toBe(workspaceWorktrees);
    expect(moveTask).not.toHaveBeenCalled();
    if (input.settings || input.task) expect(engine.isMergePending).not.toHaveBeenCalled();
    else expect(engine.isMergePending).toHaveBeenCalledOnce();
    expect(engine.enqueueMerge).not.toHaveBeenCalled();
  });
});
