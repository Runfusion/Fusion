// @vitest-environment node

import express from "express";
import { describe, expect, it, vi } from "vitest";
import { request } from "../../test-request.js";
import { registerProjectRoutes } from "../register-project-routes.js";
import { createApiRoutes } from "../../routes.js";
import { resolveEffectiveConcurrency, type TaskStore } from "@fusion/core";

const getOrCreateProjectStore = vi.hoisted(() => vi.fn());

vi.mock("../../project-store-resolver.js", () => ({
  getOrCreateProjectStore: (...args: unknown[]) => getOrCreateProjectStore(...args),
  evictProjectStore: vi.fn(),
}));

function createLiveStore(settings: Record<string, unknown>): TaskStore {
  return {
    getSettings: vi.fn().mockResolvedValue(settings),
    getSettingsFast: vi.fn().mockResolvedValue(settings),
    getActivityLog: vi.fn().mockResolvedValue([]),
    getRootDir: vi.fn().mockReturnValue("/live"),
    getFusionDir: vi.fn().mockReturnValue("/live/.fusion"),
    listTasks: vi.fn().mockResolvedValue([]),
    getProjectScopedPluginMcpServers: vi.fn().mockResolvedValue([]),
  } as unknown as TaskStore;
}

async function requestReportingSurfaces(settings: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  const liveStore = createLiveStore(settings);
  getOrCreateProjectStore.mockResolvedValue(liveStore);
  app.use("/api", createApiRoutes(liveStore));
  registerProjectRoutes({
    router: app,
    options: { centralCore: { getProject: vi.fn().mockResolvedValue({ id: "project-live", path: "/live" }) } },
    runtimeLogger: { child: () => ({ warn: vi.fn() }), warn: vi.fn() },
    prioritizeProjectsForCurrentDirectory: vi.fn(),
    rethrowAsApiError: (error: unknown): never => { throw error; },
  } as never);

  const [config, executorStats, projectConfig] = await Promise.all([
    request(app, "GET", "/api/config"),
    request(app, "GET", "/api/executor/stats"),
    request(app, "GET", "/projects/project-live/config"),
  ]);
  return { config, executorStats, projectConfig, liveStore };
}

/*
FNXC:CapacityModel 2026-08-21-17:24:
FN-9185 requires a production-route matrix rather than route-local payload checks.
Every reporter must read the same live project blob and expose the independent agent and
execution-worktree dimensions for unset, configured, and worktree-disabled states.
*/
describe("concurrency reporting route authority", () => {
  it.each([
    ["unset", {}, { maxConcurrent: 2, maxWorktrees: 4, worktreeLimitEnabled: true }],
    ["configured", { maxConcurrent: 6, maxWorktrees: 9, worktreeLimitEnabled: true }, { maxConcurrent: 6, maxWorktrees: 9, worktreeLimitEnabled: true }],
    ["worktree-disabled", { maxConcurrent: 8, maxWorktrees: 4, worktreeLimitEnabled: false }, { maxConcurrent: 8, maxWorktrees: 4, worktreeLimitEnabled: false }],
  ] as const)("reports matching live capacity through all routes for %s settings", async (_state, settings, expected) => {
    const { config, executorStats, projectConfig, liveStore } = await requestReportingSurfaces(settings);

    for (const response of [config, executorStats, projectConfig]) {
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        maxConcurrent: expected.maxConcurrent,
        maxWorktrees: expected.maxWorktrees,
        worktreeLimitEnabled: expected.worktreeLimitEnabled,
      });
    }
    expect(liveStore.getSettingsFast).toHaveBeenCalled();
    expect(liveStore.getSettings).toHaveBeenCalledOnce();
  });

  it("prefers a target project's live blob when a stale registry snapshot omits maxConcurrent", async () => {
    const { config, executorStats, projectConfig, liveStore } = await requestReportingSurfaces({ maxConcurrent: 6, maxWorktrees: 9, worktreeLimitEnabled: true });
    const capacity = resolveEffectiveConcurrency({ maxConcurrent: 6, maxWorktrees: 9, worktreeLimitEnabled: true });

    for (const response of [config, executorStats, projectConfig]) {
      expect(response.body).toMatchObject({
        maxConcurrent: capacity.maxConcurrent,
        maxWorktrees: capacity.worktreeLimit,
        worktreeLimitEnabled: true,
      });
    }
    expect(liveStore.getSettingsFast).toHaveBeenCalled();
  });
});
