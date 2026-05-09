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
  fetchPluginDashboardViews,
  fetchPluginUiSlots,
  fetchTaskReviewData,
  refreshTaskReviewData,
  type ProjectInfo,
  type ProjectHealth,
  type ActivityFeedEntry,
  type FirstRunStatus,
  type GlobalConcurrencyState,
  type ExecutorStats,
  type ExecutorState,
  triggerInsightRun,
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

describe("fetchTaskDetail", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  it("returns data on first success", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, FAKE_DETAIL));

    const result = await fetchTaskDetail("FN-001");

    expect(result.id).toBe("FN-001");
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/tasks/FN-001", {
      headers: { "Content-Type": "application/json" },
    });
  });

  it("preserves full tokenUsage payload from task detail responses", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, FAKE_DETAIL));

    const result = await fetchTaskDetail("FN-001");

    expect(result.tokenUsage).toEqual({
      inputTokens: 1000,
      outputTokens: 300,
      cachedTokens: 125,
      totalTokens: 1425,
      firstUsedAt: "2026-04-24T08:00:00.000Z",
      lastUsedAt: "2026-04-24T09:30:00.000Z",
    });
  });

  it("keeps tokenUsage undefined when server response omits task usage", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, {
      ...FAKE_DETAIL,
      tokenUsage: undefined,
    }));

    const result = await fetchTaskDetail("FN-001");

    expect(result.tokenUsage).toBeUndefined();
  });

  it("adds Authorization header when daemon token is present", async () => {
    localStorage.setItem("fn.authToken", "daemon-token");
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, FAKE_DETAIL));

    await fetchTaskDetail("FN-001");

    const call = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(call[0]).toBe("/api/tasks/FN-001");
    expect(new Headers((call[1] as RequestInit).headers).get("Authorization")).toBe("Bearer daemon-token");
    expect(new Headers((call[1] as RequestInit).headers).get("Content-Type")).toBe("application/json");
  });

  it("retries once on failure then succeeds", async () => {
    globalThis.fetch = vi.fn()
      .mockReturnValueOnce(mockFetchResponse(false, { error: "Transient error" }))
      .mockReturnValueOnce(mockFetchResponse(true, FAKE_DETAIL));

    const result = await fetchTaskDetail("FN-001");

    expect(result.id).toBe("FN-001");
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it("throws after retry exhaustion", async () => {
    globalThis.fetch = vi.fn()
      .mockReturnValue(mockFetchResponse(false, { error: "Server error" }));

    await expect(fetchTaskDetail("FN-001")).rejects.toThrow("Server error");
    expect(globalThis.fetch).toHaveBeenCalledTimes(2); // initial + 1 retry
  });
});

describe("uploadAttachment", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("does not send Authorization header when no daemon token is present", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, {
      filename: "shot.png",
      originalName: "shot.png",
      mimeType: "image/png",
      size: 42,
      createdAt: "2026-01-01T00:00:00.000Z",
    }));

    const file = new File(["img"], "shot.png", { type: "image/png" });
    await uploadAttachment("FN-001", file);

    const call = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(call[0]).toBe("/api/tasks/FN-001/attachments");
    expect((call[1] as RequestInit).method).toBe("POST");
    expect((call[1] as RequestInit).headers).toBeUndefined();
  });

  it("sends Authorization header when daemon token is present", async () => {
    localStorage.setItem("fn.authToken", "daemon-token");
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, {
      filename: "shot.png",
      originalName: "shot.png",
      mimeType: "image/png",
      size: 42,
      createdAt: "2026-01-01T00:00:00.000Z",
    }));

    const file = new File(["img"], "shot.png", { type: "image/png" });
    await uploadAttachment("FN-001", file);

    const call = vi.mocked(globalThis.fetch).mock.calls[0];
    const headers = new Headers((call[1] as RequestInit).headers);
    expect(headers.get("Authorization")).toBe("Bearer daemon-token");
  });
});

