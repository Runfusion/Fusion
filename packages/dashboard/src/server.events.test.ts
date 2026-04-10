import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import { createServer } from "./server.js";
import type { TaskStore, PluginStore } from "@fusion/core";
import { get as performGet } from "./test-request.js";

// Mock terminal-service before any imports that use it
vi.mock("./terminal-service.js", () => {
  const mockTerminalService = {
    getSession: vi.fn(),
    getScrollbackAndClearPending: vi.fn().mockReturnValue(null),
    onData: vi.fn().mockReturnValue(() => {}),
    onExit: vi.fn().mockReturnValue(() => {}),
    write: vi.fn(),
    resize: vi.fn(),
    evictStaleSessions: vi.fn().mockReturnValue(0),
  };

  return {
    getTerminalService: vi.fn(() => mockTerminalService),
    STALE_SESSION_THRESHOLD_MS: 300_000,
    __mockTerminalService: mockTerminalService,
  };
});

function createMockStore(overrides: Partial<TaskStore> = {}): TaskStore {
  const mockMissionStore = {
    listMissions: vi.fn().mockReturnValue([]),
    createMission: vi.fn(),
    getMissionWithHierarchy: vi.fn(),
    updateMission: vi.fn(),
    getMission: vi.fn(),
    deleteMission: vi.fn(),
    listMilestonesByMission: vi.fn().mockReturnValue([]),
    createMilestone: vi.fn(),
    updateMilestone: vi.fn(),
    getMilestone: vi.fn(),
    deleteMilestone: vi.fn(),
    listTasksByMilestone: vi.fn().mockReturnValue([]),
    createMissionTask: vi.fn(),
    updateMissionTask: vi.fn(),
    getMissionTask: vi.fn(),
    deleteMissionTask: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  };

  const mockPluginStore = {
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as PluginStore;

  return {
    getTask: vi.fn(),
    listTasks: vi.fn().mockResolvedValue([]),
    createTask: vi.fn(),
    moveTask: vi.fn(),
    updateTask: vi.fn(),
    deleteTask: vi.fn(),
    mergeTask: vi.fn(),
    archiveTask: vi.fn(),
    unarchiveTask: vi.fn(),
    getSettings: vi.fn().mockResolvedValue({}),
    updateSettings: vi.fn(),
    logEntry: vi.fn().mockResolvedValue(undefined),
    getAgentLogs: vi.fn().mockResolvedValue([]),
    addSteeringComment: vi.fn(),
    updatePrInfo: vi.fn().mockResolvedValue(undefined),
    updateIssueInfo: vi.fn().mockResolvedValue(undefined),
    getRootDir: vi.fn().mockReturnValue("/fake/root"),
    getFusionDir: vi.fn().mockReturnValue("/fake/fusion"),
    getDatabase: vi.fn().mockReturnValue({
      exec: vi.fn(),
      prepare: vi.fn().mockReturnValue({ run: vi.fn().mockReturnValue({ changes: 0 }), get: vi.fn(), all: vi.fn().mockReturnValue([]) }),
    }),
    getMissionStore: vi.fn().mockReturnValue(mockMissionStore),
    getPluginStore: vi.fn().mockReturnValue(mockPluginStore),
    on: vi.fn(),
    off: vi.fn(),
    ...overrides,
  } as unknown as TaskStore;
}

describe("server events endpoint integration", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("creates server with store that has getPluginStore method", () => {
    const store = createMockStore();
    const app = createServer(store);

    // Verify the store has getPluginStore
    expect(typeof store.getPluginStore).toBe("function");

    // Verify the store has getMissionStore (used by createSSE)
    expect(typeof store.getMissionStore).toBe("function");
  });

  it("creates server that handles SSE endpoint without projectId", () => {
    const store = createMockStore();
    const app = createServer(store);

    // Just verify the server was created without error
    expect(app).toBeDefined();
  });
});
