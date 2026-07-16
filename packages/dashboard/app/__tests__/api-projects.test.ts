import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
  archiveTask,
  unarchiveTask,
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
  fetchCodebaseMetrics,
  fetchProjectPathMappings,
  fetchProjectPathMapping,
  upsertProjectPathMapping,
  removeProjectPathMapping,
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


describe("API Error Handling", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("JSON responses", () => {
    it("parses successful JSON responses correctly", async () => {
      const tasks = [{ id: "FN-001", title: "Test Task" }];
      globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, tasks));

      const result = await fetchTasks();

      expect(result).toEqual(tasks);
    });

    it("extracts error field from JSON error responses", async () => {
      globalThis.fetch = vi.fn().mockReturnValue(
        mockFetchResponse(false, { error: "Task not found" }, 404)
      );

      await expect(fetchTasks()).rejects.toThrow("Task not found");
    });

    it("uses status text when JSON error has no error field", async () => {
      globalThis.fetch = vi.fn().mockReturnValue(
        mockFetchResponse(false, { message: "Different field" }, 500)
      );

      await expect(fetchTasks()).rejects.toThrow("Request failed for /api/tasks: 500 Error");
    });
  });

  describe("Non-JSON error responses", () => {
    it("throws meaningful error for HTML 404 response", async () => {
      const html404 = "<!doctype html><html><body>Not Found</body></html>";
      globalThis.fetch = vi.fn().mockReturnValue(mockHtmlErrorResponse(404, html404));

      await expect(fetchTasks()).rejects.toThrow("API returned HTML instead of JSON");
      await expect(fetchTasks()).rejects.toThrow("404 Not Found");
    });

    it("truncates long HTML responses in error message", async () => {
      const longHtml = "<!doctype html>" + "x".repeat(200);
      globalThis.fetch = vi.fn().mockReturnValue(mockHtmlErrorResponse(500, longHtml));

      await expect(fetchTasks()).rejects.toThrow("API returned HTML instead of JSON");
      await expect(fetchTasks()).rejects.not.toThrow(longHtml);
    });

    it("handles empty HTML error responses", async () => {
      globalThis.fetch = vi.fn().mockReturnValue(mockHtmlErrorResponse(500, ""));

      await expect(fetchTasks()).rejects.toThrow("API returned HTML instead of JSON");
    });
  });

  describe("Non-JSON success responses", () => {
    it("throws a descriptive HTML fallback error including the endpoint URL", async () => {
      globalThis.fetch = vi.fn().mockReturnValue(
        Promise.resolve({
          ok: true,
          status: 200,
          statusText: "OK",
          headers: {
            get: (name: string) =>
              name.toLowerCase() === "content-type" ? "text/html" : null,
          },
          json: () => Promise.reject(new Error("JSON parse error")),
          text: () => Promise.resolve("<html>Unexpected HTML</html>"),
        } as unknown as Response)
      );

      await expect(fetchTasks()).rejects.toThrow("API returned HTML instead of JSON for /api/tasks");
    });

    it("includes planning endpoint URL and status when HTML is returned", async () => {
      globalThis.fetch = vi.fn().mockReturnValue(
        Promise.resolve({
          ok: true,
          status: 200,
          statusText: "OK",
          headers: {
            get: (name: string) =>
              name.toLowerCase() === "content-type" ? "text/html" : null,
          },
          json: () => Promise.reject(new Error("JSON parse error")),
          text: () => Promise.resolve("<!DOCTYPE html><html><body>SPA Fallback</body></html>"),
        } as unknown as Response)
      );

      await expect(startPlanningStreaming("Build auth")).rejects.toThrow(
        "API returned HTML instead of JSON for /api/planning/start-streaming. The endpoint may not be properly configured. (200 OK)"
      );
    });
  });

  describe("JSON parsing edge cases", () => {
    it("reports invalid JSON with the endpoint URL", async () => {
      globalThis.fetch = vi.fn().mockReturnValue(
        Promise.resolve({
          ok: false,
          status: 500,
          statusText: "Internal Server Error",
          headers: {
            get: (name: string) =>
              name.toLowerCase() === "content-type" ? "application/json" : null,
          },
          json: () => Promise.reject(new Error("Invalid JSON")),
          text: () => Promise.resolve("{invalid json}"),
        } as unknown as Response)
      );

      await expect(fetchTasks()).rejects.toThrow(
        "API returned invalid JSON for /api/tasks. (500 Internal Server Error)"
      );
    });
  });
});


