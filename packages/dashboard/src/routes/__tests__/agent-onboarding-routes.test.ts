// @vitest-environment node

import express from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskStore } from "@fusion/core";
import { createApiRoutes } from "../../routes.js";
import { request } from "../../test-request.js";

const mockStartAgentOnboardingSession = vi.fn();

vi.mock("../../agent-onboarding.js", async () => {
  const actual = await vi.importActual<typeof import("../../agent-onboarding.js")>("../../agent-onboarding.js");
  return {
    ...actual,
    startAgentOnboardingSession: mockStartAgentOnboardingSession,
  };
});

function createMockStore(): TaskStore {
  return {
    getTask: vi.fn(),
    listTasks: vi.fn().mockResolvedValue([]),
    searchTasks: vi.fn().mockResolvedValue([]),
    createTask: vi.fn(),
    moveTask: vi.fn(),
    updateTask: vi.fn(),
    deleteTask: vi.fn(),
    mergeTask: vi.fn(),
    archiveTask: vi.fn(),
    unarchiveTask: vi.fn(),
    getSettings: vi.fn().mockResolvedValue({}),
    getSettingsFast: vi.fn().mockResolvedValue({}),
    updateSettings: vi.fn(),
    updateGlobalSettings: vi.fn(),
    getSettingsByScope: vi.fn().mockResolvedValue({ global: {}, project: {} }),
    getSettingsByScopeFast: vi.fn().mockResolvedValue({ global: {}, project: {} }),
    getGlobalSettingsStore: vi.fn(),
    logEntry: vi.fn().mockResolvedValue(undefined),
    getAgentLogs: vi.fn().mockResolvedValue([]),
    getAgentLogCount: vi.fn().mockResolvedValue(0),
    getAgentLogsByTimeRange: vi.fn().mockResolvedValue([]),
    addSteeringComment: vi.fn(),
    addTaskComment: vi.fn(),
    updateTaskComment: vi.fn(),
    deleteTaskComment: vi.fn(),
    getTaskDocuments: vi.fn().mockResolvedValue([]),
    getTaskDocument: vi.fn().mockResolvedValue(null),
    getTaskDocumentRevisions: vi.fn().mockResolvedValue([]),
    getAllDocuments: vi.fn().mockResolvedValue([]),
    upsertTaskDocument: vi.fn(),
    deleteTaskDocument: vi.fn(),
    updatePrInfo: vi.fn(),
    updateIssueInfo: vi.fn(),
    getRootDir: vi.fn().mockReturnValue("/fake/root"),
    getFusionDir: vi.fn().mockReturnValue("/fake/root/.fusion"),
    getDatabase: vi.fn(),
    listWorkflowSteps: vi.fn().mockResolvedValue([]),
    createWorkflowStep: vi.fn(),
    getWorkflowStep: vi.fn(),
    updateWorkflowStep: vi.fn(),
    deleteWorkflowStep: vi.fn(),
    getMissionStore: vi.fn(),
  } as unknown as TaskStore;
}

function setupApp(store = createMockStore()) {
  const app = express();
  app.use(express.json());
  app.use("/api", createApiRoutes(store));
  return app;
}

describe("agent onboarding routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStartAgentOnboardingSession.mockResolvedValue("session-123");
  });

  it("defaults mode to create when omitted", async () => {
    const app = setupApp();
    const res = await request(app, "POST", "/api/agents/onboarding/start-streaming", JSON.stringify({
      intent: "Create a reviewer",
      context: { existingAgents: [], templates: [] },
    }), { "Content-Type": "application/json" });

    expect(res.status).toBe(201);
    expect(mockStartAgentOnboardingSession).toHaveBeenCalledTimes(1);
    expect(mockStartAgentOnboardingSession.mock.calls[0]?.[1]).toMatchObject({ mode: "create" });
  });

  it("uses the configured planning model when the request omits an override", async () => {
    const store = createMockStore();
    vi.mocked(store.getSettings).mockResolvedValue({
      planningProvider: "openai-codex",
      planningModelId: "gpt-5.6-sol",
    } as Awaited<ReturnType<TaskStore["getSettings"]>>);
    const app = setupApp(store);

    const res = await request(app, "POST", "/api/agents/onboarding/start-streaming", JSON.stringify({
      intent: "Create a computer-use tester",
      context: { existingAgents: [], templates: [] },
    }), { "Content-Type": "application/json" });

    expect(res.status).toBe(201);
    expect(mockStartAgentOnboardingSession).toHaveBeenCalledTimes(1);
    expect(mockStartAgentOnboardingSession.mock.calls[0]?.[3]).toBe("openai-codex");
    expect(mockStartAgentOnboardingSession.mock.calls[0]?.[4]).toBe("gpt-5.6-sol");
  });

  it("accepts edit mode and forwards existingAgentConfig", async () => {
    const app = setupApp();
    const res = await request(app, "POST", "/api/agents/onboarding/start-streaming", JSON.stringify({
      intent: "Improve this agent",
      mode: "edit",
      existingAgentConfig: {
        name: "Editor",
        instructionsText: "Current instructions",
        messageResponseMode: "on-heartbeat",
      },
      context: { existingAgents: [], templates: [] },
    }), { "Content-Type": "application/json" });

    expect(res.status).toBe(201);
    expect(mockStartAgentOnboardingSession).toHaveBeenCalledTimes(1);
    expect(mockStartAgentOnboardingSession.mock.calls[0]?.[1]).toMatchObject({
      mode: "edit",
      existingAgentConfig: {
        name: "Editor",
        instructionsText: "Current instructions",
        messageResponseMode: "on-heartbeat",
      },
    });
  });

  it("rejects invalid mode", async () => {
    const app = setupApp();
    const res = await request(app, "POST", "/api/agents/onboarding/start-streaming", JSON.stringify({
      intent: "x",
      mode: "bad",
      context: { existingAgents: [], templates: [] },
    }), { "Content-Type": "application/json" });

    expect(res.status).toBe(400);
    expect(res.body?.error).toContain("mode must be 'create' or 'edit'");
    expect(mockStartAgentOnboardingSession).not.toHaveBeenCalled();
  });
});