describe("fetchAgentLogsWithMeta", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("keeps headers empty when token is absent", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: {
        has: vi.fn((name: string) => name === "X-Total-Count"),
        get: vi.fn((name: string) => (name === "X-Total-Count" ? "1" : null)),
      },
      json: vi.fn().mockResolvedValue([{ timestamp: "t", taskId: "FN-001", text: "x", type: "text" }]),
    } as unknown as Response);

    await fetchAgentLogsWithMeta("FN-001");

    const call = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(call[0]).toBe("/api/tasks/FN-001/logs");
    expect((call[1] as RequestInit).headers).toBeUndefined();
  });

  it("injects Authorization header when token exists", async () => {
    localStorage.setItem("fn.authToken", "daemon-token");
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: {
        has: vi.fn(() => false),
        get: vi.fn(() => null),
      },
      json: vi.fn().mockResolvedValue([]),
    } as unknown as Response);

    await fetchAgentLogsWithMeta("FN-001", undefined, { limit: 10, offset: 5 });

    const call = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(call[0]).toBe("/api/tasks/FN-001/logs?limit=10&offset=5");
    const headers = new Headers((call[1] as RequestInit).headers);
    expect(headers.get("Authorization")).toBe("Bearer daemon-token");
  });
});

describe("AI session raw fetch auth headers", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("fetchAiSessions omits Authorization header when no token is stored", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, { sessions: [{ id: "s1" }] }));

    await fetchAiSessions();

    const call = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(call[0]).toBe("/api/ai-sessions");
    expect((call[1] as RequestInit).headers).toBeUndefined();
  });

  it("fetchAiSessions includes Authorization header when token is stored", async () => {
    localStorage.setItem("fn.authToken", "daemon-token");
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, { sessions: [{ id: "s1" }] }));

    await fetchAiSessions("proj-1");

    const call = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(call[0]).toBe("/api/ai-sessions?projectId=proj-1");
    const headers = new Headers((call[1] as RequestInit).headers);
    expect(headers.get("Authorization")).toBe("Bearer daemon-token");
  });

  it("fetchAiSession and deleteAiSession both include Authorization header with token", async () => {
    localStorage.setItem("fn.authToken", "daemon-token");
    globalThis.fetch = vi.fn()
      .mockReturnValueOnce(mockFetchResponse(true, { id: "s1" }))
      .mockReturnValueOnce(mockFetchResponse(true, {}));

    await fetchAiSession("s1");
    await deleteAiSession("s1");

    const fetchSessionCall = vi.mocked(globalThis.fetch).mock.calls[0];
    const deleteCall = vi.mocked(globalThis.fetch).mock.calls[1];

    expect(new Headers((fetchSessionCall[1] as RequestInit).headers).get("Authorization")).toBe("Bearer daemon-token");
    expect((deleteCall[1] as RequestInit).method).toBe("DELETE");
    expect(new Headers((deleteCall[1] as RequestInit).headers).get("Authorization")).toBe("Bearer daemon-token");
  });
});

