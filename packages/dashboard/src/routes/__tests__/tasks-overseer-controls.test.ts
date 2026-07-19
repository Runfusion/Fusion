// @vitest-environment node
//
// FN-7517: HTTP-level coverage for the task-detail planner-overseer control
// endpoints (nudge/stop/explain). Mirrors the FN-7531 plannerOverseerState
// enrichment test's engine-stub pattern. Asserts: success path returns the
// expected payload; nudge never triggers a merge/PR/destructive side effect
// (it only ever calls the engine's guidance-only control method); and
// engine-unavailable degrades to a 200 "not applicable" payload rather than
// a 5xx.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import { TaskStore } from "@fusion/core";
import { createTaskStoreForTest, pgDescribe, type PgTestHarness } from "../../../../core/src/__test-utils__/pg-test-harness.js";
import type { ProjectEngine } from "@fusion/engine";
import { createApiRoutes } from "../../routes.js";
import { request as REQUEST } from "../../test-request.js";

pgDescribe("task-detail planner-overseer control routes", () => {
  let harness: PgTestHarness;
  let store: TaskStore;

  beforeEach(async () => {
    // FNXC:PostgresCutover 2026-07-16-06:30: planner-overseer route coverage
    // uses an isolated real backend rather than the retired in-memory SQLite mode.
    harness = await createTaskStoreForTest();
    store = harness.store;
  });

  afterEach(async () => {
    await harness.teardown();
  });

  function buildApp(engine: Partial<ProjectEngine> | undefined): express.Express {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store, engine ? {
      // FNXC:PostgresCutover 2026-07-16-06:30: project-aware routes resolve
      // engine services only when the test double advertises its project id.
      engine: { getProjectId: () => "test-project", ...engine } as unknown as ProjectEngine,
    } : undefined));
    return app;
  }

  describe("POST /tasks/:id/overseer/nudge", () => {
    it("returns the engine's applied result on the success path", async () => {
      const task = await store.createTask({ description: "watched task" });
      let calledWith: string | undefined;
      const engineStub: Partial<ProjectEngine> = {
        getTaskStore: () => store,
        nudgeOverseerTask: async (taskId: string) => {
          calledWith = taskId;
          return { applied: true, reason: "nudged", task };
        },
      };

      const app = buildApp(engineStub);
      const res = await REQUEST(app, "POST", `/api/tasks/${task.id}/overseer/nudge`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ applied: true, reason: "nudged" });
      expect(calledWith).toBe(task.id);
    });

    it("never invokes a merge/PR/destructive method — only the guidance-only nudge control", async () => {
      const task = await store.createTask({ description: "watched task" });
      const mergeSpy = { called: false };
      const engineStub: Partial<ProjectEngine> & { mergeTask?: () => void } = {
        getTaskStore: () => store,
        nudgeOverseerTask: async () => ({ applied: true, reason: "nudged", task }),
        mergeTask: () => {
          mergeSpy.called = true;
        },
      };

      const app = buildApp(engineStub);
      await REQUEST(app, "POST", `/api/tasks/${task.id}/overseer/nudge`);
      expect(mergeSpy.called).toBe(false);
    });

    it("surfaces a not-applicable result (still 200) when oversight is off/inactive", async () => {
      const task = await store.createTask({ description: "idle task" });
      const engineStub: Partial<ProjectEngine> = {
        getTaskStore: () => store,
        nudgeOverseerTask: async () => ({ applied: false, reason: "oversight-off" }),
      };

      const app = buildApp(engineStub);
      const res = await REQUEST(app, "POST", `/api/tasks/${task.id}/overseer/nudge`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ applied: false, reason: "oversight-off" });
    });

    it("respects user-paused tasks — the engine control itself withholds action", async () => {
      const task = await store.createTask({ description: "paused task" });
      const engineStub: Partial<ProjectEngine> = {
        getTaskStore: () => store,
        nudgeOverseerTask: async () => ({ applied: false, reason: "withheld:user-paused" }),
      };

      const app = buildApp(engineStub);
      const res = await REQUEST(app, "POST", `/api/tasks/${task.id}/overseer/nudge`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ applied: false, reason: "withheld:user-paused" });
    });

    it("degrades to a 200 not-applicable payload when no engine is present", async () => {
      const task = await store.createTask({ description: "no engine task" });
      const app = buildApp(undefined);
      const res = await REQUEST(app, "POST", `/api/tasks/${task.id}/overseer/nudge`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ applied: false, reason: "engine-unavailable" });
    });
  });

  describe("POST /tasks/:id/overseer/stop", () => {
    it("returns the updated task on the success path", async () => {
      const task = await store.createTask({ description: "watched task" });
      const engineStub: Partial<ProjectEngine> = {
        getTaskStore: () => store,
        stopOverseerTask: async () => ({ applied: true, reason: "stopped", task: { ...task, plannerOversightLevel: "off" } }),
      };

      const app = buildApp(engineStub);
      const res = await REQUEST(app, "POST", `/api/tasks/${task.id}/overseer/stop`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ applied: true, reason: "stopped" });
      expect((res.body as { task?: { plannerOversightLevel?: string } }).task?.plannerOversightLevel).toBe("off");
    });

    it("respects autoMerge:false human-review terminal tasks — the engine control itself withholds", async () => {
      const task = await store.createTask({ description: "human review task", autoMerge: false });
      const engineStub: Partial<ProjectEngine> = {
        getTaskStore: () => store,
        stopOverseerTask: async () => ({ applied: false, reason: "withheld:auto-merge-off-human-review" }),
      };

      const app = buildApp(engineStub);
      const res = await REQUEST(app, "POST", `/api/tasks/${task.id}/overseer/stop`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ applied: false, reason: "withheld:auto-merge-off-human-review" });
    });
  });

  describe("GET /tasks/:id/overseer/explain", () => {
    it("returns the current overseer runtime snapshot", async () => {
      const task = await store.createTask({ description: "watched task" });
      const snapshot = {
        state: "watching" as const,
        oversightLevel: "autonomous" as const,
        watchedStage: "executor",
        signal: "progressing",
        attemptCount: 0,
        attemptLimit: 3,
        pendingConfirmation: false,
        observedAt: 1700000000000,
        reason: "Task is actively executing in-progress work",
      };
      const engineStub: Partial<ProjectEngine> = {
        getTaskStore: () => store,
        explainOverseerTask: () => snapshot,
      };

      const app = buildApp(engineStub);
      const res = await REQUEST(app, "GET", `/api/tasks/${task.id}/overseer/explain`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ snapshot });
    });

    it("returns a null snapshot (not an error) when there is no active observation", async () => {
      const task = await store.createTask({ description: "idle task" });
      const engineStub: Partial<ProjectEngine> = {
        getTaskStore: () => store,
        explainOverseerTask: () => null,
      };

      const app = buildApp(engineStub);
      const res = await REQUEST(app, "GET", `/api/tasks/${task.id}/overseer/explain`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ snapshot: null });
    });

    it("degrades to a null snapshot when no engine is present", async () => {
      const task = await store.createTask({ description: "no engine task" });
      const app = buildApp(undefined);
      const res = await REQUEST(app, "GET", `/api/tasks/${task.id}/overseer/explain`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ snapshot: null });
    });
  });
});
