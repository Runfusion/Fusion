// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import express from "express";
import type { Column, Task, TaskStore } from "@fusion/core";
import { computeContentFingerprint } from "@fusion/core";

import { request as performRequest } from "../test-request.js";
import { registerTaskWorkflowRoutes } from "../routes/register-task-workflow-routes.js";
import { ApiError, sendErrorResponse } from "../api-error.js";

function createTaskFixture(overrides: Partial<Task> & { id: string; description: string; column: Column }): Task {
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
  const recordActivity = vi.fn().mockResolvedValue(undefined);

  const store: Partial<TaskStore> = {
    searchTasks: vi.fn().mockImplementation(async () => tasks),
    findRecentTasksByContentFingerprint: vi.fn().mockImplementation(async (fingerprint: string, options?: { windowMs?: number; includeArchived?: boolean }) => {
      const windowMs = Math.max(1, Math.min(300_000, Math.trunc(options?.windowMs ?? 60_000)));
      const cutoff = Date.now() - windowMs;
      return tasks.filter((task) => {
        const taskFingerprint = task.source?.sourceMetadata?.contentFingerprint;
        if (taskFingerprint !== fingerprint) {
          return false;
        }
        if ((options?.includeArchived ?? false) !== true && task.column === "archived") {
          return false;
        }
        return Date.parse(task.createdAt) >= cutoff;
      });
    }),
    getSettingsFast: vi.fn().mockResolvedValue({ autoSummarizeTitles: false }),
    createTask: vi.fn().mockImplementation(async (input: { title?: string; description: string; source?: Record<string, unknown> }) => {
      const task = createTaskFixture({
        id: `FN-${tasks.length + 100}`,
        title: input.title,
        description: input.description,
        column: "todo",
        source: (input.source as Task["source"]) ?? { sourceType: "api" },
      });
      tasks.push(task);
      return task;
    }),
    recordActivity,
  };

  const router = express.Router();
  registerTaskWorkflowRoutes(
    {
      router,
      store: store as TaskStore,
      options: {},
      runtimeLogger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } as never,
      planningLogger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } as never,
      chatLogger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } as never,
      getProjectIdFromRequest: () => undefined,
      getScopedStore: async () => store as TaskStore,
      getProjectContext: async () => ({ store: store as TaskStore, engine: undefined, projectId: undefined }),
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
        if (error instanceof ApiError) {
          throw error;
        }
        throw new ApiError(500, error instanceof Error ? error.message : "Internal server error");
      },
    },
    {
      runtimeLogger: { error: vi.fn(), warn: vi.fn() },
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

  return { app, store, recordActivity };
}