describe("updateTask", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const FAKE_TASK: Task = {
    id: "FN-001",
    description: "Test",
    column: "in-progress",
    dependencies: ["FN-002"],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  it("sends PATCH with dependencies and returns updated task", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, FAKE_TASK));

    const result = await updateTask("FN-001", { dependencies: ["FN-002"] });

    expect(result.dependencies).toEqual(["FN-002"]);
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/tasks/FN-001", {
      headers: { "Content-Type": "application/json" },
      method: "PATCH",
      body: JSON.stringify({ dependencies: ["FN-002"] }),
    });
  });

  it("throws on error response", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(false, { error: "Not found" }));

    await expect(updateTask("FN-001", { dependencies: [] })).rejects.toThrow("Not found");
  });

  it("sends PATCH with executionMode 'fast' when provided", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, { ...FAKE_TASK, executionMode: "fast" }));

    const result = await updateTask("FN-001", { executionMode: "fast" });

    expect(result.executionMode).toBe("fast");
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/tasks/FN-001", {
      headers: { "Content-Type": "application/json" },
      method: "PATCH",
      body: JSON.stringify({ executionMode: "fast" }),
    });
  });

  it("sends PATCH with executionMode 'standard' when provided", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, { ...FAKE_TASK, executionMode: "standard" }));

    const result = await updateTask("FN-001", { executionMode: "standard" });

    expect(result.executionMode).toBe("standard");
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/tasks/FN-001", {
      headers: { "Content-Type": "application/json" },
      method: "PATCH",
      body: JSON.stringify({ executionMode: "standard" }),
    });
  });

  it("sends PATCH with null to clear executionMode", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, { ...FAKE_TASK, executionMode: undefined }));

    const result = await updateTask("FN-001", { executionMode: null });

    expect(result.executionMode).toBeUndefined();
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/tasks/FN-001", {
      headers: { "Content-Type": "application/json" },
      method: "PATCH",
      body: JSON.stringify({ executionMode: null }),
    });
  });

  it("omits executionMode key when not provided in update", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, { ...FAKE_TASK, title: "Updated" }));

    await updateTask("FN-001", { title: "Updated" });

    const call = vi.mocked(globalThis.fetch).mock.calls[0];
    const body = JSON.parse((call[1] as RequestInit).body as string);
    expect(body).not.toHaveProperty("executionMode");
  });

  it("sends branch and baseBranch (including null clears) in update payload", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, {
      ...FAKE_TASK,
      branch: undefined,
      baseBranch: undefined,
    }));

    await updateTask("FN-001", { branch: null, baseBranch: "main" });

    expect(globalThis.fetch).toHaveBeenCalledWith("/api/tasks/FN-001", {
      headers: { "Content-Type": "application/json" },
      method: "PATCH",
      body: JSON.stringify({ branch: null, baseBranch: "main" }),
    });
  });

  it("omits branch and baseBranch from update payload when unset", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, { ...FAKE_TASK, title: "Updated" }));

    await updateTask("FN-001", { title: "Updated" });

    const call = vi.mocked(globalThis.fetch).mock.calls[0];
    const body = JSON.parse((call[1] as RequestInit).body as string);
    expect(body).not.toHaveProperty("branch");
    expect(body).not.toHaveProperty("baseBranch");
  });

  it("sends sourceIssue object when source metadata is provided", async () => {
    const sourceIssue = {
      provider: "github",
      repository: "runfusion/fusion",
      externalIssueId: "I_kgDOExample",
      issueNumber: 2473,
      url: "https://github.com/runfusion/fusion/issues/2473",
    };
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, { ...FAKE_TASK, sourceIssue }));

    const result = await updateTask("FN-001", { sourceIssue });

    expect(result.sourceIssue).toEqual(sourceIssue);
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/tasks/FN-001", {
      headers: { "Content-Type": "application/json" },
      method: "PATCH",
      body: JSON.stringify({ sourceIssue }),
    });
  });

  it("sends sourceIssue: null when clearing source metadata", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, { ...FAKE_TASK, sourceIssue: undefined }));

    await updateTask("FN-001", { sourceIssue: null });

    expect(globalThis.fetch).toHaveBeenCalledWith("/api/tasks/FN-001", {
      headers: { "Content-Type": "application/json" },
      method: "PATCH",
      body: JSON.stringify({ sourceIssue: null }),
    });
  });
});

