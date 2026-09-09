// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import express from "express";
import type { TaskStore } from "@fusion/core";
import { registerTaskWorkflowRoutes } from "../register-task-workflow-routes.js";
import { request } from "../../test-request.js";
import { ApiError, sendErrorResponse } from "../../api-error.js";

function buildApp(store: TaskStore) {
  const router = express.Router();
  const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
  registerTaskWorkflowRoutes({
    router,
    store,
    options: {},
    runtimeLogger: logger,
    planningLogger: logger,
    chatLogger: logger,
    getProjectIdFromRequest: () => undefined,
    getScopedStore: async () => store,
    getProjectContext: async () => ({ store, engine: undefined, projectId: "project-a" }),
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
    runtimeLogger: logger,
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

describe("GET /tasks/page search pagination", () => {
  it("forwards a bounded search scope and its opaque continuation cursor", async () => {
    const listCurrentTasksPage = vi.fn(async () => ({ tasks: [], total: 1_000, hasMore: true, nextCursor: "next" }));
    const response = await request(
      buildApp({ listCurrentTasksPage } as unknown as TaskStore),
      "GET",
      "/api/tasks/page?limit=50&q=incident&cursor=opaque",
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ tasks: [], total: 1_000, hasMore: true, nextCursor: "next" });
    expect(listCurrentTasksPage).toHaveBeenCalledWith({ limit: 50, query: "incident", cursor: "opaque" });
  });

  it("rejects invalid limits without reading the store", async () => {
    const listCurrentTasksPage = vi.fn();
    const response = await request(buildApp({ listCurrentTasksPage } as unknown as TaskStore), "GET", "/api/tasks/page?limit=500&q=incident");
    expect(response.status).toBe(400);
    expect(listCurrentTasksPage).not.toHaveBeenCalled();
  });
});
