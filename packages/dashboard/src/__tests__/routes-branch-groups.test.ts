// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { TaskStore } from "@fusion/core";
import type { BranchGroup, Task } from "@fusion/core";
import {
  createTaskStoreForTest,
  PG_AVAILABLE,
} from "../../../core/src/__test-utils__/pg-test-harness.js";
import { createConnectionSetFromUrl } from "../../../core/src/postgres/connection.js";
import { createAsyncDataLayer } from "../../../core/src/postgres/data-layer.js";
import { evaluateBranchGroupCompletion, ProjectEngine } from "@fusion/engine";
import { createApiRoutes } from "../routes.js";
import { createBranchGroupsRouter } from "../routes/register-branch-groups-routes.js";
import { ApiError, sendErrorResponse } from "../api-error.js";
import { request as REQUEST } from "../test-request.js";

const projectStoreResolverMocks = vi.hoisted(() => ({
  getOrCreateProjectStore: vi.fn(),
}));

vi.mock("../project-store-resolver.js", async () => {
  const actual = await vi.importActual<typeof import("../project-store-resolver.js")>("../project-store-resolver.js");
  return { ...actual, getOrCreateProjectStore: projectStoreResolverMocks.getOrCreateProjectStore };
});

// Standalone routers (mounted without createApiRoutes) need the same error
// middleware createApiRoutes provides, so thrown ApiErrors become HTTP responses
// instead of hanging the request.
function attachErrorHandler(app: express.Express) {
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof ApiError) {
      sendErrorResponse(res, err.statusCode, err.message, { details: err.details });
      return;
    }
    sendErrorResponse(res, 500, err instanceof Error ? err.message : "Internal server error");
  });
}

function buildTask(id: string, groupId: string, landed: boolean): Task {
  return {
    id,
    description: id,
    column: landed ? "done" : "in-progress",
    dependencies: [],
    steps: [],
    currentStep: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    branchContext: { groupId, source: "planning", assignmentMode: "shared" },
    mergeDetails: landed
      ? { mergeConfirmed: true, mergeTargetSource: "branch-group-integration", mergeTargetBranch: "feature/shared" }
      : undefined,
  } as Task;
}

function createStore(group: BranchGroup, tasks: Task[]): TaskStore {
  return {
    getRootDir: vi.fn(() => "/tmp/project"),
    listBranchGroups: vi.fn(() => [group]),
    getBranchGroup: vi.fn((id: string) => (id === group.id ? group : null)),
    listTasks: vi.fn(async () => tasks),
    listTasksByBranchGroup: vi.fn(async () => tasks),
    setTaskBranchGroup: vi.fn(async () => {}),
    ensureBranchGroupForSource: vi.fn(() => group),
    getTask: vi.fn(async (id: string) => tasks.find((task) => task.id === id) ?? buildTask(id, group.id, false)),
  } as unknown as TaskStore;
}

function buildApp(store: TaskStore, promoteBranchGroup?: ReturnType<typeof vi.fn>) {
  const app = express();
  app.use(express.json());
  app.use("/api", createApiRoutes(store, { engine: { promoteBranchGroup } as any }));
  return app;
}

