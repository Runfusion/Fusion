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
    const hybridExecutor = { transitionProjectIsolation: vi.fn().mockResolvedValue({ ok: true }) };
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
    const hybridExecutor = {
      transitionProjectIsolation: vi
        .fn()
        .mockResolvedValueOnce({ ok: false, reason: "active_tasks", activeTaskCount: 2 })
        .mockResolvedValueOnce({ ok: true }),
    };

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
});
