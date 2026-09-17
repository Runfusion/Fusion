// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import express from "express";
import type { Task, TaskStore } from "@fusion/core";
import { ApiError, sendErrorResponse } from "../api-error.js";
import { registerTaskWorkflowRoutes } from "../routes/register-task-workflow-routes.js";
import { request as performRequest } from "../test-request.js";

/*
FNXC:TaskQueueOrder 2026-09-17-12:07:
FN-509's Boost endpoint contract, exercised through the REAL route registrar so the project scoping,
the precondition parsing and the refusal-to-status mapping are the production ones.

The two-project case matters because task ids are reused across projects on a shared database: a
boost aimed at project A must never reach project B's identically-named card.
*/

function makeTask(id: string, patch: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    description: id,
    column: "todo",
    dependencies: [],
    createdAt: "2026-09-17T10:00:00.000Z",
    updatedAt: "2026-09-17T10:00:00.000Z",
    columnMovedAt: "2026-09-17T10:00:00.000Z",
    ...patch,
  } as Task;
}

interface Harness {
  app: express.Express;
  boostTask: ReturnType<typeof vi.fn>;
  listTaskQueuePage: ReturnType<typeof vi.fn>;
  listCurrentTasksPage: ReturnType<typeof vi.fn>;
}

function buildApp(options: {
  tasksByProject: Record<string, Task[]>;
  boostResult?: (id: string, input: unknown) => unknown;
  defaultProjectId?: string;
}): Harness {
  const boostTask = vi.fn(async (id: string, input: unknown) => {
    if (options.boostResult) return options.boostResult(id, input);
    const project = options.tasksByProject[options.defaultProjectId ?? "p-1"] ?? [];
    const task = project.find((candidate) => candidate.id === id);
    return { ok: true, task: { ...task, queueBoost: { sequence: "7", workflowId: "builtin:coding", column: task?.column, columnEntryAt: task?.columnMovedAt, requestId: (input as { requestId: string }).requestId } }, boost: { sequence: "7" }, idempotent: false };
  });

  const listTaskQueuePage = vi.fn(async () => ({ tasks: [], total: 0, hasMore: false, nextCursor: null }));
  const listCurrentTasksPage = vi.fn(async () => ({ tasks: [], total: 0, hasMore: false, nextCursor: null }));

  const storeFor = (projectId: string): TaskStore => ({
    listTaskQueuePage,
    listCurrentTasksPage,
    getTask: async (id: string) => (options.tasksByProject[projectId] ?? []).find((task) => task.id === id),
    getTaskDetail: async (id: string) => (options.tasksByProject[projectId] ?? []).find((task) => task.id === id),
    getSettings: async () => ({}),
    getTaskWorkflowSelectionAsync: async () => ({ workflowId: "builtin:coding", stepIds: [] }),
    getDefaultWorkflowId: async () => "builtin:coding",
    boostTask,
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
  app.use(express.json());
  app.use("/api", router);
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = error instanceof ApiError ? error.statusCode : 500;
    sendErrorResponse(res, status, error instanceof Error ? error.message : "Internal server error");
  });
  return { app, boostTask, listTaskQueuePage, listCurrentTasksPage };
}

/*
FNXC:TaskQueueOrder 2026-09-17-13:51:
The lane-scoped board page is the other half of Boost: a rank the database applies before its LIMIT
is worthless if no display request ever asks for that order. These cases prove the route routes a
`columns` request to the lane reader, defaults to the queue order, honours the intake order, and
leaves a scope-free request on the pre-existing generic page.
*/
const body = (extra: Record<string, unknown> = {}) => JSON.stringify({ requestId: "req-1", ...extra });
const JSON_HEADERS = { "Content-Type": "application/json" };

