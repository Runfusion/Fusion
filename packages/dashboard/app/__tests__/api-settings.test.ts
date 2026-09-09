import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { API_JSON_HEADERS } from "../test/apiRequestHeaders";
import {
  fetchTaskDetail,
  uploadAttachment,
  fetchAgentLogsWithMeta,
  fetchAiSessions,
  fetchAiSession,
  deleteAiSession,
  updateTask,
  createTask,
  connectPlanningStream,
  connectSubtaskStream,
  connectMissionInterviewStream,
  assignTask,
  fetchAgentTasks,
  deleteTask,
  ApiRequestError,
  moveTask,
  mergeTask,
  retryTask,
  duplicateTask,
  pauseTask,
  unpauseTask,
  fetchAuthStatus,
  loginProvider,
  logoutProvider,
  fetchModels,
  addSteeringComment,
  addTaskComment,
  updateTaskComment,
  deleteTaskComment,
  fetchTaskComments,
  fetchGitRemotes,
  refineTask,
  fetchBatchStatus,
  fetchWorkspaces,
  fetchWorkspaceFileList,
  fetchWorkspaceFileContent,
  saveWorkspaceFileContent,
  deleteFile,
  startPlanningStreaming,
  startAgentOnboardingStreaming,
  respondToAgentOnboarding,
  retryAgentOnboardingSession,
  stopAgentOnboardingGeneration,
  cancelAgentOnboarding,
  fetchTasks,
  summarizeTitle,
  fetchProjects,
  registerProject,
  unregisterProject,
  fetchProjectHealth,
  fetchActivityFeed,
  pauseProject,
  resumeProject,
  fetchFirstRunStatus,
  fetchGlobalConcurrency,
  updateGlobalConcurrency,
  fetchPiSettings,
  updatePiSettings,
  installPiPackage,
  reinstallFusionPiPackage,
  fetchPiExtensions,
  updatePiExtensions,
  fetchProjectTasks,
  fetchProjectConfig,
  fetchExecutorStats,
  fetchAgentRunAudit,
  fetchAgentRunTimeline,
  streamChatResponse,
  fetchMemoryBackendStatus,
  type ProjectInfo,
  type ProjectHealth,
  type ActivityFeedEntry,
  type FirstRunStatus,
  type GlobalConcurrencyState,
  type ExecutorStats,
  type ExecutorState,
} from "../api";
import type { Task, TaskDetail, BatchStatusResponse, MergeResult } from "@fusion/core";
import { clearAuthToken } from "../auth";

const TASK_TOKEN_USAGE_FIXTURE = {
  inputTokens: 1000,
  outputTokens: 300,
  cachedTokens: 125,
  totalTokens: 1425,
  firstUsedAt: "2026-04-24T08:00:00.000Z",
  lastUsedAt: "2026-04-24T09:30:00.000Z",
};

const FAKE_DETAIL: TaskDetail = {
  id: "FN-001",
  description: "Test",
  column: "in-progress",
  dependencies: [],
  steps: [],
  currentStep: 0,
  log: [],
  tokenUsage: TASK_TOKEN_USAGE_FIXTURE,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  prompt: "# FN-001",
};

function mockFetchResponse(
  ok: boolean,
  body: unknown,
  status = ok ? 200 : 500,
  contentType = "application/json"
) {
  const bodyText = JSON.stringify(body);
  return Promise.resolve({
    ok,
    status,
    statusText: ok ? "OK" : "Error",
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "content-type" ? contentType : null,
    },
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(bodyText),
  } as unknown as Response);
}

beforeEach(() => {
  clearAuthToken();
  localStorage.removeItem("fn.authToken");
});

afterEach(() => {
  clearAuthToken();
  localStorage.removeItem("fn.authToken");
});


import {
  fetchGitRemotesDetailed,
  addGitRemote,
  removeGitRemote,
  renameGitRemote,
  updateGitRemoteUrl,
} from "../api";


import { approvePlan, rejectPlan } from "../api";

import {
  startAgentRun,
  createAgent,
  updateAgent,
  fetchGitStatus,
  fetchGitCommits,
  fetchCommitDiff,
  fetchAheadCommits,
  fetchRemoteCommits,
  fetchGitBranches,
  fetchGitWorktrees,
  createBranch,
  checkoutBranch,
  deleteBranch,
  fetchRemote,
  pullBranch,
  pushBranch,
} from "../api";


