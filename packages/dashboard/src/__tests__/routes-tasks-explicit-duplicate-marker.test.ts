// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import * as core from "@fusion/core";
import type { Column, Task, TaskStore } from "@fusion/core";
import { registerTaskWorkflowRoutes } from "../routes/register-task-workflow-routes.js";
import { request as performRequest } from "../test-request.js";
import { ApiError, sendErrorResponse } from "../api-error.js";

function mkTask(overrides: Partial<Task> & { id: string; description: string; column: Column }): Task {
  const now = new Date().toISOString();
  return {
    id: overrides.id,
    description: overrides.description,
    column: overrides.column,
    dependencies: [],
    createdAt: now,
    updatedAt: now,
    size: "M",
    subtasks: [],
    log: [],
    tags: [],
    blockedBy: [],
    source: { sourceType: "api" },
    ...overrides,
  } as Task;
}

function buildApp(seed: Task[] = []) {
  const tasks = [...seed];
  const runtimeLogger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
  const store: Partial<TaskStore> = {
    searchTasks: vi.fn().mockResolvedValue(tasks),
    listTasks: vi.fn().mockResolvedValue(tasks),
    getTask: vi.fn().mockImplementation(async (id: string) => tasks.find((task) => task.id === id) ?? null),
    findRecentTasksByContentFingerprint: vi.fn().mockImplementation(async (fingerprint: string) =>
      tasks.filter((task) => task.source?.sourceMetadata?.contentFingerprint === fingerprint),
    ),
    getSettingsFast: vi.fn().mockResolvedValue({ autoSummarizeTitles: false }),
    createTask: vi.fn().mockImplementation(async (input: { title?: string; description: string; source?: Task["source"] }) => {
      const created = mkTask({ id: `FN-${tasks.length + 100}`, title: input.title, description: input.description, column: "todo", source: input.source ?? { sourceType: "api" } });
      tasks.push(created);
      return created;
    }),
    recordActivity: vi.fn().mockResolvedValue(undefined),
  };

  const router = express.Router();
  registerTaskWorkflowRoutes({
    router,
    store: store as TaskStore,
    options: {},
    runtimeLogger: runtimeLogger as never,
    planningLogger: runtimeLogger as never,
    chatLogger: runtimeLogger as never,
    getProjectIdFromRequest: () => undefined,
    getScopedStore: async () => store as TaskStore,
    getProjectContext: async () => ({ store: store as TaskStore, engine: undefined, projectId: "p-1" }),
    prioritizeProjectsForCurrentDirectory: (projects) => projects,
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
  }, {
    runtimeLogger: { error: vi.fn(), warn: runtimeLogger.warn },
    upload: { single: () => (_req: unknown, _res: unknown, next: () => void) => next() },
    taskDetailActivityLogLimit: 100,
    validateOptionalModelField: (value) => (typeof value === "string" ? value : undefined),
    normalizeModelSelectionPair: (provider, modelId) => ({ provider: provider ?? null, modelId: modelId ?? null }),
    runGitCommand: async () => "",
    trimTaskDetailActivityLog: (task) => task,
    triggerCommentWakeForAssignedAgent: async () => {},
  });

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

  return { app, store, tasks, runtimeLogger };
}