describe("POST /tasks/:id/boost", () => {
  it("boosts a queued card and returns the canonical row", async () => {
    const { app, boostTask } = buildApp({ tasksByProject: { "p-1": [makeTask("FN-1")] } });
    const response = await performRequest(app, "POST", "/api/tasks/FN-1/boost", body(), JSON_HEADERS);
    expect(response.status).toBe(200);
    expect(response.body.queueBoost).toMatchObject({ sequence: "7", requestId: "req-1" });
    expect(boostTask).toHaveBeenCalledWith("FN-1", expect.objectContaining({ requestId: "req-1", workflowId: "builtin:coding" }));
  });

  it("forwards the stay preconditions so a stale click cannot boost a card that moved", async () => {
    const { app, boostTask } = buildApp({ tasksByProject: { "p-1": [makeTask("FN-1")] } });
    await performRequest(
      app,
      "POST",
      "/api/tasks/FN-1/boost",
      body({ expectedColumn: "todo", expectedColumnEntryAt: "2026-09-17T10:00:00.000Z" }),
      JSON_HEADERS,
    );
    expect(boostTask).toHaveBeenCalledWith("FN-1", expect.objectContaining({
      expectedColumn: "todo",
      expectedColumnEntryAt: "2026-09-17T10:00:00.000Z",
    }));
  });

  it("returns 404 for a task this project does not have", async () => {
    const { app, boostTask } = buildApp({ tasksByProject: { "p-1": [] } });
    const response = await performRequest(app, "POST", "/api/tasks/FN-missing/boost", body(), JSON_HEADERS);
    expect(response.status).toBe(404);
    expect(boostTask).not.toHaveBeenCalled();
  });

  it("never reaches another project's identically-named task", async () => {
    const { app, boostTask } = buildApp({
      tasksByProject: { "p-1": [], "p-2": [makeTask("FN-1")] },
      defaultProjectId: "p-1",
    });
    const response = await performRequest(app, "POST", "/api/tasks/FN-1/boost", body(), JSON_HEADERS);
    expect(response.status).toBe(404);
    expect(boostTask).not.toHaveBeenCalled();
  });

  it.each([
    ["active", "already started"],
    ["scope-changed", "left the stay the click targeted"],
    ["no-queue", "sits in a lane with no automatic queue"],
  ])("returns 409 without mutating when the card %s (%s)", async (reason) => {
    const { app } = buildApp({
      tasksByProject: { "p-1": [makeTask("FN-1")] },
      boostResult: () => ({ ok: false, reason }),
    });
    const response = await performRequest(app, "POST", "/api/tasks/FN-1/boost", body(), JSON_HEADERS);
    expect(response.status).toBe(409);
    expect(String(response.body.error)).toContain(reason);
  });

  it("rejects a falsified payload with no requestId rather than minting a rank", async () => {
    const { app, boostTask } = buildApp({ tasksByProject: { "p-1": [makeTask("FN-1")] } });
    for (const payload of [JSON.stringify({}), JSON.stringify({ requestId: "" }), JSON.stringify({ requestId: 7 })]) {
      const response = await performRequest(app, "POST", "/api/tasks/FN-1/boost", payload, JSON_HEADERS);
      expect(response.status).toBe(400);
    }
    expect(boostTask).not.toHaveBeenCalled();
  });

  it("rejects non-string stay preconditions", async () => {
    const { app, boostTask } = buildApp({ tasksByProject: { "p-1": [makeTask("FN-1")] } });
    const response = await performRequest(app, "POST", "/api/tasks/FN-1/boost", body({ expectedColumn: 5 }), JSON_HEADERS);
    expect(response.status).toBe(400);
    expect(boostTask).not.toHaveBeenCalled();
  });

  it("is idempotent for a retried request carrying the same requestId", async () => {
    const seen: string[] = [];
    const { app } = buildApp({
      tasksByProject: { "p-1": [makeTask("FN-1")] },
      boostResult: (_id, input) => {
        const requestId = (input as { requestId: string }).requestId;
        const idempotent = seen.includes(requestId);
        seen.push(requestId);
        return { ok: true, task: makeTask("FN-1"), boost: { sequence: "7" }, idempotent };
      },
    });
    expect((await performRequest(app, "POST", "/api/tasks/FN-1/boost", body(), JSON_HEADERS)).status).toBe(200);
    expect((await performRequest(app, "POST", "/api/tasks/FN-1/boost", body(), JSON_HEADERS)).status).toBe(200);
    // The same id was presented twice and the store recognised the repeat rather than re-ranking.
    expect(seen).toEqual(["req-1", "req-1"]);
  });

  /*
  FNXC:TaskQueueOrder 2026-09-17-13:51:
  The `no-queue` refusal must be PRODUCED by the server, not only mapped when a store happens to
  return it. A Complete lane has no automatic queue, so a direct POST at one is refused before the
  store is ever asked to mint a rank — otherwise a durable rank could be persisted on a card that
  can never be admitted.
  */
  it("produces the no-queue refusal itself for a lane with no automatic processing", async () => {
    const { app, boostTask } = buildApp({ tasksByProject: { "p-1": [makeTask("FN-1", { column: "done" })] } });
    const response = await performRequest(app, "POST", "/api/tasks/FN-1/boost", body(), JSON_HEADERS);
    expect(response.status).toBe(409);
    expect(String(response.body.error)).toContain("no-queue");
    expect(boostTask).not.toHaveBeenCalled();
  });

  it("still admits a real processing lane through the same precondition", async () => {
    const { app, boostTask } = buildApp({ tasksByProject: { "p-1": [makeTask("FN-1", { column: "in-progress" })] } });
    expect((await performRequest(app, "POST", "/api/tasks/FN-1/boost", body(), JSON_HEADERS)).status).toBe(200);
    expect(boostTask).toHaveBeenCalledTimes(1);
  });

  it("lifts no guard: the route performs no pause, retry, move, or start call", async () => {
    const forbidden = {
      pauseTask: vi.fn(),
      moveTask: vi.fn(),
      retryTask: vi.fn(),
      updateTask: vi.fn(),
    };
    const { app } = buildApp({ tasksByProject: { "p-1": [makeTask("FN-1", { paused: true, blockedBy: "FN-9" })] } });
    Object.assign(app, forbidden);
    const response = await performRequest(app, "POST", "/api/tasks/FN-1/boost", body(), JSON_HEADERS);
    expect(response.status).toBe(200);
    for (const spy of Object.values(forbidden)) expect(spy).not.toHaveBeenCalled();
  });
});