describe("branch group routes", () => {
  let group: BranchGroup;
  let tasks: Task[];

  beforeEach(() => {
    group = {
      id: "BG-1",
      sourceType: "planning",
      sourceId: "PS-1",
      branchName: "feature/shared",
      autoMerge: false,
      prState: "open",
      prNumber: 101,
      prUrl: "https://example/pr/101",
      status: "open",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    tasks = [buildTask("FN-1", group.id, true), buildTask("FN-2", group.id, false)];
  });

  it("lists and shows groups with completion + PR fields", async () => {
    const app = buildApp(createStore(group, tasks));
    const listRes = await REQUEST(app, "GET", "/api/branch-groups");
    expect(listRes.status).toBe(200);
    expect(listRes.body.groups[0].completion).toEqual({ landed: 1, total: 2, complete: false });
    expect(listRes.body.groups[0].prNumber).toBe(101);

    const showRes = await REQUEST(app, "GET", "/api/branch-groups/BG-1");
    expect(showRes.status).toBe(200);
    expect(showRes.body.group.members).toHaveLength(2);
    expect(showRes.body.group.members[0]).toHaveProperty("landed");
  });

  it("returns 404 for unknown group", async () => {
    const app = buildApp(createStore(group, tasks));
    const res = await REQUEST(app, "GET", "/api/branch-groups/BG-404");
    expect(res.status).toBe(404);
  });

  it("assigns and detaches grouped task", async () => {
    const store = createStore(group, tasks);
    const app = buildApp(store);

    let res = await REQUEST(app, "POST", "/api/branch-groups/assign", JSON.stringify({ taskId: "FN-1", groupId: "BG-1" }), { "content-type": "application/json" });
    expect(res.status).toBe(200);
    expect((store.setTaskBranchGroup as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith("FN-1", "BG-1");

    res = await REQUEST(app, "POST", "/api/branch-groups/assign", JSON.stringify({ taskId: "FN-1", groupId: null }), { "content-type": "application/json" });
    expect(res.status).toBe(200);
    expect((store.setTaskBranchGroup as unknown as ReturnType<typeof vi.fn>)).toHaveBeenLastCalledWith("FN-1", null);
  });

  it("exposes a real, callable promoteBranchGroup method on the engine class (regression guard)", () => {
    // U4: the dashboard promote route reaches engine.promoteBranchGroup AS A
    // METHOD. If that method ever goes missing from ProjectEngine, this fails
    // instead of being silently masked by a route-level vi.fn mock.
    expect(typeof (ProjectEngine.prototype as { promoteBranchGroup?: unknown }).promoteBranchGroup).toBe("function");
  });

  it("promotes a completed group by reaching the real engine method (not a hand-rolled mock)", async () => {
    // Drive the route through the ACTUAL ProjectEngine.promoteBranchGroup body
    // bound to a stub context, so the wiring proves it reaches a real, callable
    // method that delegates to the coordinator — not a fabricated vi.fn.
    const completeTasks = [buildTask("FN-1", group.id, true), buildTask("FN-2", group.id, true)];

    const finalizedGroup: BranchGroup = { ...group, status: "finalized", prState: "merged" };
    const engineStore = {
      getSettings: vi.fn(async () => ({
        autoMerge: false,
        globalPause: false,
        enginePaused: false,
        mergeStrategy: "pull-request",
      })),
      getBranchGroup: vi.fn(() => finalizedGroup),
      listTasksByBranchGroup: vi.fn(async () => completeTasks),
      updateBranchGroup: vi.fn(() => finalizedGroup),
      recordRunAuditEvent: vi.fn(async () => {}),
    };
    // Minimal ProjectEngine-shaped context the real method body reads.
    // `options` must be present: the method reads this.options.createGroupPr (U5).
    const engineContext = {
      runtime: { getTaskStore: () => engineStore },
      config: { workingDirectory: "/tmp/project" },
      options: {},
    };
    // Bind the REAL method (the same one the dashboard route invokes).
    const realPromote = (ProjectEngine.prototype as unknown as {
      promoteBranchGroup: (this: unknown, groupId: string) => Promise<Record<string, unknown>>;
    }).promoteBranchGroup;
    const boundPromote = ((groupId: string) =>
      realPromote.call(engineContext, groupId)) as unknown as ReturnType<typeof vi.fn>;

    const app = buildApp(createStore(group, completeTasks), boundPromote);
    const res = await REQUEST(app, "POST", "/api/branch-groups/BG-1/promote", JSON.stringify({}), { "content-type": "application/json" });
    // already-finalized group → method short-circuits before any git work and
    // returns the persisted state; what matters is the route reached the method.
    expect(res.status).toBe(200);
    expect(res.body.groupId).toBe("BG-1");
    expect(res.body.reason).toBe("already-finalized");
    expect(engineStore.getBranchGroup).toHaveBeenCalledWith("BG-1");
  });

  it("rejects promotion of an incomplete group at the completion gate (no engine call)", async () => {
    const realPromote = (ProjectEngine.prototype as unknown as {
      promoteBranchGroup: (this: unknown, groupId: string) => Promise<Record<string, unknown>>;
    }).promoteBranchGroup;
    const promoteSpy = vi.fn((groupId: string) => realPromote.call({}, groupId));
    const app = buildApp(createStore(group, tasks), promoteSpy as unknown as ReturnType<typeof vi.fn>);
    const res = await REQUEST(app, "POST", "/api/branch-groups/BG-1/promote", JSON.stringify({}), { "content-type": "application/json" });
    expect(res.status).toBe(400);
    expect(promoteSpy).not.toHaveBeenCalled();
  });

  it("surfaces the error path when the engine lacks a promoteBranchGroup method", async () => {
    // If the bridge method is missing from the resolved engine, the route's
    // option callback throws "promoteBranchGroup is not available on engine".
    const completeTasks = [buildTask("FN-1", group.id, true), buildTask("FN-2", group.id, true)];
    const app = buildApp(createStore(group, completeTasks), undefined);
    const res = await REQUEST(app, "POST", "/api/branch-groups/BG-1/promote", JSON.stringify({}), { "content-type": "application/json" });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("route serialization and coordinator agree on landed/complete for the same fixture", async () => {
    // Same fixture exercised through BOTH paths must yield identical results.
    const completeTasks = [buildTask("FN-1", group.id, true), buildTask("FN-2", group.id, true)];
    const mixedTasks = [buildTask("FN-1", group.id, true), buildTask("FN-2", group.id, false)];

    // Coordinator path.
    const completeCoord = evaluateBranchGroupCompletion({ members: completeTasks, group });
    const mixedCoord = evaluateBranchGroupCompletion({ members: mixedTasks, group });
    expect(completeCoord.complete).toBe(true);
    expect(mixedCoord.complete).toBe(false);

    // Route serialization path.
    const completeApp = buildApp(createStore(group, completeTasks));
    const completeRes = await REQUEST(completeApp, "GET", "/api/branch-groups/BG-1");
    expect(completeRes.body.group.completion.complete).toBe(true);

    const mixedApp = buildApp(createStore(group, mixedTasks));
    const mixedRes = await REQUEST(mixedApp, "GET", "/api/branch-groups/BG-1");
    expect(mixedRes.body.group.completion.complete).toBe(false);

    // No divergence between the two gates.
    expect(completeRes.body.group.completion.complete).toBe(completeCoord.complete);
    expect(mixedRes.body.group.completion.complete).toBe(mixedCoord.complete);
  });

  it("creates group on assign when groupId absent", async () => {
    const store = createStore(group, tasks);
    const app = buildApp(store);
    const res = await REQUEST(app, "POST", "/api/branch-groups/assign", JSON.stringify({ taskId: "FN-99", branchName: "feature/cli-onboarding" }), { "content-type": "application/json" });
    expect(res.status).toBe(200);
    expect((store.ensureBranchGroupForSource as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
  });
});

describe("branch group routes project-store scoping", () => {
  function scopedGroup(id: string, project: string, overrides: Partial<BranchGroup> = {}): BranchGroup {
    return {
      id,
      sourceType: "planning",
      sourceId: `PS-${project}`,
      branchName: `feature/${project}`,
      autoMerge: false,
      prState: "none",
      status: "open",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...overrides,
    };
  }

  function scopedTask(id: string, groupId: string, project: string, landed = true): Task {
    return {
      ...buildTask(id, groupId, landed),
      description: `${project} task`,
      title: `${project} task`,
      mergeDetails: landed
        ? {
            mergeConfirmed: true,
            mergeTargetSource: "branch-group-integration",
            mergeTargetBranch: `feature/${project}`,
          }
        : undefined,
    } as Task;
  }

  function scopedStore(rootDir: string, initialGroups: BranchGroup[], initialTasks: Task[]): TaskStore {
    const groups = new Map(initialGroups.map((entry) => [entry.id, { ...entry }]));
    const tasks = new Map(initialTasks.map((entry) => [entry.id, { ...entry }]));
    return {
      getRootDir: vi.fn(() => rootDir),
      listBranchGroups: vi.fn((filter?: { status?: BranchGroup["status"] }) =>
        [...groups.values()].filter((entry) => !filter?.status || entry.status === filter.status),
      ),
      getBranchGroup: vi.fn((id: string) => groups.get(id) ?? null),
      listTasks: vi.fn(async () => [...tasks.values()]),
      listTasksByBranchGroup: vi.fn(async (groupId: string) =>
        [...tasks.values()].filter((task) => task.branchContext?.groupId === groupId),
      ),
      getTask: vi.fn(async (id: string) => {
        const task = tasks.get(id);
        if (!task) throw new Error(`Task ${id} not found`);
        return task;
      }),
      setTaskBranchGroup: vi.fn(async (taskId: string, groupId: string | null) => {
        const task = tasks.get(taskId);
        if (!task) throw new Error(`Task ${taskId} not found`);
        task.branchContext = groupId
          ? { groupId, source: "planning", assignmentMode: "shared" }
          : undefined;
      }),
      ensureBranchGroupForSource: vi.fn((_sourceType, _sourceId, input: { branchName: string; autoMerge: boolean }) => {
        const created = scopedGroup(`BG-CREATED-${rootDir}`, rootDir, {
          branchName: input.branchName,
          autoMerge: input.autoMerge,
        });
        groups.set(created.id, created);
        return created;
      }),
      updateBranchGroup: vi.fn((id: string, patch: Partial<BranchGroup>) => {
        const current = groups.get(id);
        if (!current) throw new Error(`Branch group ${id} not found`);
        const updated = { ...current, ...patch, updatedAt: Date.now() };
        groups.set(id, updated);
        return updated;
      }),
    } as unknown as TaskStore;
  }

  function mountScopedRouter(
    defaultStore: TaskStore,
    options: Parameters<typeof createBranchGroupsRouter>[1] = {},
  ): express.Express {
    const app = express();
    app.use(express.json());
    app.use("/branch-groups", createBranchGroupsRouter(defaultStore, options));
    attachErrorHandler(app);
    return app;
  }

  beforeEach(() => {
    projectStoreResolverMocks.getOrCreateProjectStore.mockReset();
  });

  it("canonicalizes padded projectId so store and callback keys match the bare id", async () => {
    // FNXC:BranchGroupProjectScoping 2026-07-14-06:15:
    // `?projectId=secondary%20` must resolve the same store key as `secondary`, not a distinct padded key.
    const secondaryGroup = scopedGroup("BG-PAD", "secondary");
    const defaultStore = scopedStore("/projects/default", [], []);
    const secondaryStore = scopedStore("/projects/secondary", [secondaryGroup], [
      scopedTask("FN-PAD", secondaryGroup.id, "secondary"),
    ]);
    projectStoreResolverMocks.getOrCreateProjectStore.mockResolvedValue(secondaryStore);
    const promoteBranchGroup = vi.fn(async () => ({ promoted: true }));
    const app = mountScopedRouter(defaultStore, { promoteBranchGroup });

    const read = await REQUEST(app, "GET", "/branch-groups/BG-PAD?projectId=secondary%20");
    expect(read.status).toBe(200);
    expect(read.body.group.branchName).toBe("feature/secondary");
    expect(projectStoreResolverMocks.getOrCreateProjectStore).toHaveBeenCalledWith("secondary");

    const promote = await REQUEST(
      app,
      "POST",
      "/branch-groups/BG-PAD/promote?projectId=%20secondary%20",
      JSON.stringify({}),
      { "content-type": "application/json" },
    );
    expect(promote.status).toBe(200);
    expect(promoteBranchGroup).toHaveBeenCalledWith({
      groupId: "BG-PAD",
      projectId: "secondary",
      store: secondaryStore,
    });
  });

  it("replays non-default GET and reset requests without consulting the mounted default store", async () => {
    const duplicateDefault = scopedGroup("BG-DUPLICATE", "default");
    const duplicateSecondary = scopedGroup("BG-DUPLICATE", "secondary");
    const secondaryOnly = scopedGroup("BG-SECONDARY-ONLY", "secondary-only");
    const defaultStore = scopedStore("/projects/default", [duplicateDefault], [
      scopedTask("FN-DUPLICATE", duplicateDefault.id, "default"),
    ]);
    const secondaryStore = scopedStore("/projects/secondary", [duplicateSecondary, secondaryOnly], [
      scopedTask("FN-DUPLICATE", duplicateSecondary.id, "secondary"),
      scopedTask("FN-SECONDARY-ONLY", secondaryOnly.id, "secondary-only"),
    ]);
    projectStoreResolverMocks.getOrCreateProjectStore.mockResolvedValue(secondaryStore);
    const app = mountScopedRouter(defaultStore);

    const duplicate = await REQUEST(app, "GET", "/branch-groups/BG-DUPLICATE?projectId=secondary");
    expect(duplicate.status).toBe(200);
    expect(duplicate.body.group.branchName).toBe("feature/secondary");
    expect(duplicate.body.group.members[0].title).toBe("secondary task");

    const secondaryOnlyResponse = await REQUEST(app, "GET", "/branch-groups/BG-SECONDARY-ONLY?projectId=secondary");
    expect(secondaryOnlyResponse.status).toBe(200);
    expect(secondaryOnlyResponse.body.group.branchName).toBe("feature/secondary-only");

    const reset = await REQUEST(
      app,
      "POST",
      "/branch-groups/assign?projectId=secondary",
      JSON.stringify({ taskId: "FN-SECONDARY-ONLY", groupId: null }),
      { "content-type": "application/json" },
    );
    expect(reset.status).toBe(200);
    expect(reset.body).toEqual({ taskId: "FN-SECONDARY-ONLY", groupId: null });
    expect(secondaryStore.setTaskBranchGroup).toHaveBeenCalledWith("FN-SECONDARY-ONLY", null);
    expect(defaultStore.getBranchGroup).not.toHaveBeenCalled();
    expect(defaultStore.getTask).not.toHaveBeenCalled();
    expect(defaultStore.setTaskBranchGroup).not.toHaveBeenCalled();
  });

  it("uses the selected store across list, body assignment, promotion, abandon, and callbacks", async () => {
    const defaultStore = scopedStore("/projects/default", [], []);
    const secondaryGroup = scopedGroup("BG-SECONDARY", "secondary", {
      prState: "open",
      prNumber: 42,
      prUrl: "https://example/pr/42",
    });
    const secondaryStore = scopedStore("/projects/secondary", [secondaryGroup], [
      scopedTask("FN-SECONDARY", secondaryGroup.id, "secondary"),
    ]);
    projectStoreResolverMocks.getOrCreateProjectStore.mockResolvedValue(secondaryStore);
    const promoteBranchGroup = vi.fn(async () => ({ promoted: true }));
    const closeGroupPr = vi.fn(async () => ({
      prNumber: 42,
      prUrl: "https://example/pr/42",
      prState: "closed" as const,
    }));
    const app = mountScopedRouter(defaultStore, { promoteBranchGroup, closeGroupPr });

    const list = await REQUEST(app, "GET", "/branch-groups?projectId=secondary");
    expect(list.status).toBe(200);
    expect(list.body.groups.map((entry: BranchGroup) => entry.id)).toEqual(["BG-SECONDARY"]);

    const assign = await REQUEST(
      app,
      "POST",
      "/branch-groups/assign",
      JSON.stringify({ projectId: "secondary", taskId: "FN-SECONDARY", groupId: "BG-SECONDARY" }),
      { "content-type": "application/json" },
    );
    expect(assign.status).toBe(200);

    const promote = await REQUEST(
      app,
      "POST",
      "/branch-groups/BG-SECONDARY/promote",
      JSON.stringify({ projectId: "secondary" }),
      { "content-type": "application/json" },
    );
    expect(promote.status).toBe(200);
    expect(promoteBranchGroup).toHaveBeenCalledWith({
      groupId: "BG-SECONDARY",
      projectId: "secondary",
      store: secondaryStore,
    });

    const abandon = await REQUEST(
      app,
      "POST",
      "/branch-groups/BG-SECONDARY/abandon?projectId=secondary",
      JSON.stringify({}),
      { "content-type": "application/json" },
    );
    expect(abandon.status).toBe(200);
    expect(closeGroupPr).toHaveBeenCalledWith({
      group: expect.objectContaining({ id: "BG-SECONDARY" }),
      projectId: "secondary",
      store: secondaryStore,
    });
    expect(secondaryStore.updateBranchGroup).toHaveBeenCalledWith(
      "BG-SECONDARY",
      expect.objectContaining({ status: "abandoned", prState: "closed" }),
    );
    expect(defaultStore.listBranchGroups).not.toHaveBeenCalled();
    expect(defaultStore.listTasks).not.toHaveBeenCalled();
    expect(defaultStore.getBranchGroup).not.toHaveBeenCalled();
    expect(defaultStore.getTask).not.toHaveBeenCalled();
    expect(defaultStore.updateBranchGroup).not.toHaveBeenCalled();
  });

  it("persists and re-reads reconciliation through the query-selected store", async () => {
    const duplicateDefault = scopedGroup("BG-RECONCILE", "default", {
      prState: "open",
      prNumber: 11,
      prUrl: "https://example/pr/11",
    });
    const duplicateSecondary = scopedGroup("BG-RECONCILE", "secondary", {
      prState: "open",
      prNumber: 22,
      prUrl: "https://example/pr/22",
    });
    const defaultStore = scopedStore("/projects/default", [duplicateDefault], []);
    const secondaryStore = scopedStore("/projects/secondary", [duplicateSecondary], []);
    projectStoreResolverMocks.getOrCreateProjectStore.mockResolvedValue(secondaryStore);
    const reconcileGroupPr = vi.fn(async ({ group, store: requestStore }: { group: BranchGroup; store: TaskStore }) => {
      // FNXC:BranchGroupProjectScoping 2026-07-13-12:00: await async TaskStore branch-group methods after Postgres cutover on main.
      await requestStore.updateBranchGroup(group.id, { prState: "merged" });
      return (await requestStore.getBranchGroup(group.id)) ?? group;
    });
    const app = mountScopedRouter(defaultStore, { reconcileGroupPr });

    const response = await REQUEST(app, "GET", "/branch-groups/BG-RECONCILE?projectId=secondary");
    expect(response.status).toBe(200);
    expect(response.body.group.prState).toBe("merged");
    expect(reconcileGroupPr).toHaveBeenCalledWith({
      group: expect.objectContaining({ prNumber: 22 }),
      projectId: "secondary",
      store: secondaryStore,
    });
    expect(secondaryStore.updateBranchGroup).toHaveBeenCalledWith("BG-RECONCILE", { prState: "merged" });
    expect(defaultStore.getBranchGroup).not.toHaveBeenCalled();
    expect(defaultStore.updateBranchGroup).not.toHaveBeenCalled();
  });

  it("falls back only when projectId is absent and keeps unknown groups project-local", async () => {
    const defaultGroup = scopedGroup("BG-DEFAULT", "default");
    const secondaryGroup = scopedGroup("BG-SECONDARY", "secondary");
    const defaultStore = scopedStore("/projects/default", [defaultGroup], [
      scopedTask("FN-DEFAULT", defaultGroup.id, "default"),
    ]);
    const secondaryStore = scopedStore("/projects/secondary", [secondaryGroup], [
      scopedTask("FN-SECONDARY", secondaryGroup.id, "secondary"),
    ]);
    projectStoreResolverMocks.getOrCreateProjectStore.mockResolvedValue(secondaryStore);
    const app = mountScopedRouter(defaultStore);

    const fallbackGet = await REQUEST(app, "GET", "/branch-groups/BG-DEFAULT");
    expect(fallbackGet.status).toBe(200);
    expect(fallbackGet.body.group.branchName).toBe("feature/default");
    const fallbackAssign = await REQUEST(
      app,
      "POST",
      "/branch-groups/assign",
      JSON.stringify({ taskId: "FN-DEFAULT", groupId: null }),
      { "content-type": "application/json" },
    );
    expect(fallbackAssign.status).toBe(200);
    expect(projectStoreResolverMocks.getOrCreateProjectStore).not.toHaveBeenCalled();
    expect(defaultStore.setTaskBranchGroup).toHaveBeenCalledWith("FN-DEFAULT", null);
    expect(secondaryStore.getBranchGroup).not.toHaveBeenCalled();
    expect(secondaryStore.getTask).not.toHaveBeenCalled();
    expect(secondaryStore.setTaskBranchGroup).not.toHaveBeenCalled();

    vi.clearAllMocks();
    projectStoreResolverMocks.getOrCreateProjectStore.mockResolvedValue(secondaryStore);
    const missing = await REQUEST(app, "GET", "/branch-groups/BG-DEFAULT?projectId=secondary");
    expect(missing.status).toBe(404);
    expect(secondaryStore.getBranchGroup).toHaveBeenCalledWith("BG-DEFAULT");
    expect(defaultStore.getBranchGroup).not.toHaveBeenCalled();
  });
});

/*
FNXC:BranchGroupProjectScoping 2026-07-13-12:05:
FN-7438 durable-route coverage used bare `new TaskStore` (SQLite). Main removed that path for Postgres backend mode.
Rebind the restart fixture to createTaskStoreForTest, reopening a second TaskStore on the same AsyncDataLayer so group/member rows still prove request routing against durable storage.
*/
const durableDescribe = PG_AVAILABLE ? describe : describe.skip;

durableDescribe("branch group routes with durable TaskStore", () => {
  async function withRestartedStore<T>(callback: (store: TaskStore, app: express.Express) => Promise<T>): Promise<T> {
    const harness = await createTaskStoreForTest({ prefix: "fusion_bg_route" });
    let restartedStore: TaskStore | null = null;
    try {
      const group = await harness.store.ensureBranchGroupForSource("planning", "PS-route-restart", {
        branchName: "feature/route-restart",
        autoMerge: true,
      });
      await harness.store.createTask({
        description: "route member after restart",
        branchContext: { groupId: group.id, source: "planning", assignmentMode: "shared" },
      });
      // TaskStore.close() also closes the AsyncDataLayer pool. Rebuild a fresh
      // connection set to the same database URL so we prove durability across a
      // real store/process restart rather than reusing a closed pool.
      await harness.store.close();
      const connections = await createConnectionSetFromUrl(
        {
          mode: "external",
          runtimeUrl: harness.testUrl,
          migrationUrl: harness.testUrl,
          migrationUrlOverridden: false,
        },
        { poolMax: 5, connectTimeoutSeconds: 5 },
      );
      const layer = createAsyncDataLayer(connections);
      restartedStore = new TaskStore(harness.rootDir, undefined, { asyncLayer: layer });
      await restartedStore.init();

      const app = express();
      app.use(express.json());
      app.use("/api/branch-groups", createBranchGroupsRouter(restartedStore));
      attachErrorHandler(app);
      return await callback(restartedStore, app);
    } finally {
      try {
        await restartedStore?.close();
      } catch {
        // best-effort; harness.teardown drops the database either way
      }
      await harness.teardown();
    }
  }

  it("FN-7438: lists and shows persisted branch groups after a server/store restart", async () => {
    await withRestartedStore(async (store, app) => {
      const group = await store.getBranchGroupBySource("planning", "PS-route-restart");
      expect(group?.id).toMatch(/^BG-/);

      const listRes = await REQUEST(app, "GET", "/api/branch-groups");
      expect(listRes.status).toBe(200);
      expect(listRes.body.groups.map((entry: { id: string }) => entry.id)).toContain(group!.id);
      expect(listRes.body.groups.find((entry: { id: string }) => entry.id === group!.id).completion.total).toBe(1);

      const showRes = await REQUEST(app, "GET", `/api/branch-groups/${group!.id}`);
      expect(showRes.status).toBe(200);
      expect(showRes.body.group.id).toBe(group!.id);
      expect(showRes.body.group.members).toHaveLength(1);
      expect(showRes.body.group.branchName).toBe("feature/route-restart");
    });
  });

  it("FN-7438: clears only one stale task branch context through the assign API", async () => {
    await withRestartedStore(async (store, app) => {
      const stale = await store.createTask({
        description: "stale branch context",
        source: { sourceType: "api", sourceMetadata: { externalKey: "preserve" } },
        branchContext: { groupId: "BG-missing", source: "planning", assignmentMode: "shared" },
      });
      const peer = await store.createTask({
        description: "peer branch context",
        branchContext: { groupId: "BG-other-missing", source: "planning", assignmentMode: "shared" },
      });

      const res = await REQUEST(app, "POST", "/api/branch-groups/assign", JSON.stringify({ taskId: stale.id, groupId: null }), { "content-type": "application/json" });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ taskId: stale.id, groupId: null });

      const cleared = await store.getTask(stale.id);
      expect(cleared.branchContext).toBeUndefined();
      expect(cleared.sourceMetadata).toEqual({ externalKey: "preserve" });
      expect((await store.getTask(peer.id)).branchContext?.groupId).toBe("BG-other-missing");
    });
  });
});

describe("branch group abandon (U6, R7)", () => {
  function buildOpenGroup(): BranchGroup {
    return {
      id: "BG-AB",
      sourceType: "planning",
      sourceId: "PS-AB",
      branchName: "feature/shared-ab",
      autoMerge: false,
      prState: "open",
      prNumber: 55,
      prUrl: "https://example/pr/55",
      status: "open",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }

  function buildAbandonStore(initial: BranchGroup) {
    let current = { ...initial };
    const updateBranchGroup = vi.fn((_id: string, patch: Partial<BranchGroup>) => {
      current = { ...current, ...patch, status: patch.status ?? current.status };
      return current;
    });
    const store = {
      getRootDir: vi.fn(() => "/tmp/project"),
      getBranchGroup: vi.fn(() => current),
      listTasksByBranchGroup: vi.fn(async () => [] as Task[]),
      updateBranchGroup,
    } as unknown as TaskStore;
    return { store, updateBranchGroup, getCurrent: () => current };
  }

  function mount(store: TaskStore, closeGroupPr?: ReturnType<typeof vi.fn>) {
    const app = express();
    app.use(express.json());
    app.use("/branch-groups", createBranchGroupsRouter(store, { closeGroupPr }));
    attachErrorHandler(app);
    return app;
  }

  it("closes the GitHub PR (close callback invoked) and sets prState=closed", async () => {
    const { store, updateBranchGroup } = buildAbandonStore(buildOpenGroup());
    const closeGroupPr = vi.fn(async () => ({ prNumber: 55, prUrl: "https://example/pr/55", prState: "closed" as const }));
    const app = mount(store, closeGroupPr);

    const res = await REQUEST(app, "POST", "/branch-groups/BG-AB/abandon", JSON.stringify({}), { "content-type": "application/json" });
    expect(res.status).toBe(200);
    expect(closeGroupPr).toHaveBeenCalledTimes(1);
    expect(updateBranchGroup).toHaveBeenCalledWith("BG-AB", expect.objectContaining({ status: "abandoned", prState: "closed" }));
    expect(res.body.group.status).toBe("abandoned");
    expect(res.body.group.prState).toBe("closed");
  });

  it("still marks the row abandoned/closed when the close callback throws (best-effort)", async () => {
    const { store, updateBranchGroup } = buildAbandonStore(buildOpenGroup());
    const closeGroupPr = vi.fn(async () => { throw new Error("github down"); });
    const app = mount(store, closeGroupPr);

    const res = await REQUEST(app, "POST", "/branch-groups/BG-AB/abandon", JSON.stringify({}), { "content-type": "application/json" });
    expect(res.status).toBe(200);
    expect(updateBranchGroup).toHaveBeenCalledWith("BG-AB", expect.objectContaining({ status: "abandoned", prState: "closed" }));
    expect(res.body.group.prState).toBe("closed");
  });

  it("does not invoke close when there is no persisted PR", async () => {
    const noPr = { ...buildOpenGroup(), prNumber: undefined, prUrl: undefined, prState: "none" as const };
    const { store } = buildAbandonStore(noPr);
    const closeGroupPr = vi.fn(async () => ({ prNumber: 0, prUrl: "", prState: "closed" as const }));
    const app = mount(store, closeGroupPr);

    const res = await REQUEST(app, "POST", "/branch-groups/BG-AB/abandon", JSON.stringify({}), { "content-type": "application/json" });
    expect(res.status).toBe(200);
    expect(closeGroupPr).not.toHaveBeenCalled();
    expect(res.body.group.status).toBe("abandoned");
  });

  it("rejects abandon of an already-merged group with 400 (Fix #2)", async () => {
    const merged = { ...buildOpenGroup(), prState: "merged" as const };
    const { store, updateBranchGroup } = buildAbandonStore(merged);
    const closeGroupPr = vi.fn();
    const app = mount(store, closeGroupPr as unknown as ReturnType<typeof vi.fn>);

    const res = await REQUEST(app, "POST", "/branch-groups/BG-AB/abandon", JSON.stringify({}), { "content-type": "application/json" });
    // Terminal state — must not flip to abandoned/closed.
    expect(res.status).toBe(400);
    expect(closeGroupPr).not.toHaveBeenCalled();
    expect(updateBranchGroup).not.toHaveBeenCalled();
  });

  it("rejects abandon of a finalized group with 400 (Fix #2)", async () => {
    const finalized = { ...buildOpenGroup(), status: "finalized" as const };
    const { store, updateBranchGroup } = buildAbandonStore(finalized);
    const closeGroupPr = vi.fn();
    const app = mount(store, closeGroupPr as unknown as ReturnType<typeof vi.fn>);

    const res = await REQUEST(app, "POST", "/branch-groups/BG-AB/abandon", JSON.stringify({}), { "content-type": "application/json" });
    expect(res.status).toBe(400);
    expect(closeGroupPr).not.toHaveBeenCalled();
    expect(updateBranchGroup).not.toHaveBeenCalled();
  });

  it("rejects re-abandon of an already-abandoned group with 400 (Fix #2)", async () => {
    // A prState:"none" abandoned group: re-abandoning would otherwise flip prState
    // to "closed", persisting a PR close that never happened.
    const abandoned = { ...buildOpenGroup(), status: "abandoned" as const, prState: "none" as const, prNumber: undefined, prUrl: undefined };
    const { store, updateBranchGroup } = buildAbandonStore(abandoned);
    const closeGroupPr = vi.fn();
    const app = mount(store, closeGroupPr as unknown as ReturnType<typeof vi.fn>);

    const res = await REQUEST(app, "POST", "/branch-groups/BG-AB/abandon", JSON.stringify({}), { "content-type": "application/json" });
    expect(res.status).toBe(400);
    expect(closeGroupPr).not.toHaveBeenCalled();
    expect(updateBranchGroup).not.toHaveBeenCalled();
  });

  it("preserves prState 'none' when abandoning a group that never had a PR", async () => {
    // "closed" would falsely imply a PR existed and was explicitly closed.
    const noPr = { ...buildOpenGroup(), prState: "none" as const, prNumber: undefined, prUrl: undefined };
    const { store, updateBranchGroup } = buildAbandonStore(noPr);
    const closeGroupPr = vi.fn();
    const app = mount(store, closeGroupPr as unknown as ReturnType<typeof vi.fn>);

    const res = await REQUEST(app, "POST", "/branch-groups/BG-AB/abandon", JSON.stringify({}), { "content-type": "application/json" });
    expect(res.status).toBe(200);
    expect(closeGroupPr).not.toHaveBeenCalled();
    expect(updateBranchGroup).toHaveBeenLastCalledWith(
      "BG-AB",
      expect.objectContaining({ status: "abandoned", prState: "none" }),
    );
    expect(res.body.group.prState).toBe("none");
  });
});

describe("branch group reconcile-on-read (Fix #3)", () => {
  function buildOpenGroup(): BranchGroup {
    return {
      id: "BG-RC",
      sourceType: "planning",
      sourceId: "PS-RC",
      branchName: "feature/shared-rc",
      autoMerge: false,
      prState: "open",
      prNumber: 77,
      prUrl: "https://example/pr/77",
      status: "open",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }

  function buildStore(initial: BranchGroup) {
    let current = { ...initial };
    const store = {
      getRootDir: vi.fn(() => "/tmp/project"),
      getBranchGroup: vi.fn(() => current),
      listTasksByBranchGroup: vi.fn(async () => [] as Task[]),
      updateBranchGroup: vi.fn((_id: string, patch: Partial<BranchGroup>) => {
        current = { ...current, ...patch };
        return current;
      }),
    } as unknown as TaskStore;
    return { store, getCurrent: () => current };
  }

  function mount(store: TaskStore, reconcileGroupPr?: ReturnType<typeof vi.fn>) {
    const app = express();
    app.use(express.json());
    app.use("/branch-groups", createBranchGroupsRouter(store, { reconcileGroupPr }));
    attachErrorHandler(app);
    return app;
  }

  it("flips prState to merged and persists when the injected reconcile reports merged", async () => {
    const { store, getCurrent } = buildStore(buildOpenGroup());
    const reconcileGroupPr = vi.fn(async ({ group }: { group: BranchGroup }) => {
      // Mirror the wired callback: persist via the store, then return fresh row.
      store.updateBranchGroup(group.id, { prState: "merged", prNumber: 77, prUrl: group.prUrl ?? null });
      return getCurrent();
    });
    const app = mount(store, reconcileGroupPr);

    const res = await REQUEST(app, "GET", "/branch-groups/BG-RC");
    expect(res.status).toBe(200);
    expect(reconcileGroupPr).toHaveBeenCalledTimes(1);
    expect(res.body.group.prState).toBe("merged");
    expect(getCurrent().prState).toBe("merged");
  });

  it("returns 200 with stale state when the reconcile callback throws", async () => {
    const { store } = buildStore(buildOpenGroup());
    const reconcileGroupPr = vi.fn(async () => { throw new Error("github down"); });
    const app = mount(store, reconcileGroupPr);

    const res = await REQUEST(app, "GET", "/branch-groups/BG-RC");
    expect(res.status).toBe(200);
    expect(reconcileGroupPr).toHaveBeenCalledTimes(1);
    expect(res.body.group.prState).toBe("open");
  });

  it("does not reconcile when the group has no open PR", async () => {
    const noPr = { ...buildOpenGroup(), prState: "none" as const, prNumber: undefined };
    const { store } = buildStore(noPr);
    const reconcileGroupPr = vi.fn();
    const app = mount(store, reconcileGroupPr as unknown as ReturnType<typeof vi.fn>);

    const res = await REQUEST(app, "GET", "/branch-groups/BG-RC");
    expect(res.status).toBe(200);
    expect(reconcileGroupPr).not.toHaveBeenCalled();
  });
});

describe("branch group list N+1 elimination (Fix #6)", () => {
  function buildGroups(): BranchGroup[] {
    const base = {
      sourceType: "planning" as const,
      autoMerge: false,
      prState: "open" as const,
      status: "open" as const,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    return [
      { ...base, id: "BG-A", sourceId: "PS-A", branchName: "feature/a" },
      { ...base, id: "BG-B", sourceId: "PS-B", branchName: "feature/b" },
      { ...base, id: "BG-C", sourceId: "PS-C", branchName: "feature/c" },
    ];
  }

  // Landed requires mergeTargetBranch === the group's branchName, so build tasks
  // with a branch that matches their group.
  function memberTask(id: string, groupId: string, branchName: string, landed: boolean): Task {
    return {
      id,
      description: id,
      column: landed ? "done" : "in-progress",
      dependencies: [],
      steps: [],
      currentStep: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      branchContext: { groupId, source: "planning", assignmentMode: "shared" },
      mergeDetails: landed
        ? { mergeConfirmed: true, mergeTargetSource: "branch-group-integration", mergeTargetBranch: branchName }
        : undefined,
    } as Task;
  }

  it("issues exactly ONE listTasks call regardless of group count, with identical results", async () => {
    const groups = buildGroups();
    const tasks: Task[] = [
      memberTask("FN-A1", "BG-A", "feature/a", true),
      memberTask("FN-A2", "BG-A", "feature/a", false),
      memberTask("FN-B1", "BG-B", "feature/b", true),
    ];
    const listTasks = vi.fn(async () => tasks);
    // listTasksByBranchGroup must NOT be used by the list route anymore.
    const listTasksByBranchGroup = vi.fn(async (groupId: string) =>
      tasks.filter((t) => t.branchContext?.groupId === groupId),
    );
    const store = {
      getRootDir: vi.fn(() => "/tmp/project"),
      listBranchGroups: vi.fn(() => groups),
      getBranchGroup: vi.fn((id: string) => groups.find((g) => g.id === id) ?? null),
      listTasks,
      listTasksByBranchGroup,
    } as unknown as TaskStore;

    const app = express();
    app.use(express.json());
    app.use("/branch-groups", createBranchGroupsRouter(store));
    attachErrorHandler(app);

    const res = await REQUEST(app, "GET", "/branch-groups");
    expect(res.status).toBe(200);
    expect(listTasks).toHaveBeenCalledTimes(1);
    expect(listTasksByBranchGroup).not.toHaveBeenCalled();

    const byId = Object.fromEntries(res.body.groups.map((g: { id: string }) => [g.id, g]));
    expect(byId["BG-A"].completion).toEqual({ landed: 1, total: 2, complete: false });
    expect(byId["BG-B"].completion).toEqual({ landed: 1, total: 1, complete: true });
    expect(byId["BG-C"].completion).toEqual({ landed: 0, total: 0, complete: false });
  });

  /*
  FNXC:BranchGroupCompletion 2026-07-04-00:00:
  FN-7532 archived-member semantics: the list route fetches membership via
  `listTasks({ includeArchived: false, slim: true })`, so an archived member
  drops out of BOTH `landed` and `total` uniformly — archiving a LANDED member
  preserves the ratio (both counts drop by one, `complete` is unaffected when it
  was already complete), matching every other completion-reading surface (CLI,
  PR-body checklist, engine promotion gate) which all resolve membership through
  the same includeArchived:false path. This is intentional, consistent behavior
  (no cross-surface divergence), asserted here so a future change to the fetch
  option on only one surface would be caught as a regression.
  */
  it("drops an archived member from both landed and total uniformly (no ratio distortion when the archived member was landed)", async () => {
    const groups = buildGroups();
    const archivedLandedMember = memberTask("FN-A3", "BG-A", "feature/a", true);
    // listTasks with includeArchived:false never returns this row — simulate
    // the store contract precisely rather than assuming.
    const nonArchivedTasks: Task[] = [
      memberTask("FN-A1", "BG-A", "feature/a", true),
      memberTask("FN-A2", "BG-A", "feature/a", true),
    ];
    const allTasksIncludingArchived = [...nonArchivedTasks, { ...archivedLandedMember, column: "archived" as const }];
    const listTasks = vi.fn(async (opts?: { includeArchived?: boolean }) =>
      opts?.includeArchived ? allTasksIncludingArchived : nonArchivedTasks,
    );
    const store = {
      getRootDir: vi.fn(() => "/tmp/project"),
      listBranchGroups: vi.fn(() => [groups[0]]),
      getBranchGroup: vi.fn((id: string) => groups.find((g) => g.id === id) ?? null),
      listTasks,
      listTasksByBranchGroup: vi.fn(),
    } as unknown as TaskStore;

    const app = express();
    app.use(express.json());
    app.use("/branch-groups", createBranchGroupsRouter(store));
    attachErrorHandler(app);

    const res = await REQUEST(app, "GET", "/branch-groups");
    expect(res.status).toBe(200);
    // Both members landed, both counted — the archived 3rd (also landed) member
    // is invisible to the route entirely: 2/2 complete, not 2/3 incomplete.
    expect(res.body.groups[0].completion).toEqual({ landed: 2, total: 2, complete: true });
  });
});
