// @vitest-environment node
//
// FN-7531: HTTP-level coverage for the additive `plannerOverseerState`
// enrichment on `GET /tasks`. Mirrors the `branchProgress` enrichment
// contract: attach when the engine snapshot accessor returns a non-null
// snapshot, omit entirely (byte-identical payload) otherwise, and never
// fail the board load even when the accessor throws.

import { it, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import { TaskStore } from "@fusion/core";
import { createTaskStoreForTest, pgDescribe, type PgTestHarness } from "../../../../core/src/__test-utils__/pg-test-harness.js";
import type { ProjectEngine } from "@fusion/engine";
import { createApiRoutes } from "../../routes.js";
import { request as REQUEST } from "../../test-request.js";

pgDescribe("GET /tasks — plannerOverseerState enrichment", () => {
  let harness: PgTestHarness;
  let store: TaskStore;

  beforeEach(async () => {
    // FNXC:PostgresCutover 2026-07-16-06:50: planner state API coverage must
    // exercise the PostgreSQL TaskStore rather than the removed SQLite mode.
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
      // FNXC:PostgresCutover 2026-07-16-06:55: project-aware route enrichment
      // resolves engine state only when the test double supplies its project id.
      engine: { getProjectId: () => "test-project", ...engine } as unknown as ProjectEngine,
    } : undefined));
    return app;
  }

  it("attaches plannerOverseerState when the engine snapshot accessor returns a snapshot", async () => {
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
    };

    const engineStub: Partial<ProjectEngine> = {
      getTaskStore: () => store,
      getPlannerOverseerRuntimeSnapshot: (taskId: string) => (taskId === task.id ? snapshot : null),
    };

    const app = buildApp(engineStub);
    const res = await REQUEST(app, "GET", "/api/tasks");
    expect(res.status).toBe(200);
    const found = (res.body as Array<Record<string, unknown>>).find((t) => t.id === task.id);
    expect(found?.plannerOverseerState).toEqual(snapshot);
  });

  it("omits plannerOverseerState entirely (no key) when the accessor returns null", async () => {
    const task = await store.createTask({ description: "idle task" });

    const engineStub: Partial<ProjectEngine> = {
      getTaskStore: () => store,
      getPlannerOverseerRuntimeSnapshot: () => null,
    };

    const app = buildApp(engineStub);
    const res = await REQUEST(app, "GET", "/api/tasks");
    expect(res.status).toBe(200);
    const found = (res.body as Array<Record<string, unknown>>).find((t) => t.id === task.id);
    expect(found).toBeDefined();
    expect(found && "plannerOverseerState" in found).toBe(false);
  });

  it("returns 200 with the un-enriched list when the accessor throws (board load never fails)", async () => {
    const task = await store.createTask({ description: "throwing task" });

    const engineStub: Partial<ProjectEngine> = {
      getTaskStore: () => store,
      getPlannerOverseerRuntimeSnapshot: () => {
        throw new Error("boom");
      },
    };

    const app = buildApp(engineStub);
    const res = await REQUEST(app, "GET", "/api/tasks");
    expect(res.status).toBe(200);
    const found = (res.body as Array<Record<string, unknown>>).find((t) => t.id === task.id);
    expect(found).toBeDefined();
    expect(found && "plannerOverseerState" in found).toBe(false);
  });

  it("returns 200 with the un-enriched list when no engine is present at all", async () => {
    const task = await store.createTask({ description: "no engine task" });

    const app = buildApp(undefined);
    const res = await REQUEST(app, "GET", "/api/tasks");
    expect(res.status).toBe(200);
    const found = (res.body as Array<Record<string, unknown>>).find((t) => t.id === task.id);
    expect(found).toBeDefined();
    expect(found && "plannerOverseerState" in found).toBe(false);
  });
});

// FN-7600: GET /tasks/:id (detail route) must attach the same transient
// `plannerOverseerState` snapshot as the list route above — the Task Detail
// modal's Overseer/Nudge controls read the snapshot from the full-detail
// payload, not the list payload, so the detail route previously never
// carried it and Nudge always showed the periodic-observation disabled copy.
pgDescribe("GET /tasks/:id — plannerOverseerState enrichment", () => {
  let harness: PgTestHarness;
  let store: TaskStore;

  beforeEach(async () => {
    // FNXC:PostgresCutover 2026-07-16-06:50: detail-route state enrichment
    // shares the isolated async-store fixture used by the board-list surface.
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
      // FNXC:PostgresCutover 2026-07-16-06:55: project-aware route enrichment
      // resolves engine state only when the test double supplies its project id.
      engine: { getProjectId: () => "test-project", ...engine } as unknown as ProjectEngine,
    } : undefined));
    return app;
  }

  it("attaches plannerOverseerState when the engine snapshot accessor returns a snapshot", async () => {
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
    };

    const engineStub: Partial<ProjectEngine> = {
      getTaskStore: () => store,
      getPlannerOverseerRuntimeSnapshot: (taskId: string) => (taskId === task.id ? snapshot : null),
    };

    const app = buildApp(engineStub);
    const res = await REQUEST(app, "GET", `/api/tasks/${task.id}`);
    expect(res.status).toBe(200);
    expect((res.body as Record<string, unknown>).plannerOverseerState).toEqual(snapshot);
  });

  it("omits plannerOverseerState entirely (no key) when the accessor returns null", async () => {
    const task = await store.createTask({ description: "idle task" });

    const engineStub: Partial<ProjectEngine> = {
      getTaskStore: () => store,
      getPlannerOverseerRuntimeSnapshot: () => null,
    };

    const app = buildApp(engineStub);
    const res = await REQUEST(app, "GET", `/api/tasks/${task.id}`);
    expect(res.status).toBe(200);
    expect("plannerOverseerState" in (res.body as Record<string, unknown>)).toBe(false);
  });

  it("returns 200 with the un-enriched task when the accessor throws (detail load never fails)", async () => {
    const task = await store.createTask({ description: "throwing task" });

    const engineStub: Partial<ProjectEngine> = {
      getTaskStore: () => store,
      getPlannerOverseerRuntimeSnapshot: () => {
        throw new Error("boom");
      },
    };

    const app = buildApp(engineStub);
    const res = await REQUEST(app, "GET", `/api/tasks/${task.id}`);
    expect(res.status).toBe(200);
    expect("plannerOverseerState" in (res.body as Record<string, unknown>)).toBe(false);
  });

  it("returns 200 with the un-enriched task when no engine is present at all", async () => {
    const task = await store.createTask({ description: "no engine task" });

    const app = buildApp(undefined);
    const res = await REQUEST(app, "GET", `/api/tasks/${task.id}`);
    expect(res.status).toBe(200);
    expect("plannerOverseerState" in (res.body as Record<string, unknown>)).toBe(false);
  });
});