describe("createTask", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const FAKE_CREATED_TASK: Task = {
    id: "FN-001",
    description: "Test task",
    column: "triage",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  it("sends POST with executionMode 'fast' when provided", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, { ...FAKE_CREATED_TASK, executionMode: "fast" }));

    const result = await createTask({ description: "Fast task", executionMode: "fast" });

    expect(result.executionMode).toBe("fast");
    const call = vi.mocked(globalThis.fetch).mock.calls[0];
    const body = JSON.parse((call[1] as RequestInit).body as string);
    expect(body.executionMode).toBe("fast");
    expect(body.description).toBe("Fast task");
  });

  it("sends POST with executionMode 'standard' when provided", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, { ...FAKE_CREATED_TASK, executionMode: "standard" }));

    const result = await createTask({ description: "Standard task", executionMode: "standard" });

    expect(result.executionMode).toBe("standard");
    const call = vi.mocked(globalThis.fetch).mock.calls[0];
    const body = JSON.parse((call[1] as RequestInit).body as string);
    expect(body.executionMode).toBe("standard");
    expect(body.description).toBe("Standard task");
  });

  it("omits executionMode key when not provided", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, FAKE_CREATED_TASK));

    await createTask({ description: "Task without execution mode" });

    const call = vi.mocked(globalThis.fetch).mock.calls[0];
    const body = JSON.parse((call[1] as RequestInit).body as string);
    expect(body).not.toHaveProperty("executionMode");
  });

  it("passes source provenance through createTask payload", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, FAKE_CREATED_TASK));

    await createTask({
      description: "Sourced task",
      source: { sourceType: "dashboard_ui" },
    });

    const call = vi.mocked(globalThis.fetch).mock.calls[0];
    const body = JSON.parse((call[1] as RequestInit).body as string);
    expect(body.source).toEqual({ sourceType: "dashboard_ui" });
  });

  it("serializes priority in createTask payload when provided", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, { ...FAKE_CREATED_TASK, priority: "urgent" }));

    await createTask({
      description: "Priority task",
      priority: "urgent",
    });

    const call = vi.mocked(globalThis.fetch).mock.calls[0];
    const body = JSON.parse((call[1] as RequestInit).body as string);
    expect(body.priority).toBe("urgent");
  });

  it("serializes branch and baseBranch in create payload", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, {
      ...FAKE_CREATED_TASK,
      branch: "fusion/fn-branch",
      baseBranch: "main",
    }));

    await createTask({
      description: "Task with branches",
      branch: "fusion/fn-branch",
      baseBranch: "main",
    });

    const call = vi.mocked(globalThis.fetch).mock.calls[0];
    const body = JSON.parse((call[1] as RequestInit).body as string);
    expect(body.branch).toBe("fusion/fn-branch");
    expect(body.baseBranch).toBe("main");
  });

  it("omits branch and baseBranch in create payload when unset", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, FAKE_CREATED_TASK));

    await createTask({ description: "Task without branch fields" });

    const call = vi.mocked(globalThis.fetch).mock.calls[0];
    const body = JSON.parse((call[1] as RequestInit).body as string);
    expect(body).not.toHaveProperty("branch");
    expect(body).not.toHaveProperty("baseBranch");
  });

  it("serializes nodeId in create payload when execution target is specified", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, {
      ...FAKE_CREATED_TASK,
      nodeId: "node-exec-1",
    }));

    await createTask({
      description: "Task with remote execution target",
      nodeId: "node-exec-1",
    });

    const call = vi.mocked(globalThis.fetch).mock.calls[0];
    const body = JSON.parse((call[1] as RequestInit).body as string);
    expect(body.nodeId).toBe("node-exec-1");
  });

  it("routes createTask through node proxy when transportNodeId differs from local node", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, FAKE_CREATED_TASK));

    await createTask(
      { description: "Proxy-routed task", nodeId: "node-exec-2" },
      "proj-1",
      { transportNodeId: "node-remote", localNodeId: "node-local" },
    );

    const call = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(call[0]).toBe("/api/proxy/node-remote/tasks?projectId=proj-1");
    const body = JSON.parse((call[1] as RequestInit).body as string);
    expect(body.nodeId).toBe("node-exec-2");
  });

  it("sends POST with multiple fields including executionMode", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, {
      ...FAKE_CREATED_TASK,
      executionMode: "fast",
      title: "Test Title",
      dependencies: ["FN-002"],
    }));

    const result = await createTask({
      description: "Full task",
      title: "Test Title",
      dependencies: ["FN-002"],
      executionMode: "fast",
    });

    expect(result.executionMode).toBe("fast");
    const call = vi.mocked(globalThis.fetch).mock.calls[0];
    const body = JSON.parse((call[1] as RequestInit).body as string);
    expect(body.description).toBe("Full task");
    expect(body.title).toBe("Test Title");
    expect(body.dependencies).toEqual(["FN-002"]);
    expect(body.executionMode).toBe("fast");
  });
});

