// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { createApiRoutes } from "../routes.js";
import { request } from "../test-request.js";
import type { TaskStore } from "@fusion/core";

const project = {
  id: "proj_1",
  name: "Project",
  path: "/tmp/project",
  status: "active",
  isolationMode: "in-process" as const,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const central = {
  isInitialized: () => true,
  getProject: vi.fn(),
  updateProject: vi.fn(),
  unassignProjectFromNode: vi.fn(),
  assignProjectToNode: vi.fn(),
};

function createStore(): TaskStore {
  return {
    listTasks: vi.fn().mockResolvedValue([]),
    getSettings: vi.fn().mockResolvedValue({}),
    getSettingsFast: vi.fn().mockResolvedValue({}),
    getRootDir: vi.fn().mockReturnValue("/tmp/test"),
    getFusionDir: vi.fn().mockReturnValue("/tmp/test/.fusion"),
    getPluginStore: vi.fn().mockReturnValue({ listPlugins: vi.fn().mockResolvedValue([]) }),
    getMissionStore: vi.fn().mockReturnValue({ listMissions: vi.fn().mockResolvedValue([]) }),
    getRoutineStore: vi.fn().mockReturnValue({ listRoutines: vi.fn().mockResolvedValue([]) }),
    getAutomationStore: vi.fn().mockReturnValue({ listScheduledTasks: vi.fn().mockResolvedValue([]) }),
  } as unknown as TaskStore;
}

/**
 * FNXC:HybridExecutorBoot 2026-09-26-03:10:
 * RUFU-322: the isolation route now gates on `HybridExecutor.whenReady()` before touching runtime
 * state, so every fixture that means "the executor is up and running" must state it. A fixture without
 * `whenReady` is a fixture for a broken executor — the route answers 500, which is the honest outcome
 * of calling a method the real class guarantees.
 */
function readyExecutor(
  transitionProjectIsolation = vi.fn().mockResolvedValue({ ok: true }),
): { transitionProjectIsolation: ReturnType<typeof vi.fn>; whenReady: ReturnType<typeof vi.fn> } {
  return { transitionProjectIsolation, whenReady: vi.fn().mockResolvedValue(undefined) };
}

function createApp(options?: Parameters<typeof createApiRoutes>[1]) {
  const app = express();
  app.use(express.json());
  app.use("/api", createApiRoutes(createStore(), { ...options, centralCore: central as any }));
  return app;
}

describe("project isolation transition route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    central.getProject.mockResolvedValue(project);
    central.updateProject.mockImplementation(async (_id: string, updates: Record<string, unknown>) => ({ ...project, ...updates }));
  });

  it("uses hybrid executor transition path when available", async () => {
    const hybridExecutor = readyExecutor();
    const res = await request(
      createApp({ hybridExecutor: hybridExecutor as any }),
      "PATCH",
      "/api/projects/proj_1",
      JSON.stringify({ isolationMode: "child-process" }),
      { "content-type": "application/json" },
    );
    expect(res.status).toBe(200);
    expect(hybridExecutor.transitionProjectIsolation).toHaveBeenCalledWith("proj_1", "child-process", { force: false });
    expect((res.body as any).transitionDeferred).toBeUndefined();
  });

  it("returns 503 with clear remediation when no hybrid executor is configured (local-only)", async () => {
    // Previously this route silently set transitionDeferred=true and persisted
    // the new isolationMode without performing the live runtime transition —
    // confusing UX and active-task safety check was bypassed. The new
    // behavior throws 503 immediately so the user gets actionable guidance
    // (restart the dashboard or force-enable HybridExecutor) and the stored
    // isolationMode stays consistent with the live runtime.
    const res = await request(
      createApp(),
      "PATCH",
      "/api/projects/proj_1",
      JSON.stringify({ isolationMode: "child-process" }),
      { "content-type": "application/json" },
    );
    expect(res.status).toBe(503);
    expect((res.body as { error?: string }).error).toBe("isolation_transition_unavailable");
  });

  it("returns 409 on active_tasks without force and succeeds with force", async () => {
    const hybridExecutor = readyExecutor(
      vi
        .fn()
        .mockResolvedValueOnce({ ok: false, reason: "active_tasks", activeTaskCount: 2 })
        .mockResolvedValueOnce({ ok: true }),
    );

    const blocked = await request(
      createApp({ hybridExecutor: hybridExecutor as any }),
      "PATCH",
      "/api/projects/proj_1",
      JSON.stringify({ isolationMode: "child-process" }),
      { "content-type": "application/json" },
    );
    expect(blocked.status).toBe(409);

    const forced = await request(
      createApp({ hybridExecutor: hybridExecutor as any }),
      "PATCH",
      "/api/projects/proj_1",
      JSON.stringify({ isolationMode: "child-process", force: true }),
      { "content-type": "application/json" },
    );
    expect(forced.status).toBe(200);
    expect(hybridExecutor.transitionProjectIsolation).toHaveBeenLastCalledWith("proj_1", "child-process", { force: true });
  });

  /*
  FNXC:IsolationTransitionBlockers 2026-10-15-06:45 (RUFU-328):
  The two shapes of the 409 body, pinned as a pair. A refusal the durable guard could name must hand the
  operator the card ids — the reported incident was a refusal that sat for hours naming nothing, because
  a count alone cannot be looked up. A refusal where the read could not answer must NOT grow an empty
  list: `blockingTaskIds: []` would tell the operator the board proved nothing blocks while the request
  was still refused, which is the false-release claim in payload form.
  */
  it("names the blocking cards in the 409 body when the guard named them", async () => {
    const hybridExecutor = readyExecutor(
      vi.fn().mockResolvedValue({
        ok: false,
        reason: "active_tasks",
        activeTaskCount: 2,
        blockingTaskIds: ["SANE-435", "SANE-453"],
      }),
    );

    const res = await request(
      createApp({ hybridExecutor: hybridExecutor as any }),
      "PATCH",
      "/api/projects/proj_1",
      JSON.stringify({ isolationMode: "child-process" }),
      { "content-type": "application/json" },
    );

    expect(res.status).toBe(409);
    // `ApiError` serialises as { error: <message>, details: <payload> } (see `sendErrorResponse`), so the
    // diagnostic payload the guard produced lands under `details`.
    expect(res.body).toMatchObject({
      error: "active_tasks",
      details: {
        activeTaskCount: 2,
        blockingTaskIds: ["SANE-435", "SANE-453"],
      },
    });
    // A refused transition persists nothing.
    expect(central.updateProject).not.toHaveBeenCalled();
  });

  it("omits blockingTaskIds from the 409 body when the durable read could not answer", async () => {
    const hybridExecutor = readyExecutor(
      vi.fn().mockResolvedValue({ ok: false, reason: "active_tasks", activeTaskCount: 3 }),
    );

    const res = await request(
      createApp({ hybridExecutor: hybridExecutor as any }),
      "PATCH",
      "/api/projects/proj_1",
      JSON.stringify({ isolationMode: "child-process" }),
      { "content-type": "application/json" },
    );

    expect(res.status).toBe(409);
    const details = (res.body as { details?: Record<string, unknown> }).details ?? {};
    expect(details.activeTaskCount).toBe(3);
    expect("blockingTaskIds" in details).toBe(false);
  });

  /*
  FNXC:HybridExecutorBoot 2026-09-26-03:10:
  RUFU-322: because HTTP listen no longer waits for `HybridExecutor.initialize()`, a transition request
  can reach the route while project runtimes are still loading. The route must then answer with a
  bounded, retryable 503 naming the state truthfully, and must not persist the new isolationMode —
  otherwise the stored mode would disagree with the live runtime, which is the exact confusion the
  pre-existing `isolation_transition_unavailable` branch was added to remove.
  */
  it("answers 503 hybrid_executor_starting while project runtimes are still loading", async () => {
    const hybridExecutor = readyExecutor();
    hybridExecutor.whenReady.mockImplementation(() => new Promise(() => {}));

    const res = await request(
      createApp({ hybridExecutor: hybridExecutor as any, hybridExecutorReadyWaitMs: 20 }),
      "PATCH",
      "/api/projects/proj_1",
      JSON.stringify({ isolationMode: "child-process" }),
      { "content-type": "application/json" },
    );

    expect(res.status).toBe(503);
    expect((res.body as { error?: string }).error).toBe("hybrid_executor_starting");
    expect(hybridExecutor.transitionProjectIsolation).not.toHaveBeenCalled();
    // The transition was refused, so nothing may have been persisted about it.
    expect(central.updateProject).not.toHaveBeenCalled();
  });

  it("answers 503 hybrid_executor_failed when the executor boot never succeeded", async () => {
    const hybridExecutor = readyExecutor();
    hybridExecutor.whenReady.mockRejectedValue(new Error("project runtime loading has not completed"));

    const res = await request(
      createApp({ hybridExecutor: hybridExecutor as any, hybridExecutorReadyWaitMs: 20 }),
      "PATCH",
      "/api/projects/proj_1",
      JSON.stringify({ isolationMode: "child-process" }),
      { "content-type": "application/json" },
    );

    expect(res.status).toBe(503);
    expect((res.body as { error?: string }).error).toBe("hybrid_executor_failed");
    expect(hybridExecutor.transitionProjectIsolation).not.toHaveBeenCalled();
    expect(central.updateProject).not.toHaveBeenCalled();
  });

  it("transitions without a readiness delay when the executor is already initialized", async () => {
    const hybridExecutor = readyExecutor();

    // A generous bound proves the fast path returns from `whenReady()` itself rather than from the
    // deadline: a route that always waited the bound would take >= the bound here.
    const startedAt = Date.now();
    const res = await request(
      createApp({ hybridExecutor: hybridExecutor as any, hybridExecutorReadyWaitMs: 5_000 }),
      "PATCH",
      "/api/projects/proj_1",
      JSON.stringify({ isolationMode: "child-process" }),
      { "content-type": "application/json" },
    );

    expect(res.status).toBe(200);
    expect(hybridExecutor.whenReady).toHaveBeenCalledTimes(1);
    expect(hybridExecutor.transitionProjectIsolation).toHaveBeenCalledTimes(1);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });
});
