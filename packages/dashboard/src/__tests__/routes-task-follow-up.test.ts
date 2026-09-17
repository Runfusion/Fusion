// @vitest-environment node
/*
FNXC:TaskFollowUp 2026-09-17-17:40:
FN-513's follow-up endpoint, exercised through the REAL route registrar so the project scoping, the
request-text bounds and the typed-refusal-to-status mapping are the production ones.

The two-project case matters because task ids are reused across projects on a shared database: a
follow-up aimed at project A must never create a child from project B's identically-named card.
*/
import { describe, expect, it, vi } from "vitest";
import express from "express";
import { FollowUpIneligibleError, MAX_TASK_MESSAGE_LENGTH, type Task, type TaskStore } from "@fusion/core";
import { ApiError, sendErrorResponse } from "../api-error.js";
import { registerTaskWorkflowRoutes } from "../routes/register-task-workflow-routes.js";
import { request as performRequest } from "../test-request.js";

function makeTask(id: string, patch: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    description: id,
    column: "in-progress",
    dependencies: [],
    createdAt: "2026-09-17T10:00:00.000Z",
    updatedAt: "2026-09-17T10:00:00.000Z",
    columnMovedAt: "2026-09-17T10:00:00.000Z",
    ...patch,
  } as Task;
}

interface Harness {
  app: express.Express;
  refineTask: ReturnType<typeof vi.fn>;
  logEntry: ReturnType<typeof vi.fn>;
}

function buildApp(options: {
  tasksByProject?: Record<string, Task[]>;
  refineResult?: (id: string, feedback: string, opts: unknown) => unknown;
  defaultProjectId?: string;
} = {}): Harness {
  const tasksByProject = options.tasksByProject ?? { "p-1": [makeTask("FN-1")] };
  const refineTask = vi.fn(async (id: string, feedback: string, opts?: unknown) => {
    if (options.refineResult) return options.refineResult(id, feedback, opts);
    return makeTask("FN-2", {
      column: "todo",
      dependencies: [id],
      description: `${feedback}\n\nFollows up on: ${id}`,
      sourceType: "task_refine",
      sourceParentTaskId: id,
      sourceMetadata: { followUp: { version: 1 } },
    } as Partial<Task>);
  });
  const logEntry = vi.fn(async () => undefined);

  const storeFor = (projectId: string): TaskStore => ({
    getTask: async (id: string) => (tasksByProject[projectId] ?? []).find((task) => task.id === id),
    getTaskDetail: async (id: string) => (tasksByProject[projectId] ?? []).find((task) => task.id === id),
    getSettings: async () => ({}),
    getTaskWorkflowSelectionAsync: async () => ({ workflowId: "builtin:coding", stepIds: [] }),
    getDefaultWorkflowId: async () => "builtin:coding",
    refineTask,
    logEntry,
  } as unknown as TaskStore);

  const logger = { warn: vi.fn(), error: vi.fn(), log: vi.fn() };
  const router = express.Router();
  const resolveProjectId = (req: express.Request): string =>
    (req.query.projectId as string | undefined) ?? options.defaultProjectId ?? "p-1";

  registerTaskWorkflowRoutes({
    router,
    store: storeFor(options.defaultProjectId ?? "p-1"),
    options: {},
    runtimeLogger: logger as never,
    planningLogger: logger as never,
    chatLogger: logger as never,
    getProjectIdFromRequest: resolveProjectId,
    getScopedStore: async (req: express.Request) => storeFor(resolveProjectId(req)),
    getProjectContext: async (req: express.Request) => ({
      store: storeFor(resolveProjectId(req)),
      engine: undefined as never,
      projectId: resolveProjectId(req),
    }),
    prioritizeProjectsForCurrentDirectory: (projects: unknown) => projects,
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
    normalizeModelSelectionPair: (provider: string | null, modelId: string | null) => ({ provider: provider ?? null, modelId: modelId ?? null }),
    runGitCommand: async () => "",
    isGitRepo: async () => true,
    resolveIntegrationBranch: async () => "main",
    trimTaskDetailActivityLog: (task: unknown) => task,
    triggerCommentWakeForAssignedAgent: async () => {},
    resolveSelfHealingManager: () => undefined,
  } as never);

  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use("/api", router);
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = error instanceof ApiError ? error.statusCode : 500;
    sendErrorResponse(res, status, error instanceof Error ? error.message : "Internal server error");
  });
  return { app, refineTask, logEntry };
}

const JSON_HEADERS = { "Content-Type": "application/json" };
const body = (feedback: unknown) => JSON.stringify({ feedback });