describe("assignTask and fetchAgentTasks", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const ASSIGNED_TASK: Task = {
    id: "FN-001",
    description: "Test",
    column: "todo",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    assignedAgentId: "agent-001",
  };

  it("assignTask sends PATCH with agentId payload", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, ASSIGNED_TASK));

    const result = await assignTask("FN-001", "agent-001");

    expect(result.assignedAgentId).toBe("agent-001");
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/tasks/FN-001/assign", {
      headers: { "Content-Type": "application/json" },
      method: "PATCH",
      body: JSON.stringify({ agentId: "agent-001" }),
    });
  });

  it("fetchAgentTasks requests assigned tasks for an agent", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, [ASSIGNED_TASK]));

    const result = await fetchAgentTasks("agent-001");

    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("FN-001");
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/agents/agent-001/tasks", {
      headers: { "Content-Type": "application/json" },
    });
  });
});

describe("task comments api", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const FAKE_TASK: Task = {
    id: "FN-001",
    description: "Test",
    column: "todo",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    comments: [{ id: "c1", text: "Hello", author: "user", createdAt: "2026-01-01T00:00:00.000Z" }],
  };

  it("fetches task comments", async () => {
    const comments = FAKE_TASK.comments!;
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, comments));

    const result = await fetchTaskComments("FN-001");

    expect(result).toEqual(comments);
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/tasks/FN-001/comments", {
      headers: { "Content-Type": "application/json" },
    });
  });

  it("adds a task comment", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, FAKE_TASK));

    const result = await addTaskComment("FN-001", "Hello", "user");

    expect(result).toEqual(FAKE_TASK);
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/tasks/FN-001/comments", {
      headers: { "Content-Type": "application/json" },
      method: "POST",
      body: JSON.stringify({ text: "Hello", author: "user" }),
    });
  });

  it("updates a task comment", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, FAKE_TASK));

    await updateTaskComment("FN-001", "c1", "Updated");

    expect(globalThis.fetch).toHaveBeenCalledWith("/api/tasks/FN-001/comments/c1", {
      headers: { "Content-Type": "application/json" },
      method: "PATCH",
      body: JSON.stringify({ text: "Updated" }),
    });
  });

  it("deletes a task comment", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, FAKE_TASK));

    await deleteTaskComment("FN-001", "c1");

    expect(globalThis.fetch).toHaveBeenCalledWith("/api/tasks/FN-001/comments/c1", {
      headers: { "Content-Type": "application/json" },
      method: "DELETE",
    });
  });
});

describe("plugin dashboard view API wrappers", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("fetchPluginDashboardViews calls /api/plugins/dashboard-views", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, [
      {
        pluginId: "roadmap-planner",
        view: { viewId: "roadmaps", label: "Roadmaps", componentPath: "./dashboard-view" },
      },
    ]));

    const result = await fetchPluginDashboardViews("project-a");

    expect(result).toHaveLength(1);
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/plugins/dashboard-views?projectId=project-a", {
      headers: { "Content-Type": "application/json" },
    });
  });

  it("fetchPluginUiSlots calls /api/plugins/ui-slots and keeps slot shape", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, [
      {
        pluginId: "roadmap-planner",
        slot: {
          slotId: "task-detail-tab",
          label: "Roadmap Details",
          componentPath: "./task-detail.js",
        },
      },
    ]));

    const result = await fetchPluginUiSlots("project-a");

    expect(result).toHaveLength(1);
    expect(result[0]).toHaveProperty("slot");
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/plugins/ui-slots?projectId=project-a", {
      headers: { "Content-Type": "application/json" },
    });
  });
});

