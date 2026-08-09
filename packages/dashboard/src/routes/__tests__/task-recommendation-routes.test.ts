// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Column, Task, TaskStore } from "@fusion/core";
import * as taskWorkflowRoutes from "../register-task-workflow-routes.js";
import { request as performRequest } from "../../test-request.js";
import { ApiError, sendErrorResponse } from "../../api-error.js";

const { registerTaskWorkflowRoutes } = taskWorkflowRoutes;
const locks = (taskWorkflowRoutes as { __fingerprintCreateLocksForTests?: Map<string, Promise<unknown>> }).__fingerprintCreateLocksForTests;

function task(overrides: Partial<Task> & { id: string; description: string; column: Column }): Task {
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

function buildApp(seed: Task[], projectId = "project-a") {
  const tasks = [...seed];
  const store: Partial<TaskStore> = {
    getTask: vi.fn(async (id: string) => tasks.find((item) => item.id === id && !item.deletedAt) ?? null),
    listTasks: vi.fn(async (options?: { includeDeleted?: boolean }) =>
      tasks.filter((item) => options?.includeDeleted || !item.deletedAt),
    ),
    searchTasks: vi.fn(async () => tasks.filter((item) => !item.deletedAt)),
    findRecentTasksByContentFingerprint: vi.fn(async () => []),
    getSettingsFast: vi.fn(async () => ({ autoSummarizeTitles: false })),
    getRootDir: () => process.cwd(),
    createTask: vi.fn(async (input: { title?: string; description: string; source?: Task["source"]; proposalClaimId?: string }) => {
      const created = task({
        id: `FN-${tasks.length + 100}`,
        title: input.title,
        description: input.description,
        column: "todo",
        source: input.source ?? { sourceType: "api" },
        proposalClaimId: input.proposalClaimId,
      });
      tasks.push(created);
      return created;
    }),
    updateTask: vi.fn(async (id: string, updates: Partial<Task> & { sourceMetadataPatch?: Record<string, unknown> }) => {
      const index = tasks.findIndex((item) => item.id === id);
      if (index < 0) throw new Error("Task not found");
      const { sourceMetadataPatch, ...taskUpdates } = updates;
      tasks[index] = {
        ...tasks[index],
        ...taskUpdates,
        ...(sourceMetadataPatch ? { sourceMetadata: { ...tasks[index]!.sourceMetadata, ...sourceMetadataPatch } } : {}),
      };
      return tasks[index];
    }),
    moveTask: vi.fn(async (id: string, column: Column) => {
      const index = tasks.findIndex((item) => item.id === id);
      if (index < 0) throw new Error("Task not found");
      tasks[index] = { ...tasks[index], column };
      return tasks[index];
    }),
    unarchiveTask: vi.fn(async (id: string) => {
      const index = tasks.findIndex((item) => item.id === id);
      if (index < 0) throw new Error("Task not found");
      tasks[index] = { ...tasks[index], column: "todo" };
      return tasks[index];
    }),
    linkTaskRecommendation: vi.fn(async (id: string, recommendationId: string, createdTaskId: string, completeColumns?: ReadonlySet<string>) => {
      const index = tasks.findIndex((item) => item.id === id);
      if (index < 0) throw new Error("Task not found");
      if (completeColumns && !completeColumns.has(tasks[index]!.column)) {
        throw new Error("Recommendations are available only on completed tasks");
      }
      const recommendations = tasks[index]!.recommendations?.map((item) => {
        if (item.id !== recommendationId) return item;
        if (item.createdTaskId && item.createdTaskId !== createdTaskId) throw new Error("Recommendation is already linked to another task");
        return { ...item, createdTaskId };
      });
      if (!recommendations?.some((item) => item.id === recommendationId)) throw new Error("Recommendation no longer exists");
      tasks[index] = { ...tasks[index]!, recommendations };
      return tasks[index]!;
    }),
    recordActivity: vi.fn(async () => undefined),
  };
  const runtimeLogger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
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
    getProjectContext: async () => ({ store: store as TaskStore, engine: undefined, projectId }),
    prioritizeProjectsForCurrentDirectory: (projects) => projects,
    emitRemoteRouteDiagnostic: () => {}, emitAuthSyncAuditLog: () => {}, parseScopeParam: () => undefined,
    resolveAutomationStore: () => ({}) as never, resolveRoutineStore: () => ({}) as never, resolveRoutineRunner: () => ({}) as never,
    registerDispose: () => {}, dispose: () => {},
    rethrowAsApiError: (error: unknown): never => { throw error instanceof ApiError ? error : new ApiError(500, String(error)); },
  }, {
    runtimeLogger: { error: vi.fn(), warn: runtimeLogger.warn },
    upload: { single: () => (_req: unknown, _res: unknown, next: () => void) => next() },
    taskDetailActivityLogLimit: 100,
    validateOptionalModelField: (value) => typeof value === "string" ? value : undefined,
    normalizeModelSelectionPair: (provider, modelId) => ({ provider: provider ?? null, modelId: modelId ?? null }),
    runGitCommand: async () => "", trimTaskDetailActivityLog: (item) => item,
    triggerCommentWakeForAssignedAgent: async () => {},
  });
  const app = express();
  app.use(express.json());
  app.use("/api", router);
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const apiError = error instanceof ApiError ? error : new ApiError(500, String(error));
    sendErrorResponse(res, apiError.statusCode, apiError.message, { details: apiError.details });
  });
  return { app, store, tasks };
}