import { startPlanning, respondToPlanning, cancelPlanning, createTaskFromPlanning } from "../api";
import type { PlanningQuestion, PlanningSummary } from "@fusion/core";


import { refineText, getRefineErrorMessage, REFINE_ERROR_MESSAGES, type RefinementType } from "../api";


function mockHtmlErrorResponse(status: number, htmlBody: string) {
  return Promise.resolve({
    ok: false,
    status,
    statusText: "Not Found",
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "content-type" ? "text/html" : null,
    },
    json: () => Promise.reject(new Error("JSON parse error")),
    text: () => Promise.resolve(htmlBody),
  } as unknown as Response);
}

const FAKE_PROJECT: ProjectInfo = {
  id: "proj_abc123",
  name: "Test Project",
  path: "/path/to/project",
  status: "active",
  isolationMode: "in-process",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  lastActivityAt: "2026-01-01T00:00:00.000Z",
};

const FAKE_PROJECT_HEALTH: ProjectHealth = {
  projectId: "proj_abc123",
  status: "active",
  activeTaskCount: 5,
  inFlightAgentCount: 2,
  lastActivityAt: "2026-01-01T00:00:00.000Z",
  totalTasksCompleted: 100,
  totalTasksFailed: 5,
  averageTaskDurationMs: 600000,
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const FAKE_ACTIVITY_ENTRY: ActivityFeedEntry = {
  id: "act_123",
  timestamp: "2026-01-01T00:00:00.000Z",
  type: "task:created",
  projectId: "proj_abc123",
  projectName: "Test Project",
  taskId: "KB-001",
  taskTitle: "Test Task",
  details: "Task created",
};



function mockSchedulingFetchResponse(
  ok: boolean,
  body: unknown,
  status = ok ? 200 : 500,
  contentType = "application/json"
) {
  const bodyText = JSON.stringify(body);
  return Promise.resolve({
    ok,
    status,
    statusText: ok ? "OK" : "Error",
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "content-type" ? contentType : null,
    },
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(bodyText),
  } as unknown as Response);
}

/**
 * Settings API wrapper tests for FN-1712 (scope-split settings UX).
 * These tests verify the API contract for:
 * - fetchSettingsByScope: Returns { global, project } scoped settings
 * - updateGlobalSettings: PUT /api/settings/global
 * - updateSettings: PUT /api/settings (project scope)
 * - fetchGlobalSettings: GET /api/settings/global
 */
