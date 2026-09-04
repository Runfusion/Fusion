// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import express from "express";
import type { Task, TaskStore } from "@fusion/core";
import { registerTaskWorkflowRoutes } from "../routes/register-task-workflow-routes.js";
import { request as performRequest } from "../test-request.js";
import { ApiError, sendErrorResponse } from "../api-error.js";

function completedTask(): Task {
  return {
    id: "FN-255",
    title: "Completed task",
    description: "An operator must be able to reopen a completed step.",
    priority: "normal",
    column: "in-review",
    currentStep: 1,
    dependencies: [],
    steps: [
      { name: "Preflight", status: "done" },
      { name: "Implementation", status: "in-progress" },
    ],
    log: [{ timestamp: "2026-08-29T00:00:00.000Z", action: "Task marked done by agent" }],
    createdAt: "2026-08-29T00:00:00.000Z",
    updatedAt: "2026-08-29T00:00:00.000Z",
  } as Task;
}

function appForStepEdit(task: Task) {
  const updateStep = vi.fn(async (_id: string, index: number, status: Task["steps"][number]["status"], options?: { operatorOverride?: boolean }) => {
    if (options?.operatorOverride) {
      task.log.push({ timestamp: "2026-08-29T00:01:00.000Z", action: `Step ledger reopened — step ${index} (${task.steps[index]!.name}) edited by operator after completion` });
      task.steps[index]!.status = status;
      task.log.push({ timestamp: "2026-08-29T00:01:00.000Z", action: `Step ${index} (${task.steps[index]!.name}) → ${status}` });
    }
    return task;
  });
  const store = {
    getTask: vi.fn(async () => task),
    updateStep,
  } as unknown as TaskStore;
  const logger = { warn: vi.fn(), error: vi.fn(), log: vi.fn() };
  const router = express.Router();

  registerTaskWorkflowRoutes({
    router,
    store,
    options: {},
    runtimeLogger: logger as never,
    planningLogger: logger as never,
    chatLogger: logger as never,
    getProjectIdFromRequest: () => undefined,
    getScopedStore: async () => store,
    getProjectContext: async () => ({ store, engine: undefined as never, projectId: "project-1" }),
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
    runtimeLogger: logger,
    upload: { single: () => (_req: unknown, _res: unknown, next: () => void) => next() },
    taskDetailActivityLogLimit: 100,
    validateOptionalModelField: (value: unknown) => (typeof value === "string" ? value : undefined),
    normalizeModelSelectionPair: (provider: string | null, modelId: string | null) => ({ provider: provider ?? null, modelId: modelId ?? null }),
    runGitCommand: async () => "",
    isGitRepo: async () => true,
    resolveIntegrationBranch: async () => "main",
    trimTaskDetailActivityLog: (value: unknown) => value,
    triggerCommentWakeForAssignedAgent: async () => {},
    resolveSelfHealingManager: () => undefined,
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
  return { app, updateStep };
}

describe("PATCH /api/tasks/:id/steps/:stepIndex", () => {
  it("passes the operator override through a completion seal instead of returning conflict", async () => {
    const { app, updateStep } = appForStepEdit(completedTask());

    const response = await performRequest(
      app,
      "PATCH",
      "/api/tasks/FN-255/steps/1",
      JSON.stringify({ status: "done" }),
      { "content-type": "application/json" },
    );

    expect(response.status).toBe(200);
    expect(updateStep).toHaveBeenCalledWith("FN-255", 1, "done", { operatorOverride: true });
    expect(response.body.steps[1].status).toBe("done");
  });
});
