// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import express from "express";
import type { Task, TaskStore } from "@fusion/core";
import { ApiError, sendErrorResponse } from "../api-error.js";
import { registerTaskWorkflowRoutes } from "../routes/register-task-workflow-routes.js";
import { request as performRequest } from "../test-request.js";

function makeTask(id: string, patch: Partial<Task> = {}): Task {
  return { id, title: id, description: id, column: "todo", dependencies: [], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", ...patch } as Task;
}

function buildApp(tasks: Task[]) {
  const store = {
    getTask: async (id: string) => tasks.find((task) => task.id === id),
    getTaskDetail: async (id: string) => tasks.find((task) => task.id === id),
    getSettings: async () => ({}),
    parseFileScopeFromPrompt: async (id: string) => id === "FN-2" ? ["src/*"] : ["src/a.ts"],
  } as unknown as TaskStore;
  const logger = { warn: vi.fn(), error: vi.fn(), log: vi.fn() };
  const router = express.Router();
  registerTaskWorkflowRoutes({
    router, store, options: {}, runtimeLogger: logger as never, planningLogger: logger as never, chatLogger: logger as never,
    getProjectIdFromRequest: () => undefined, getScopedStore: async () => store,
    getProjectContext: async () => ({ store, engine: undefined as never, projectId: "p-1" }),
    prioritizeProjectsForCurrentDirectory: (projects: unknown) => projects, emitRemoteRouteDiagnostic: () => {}, emitAuthSyncAuditLog: () => {}, parseScopeParam: () => undefined,
    resolveAutomationStore: () => ({}) as never, resolveRoutineStore: () => ({}) as never, resolveRoutineRunner: () => ({}) as never,
    registerDispose: () => {}, dispose: () => {}, rethrowAsApiError: (error: unknown): never => { throw error; },
  } as never, {
    runtimeLogger: logger, upload: { single: () => (_req: unknown, _res: unknown, next: () => void) => next() }, taskDetailActivityLogLimit: 100,
    validateOptionalModelField: (value: unknown) => typeof value === "string" ? value : undefined,
    normalizeModelSelectionPair: (provider: string | null, modelId: string | null) => ({ provider: provider ?? null, modelId: modelId ?? null }),
    runGitCommand: async () => "", isGitRepo: async () => true, resolveIntegrationBranch: async () => "main", trimTaskDetailActivityLog: (task: unknown) => task,
    triggerCommentWakeForAssignedAgent: async () => {}, resolveSelfHealingManager: () => undefined,
  } as never);
  const app = express(); app.use("/api", router); app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = error instanceof ApiError ? error.statusCode : 500;
    sendErrorResponse(res, status, error instanceof Error ? error.message : "Internal server error");
  });
  return app;
}

describe("GET /tasks/:id/overlap-blocker", () => {
  it("returns matching paths and scope counts", async () => {
    const app = buildApp([makeTask("FN-1", { overlapBlockedBy: "FN-2" }), makeTask("FN-2", { column: "in-progress" })]);
    const response = await performRequest(app, "GET", "/api/tasks/FN-1/overlap-blocker");
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ taskScopeCount: 1, blockerScopeCount: 1, overlaps: [{ path: "src/a.ts", blockerPath: "src/*" }] });
  });

  it("reports no blocker without failing", async () => {
    const response = await performRequest(buildApp([makeTask("FN-1")]), "GET", "/api/tasks/FN-1/overlap-blocker");
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ reason: "no-overlap-blocker", overlaps: [] });
  });

  it("returns 404 for unknown tasks", async () => {
    const response = await performRequest(buildApp([]), "GET", "/api/tasks/FN-missing/overlap-blocker");
    expect(response.status).toBe(404);
  });
});