describe("Settings API wrappers", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("fetchSettingsByScope", () => {
    it("calls /api/settings/scopes with no query string when projectId is omitted", async () => {
      const { fetchSettingsByScope } = await import("../api");

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: {
          get: (name: string) =>
            name.toLowerCase() === "content-type" ? "application/json" : null,
        },
        json: () => Promise.resolve({ global: { themeMode: "dark" }, project: {} }),
        text: () => Promise.resolve(JSON.stringify({ global: { themeMode: "dark" }, project: {} })),
      } as unknown as Response);

      await fetchSettingsByScope();

      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      expect(globalThis.fetch).toHaveBeenCalledWith("/api/settings/scopes", expect.objectContaining({
        headers: API_JSON_HEADERS,
      }));
      // GET is the default method, so method should not be specified
      const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(call[1].method).toBeUndefined();
    });

    it("calls /api/settings/scopes?projectId=proj_123 when projectId is provided", async () => {
      const { fetchSettingsByScope } = await import("../api");

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: {
          get: (name: string) =>
            name.toLowerCase() === "content-type" ? "application/json" : null,
        },
        json: () => Promise.resolve({ global: { themeMode: "dark" }, project: {} }),
        text: () => Promise.resolve(JSON.stringify({ global: { themeMode: "dark" }, project: {} })),
      } as unknown as Response);

      await fetchSettingsByScope("proj_123");

      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      expect(globalThis.fetch).toHaveBeenCalledWith("/api/settings/scopes?projectId=proj_123", expect.objectContaining({
        headers: API_JSON_HEADERS,
      }));
      // GET is the default method
      const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(call[1].method).toBeUndefined();
    });

    it("returns the { global, project } shape", async () => {
      const { fetchSettingsByScope } = await import("../api");
      const mockResponse = {
        global: { themeMode: "dark", defaultProvider: "anthropic", defaultModelId: "claude-sonnet-4-5" },
        project: { planningProvider: "openai", planningModelId: "gpt-4o" },
      };

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: {
          get: (name: string) =>
            name.toLowerCase() === "content-type" ? "application/json" : null,
        },
        json: () => Promise.resolve(mockResponse),
        text: () => Promise.resolve(JSON.stringify(mockResponse)),
      } as unknown as Response);

      const result = await fetchSettingsByScope();

      expect(result).toHaveProperty("global");
      expect(result).toHaveProperty("project");
      expect(result.global.themeMode).toBe("dark");
      expect(result.global.defaultProvider).toBe("anthropic");
      expect(result.project.planningProvider).toBe("openai");
    });

    it("throws with server error message on failure", async () => {
      const { fetchSettingsByScope } = await import("../api");

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        headers: {
          get: (name: string) =>
            name.toLowerCase() === "content-type" ? "application/json" : null,
        },
        json: () => Promise.resolve({ error: "Database connection failed" }),
        text: () => Promise.resolve(JSON.stringify({ error: "Database connection failed" })),
      } as unknown as Response);

      await expect(fetchSettingsByScope()).rejects.toThrow("Database connection failed");
    });
  });

  describe("updateGlobalSettings", () => {
    it("sends PUT to /api/settings/global with the provided payload", async () => {
      const { updateGlobalSettings } = await import("../api");

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: {
          get: (name: string) =>
            name.toLowerCase() === "content-type" ? "application/json" : null,
        },
        json: () => Promise.resolve({ themeMode: "light" }),
        text: () => Promise.resolve(JSON.stringify({ themeMode: "light" })),
      } as unknown as Response);

      await updateGlobalSettings({ themeMode: "light" });

      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      const [url, options] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toBe("/api/settings/global");
      expect(options.method).toBe("PUT");
      expect(JSON.parse(options.body as string)).toEqual({ themeMode: "light" });
    });

    it("returns the settings object on success", async () => {
      const { updateGlobalSettings } = await import("../api");

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: {
          get: (name: string) =>
            name.toLowerCase() === "content-type" ? "application/json" : null,
        },
        json: () => Promise.resolve({ themeMode: "light", defaultProvider: "anthropic" }),
        text: () => Promise.resolve(JSON.stringify({ themeMode: "light", defaultProvider: "anthropic" })),
      } as unknown as Response);

      const result = await updateGlobalSettings({ defaultProvider: "anthropic" });

      expect(result.themeMode).toBe("light");
      expect(result.defaultProvider).toBe("anthropic");
    });

    it("throws with server error message on failure", async () => {
      const { updateGlobalSettings } = await import("../api");

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        statusText: "Bad Request",
        headers: {
          get: (name: string) =>
            name.toLowerCase() === "content-type" ? "application/json" : null,
        },
        json: () => Promise.resolve({ error: "Invalid settings format" }),
        text: () => Promise.resolve(JSON.stringify({ error: "Invalid settings format" })),
      } as unknown as Response);

      await expect(updateGlobalSettings({})).rejects.toThrow("Invalid settings format");
    });
  });

  describe("updateSettings scope rejection", () => {
    it("forwards payload to PUT /api/settings and surfaces resulting 400 error", async () => {
      const { updateSettings } = await import("../api");

      // The backend rejects global keys on PUT /api/settings
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        statusText: "Bad Request",
        headers: {
          get: (name: string) =>
            name.toLowerCase() === "content-type" ? "application/json" : null,
        },
        json: () => Promise.resolve({ error: "Global settings keys not allowed in project scope" }),
        text: () => Promise.resolve(JSON.stringify({ error: "Global settings keys not allowed in project scope" })),
      } as unknown as Response);

      // This documents the client/server contract: sending global keys to project endpoint fails
      await expect(updateSettings({ themeMode: "light" })).rejects.toThrow(
        "Global settings keys not allowed in project scope"
      );

      const [url, options] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toBe("/api/settings");
      expect(options.method).toBe("PUT");
    });

    it("sends PUT to /api/settings with project-scoped payload on success", async () => {
      const { updateSettings } = await import("../api");

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: {
          get: (name: string) =>
            name.toLowerCase() === "content-type" ? "application/json" : null,
        },
        json: () => Promise.resolve({ planningProvider: "openai" }),
        text: () => Promise.resolve(JSON.stringify({ planningProvider: "openai" })),
      } as unknown as Response);

      const result = await updateSettings({ planningProvider: "openai", planningModelId: "gpt-4o" });

      expect(result.planningProvider).toBe("openai");
      const [url, options] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toBe("/api/settings");
      expect(options.method).toBe("PUT");
      expect(JSON.parse(options.body as string)).toEqual({
        planningProvider: "openai",
        planningModelId: "gpt-4o",
      });
    });
  });

  describe("fetchGlobalSettings", () => {
    it("calls GET /api/settings/global with no query string", async () => {
      const { fetchGlobalSettings } = await import("../api");

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: {
          get: (name: string) =>
            name.toLowerCase() === "content-type" ? "application/json" : null,
        },
        json: () => Promise.resolve({ themeMode: "dark" }),
        text: () => Promise.resolve(JSON.stringify({ themeMode: "dark" })),
      } as unknown as Response);

      await fetchGlobalSettings();

      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      expect(globalThis.fetch).toHaveBeenCalledWith("/api/settings/global", expect.objectContaining({
        headers: API_JSON_HEADERS,
      }));
      // GET is the default method
      const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(call[1].method).toBeUndefined();
    });

    it("returns GlobalSettings with known keys like themeMode", async () => {
      const { fetchGlobalSettings } = await import("../api");
      const mockSettings = {
        themeMode: "light",
        defaultProvider: "anthropic",
        defaultModelId: "claude-sonnet-4-5",
      };

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: {
          get: (name: string) =>
            name.toLowerCase() === "content-type" ? "application/json" : null,
        },
        json: () => Promise.resolve(mockSettings),
        text: () => Promise.resolve(JSON.stringify(mockSettings)),
      } as unknown as Response);

      const result = await fetchGlobalSettings();

      expect(result.themeMode).toBe("light");
      expect(result.defaultProvider).toBe("anthropic");
    });

    it("throws with server error message on failure", async () => {
      const { fetchGlobalSettings } = await import("../api");

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        headers: {
          get: (name: string) =>
            name.toLowerCase() === "content-type" ? "application/json" : null,
        },
        json: () => Promise.resolve({ error: "Settings file corrupted" }),
        text: () => Promise.resolve(JSON.stringify({ error: "Settings file corrupted" })),
      } as unknown as Response);

      await expect(fetchGlobalSettings()).rejects.toThrow("Settings file corrupted");
    });
  });
});