describe("fetchModels", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns available models with favorites", async () => {
    const response = {
      models: [
        { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", reasoning: true, contextWindow: 200000 },
      ],
      favoriteProviders: ["anthropic"],
      favoriteModels: ["anthropic/claude-sonnet-4-5"],
    };
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, response));

    const result = await fetchModels();

    expect(result).toEqual(response);
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/models", {
      headers: { "Content-Type": "application/json" },
    });
  });

  it("throws on error", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(false, { error: "Server error" }));

    await expect(fetchModels()).rejects.toThrow("Server error");
  });
});

describe("fetchBatchStatus", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("posts task ids and unwraps the results envelope", async () => {
    const response: BatchStatusResponse = {
      results: {
        "FN-001": {
          issueInfo: {
            url: "https://github.com/owner/repo/issues/101",
            number: 101,
            state: "closed",
            title: "Issue 101",
            stateReason: "completed",
            lastCheckedAt: "2026-03-30T12:00:00.000Z",
          },
          stale: false,
        },
      },
    };
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, response));

    const result = await fetchBatchStatus(["FN-001"]);

    expect(result).toEqual(response.results);
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/github/batch/status", {
      headers: { "Content-Type": "application/json" },
      method: "POST",
      body: JSON.stringify({ taskIds: ["FN-001"] }),
    });
  });

  it("propagates API errors", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(false, { error: "rate limit exceeded" }, 429));

    await expect(fetchBatchStatus(["FN-001"])).rejects.toThrow("rate limit exceeded");
  });
});

describe("batchUpdateTaskModels", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("calls API with correct parameters for executor model update", async () => {
    const mockResponse = {
      updated: [{ id: "FN-001", modelProvider: "openai", modelId: "gpt-4o" }],
      count: 1,
    };
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockFetchResponse(true, mockResponse)
    );

    const { batchUpdateTaskModels } = await import("../api");
    const result = await batchUpdateTaskModels(["FN-001"], "openai", "gpt-4o");

    expect(result.count).toBe(1);
    expect(result.updated).toHaveLength(1);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/tasks/batch-update-models",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          taskIds: ["FN-001"],
          modelProvider: "openai",
          modelId: "gpt-4o",
        }),
      })
    );
  });

  it("calls API with correct parameters for validator model update", async () => {
    const mockResponse = { updated: [], count: 0 };
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockFetchResponse(true, mockResponse)
    );

    const { batchUpdateTaskModels } = await import("../api");
    await batchUpdateTaskModels(
      ["FN-001", "FN-002"],
      undefined,
      undefined,
      "anthropic",
      "claude-sonnet-4-5"
    );

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/tasks/batch-update-models",
      expect.objectContaining({
        body: JSON.stringify({
          taskIds: ["FN-001", "FN-002"],
          validatorModelProvider: "anthropic",
          validatorModelId: "claude-sonnet-4-5",
        }),
      })
    );
  });

  it("calls API with null values to clear models", async () => {
    const mockResponse = { updated: [{ id: "FN-001" }], count: 1 };
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockFetchResponse(true, mockResponse)
    );

    const { batchUpdateTaskModels } = await import("../api");
    await batchUpdateTaskModels(["FN-001"], null, null);

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/tasks/batch-update-models",
      expect.objectContaining({
        body: JSON.stringify({
          taskIds: ["FN-001"],
          modelProvider: null,
          modelId: null,
        }),
      })
    );
  });

  it("includes nodeId when provided", async () => {
    const mockResponse = { updated: [{ id: "FN-001", nodeId: "node-abc" }], count: 1 };
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockFetchResponse(true, mockResponse)
    );

    const { batchUpdateTaskModels } = await import("../api");
    await batchUpdateTaskModels(
      ["FN-001"],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "node-abc",
      "proj-123"
    );

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/tasks/batch-update-models?projectId=proj-123",
      expect.objectContaining({
        body: JSON.stringify({
          taskIds: ["FN-001"],
          nodeId: "node-abc",
        }),
      })
    );
  });

  it("includes null nodeId when clearing override", async () => {
    const mockResponse = { updated: [{ id: "FN-001" }], count: 1 };
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockFetchResponse(true, mockResponse)
    );

    const { batchUpdateTaskModels } = await import("../api");
    await batchUpdateTaskModels(["FN-001"], undefined, undefined, undefined, undefined, undefined, undefined, null);

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/tasks/batch-update-models",
      expect.objectContaining({
        body: JSON.stringify({
          taskIds: ["FN-001"],
          nodeId: null,
        }),
      })
    );
  });

  it("throws on 400 validation error", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockFetchResponse(false, { error: "taskIds must be an array" }, 400)
    );

    const { batchUpdateTaskModels } = await import("../api");
    await expect(batchUpdateTaskModels([], "openai", "gpt-4o")).rejects.toThrow(
      "taskIds must be an array"
    );
  });

  it("throws on 404 when task not found", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockFetchResponse(false, { error: "Task KB-999 not found" }, 404)
    );

    const { batchUpdateTaskModels } = await import("../api");
    await expect(batchUpdateTaskModels(["KB-999"], "openai", "gpt-4o")).rejects.toThrow(
      "Task KB-999 not found"
    );
  });

  it("throws on network error", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Network failed"));

    const { batchUpdateTaskModels } = await import("../api");
    await expect(batchUpdateTaskModels(["FN-001"], "openai", "gpt-4o")).rejects.toThrow(
      "Network failed"
    );
  });
});