describe("task duplicate detection routes", () => {
  it("POST /tasks/duplicate-check returns matches for high similarity", async () => {
    const { app } = buildApp([
      createTaskFixture({
        id: "FN-10",
        title: "Add duplicate task warning",
        description: "Warn before creating duplicate tasks from quick entry",
        column: "todo",
      }),
    ]);

    const res = await performRequest(
      app,
      "POST",
      "/api/tasks/duplicate-check",
      JSON.stringify({ description: "Warn before creating duplicate tasks from quick entry" }),
      { "content-type": "application/json" },
    );

    expect(res.status).toBe(200);
    const body = res.body as { matches: Array<{ id: string }> };
    expect(body.matches.map((match) => match.id)).toContain("FN-10");
  });

  it("returns empty matches for unrelated descriptions", async () => {
    const { app } = buildApp([
      createTaskFixture({ id: "FN-11", title: "Retry scheduler", description: "Adjust retry windows", column: "todo" }),
    ]);

    const res = await performRequest(
      app,
      "POST",
      "/api/tasks/duplicate-check",
      JSON.stringify({ description: "Completely unrelated modal styling issue" }),
      { "content-type": "application/json" },
    );

    expect(res.status).toBe(200);
    expect((res.body as { matches: unknown[] }).matches).toEqual([]);
  });

  it("POST /tasks returns 409 when duplicate exists without acknowledgement", async () => {
    const { app } = buildApp([
      createTaskFixture({ id: "FN-12", title: "Duplicate warning", description: "Warn before task creation", column: "todo" }),
    ]);

    const res = await performRequest(
      app,
      "POST",
      "/api/tasks",
      JSON.stringify({ description: "Warn before task creation" }),
      { "content-type": "application/json" },
    );

    expect(res.status).toBe(409);
    const body = res.body as { error: string; details: { matches: Array<{ id: string }> } };
    expect(body.error).toBe("duplicate_candidates");
    expect(body.details.matches.map((match) => match.id)).toContain("FN-12");
  });

  it("creates task with override metadata and records activity", async () => {
    const { app, store, recordActivity } = buildApp([
      createTaskFixture({ id: "FN-13", title: "Duplicate warning", description: "Warn before task creation", column: "todo" }),
    ]);

    const res = await performRequest(
      app,
      "POST",
      "/api/tasks",
      JSON.stringify({ description: "Warn before task creation", acknowledgedDuplicates: ["FN-13"] }),
      { "content-type": "application/json" },
    );

    expect(res.status).toBe(201);
    const created = res.body as Task;
    expect(created.source?.sourceMetadata?.duplicateWarningOverridden).toBe(true);
    expect(created.source?.sourceMetadata?.acknowledgedDuplicateIds).toEqual(["FN-13"]);
    expect(recordActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "task:duplicate-warning-overridden",
        metadata: expect.objectContaining({ acknowledgedDuplicateIds: ["FN-13"] }),
      }),
    );
    expect((store.createTask as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it("bypassDuplicateCheck creates task without override metadata", async () => {
    const { app } = buildApp([
      createTaskFixture({ id: "FN-14", title: "Duplicate warning", description: "Warn before task creation", column: "todo" }),
    ]);

    const res = await performRequest(
      app,
      "POST",
      "/api/tasks",
      JSON.stringify({ description: "Warn before task creation", bypassDuplicateCheck: true }),
      { "content-type": "application/json" },
    );

    expect(res.status).toBe(201);
    const created = res.body as Task;
    expect(created.source?.sourceMetadata?.duplicateWarningOverridden).toBeUndefined();
  });

  it("deterministic check still blocks when only similarity duplicate is acknowledged", async () => {
    const fingerprint = computeContentFingerprint({
      title: "Move retry counter badge next to GitHub tracking badge",
      description: "Move the retry counter badge to the left of the GitHub tracking badge",
    }) as string;
    const { app } = buildApp([
      createTaskFixture({
        id: "FN-31",
        title: "Similar title",
        description: "Move the retry counter badge left of GitHub tracking badge",
        column: "todo",
      }),
      createTaskFixture({
        id: "FN-32",
        title: "Move retry counter badge next to GitHub tracking badge",
        description: "Move the retry counter badge to the left of the GitHub tracking badge",
        column: "todo",
        source: { sourceType: "api", sourceMetadata: { contentFingerprint: fingerprint } },
      }),
    ]);

    const res = await performRequest(
      app,
      "POST",
      "/api/tasks",
      JSON.stringify({
        title: "Move retry counter badge next to GitHub tracking badge",
        description: "Move the retry counter badge to the left of the GitHub tracking badge",
        acknowledgedDuplicates: ["FN-31"],
      }),
      { "content-type": "application/json" },
    );

    expect(res.status).toBe(409);
    const body = res.body as { details: { matches: Array<{ id: string; deterministic?: boolean }> } };
    expect(body.details.matches[0]).toMatchObject({ id: "FN-32", deterministic: true });
  });

  it("near-duplicate matches are suppressed when candidate is acknowledged", async () => {
    const { app } = buildApp([
      createTaskFixture({
        id: "FN-40",
        title: "Fix missing Create PR API routes",
        description: "Missing /pr/options /pr/preflight /pr/generate-metadata in packages/dashboard/src/routes/register-git-github.ts",
        column: "todo",
      }),
    ]);

    const res = await performRequest(
      app,
      "POST",
      "/api/tasks",
      JSON.stringify({
        title: "Create PR modal 404s",
        description: "PrCreateModal hits /api/tasks/:id/pr/options /api/tasks/:id/pr/preflight /api/tasks/:id/pr/generate-metadata",
        acknowledgedDuplicates: ["FN-40"],
      }),
      { "content-type": "application/json" },
    );

    expect(res.status).toBe(201);
  });

  it("done tasks do not trigger conflict", async () => {
    const { app } = buildApp([
      createTaskFixture({ id: "FN-15", title: "Duplicate warning", description: "Warn before task creation", column: "done" }),
    ]);

    const res = await performRequest(
      app,
      "POST",
      "/api/tasks",
      JSON.stringify({ description: "Warn before task creation" }),
      { "content-type": "application/json" },
    );

    expect(res.status).toBe(201);
  });
});