describe("Automation API scope forwarding", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("fetchAutomations sends GET to /automations without scope by default", async () => {
    const { fetchAutomations } = await import("../api");
    globalThis.fetch = vi.fn().mockReturnValue(mockSchedulingFetchResponse(true, []));

    await fetchAutomations();

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("/api/automations");
  });

  it("fetchAutomations includes scope=global when specified", async () => {
    const { fetchAutomations } = await import("../api");
    globalThis.fetch = vi.fn().mockReturnValue(mockSchedulingFetchResponse(true, []));

    await fetchAutomations({ scope: "global" });

    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain("/api/automations?scope=global");
  });

  it("fetchAutomations includes scope=project and projectId when project-scoped", async () => {
    const { fetchAutomations } = await import("../api");
    globalThis.fetch = vi.fn().mockReturnValue(mockSchedulingFetchResponse(true, []));

    await fetchAutomations({ scope: "project", projectId: "proj-123" });

    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain("/api/automations");
    expect(url).toContain("scope=project");
    expect(url).toContain("projectId=proj-123");
  });

  it("createAutomation forwards scope context in query params", async () => {
    const { createAutomation } = await import("../api");
    const fakeSchedule = {
      id: "sched-001",
      name: "Test",
      scheduleType: "daily",
      cronExpression: "0 0 * * *",
      command: "echo test",
      enabled: true,
      scope: "project",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    globalThis.fetch = vi.fn().mockReturnValue({
      ok: true,
      status: 201,
      statusText: "Created",
      headers: { get: () => "application/json" },
      json: () => Promise.resolve(fakeSchedule),
      text: () => Promise.resolve(JSON.stringify(fakeSchedule)),
    } as unknown as Response);

    await createAutomation(
      { name: "Test", scheduleType: "daily", command: "echo test", enabled: true, scope: "project" },
      { scope: "project", projectId: "proj-123" }
    );

    const [url, opts] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain("/api/automations?scope=project&projectId=proj-123");
    const body = JSON.parse(opts.body);
    expect(body.name).toBe("Test");
    expect(body.scope).toBe("project");
  });

  it("createAutomation forwards scope context without projectId for global scope", async () => {
    const { createAutomation } = await import("../api");
    const fakeSchedule = {
      id: "sched-001",
      name: "Test",
      scheduleType: "daily",
      cronExpression: "0 0 * * *",
      command: "echo test",
      enabled: true,
      scope: "global",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    globalThis.fetch = vi.fn().mockReturnValue({
      ok: true,
      status: 201,
      statusText: "Created",
      headers: { get: () => "application/json" },
      json: () => Promise.resolve(fakeSchedule),
      text: () => Promise.resolve(JSON.stringify(fakeSchedule)),
    } as unknown as Response);

    await createAutomation(
      { name: "Test", scheduleType: "daily", command: "echo test", enabled: true },
      { scope: "global" }
    );

    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain("/api/automations?scope=global");
    expect(url).not.toContain("projectId");
  });

  it("runAutomation forwards scope context", async () => {
    const { runAutomation } = await import("../api");
    globalThis.fetch = vi.fn().mockReturnValue(mockSchedulingFetchResponse(true, { schedule: {}, result: { success: true } }));

    await runAutomation("sched-001", { scope: "project", projectId: "proj-123" });

    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain("/api/automations/sched-001/run?scope=project&projectId=proj-123");
  });

  it("toggleAutomation forwards scope context", async () => {
    const { toggleAutomation } = await import("../api");
    globalThis.fetch = vi.fn().mockReturnValue(mockSchedulingFetchResponse(true, { id: "sched-001", enabled: false }));

    await toggleAutomation("sched-001", { scope: "global" });

    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain("/api/automations/sched-001/toggle?scope=global");
  });
});

describe("Routine API scope forwarding", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("fetchRoutines sends GET to /routines without scope by default", async () => {
    const { fetchRoutines } = await import("../api");
    globalThis.fetch = vi.fn().mockReturnValue(mockSchedulingFetchResponse(true, []));

    await fetchRoutines();

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("/api/routines");
  });

  it("fetchRoutines includes scope=global when specified", async () => {
    const { fetchRoutines } = await import("../api");
    globalThis.fetch = vi.fn().mockReturnValue(mockSchedulingFetchResponse(true, []));

    await fetchRoutines({ scope: "global" });

    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain("/api/routines?scope=global");
  });

  it("fetchRoutines includes scope=project and projectId when project-scoped", async () => {
    const { fetchRoutines } = await import("../api");
    globalThis.fetch = vi.fn().mockReturnValue(mockSchedulingFetchResponse(true, []));

    await fetchRoutines({ scope: "project", projectId: "proj-456" });

    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain("/api/routines");
    expect(url).toContain("scope=project");
    expect(url).toContain("projectId=proj-456");
  });

  it("createRoutine forwards scope context in query params", async () => {
    const { createRoutine } = await import("../api");
    const fakeRoutine = {
      id: "routine-001",
      name: "Test Routine",
      enabled: true,
      trigger: { type: "manual" },
      scope: "project",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    globalThis.fetch = vi.fn().mockReturnValue({
      ok: true,
      status: 201,
      statusText: "Created",
      headers: { get: () => "application/json" },
      json: () => Promise.resolve(fakeRoutine),
      text: () => Promise.resolve(JSON.stringify(fakeRoutine)),
    } as unknown as Response);

    await createRoutine(
      { name: "Test Routine", agentId: "", trigger: { type: "manual" as const }, enabled: true },
      { scope: "project", projectId: "proj-456" }
    );

    const [url, opts] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain("/api/routines?scope=project&projectId=proj-456");
    const body = JSON.parse(opts.body);
    expect(body.name).toBe("Test Routine");
    expect(body.scope).toBeUndefined(); // scope is in query, not body (body comes from RoutineCreateInput)
  });

  it("updateRoutine forwards scope context", async () => {
    const { updateRoutine } = await import("../api");
    globalThis.fetch = vi.fn().mockReturnValue(mockSchedulingFetchResponse(true, { id: "routine-001", name: "Updated" }));

    await updateRoutine("routine-001", { name: "Updated" }, { scope: "project", projectId: "proj-456" });

    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain("/api/routines/routine-001?scope=project&projectId=proj-456");
  });

  it("deleteRoutine forwards scope context", async () => {
    const { deleteRoutine } = await import("../api");
    globalThis.fetch = vi.fn().mockReturnValue({
      ok: true,
      status: 204,
      statusText: "No Content",
      headers: { get: () => "application/json" },
      json: () => Promise.resolve(null),
      text: () => Promise.resolve(""),
    } as unknown as Response);

    await deleteRoutine("routine-001", { scope: "global" });

    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain("/api/routines/routine-001?scope=global");
  });

  it("runRoutine forwards scope context", async () => {
    const { runRoutine } = await import("../api");
    globalThis.fetch = vi.fn().mockReturnValue(mockSchedulingFetchResponse(true, { routine: {}, result: { success: true } }));

    await runRoutine("routine-001", { scope: "project", projectId: "proj-789" });

    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain("/api/routines/routine-001/trigger?scope=project&projectId=proj-789");
  });
});

describe("fetchPiSettings", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("fetches pi settings from /api/pi-settings", async () => {
    const mockSettings = {
      packages: ["npm:pi-example"],
      extensions: ["/path/to/extension"],
      skills: ["/path/to/skill"],
      prompts: ["/path/to/prompts"],
      themes: ["/path/to/themes"],
    };
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, mockSettings));

    const result = await fetchPiSettings();

    expect(result).toEqual(mockSettings);
    /*
    Exact headers, not a nested objectContaining (coderabbit #2652). `fetchPiSettings` goes through
    `api()`, so it carries the `x-fusion-client` attribution header — and a loose matcher would pass
    with that header silently dropped, which is precisely what these assertions are the only guard
    against. My own note in test/apiRequestHeaders.ts says so; this site was inconsistent with it.
    */
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/pi-settings", expect.objectContaining({
      headers: API_JSON_HEADERS,
    }));
  });

  it("throws with server error message on failure", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(
      mockFetchResponse(false, { error: "Failed to read settings" })
    );

    await expect(fetchPiSettings()).rejects.toThrow("Failed to read settings");
  });
});

