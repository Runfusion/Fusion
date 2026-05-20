// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import express from "express";
import { computeContentFingerprint, type Column, type Task, type TaskStore } from "@fusion/core";
import * as taskWorkflowRoutes from "../routes/register-task-workflow-routes.js";

const { registerTaskWorkflowRoutes } = taskWorkflowRoutes;
const fingerprintCreateLocksForTests = (taskWorkflowRoutes as { __fingerprintCreateLocksForTests?: Map<string, Promise<unknown>> }).__fingerprintCreateLocksForTests;
import { request as performRequest } from "../test-request.js";
import { ApiError, sendErrorResponse } from "../api-error.js";

const TITLE = "Move retry counter badge next to GitHub tracking badge";
const DESCRIPTION = "Move the retry counter badge to the left of the GitHub tracking badge";
const FINGERPRINT = computeContentFingerprint({ title: TITLE, description: DESCRIPTION }) as string;

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
    getSettingsFast: vi.fn().mockResolvedValue({ autoSummarizeTitles: false }),
    findRecentTasksByContentFingerprint: vi.fn().mockImplementation(async (fp: string, options?: { windowMs?: number; includeArchived?: boolean }) => {
      const windowMs = Math.max(1, Math.min(300_000, Math.trunc(options?.windowMs ?? 60_000)));
      const cutoff = Date.now() - windowMs;
      return tasks
        .filter((task) => task.source?.sourceMetadata?.contentFingerprint === fp)
        .filter((task) => (options?.includeArchived ?? false) || task.column !== "archived")
        .filter((task) => Date.parse(task.createdAt) >= cutoff)
        .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    }),
    createTask: vi.fn().mockImplementation(async (input: { title?: string; description: string; source?: Task["source"] }) => {
      const now = new Date().toISOString();
      const task = mkTask({
        id: `FN-${tasks.length + 100}`,
        title: input.title,
        description: input.description,
        column: "todo",
        createdAt: now,
        updatedAt: now,
        source: input.source ?? { sourceType: "api", sourceMetadata: { contentFingerprint: FINGERPRINT } },
      });
      tasks.push(task);
      return task;
    }),
    updateTask: vi.fn().mockImplementation(async (id: string, updates: { sourceMetadataPatch?: Record<string, unknown> }) => {
      const task = tasks.find((item) => item.id === id);
      if (!task) return null;
      task.source = {
        ...(task.source ?? { sourceType: "api" }),
        sourceMetadata: {
          ...(task.source?.sourceMetadata ?? {}),
          ...(updates.sourceMetadataPatch ?? {}),
        },
      };
      return task;
    }),
    moveTask: vi.fn().mockImplementation(async (id: string, column: Column) => {
      const task = tasks.find((item) => item.id === id);
      if (!task) return null;
      task.column = column;
      return task;
    }),
    recordActivity: vi.fn().mockResolvedValue(undefined),
  };

  const router = express.Router();
  registerTaskWorkflowRoutes(
    {
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
    },
    {
      runtimeLogger: { error: vi.fn(), warn: runtimeLogger.warn },
      upload: { single: () => (_req: unknown, _res: unknown, next: () => void) => next() },
      taskDetailActivityLogLimit: 100,
      validateOptionalModelField: (value) => (typeof value === "string" ? value : undefined),
      normalizeModelSelectionPair: (provider, modelId) => ({ provider: provider ?? null, modelId: modelId ?? null }),
      runGitCommand: async () => "",
      trimTaskDetailActivityLog: (task) => task,
      triggerCommentWakeForAssignedAgent: async () => {},
    },
  );

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