describe("triggerInsightRun", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    clearAuthToken();
    localStorage.removeItem("fn.authToken");
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    clearAuthToken();
    localStorage.removeItem("fn.authToken");
  });

  it("sends POST to /api/insights/run without model params by default", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, { id: "INSR-test", status: "completed" }));

    await triggerInsightRun("manual");

    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(call[1].body);
    expect(body).not.toHaveProperty("modelProvider");
    expect(body).not.toHaveProperty("modelId");
    expect(body.trigger).toBe("manual");
  });

  it("includes modelProvider and modelId in POST body when provided", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, { id: "INSR-test", status: "completed" }));

    await triggerInsightRun("manual", undefined, undefined, "openai", "gpt-4o");

    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(call[1].body);
    expect(body.modelProvider).toBe("openai");
    expect(body.modelId).toBe("gpt-4o");
  });

  it("omits model params when provider is empty string", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, { id: "INSR-test", status: "completed" }));

    await triggerInsightRun("manual", undefined, undefined, "", "");

    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(call[1].body);
    expect(body).not.toHaveProperty("modelProvider");
    expect(body).not.toHaveProperty("modelId");
  });
});


describe("task review data api wrappers", () => {
  it("fetchTaskReviewData calls task review endpoint", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockFetchResponse(true, { mode: "reviewer-agent", refreshable: true, fetchedAt: null, summary: null, items: [] })
    ) as unknown as typeof fetch;
    await fetchTaskReviewData("FN-123", "proj-1");
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/tasks/FN-123/review?projectId=proj-1",
      expect.any(Object)
    );
  });

  it("refreshTaskReviewData posts to refresh endpoint", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockFetchResponse(true, { mode: "pull-request", refreshable: true, fetchedAt: "2026-05-01T00:00:00.000Z", summary: null, items: [] })
    ) as unknown as typeof fetch;
    await refreshTaskReviewData("FN-123");
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/tasks/FN-123/review/refresh",
      expect.objectContaining({ method: "POST" })
    );
  });
});