describe("updatePiSettings", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("sends PUT to /api/pi-settings with settings body", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, { success: true }));

    const result = await updatePiSettings({ packages: ["npm:new-package"] });

    expect(result.success).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/pi-settings", expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({ packages: ["npm:new-package"] }),
    }));
  });

  it("sends all fields when updating multiple settings", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, { success: true }));

    const result = await updatePiSettings({
      packages: ["npm:pi-example"],
      extensions: ["/custom/extension"],
      skills: ["/custom/skill"],
      prompts: ["/custom/prompts"],
      themes: ["/custom/themes"],
    });

    expect(result.success).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/pi-settings", expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({
        packages: ["npm:pi-example"],
        extensions: ["/custom/extension"],
        skills: ["/custom/skill"],
        prompts: ["/custom/prompts"],
        themes: ["/custom/themes"],
      }),
    }));
  });
});

describe("installPiPackage", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("sends POST to /api/pi-settings/packages with source", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, { success: true }));

    const result = await installPiPackage("npm:pi-example");

    expect(result.success).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/pi-settings/packages", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ source: "npm:pi-example" }),
    }));
  });

  it("handles git source URLs", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, { success: true }));

    const result = await installPiPackage("git:https://github.com/example/pi-extension.git");

    expect(result.success).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/pi-settings/packages", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ source: "git:https://github.com/example/pi-extension.git" }),
    }));
  });
});