describe("refineText", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("sends POST with text and type, returns refined text", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(
      mockFetchResponse(true, { refined: "Refined task description" })
    );

    const result = await refineText("Original text", "clarify");

    expect(result).toBe("Refined task description");
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/ai/refine-text", {
      headers: { "Content-Type": "application/json" },
      method: "POST",
      body: JSON.stringify({ text: "Original text", type: "clarify" }),
    });
  });

  it("passes projectId as query param for scoped settings resolution", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(
      mockFetchResponse(true, { refined: "Refined with scoped settings" })
    );

    const result = await refineText("Original text", "clarify", "proj-123");

    expect(result).toBe("Refined with scoped settings");
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/ai/refine-text?projectId=proj-123", {
      headers: { "Content-Type": "application/json" },
      method: "POST",
      body: JSON.stringify({ text: "Original text", type: "clarify" }),
    });
  });

  it("works with all four refinement types", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(
      mockFetchResponse(true, { refined: "Refined" })
    );

    const types: RefinementType[] = ["clarify", "add-details", "expand", "simplify"];

    for (const type of types) {
      const result = await refineText("Test text", type);
      expect(result).toBe("Refined");
    }
  });

  it("throws on rate limit error (429)", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(
      mockFetchResponse(false, { error: "Rate limit exceeded. Maximum 10 refinement requests per hour." }, 429)
    );

    await expect(refineText("Test", "clarify")).rejects.toThrow("Rate limit exceeded");
  });

  it("throws on invalid type error (422)", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(
      mockFetchResponse(false, { error: "type must be one of: clarify, add-details, expand, simplify" }, 422)
    );

    await expect(refineText("Test", "invalid" as RefinementType)).rejects.toThrow("type must be one of");
  });

  it("throws on validation error (400)", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(
      mockFetchResponse(false, { error: "text must be at least 1 character" }, 400)
    );

    await expect(refineText("", "clarify")).rejects.toThrow("text must be at least 1 character");
  });

  it("throws on server error (500)", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(
      mockFetchResponse(false, { error: "AI service error" }, 500)
    );

    await expect(refineText("Test", "clarify")).rejects.toThrow("AI service error");
  });
});

describe("getRefineErrorMessage", () => {
  it("returns rate limit message for rate limit errors", () => {
    const error = new Error("Rate limit exceeded");
    expect(getRefineErrorMessage(error)).toBe(REFINE_ERROR_MESSAGES.RATE_LIMIT);
  });

  it("returns rate limit message for 429 status", () => {
    const error = new Error("429 Too Many Requests");
    expect(getRefineErrorMessage(error)).toBe(REFINE_ERROR_MESSAGES.RATE_LIMIT);
  });

  it("returns invalid type message for invalid type errors", () => {
    const error = new Error("Invalid type selected");
    expect(getRefineErrorMessage(error)).toBe(REFINE_ERROR_MESSAGES.INVALID_TYPE);
  });

  it("passes through text validation errors", () => {
    const error = new Error("text must be at least 1 character");
    expect(getRefineErrorMessage(error)).toBe("text must be at least 1 character");
  });

  it("passes through text length errors", () => {
    const error = new Error("text must not exceed 2000 characters");
    expect(getRefineErrorMessage(error)).toBe("text must not exceed 2000 characters");
  });

  it("passes through type required errors", () => {
    const error = new Error("type is required");
    expect(getRefineErrorMessage(error)).toBe("type is required");
  });

  it("returns network message for unknown errors", () => {
    const error = new Error("Network failure");
    expect(getRefineErrorMessage(error)).toBe(REFINE_ERROR_MESSAGES.NETWORK);
  });

  it("returns network message for non-Error values", () => {
    expect(getRefineErrorMessage("string error")).toBe(REFINE_ERROR_MESSAGES.NETWORK);
    expect(getRefineErrorMessage(null)).toBe(REFINE_ERROR_MESSAGES.NETWORK);
    expect(getRefineErrorMessage(undefined)).toBe(REFINE_ERROR_MESSAGES.NETWORK);
  });
});