describe("POST /tasks/:id/follow-up", () => {
  it("creates the child through the follow-up store mode and returns it with 201", async () => {
    const { app, refineTask } = buildApp();
    const response = await performRequest(app, "POST", "/api/tasks/FN-1/follow-up", body("  Add a CSV export  "), JSON_HEADERS);

    expect(response.status).toBe(201);
    expect(response.body.id).toBe("FN-2");
    expect(response.body.dependencies).toEqual(["FN-1"]);
    expect(response.body.sourceMetadata).toEqual({ followUp: { version: 1 } });
    // Trimmed text, and the mode is explicit — a bare two-argument call would be ordinary Refine.
    expect(refineTask).toHaveBeenCalledWith("FN-1", "Add a CSV export", { mode: "follow-up" });
  });

  it("routes an explicitly chosen project and never reaches another project's identically-named task", async () => {
    const { app, refineTask } = buildApp({
      tasksByProject: { "p-1": [], "p-2": [makeTask("FN-1")] },
      defaultProjectId: "p-1",
      refineResult: (id) => {
        throw new FollowUpIneligibleError(id, "source-missing");
      },
    });

    const wrongProject = await performRequest(app, "POST", "/api/tasks/FN-1/follow-up", body("From the wrong project"), JSON_HEADERS);
    expect(wrongProject.status).toBe(404);

    const chosen = await performRequest(app, "POST", "/api/tasks/FN-1/follow-up?projectId=p-2", body("From the right project"), JSON_HEADERS);
    expect(chosen.status).toBe(404);
    // Both requests reached the scoped store for their OWN project; neither crossed over.
    expect(refineTask).toHaveBeenCalledTimes(2);
  });

  it.each([
    [undefined, "absent"],
    [null, "null"],
    ["", "empty"],
    ["   \n\t ", "whitespace only"],
    [42, "not a string"],
    [{ text: "x" }, "an object"],
  ])("rejects an invalid request body (%s) with 400 and no store call", async (feedback) => {
    const { app, refineTask } = buildApp();
    const response = await performRequest(app, "POST", "/api/tasks/FN-1/follow-up", body(feedback), JSON_HEADERS);
    expect(response.status).toBe(400);
    expect(refineTask).not.toHaveBeenCalled();
  });

  it("rejects a request longer than the shared task-message limit", async () => {
    const { app, refineTask } = buildApp();
    const response = await performRequest(
      app,
      "POST",
      "/api/tasks/FN-1/follow-up",
      body("x".repeat(MAX_TASK_MESSAGE_LENGTH + 1)),
      JSON_HEADERS,
    );
    expect(response.status).toBe(400);
    expect(refineTask).not.toHaveBeenCalled();
  });

  it("accepts a request at exactly the shared task-message limit", async () => {
    const { app, refineTask } = buildApp();
    const response = await performRequest(
      app,
      "POST",
      "/api/tasks/FN-1/follow-up",
      body("y".repeat(MAX_TASK_MESSAGE_LENGTH)),
      JSON_HEADERS,
    );
    expect(response.status).toBe(201);
    expect(refineTask).toHaveBeenCalledTimes(1);
  });

  /*
  The refusal mapping is driven by the STORE'S TYPED reason, not by matching a message that names
  English column ids — that message is wrong on every renamed board and unusable as a branch.
  */
  it.each([
    ["source-terminal", 409],
    ["source-manual-intake", 409],
    ["source-column-unsupported", 409],
    ["plan-review-not-approved", 409],
    ["source-deleted", 409],
    ["destination-unavailable", 409],
    ["workflow-selection-changed", 409],
    ["source-missing", 404],
  ] as const)("maps the %s refusal to %i", async (reason, status) => {
    const { app } = buildApp({
      refineResult: (id) => {
        throw new FollowUpIneligibleError(id, reason);
      },
    });
    const response = await performRequest(app, "POST", "/api/tasks/FN-1/follow-up", body("A stale menu click"), JSON_HEADERS);
    expect(response.status).toBe(status);
    expect(String(response.body.error)).toContain(reason);
  });

  it("surfaces an unexpected store failure as 500 rather than a silent success", async () => {
    const { app } = buildApp({
      refineResult: () => {
        throw new Error("connection terminated unexpectedly");
      },
    });
    const response = await performRequest(app, "POST", "/api/tasks/FN-1/follow-up", body("Store is down"), JSON_HEADERS);
    expect(response.status).toBe(500);
  });

  it("never mutates the source: the handler performs no move, pause, retry or log write on it", async () => {
    const { app, logEntry, refineTask } = buildApp();
    await performRequest(app, "POST", "/api/tasks/FN-1/follow-up", body("Leave the parent alone"), JSON_HEADERS);
    expect(logEntry).not.toHaveBeenCalled();
    expect(refineTask).toHaveBeenCalledTimes(1);
  });

  it("leaves the historical /refine route on its exact two-argument contract", async () => {
    const { app, refineTask, logEntry } = buildApp();
    const response = await performRequest(app, "POST", "/api/tasks/FN-1/refine", body("Ordinary refinement"), JSON_HEADERS);
    expect(response.status).toBe(201);
    expect(refineTask).toHaveBeenCalledWith("FN-1", "Ordinary refinement");
    expect(logEntry).toHaveBeenCalledWith("FN-1", "Refinement requested", "Ordinary refinement");
  });
});