describe("reinstallFusionPiPackage", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("sends POST to /api/pi-settings/reinstall-fusion", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(
      mockFetchResponse(true, { success: true, source: "npm:@runfusion/fusion" })
    );

    const result = await reinstallFusionPiPackage();

    expect(result).toEqual({ success: true, source: "npm:@runfusion/fusion" });
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/pi-settings/reinstall-fusion", expect.objectContaining({
      method: "POST",
    }));
  });

  it("forwards projectId query parameter when provided", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(
      mockFetchResponse(true, { success: true, source: "npm:@runfusion/fusion" })
    );

    await reinstallFusionPiPackage("proj-123");

    expect(globalThis.fetch).toHaveBeenCalledWith("/api/pi-settings/reinstall-fusion?projectId=proj-123", expect.objectContaining({
      method: "POST",
    }));
  });

  it("throws API error message on failure", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(false, { error: "Reinstall failed" }, 500));

    await expect(reinstallFusionPiPackage()).rejects.toThrow("Reinstall failed");
  });
});

describe("fetchPiExtensions", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("sends GET to /api/settings/pi-extensions", async () => {
    const mockSettings = {
      extensions: [
        { id: "ext-1", name: "Example", source: "fusion-global", path: "/path/to/ext", enabled: true },
      ],
      disabledIds: [],
      settingsPath: "/path/to/settings",
    };
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, mockSettings));

    const result = await fetchPiExtensions();

    expect(result.extensions).toEqual(mockSettings.extensions);
    expect(result.disabledIds).toEqual(mockSettings.disabledIds);
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/settings/pi-extensions", expect.any(Object));
  });

  it("includes projectId query param when provided", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, { extensions: [], disabledIds: [], settingsPath: "" }));

    await fetchPiExtensions("proj-123");

    expect(globalThis.fetch).toHaveBeenCalledWith("/api/settings/pi-extensions?projectId=proj-123", expect.any(Object));
  });

  it("returns empty extensions when no extensions", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, { extensions: [], disabledIds: [], settingsPath: "" }));

    const result = await fetchPiExtensions();

    expect(result.extensions).toEqual([]);
  });

  it("handles all source types", async () => {
    const mockSettings = {
      extensions: [
        { id: "ext-1", name: "Fusion Global", source: "fusion-global", path: "/path", enabled: true },
        { id: "ext-2", name: "Pi Global", source: "pi-global", path: "/path", enabled: true },
        { id: "ext-3", name: "Fusion Project", source: "fusion-project", path: "/path", enabled: false },
        { id: "ext-4", name: "Pi Project", source: "pi-project", path: "/path", enabled: true },
      ],
      disabledIds: ["ext-3"],
      settingsPath: "/path/to/settings",
    };
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, mockSettings));

    const result = await fetchPiExtensions();

    expect(result.extensions).toHaveLength(4);
    expect(result.extensions[0].source).toBe("fusion-global");
  });

  it("throws error on API failure", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(false, { error: "Server error" }, 500));

    await expect(fetchPiExtensions()).rejects.toThrow();
  });
});