describe("GET /tasks/page lane scope", () => {
  const harness = () => buildApp({ tasksByProject: { "p-1": [makeTask("FN-1")] } });

  it("routes a columns request to the lane reader in queue order by default", async () => {
    const { app, listTaskQueuePage, listCurrentTasksPage } = harness();
    const response = await performRequest(app, "GET", "/api/tasks/page?columns=todo&limit=25");
    expect(response.status).toBe(200);
    expect(listCurrentTasksPage).not.toHaveBeenCalled();
    expect(listTaskQueuePage).toHaveBeenCalledWith(expect.objectContaining({ columns: ["todo"], limit: 25 }));
    // No explicit order means the server's queue default, not a silently different one.
    expect(listTaskQueuePage.mock.calls[0]?.[0]).not.toHaveProperty("order");
  });

  it("honours the manual-intake order and multi-column scopes", async () => {
    const { app, listTaskQueuePage } = harness();
    await performRequest(app, "GET", "/api/tasks/page?columns=ideas,inbox&order=intake");
    expect(listTaskQueuePage).toHaveBeenCalledWith(expect.objectContaining({ columns: ["ideas", "inbox"], order: "intake" }));
  });

  it("keeps a scope-free request on the generic board page", async () => {
    const { app, listTaskQueuePage, listCurrentTasksPage } = harness();
    await performRequest(app, "GET", "/api/tasks/page?limit=100");
    expect(listTaskQueuePage).not.toHaveBeenCalled();
    expect(listCurrentTasksPage).toHaveBeenCalledTimes(1);
  });

  it("rejects an unknown order and a scope combined with a text query", async () => {
    const { app, listTaskQueuePage } = harness();
    expect((await performRequest(app, "GET", "/api/tasks/page?columns=todo&order=oldest")).status).toBe(400);
    expect((await performRequest(app, "GET", "/api/tasks/page?columns=todo&q=incident")).status).toBe(400);
    expect(listTaskQueuePage).not.toHaveBeenCalled();
  });

  it("answers 400 rather than 500 for a cursor minted under another lane or order", async () => {
    const { app, listTaskQueuePage } = harness();
    listTaskQueuePage.mockRejectedValueOnce(new TypeError("Invalid task queue cursor"));
    const response = await performRequest(app, "GET", "/api/tasks/page?columns=todo&cursor=stale");
    expect(response.status).toBe(400);
  });
});
