// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import express from "express";
import { TaskNotFoundError, type TaskStore } from "@fusion/core";
import { registerTaskWorkflowRoutes } from "../register-task-workflow-routes.js";
import { request } from "../../test-request.js";
import { ApiError, sendErrorResponse } from "../../api-error.js";

function buildApp(store: TaskStore, projectId = "project-a") {
  const router = express.Router();
  const noopLogger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
  registerTaskWorkflowRoutes({
    router,
    store,
    options: {},
    runtimeLogger: noopLogger,
    planningLogger: noopLogger,
    chatLogger: noopLogger,
    getProjectIdFromRequest: () => undefined,
    getScopedStore: async () => store,
    getProjectContext: async () => ({ store, engine: undefined, projectId }),
    prioritizeProjectsForCurrentDirectory: (projects: unknown[]) => projects,
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
  } as never, {
    runtimeLogger: noopLogger,
    upload: { single: () => (_req: unknown, _res: unknown, next: () => void) => next() },
    taskDetailActivityLogLimit: 100,
    validateOptionalModelField: (value: unknown) => typeof value === "string" ? value : undefined,
    normalizeModelSelectionPair: (provider?: string, modelId?: string) => ({ provider: provider ?? null, modelId: modelId ?? null }),
    runGitCommand: async () => "",
    trimTaskDetailActivityLog: (item: unknown) => item,
    triggerCommentWakeForAssignedAgent: async () => {},
  } as never);

  const app = express();
  app.use(express.json());
  app.use("/api", router);
  app.use((_req, res) => res.status(404).json({ error: "Not found" }));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const apiError = error instanceof ApiError ? error : new ApiError(500, String(error));
    sendErrorResponse(res, apiError.statusCode, apiError.message, { details: apiError.details });
  });
  return app;
}

describe("GET /tasks/done pagination", () => {
  it("returns the exact total with the default bounded page", async () => {
    const listCompletedTasks = vi.fn(async () => ({ tasks: [], total: 1_284, hasMore: true }));
    const response = await request(buildApp({ listCompletedTasks } as unknown as TaskStore), "GET", "/api/tasks/done");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ tasks: [], total: 1_284, hasMore: true });
    expect(listCompletedTasks).toHaveBeenCalledWith({ limit: undefined, cursor: undefined, slim: true, sort: undefined });
  });

  it("forwards pagination and rejects invalid values before reading the store", async () => {
    const listCompletedTasks = vi.fn(async () => ({ tasks: [], total: 0, hasMore: false }));
    const app = buildApp({ listCompletedTasks } as unknown as TaskStore);

    expect((await request(app, "GET", "/api/tasks/done?limit=50&cursor=opaque")).status).toBe(200);
    expect(listCompletedTasks).toHaveBeenCalledWith({ limit: 50, cursor: "opaque", slim: true, sort: undefined });
    expect((await request(app, "GET", "/api/tasks/done?limit=0")).status).toBe(400);
    expect((await request(app, "GET", "/api/tasks/done?limit=-1")).status).toBe(400);
    expect(listCompletedTasks).toHaveBeenCalledTimes(1);
  });

  it("validates and forwards the selected server sort", async () => {
    const listCompletedTasks = vi.fn(async () => ({ tasks: [], total: 0, hasMore: false }));
    const app = buildApp({ listCompletedTasks } as unknown as TaskStore);

    expect((await request(app, "GET", "/api/tasks/done?sort=task-id-desc")).status).toBe(200);
    expect(listCompletedTasks).toHaveBeenCalledWith({
      limit: undefined,
      cursor: undefined,
      slim: true,
      sort: "task-id-desc",
    });
    expect((await request(app, "GET", "/api/tasks/done?sort=oldest")).status).toBe(400);
    expect(listCompletedTasks).toHaveBeenCalledTimes(1);
  });

  it("maps a malformed or scope-mismatched opaque cursor to 400", async () => {
    const listCompletedTasks = vi.fn(async () => { throw new TypeError("Invalid completed-task cursor"); });
    const response = await request(buildApp({ listCompletedTasks } as unknown as TaskStore), "GET", "/api/tasks/done?cursor=bad");
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: "Invalid completed-task cursor" });
  });

  it("does not expose removed archive endpoints", async () => {
    const store = {
      getTask: vi.fn(async (id: string) => { throw new TaskNotFoundError(id); }),
    } as unknown as TaskStore;
    const app = buildApp(store);

    expect((await request(app, "GET", "/api/tasks/archived")).status).toBe(404);
    expect((await request(app, "POST", "/api/tasks/FN-1/archive")).status).toBe(404);
    expect((await request(app, "POST", "/api/tasks/FN-1/unarchive")).status).toBe(404);
    expect((await request(app, "POST", "/api/tasks/archive-all-done")).status).toBe(404);
  });
});

describe("GET /tasks/page pagination", () => {
  it("returns bounded page metadata and forwards the exclusive cursor", async () => {
    const listCurrentTasksPage = vi.fn(async () => ({ tasks: [], total: 1_000, hasMore: true, nextCursor: "next" }));
    const response = await request(buildApp({ listCurrentTasksPage } as unknown as TaskStore), "GET", "/api/tasks/page?limit=75&cursor=opaque");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ tasks: [], total: 1_000, hasMore: true, nextCursor: "next" });
    expect(listCurrentTasksPage).toHaveBeenCalledWith({ limit: 75, cursor: "opaque" });
  });

  it("forwards a trimmed search scope to the same bounded page reader", async () => {
    const listCurrentTasksPage = vi.fn(async () => ({ tasks: [], total: 0, hasMore: false, nextCursor: null }));
    const response = await request(buildApp({ listCurrentTasksPage } as unknown as TaskStore), "GET", "/api/tasks/page?limit=25&q=%20incident%20");
    expect(response.status).toBe(200);
    expect(listCurrentTasksPage).toHaveBeenCalledWith({ limit: 25, query: "incident" });
  });

  it.each(["limit=0", "limit=201", "limit=nope", "limit=1.5"])("rejects invalid input before reading the store: %s", async (query) => {
    const listCurrentTasksPage = vi.fn();
    const response = await request(buildApp({ listCurrentTasksPage } as unknown as TaskStore), "GET", `/api/tasks/page?${query}`);
    expect(response.status).toBe(400);
    expect(listCurrentTasksPage).not.toHaveBeenCalled();
  });

  it("maps a malformed cursor to 400", async () => {
    const listCurrentTasksPage = vi.fn(async () => { throw new TypeError("Invalid task list cursor"); });
    const response = await request(buildApp({ listCurrentTasksPage } as unknown as TaskStore), "GET", "/api/tasks/page?cursor=bad");
    expect(response.status).toBe(400);
  });
});
