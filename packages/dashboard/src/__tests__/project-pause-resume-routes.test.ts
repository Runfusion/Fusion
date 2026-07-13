// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import { createApiRoutes } from "../routes.js";
import { request } from "../test-request.js";
import type { TaskStore } from "@fusion/core";

// Mock @fusion/core
const mockCentralListProjects = vi.fn().mockResolvedValue([]);
const mockCentralInit = vi.fn().mockResolvedValue(undefined);
const mockCentralClose = vi.fn().mockResolvedValue(undefined);
const mockCentralReconcileProjectStatuses = vi.fn().mockResolvedValue(undefined);
const mockCentralGetProject = vi.fn().mockResolvedValue(null);
const mockCentralUpdateProject = vi.fn().mockResolvedValue(undefined);
const mockCentralUpdateProjectHealth = vi.fn().mockResolvedValue(undefined);

vi.mock("@fusion/core", async () => {
  const actual = await vi.importActual<typeof import("@fusion/core")>("@fusion/core");
  return {
    ...actual,
    isGhAuthenticated: vi.fn(),
    CentralCore: vi.fn().mockImplementation(function () { return {
      init: mockCentralInit,
      close: mockCentralClose,
      listProjects: mockCentralListProjects,
      reconcileProjectStatuses: mockCentralReconcileProjectStatuses,
      getProject: mockCentralGetProject,
      updateProject: mockCentralUpdateProject,
      updateProjectHealth: mockCentralUpdateProjectHealth,
    }; }),
  };
});

vi.mock("@fusion/engine", () => ({
  // FNXC:TestInfrastructure 2026-07-13-11:05: Missing @fusion/engine barrel exports added for mock completeness (check-mock-completeness.mjs gate).
  getExemptToolNames: vi.fn(() => []),
  promptWithFallback: vi.fn(),
  reloadExemptTools: vi.fn(),
  resolveIntegrationBranch: vi.fn(),
  discoverMcpServers: vi.fn(() => []),
  resolveMcpServersForRuntime: vi.fn(() => []),
  resolveMcpServersForStore: vi.fn(() => []),
  validateMcpServer: vi.fn(),
  isInProcessBackupCommand: vi.fn(),
  isInProcessMemoryBackupCommand: vi.fn(),
  formatInProcessBackupError: vi.fn(),
  listCliAdapterDescriptors: () => [],
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
  createResolvedAgentSession: vi.fn(async () => ({
    session: { state: { messages: [] }, prompt: vi.fn(), dispose: vi.fn() },
    runtimeModel: undefined,
  })),
  ExperimentFinalizeService: class {
    async finalize() {
      return { keptRuns: [], droppedRuns: [], branches: [] };
    }
  },
  defaultGitOps: vi.fn(() => ({})),
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

const mockProjectData = {
  id: "proj_test",
  name: "Test Project",
  path: "/tmp/test",
  status: "active",
  isolationMode: "in-process" as const,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

describe("Project pause/resume routes", () => {
  let store: TaskStore;

  const mockEngineManager = {
    pauseProject: vi.fn().mockResolvedValue(undefined),
    resumeProject: vi.fn().mockResolvedValue(undefined),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    store = createMockStore();
    // Set up mock return values
    mockCentralGetProject.mockResolvedValue(mockProjectData);
    mockCentralUpdateProject.mockResolvedValue(undefined);
    mockCentralUpdateProjectHealth.mockResolvedValue(undefined);
    mockCentralInit.mockResolvedValue(undefined);
    mockCentralClose.mockResolvedValue(undefined);
  });

  describe("with engineManager", () => {
    function buildApp() {
      const app = express();
      app.use(express.json());
      app.use("/api", createApiRoutes(store, { engineManager: mockEngineManager as any }));
      return app;
    }

    it("POST /projects/:id/pause — calls engineManager.pauseProject and returns updated project", async () => {
      const pausedProject = { ...mockProjectData, status: "paused" };
      mockCentralGetProject.mockResolvedValue(pausedProject);

      const res = await request(buildApp(), "POST", "/api/projects/proj_test/pause");

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("paused");
      expect(mockEngineManager.pauseProject).toHaveBeenCalledWith("proj_test");
    });

    it("POST /projects/:id/resume — calls engineManager.resumeProject and returns updated project", async () => {
      const activeProject = { ...mockProjectData, status: "active" };
      mockCentralGetProject.mockResolvedValue(activeProject);

      const res = await request(buildApp(), "POST", "/api/projects/proj_test/resume");

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("active");
      expect(mockEngineManager.resumeProject).toHaveBeenCalledWith("proj_test");
    });
  });

  describe("without engineManager (dev mode fallback)", () => {
    function buildApp() {
      const app = express();
      app.use(express.json());
      app.use("/api", createApiRoutes(store));
      return app;
    }

    it("POST /projects/:id/pause — falls back to CentralCore when engineManager is absent", async () => {
      const pausedProject = { ...mockProjectData, status: "paused" };
      mockCentralGetProject.mockResolvedValue(pausedProject);

      const res = await request(buildApp(), "POST", "/api/projects/proj_test/pause");

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("paused");
      expect(mockCentralUpdateProject).toHaveBeenCalledWith("proj_test", { status: "paused" });
      expect(mockCentralUpdateProjectHealth).toHaveBeenCalledWith("proj_test", { status: "paused" });
    });

    it("POST /projects/:id/resume — falls back to CentralCore when engineManager is absent", async () => {
      const activeProject = { ...mockProjectData, status: "active" };
      mockCentralGetProject.mockResolvedValue(activeProject);

      const res = await request(buildApp(), "POST", "/api/projects/proj_test/resume");

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("active");
      expect(mockCentralUpdateProject).toHaveBeenCalledWith("proj_test", { status: "active" });
      expect(mockCentralUpdateProjectHealth).toHaveBeenCalledWith("proj_test", { status: "active" });
    });
  });
});
