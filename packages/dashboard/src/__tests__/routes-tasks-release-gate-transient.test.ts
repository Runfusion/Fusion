// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import * as core from "@fusion/core";
import * as engine from "@fusion/engine";
import type { Task, TaskStore, WorkflowIr } from "@fusion/core";
import { request as performRequest } from "../test-request.js";
import { ApiError, sendErrorResponse } from "../api-error.js";
import { registerTaskWorkflowRoutes } from "../routes/register-task-workflow-routes.js";

const verdict = {
  promoteBlocked: false,
  unplannedForExecution: false,
  blockedOnApproval: false,
  reason: null,
  readyAtCapacityBoundary: true,
  evaluatedAt: "2026-08-13T22:02:00.000Z",
  evaluatedForUpdatedAt: "2026-08-13T22:02:00.000Z",
} as const;

function createTask(id: string): Task {
  return {
    id,
    description: "Release verdict must stay transient",
    column: "todo",
    dependencies: [],
    createdAt: "2026-08-13T22:02:00.000Z",
    updatedAt: "2026-08-13T22:02:00.000Z",
    steps: [],
    log: [],
  } as Task;
}

function buildApp(tasks: Task[]) {
  const store: Partial<TaskStore> = {
    listTasks: vi.fn().mockResolvedValue(tasks),
    getBranchProgressByTask: vi.fn().mockResolvedValue(new Map()),
    getSettingsFast: vi.fn().mockResolvedValue({}),
    getTaskDir: vi.fn().mockReturnValue("/missing-task-dir"),
  };
  const router = express.Router();
  const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
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
    emitRemoteRouteDiagnostic: () => {}, emitAuthSyncAuditLog: () => {}, parseScopeParam: () => undefined,
    resolveAutomationStore: () => ({}) as never, resolveRoutineStore: () => ({}) as never,
    resolveRoutineRunner: () => ({}) as never, registerDispose: () => {}, dispose: () => {},
    rethrowAsApiError: (error: unknown): never => { throw error instanceof ApiError ? error : new ApiError(500, String(error)); },
  }, {
    runtimeLogger: logger as never,
    upload: { single: () => (_req: unknown, _res: unknown, next: () => void) => next() },
    taskDetailActivityLogLimit: 100, validateOptionalModelField: () => undefined,
    normalizeModelSelectionPair: () => ({ provider: null, modelId: null }), runGitCommand: async () => "",
    trimTaskDetailActivityLog: (task) => task, triggerCommentWakeForAssignedAgent: async () => {},
  });
  const app = express();
  app.use("/api", router);
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) =>
    sendErrorResponse(res, error instanceof ApiError ? error.statusCode : 500, error instanceof Error ? error.message : String(error)),
  );
  return { app, store };
}

describe("GET /api/tasks releaseGate enrichment", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns a verdict only in the response, never mutating the stored task", async () => {
    const task = createTask("FN-9029");
    vi.spyOn(core, "resolveProjectColumnsForRoles").mockResolvedValue(new Set(["todo"]));
    vi.spyOn(core, "resolveWorkflowIrForTask").mockResolvedValue({ version: "v2" } as WorkflowIr);
    vi.spyOn(engine, "evaluateTaskReleaseGate").mockResolvedValue(verdict);
    const { app, store } = buildApp([task]);

    const response = await performRequest(app, "GET", "/api/tasks");

    expect(response.status).toBe(200);
    expect((response.body as Task[])[0]).toMatchObject({ id: task.id, releaseGate: verdict });
    expect(task).not.toHaveProperty("releaseGate");
    expect(await store.listTasks?.({ slim: true })).not.toEqual(expect.arrayContaining([expect.objectContaining({ releaseGate: expect.anything() })]));
  });

  it("keeps verdict-less and truncation rows byte-identical", async () => {
    const first = createTask("FN-9029-FIRST");
    const beyondLimit = createTask("FN-9029-BEYOND");
    vi.spyOn(core, "resolveProjectColumnsForRoles").mockResolvedValue(new Set());
    const { app } = buildApp([first, beyondLimit]);

    const response = await performRequest(app, "GET", "/api/tasks");

    expect(response.status).toBe(200);
    expect(response.body).toEqual([first, beyondLimit]);
  });
});