describe("REFINE_ERROR_MESSAGES", () => {
  it("has the expected error messages", () => {
    expect(REFINE_ERROR_MESSAGES.RATE_LIMIT).toBe("Too many refinement requests. Please wait an hour.");
    expect(REFINE_ERROR_MESSAGES.INVALID_TYPE).toBe("Invalid refinement option selected.");
    expect(REFINE_ERROR_MESSAGES.NETWORK).toBe("Failed to refine text. Please try again.");
  });
});

// --- Summarize Title Tests ---

describe("summarizeTitle", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns title on successful response", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      text: vi.fn().mockResolvedValue(JSON.stringify({ title: "Generated Title" })),
    });
    global.fetch = mockFetch;

    const result = await summarizeTitle("a".repeat(201));

    expect(result).toBe("Generated Title");
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/ai/summarize-title",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: "a".repeat(201), provider: undefined, modelId: undefined }),
      })
    );
  });

  it("adds Authorization header when daemon token is present", async () => {
    localStorage.setItem("fn.authToken", "daemon-token");
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      text: vi.fn().mockResolvedValue(JSON.stringify({ title: "Generated Title" })),
    });
    global.fetch = mockFetch;

    await summarizeTitle("a".repeat(201));

    const call = vi.mocked(global.fetch).mock.calls[0];
    const headers = new Headers((call[1] as RequestInit).headers);
    expect(headers.get("Authorization")).toBe("Bearer daemon-token");
    expect(headers.get("Content-Type")).toBe("application/json");
  });

  it("sends provider and modelId when provided", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      text: vi.fn().mockResolvedValue(JSON.stringify({ title: "Generated Title" })),
    });
    global.fetch = mockFetch;

    await summarizeTitle("a".repeat(201), "anthropic", "claude-sonnet-4-5");

    expect(mockFetch).toHaveBeenCalledWith(
      "/api/ai/summarize-title",
      expect.objectContaining({
        body: JSON.stringify({ description: "a".repeat(201), provider: "anthropic", modelId: "claude-sonnet-4-5" }),
      })
    );
  });

  it("throws descriptive error on 400 response", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      headers: new Headers({ "content-type": "application/json" }),
      text: vi.fn().mockResolvedValue(JSON.stringify({ error: "Description too short" })),
    });
    global.fetch = mockFetch;

    await expect(summarizeTitle("short")).rejects.toThrow("Invalid request: Description too short");
  });

  it("throws descriptive error on 429 response", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      headers: new Headers({ "content-type": "application/json" }),
      text: vi.fn().mockResolvedValue(JSON.stringify({ error: "Rate limit exceeded" })),
    });
    global.fetch = mockFetch;

    await expect(summarizeTitle("a".repeat(201))).rejects.toThrow("Rate limit exceeded: Rate limit exceeded");
  });

  it("throws descriptive error on 503 response", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      headers: new Headers({ "content-type": "application/json" }),
      text: vi.fn().mockResolvedValue(JSON.stringify({ error: "AI service unavailable" })),
    });
    global.fetch = mockFetch;

    await expect(summarizeTitle("a".repeat(201))).rejects.toThrow("AI service temporarily unavailable: AI service unavailable");
  });

  it("throws generic error on other failure responses", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      headers: new Headers({ "content-type": "application/json" }),
      text: vi.fn().mockResolvedValue(JSON.stringify({ error: "Internal server error" })),
    });
    global.fetch = mockFetch;

    await expect(summarizeTitle("a".repeat(201))).rejects.toThrow("Internal server error");
  });

  it("throws error for non-JSON responses", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "text/html" }),
      text: vi.fn().mockResolvedValue("<html>Not JSON</html>"),
    });
    global.fetch = mockFetch;

    await expect(summarizeTitle("a".repeat(201))).rejects.toThrow("API returned non-JSON response");
  });

  it("throws error when response has no title", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      text: vi.fn().mockResolvedValue(JSON.stringify({})),
    });
    global.fetch = mockFetch;

    await expect(summarizeTitle("a".repeat(201))).rejects.toThrow("API returned empty title");
  });
});