describe("routes /api/tasks explicit duplicate marker", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 409 duplicate_candidates when description is an explicit marker", async () => {
    const canonical = mkTask({ id: "FN-42", title: "Canonical", description: "Existing canonical task", column: "todo" });
    const { app, tasks, store } = buildApp([canonical]);

    const res = await performRequest(app, "POST", "/api/tasks", JSON.stringify({ description: "DUPLICATE: FN-42" }), { "content-type": "application/json" });

    expect(res.status).toBe(409);
    expect((res.body as { details: { matches: Array<{ id: string; reason: string }> } }).details.matches[0]).toMatchObject({
      id: canonical.id,
      reason: "explicit-marker",
    });
    expect(tasks).toHaveLength(1);
    expect(store.createTask).not.toHaveBeenCalled();
    expect(store.recordActivity).not.toHaveBeenCalled();
  });

  it("returns 409 when the explicit marker is supplied in the title with blank description padding", async () => {
    const canonical = mkTask({ id: "FN-42", title: "Canonical", description: "Existing canonical task", column: "todo" });
    const { app, tasks } = buildApp([canonical]);
    const res = await performRequest(app, "POST", "/api/tasks", JSON.stringify({ title: "DUPLICATE: FN-42", description: "   " }), { "content-type": "application/json" });
    expect(res.status).toBe(409);
    expect((res.body as { details: { matches: Array<{ id: string; reason: string }> } }).details.matches[0]).toMatchObject({ id: canonical.id, reason: "explicit-marker" });
    expect(tasks).toHaveLength(1);
  });

  it("blocks backtick-wrapped markers", async () => {
    const canonical = mkTask({ id: "FN-42", title: "Canonical", description: "Existing canonical task", column: "todo" });
    const { app } = buildApp([canonical]);
    const res = await performRequest(app, "POST", "/api/tasks", JSON.stringify({ description: "`DUPLICATE: FN-42`" }), { "content-type": "application/json" });
    expect(res.status).toBe(409);
    expect((res.body as { details: { matches: Array<{ id: string; reason: string }> } }).details.matches[0]).toMatchObject({ id: canonical.id, reason: "explicit-marker" });
  });

  it("acknowledgedDuplicates bypasses the explicit-marker guard", async () => {
    const canonical = mkTask({ id: "FN-42", title: "Canonical", description: "Existing canonical task", column: "todo" });
    const { app, tasks, store } = buildApp([canonical]);
    const res = await performRequest(app, "POST", "/api/tasks", JSON.stringify({ description: "DUPLICATE: FN-42", acknowledgedDuplicates: ["FN-42"] }), { "content-type": "application/json" });
    expect(res.status).toBe(201);
    expect(tasks).toHaveLength(2);
    expect(store.recordActivity).not.toHaveBeenCalledWith(expect.objectContaining({
      type: "task:auto-archived-duplicate",
      metadata: expect.objectContaining({ source: "explicit-marker-intake" }),
    }));
  });

  it("bypassDuplicateCheck bypasses the explicit-marker guard", async () => {
    const canonical = mkTask({ id: "FN-42", title: "Canonical", description: "Existing canonical task", column: "todo" });
    const { app, tasks, store } = buildApp([canonical]);
    const res = await performRequest(app, "POST", "/api/tasks", JSON.stringify({ description: "DUPLICATE: FN-42", bypassDuplicateCheck: true }), { "content-type": "application/json" });
    expect(res.status).toBe(201);
    expect(tasks).toHaveLength(2);
    expect(store.recordActivity).not.toHaveBeenCalledWith(expect.objectContaining({
      type: "task:auto-archived-duplicate",
      metadata: expect.objectContaining({ source: "explicit-marker-intake" }),
    }));
  });

  it("fails open when the marker target is missing", async () => {
    const { app, tasks } = buildApp();
    const res = await performRequest(app, "POST", "/api/tasks", JSON.stringify({ description: "DUPLICATE: FN-999" }), { "content-type": "application/json" });
    expect(res.status).toBe(201);
    expect(tasks).toHaveLength(1);
  });

  it("fails open when the marker target is soft-deleted", async () => {
    const canonical = mkTask({ id: "FN-42", title: "Canonical", description: "Existing canonical task", column: "archived", deletedAt: new Date().toISOString() });
    const { app, tasks } = buildApp([canonical]);
    const res = await performRequest(app, "POST", "/api/tasks", JSON.stringify({ description: "DUPLICATE: FN-42" }), { "content-type": "application/json" });
    expect(res.status).toBe(201);
    expect(tasks).toHaveLength(2);
  });

  it("allows a user-authored task to reference a completed duplicate target", async () => {
    const canonical = mkTask({ id: "FN-42", title: "Canonical", description: "Existing canonical task", column: "done" });
    const { app, tasks } = buildApp([canonical]);
    const res = await performRequest(app, "POST", "/api/tasks", JSON.stringify({
      description: "DUPLICATE: FN-42",
      source: { sourceType: "dashboard_ui" },
    }), { "content-type": "application/json" });

    expect(res.status).toBe(201);
    expect(tasks).toHaveLength(2);
  });

  it("allows a programmatic task to reference a completed duplicate target", async () => {
    const canonical = mkTask({ id: "FN-42", title: "Canonical", description: "Existing canonical task", column: "done" });
    const { app, tasks } = buildApp([canonical]);
    const res = await performRequest(app, "POST", "/api/tasks", JSON.stringify({
      description: "DUPLICATE: FN-42",
      source: { sourceType: "api" },
    }), { "content-type": "application/json" });

    expect(res.status).toBe(201);
    expect(tasks).toHaveLength(2);
  });

  it("does not block prose that merely mentions duplicate text", async () => {
    const canonical = mkTask({ id: "FN-42", title: "Canonical", description: "Existing canonical task", column: "todo" });
    const { app, tasks } = buildApp([canonical]);
    const res = await performRequest(app, "POST", "/api/tasks", JSON.stringify({ description: "We thought this was a DUPLICATE: FN-42 but it is not." }), { "content-type": "application/json" });
    expect(res.status).toBe(201);
    expect(tasks).toHaveLength(2);
  });

  it("keeps deterministic matching ahead of the explicit-marker guard", async () => {
    const title = "";
    const description = "DUPLICATE: FN-42";
    const fingerprint = core.computeContentFingerprint({ title, description }) as string;
    const { app } = buildApp([
      mkTask({
        id: "FN-500",
        title,
        description,
        column: "todo",
        source: { sourceType: "api", sourceMetadata: { contentFingerprint: fingerprint } },
      }),
      mkTask({ id: "FN-42", title: "Canonical", description: "Existing canonical task", column: "todo" }),
    ]);

    const res = await performRequest(app, "POST", "/api/tasks", JSON.stringify({ description }), { "content-type": "application/json" });
    expect(res.status).toBe(409);
    expect((res.body as { details: { matches: Array<{ id: string; deterministic?: boolean; reason?: string }> } }).details.matches[0]).toMatchObject({
      id: "FN-500",
      deterministic: true,
    });
  });

  it("fails open when parseExplicitDuplicateMarker throws", async () => {
    const canonical = mkTask({ id: "FN-42", title: "Canonical", description: "Existing canonical task", column: "todo" });
    vi.spyOn(core, "parseExplicitDuplicateMarker").mockImplementation(() => {
      throw new Error("boom");
    });
    const { app, tasks, runtimeLogger } = buildApp([canonical]);

    const res = await performRequest(app, "POST", "/api/tasks", JSON.stringify({ description: "DUPLICATE: FN-42" }), { "content-type": "application/json" });

    expect(res.status).toBe(201);
    expect(tasks).toHaveLength(2);
    expect(runtimeLogger.warn).toHaveBeenCalledWith("Explicit duplicate-marker intake guard failed; proceeding", expect.objectContaining({ error: "boom" }));
  });
});
