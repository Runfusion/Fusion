// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import express from "express";
import type { TaskStore } from "@fusion/core";
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
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const apiError = error instanceof ApiError ? error : new ApiError(500, String(error));
    sendErrorResponse(res, apiError.statusCode, apiError.message, { details: apiError.details });
  });
  return app;
}

describe("GET /tasks/archived sort contract", () => {
  it("defaults to arrival order and passes the project scope", async () => {
    const listArchivedTasks = vi.fn(async () => ({ tasks: [], total: 0, hasMore: false }));
    const response = await request(buildApp({ listArchivedTasks } as unknown as TaskStore), "GET", "/api/tasks/archived");

    expect(response.status).toBe(200);
    expect(listArchivedTasks).toHaveBeenCalledWith({ limit: undefined, offset: undefined, slim: true, sort: "completion-date-desc" });
  });

  it("passes task-id order and rejects invalid or repeated values before the store", async () => {
    const listArchivedTasks = vi.fn(async () => ({ tasks: [], total: 0, hasMore: false }));
    const app = buildApp({ listArchivedTasks } as unknown as TaskStore, "project-b");

    const valid = await request(app, "GET", "/api/tasks/archived?sort=task-id-desc&limit=100&offset=100");
    expect(valid.status).toBe(200);
    expect(listArchivedTasks).toHaveBeenCalledWith({ limit: 100, offset: 100, slim: true, sort: "task-id-desc" });

    const invalid = await request(app, "GET", "/api/tasks/archived?sort=priority");
    const repeated = await request(app, "GET", "/api/tasks/archived?sort=task-id-desc&sort=completion-date-desc");
    expect(invalid.status).toBe(400);
    expect(repeated.status).toBe(400);
    expect(listArchivedTasks).toHaveBeenCalledTimes(1);
  });
});
