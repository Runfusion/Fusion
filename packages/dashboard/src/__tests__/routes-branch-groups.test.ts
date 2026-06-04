// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { BranchGroup, Task, TaskStore } from "@fusion/core";
import { evaluateBranchGroupCompletion, ProjectEngine } from "@fusion/engine";
import { createApiRoutes } from "../routes.js";
import { createBranchGroupsRouter } from "../routes/register-branch-groups-routes.js";
import { ApiError, sendErrorResponse } from "../api-error.js";
import { request as REQUEST } from "../test-request.js";

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
});