describe("fetchProjects", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns list of projects", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, [FAKE_PROJECT]));

    const result = await fetchProjects();

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("proj_abc123");
    expect(result[0].name).toBe("Test Project");
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/projects",
      expect.objectContaining({ headers: { "Content-Type": "application/json" } })
    );
  });

  it("throws on error response", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(false, { error: "Database error" }));

    await expect(fetchProjects()).rejects.toThrow("Database error");
  });
});

describe("registerProject", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("registers a new project", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, FAKE_PROJECT));

    const result = await registerProject({
      name: "Test Project",
      path: "/path/to/project",
      isolationMode: "in-process",
    });

    expect(result.id).toBe("proj_abc123");
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/projects",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          name: "Test Project",
          path: "/path/to/project",
          isolationMode: "in-process",
        }),
      })
    );
  });

  it("uses default isolation mode when not specified", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, FAKE_PROJECT));

    await registerProject({
      name: "Test Project",
      path: "/path/to/project",
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: JSON.stringify({
          name: "Test Project",
          path: "/path/to/project",
          isolationMode: undefined,
        }),
      })
    );
  });

  it("includes cloneUrl when cloning during registration", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, FAKE_PROJECT));

    await registerProject({
      name: "Test Project",
      path: "/path/to/new/project",
      isolationMode: "child-process",
      nodeId: "node-1",
      cloneUrl: "https://github.com/runfusion/fusion.git",
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/projects",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          name: "Test Project",
          path: "/path/to/new/project",
          isolationMode: "child-process",
          nodeId: "node-1",
          cloneUrl: "https://github.com/runfusion/fusion.git",
        }),
      }),
    );
  });
});

describe("unregisterProject", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("unregisters a project", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, {}));

    await unregisterProject("proj_abc123");

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/projects/proj_abc123",
      expect.objectContaining({ method: "DELETE" })
    );
  });

  it("url-encodes project id", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, {}));

    await unregisterProject("proj/with+special");

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/projects/proj%2Fwith%2Bspecial",
      expect.any(Object)
    );
  });
});

describe("project path mapping helpers", () => {
  it("fetchProjectPathMappings encodes project id", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, []));

    await fetchProjectPathMappings("proj/test+id");

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/projects/proj%2Ftest%2Bid/path-mappings",
      expect.any(Object),
    );
  });

  it("fetchProjectPathMapping encodes project and node ids", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(
      mockFetchResponse(true, { projectId: "proj", nodeId: "node", path: "/tmp", createdAt: "t", updatedAt: "t" }),
    );

    await fetchProjectPathMapping("proj/test", "node/a+b");

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/projects/proj%2Ftest/path-mappings/node%2Fa%2Bb",
      expect.any(Object),
    );
  });

  it("upsertProjectPathMapping uses PUT", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(
      mockFetchResponse(true, { projectId: "proj", nodeId: "node", path: "/tmp", createdAt: "t", updatedAt: "t" }),
    );

    await upsertProjectPathMapping("proj", "node", "/tmp");

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/projects/proj/path-mappings/node",
      expect.objectContaining({ method: "PUT", body: JSON.stringify({ path: "/tmp" }) }),
    );
  });

  it("removeProjectPathMapping uses DELETE", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(
      Promise.resolve({
        ok: true,
        status: 204,
        statusText: "No Content",
        headers: { get: () => null },
        text: () => Promise.resolve(""),
      } as unknown as Response),
    );

    await removeProjectPathMapping("proj", "node");

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/projects/proj/path-mappings/node",
      expect.objectContaining({ method: "DELETE" }),
    );
  });
});

describe("fetchProjectHealth", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns health metrics for a project", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, FAKE_PROJECT_HEALTH));

    const result = await fetchProjectHealth("proj_abc123");

    expect(result.projectId).toBe("proj_abc123");
    expect(result.activeTaskCount).toBe(5);
    expect(result.inFlightAgentCount).toBe(2);
    expect(result.totalTasksCompleted).toBe(100);
  });
});

describe("fetchCodebaseMetrics", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("uses the project-scoped metrics URL and returns its response", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, { tokenEstimate: 42, sourceFileCount: 1, sourceByteCount: 20, diskBytes: 30, diskFileCount: 2, method: "local", truncated: false }));
    await expect(fetchCodebaseMetrics("project/a")).resolves.toMatchObject({ tokenEstimate: 42, diskFileCount: 2 });
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/projects/project%2Fa/codebase-metrics", expect.any(Object));
  });
});

