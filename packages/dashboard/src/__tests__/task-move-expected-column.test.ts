// @vitest-environment node

import express from "express";
import { describe, expect, it, vi } from "vitest";
import type { Task, TaskStore, WorkflowIr } from "@fusion/core";

import { ApiError, sendErrorResponse } from "../api-error.js";
import { registerTaskWorkflowRoutes } from "../routes/register-task-workflow-routes.js";
import { request } from "../test-request.js";

function workflow(): WorkflowIr {
  return {
    version: "v2",
    name: "expected-column",
    columns: [
      { id: "ideas", name: "Ideas", traits: [{ trait: "intake" }] },
      { id: "todo", name: "Todo", traits: [{ trait: "hold" }] },
      { id: "in-progress", name: "In progress", traits: [{ trait: "wip" }] },
    ],
    nodes: [{ id: "start", kind: "start", column: "ideas" }],
    edges: [],
  };
}

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-262",
    title: "Expected column fixture",
    description: "Protect Start from a stale card",
    column: "ideas",
    dependencies: [],
    steps: [],
    currentStep: 0,
    worktree: "/workspace/.worktrees/fn-262",
    log: [],
    createdAt: "2026-08-30T01:00:00.000Z",
    updatedAt: "2026-08-30T01:00:00.000Z",
    ...overrides,
  } as Task;
}

function buildApp(options: { guardTask?: Task; liveTask?: Task } = {}) {
  const guardTask = options.guardTask ?? createTask();
  const liveTask = options.liveTask ?? guardTask;
  const moveTask = vi.fn(async (_id: string, target: Task["column"]) => {
    liveTask.column = target;
    liveTask.userPaused = true;
    liveTask.worktree = undefined;
    return liveTask;
  });
  const moveTaskIf = vi.fn(async (
    _id: string,
    target: Task["column"],
    predicate: (task: Task) => boolean | Promise<boolean>,
  ) => {
    if (!(await predicate(liveTask)) || liveTask.column === target) {
      return { task: liveTask, moved: false };
    }
    liveTask.column = target;
    return { task: liveTask, moved: true };
  });
  const store: Partial<TaskStore> = {
    getTask: vi.fn(async (id: string) => id === guardTask.id ? guardTask : null),
    moveTask,
    moveTaskIf,
    getTaskWorkflowSelection: vi.fn(async () => ({ workflowId: "expected-column", stepIds: [] })),
    getWorkflowDefinition: vi.fn(async () => ({ id: "expected-column", name: "Expected column", ir: workflow() })),
    getRootDir: vi.fn(() => "/workspace"),
    getSettings: vi.fn(async () => ({})),
  };
  const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
  const router = express.Router();
  registerTaskWorkflowRoutes({
    router,
    store: store as TaskStore,
    options: {},
    runtimeLogger: logger as never,
    planningLogger: logger as never,
    chatLogger: logger as never,
    getProjectIdFromRequest: () => undefined,
    getScopedStore: async () => store as TaskStore,
    getProjectContext: async () => ({ store: store as TaskStore, engine: undefined, projectId: undefined }),
    prioritizeProjectsForCurrentDirectory: (projects) => projects,
    emitRemoteRouteDiagnostic: () => {},
    emitAuthSyncAuditLog: () => {},
    parseScopeParam: () => undefined,
    resolveAutomationStore: () => ({}) as never,
    resolveRoutineStore: () => ({}) as never,
    resolveRoutineRunner: () => ({}) as never,
    registerDispose: () => {},
    dispose: () => {},
    rethrowAsApiError: (error: unknown): never => {
      throw error instanceof ApiError ? error : new ApiError(500, String(error));
    },
  }, {
    runtimeLogger: logger as never,
    upload: { single: () => (_req: unknown, _res: unknown, next: () => void) => next() },
    taskDetailActivityLogLimit: 100,
    validateOptionalModelField: () => undefined,
    normalizeModelSelectionPair: () => ({ provider: null, modelId: null }),
    runGitCommand: async () => "",
    trimTaskDetailActivityLog: (candidate) => candidate,
    triggerCommentWakeForAssignedAgent: async () => {},
  });

  const app = express();
  app.use(express.json());
  app.use("/api", router);
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const apiError = error instanceof ApiError ? error : new ApiError(500, String(error));
    sendErrorResponse(res, apiError.statusCode, apiError.message, { details: apiError.details, error: apiError });
  });
  return { app, guardTask, liveTask, moveTask, moveTaskIf };
}

async function move(app: express.Express, body: Record<string, unknown>) {
  return request(
    app,
    "POST",
    "/api/tasks/FN-262/move",
    JSON.stringify(body),
    { "content-type": "application/json" },
  );
}

describe("POST /api/tasks/:id/move expectedColumn", () => {
  it("atomically refuses the operator's stale Start after the live row advances", async () => {
    const guardTask = createTask({ column: "ideas" });
    const liveTask = createTask({ column: "in-progress", userPaused: undefined, worktree: "/workspace/.worktrees/fn-262" });
    const { app, moveTask, moveTaskIf } = buildApp({ guardTask, liveTask });

    const response = await move(app, { column: "todo", expectedColumn: "ideas" });

    expect(response.status).toBe(409);
    expect(response.body.details).toMatchObject({
      code: "stale-move-precondition",
      messageKey: "board.rejection.staleMovePrecondition",
      retryable: false,
    });
    expect(moveTaskIf).toHaveBeenCalledOnce();
    expect(moveTask).not.toHaveBeenCalled();
    expect(liveTask).toMatchObject({ column: "in-progress", worktree: "/workspace/.worktrees/fn-262" });
    expect(liveTask.userPaused).toBeUndefined();
  });

  it("returns the already-reached target without mutating it", async () => {
    const guardTask = createTask({ column: "ideas" });
    const liveTask = createTask({ column: "todo", worktree: "/workspace/.worktrees/fn-262" });
    const { app, moveTask, moveTaskIf } = buildApp({ guardTask, liveTask });

    const response = await move(app, { column: "todo", expectedColumn: "ideas" });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ id: "FN-262", column: "todo" });
    expect(moveTaskIf).toHaveBeenCalledOnce();
    expect(moveTask).not.toHaveBeenCalled();
    expect(liveTask.worktree).toBe("/workspace/.worktrees/fn-262");
  });

  it("moves when the live row still matches the expected column", async () => {
    const liveTask = createTask({ column: "ideas" });
    const { app, moveTask, moveTaskIf } = buildApp({ liveTask });

    const response = await move(app, { column: "todo", expectedColumn: "ideas" });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ id: "FN-262", column: "todo" });
    expect(moveTaskIf).toHaveBeenCalledOnce();
    expect(moveTask).not.toHaveBeenCalled();
  });

  it("preserves the legacy moveTask path when expectedColumn is omitted", async () => {
    const { app, moveTask, moveTaskIf } = buildApp();

    const response = await move(app, { column: "todo" });

    expect(response.status).toBe(200);
    expect(moveTask).toHaveBeenCalledOnce();
    expect(moveTaskIf).not.toHaveBeenCalled();
  });

  it.each([42, "", "   "])("rejects invalid expectedColumn %j before any store move", async (expectedColumn) => {
    const { app, moveTask, moveTaskIf } = buildApp();

    const response = await move(app, { column: "todo", expectedColumn });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("expectedColumn must be a non-empty string");
    expect(moveTask).not.toHaveBeenCalled();
    expect(moveTaskIf).not.toHaveBeenCalled();
  });
});
