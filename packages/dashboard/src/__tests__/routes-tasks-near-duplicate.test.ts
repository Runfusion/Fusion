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

function buildApp(seed: Task[]) {
  const tasks = [...seed];
  const runtimeLogger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
  const store: Partial<TaskStore> = {
    searchTasks: vi.fn().mockResolvedValue(tasks),
    listTasks: vi.fn().mockResolvedValue(tasks),
    findRecentTasksByContentFingerprint: vi.fn().mockImplementation(async (fingerprint: string) =>
      tasks.filter((task) => task.source?.sourceMetadata?.contentFingerprint === fingerprint),
    ),
    getSettingsFast: vi.fn().mockResolvedValue({ autoSummarizeTitles: false }),
    createTask: vi.fn().mockImplementation(async (input: { title?: string; description: string; source?: Task["source"] }) => {
      const created = mkTask({ id: `FN-${tasks.length + 100}`, title: input.title, description: input.description, column: "todo", source: input.source ?? { sourceType: "api" } });
      tasks.push(created);
      return created;
    }),
    getTask: vi.fn().mockImplementation(async (id: string) => tasks.find((task) => task.id === id) ?? null),
    getRootDir: () => process.cwd(),
    updateTask: vi.fn().mockImplementation(async (id: string, updates: Record<string, unknown>) => {
      const index = tasks.findIndex((task) => task.id === id);
      if (index < 0) throw new Error("Task not found");
      const current = tasks[index];
      const sourceMetadataPatch = updates.sourceMetadataPatch as Record<string, unknown> | undefined;
      const next = {
        ...current,
        ...updates,
        ...(sourceMetadataPatch
          ? { sourceMetadata: { ...(current.sourceMetadata ?? {}), ...sourceMetadataPatch } }
          : {}),
      };
      tasks[index] = next;
      return next;
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

  return { app, tasks, runtimeLogger };
}

describe("routes /api/tasks near duplicate", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const routeSeed = mkTask({
    id: "FN-5144",
    title: "Create PR routes missing handlers",
    description: "Telemetry stream from staging parser indicates transport omissions. Missing paths: /api/tasks/:id/pr/options, /api/tasks/:id/pr/preflight, /api/tasks/:id/pr/generate-metadata in register-git-github.ts. Extra context: websocket jitter artifact, markdown sanitizer mismatch, scheduler heartbeat skew.",
    column: "todo",
  });

  const routeIncoming = {
    title: "Missing handlers for create PR routes",
    description: "Customer bug report with shell reproducer: GET /api/tasks/:id/pr/options, GET /api/tasks/:id/pr/preflight, POST /api/tasks/:id/pr/generate-metadata all return 404. Additional notes reference auth nonce parity, cache priming drift, and upstream webhook envelope differences.",
  };

  const reviewSeed = mkTask({
    id: "FN-5145",
    title: "TaskReviewTab create PR button no-op",
    description: "Review pipeline regression: TaskReviewTab.tsx action fires analytics but PrCreateModal never mounts. Includes unrelated notes on markdown hydration, audit panel clipping, and timeline compaction.",
    column: "todo",
  });

  const reviewIncoming = {
    title: "Create PR button no-op in TaskReviewTab",
    description: "Observed in QA replay: click handler executes in TaskReviewTab.tsx yet PrCreateModal is absent. Report also mentions artifact retention toggles, branch badge repaint, and virtualized list reflow.",
  };

  it("reproduces FN-5144 -> FN-5149 with near-duplicate reason and shared tokens", async () => {
    vi.spyOn(core, "findDuplicateMatches").mockReturnValue([]);
    const { app, tasks } = buildApp([routeSeed]);
    const res = await performRequest(app, "POST", "/api/tasks", JSON.stringify(routeIncoming), { "content-type": "application/json" });
    expect(res.status).toBe(409);
    const match = (res.body as { details: { matches: Array<{ id: string; reason: string; sharedTokens: string[] }> } }).details.matches[0];
    expect(match.id).toBe("FN-5144");
    expect(match.reason).toBe("near-duplicate-intent");
    expect(match.sharedTokens.filter((token) => token.includes("/pr/")).length).toBeGreaterThanOrEqual(2);
    expect(tasks).toHaveLength(1);
  });

  it("reproduces FN-5145 -> FN-5150 near-duplicate block", async () => {
    vi.spyOn(core, "findDuplicateMatches").mockReturnValue([]);
    const { app, tasks } = buildApp([reviewSeed]);
    const res = await performRequest(app, "POST", "/api/tasks", JSON.stringify(reviewIncoming), { "content-type": "application/json" });
    expect(res.status).toBe(409);
    const match = (res.body as { details: { matches: Array<{ id: string; reason: string }> } }).details.matches[0];
    expect(match).toMatchObject({ id: "FN-5145", reason: "near-duplicate-intent" });
    expect(tasks).toHaveLength(1);
  });

  it("acknowledgedDuplicates bypasses", async () => {
    const { app, tasks } = buildApp([routeSeed]);
    const res = await performRequest(app, "POST", "/api/tasks", JSON.stringify({ ...routeIncoming, acknowledgedDuplicates: ["FN-5144"] }), { "content-type": "application/json" });
    expect(res.status).toBe(201);
    expect(tasks).toHaveLength(2);
    expect((res.body as Task).source?.sourceMetadata?.acknowledgedDuplicateIds).toEqual(["FN-5144"]);
  });

  it("bypassDuplicateCheck bypasses", async () => {
    const { app, tasks } = buildApp([routeSeed]);
    const res = await performRequest(app, "POST", "/api/tasks", JSON.stringify({ ...routeIncoming, bypassDuplicateCheck: true }), { "content-type": "application/json" });
    expect(res.status).toBe(201);
    expect(tasks).toHaveLength(2);
  });

  it("generic-large-file overlap alone does not fire", async () => {
    const { app, tasks } = buildApp([
      mkTask({
        id: "FN-7001",
        title: "Fix PR comments pagination bug",
        description: "Update register-git-github.ts to page PR comments with cursor bounds only.",
        column: "todo",
      }),
    ]);

    const res = await performRequest(app, "POST", "/api/tasks", JSON.stringify({
      title: "Add PR merge auto-rebase option",
      description: "Implement merge auto-rebase handling in register-git-github.ts without changing comment pagination.",
    }), { "content-type": "application/json" });

    expect(res.status).toBe(201);
    expect(tasks).toHaveLength(2);
  });

  it("outside 7-day window does not fire", async () => {
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const { app, tasks } = buildApp([
      mkTask({
        id: "FN-9001",
        title: "Provision transport wiring for legacy routes",
        description: "Missing only /api/tasks/:id/pr/options, /api/tasks/:id/pr/preflight, /api/tasks/:id/pr/generate-metadata.",
        column: "todo",
        createdAt: old,
        updatedAt: old,
      }),
    ]);
    const res = await performRequest(app, "POST", "/api/tasks", JSON.stringify({
      title: "Re-enable review initiation workflow",
      description: "Calls depend on /api/tasks/:id/pr/options, /api/tasks/:id/pr/preflight, and /api/tasks/:id/pr/generate-metadata route handlers.",
    }), { "content-type": "application/json" });
    expect(res.status).toBe(201);
    expect(tasks).toHaveLength(2);
  });

  it("deterministic exact match wins over near-duplicate", async () => {
    const title = routeIncoming.title;
    const description = routeIncoming.description;
    const fingerprint = core.computeContentFingerprint({ title, description }) as string;
    const { app } = buildApp([
      mkTask({
        id: "FN-8001",
        title,
        description,
        column: "todo",
        source: { sourceType: "api", sourceMetadata: { contentFingerprint: fingerprint } },
      }),
    ]);

    const res = await performRequest(app, "POST", "/api/tasks", JSON.stringify({ title, description }), { "content-type": "application/json" });
    expect(res.status).toBe(409);
    const match = (res.body as { details: { matches: Array<{ id: string; deterministic?: boolean; reason?: string }> } }).details.matches[0];
    expect(match).toMatchObject({ id: "FN-8001", deterministic: true });
    expect(match.reason).toBeUndefined();
  });

  it("fails open when intent extraction throws", async () => {
    const extractorSpy = vi.spyOn(core, "extractIntentSignature").mockImplementation(() => {
      throw new Error("boom");
    });
    const { app, tasks, runtimeLogger } = buildApp([]);
    const res = await performRequest(app, "POST", "/api/tasks", JSON.stringify(routeIncoming), { "content-type": "application/json" });
    expect(res.status).toBe(201);
    expect(tasks).toHaveLength(1);
    expect(extractorSpy).toHaveBeenCalled();
    expect(runtimeLogger.warn).toHaveBeenCalledWith(
      "Near-duplicate intent guard failed; proceeding",
      expect.objectContaining({ error: "boom" }),
    );
  });

  it("PATCH Keep resumes a triage-marker duplicate for real planning", async () => {
    const seeded = mkTask({
      id: "FN-6002",
      title: "Triage marker duplicate",
      description: "Test candidate",
      column: "triage",
      paused: true,
      pausedReason: "duplicate-decision-required",
      sourceMetadata: { nearDuplicateOf: "FN-1000", duplicateSource: "triage-marker" },
    });
    const { app, tasks } = buildApp([seeded]);

    const res = await performRequest(
      app,
      "PATCH",
      "/api/tasks/FN-6002",
      JSON.stringify({ dismissNearDuplicate: true }),
      { "content-type": "application/json" },
    );

    expect(res.status).toBe(200);
    expect((res.body as Task)).toMatchObject({ paused: false, pausedReason: null, status: null });
    expect((res.body as Task).sourceMetadata).toMatchObject({
      nearDuplicateOf: "FN-1000",
      duplicateSource: "triage-marker",
      nearDuplicateDismissed: true,
    });
    expect(tasks[0]).toMatchObject({ paused: false, pausedReason: null, status: null });
  });

  it("PATCH dismissNearDuplicate applies sourceMetadataPatch merge", async () => {
    const seeded = mkTask({
      id: "FN-6001",
      title: "Near duplicate candidate",
      description: "Test candidate",
      column: "todo",
      sourceMetadata: { nearDuplicateOf: "FN-1000" },
    });
    const { app, tasks } = buildApp([seeded]);

    const res = await performRequest(
      app,
      "PATCH",
      "/api/tasks/FN-6001",
      JSON.stringify({ dismissNearDuplicate: true }),
      { "content-type": "application/json" },
    );

    expect(res.status).toBe(200);
    expect((res.body as Task).sourceMetadata).toMatchObject({
      nearDuplicateOf: "FN-1000",
      nearDuplicateDismissed: true,
    });
    expect(tasks[0]?.sourceMetadata).toMatchObject({
      nearDuplicateOf: "FN-1000",
      nearDuplicateDismissed: true,
    });
  });
});