describe("fetchActivityFeed", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns activity feed without options", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, [FAKE_ACTIVITY_ENTRY]));

    const result = await fetchActivityFeed();

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("task:created");
    expect(result[0].projectName).toBe("Test Project");
  });

  it("passes query parameters", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, []));

    await fetchActivityFeed({
      limit: 50,
      since: "2026-01-01T00:00:00.000Z",
      projectId: "proj_abc123",
      type: "task:created",
    });

    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toContain("limit=50");
    expect(call[0]).toContain("since=2026-01-01T00%3A00%3A00.000Z");
    expect(call[0]).toContain("projectId=proj_abc123");
    expect(call[0]).toContain("type=task%3Acreated");
  });
});

describe("pauseProject", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("pauses a project", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, { ...FAKE_PROJECT, status: "paused" }));

    const result = await pauseProject("proj_abc123");

    expect(result.status).toBe("paused");
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/projects/proj_abc123/pause",
      expect.objectContaining({ method: "POST" })
    );
  });
});

describe("resumeProject", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("resumes a paused project", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, { ...FAKE_PROJECT, status: "active" }));

    const result = await resumeProject("proj_abc123");

    expect(result.status).toBe("active");
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/projects/proj_abc123/resume",
      expect.objectContaining({ method: "POST" })
    );
  });
});

describe("fetchFirstRunStatus", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns first run status with existing projects", async () => {
    const mockStatus: FirstRunStatus = { hasProjects: true, singleProjectPath: "/existing/project" };
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, mockStatus));

    const result = await fetchFirstRunStatus();

    expect(result.hasProjects).toBe(true);
    expect(result.singleProjectPath).toBe("/existing/project");
  });

  it("returns first run status with no projects", async () => {
    const mockStatus: FirstRunStatus = { hasProjects: false, singleProjectPath: null };
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, mockStatus));

    const result = await fetchFirstRunStatus();

    expect(result.hasProjects).toBe(false);
    expect(result.singleProjectPath).toBeNull();
  });
});

describe("fetchGlobalConcurrency", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns global concurrency state", async () => {
    const mockState: GlobalConcurrencyState = {
      globalMaxConcurrent: 4,
      currentlyActive: 2,
      queuedCount: 1,
      projectsActive: { "proj_abc123": 2 },
    };
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, mockState));

    const result = await fetchGlobalConcurrency();

    expect(result.globalMaxConcurrent).toBe(4);
    expect(result.currentlyActive).toBe(2);
    expect(result.projectsActive["proj_abc123"]).toBe(2);
  });

  it("updates global concurrency state", async () => {
    const mockState: GlobalConcurrencyState = {
      globalMaxConcurrent: 10,
      currentlyActive: 4,
      queuedCount: 0,
      projectsActive: {},
    };
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, mockState));

    const result = await updateGlobalConcurrency({ globalMaxConcurrent: 10 });

    expect(result.globalMaxConcurrent).toBe(10);
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/global-concurrency", {
      headers: { "Content-Type": "application/json" },
      method: "PUT",
      body: JSON.stringify({ globalMaxConcurrent: 10 }),
    });
  });
});

describe("fetchProjectTasks", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("fetches tasks for a specific project", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, [{ id: "KB-001", description: "Test", column: "todo", dependencies: [], steps: [], currentStep: 0, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }]));

    const result = await fetchProjectTasks("proj_abc123");

    expect(result).toHaveLength(1);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/tasks?"),
      expect.any(Object)
    );
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toContain("projectId=proj_abc123");
  });

  it("passes pagination parameters", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, []));

    await fetchProjectTasks("proj_abc123", 50, 100);

    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toContain("limit=50");
    expect(call[0]).toContain("offset=100");
  });
});

describe("fetchProjectConfig", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns project config", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, { maxConcurrent: 4, rootDir: "/path/to/project" }));

    const result = await fetchProjectConfig("proj_abc123");

    expect(result.maxConcurrent).toBe(4);
    expect(result.rootDir).toBe("/path/to/project");
  });
});