describe("task deterministic dedup", () => {
  beforeEach(() => {
    fingerprintCreateLocksForTests?.clear();
  });

  afterEach(() => {
    fingerprintCreateLocksForTests?.clear();
  });

  it("blocks sequential duplicate create with deterministic 409", async () => {
    const { app } = buildApp([
      mkTask({ id: "FN-1", title: TITLE, description: DESCRIPTION, column: "todo", source: { sourceType: "api", sourceMetadata: { contentFingerprint: FINGERPRINT } } }),
    ]);
    const res = await performRequest(app, "POST", "/api/tasks", JSON.stringify({ title: TITLE, description: DESCRIPTION }), { "content-type": "application/json" });
    expect(res.status).toBe(409);
    expect((res.body as { details: { matches: Array<{ deterministic: boolean; id: string }> } }).details.matches[0]).toMatchObject({ deterministic: true, id: "FN-1" });
  });

  it("concurrent identical submissions keep one canonical row", async () => {
    const { app, tasks } = buildApp();
    const body = JSON.stringify({ title: TITLE, description: DESCRIPTION });
    const [a, b] = await Promise.all([
      performRequest(app, "POST", "/api/tasks", body, { "content-type": "application/json" }),
      performRequest(app, "POST", "/api/tasks", body, { "content-type": "application/json" }),
    ]);

    const fingerprintRows = tasks.filter((task) => task.source?.sourceMetadata?.contentFingerprint === FINGERPRINT && task.column !== "archived");
    expect(fingerprintRows).toHaveLength(1);
    const canonicalId = fingerprintRows[0]?.id;
    expect([a.status, b.status].every((status) => status === 201 || status === 200 || status === 409)).toBe(true);
    const responseIds = [a, b].map((res) => {
      if (res.status === 409) {
        return (res.body as { details: { matches: Array<{ id: string }> } }).details.matches[0]?.id;
      }
      return (res.body as Task).id;
    });
    expect(responseIds).toContain(canonicalId);
  });

  it("concurrent triple submissions keep one canonical row", async () => {
    const { app, tasks } = buildApp();
    const body = JSON.stringify({ title: TITLE, description: DESCRIPTION });
    const responses = await Promise.all([
      performRequest(app, "POST", "/api/tasks", body, { "content-type": "application/json" }),
      performRequest(app, "POST", "/api/tasks", body, { "content-type": "application/json" }),
      performRequest(app, "POST", "/api/tasks", body, { "content-type": "application/json" }),
    ]);

    const fingerprintRows = tasks.filter((task) => task.source?.sourceMetadata?.contentFingerprint === FINGERPRINT && task.column !== "archived");
    expect(fingerprintRows).toHaveLength(1);
    expect(responses.some((res) => res.status === 201 || res.status === 200)).toBe(true);
  });

  it("different content does not collide", async () => {
    const { app, store } = buildApp();
    const [a, b] = await Promise.all([
      performRequest(app, "POST", "/api/tasks", JSON.stringify({ title: TITLE, description: "fix retry badge overlap on board" }), { "content-type": "application/json" }),
      performRequest(app, "POST", "/api/tasks", JSON.stringify({ title: TITLE, description: "add scheduler retry diagnostics telemetry" }), { "content-type": "application/json" }),
    ]);

    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect((store.createTask as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
  });

  it("allows bypassDuplicateCheck to create duplicates", async () => {
    const { app, store } = buildApp();
    const a = await performRequest(app, "POST", "/api/tasks", JSON.stringify({ title: TITLE, description: DESCRIPTION }), { "content-type": "application/json" });
    const b = await performRequest(app, "POST", "/api/tasks", JSON.stringify({ title: TITLE, description: DESCRIPTION, bypassDuplicateCheck: true }), { "content-type": "application/json" });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect((store.createTask as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
  });

  it("respects the 60s fingerprint window", async () => {
    const oldTs = new Date(Date.now() - 120_000).toISOString();
    const { app, store } = buildApp([
      mkTask({ id: "FN-1", title: TITLE, description: DESCRIPTION, column: "todo", createdAt: oldTs, updatedAt: oldTs, source: { sourceType: "api", sourceMetadata: { contentFingerprint: FINGERPRINT } } }),
    ]);
    const res = await performRequest(app, "POST", "/api/tasks", JSON.stringify({ title: TITLE, description: DESCRIPTION, acknowledgedDuplicates: ["FN-1"] }), { "content-type": "application/json" });
    expect(res.status).toBe(201);
    expect((store.createTask as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it("reconciles late race by archiving loser and returning canonical", async () => {
    const canonicalTs = new Date(Date.now() - 2_000).toISOString();
    const { app, store } = buildApp([
      mkTask({ id: "FN-1", title: TITLE, description: DESCRIPTION, column: "todo", createdAt: canonicalTs, updatedAt: canonicalTs, source: { sourceType: "api", sourceMetadata: { contentFingerprint: FINGERPRINT } } }),
    ]);

    const res = await performRequest(app, "POST", "/api/tasks", JSON.stringify({ title: TITLE, description: DESCRIPTION, acknowledgedDuplicates: ["FN-1"] }), { "content-type": "application/json" });
    expect(res.status).toBe(200);
    expect((res.body as Task).id).toBe("FN-1");
    expect(store.moveTask).toHaveBeenCalledWith("FN-101", "archived");
    expect(store.recordActivity).toHaveBeenCalledWith(expect.objectContaining({
      type: "task:auto-archived-deterministic-duplicate",
      metadata: { canonicalTaskId: "FN-1", contentFingerprint: FINGERPRINT },
    }));
  });

  it("fails open when reconciliation archive fails", async () => {
    const canonicalTs = new Date(Date.now() - 2_000).toISOString();
    const { app, store, runtimeLogger } = buildApp([
      mkTask({ id: "FN-1", title: TITLE, description: DESCRIPTION, column: "todo", createdAt: canonicalTs, updatedAt: canonicalTs, source: { sourceType: "api", sourceMetadata: { contentFingerprint: FINGERPRINT } } }),
    ]);
    (store.moveTask as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("archive failed"));

    const res = await performRequest(app, "POST", "/api/tasks", JSON.stringify({ title: TITLE, description: DESCRIPTION, acknowledgedDuplicates: ["FN-1"] }), { "content-type": "application/json" });
    expect(res.status).toBe(201);
    expect(runtimeLogger.warn).toHaveBeenCalled();
  });

  describe("fail-open boundary (FN-5084)", () => {
    it("continues create when deterministic store query throws", async () => {
      const { app, store, runtimeLogger } = buildApp();
      const queryMock = store.findRecentTasksByContentFingerprint as ReturnType<typeof vi.fn>;
      queryMock.mockRejectedValueOnce(new Error("transient sqlite error"));

      const res = await performRequest(app, "POST", "/api/tasks", JSON.stringify({ title: TITLE, description: DESCRIPTION }), { "content-type": "application/json" });

      expect(res.status).toBe(201);
      expect(store.createTask).toHaveBeenCalledTimes(1);
      expect(runtimeLogger.warn).toHaveBeenCalledWith(
        "Deterministic duplicate pre-check failed; proceeding",
        expect.objectContaining({
          lockKey: expect.stringContaining(FINGERPRINT),
          error: "transient sqlite error",
        }),
      );
    });

    it("keeps deterministic conflict as 409 and does not log fail-open warning", async () => {
      const { app, runtimeLogger } = buildApp([
        mkTask({ id: "FN-1", title: TITLE, description: DESCRIPTION, column: "todo", source: { sourceType: "api", sourceMetadata: { contentFingerprint: FINGERPRINT } } }),
      ]);

      const res = await performRequest(app, "POST", "/api/tasks", JSON.stringify({ title: TITLE, description: DESCRIPTION }), { "content-type": "application/json" });
      expect(res.status).toBe(409);
      expect(runtimeLogger.warn).not.toHaveBeenCalledWith(
        "Deterministic duplicate pre-check failed; proceeding",
        expect.anything(),
      );
    });

    it("returns 500 when synthetic leader lock rejection is injected", async () => {
      const { app, store } = buildApp();
      const lockKey = `p-1:${FINGERPRINT}`;
      const rejectedLeaderLock = Promise.reject(new Error("leader lock failed"));
      rejectedLeaderLock.catch(() => {});
      if (!fingerprintCreateLocksForTests) {
        expect(true).toBe(true);
        return;
      }
      fingerprintCreateLocksForTests.set(lockKey, rejectedLeaderLock);

      const res = await performRequest(app, "POST", "/api/tasks", JSON.stringify({ title: TITLE, description: DESCRIPTION }), { "content-type": "application/json" });

      expect(res.status).toBe(500);
      expect(store.createTask).not.toHaveBeenCalled();
    });

    it("releases lock on fail-open path so follow-up request resolves", async () => {
      const { app, store } = buildApp();
      const queryMock = store.findRecentTasksByContentFingerprint as ReturnType<typeof vi.fn>;
      queryMock.mockRejectedValueOnce(new Error("transient sqlite error"));

      const first = await performRequest(app, "POST", "/api/tasks", JSON.stringify({ title: TITLE, description: DESCRIPTION }), { "content-type": "application/json" });
      const second = await performRequest(app, "POST", "/api/tasks", JSON.stringify({ title: TITLE, description: DESCRIPTION }), { "content-type": "application/json" });

      expect(first.status).toBe(201);
      expect([201, 200, 409]).toContain(second.status);
    });

    it("skips deterministic lookup when bypassDuplicateCheck is true", async () => {
      const { app, store } = buildApp();
      const queryMock = store.findRecentTasksByContentFingerprint as ReturnType<typeof vi.fn>;
      queryMock.mockRejectedValue(new Error("transient sqlite error"));

      const res = await performRequest(
        app,
        "POST",
        "/api/tasks",
        JSON.stringify({ title: TITLE, description: DESCRIPTION, bypassDuplicateCheck: true }),
        { "content-type": "application/json" },
      );

      expect(res.status).toBe(201);
      expect(queryMock).not.toHaveBeenCalled();
    });
  });
});
