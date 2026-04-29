// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import { request } from "../test-request.js";
import type { TaskStore } from "@fusion/core";

const mockCentralInit = vi.fn().mockResolvedValue(undefined);
const mockCentralClose = vi.fn().mockResolvedValue(undefined);
const mockCentralListProjects = vi.fn().mockResolvedValue([]);
const mockCentralGetGlobalDir = vi.fn().mockReturnValue("/tmp/fusion-global");

const mockDetectorDetectExistingProjects = vi.fn().mockResolvedValue([]);
const mockDetectorDetectFirstRunState = vi.fn().mockResolvedValue("fresh-install");
const mockDetectorHasCentralDb = vi.fn().mockReturnValue(false);

vi.mock("@fusion/core", async () => {
  const actual = await vi.importActual<typeof import("@fusion/core")>("@fusion/core");
  return {
    ...actual,
    isGhAuthenticated: vi.fn(),
    CentralCore: vi.fn().mockImplementation(() => ({
      init: mockCentralInit,
      close: mockCentralClose,
      listProjects: mockCentralListProjects,
      getGlobalDir: mockCentralGetGlobalDir,
    })),
    FirstRunDetector: vi.fn().mockImplementation(() => ({
      detectExistingProjects: mockDetectorDetectExistingProjects,
      detectFirstRunState: mockDetectorDetectFirstRunState,
      hasCentralDb: mockDetectorHasCentralDb,
    })),
  };
});

vi.mock("@fusion/engine", () => ({
  createFnAgent: vi.fn(async () => ({
    session: {
      state: { messages: [] as Array<{ role: string; content: string }> },
      prompt: vi.fn(async function (this: { state?: { messages?: Array<{ role: string; content: string }> } }, message: string) {
        const messages = this.state?.messages ?? [];
        messages.push({ role: "user", content: message });
        messages.push({ role: "assistant", content: JSON.stringify({ subtasks: [] }) });
      }),
      dispose: vi.fn(),
    },
  })),
  AgentReflectionService: class {
    async generateReflection(): Promise<never> { throw new Error("Reflection service unavailable"); }
    async buildReflectionContext(): Promise<never> { throw new Error("Reflection service unavailable"); }
  },
}));

function createMockStore(overrides: Partial<TaskStore> = {}): TaskStore {
  return {
    getTask: vi.fn(),
    listTasks: vi.fn().mockResolvedValue([]),
    searchTasks: vi.fn().mockResolvedValue([]),
    createTask: vi.fn(),
    moveTask: vi.fn(),
    updateTask: vi.fn(),
    deleteTask: vi.fn(),
    mergeTask: vi.fn(),
    getTaskByBranch: vi.fn(),
    getTaskByWorktree: vi.fn(),
    checkoutTask: vi.fn(),
    releaseTask: vi.fn(),
    listAgents: vi.fn().mockResolvedValue([]),
    createAgent: vi.fn(),
    updateAgent: vi.fn(),
    deleteAgent: vi.fn(),
    getAgent: vi.fn(),
    logAgentEvent: vi.fn(),
    logEntry: vi.fn(),
    addComment: vi.fn(),
    getComments: vi.fn().mockResolvedValue([]),
    updateSettings: vi.fn(),
    getSettings: vi.fn().mockResolvedValue({}),
    getRootDir: vi.fn().mockReturnValue("/tmp/test"),
    getFusionDir: vi.fn().mockReturnValue("/tmp/test/.fusion"),
    getPluginStore: vi.fn().mockReturnValue({
      listPlugins: vi.fn().mockResolvedValue([]),
      getPlugin: vi.fn(),
      registerPlugin: vi.fn(),
      updatePlugin: vi.fn(),
      unregisterPlugin: vi.fn(),
    }),
    getMissionStore: vi.fn().mockReturnValue({
      listMissions: vi.fn().mockResolvedValue([]),
    }),
    getRoutineStore: vi.fn().mockReturnValue({
      listRoutines: vi.fn().mockResolvedValue([]),
    }),
    getAutomationStore: vi.fn().mockReturnValue({
      listScheduledTasks: vi.fn().mockResolvedValue([]),
    }),
    ...overrides,
  } as unknown as TaskStore;
}

describe("setup routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCentralInit.mockResolvedValue(undefined);
    mockCentralClose.mockResolvedValue(undefined);
    mockCentralListProjects.mockResolvedValue([]);
    mockCentralGetGlobalDir.mockReturnValue("/tmp/fusion-global");
    mockDetectorDetectExistingProjects.mockResolvedValue([]);
    mockDetectorDetectFirstRunState.mockResolvedValue("fresh-install");
    mockDetectorHasCentralDb.mockReturnValue(false);
  });

  async function buildApp() {
    const { createApiRoutes } = await import("../routes.js");
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(createMockStore()));
    return app;
  }

  it("falls back to detected local projects when /api/first-run-status cannot open the central DB", async () => {
    mockCentralInit.mockRejectedValueOnce(new Error("file is not a database"));
    mockDetectorDetectExistingProjects.mockResolvedValueOnce([
      { path: "/workspace/f1", name: "f1", hasDb: true },
    ]);

    const res = await request(await buildApp(), "GET", "/api/first-run-status");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      hasProjects: true,
      singleProjectPath: "/workspace/f1",
    });
    expect(mockDetectorDetectExistingProjects).toHaveBeenCalledWith(process.cwd());
    expect(mockCentralClose).toHaveBeenCalledTimes(1);
  });

  it("returns setup state with empty registered projects when the central DB is unreadable", async () => {
    const detectedProjects = [{ path: "/workspace/f1", name: "f1", hasDb: true }];
    mockCentralInit.mockRejectedValueOnce(new Error("file is not a database"));
    mockDetectorDetectExistingProjects.mockResolvedValueOnce(detectedProjects);
    mockDetectorDetectFirstRunState.mockResolvedValueOnce("fresh-install");
    mockDetectorHasCentralDb.mockReturnValueOnce(true);

    const res = await request(await buildApp(), "GET", "/api/setup-state");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      state: "fresh-install",
      detectedProjects,
      hasCentralDb: true,
      registeredProjects: [],
    });
    expect(mockCentralListProjects).not.toHaveBeenCalled();
    expect(mockCentralClose).toHaveBeenCalledTimes(1);
  });
});