describe("updatePiExtensions", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("sends PUT to /api/settings/pi-extensions with disabledIds", async () => {
    const mockSettings = { extensions: [], disabledIds: ["ext-1", "ext-2"], settingsPath: "" };
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, mockSettings));

    const result = await updatePiExtensions(["ext-1", "ext-2"]);

    expect(globalThis.fetch).toHaveBeenCalledWith("/api/settings/pi-extensions", expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({ disabledIds: ["ext-1", "ext-2"] }),
    }));
    expect(result.disabledIds).toEqual(["ext-1", "ext-2"]);
  });

  it("includes projectId query param when provided", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, { extensions: [], disabledIds: [], settingsPath: "" }));

    await updatePiExtensions([], "proj-456");

    expect(globalThis.fetch).toHaveBeenCalledWith("/api/settings/pi-extensions?projectId=proj-456", expect.any(Object));
  });

  it("sends empty disabledIds array", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, { extensions: [], disabledIds: [], settingsPath: "" }));

    await updatePiExtensions([]);

    expect(globalThis.fetch).toHaveBeenCalledWith("/api/settings/pi-extensions", expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({ disabledIds: [] }),
    }));
  });

  it("throws error on API failure", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(false, { error: "Server error" }, 500));

    await expect(updatePiExtensions(["ext-1"])).rejects.toThrow();
  });
});

