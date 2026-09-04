// @vitest-environment node

import express from "express";
import { describe, expect, it, vi } from "vitest";
import { DuplicateWorkflowSelectionError } from "@fusion/core";
import { ApiError } from "../api-error.js";
import { registerTaskWorkflowRoutes } from "../routes/register-task-workflow-routes.js";
import { request } from "../test-request.js";

function createApp(duplicateTask: ReturnType<typeof vi.fn>) {
  const app = express();
  const router = express.Router();
  app.use(express.json());
  registerTaskWorkflowRoutes({
    router,
    options: {},
    getProjectContext: vi.fn().mockResolvedValue({ store: { duplicateTask } }),
    rethrowAsApiError: (error: unknown) => { throw error; },
  } as never, {
    runtimeLogger: { error: vi.fn(), warn: vi.fn() },
    upload: { single: vi.fn(() => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next()) },
    taskDetailActivityLogLimit: 100,
    validateOptionalModelField: vi.fn(),
    normalizeModelSelectionPair: vi.fn(),
    runGitCommand: vi.fn(),
    isGitRepo: vi.fn(),
    resolveIntegrationBranch: vi.fn(),
    trimTaskDetailActivityLog: vi.fn(),
    triggerCommentWakeForAssignedAgent: vi.fn(),
    resolveSelfHealingManager: vi.fn(),
  } as never);
  app.use("/api", router);
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const apiError = error instanceof ApiError ? error : new ApiError(500, String(error));
    res.status(apiError.statusCode).json({ error: apiError.message });
  });
  return app;
}

async function post(app: ReturnType<typeof createApp>, body?: unknown) {
  return request(
    app,
    "POST",
    "/api/tasks/FN-001/duplicate",
    body === undefined ? undefined : JSON.stringify(body),
    body === undefined ? {} : { "content-type": "application/json" },
  );
}

describe("POST /api/tasks/:id/duplicate workflow routing", () => {
  it("forwards no options when the request has no workflow", async () => {
    const duplicateTask = vi.fn().mockResolvedValue({ id: "FN-002" });
    expect((await post(createApp(duplicateTask))).status).toBe(201);
    expect(duplicateTask).toHaveBeenCalledWith("FN-001", undefined);
  });

  it("forwards a concrete trimmed workflow id", async () => {
    const duplicateTask = vi.fn().mockResolvedValue({ id: "FN-002" });
    expect((await post(createApp(duplicateTask), { workflowId: " wf-b " })).status).toBe(201);
    expect(duplicateTask).toHaveBeenCalledWith("FN-001", { workflowId: "wf-b" });
  });

  it.each([{ workflowId: null }, { workflowId: "" }, { workflowId: "  " }, { workflowId: "__all_workflows__" }])(
    "treats $workflowId as an absent workflow request",
    async (body) => {
      const duplicateTask = vi.fn().mockResolvedValue({ id: "FN-002" });
      expect((await post(createApp(duplicateTask), body)).status).toBe(201);
      expect(duplicateTask).toHaveBeenCalledWith("FN-001", undefined);
    },
  );

  it("rejects a non-string workflow id", async () => {
    const duplicateTask = vi.fn();
    const response = await post(createApp(duplicateTask), { workflowId: 42 });
    expect(response.status).toBe(400);
    expect(duplicateTask).not.toHaveBeenCalled();
  });

  it("maps an unavailable workflow rejection to 400 and names the id", async () => {
    const duplicateTask = vi.fn().mockRejectedValue(new DuplicateWorkflowSelectionError("wf-retired"));
    const response = await post(createApp(duplicateTask), { workflowId: "wf-retired" });
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: expect.stringContaining("wf-retired") });
  });
});
