// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import express from "express";
import { registerTaskWorkflowRoutes } from "../routes/register-task-workflow-routes.js";
import { request } from "../test-request.js";
import { ApiError, sendErrorResponse } from "../api-error.js";

function buildApp(engine: { getPreMergeAdmissionDecision: (taskId: string) => Promise<unknown> }) {
  const router = express.Router();
  const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
  registerTaskWorkflowRoutes({
    router,
    store: {} as never,
    options: {},
    runtimeLogger: logger,
    planningLogger: logger,
    chatLogger: logger,
    getProjectIdFromRequest: () => undefined,
    getScopedStore: async () => ({}) as never,
    getProjectContext: async () => ({ store: { getTask: async () => ({ id: "FN-9527" }) }, engine, projectId: "project-a" }),
    prioritizeProjectsForCurrentDirectory: (projects: unknown[]) => projects,
    emitRemoteRouteDiagnostic: () => {},
    emitAuthSyncAuditLog: () => {},
    parseScopeParam: () => undefined,
    resolveAutomationStore: () => ({}) as never,
    resolveRoutineStore: () => ({}) as never,
    resolveRoutineRunner: () => ({}) as never,
    registerDispose: () => {},
    dispose: () => {},
    rethrowAsApiError: (error: unknown): never => { throw error; },
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
  app.use("/api", router);
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const apiError = error instanceof ApiError ? error : new ApiError(500, String(error));
    sendErrorResponse(res, apiError.statusCode, apiError.message, { details: apiError.details });
  });
  return app;
}

describe("GET /tasks/:id/workflow-admission", () => {
  it("returns the engine-owned stale-content decision instead of approving a passed raw row", async () => {
    const getPreMergeAdmissionDecision = vi.fn(async () => ({
      gate: { requiredPreMergeStepIds: new Set(["code-review"]), resolution: "selection" },
      decision: {
        allApproved: false,
        gates: [{
          workflowStepId: "code-review",
          state: "stale-content",
          selectedResult: {
            workflowStepId: "code-review",
            status: "passed",
            verdict: "APPROVE",
            reviewInputFingerprint: "old-content",
          },
        }],
      },
    }));

    const response = await request(buildApp({ getPreMergeAdmissionDecision }), "GET", "/api/tasks/FN-9527/workflow-admission");

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      allApproved: false,
      requiredGateIds: ["code-review"],
      resolution: "selection",
      gates: [{ workflowStepId: "code-review", state: "stale-content" }],
    });
    expect(getPreMergeAdmissionDecision).toHaveBeenCalledWith("FN-9527");
  });
});