function parent(overrides: Partial<Task> = {}): Task {
  return task({
    id: "FN-1", description: "Complete the current task", column: "done",
    recommendations: [{ id: "rec-1", title: "Add task export", description: "Add CSV export outside this task's scope.", category: "feature" }],
    ...overrides,
  });
}

describe("recommendation task creation route", () => {
  beforeEach(() => locks?.clear());
  afterEach(() => { locks?.clear(); vi.restoreAllMocks(); });

  it("creates and links exactly one child on concurrent clicks through guarded intake", async () => {
    const { app, store, tasks } = buildApp([parent()]);
    const [first, second] = await Promise.all([
      performRequest(app, "POST", "/api/tasks/FN-1/recommendations/rec-1/create", undefined),
      performRequest(app, "POST", "/api/tasks/FN-1/recommendations/rec-1/create", undefined),
    ]);

    expect([first.status, second.status]).toEqual([201, 200]);
    expect(store.createTask).toHaveBeenCalledTimes(1);
    const children = tasks.filter((item) => item.id !== "FN-1");
    expect(children).toHaveLength(1);
    expect(children[0]).toMatchObject({ proposalClaimId: "recommendation:FN-1:rec-1", source: { sourceParentTaskId: "FN-1" } });
    expect(tasks[0]?.recommendations?.[0]?.createdTaskId).toBe(children[0]?.id);
  });

  /*
  FNXC:TaskRecommendations 2026-08-08-08:10:
  Recommendation parent and row IDs are only project-scoped identities. A slow create in one
  project must not hold the idempotency key for an identical lineage in another project, and a
  failed create must release both its recommendation and guarded-intake locks for a later retry.
  */
  it("does not serialize identical parent and recommendation IDs across projects", async () => {
    let releaseProjectA: (() => void) | undefined;
    const projectAStarted = new Promise<void>((resolve) => { releaseProjectA = resolve; });
    let markProjectAStarted: (() => void) | undefined;
    const projectAIsCreating = new Promise<void>((resolve) => { markProjectAStarted = resolve; });
    const projectA = buildApp([parent()], "project-a");
    const projectB = buildApp([parent()], "project-b");
    (projectA.store.createTask as ReturnType<typeof vi.fn>).mockImplementationOnce(async (input) => {
      markProjectAStarted?.();
      await projectAStarted;
      const created = task({
        id: "FN-101", title: input.title, description: input.description, column: "todo",
        source: input.source ?? { sourceType: "api" }, proposalClaimId: input.proposalClaimId,
      });
      projectA.tasks.push(created);
      return created;
    });

    const pendingProjectA = performRequest(projectA.app, "POST", "/api/tasks/FN-1/recommendations/rec-1/create", undefined);
    await projectAIsCreating;
    const projectBResponse = await performRequest(projectB.app, "POST", "/api/tasks/FN-1/recommendations/rec-1/create", undefined);
    releaseProjectA?.();
    const projectAResponse = await pendingProjectA;

    expect(projectBResponse.status).toBe(201);
    expect(projectAResponse.status).toBe(201);
    expect(projectA.tasks).toHaveLength(2);
    expect(projectB.tasks).toHaveLength(2);
    expect(projectA.tasks[1]).toMatchObject({ proposalClaimId: "recommendation:FN-1:rec-1" });
    expect(projectB.tasks[1]).toMatchObject({ proposalClaimId: "recommendation:FN-1:rec-1" });
  });

  it("releases idempotency and intake locks after task creation fails", async () => {
    const { app, store, tasks } = buildApp([parent()]);
    (store.createTask as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error("storage unavailable"))
      .mockImplementationOnce(async (input) => {
        const created = task({
          id: "FN-101", title: input.title, description: input.description, column: "todo",
          source: input.source ?? { sourceType: "api" }, proposalClaimId: input.proposalClaimId,
        });
        tasks.push(created);
        return created;
      });

    const failed = await performRequest(app, "POST", "/api/tasks/FN-1/recommendations/rec-1/create", undefined);
    const retried = await performRequest(app, "POST", "/api/tasks/FN-1/recommendations/rec-1/create", undefined);

    expect(failed.status).toBe(500);
    expect(retried.status).toBe(201);
    expect(store.createTask).toHaveBeenCalledTimes(2);
    expect(tasks[0]?.recommendations?.[0]?.createdTaskId).toBe("FN-101");
  });

  it("preserves every parent link when separate recommendations create concurrently", async () => {
    const { app, store, tasks } = buildApp([parent({ recommendations: [
      ...parent().recommendations!,
      { id: "rec-2", title: "Improve task filters", description: "Add saved filters outside this task's scope.", category: "improvement" },
    ] })]);
    (store.searchTasks as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const [first, second] = await Promise.all([
      performRequest(app, "POST", "/api/tasks/FN-1/recommendations/rec-1/create", undefined),
      performRequest(app, "POST", "/api/tasks/FN-1/recommendations/rec-2/create", undefined),
    ]);

    expect([first.status, second.status]).toEqual([201, 201]);
    expect(store.createTask).toHaveBeenCalledTimes(2);
    expect(tasks[0]?.recommendations?.map((item) => item.createdTaskId)).toEqual(["FN-101", "FN-102"]);
  });

  it("does not link a child when the parent reopens during guarded intake", async () => {
    const { app, store, tasks } = buildApp([parent()]);
    (store.createTask as ReturnType<typeof vi.fn>).mockImplementationOnce(async (input) => {
      tasks[0] = { ...tasks[0]!, column: "todo" };
      const created = task({
        id: "FN-101", title: input.title, description: input.description, column: "todo",
        source: input.source ?? { sourceType: "api" }, proposalClaimId: input.proposalClaimId,
      });
      tasks.push(created);
      return created;
    });

    const response = await performRequest(app, "POST", "/api/tasks/FN-1/recommendations/rec-1/create", undefined);

    expect(response.status).toBe(409);
    expect(tasks[0]?.recommendations?.[0]?.createdTaskId).toBeUndefined();
  });

  it("repairs a create-before-link interruption by reusing the durable live claim", async () => {
    const child = task({
      id: "FN-9", title: "Add task export", description: "Add CSV export outside this task's scope.", column: "todo",
      proposalClaimId: "recommendation:FN-1:rec-1", source: { sourceType: "api", sourceParentTaskId: "FN-1" },
    });
    const { app, store, tasks } = buildApp([parent(), child]);
    const response = await performRequest(app, "POST", "/api/tasks/FN-1/recommendations/rec-1/create", undefined);

    expect(response.status).toBe(200);
    expect(store.createTask).not.toHaveBeenCalled();
    expect(tasks[0]?.recommendations?.[0]?.createdTaskId).toBe("FN-9");
  });

  it("returns conflict without creating or relinking when the immutable claim is soft deleted", async () => {
    const tombstone = task({
      id: "FN-9", description: "Former recommendation child", column: "archived", deletedAt: new Date().toISOString(),
      proposalClaimId: "recommendation:FN-1:rec-1",
    });
    const { app, store, tasks } = buildApp([parent(), tombstone]);
    const response = await performRequest(app, "POST", "/api/tasks/FN-1/recommendations/rec-1/create", undefined);

    expect(response.status).toBe(409);
    expect(store.createTask).not.toHaveBeenCalled();
    expect(tasks[0]?.recommendations?.[0]?.createdTaskId).toBeUndefined();
    expect(store.listTasks).toHaveBeenCalledWith(expect.objectContaining({ includeDeleted: true }));
  });

  it("returns the normal duplicate conflict shape when post-create reconciliation loses a race", async () => {
    const canonical = task({
      id: "FN-9", title: "Add task export", description: "Add CSV export outside this task's scope.",
      column: "todo", createdAt: "2026-01-01T00:00:00.000Z",
    });
    const { app, store, tasks } = buildApp([parent(), canonical]);
    (store.findRecentTasksByContentFingerprint as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([canonical]);
    (store.searchTasks as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const response = await performRequest(app, "POST", "/api/tasks/FN-1/recommendations/rec-1/create", undefined);

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ error: "duplicate_candidates", details: { matches: [{ id: "FN-9", deterministic: true }] } });
    expect(tasks[0]?.recommendations?.[0]?.createdTaskId).toBeUndefined();
    expect(tasks.find((item) => item.id === "FN-102")?.column).toBe("archived");
  });

  it("retries a late deterministic conflict through normal guards and restores its child after the canonical closes", async () => {
    const canonical = task({
      id: "FN-9", title: "Add task export", description: "Add CSV export outside this task's scope.",
      column: "todo", createdAt: "2026-01-01T00:00:00.000Z",
    });
    const { app, store, tasks } = buildApp([parent(), canonical]);
    (store.findRecentTasksByContentFingerprint as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([canonical]);
    (store.searchTasks as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const rejected = await performRequest(app, "POST", "/api/tasks/FN-1/recommendations/rec-1/create", undefined);
    expect(rejected.status).toBe(409);
    expect(rejected.body).toMatchObject({ error: "duplicate_candidates", details: { matches: [{ id: "FN-9", deterministic: true }] } });
    const archivedChild = tasks.find((item) => item.id === "FN-102");
    expect(archivedChild).toMatchObject({ column: "archived", sourceMetadata: { deterministicDuplicateOf: "FN-9" } });

    const canonicalIndex = tasks.findIndex((item) => item.id === "FN-9");
    tasks[canonicalIndex] = { ...tasks[canonicalIndex]!, column: "done" };
    const recovered = await performRequest(app, "POST", "/api/tasks/FN-1/recommendations/rec-1/create", undefined);

    expect(recovered.status).toBe(200);
    expect(store.createTask).toHaveBeenCalledTimes(1);
    expect(store.unarchiveTask).toHaveBeenCalledWith("FN-102");
    expect(tasks[0]?.recommendations?.[0]?.createdTaskId).toBe("FN-102");
  });

  it("restores a late-conflict child into its custom workflow intake lane", async () => {
    const canonical = task({
      id: "FN-9", title: "Add task export", description: "Add CSV export outside this task's scope.",
      column: "todo", createdAt: "2026-01-01T00:00:00.000Z",
    });
    const { app, store, tasks } = buildApp([parent(), canonical]);
    Object.assign(store, {
      getTaskWorkflowSelection: vi.fn((id: string) => id === "FN-102" ? { workflowId: "recommendation-workflow", stepIds: [] } : undefined),
      getTaskWorkflowSelectionAsync: vi.fn(async (id: string) => id === "FN-102" ? { workflowId: "recommendation-workflow", stepIds: [] } : undefined),
      getWorkflowDefinition: vi.fn(async () => ({
        id: "recommendation-workflow",
        name: "Recommendation workflow",
        kind: "workflow",
        ir: {
          version: "v2",
          id: "recommendation-workflow",
          name: "Recommendation workflow",
          nodes: [{ id: "start", kind: "start", column: "backlog" }],
          edges: [],
          columns: [
            { id: "backlog", name: "Backlog", traits: [{ trait: "intake" }] },
            { id: "queued", name: "Queued", traits: [{ trait: "hold" }] },
            { id: "building", name: "Building", traits: [{ trait: "wip" }] },
            { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
            { id: "boxed", name: "Boxed", traits: [{ trait: "archived" }] },
          ],
        },
      })),
    });
    (store.findRecentTasksByContentFingerprint as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([canonical]);
    (store.searchTasks as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    expect((await performRequest(app, "POST", "/api/tasks/FN-1/recommendations/rec-1/create", undefined)).status).toBe(409);
    const canonicalIndex = tasks.findIndex((item) => item.id === "FN-9");
    tasks[canonicalIndex] = { ...tasks[canonicalIndex]!, column: "done" };

    const recovered = await performRequest(app, "POST", "/api/tasks/FN-1/recommendations/rec-1/create", undefined);

    expect(recovered.status).toBe(200);
    expect(store.moveTask).toHaveBeenLastCalledWith("FN-102", "backlog");
    expect(tasks.find((item) => item.id === "FN-102")?.column).toBe("backlog");
  });

  it("preserves deterministic duplicate conflicts and releases the intake lock for a later retry", async () => {
    const canonical = task({ id: "FN-9", title: "Add task export", description: "Add CSV export outside this task's scope.", column: "todo" });
    const { app, store, tasks } = buildApp([parent(), canonical]);
    (store.findRecentTasksByContentFingerprint as ReturnType<typeof vi.fn>).mockResolvedValueOnce([canonical]).mockResolvedValueOnce([]);
    (store.searchTasks as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const rejected = await performRequest(app, "POST", "/api/tasks/FN-1/recommendations/rec-1/create", undefined);
    const retried = await performRequest(app, "POST", "/api/tasks/FN-1/recommendations/rec-1/create", undefined);

    expect(rejected.status).toBe(409);
    expect(retried.status).toBe(201);
    expect(store.createTask).toHaveBeenCalledTimes(1);
    expect(tasks[0]?.recommendations?.[0]?.createdTaskId).toBeDefined();
  });

  it("preserves similarity and near-intent guard conflicts for server-owned recommendation content", async () => {
    const similarCanonical = task({
      id: "FN-9",
      title: "Add task export",
      description: "Build CSV export for existing tasks outside the current scope.",
      column: "todo",
    });
    const similar = buildApp([parent(), similarCanonical]);
    const similarResponse = await performRequest(similar.app, "POST", "/api/tasks/FN-1/recommendations/rec-1/create", undefined);
    expect(similarResponse.status).toBe(409);
    expect(similar.store.createTask).not.toHaveBeenCalled();

    const nearParent = parent({
      recommendations: [{
        id: "rec-near",
        title: "Export permissions",
        description: "Update `/api/tasks/export` and `TaskExportPolicy` for scoped access outside this task.",
        category: "improvement",
      }],
    });
    const nearCanonical = task({
      id: "FN-10",
      title: "Export permissions audit rollout",
      description: "Review `/api/tasks/export` through `TaskExportPolicy` before the compliance rollout.",
      column: "todo",
    });
    const near = buildApp([nearParent, nearCanonical]);
    const nearResponse = await performRequest(near.app, "POST", "/api/tasks/FN-1/recommendations/rec-near/create", undefined);
    expect(nearResponse.status).toBe(409);
    expect(near.store.createTask).not.toHaveBeenCalled();
    expect(nearResponse.body).toMatchObject({ details: { matches: [expect.objectContaining({ reason: "near-duplicate-intent" })] } });
  });

  it("preserves explicit duplicate-marker conflicts for server-owned recommendation content", async () => {
    const canonical = task({ id: "FN-9", title: "Canonical export task", description: "Already planned export work", column: "todo" });
    const markedParent = parent({
      recommendations: [{
        id: "rec-marker",
        title: "Previously identified duplicate",
        description: "DUPLICATE: FN-9",
        category: "other",
      }],
    });
    const { app, store, tasks } = buildApp([markedParent, canonical]);

    const response = await performRequest(app, "POST", "/api/tasks/FN-1/recommendations/rec-marker/create", undefined);

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ details: { matches: [expect.objectContaining({ id: "FN-9", reason: "explicit-marker" })] } });
    expect(store.createTask).not.toHaveBeenCalled();
    expect(tasks[0]?.recommendations?.[0]?.createdTaskId).toBeUndefined();
    expect(store.recordActivity).toHaveBeenCalledWith(expect.objectContaining({ taskId: "FN-9", metadata: expect.objectContaining({ source: "explicit-marker-intake" }) }));
  });

  it("rejects non-complete parents and stale linked children without creating another task", async () => {
    const incomplete = buildApp([parent({ column: "todo" })]);
    const incompleteResponse = await performRequest(incomplete.app, "POST", "/api/tasks/FN-1/recommendations/rec-1/create", undefined);
    expect(incompleteResponse.status).toBe(409);
    expect(incomplete.store.createTask).not.toHaveBeenCalled();

    const stale = buildApp([parent({ recommendations: [{ ...parent().recommendations![0], createdTaskId: "FN-9" }] })]);
    const staleResponse = await performRequest(stale.app, "POST", "/api/tasks/FN-1/recommendations/rec-1/create", undefined);
    expect(staleResponse.status).toBe(409);
    expect(stale.store.createTask).not.toHaveBeenCalled();

    const archivedChild = task({ id: "FN-9", description: "Archived child", column: "archived" });
    const archived = buildApp([parent({ recommendations: [{ ...parent().recommendations![0], createdTaskId: "FN-9" }] }), archivedChild]);
    const archivedResponse = await performRequest(archived.app, "POST", "/api/tasks/FN-1/recommendations/rec-1/create", undefined);
    expect(archivedResponse.status).toBe(409);
    expect(archived.store.createTask).not.toHaveBeenCalled();
  });

  it.each([
    { bypassDuplicateCheck: true },
    { acknowledgedDuplicates: ["FN-9"] },
    { column: "in-progress" },
    { workflowId: "builtin:coding" },
    { modelProvider: "mock" },
    { source: { sourceType: "api" } },
  ])("rejects client-controlled recommendation intake options before reading or creating: %o", async (body) => {
    const { app, store } = buildApp([parent()]);
    const response = await performRequest(app, "POST", "/api/tasks/FN-1/recommendations/rec-1/create", JSON.stringify(body), { "content-type": "application/json" });

    expect(response.status).toBe(400);
    expect(store.getTask).not.toHaveBeenCalled();
    expect(store.createTask).not.toHaveBeenCalled();
  });
});
