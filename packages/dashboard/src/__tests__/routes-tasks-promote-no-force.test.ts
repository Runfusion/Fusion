// @vitest-environment node

import express from "express";
import { describe, expect, it, vi } from "vitest";
import type { Task, TaskStore, WorkflowIr } from "@fusion/core";
import { request } from "../test-request.js";
import { ApiError, sendErrorResponse } from "../api-error.js";
import { registerTaskWorkflowRoutes } from "../routes/register-task-workflow-routes.js";

function workflow(): WorkflowIr {
  return {
    version: "v2",
    name: "promote-route",
    columns: [
      { id: "todo", name: "Todo", traits: [{ trait: "hold", config: { release: "capacity" } }] },
      { id: "in-progress", name: "In progress", traits: [{ trait: "wip" }] },
      { id: "done", name: "Done", traits: [{ trait: "complete" }] },
    ],
    nodes: [
      { id: "start", kind: "start", column: "todo" },
      { id: "end", kind: "end", column: "done" },
    ],
    edges: [{ from: "start", to: "end" }],
  };
}

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-1403",
    title: "Promote route fixture",
    description: "Promote route fixture",
    column: "todo",
    status: "needs-replan",
    dependencies: [],
    steps: [],
    log: [],
    createdAt: "2026-08-29T00:24:00.000Z",
    updatedAt: "2026-08-29T00:24:00.000Z",
    columnMovedAt: "2026-08-29T00:24:00.000Z",
    ...overrides,
  } as Task;
}

function buildApp(task: Task) {
  const moveTaskIf = vi.fn(async (
    _taskId: string,
    target: string,
    predicate: (live: Task) => boolean | Promise<boolean>,
  ) => {
    if (!(await predicate(task))) return { moved: false, task };
    task.column = target as Task["column"];
    return { moved: true, task };
  });
  const store: Partial<TaskStore> = {
    getTask: vi.fn(async (id: string) => id === task.id ? task : null),
    updateTask: vi.fn(async (_id: string, patch: Partial<Task>) => Object.assign(task, patch)),
    moveTaskIf,
    recordRunAuditEvent: vi.fn(async () => undefined),
    getTaskWorkflowSelection: vi.fn(async () => ({ workflowId: "custom", stepIds: [] })),
    getWorkflowDefinition: vi.fn(async () => ({ ir: workflow() })),
    getSettingsFast: vi.fn(async () => ({})),
    getRootDir: vi.fn(() => process.cwd()),
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
  return { app, store, moveTaskIf, task };
}

async function promote(app: express.Express, body: Record<string, unknown>) {
  return request(
    app,
    "POST",
    "/api/tasks/FN-1403/promote",
    JSON.stringify(body),
    { "content-type": "application/json" },
  );
}

describe("POST /api/tasks/:id/promote without a force override", () => {
  it("keeps an unplanned task held when the request body includes force", async () => {
    const { app, moveTaskIf, task } = buildApp(createTask());

    const response = await promote(app, { force: true });
    const body = response.body as { details: Record<string, unknown> };

    expect(response.status).toBe(409);
    expect(body.details).toMatchObject({
      code: "unplanned-for-execution",
      messageKey: "board.rejection.unplannedForExecution",
      retryable: true,
    });
    expect(body.details).not.toHaveProperty("forceable");
    expect(moveTaskIf).not.toHaveBeenCalled();
    expect(task.status).toBe("needs-replan");
  });

  it("still promotes a planned held task", async () => {
    const { app, moveTaskIf, task } = buildApp(createTask({ status: null }));

    const response = await promote(app, { force: true });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ id: "FN-1403", column: "in-progress" });
    expect(moveTaskIf).toHaveBeenCalledTimes(1);
    expect(task.column).toBe("in-progress");
  });
});