describe("fetchExecutorStats", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns executor stats with running state", async () => {
    const response = {
      globalPause: false,
      enginePaused: false,
      maxConcurrent: 4,
      lastActivityAt: "2026-04-01T12:00:00.000Z",
    };
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, response));

    const result = await fetchExecutorStats();

    expect(result.globalPause).toBe(false);
    expect(result.enginePaused).toBe(false);
    expect(result.maxConcurrent).toBe(4);
    expect(result.lastActivityAt).toBe("2026-04-01T12:00:00.000Z");
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/executor/stats", {
      headers: { "Content-Type": "application/json" },
    });
  });

  it("returns executor stats with paused state", async () => {
    const response = {
      globalPause: false,
      enginePaused: true,
      maxConcurrent: 2,
      lastActivityAt: "2026-04-01T11:00:00.000Z",
    };
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, response));

    const result = await fetchExecutorStats();

    expect(result.globalPause).toBe(false);
    expect(result.enginePaused).toBe(true);
    expect(result.maxConcurrent).toBe(2);
  });

  it("returns executor stats with global pause", async () => {
    const response = {
      globalPause: true,
      enginePaused: false,
      maxConcurrent: 2,
    };
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, response));

    const result = await fetchExecutorStats();

    expect(result.globalPause).toBe(true);
    expect(result.enginePaused).toBe(false);
  });

  it("throws on API error", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(false, { error: "Internal server error" }));

    await expect(fetchExecutorStats()).rejects.toThrow("Internal server error");
  });
});

describe("ExecutorStats type", () => {
  it("has correct shape for executor stats object", () => {
    const stats: ExecutorStats = {
      runningTaskCount: 3,
      blockedTaskCount: 2,
      stuckTaskCount: 1,
      queuedTaskCount: 10,
      inReviewCount: 4,
      executorState: "running",
      maxConcurrent: 4,
      lastActivityAt: "2026-04-01T12:00:00.000Z",
    };

    expect(stats.runningTaskCount).toBe(3);
    expect(stats.blockedTaskCount).toBe(2);
    expect(stats.stuckTaskCount).toBe(1);
    expect(stats.queuedTaskCount).toBe(10);
    expect(stats.inReviewCount).toBe(4);
    expect(stats.executorState).toBe("running");
    expect(stats.maxConcurrent).toBe(4);
    expect(stats.lastActivityAt).toBe("2026-04-01T12:00:00.000Z");
  });

  it("accepts all valid executor states", () => {
    const idleStats: ExecutorStats = {
      runningTaskCount: 0,
      blockedTaskCount: 0,
      stuckTaskCount: 0,
      queuedTaskCount: 5,
      inReviewCount: 0,
      executorState: "idle",
      maxConcurrent: 2,
    };

    const runningStats: ExecutorStats = {
      runningTaskCount: 2,
      blockedTaskCount: 1,
      stuckTaskCount: 0,
      queuedTaskCount: 3,
      inReviewCount: 1,
      executorState: "running",
      maxConcurrent: 2,
    };

    const pausedStats: ExecutorStats = {
      runningTaskCount: 1,
      blockedTaskCount: 0,
      stuckTaskCount: 0,
      queuedTaskCount: 8,
      inReviewCount: 2,
      executorState: "paused",
      maxConcurrent: 2,
    };

    expect(idleStats.executorState).toBe("idle");
    expect(runningStats.executorState).toBe("running");
    expect(pausedStats.executorState).toBe("paused");
  });

  it("allows optional lastActivityAt", () => {
    const stats: ExecutorStats = {
      runningTaskCount: 0,
      blockedTaskCount: 0,
      stuckTaskCount: 0,
      queuedTaskCount: 0,
      inReviewCount: 0,
      executorState: "idle",
      maxConcurrent: 2,
    };

    expect(stats.lastActivityAt).toBeUndefined();
  });
});

describe("ExecutorState type", () => {
  it("has valid executor state values", () => {
    const states: ExecutorState[] = ["idle", "running", "paused", "stopped"];

    expect(states).toContain("idle");
    expect(states).toContain("running");
    expect(states).toContain("paused");
    expect(states).toContain("stopped");
  });
});

// ── Regression: Mission mutation 204 response handling ─────────────────────
//
// Mission DELETE and reorder endpoints return 204 No Content. The api()
// function must handle these responses correctly instead of throwing
// a misleading content-type error.
