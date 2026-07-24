// @vitest-environment node

import { describe, it, expect, vi } from "vitest";
import express from "express";
import type { TaskStore } from "@fusion/core";
import { createApiRoutes } from "../../routes.js";
import { request as REQUEST } from "../../test-request.js";

const makeTaskState = (overrides: Record<string, unknown> = {}) => ({
  id: "FN-001",
  description: "todo parked task",
  column: "todo",
  dependencies: [],
  steps: [],
  currentStep: 0,
  log: [],
  createdAt: "2026-05-15T00:00:00.000Z",
  updatedAt: "2026-05-15T00:00:00.000Z",
  paused: undefined,
  userPaused: undefined,
  ...overrides,
} as any);

const createPauseRouteHarness = (initialTaskState: any) => {
  let taskState = initialTaskState;
  const store: TaskStore = {
    getRootDir: vi.fn(() => process.cwd()),
    /*
    FNXC:PluginMcpServers 2026-07-24-01:25:
    FN-8491 (3cd023fa4) binds a project-scoped plugin-MCP provider on every getProjectContext.
    Exposing getProjectScopedPluginMcpServers marks this mock as runtime-owned so the binder
    short-circuits instead of calling getPluginStore().
    */
    getProjectScopedPluginMcpServers: vi.fn(async () => []),
    getTask: vi.fn(async () => taskState),
    pauseTask: vi.fn(async (_id: string, paused: boolean) => {
      taskState = {
        ...taskState,
        paused: paused ? true : undefined,
        userPaused: paused ? taskState.userPaused : undefined,
        pausedByAgentId: paused ? taskState.pausedByAgentId : undefined,
      };
      return taskState;
    }),
  } as unknown as TaskStore;

  const app = express();
  app.use(express.json());
  app.use("/api", createApiRoutes(store));
  return { app, store, getTaskState: () => taskState };
};

describe("task workflow pause routes", () => {
  it("clears userPaused latch for todo user-paused tasks", async () => {
    const { app, store, getTaskState } = createPauseRouteHarness(makeTaskState({ userPaused: true }));

    const res = await REQUEST(app, "POST", "/api/tasks/FN-001/unpause", JSON.stringify({}), {
      "content-type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(getTaskState().userPaused).toBeUndefined();
    expect(getTaskState().userPaused === true).toBe(false);
    expect(store.pauseTask).toHaveBeenCalledWith("FN-001", false);
  });

  it("allows agent-assigned paused tasks to be manually unpaused", async () => {
    const { app, store, getTaskState } = createPauseRouteHarness(makeTaskState({
      assignedAgentId: "agent-1",
      paused: true,
      pausedByAgentId: "agent-1",
    }));

    const res = await REQUEST(app, "POST", "/api/tasks/FN-001/unpause", JSON.stringify({}), {
      "content-type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(getTaskState().paused).toBeUndefined();
    expect(getTaskState().pausedByAgentId).toBeUndefined();
    expect(store.pauseTask).toHaveBeenCalledWith("FN-001", false);
  });

  it("allows agent-assigned tasks to be manually paused", async () => {
    const { app, store, getTaskState } = createPauseRouteHarness(makeTaskState({ assignedAgentId: "agent-1" }));

    const res = await REQUEST(app, "POST", "/api/tasks/FN-001/pause", JSON.stringify({}), {
      "content-type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(getTaskState().paused).toBe(true);
    expect(store.pauseTask).toHaveBeenCalledWith("FN-001", true);
  });
});