describe("agent onboarding API wrappers", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("starts onboarding streaming session with create context payload", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, { sessionId: "onb-1" }, 201));

    const result = await startAgentOnboardingStreaming(
      "Need a docs reviewer",
      {
        existingAgents: [{ id: "agent-1", name: "Reviewer", role: "reviewer" }],
        templates: [{ id: "preset-1", label: "Reviewer preset" }],
        mode: "create",
      },
      "proj-123",
      { planningModelProvider: "openai", planningModelId: "gpt-4o" },
    );

    expect(result.sessionId).toBe("onb-1");
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/agents/onboarding/start-streaming?projectId=proj-123", {
      headers: API_JSON_HEADERS,
      method: "POST",
      body: JSON.stringify({
        intent: "Need a docs reviewer",
        context: {
          existingAgents: [{ id: "agent-1", name: "Reviewer", role: "reviewer" }],
          templates: [{ id: "preset-1", label: "Reviewer preset" }],
          mode: "create",
        },
        mode: "create",
        planningModelProvider: "openai",
        planningModelId: "gpt-4o",
      }),
    });
  });

  it("starts onboarding streaming session with edit context payload", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, { sessionId: "onb-edit" }, 201));

    const result = await startAgentOnboardingStreaming(
      "Tighten this agent's review quality",
      {
        existingAgents: [{ id: "agent-1", name: "Reviewer", role: "reviewer" }],
        templates: [{ id: "preset-1", label: "Reviewer preset" }],
        mode: "edit",
        existingAgentConfig: {
          name: "Reviewer",
          role: "reviewer",
          instructionsText: "Current instructions",
          runtimeHint: "openclaw",
          heartbeatIntervalMs: 30000,
        },
      },
      "proj-123",
    );

    expect(result.sessionId).toBe("onb-edit");
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/agents/onboarding/start-streaming?projectId=proj-123",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          intent: "Tighten this agent's review quality",
          context: {
            existingAgents: [{ id: "agent-1", name: "Reviewer", role: "reviewer" }],
            templates: [{ id: "preset-1", label: "Reviewer preset" }],
            mode: "edit",
            existingAgentConfig: {
              name: "Reviewer",
              role: "reviewer",
              instructionsText: "Current instructions",
              runtimeHint: "openclaw",
              heartbeatIntervalMs: 30000,
            },
          },
          mode: "edit",
          existingAgentConfig: {
            name: "Reviewer",
            role: "reviewer",
            instructionsText: "Current instructions",
            runtimeHint: "openclaw",
            heartbeatIntervalMs: 30000,
          },
        }),
      }),
    );
  });

  it("posts onboarding response/retry/stop/cancel endpoints", async () => {
    globalThis.fetch = vi.fn()
      .mockReturnValueOnce(mockFetchResponse(true, { type: "question", data: { id: "q1", type: "text", question: "?" } }))
      .mockReturnValueOnce(mockFetchResponse(true, { success: true, sessionId: "onb-1" }))
      .mockReturnValueOnce(mockFetchResponse(true, { success: true }))
      .mockReturnValueOnce(mockFetchResponse(true, {}));

    await respondToAgentOnboarding("onb-1", { q1: "answer" }, "proj-123");
    await retryAgentOnboardingSession("onb-1", "proj-123");
    await stopAgentOnboardingGeneration("onb-1", "proj-123");
    await cancelAgentOnboarding("onb-1", "proj-123");

    expect(globalThis.fetch).toHaveBeenNthCalledWith(1, "/api/agents/onboarding/respond?projectId=proj-123", expect.objectContaining({ method: "POST" }));
    expect(globalThis.fetch).toHaveBeenNthCalledWith(2, "/api/agents/onboarding/onb-1/retry?projectId=proj-123", expect.objectContaining({ method: "POST" }));
    expect(globalThis.fetch).toHaveBeenNthCalledWith(3, "/api/agents/onboarding/onb-1/stop?projectId=proj-123", expect.objectContaining({ method: "POST" }));
    expect(globalThis.fetch).toHaveBeenNthCalledWith(4, "/api/agents/onboarding/cancel?projectId=proj-123", expect.objectContaining({ method: "POST" }));
  });
});
