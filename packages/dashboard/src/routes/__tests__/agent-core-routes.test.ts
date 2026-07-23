// @vitest-environment node

import express from "express";
import { describe, expect, it, vi } from "vitest";
import type { TaskStore } from "@fusion/core";
import { createApiRoutes } from "../../routes.js";
import { request } from "../../test-request.js";

const updateAgent = vi.fn();

vi.mock("@fusion/core", async () => {
  const actual = await vi.importActual<typeof import("@fusion/core")>("@fusion/core");
  class MockAgentStore {
    async init() {}
    updateAgent = updateAgent;
  }
  return { ...actual, AgentStore: MockAgentStore };
});

function createStore(): TaskStore {
  return {
    getRootDir: vi.fn().mockReturnValue("/fake/project"),
    getFusionDir: vi.fn().mockReturnValue("/fake/project/.fusion"),
    getAsyncLayer: vi.fn().mockReturnValue(undefined),
    getSettings: vi.fn().mockResolvedValue({}),
    getSettingsFast: vi.fn().mockResolvedValue({}),
    getSettingsByScope: vi.fn().mockResolvedValue({ global: {}, project: {} }),
    getSettingsByScopeFast: vi.fn().mockResolvedValue({ global: {}, project: {} }),
    getGlobalSettingsStore: vi.fn(),
    getPluginStore: vi.fn().mockReturnValue({ init: vi.fn().mockResolvedValue(undefined), listPlugins: vi.fn().mockResolvedValue([]) }),
    listTasks: vi.fn().mockResolvedValue([]),
    searchTasks: vi.fn().mockResolvedValue([]),
    getAgentLogs: vi.fn().mockResolvedValue([]),
    getAgentLogCount: vi.fn().mockResolvedValue(0),
    getAgentLogsByTimeRange: vi.fn().mockResolvedValue([]),
    getTaskDocuments: vi.fn().mockResolvedValue([]),
    getTaskDocument: vi.fn().mockResolvedValue(null),
    getTaskDocumentRevisions: vi.fn().mockResolvedValue([]),
    getAllDocuments: vi.fn().mockResolvedValue([]),
    listWorkflowSteps: vi.fn().mockResolvedValue([]),
    getMissionStore: vi.fn(),
  } as unknown as TaskStore;
}

describe("agent core PATCH route", () => {
  it("passes a complete heartbeat runtime config to the project-scoped agent store without lifecycle transitions", async () => {
    updateAgent.mockResolvedValue({ id: "agent-1" });
    const store = createStore();
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store));
    const runtimeConfig = {
      enabled: false,
      heartbeatIntervalMs: 30_000,
      heartbeatTimeoutMs: 10_000,
      maxConcurrentRuns: 2,
      assignmentMode: "shared",
      skipHeartbeatWhenIdle: true,
      model: "provider/model",
      unknownFutureKey: "preserved",
    };

    const response = await request(app, "PATCH", "/api/agents/agent-1", JSON.stringify({ runtimeConfig }), { "Content-Type": "application/json" });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(updateAgent).toHaveBeenCalledWith("agent-1", { runtimeConfig });
    expect(store.getFusionDir).toHaveBeenCalled();
  });
});
