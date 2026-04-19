import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  fetchTaskDetail,
  updateTask,
  connectPlanningStream,
  connectSubtaskStream,
  connectMissionInterviewStream,
  assignTask,
  fetchAgentTasks,
  archiveTask,
  unarchiveTask,
  deleteTask,
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
} from "./api";
import type { Task, TaskDetail, BatchStatusResponse, MergeResult } from "@fusion/core";

const FAKE_DETAIL: TaskDetail = {
  id: "FN-001",
  description: "Test",
  column: "in-progress",
  dependencies: [],
  steps: [],
  currentStep: 0,
  log: [],
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

    const { batchUpdateTaskModels } = await import("./api");
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

    const { batchUpdateTaskModels } = await import("./api");
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

    const { batchUpdateTaskModels } = await import("./api");
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

  it("throws on 400 validation error", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockFetchResponse(false, { error: "taskIds must be an array" }, 400)
    );

    const { batchUpdateTaskModels } = await import("./api");
    await expect(batchUpdateTaskModels([], "openai", "gpt-4o")).rejects.toThrow(
      "taskIds must be an array"
    );
  });

  it("throws on 404 when task not found", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockFetchResponse(false, { error: "Task KB-999 not found" }, 404)
    );

    const { batchUpdateTaskModels } = await import("./api");
    await expect(batchUpdateTaskModels(["KB-999"], "openai", "gpt-4o")).rejects.toThrow(
      "Task KB-999 not found"
    );
  });

  it("throws on network error", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Network failed"));

    const { batchUpdateTaskModels } = await import("./api");
    await expect(batchUpdateTaskModels(["FN-001"], "openai", "gpt-4o")).rejects.toThrow(
      "Network failed"
    );
  });
});

describe("fetchAuthStatus", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns providers with auth status", async () => {
    const response = { providers: [{ id: "anthropic", name: "Anthropic", authenticated: true }] };
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, response));

    const result = await fetchAuthStatus();

    expect(result.providers).toEqual([{ id: "anthropic", name: "Anthropic", authenticated: true }]);
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/auth/status", {
      headers: { "Content-Type": "application/json" },
    });
  });

  it("throws on error", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(false, { error: "Server error" }));

    await expect(fetchAuthStatus()).rejects.toThrow("Server error");
  });
});

describe("loginProvider", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("sends POST and returns auth URL", async () => {
    const response = { url: "https://auth.example.com/login", instructions: "Open in browser" };
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, response));

    const result = await loginProvider("anthropic");

    expect(result.url).toBe("https://auth.example.com/login");
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/auth/login", {
      headers: { "Content-Type": "application/json" },
      method: "POST",
      body: JSON.stringify({ provider: "anthropic" }),
    });
  });

  it("throws on error", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(false, { error: "Unknown provider" }));

    await expect(loginProvider("bad")).rejects.toThrow("Unknown provider");
  });
});

describe("logoutProvider", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("sends POST to logout", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, { success: true }));

    const result = await logoutProvider("anthropic");

    expect(result.success).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/auth/logout", {
      headers: { "Content-Type": "application/json" },
      method: "POST",
      body: JSON.stringify({ provider: "anthropic" }),
    });
  });

  it("throws on error", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(false, { error: "logout failed" }));

    await expect(logoutProvider("anthropic")).rejects.toThrow("logout failed");
  });
});

describe("addSteeringComment", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const FAKE_TASK: Task = {
    id: "FN-001",
    description: "Test",
    column: "in-progress",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    steeringComments: [
      {
        id: "1234567890-abc123",
        text: "Please handle the edge case",
        createdAt: "2026-01-01T00:00:00.000Z",
        author: "user",
      },
    ],
  };

  it("sends POST with text and returns updated task", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, FAKE_TASK));

    const result = await addSteeringComment("FN-001", "Please handle the edge case");

    expect(result.id).toBe("FN-001");
    expect(result.steeringComments).toHaveLength(1);
    expect(result.steeringComments![0].text).toBe("Please handle the edge case");
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/tasks/FN-001/steer", {
      headers: { "Content-Type": "application/json" },
      method: "POST",
      body: JSON.stringify({ text: "Please handle the edge case" }),
    });
  });

  it("throws on error response", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(
      mockFetchResponse(false, { error: "Task not found" })
    );

    await expect(addSteeringComment("FN-001", "Test comment")).rejects.toThrow("Task not found");
  });
});

describe("fetchGitRemotes", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns array of GitHub remotes", async () => {
    const remotes = [
      { name: "origin", owner: "dustinbyrne", repo: "kb", url: "https://github.com/dustinbyrne/kb.git" },
    ];
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, remotes));

    const result = await fetchGitRemotes();

    expect(result).toEqual(remotes);
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/git/remotes", {
      headers: { "Content-Type": "application/json" },
    });
  });

  it("returns empty array when no remotes", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, []));

    const result = await fetchGitRemotes();

    expect(result).toEqual([]);
  });

  it("throws on error", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(false, { error: "Failed to execute git command" }));

    await expect(fetchGitRemotes()).rejects.toThrow("Failed to execute git command");
  });
});

import {
  fetchGitRemotesDetailed,
  addGitRemote,
  removeGitRemote,
  renameGitRemote,
  updateGitRemoteUrl,
} from "./api";

describe("fetchGitRemotesDetailed", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns array of remotes with fetch and push URLs", async () => {
    const remotes = [
      { name: "origin", fetchUrl: "https://github.com/dustinbyrne/kb.git", pushUrl: "https://github.com/dustinbyrne/kb.git" },
      { name: "upstream", fetchUrl: "https://github.com/upstream/kb.git", pushUrl: "git@github.com:upstream/kb.git" },
    ];
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, remotes));

    const result = await fetchGitRemotesDetailed();

    expect(result).toEqual(remotes);
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/git/remotes/detailed", {
      headers: { "Content-Type": "application/json" },
    });
  });

  it("returns empty array when no remotes", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, []));

    const result = await fetchGitRemotesDetailed();

    expect(result).toEqual([]);
  });

  it("throws on error", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(false, { error: "Not a git repository" }, 400));

    await expect(fetchGitRemotesDetailed()).rejects.toThrow("Not a git repository");
  });
});

describe("addGitRemote", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("adds a new remote successfully", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, { name: "origin", added: true }, 201));

    await addGitRemote("origin", "https://github.com/dustinbyrne/kb.git");

    expect(globalThis.fetch).toHaveBeenCalledWith("/api/git/remotes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "origin", url: "https://github.com/dustinbyrne/kb.git" }),
    });
  });

  it("throws on invalid name", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(false, { error: "Invalid remote name" }, 400));

    await expect(addGitRemote("invalid;cmd", "https://github.com/test/repo.git")).rejects.toThrow("Invalid remote name");
  });

  it("throws on invalid URL", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(false, { error: "Invalid git URL format" }, 400));

    await expect(addGitRemote("origin", "not-a-valid-url")).rejects.toThrow("Invalid git URL format");
  });

  it("throws on duplicate remote", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(false, { error: "Remote 'origin' already exists" }, 409));

    await expect(addGitRemote("origin", "https://github.com/test/repo.git")).rejects.toThrow("Remote 'origin' already exists");
  });
});

describe("removeGitRemote", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("removes a remote successfully", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, { name: "origin", removed: true }));

    await removeGitRemote("origin");

    expect(globalThis.fetch).toHaveBeenCalledWith("/api/git/remotes/origin", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
    });
  });

  it("throws on invalid name", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(false, { error: "Invalid remote name" }, 400));

    await expect(removeGitRemote("invalid;cmd")).rejects.toThrow("Invalid remote name");
  });

  it("throws when remote does not exist", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(false, { error: "Remote 'origin' does not exist" }, 404));

    await expect(removeGitRemote("origin")).rejects.toThrow("Remote 'origin' does not exist");
  });
});

describe("renameGitRemote", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("renames a remote successfully", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, { oldName: "origin", newName: "upstream", renamed: true }));

    await renameGitRemote("origin", "upstream");

    expect(globalThis.fetch).toHaveBeenCalledWith("/api/git/remotes/origin", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ newName: "upstream" }),
    });
  });

  it("throws on invalid name", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(false, { error: "Invalid remote name" }, 400));

    await expect(renameGitRemote("invalid;cmd", "upstream")).rejects.toThrow("Invalid remote name");
  });

  it("throws when remote does not exist", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(false, { error: "Remote 'origin' does not exist" }, 404));

    await expect(renameGitRemote("origin", "upstream")).rejects.toThrow("Remote 'origin' does not exist");
  });

  it("throws when new name already exists", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(false, { error: "Remote 'upstream' already exists" }, 409));

    await expect(renameGitRemote("origin", "upstream")).rejects.toThrow("Remote 'upstream' already exists");
  });
});

describe("updateGitRemoteUrl", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("updates remote URL successfully", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, { name: "origin", url: "https://new-url.com/repo.git", updated: true }));

    await updateGitRemoteUrl("origin", "https://new-url.com/repo.git");

    expect(globalThis.fetch).toHaveBeenCalledWith("/api/git/remotes/origin/url", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://new-url.com/repo.git" }),
    });
  });

  it("throws on invalid name", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(false, { error: "Invalid remote name" }, 400));

    await expect(updateGitRemoteUrl("invalid;cmd", "https://github.com/test/repo.git")).rejects.toThrow("Invalid remote name");
  });

  it("throws on invalid URL", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(false, { error: "Invalid git URL format" }, 400));

    await expect(updateGitRemoteUrl("origin", "not-a-valid-url")).rejects.toThrow("Invalid git URL format");
  });

  it("throws when remote does not exist", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(false, { error: "Remote 'origin' does not exist" }, 404));

    await expect(updateGitRemoteUrl("origin", "https://github.com/test/repo.git")).rejects.toThrow("Remote 'origin' does not exist");
  });
});

// --- Plan approval API tests ---

import { approvePlan, rejectPlan } from "./api";

describe("approvePlan", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("approves plan and returns updated task", async () => {
    const approvedTask: Task = {
      ...FAKE_DETAIL,
      column: "todo",
      status: undefined,
    };
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, approvedTask));

    const result = await approvePlan("FN-001");

    expect(result.column).toBe("todo");
    expect(result.status).toBeUndefined();
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/tasks/FN-001/approve-plan", {
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
  });

  it("throws on error response", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(
      mockFetchResponse(false, { error: "Task must be in 'triage' column to approve plan" }, 400)
    );

    await expect(approvePlan("FN-001")).rejects.toThrow("triage");
  });
});

describe("rejectPlan", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("rejects plan and returns updated task", async () => {
    const rejectedTask: Task = {
      ...FAKE_DETAIL,
      column: "triage",
      status: undefined,
    };
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, rejectedTask));

    const result = await rejectPlan("FN-001");

    expect(result.column).toBe("triage");
    expect(result.status).toBeUndefined();
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/tasks/FN-001/reject-plan", {
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
  });

  it("throws on error response", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(
      mockFetchResponse(false, { error: "Task must have status 'awaiting-approval' to reject plan" }, 400)
    );

    await expect(rejectPlan("FN-001")).rejects.toThrow("awaiting-approval");
  });
});

// --- Refinement API tests ---

describe("refineTask", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const FAKE_REFINED_TASK: Task = {
    id: "FN-002",
    description: "Refinement of FN-001",
    column: "triage",
    dependencies: ["FN-001"],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  it("sends POST with feedback and returns new refinement task", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, FAKE_REFINED_TASK));

    const result = await refineTask("FN-001", "Need to add more tests and improve error handling");

    expect(result.id).toBe("FN-002");
    expect(result.column).toBe("triage");
    expect(result.dependencies).toContain("FN-001");
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/tasks/FN-001/refine", {
      headers: { "Content-Type": "application/json" },
      method: "POST",
      body: JSON.stringify({ feedback: "Need to add more tests and improve error handling" }),
    });
  });

  it("throws on error response when task not found", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(
      mockFetchResponse(false, { error: "Task not found" }, 404)
    );

    await expect(refineTask("KB-999", "feedback")).rejects.toThrow("Task not found");
  });

  it("throws on error response when task not in done/in-review", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(
      mockFetchResponse(false, { error: "Task must be in 'done' or 'in-review' column to refine" }, 400)
    );

    await expect(refineTask("FN-001", "feedback")).rejects.toThrow("done' or 'in-review'");
  });
});

// --- Git Management API tests ---

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
} from "./api";

describe("agent API wrappers", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("creates agents with full create payload and project scope", async () => {
    const createdAgent = { id: "agent-001", name: "reviewer", role: "reviewer", state: "idle" };
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, createdAgent, 201));

    await createAgent({
      name: "reviewer",
      role: "reviewer",
      title: "Review Agent",
      icon: "🔍",
      reportsTo: "agent-parent",
      runtimeConfig: { heartbeatIntervalMs: 15000, maxConcurrentRuns: 2 },
      permissions: { read: true, write: false },
      instructionsPath: ".fusion/agents/reviewer.md",
      instructionsText: "Prioritize security and edge cases.",
    }, "proj_123");

    expect(globalThis.fetch).toHaveBeenCalledWith("/api/agents?projectId=proj_123", {
      headers: { "Content-Type": "application/json" },
      method: "POST",
      body: JSON.stringify({
        name: "reviewer",
        role: "reviewer",
        title: "Review Agent",
        icon: "🔍",
        reportsTo: "agent-parent",
        runtimeConfig: { heartbeatIntervalMs: 15000, maxConcurrentRuns: 2 },
        permissions: { read: true, write: false },
        instructionsPath: ".fusion/agents/reviewer.md",
        instructionsText: "Prioritize security and edge cases.",
      }),
    });
  });

  it("updates agents with runtime + instruction fields", async () => {
    const updatedAgent = { id: "agent-001", name: "reviewer", role: "reviewer", state: "active" };
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, updatedAgent));

    await updateAgent("agent-001", {
      runtimeConfig: { heartbeatTimeoutMs: 45000, maxConcurrentRuns: 3 },
      instructionsPath: ".fusion/agents/reviewer.md",
      instructionsText: "Handle migrations cautiously.",
      pauseReason: "maintenance",
      reportsTo: undefined,
    }, "proj_123");

    expect(globalThis.fetch).toHaveBeenCalledWith("/api/agents/agent-001?projectId=proj_123", {
      headers: { "Content-Type": "application/json" },
      method: "PATCH",
      body: JSON.stringify({
        runtimeConfig: { heartbeatTimeoutMs: 45000, maxConcurrentRuns: 3 },
        instructionsPath: ".fusion/agents/reviewer.md",
        instructionsText: "Handle migrations cautiously.",
        pauseReason: "maintenance",
      }),
    });
  });
});

describe("startAgentRun", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("sends POST to start a run for an agent", async () => {
    const mockRun = {
      id: "run-001",
      agentId: "agent-001",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: null,
      status: "active",
    };
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, mockRun, 201));

    const result = await startAgentRun("agent-001");

    expect(result.id).toBe("run-001");
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/agents/agent-001/runs", {
      headers: { "Content-Type": "application/json" },
      method: "POST",
      body: JSON.stringify({ source: "manual", triggerDetail: "Agent activated via dashboard" }),
    });
  });

  it("passes projectId as query param", async () => {
    const mockRun = { id: "run-001", agentId: "agent-001", startedAt: "", endedAt: null, status: "active" };
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, mockRun, 201));

    await startAgentRun("agent-001", "proj_123");

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/agents/agent-001/runs?projectId=proj_123",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("throws on 404 when agent not found", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(
      mockFetchResponse(false, { error: "Agent agent-999 not found" }, 404),
    );

    await expect(startAgentRun("agent-999")).rejects.toThrow("not found");
  });
});

describe("fetchAgentChildren", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("fetches children for an agent", async () => {
    const mockChildren = [
      { id: "child-1", name: "Child Agent 1", state: "active", reportsTo: "agent-001" },
      { id: "child-2", name: "Child Agent 2", state: "idle", reportsTo: "agent-001" },
    ];
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, mockChildren));

    const { fetchAgentChildren } = await import("./api");
    const result = await fetchAgentChildren("agent-001");

    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("child-1");
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/agents/agent-001/children", {
      headers: { "Content-Type": "application/json" },
    });
  });

  it("passes projectId as query param", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, []));

    const { fetchAgentChildren } = await import("./api");
    await fetchAgentChildren("agent-001", "proj_123");

    expect(globalThis.fetch).toHaveBeenCalledWith("/api/agents/agent-001/children?projectId=proj_123", {
      headers: { "Content-Type": "application/json" },
    });
  });

  it("returns empty array for 404 (agent not found)", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(
      mockFetchResponse(false, { error: "Agent not found" }, 404),
    );

    const { fetchAgentChildren } = await import("./api");
    const result = await fetchAgentChildren("agent-999");

    expect(result).toEqual([]);
  });

  it("throws on non-404 errors", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(
      mockFetchResponse(false, { error: "Internal server error" }, 500),
    );

    const { fetchAgentChildren } = await import("./api");
    await expect(fetchAgentChildren("agent-001")).rejects.toThrow("Internal server error");
  });
});

describe("Git Management API", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("fetchGitStatus", () => {
    it("returns git status", async () => {
      const status = { branch: "main", commit: "abc1234", isDirty: false, ahead: 0, behind: 0 };
      globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, status));

      const result = await fetchGitStatus();

      expect(result).toEqual(status);
      expect(globalThis.fetch).toHaveBeenCalledWith("/api/git/status", {
        headers: { "Content-Type": "application/json" },
      });
    });

    it("throws on error", async () => {
      globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(false, { error: "Not a git repository" }, 400));

      await expect(fetchGitStatus()).rejects.toThrow("Not a git repository");
    });
  });

  describe("fetchGitCommits", () => {
    it("returns commits without limit", async () => {
      const commits = [
        { hash: "abc123", shortHash: "abc", message: "Test commit", author: "User", date: "2026-01-01", parents: [] },
      ];
      globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, commits));

      const result = await fetchGitCommits();

      expect(result).toEqual(commits);
      expect(globalThis.fetch).toHaveBeenCalledWith("/api/git/commits", {
        headers: { "Content-Type": "application/json" },
      });
    });

    it("includes limit in query string", async () => {
      const commits = [{ hash: "abc123", shortHash: "abc", message: "Test", author: "User", date: "2026-01-01", parents: [] }];
      globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, commits));

      const result = await fetchGitCommits(50);

      expect(result).toEqual(commits);
      expect(globalThis.fetch).toHaveBeenCalledWith("/api/git/commits?limit=50", {
        headers: { "Content-Type": "application/json" },
      });
    });
  });

  describe("fetchCommitDiff", () => {
    it("returns diff for a commit", async () => {
      const diff = { stat: "1 file changed", patch: "diff content" };
      globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, diff));

      const result = await fetchCommitDiff("abc123");

      expect(result).toEqual(diff);
      expect(globalThis.fetch).toHaveBeenCalledWith("/api/git/commits/abc123/diff", {
        headers: { "Content-Type": "application/json" },
      });
    });

    it("throws on 404", async () => {
      globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(false, { error: "Commit not found" }, 404));

      await expect(fetchCommitDiff("invalid")).rejects.toThrow("Commit not found");
    });
  });

  describe("fetchAheadCommits", () => {
    it("returns commits ahead of upstream", async () => {
      const commits = [
        { hash: "abc123", shortHash: "abc", message: "Fix bug", author: "User", date: "2026-01-01", parents: [] },
      ];
      globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, commits));

      const result = await fetchAheadCommits();

      expect(result).toEqual(commits);
      expect(globalThis.fetch).toHaveBeenCalledWith("/api/git/commits/ahead", {
        headers: { "Content-Type": "application/json" },
      });
    });

    it("returns empty array when no upstream", async () => {
      globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, []));

      const result = await fetchAheadCommits();

      expect(result).toEqual([]);
    });
  });

  describe("fetchRemoteCommits", () => {
    it("fetches commits for a remote with default params", async () => {
      const commits = [
        { hash: "def456", shortHash: "def", message: "Remote commit", author: "User", date: "2026-01-01", parents: [] },
      ];
      globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, commits));

      const result = await fetchRemoteCommits("origin");

      expect(result).toEqual(commits);
      expect(globalThis.fetch).toHaveBeenCalledWith("/api/git/remotes/origin/commits", {
        headers: { "Content-Type": "application/json" },
      });
    });

    it("includes ref and limit in query", async () => {
      globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, []));

      await fetchRemoteCommits("origin", "main", 5);

      expect(globalThis.fetch).toHaveBeenCalledWith("/api/git/remotes/origin/commits?ref=main&limit=5", {
        headers: { "Content-Type": "application/json" },
      });
    });

    it("encodes remote name in URL", async () => {
      globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, []));

      await fetchRemoteCommits("my-remote");

      expect(globalThis.fetch).toHaveBeenCalledWith("/api/git/remotes/my-remote/commits", {
        headers: { "Content-Type": "application/json" },
      });
    });
  });

  describe("fetchGitBranches", () => {
    it("returns branches array", async () => {
      const branches = [{ name: "main", isCurrent: true, remote: "origin/main" }];
      globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, branches));

      const result = await fetchGitBranches();

      expect(result).toEqual(branches);
    });
  });

  describe("fetchGitWorktrees", () => {
    it("returns worktrees array", async () => {
      const worktrees = [{ path: "/path/to/repo", branch: "main", isMain: true, isBare: false }];
      globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, worktrees));

      const result = await fetchGitWorktrees();

      expect(result).toEqual(worktrees);
    });
  });

  describe("createBranch", () => {
    it("sends POST to create branch", async () => {
      globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, { created: true }, 201));

      await createBranch("feature-branch");

      expect(globalThis.fetch).toHaveBeenCalledWith("/api/git/branches", {
        headers: { "Content-Type": "application/json" },
        method: "POST",
        body: JSON.stringify({ name: "feature-branch", base: undefined }),
      });
    });

    it("sends base when provided", async () => {
      globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, { created: true }, 201));

      await createBranch("feature-branch", "main");

      expect(globalThis.fetch).toHaveBeenCalledWith("/api/git/branches", {
        headers: { "Content-Type": "application/json" },
        method: "POST",
        body: JSON.stringify({ name: "feature-branch", base: "main" }),
      });
    });

    it("throws on error", async () => {
      globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(false, { error: "Invalid branch name" }, 400));

      await expect(createBranch("invalid")).rejects.toThrow("Invalid branch name");
    });
  });

  describe("checkoutBranch", () => {
    it("sends POST to checkout branch", async () => {
      globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, { checkedOut: "main" }));

      await checkoutBranch("main");

      expect(globalThis.fetch).toHaveBeenCalledWith("/api/git/branches/main/checkout", {
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
    });

    it("encodes branch name", async () => {
      globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, {}));

      await checkoutBranch("feature/test");

      expect(globalThis.fetch).toHaveBeenCalledWith("/api/git/branches/feature%2Ftest/checkout", {
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
    });
  });

  describe("deleteBranch", () => {
    it("sends DELETE to remove branch", async () => {
      globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, { deleted: "feature" }));

      await deleteBranch("feature");

      expect(globalThis.fetch).toHaveBeenCalledWith("/api/git/branches/feature", {
        headers: { "Content-Type": "application/json" },
        method: "DELETE",
      });
    });

    it("includes force query param when true", async () => {
      globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, { deleted: "feature" }));

      await deleteBranch("feature", true);

      expect(globalThis.fetch).toHaveBeenCalledWith("/api/git/branches/feature?force=true", {
        headers: { "Content-Type": "application/json" },
        method: "DELETE",
      });
    });
  });

  describe("fetchRemote", () => {
    it("sends POST to fetch origin by default", async () => {
      const result = { fetched: true, message: "Fetched" };
      globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, result));

      const response = await fetchRemote();

      expect(response).toEqual(result);
      expect(globalThis.fetch).toHaveBeenCalledWith("/api/git/fetch", {
        headers: { "Content-Type": "application/json" },
        method: "POST",
        body: JSON.stringify({ remote: undefined }),
      });
    });

    it("sends custom remote when provided", async () => {
      const result = { fetched: true, message: "Fetched from upstream" };
      globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, result));

      await fetchRemote("upstream");

      expect(globalThis.fetch).toHaveBeenCalledWith("/api/git/fetch", {
        headers: { "Content-Type": "application/json" },
        method: "POST",
        body: JSON.stringify({ remote: "upstream" }),
      });
    });
  });

  describe("pullBranch", () => {
    it("sends POST to pull", async () => {
      const result = { success: true, message: "Pulled 2 commits" };
      globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, result));

      const response = await pullBranch();

      expect(response).toEqual(result);
      expect(globalThis.fetch).toHaveBeenCalledWith("/api/git/pull", {
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
    });

    it("returns conflict info when there are conflicts", async () => {
      const result = { success: false, message: "Merge conflict", conflict: true };
      globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, result, 409));

      const response = await pullBranch();

      expect(response.conflict).toBe(true);
    });
  });

  describe("pushBranch", () => {
    it("sends POST to push", async () => {
      const result = { success: true, message: "Pushed to origin" };
      globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, result));

      const response = await pushBranch();

      expect(response).toEqual(result);
      expect(globalThis.fetch).toHaveBeenCalledWith("/api/git/push", {
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
    });

    it("throws on rejection", async () => {
      globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(false, { error: "Push rejected" }, 409));

      await expect(pushBranch()).rejects.toThrow("Push rejected");
    });
  });

  describe("archiveTask", () => {
    it("sends POST to archive endpoint", async () => {
      const archivedTask: Task = { ...FAKE_DETAIL, column: "archived" };
      globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, archivedTask));

      const response = await archiveTask("FN-001");

      expect(response.column).toBe("archived");
      expect(globalThis.fetch).toHaveBeenCalledWith("/api/tasks/FN-001/archive", {
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
    });

    it("throws on error", async () => {
      globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(false, { error: "Task not in done" }, 400));

      await expect(archiveTask("FN-001")).rejects.toThrow("Task not in done");
    });
  });

  describe("unarchiveTask", () => {
    it("sends POST to unarchive endpoint", async () => {
      const unarchivedTask: Task = { ...FAKE_DETAIL, column: "done" };
      globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, unarchivedTask));

      const response = await unarchiveTask("FN-001");

      expect(response.column).toBe("done");
      expect(globalThis.fetch).toHaveBeenCalledWith("/api/tasks/FN-001/unarchive", {
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
    });

    it("throws on error", async () => {
      globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(false, { error: "Task not in archived" }, 400));

      await expect(unarchiveTask("FN-001")).rejects.toThrow("Task not in archived");
    });
  });

  describe("deleteTask", () => {
    it("sends DELETE to task endpoint", async () => {
      const deletedTask: Task = { ...FAKE_DETAIL, column: "done" };
      globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, deletedTask));

      const response = await deleteTask("FN-001");

      expect(response).toEqual(deletedTask);
      expect(globalThis.fetch).toHaveBeenCalledWith("/api/tasks/FN-001", {
        headers: { "Content-Type": "application/json" },
        method: "DELETE",
      });
    });

    it("throws on error", async () => {
      globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(false, { error: "Not found" }, 404));

      await expect(deleteTask("FN-001")).rejects.toThrow("Not found");
    });
  });

  describe("moveTask", () => {
    it("sends POST to move endpoint with column body", async () => {
      const movedTask: Task = { ...FAKE_DETAIL, column: "todo" };
      globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, movedTask));

      const response = await moveTask("FN-001", "todo");

      expect(response.column).toBe("todo");
      expect(globalThis.fetch).toHaveBeenCalledWith("/api/tasks/FN-001/move", {
        headers: { "Content-Type": "application/json" },
        method: "POST",
        body: JSON.stringify({ column: "todo" }),
      });
    });

    it("sends POST with done column", async () => {
      const movedTask: Task = { ...FAKE_DETAIL, column: "done" };
      globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, movedTask));

      const response = await moveTask("FN-001", "done");

      expect(response.column).toBe("done");
      expect(globalThis.fetch).toHaveBeenCalledWith("/api/tasks/FN-001/move", {
        headers: { "Content-Type": "application/json" },
        method: "POST",
        body: JSON.stringify({ column: "done" }),
      });
    });

    it("forwards projectId as query param", async () => {
      const movedTask: Task = { ...FAKE_DETAIL, column: "todo" };
      globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, movedTask));

      await moveTask("FN-001", "todo", "proj_123");

      expect(globalThis.fetch).toHaveBeenCalledWith("/api/tasks/FN-001/move?projectId=proj_123", {
        headers: { "Content-Type": "application/json" },
        method: "POST",
        body: JSON.stringify({ column: "todo" }),
      });
    });

    it("throws on error", async () => {
      globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(false, { error: "Cannot move to same column" }, 400));

      await expect(moveTask("FN-001", "todo")).rejects.toThrow("Cannot move to same column");
    });
  });

  describe("mergeTask", () => {
    it("sends POST to merge endpoint and returns MergeResult", async () => {
      const mergeResult: MergeResult = {
        source: "FN-001",
        target: "FN-002",
        details: {
          mergedFields: ["description", "steps"],
          sourceDeleted: true,
        },
      };
      globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, mergeResult));

      const response = await mergeTask("FN-001");

      expect(response).toEqual(mergeResult);
      expect(globalThis.fetch).toHaveBeenCalledWith("/api/tasks/FN-001/merge", {
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
    });

    it("throws on error", async () => {
      globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(false, { error: "Cannot merge with itself" }, 400));

      await expect(mergeTask("FN-001")).rejects.toThrow("Cannot merge with itself");
    });
  });

  describe("retryTask", () => {
    it("sends POST to retry endpoint", async () => {
      const retriedTask: Task = { ...FAKE_DETAIL, column: "todo" };
      globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, retriedTask));

      const response = await retryTask("FN-001");

      expect(response).toEqual(retriedTask);
      expect(globalThis.fetch).toHaveBeenCalledWith("/api/tasks/FN-001/retry", {
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
    });

    it("throws on error", async () => {
      globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(false, { error: "Task not in error state" }, 400));

      await expect(retryTask("FN-001")).rejects.toThrow("Task not in error state");
    });
  });

  describe("duplicateTask", () => {
    it("sends POST to duplicate endpoint", async () => {
      const duplicatedTask: Task = { ...FAKE_DETAIL, id: "FN-002" };
      globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, duplicatedTask));

      const response = await duplicateTask("FN-001");

      expect(response.id).toBe("FN-002");
      expect(globalThis.fetch).toHaveBeenCalledWith("/api/tasks/FN-001/duplicate", {
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
    });

    it("throws on error", async () => {
      globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(false, { error: "Duplicate failed" }, 500));

      await expect(duplicateTask("FN-001")).rejects.toThrow("Duplicate failed");
    });
  });

  describe("pauseTask", () => {
    it("sends POST to pause endpoint", async () => {
      const pausedTask: Task = { ...FAKE_DETAIL, column: "in-progress" };
      globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, pausedTask));

      const response = await pauseTask("FN-001");

      expect(response).toEqual(pausedTask);
      expect(globalThis.fetch).toHaveBeenCalledWith("/api/tasks/FN-001/pause", {
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
    });

    it("throws on error", async () => {
      globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(false, { error: "Cannot pause completed task" }, 400));

      await expect(pauseTask("FN-001")).rejects.toThrow("Cannot pause completed task");
    });
  });

  describe("unpauseTask", () => {
    it("sends POST to unpause endpoint", async () => {
      const unpausedTask: Task = { ...FAKE_DETAIL, column: "in-progress" };
      globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, unpausedTask));

      const response = await unpauseTask("FN-001");

      expect(response).toEqual(unpausedTask);
      expect(globalThis.fetch).toHaveBeenCalledWith("/api/tasks/FN-001/unpause", {
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
    });

    it("throws on error", async () => {
      globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(false, { error: "Task not paused" }, 400));

      await expect(unpauseTask("FN-001")).rejects.toThrow("Task not paused");
    });
  });

  describe("workspace file APIs", () => {
    it("fetchWorkspaces requests the workspace list", async () => {
      const payload = {
        project: "/repo",
        tasks: [{ id: "FN-001", title: "Task", worktree: "/repo/.worktrees/kb-001" }],
      };
      globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, payload));

      const response = await fetchWorkspaces();

      expect(response).toEqual(payload);
      expect(globalThis.fetch).toHaveBeenCalledWith("/api/workspaces", {
        headers: { "Content-Type": "application/json" },
      });
    });

    it("fetchWorkspaceFileList sends workspace and path query params", async () => {
      const payload = { path: "src", entries: [] };
      globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, payload));

      const response = await fetchWorkspaceFileList("FN-001", "src");

      expect(response).toEqual(payload);
      expect(globalThis.fetch).toHaveBeenCalledWith("/api/files?workspace=FN-001&path=src", {
        headers: { "Content-Type": "application/json" },
      });
    });

    it("fetchWorkspaceFileContent sends the workspace query param", async () => {
      const payload = { content: "hello", mtime: "2026-01-01T00:00:00.000Z", size: 5 };
      globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, payload));

      const response = await fetchWorkspaceFileContent("project", "src/index.ts");

      expect(response).toEqual(payload);
      expect(globalThis.fetch).toHaveBeenCalledWith("/api/files/src%2Findex.ts?workspace=project", {
        headers: { "Content-Type": "application/json" },
      });
    });

    it("saveWorkspaceFileContent posts content to the workspace route", async () => {
      const payload = { success: true, mtime: "2026-01-01T00:00:00.000Z", size: 5 };
      globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, payload));

      const response = await saveWorkspaceFileContent("FN-001", "src/index.ts", "hello");

      expect(response).toEqual(payload);
      expect(globalThis.fetch).toHaveBeenCalledWith("/api/files/src%2Findex.ts?workspace=FN-001", {
        headers: { "Content-Type": "application/json" },
        method: "POST",
        body: JSON.stringify({ content: "hello" }),
      });
    });

    it("deleteFile sends POST to the delete route with encoded URL and workspace query", async () => {
      // FN-1492 regression: ensure folder delete (e.g., "somefolder/") doesn't hit the
      // generic write route POST /files/{*filepath} and get rejected for missing `content`.
      const payload = { success: true, mtime: null, size: 0 };
      globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, payload));

      const response = await deleteFile("FN-001", "src/old");

      expect(response).toEqual(payload);
      // Verify the delete operation goes to /files/{encoded-path}/delete (not the write route)
      expect(globalThis.fetch).toHaveBeenCalledWith("/api/files/src%2Fold/delete?workspace=FN-001", {
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
    });

    it("deleteFile URL-encodes nested paths correctly", async () => {
      const payload = { success: true, mtime: null, size: 0 };
      globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, payload));

      await deleteFile("FN-001", "a/b/c");

      // Forward slashes in path segments must be encoded so Express matches
      // POST /files/{*filepath}/delete rather than POST /files/{*filepath}
      expect(globalThis.fetch).toHaveBeenCalledWith("/api/files/a%2Fb%2Fc/delete?workspace=FN-001", {
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
    });

    it("deleteFile handles folder paths (FN-1492 regression)", async () => {
      const payload = { success: true, mtime: null, size: 0 };
      globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, payload));

      // Deleting a folder should work without hitting write-route validation
      const response = await deleteFile("FN-001", "old-folder");

      expect(response).toEqual(payload);
      expect(globalThis.fetch).toHaveBeenCalledWith("/api/files/old-folder/delete?workspace=FN-001", {
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
    });

    it("propagates workspace API errors", async () => {
      globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(false, { error: "Task not found" }, 404));

      await expect(fetchWorkspaceFileList("FN-404")).rejects.toThrow("Task not found");
    });
  });
});

// --- Planning Mode API Tests ---

import { startPlanning, respondToPlanning, cancelPlanning, createTaskFromPlanning } from "./api";
import type { PlanningQuestion, PlanningSummary } from "@fusion/core";

describe("Planning Mode API", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const FAKE_QUESTION: PlanningQuestion = {
    id: "q-scope",
    type: "single_select",
    question: "What is the scope of this plan?",
    description: "This helps estimate the size and complexity.",
    options: [
      { id: "small", label: "Small", description: "Quick implementation" },
      { id: "large", label: "Large", description: "Complex feature" },
    ],
  };

  const FAKE_SUMMARY: PlanningSummary = {
    title: "Build user authentication",
    description: "Implement login/logout with JWT tokens",
    suggestedSize: "M",
    suggestedDependencies: [],
    keyDeliverables: ["Login form", "JWT middleware", "Logout endpoint"],
  };

  describe("startPlanning", () => {
    it("sends POST with initial plan and returns session", async () => {
      const response = { sessionId: "plan-123", currentQuestion: FAKE_QUESTION, summary: null };
      globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, response, 201));

      const result = await startPlanning("Build a user auth system");

      expect(result.sessionId).toBe("plan-123");
      expect(result.currentQuestion).toEqual(FAKE_QUESTION);
      expect(globalThis.fetch).toHaveBeenCalledWith("/api/planning/start", {
        headers: { "Content-Type": "application/json" },
        method: "POST",
        body: JSON.stringify({ initialPlan: "Build a user auth system" }),
      });
    });

    it("throws on rate limit error", async () => {
      globalThis.fetch = vi.fn().mockReturnValue(
        mockFetchResponse(false, { error: "Rate limit exceeded. Maximum 5 planning sessions per hour." }, 429)
      );

      await expect(startPlanning("Build something")).rejects.toThrow("Rate limit exceeded");
    });

    it("accepts long initialPlan values (no character limit)", async () => {
      // Test that long initialPlan values are accepted by the server (removed 500-char limit)
      const response = { sessionId: "plan-456", currentQuestion: FAKE_QUESTION, summary: null };
      globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, response, 201));

      const result = await startPlanning("a".repeat(2000));

      expect(result.sessionId).toBe("plan-456");
      expect(globalThis.fetch).toHaveBeenCalledWith("/api/planning/start", {
        headers: { "Content-Type": "application/json" },
        method: "POST",
        body: JSON.stringify({ initialPlan: "a".repeat(2000) }),
      });
    });
  });

  describe("respondToPlanning", () => {
    it("sends POST with responses and returns next question", async () => {
      const response = { sessionId: "plan-123", currentQuestion: FAKE_QUESTION, summary: null };
      globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, response));

      const result = await respondToPlanning("plan-123", { scope: "small" });

      expect(result.sessionId).toBe("plan-123");
      expect(globalThis.fetch).toHaveBeenCalledWith("/api/planning/respond", {
        headers: { "Content-Type": "application/json" },
        method: "POST",
        body: JSON.stringify({ sessionId: "plan-123", responses: { scope: "small" } }),
      });
    });

    it("returns summary when planning is complete", async () => {
      const response = { sessionId: "plan-123", currentQuestion: null, summary: FAKE_SUMMARY };
      globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, response));

      const result = await respondToPlanning("plan-123", { final: "yes" });

      expect(result.summary).toEqual(FAKE_SUMMARY);
      expect(result.currentQuestion).toBeNull();
    });

    it("throws on session not found", async () => {
      globalThis.fetch = vi.fn().mockReturnValue(
        mockFetchResponse(false, { error: "Planning session plan-123 not found or expired" }, 404)
      );

      await expect(respondToPlanning("plan-123", {})).rejects.toThrow("not found");
    });
  });

  describe("cancelPlanning", () => {
    it("sends POST to cancel endpoint", async () => {
      globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, { success: true }));

      await cancelPlanning("plan-123");

      expect(globalThis.fetch).toHaveBeenCalledWith("/api/planning/cancel", {
        headers: { "Content-Type": "application/json" },
        method: "POST",
        body: JSON.stringify({ sessionId: "plan-123" }),
      });
    });

    it("throws on session not found", async () => {
      globalThis.fetch = vi.fn().mockReturnValue(
        mockFetchResponse(false, { error: "Planning session not found" }, 404)
      );

      await expect(cancelPlanning("plan-123")).rejects.toThrow("not found");
    });
  });

  describe("createTaskFromPlanning", () => {
    it("sends POST to create-task endpoint and returns task", async () => {
      const createdTask: Task = {
        id: "FN-042",
        title: "Build user authentication",
        description: "Implement login/logout with JWT tokens",
        column: "triage",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      };
      globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, createdTask, 201));

      const result = await createTaskFromPlanning("plan-123");

      expect(result.id).toBe("FN-042");
      expect(result.column).toBe("triage");
      expect(globalThis.fetch).toHaveBeenCalledWith("/api/planning/create-task", {
        headers: { "Content-Type": "application/json" },
        method: "POST",
        body: JSON.stringify({ sessionId: "plan-123" }),
      });
    });

    it("throws when session is not complete", async () => {
      globalThis.fetch = vi.fn().mockReturnValue(
        mockFetchResponse(false, { error: "Planning session is not complete" }, 400)
      );

      await expect(createTaskFromPlanning("plan-123")).rejects.toThrow("not complete");
    });

    it("throws on session not found", async () => {
      globalThis.fetch = vi.fn().mockReturnValue(
        mockFetchResponse(false, { error: "Planning session not found" }, 404)
      );

      await expect(createTaskFromPlanning("plan-123")).rejects.toThrow("not found");
    });
  });
});

// --- API Error Handling Tests ---

/** Mock helper for HTML error responses (e.g., 404 page) */
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

// ── AI Text Refinement API Tests ───────────────────────────────────────────

import { refineText, getRefineErrorMessage, REFINE_ERROR_MESSAGES, type RefinementType } from "./api";

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

// ── Project Management API Tests ───────────────────────────────────────────

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
    const states: ExecutorState[] = ["idle", "running", "paused"];

    expect(states).toContain("idle");
    expect(states).toContain("running");
    expect(states).toContain("paused");
  });
});

// ── Regression: Mission mutation 204 response handling ─────────────────────
//
// Mission DELETE and reorder endpoints return 204 No Content. The api()
// function must handle these responses correctly instead of throwing
// a misleading content-type error.
describe("Mission mutation coverage with 204 responses", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns undefined for void responses (204 No Content)", async () => {
    globalThis.fetch = vi.fn().mockReturnValue({
      ok: true,
      status: 204,
      headers: new Headers(),
      text: () => Promise.resolve(""),
    });

    const { deleteMission } = await import("./api");
    const result = await deleteMission("M-LZ7DN0-A2B5");
    expect(result).toBeUndefined();
  });

  it("returns undefined for milestone delete (204 No Content)", async () => {
    globalThis.fetch = vi.fn().mockReturnValue({
      ok: true,
      status: 204,
      headers: new Headers(),
      text: () => Promise.resolve(""),
    });

    const { deleteMilestone } = await import("./api");
    const result = await deleteMilestone("MS-M3N8QR-C9F1");
    expect(result).toBeUndefined();
  });

  it("returns undefined for slice delete (204 No Content)", async () => {
    globalThis.fetch = vi.fn().mockReturnValue({
      ok: true,
      status: 204,
      headers: new Headers(),
      text: () => Promise.resolve(""),
    });

    const { deleteSlice } = await import("./api");
    const result = await deleteSlice("SL-P4T2WX-D5E8");
    expect(result).toBeUndefined();
  });

  it("returns undefined for feature delete (204 No Content)", async () => {
    globalThis.fetch = vi.fn().mockReturnValue({
      ok: true,
      status: 204,
      headers: new Headers(),
      text: () => Promise.resolve(""),
    });

    const { deleteFeature } = await import("./api");
    const result = await deleteFeature("F-J6K9AB-G7H3");
    expect(result).toBeUndefined();
  });

  it("returns undefined for milestone reorder (204 No Content)", async () => {
    globalThis.fetch = vi.fn().mockReturnValue({
      ok: true,
      status: 204,
      headers: new Headers(),
      text: () => Promise.resolve(""),
    });

    const { reorderMilestones } = await import("./api");
    const result = await reorderMilestones("M-LZ7DN0-A2B5", ["MS-1", "MS-2"]);
    expect(result).toBeUndefined();
  });

  it("returns undefined for slice reorder (204 No Content)", async () => {
    globalThis.fetch = vi.fn().mockReturnValue({
      ok: true,
      status: 204,
      headers: new Headers(),
      text: () => Promise.resolve(""),
    });

    const { reorderSlices } = await import("./api");
    const result = await reorderSlices("MS-M3N8QR-C9F1", ["SL-1", "SL-2"]);
    expect(result).toBeUndefined();
  });

  it("handles 204 with projectId query param", async () => {
    globalThis.fetch = vi.fn().mockReturnValue({
      ok: true,
      status: 204,
      headers: new Headers(),
      text: () => Promise.resolve(""),
    });

    const { deleteMission } = await import("./api");
    const result = await deleteMission("M-LZ7DN0-A2B5", "my-project");
    expect(result).toBeUndefined();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/missions/M-LZ7DN0-A2B5?projectId=my-project"),
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("still throws on JSON error responses (non-204)", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(
      mockFetchResponse(false, { error: "Mission not found" }, 404)
    );

    const { deleteMission } = await import("./api");
    await expect(deleteMission("M-999")).rejects.toThrow("Mission not found");
  });

  it("still throws on invalid ID format (400)", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(
      mockFetchResponse(false, { error: "Invalid mission ID format" }, 400)
    );

    const { deleteMission } = await import("./api");
    await expect(deleteMission("bad-id")).rejects.toThrow("Invalid mission ID format");
  });
});

describe("resilient SSE reconnect", () => {
  const OriginalEventSource = globalThis.EventSource;
  const originalFetch = globalThis.fetch;

  class ControlledEventSource {
    static instances: ControlledEventSource[] = [];
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 2;

    readyState = ControlledEventSource.OPEN;
    onopen: ((event: Event) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    readonly listeners = new Map<string, Set<(event: MessageEvent) => void>>();

    constructor(public readonly url: string) {
      ControlledEventSource.instances.push(this);
    }

    addEventListener(eventName: string, listener: (event: MessageEvent) => void): void {
      if (!this.listeners.has(eventName)) {
        this.listeners.set(eventName, new Set());
      }
      this.listeners.get(eventName)!.add(listener);
    }

    removeEventListener(eventName: string, listener: (event: MessageEvent) => void): void {
      this.listeners.get(eventName)?.delete(listener);
    }

    close(): void {
      this.readyState = ControlledEventSource.CLOSED;
    }

    emitOpen(): void {
      this.readyState = ControlledEventSource.OPEN;
      this.onopen?.(new Event("open"));
    }

    emitConnectionError(state: number): void {
      this.readyState = state;
      this.onerror?.(new Event("error"));
    }

    emitEvent(eventName: string, data: string, lastEventId = ""): void {
      const event = { data, lastEventId } as MessageEvent;
      for (const listener of this.listeners.get(eventName) ?? []) {
        listener(event);
      }
    }
  }

  beforeEach(() => {
    vi.useFakeTimers();
    ControlledEventSource.instances = [];
    Object.defineProperty(globalThis, "EventSource", {
      configurable: true,
      writable: true,
      value: ControlledEventSource,
    });
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, { ok: true }));
  });

  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(globalThis, "EventSource", {
      configurable: true,
      writable: true,
      value: OriginalEventSource,
    });
    globalThis.fetch = originalFetch;
  });

  it("reconnects with backoff and deduplicates replayed events", () => {
    const onThinking = vi.fn();
    const onState = vi.fn();

    connectPlanningStream("session-1", undefined, {
      onThinking,
      onConnectionStateChange: onState,
    });

    const firstConnection = ControlledEventSource.instances[0]!;
    firstConnection.emitOpen();
    firstConnection.emitEvent("thinking", JSON.stringify("first"), "1");

    firstConnection.emitConnectionError(ControlledEventSource.CLOSED);
    expect(onState).toHaveBeenCalledWith("reconnecting");

    vi.advanceTimersByTime(1000);

    const secondConnection = ControlledEventSource.instances[1]!;
    secondConnection.emitOpen();

    // Duplicate replayed event should be ignored by lastEventId tracking.
    secondConnection.emitEvent("thinking", JSON.stringify("first"), "1");
    secondConnection.emitEvent("thinking", JSON.stringify("second"), "2");

    expect(onThinking).toHaveBeenCalledTimes(2);
    expect(onThinking).toHaveBeenNthCalledWith(1, "first");
    expect(onThinking).toHaveBeenNthCalledWith(2, "second");
    expect(secondConnection.url).toContain("lastEventId=1");
  });

  it("stops reconnecting after max attempts and reports fatal error", () => {
    const onError = vi.fn();

    connectPlanningStream(
      "session-2",
      undefined,
      { onError },
      { maxReconnectAttempts: 2 },
    );

    const first = ControlledEventSource.instances[0]!;
    first.emitConnectionError(ControlledEventSource.CLOSED);
    vi.advanceTimersByTime(1000);

    const second = ControlledEventSource.instances[1]!;
    second.emitConnectionError(ControlledEventSource.CLOSED);
    vi.advanceTimersByTime(2000);

    const third = ControlledEventSource.instances[2]!;
    third.emitConnectionError(ControlledEventSource.CLOSED);

    expect(onError).toHaveBeenCalledWith("Connection lost");
  });

  it("manual close cancels pending reconnect", () => {
    const connection = connectPlanningStream("session-3", undefined, {});

    const first = ControlledEventSource.instances[0]!;
    first.emitConnectionError(ControlledEventSource.CLOSED);

    connection.close();
    vi.advanceTimersByTime(30_000);

    expect(ControlledEventSource.instances).toHaveLength(1);
  });

  it("starts planning keep-alive on open and stops on explicit close", () => {
    const connection = connectPlanningStream("session-keepalive", undefined, {});
    const stream = ControlledEventSource.instances[0]!;

    stream.emitOpen();
    vi.advanceTimersByTime(25_000);

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/ai-sessions/session-keepalive/ping",
      expect.objectContaining({ method: "POST" }),
    );

    const pingCallsBeforeClose = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length;
    connection.close();

    vi.advanceTimersByTime(50_000);

    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(pingCallsBeforeClose);
    expect(stream.readyState).toBe(ControlledEventSource.CLOSED);
  });

  it("stops subtask keep-alive after complete event", () => {
    connectSubtaskStream("subtask-session", undefined, {});
    const stream = ControlledEventSource.instances[0]!;

    stream.emitOpen();
    vi.advanceTimersByTime(25_000);

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/ai-sessions/subtask-session/ping",
      expect.objectContaining({ method: "POST" }),
    );

    const pingCallsBeforeComplete = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length;
    stream.emitEvent("complete", "");

    vi.advanceTimersByTime(50_000);

    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(pingCallsBeforeComplete);
    expect(stream.readyState).toBe(ControlledEventSource.CLOSED);
  });

  it("stops mission interview keep-alive after complete event", () => {
    connectMissionInterviewStream("mission-session", undefined, {});
    const stream = ControlledEventSource.instances[0]!;

    stream.emitOpen();
    vi.advanceTimersByTime(25_000);

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/ai-sessions/mission-session/ping",
      expect.objectContaining({ method: "POST" }),
    );

    const pingCallsBeforeComplete = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length;
    stream.emitEvent("complete", "");

    vi.advanceTimersByTime(50_000);

    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(pingCallsBeforeComplete);
    expect(stream.readyState).toBe(ControlledEventSource.CLOSED);
  });

  it("silently ignores keep-alive ping failures", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("network down"));
    const onThinking = vi.fn();
    const onError = vi.fn();

    connectPlanningStream("session-ping-failure", undefined, {
      onThinking,
      onError,
    });

    const stream = ControlledEventSource.instances[0]!;
    stream.emitOpen();

    vi.advanceTimersByTime(25_000);
    await Promise.resolve();

    stream.emitEvent("thinking", JSON.stringify("still-streaming"));

    expect(onThinking).toHaveBeenCalledWith("still-streaming");
    expect(onError).not.toHaveBeenCalled();
    expect(stream.readyState).toBe(ControlledEventSource.OPEN);
  });
});

describe("fetchAgentRunAudit", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  it("fetches run audit events with correct URL encoding", async () => {
    const mockResponse = {
      runId: "run-001",
      events: [],
      filters: {},
      totalCount: 0,
      hasMore: false,
    };
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, mockResponse));

    const result = await fetchAgentRunAudit("agent-001", "run-001");

    expect(result).toEqual(mockResponse);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/agents/agent-001/runs/run-001/audit",
      expect.objectContaining({ headers: { "Content-Type": "application/json" } })
    );
  });

  it("passes projectId as query param", async () => {
    const mockResponse = { runId: "run-001", events: [], filters: {}, totalCount: 0, hasMore: false };
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, mockResponse));

    await fetchAgentRunAudit("agent-001", "run-001", undefined, "my-project");

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/agents/agent-001/runs/run-001/audit?projectId=my-project",
      expect.objectContaining({ headers: { "Content-Type": "application/json" } })
    );
  });

  it("includes filter params in query string", async () => {
    const mockResponse = { runId: "run-001", events: [], filters: {}, totalCount: 0, hasMore: false };
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, mockResponse));

    await fetchAgentRunAudit("agent-001", "run-001", {
      domain: "git",
      taskId: "FN-001",
      limit: 50,
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/agents/agent-001/runs/run-001/audit?taskId=FN-001&domain=git&limit=50",
      expect.objectContaining({ headers: { "Content-Type": "application/json" } })
    );
  });

  it("throws on 404 with 'Run not found' message", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(
      mockFetchResponse(false, { error: "Run not found" }, 404)
    );

    await expect(fetchAgentRunAudit("agent-001", "run-nonexistent")).rejects.toThrow("Run not found");
  });

  it("throws on 400 for blank runId before calling fetch", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, { runId: "run-001", events: [], filters: {}, totalCount: 0, hasMore: false }));

    // Blank runId should throw synchronously before fetch is called
    expect(() => fetchAgentRunAudit("agent-001", "")).toThrow("runId is required");
    expect(() => fetchAgentRunAudit("agent-001", "   ")).toThrow("runId is required");
    // Note: URL-encoded values like "%20" are valid runId values (they're decoded at the URL level, not parameter level)

    // Verify fetch was never called for blank runId
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe("fetchAgentRunTimeline", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  it("fetches run timeline with correct URL encoding", async () => {
    const mockResponse = {
      run: { id: "run-001", agentId: "agent-001", startedAt: "2026-01-01T00:00:00Z", status: "active" },
      auditByDomain: { database: [], git: [], filesystem: [] },
      counts: { auditEvents: 0, logEntries: 0 },
      timeline: [],
    };
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, mockResponse));

    const result = await fetchAgentRunTimeline("agent-001", "run-001");

    expect(result).toEqual(mockResponse);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/agents/agent-001/runs/run-001/timeline",
      expect.objectContaining({ headers: { "Content-Type": "application/json" } })
    );
  });

  it("passes projectId as query param", async () => {
    const mockResponse = {
      run: { id: "run-001", agentId: "agent-001", startedAt: "2026-01-01T00:00:00Z", status: "active" },
      auditByDomain: { database: [], git: [], filesystem: [] },
      counts: { auditEvents: 0, logEntries: 0 },
      timeline: [],
    };
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, mockResponse));

    await fetchAgentRunTimeline("agent-001", "run-001", undefined, "my-project");

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/agents/agent-001/runs/run-001/timeline?projectId=my-project",
      expect.objectContaining({ headers: { "Content-Type": "application/json" } })
    );
  });

  it("includes options in query string", async () => {
    const mockResponse = {
      run: { id: "run-001", agentId: "agent-001", startedAt: "2026-01-01T00:00:00Z", status: "active" },
      auditByDomain: { database: [], git: [], filesystem: [] },
      counts: { auditEvents: 0, logEntries: 0 },
      timeline: [],
    };
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, mockResponse));

    await fetchAgentRunTimeline("agent-001", "run-001", {
      domain: "filesystem",
      taskId: "FN-001",
      includeLogs: false,
      limit: 100,
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/agents/agent-001/runs/run-001/timeline?taskId=FN-001&domain=filesystem&includeLogs=false&limit=100",
      expect.objectContaining({ headers: { "Content-Type": "application/json" } })
    );
  });

  it("throws on 404 with 'Run not found' message", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(
      mockFetchResponse(false, { error: "Run not found" }, 404)
    );

    await expect(fetchAgentRunTimeline("agent-001", "run-nonexistent")).rejects.toThrow("Run not found");
  });

  it("throws on 400 for blank runId before calling fetch", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, {
      run: { id: "run-001", agentId: "agent-001", startedAt: "2026-01-01T00:00:00Z", status: "active" },
      auditByDomain: { database: [], git: [], filesystem: [] },
      counts: { auditEvents: 0, logEntries: 0 },
      timeline: [],
    }));

    // Blank runId should throw synchronously before fetch is called
    expect(() => fetchAgentRunTimeline("agent-001", "")).toThrow("runId is required");
    expect(() => fetchAgentRunTimeline("agent-001", "   ")).toThrow("runId is required");
    // Note: URL-encoded values like "%20" are valid runId values (they're decoded at the URL level, not parameter level)

    // Verify fetch was never called for blank runId
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe("streamChatResponse", () => {
  const originalFetch = globalThis.fetch;

  const createStreamResponse = (chunks: string[]) => {
    const encoder = new TextEncoder();
    return Promise.resolve({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: {
        get: (name: string) =>
          name.toLowerCase() === "content-type" ? "text/event-stream" : null,
      },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(encoder.encode(chunk));
          }
          controller.close();
        },
      }),
      text: () => Promise.resolve(chunks.join("")),
    } as unknown as Response);
  };

  const withStreamResult = async (
    chunks: string[],
    assertCallbacks: (callbacks: {
      thinking: string[];
      text: string[];
      done: Array<{ messageId: string }>;
      error: string[];
      connectionStates: string[];
    }) => void,
  ) => {
    const callbacks = {
      thinking: [] as string[],
      text: [] as string[],
      done: [] as Array<{ messageId: string }>,
      error: [] as string[],
      connectionStates: [] as string[],
    };

    globalThis.fetch = vi.fn().mockImplementation(() => createStreamResponse(chunks));

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timed out waiting for chat stream")), 10000);
      const stream = streamChatResponse("chat-1", "hello", {
        onThinking: (data) => callbacks.thinking.push(data),
        onText: (data) => callbacks.text.push(data),
        onDone: (data) => {
          callbacks.done.push(data);
          clearTimeout(timeout);
          stream.close();
          resolve();
        },
        onError: (data) => {
          callbacks.error.push(data);
          clearTimeout(timeout);
          stream.close();
          resolve();
        },
        onConnectionStateChange: (state) => callbacks.connectionStates.push(state),
      });
    });

    assertCallbacks(callbacks);
  };

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("delivers chunk-split text and done events in order", async () => {
    await withStreamResult(
      [
        "event: te",
        "xt\ndata: \"Hel",
        "lo\"\n\nevent: do",
        "ne\ndata: {\"messageId\":\"msg-1\"}\n\n",
      ],
      (callbacks) => {
        expect(callbacks.connectionStates).toEqual(["connected"]);
        expect(callbacks.text).toEqual(["Hello"]);
        expect(callbacks.done).toEqual([{ messageId: "msg-1" }]);
        expect(callbacks.error).toEqual([]);
      },
    );
  });

  it("surfaces chunk-split error events through onError", async () => {
    await withStreamResult(
      [
        "event: err",
        "or\ndata: {\"message\":\"boom\"}\n\n",
      ],
      (callbacks) => {
        expect(callbacks.text).toEqual([]);
        expect(callbacks.done).toEqual([]);
        expect(callbacks.error).toEqual(["boom"]);
      },
    );
  });

  it("does not duplicate callbacks when multiple events arrive in one chunk", async () => {
    await withStreamResult(
      [
        "event: text\ndata: \"Hello\"\n\nevent: text\ndata: \" world\"\n\nevent: done\ndata: {\"messageId\":\"msg-2\"}\n\n",
      ],
      (callbacks) => {
        expect(callbacks.text).toEqual(["Hello", " world"]);
        expect(callbacks.done).toEqual([{ messageId: "msg-2" }]);
        expect(callbacks.text).toHaveLength(2);
        expect(callbacks.done).toHaveLength(1);
      },
    );
  });

  it("flushes a final complete event when the stream ends without a trailing blank line", async () => {
    await withStreamResult(
      [
        "event: text\ndata: \"tail\"\n\nevent: done\ndata: {\"messageId\":\"msg-tail\"}",
      ],
      (callbacks) => {
        expect(callbacks.text).toEqual(["tail"]);
        expect(callbacks.done).toEqual([{ messageId: "msg-tail" }]);
        expect(callbacks.error).toEqual([]);
      },
    );
  });

  it("flushes events built from partial chunks when stream ends without trailing newline", async () => {
    await withStreamResult(
      [
        "event: text\ndata: \"partial",
        " chunk\"\n\nevent: done\ndata: {\"messageId\":\"msg-x\"}",
      ],
      (callbacks) => {
        expect(callbacks.text).toEqual(["partial chunk"]);
        expect(callbacks.done).toEqual([{ messageId: "msg-x" }]);
        expect(callbacks.error).toEqual([]);
      },
    );
  });

  it("still delivers events normally when stream ends with proper newlines", async () => {
    await withStreamResult(
      [
        "event: text\ndata: \"hello\"\n\nevent: done\ndata: {\"messageId\":\"msg-n\"}\n\n",
      ],
      (callbacks) => {
        expect(callbacks.text).toEqual(["hello"]);
        expect(callbacks.done).toEqual([{ messageId: "msg-n" }]);
        expect(callbacks.error).toEqual([]);
      },
    );
  });

  it("does not dispatch when stream ends mid-event with incomplete data", async () => {
    const callbacks = {
      thinking: [] as string[],
      text: [] as string[],
      done: [] as Array<{ messageId: string }>,
      error: [] as string[],
      connectionStates: [] as string[],
    };

    globalThis.fetch = vi.fn().mockImplementation(() =>
      createStreamResponse([
        'event: text\ndata: "complete"\n\ndata: "incomp',
      ]),
    );

    const stream = streamChatResponse("chat-1", "hello", {
      onThinking: (data) => callbacks.thinking.push(data),
      onText: (data) => callbacks.text.push(data),
      onDone: (data) => callbacks.done.push(data),
      onError: (data) => callbacks.error.push(data),
      onConnectionStateChange: (state) => callbacks.connectionStates.push(state),
    });

    await new Promise((resolve) => setTimeout(resolve, 25));
    stream.close();

    expect(callbacks.text).toEqual(["complete"]);
    expect(callbacks.done).toEqual([]);
    expect(callbacks.error).toEqual([]);
  });

  it("fires onError when fetch aborts unexpectedly", async () => {
    const callbacks = {
      error: [] as string[],
    };

    globalThis.fetch = vi.fn().mockRejectedValue(new DOMException("The operation was aborted", "AbortError"));

    const stream = streamChatResponse("chat-1", "hello", {
      onError: (data) => callbacks.error.push(data),
    });

    await new Promise((resolve) => setTimeout(resolve, 25));
    stream.close();

    expect(callbacks.error).toEqual(["Connection aborted"]);
  });

  it("does not fire onError when abort is initiated by close", async () => {
    const callbacks = {
      error: [] as string[],
    };

    globalThis.fetch = vi.fn().mockImplementation((_, init?: RequestInit) => {
      const signal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        if (!signal) {
          return;
        }
        const rejectAbort = () => reject(new DOMException("The operation was aborted", "AbortError"));
        if (signal.aborted) {
          rejectAbort();
          return;
        }
        signal.addEventListener("abort", rejectAbort, { once: true });
      });
    });

    const stream = streamChatResponse("chat-1", "hello", {
      onError: (data) => callbacks.error.push(data),
    });

    stream.close();
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(callbacks.error).toEqual([]);
  });
});

describe("fetchMemoryBackendStatus", () => {
  const originalFetch = globalThis.fetch;

  const mockBackendStatus = {
    currentBackend: "file",
    capabilities: {
      readable: true,
      writable: true,
      supportsAtomicWrite: true,
      hasConflictResolution: false,
      persistent: true,
    },
    availableBackends: ["file", "readonly", "qmd"],
  };

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("fetches memory backend status without projectId", async () => {
    const { fetchMemoryBackendStatus } = await import("./api");

    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: {
        get: (name: string) =>
          name.toLowerCase() === "content-type" ? "application/json" : null,
      },
      json: () => Promise.resolve(mockBackendStatus),
      text: () => Promise.resolve(JSON.stringify(mockBackendStatus)),
    } as unknown as Response);

    const result = await fetchMemoryBackendStatus();

    expect(result).toEqual(mockBackendStatus);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toContain("/api/memory/backend");
  });

  it("fetches memory backend status with projectId", async () => {
    const { fetchMemoryBackendStatus } = await import("./api");

    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: {
        get: (name: string) =>
          name.toLowerCase() === "content-type" ? "application/json" : null,
      },
      json: () => Promise.resolve(mockBackendStatus),
      text: () => Promise.resolve(JSON.stringify(mockBackendStatus)),
    } as unknown as Response);

    const result = await fetchMemoryBackendStatus("proj_abc");

    expect(result).toEqual(mockBackendStatus);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toContain("/api/memory/backend");
    expect(call[0]).toContain("projectId=proj_abc");
  });

  it("throws on error response", async () => {
    const { fetchMemoryBackendStatus } = await import("./api");

    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      headers: {
        get: (name: string) =>
          name.toLowerCase() === "content-type" ? "application/json" : null,
      },
      json: () => Promise.resolve({ error: "Server error" }),
      text: () => Promise.resolve(JSON.stringify({ error: "Server error" })),
    } as unknown as Response);

    await expect(fetchMemoryBackendStatus()).rejects.toThrow("Server error");
  });

  it("handles readonly backend response", async () => {
    const { fetchMemoryBackendStatus } = await import("./api");

    const readonlyStatus = {
      currentBackend: "readonly",
      capabilities: {
        readable: true,
        writable: false,
        supportsAtomicWrite: false,
        hasConflictResolution: false,
        persistent: false,
      },
      availableBackends: ["file", "readonly", "qmd"],
    };

    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: {
        get: (name: string) =>
          name.toLowerCase() === "content-type" ? "application/json" : null,
      },
      json: () => Promise.resolve(readonlyStatus),
      text: () => Promise.resolve(JSON.stringify(readonlyStatus)),
    } as unknown as Response);

    const result = await fetchMemoryBackendStatus();

    expect(result.currentBackend).toBe("readonly");
    expect(result.capabilities.writable).toBe(false);
  });

  it("handles qmd backend response", async () => {
    const { fetchMemoryBackendStatus } = await import("./api");

    const qmdStatus = {
      currentBackend: "qmd",
      capabilities: {
        readable: true,
        writable: true,
        supportsAtomicWrite: false,
        hasConflictResolution: false,
        persistent: true,
      },
      availableBackends: ["file", "readonly", "qmd"],
    };

    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: {
        get: (name: string) =>
          name.toLowerCase() === "content-type" ? "application/json" : null,
      },
      json: () => Promise.resolve(qmdStatus),
      text: () => Promise.resolve(JSON.stringify(qmdStatus)),
    } as unknown as Response);

    const result = await fetchMemoryBackendStatus();

    expect(result.currentBackend).toBe("qmd");
    expect(result.capabilities.writable).toBe(true);
    expect(result.capabilities.supportsAtomicWrite).toBe(false);
  });
});

describe("installQmd", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("calls POST /api/memory/install-qmd without projectId", async () => {
    const { installQmd } = await import("./api");
    const response = {
      success: true,
      qmdAvailable: true,
      qmdInstallCommand: "bun install -g @tobilu/qmd",
    };

    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: {
        get: (name: string) =>
          name.toLowerCase() === "content-type" ? "application/json" : null,
      },
      json: () => Promise.resolve(response),
      text: () => Promise.resolve(JSON.stringify(response)),
    } as unknown as Response);

    const result = await installQmd();

    expect(result).toEqual(response);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toContain("/api/memory/install-qmd");
    expect(call[1]).toMatchObject({ method: "POST" });
  });

  it("includes projectId when installing qmd for a project context", async () => {
    const { installQmd } = await import("./api");
    const response = {
      success: true,
      qmdAvailable: true,
      qmdInstallCommand: "bun install -g @tobilu/qmd",
    };

    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: {
        get: (name: string) =>
          name.toLowerCase() === "content-type" ? "application/json" : null,
      },
      json: () => Promise.resolve(response),
      text: () => Promise.resolve(JSON.stringify(response)),
    } as unknown as Response);

    await installQmd("proj_abc");

    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toContain("/api/memory/install-qmd");
    expect(call[0]).toContain("projectId=proj_abc");
  });
});

describe("compactMemory", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("calls POST /api/memory/compact without projectId", async () => {
    const { compactMemory } = await import("./api");

    const mockResponse = {
      path: ".fusion/memory/DREAMS.md",
      content: "# Compacted Memory\n\nImportant content here.",
    };
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
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

    const result = await compactMemory(".fusion/memory/DREAMS.md");

    expect(result).toEqual(mockResponse);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toContain("/api/memory/compact");
    expect(call[1].method).toBe("POST");
    expect(call[1].body).toBe(JSON.stringify({ path: ".fusion/memory/DREAMS.md" }));
  });

  it("calls POST /api/memory/compact with projectId", async () => {
    const { compactMemory } = await import("./api");

    const mockResponse = {
      path: ".fusion/memory/MEMORY.md",
      content: "# Compacted Memory\n\nImportant content here.",
    };
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
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

    const result = await compactMemory(".fusion/memory/MEMORY.md", "proj_abc");

    expect(result).toEqual(mockResponse);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toContain("/api/memory/compact");
    expect(call[0]).toContain("projectId=proj_abc");
    expect(call[1].method).toBe("POST");
    expect(call[1].body).toBe(JSON.stringify({ path: ".fusion/memory/MEMORY.md" }));
  });

  it("throws on error response", async () => {
    const { compactMemory } = await import("./api");

    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
      headers: {
        get: (name: string) =>
          name.toLowerCase() === "content-type" ? "application/json" : null,
      },
      json: () => Promise.resolve({ error: "AI service temporarily unavailable" }),
      text: () => Promise.resolve(JSON.stringify({ error: "AI service temporarily unavailable" })),
    } as unknown as Response);

    await expect(compactMemory(".fusion/memory/DREAMS.md")).rejects.toThrow("AI service temporarily unavailable");
  });
});

describe("fetchMemoryInsights", () => {
  it("calls GET /api/memory/insights without projectId", async () => {
    const { fetchMemoryInsights } = await import("./api");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: {
        get: (name: string) => name.toLowerCase() === "content-type" ? "application/json" : null,
      },
      json: () => Promise.resolve({ content: "## Patterns\n- Pattern 1", exists: true }),
      text: () => Promise.resolve('{"content":"## Patterns\\n- Pattern 1","exists":true}'),
    } as unknown as Response);

    const result = await fetchMemoryInsights();

    expect(result).toEqual({ content: "## Patterns\n- Pattern 1", exists: true });
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit?];
    expect(call[0]).toContain("/api/memory/insights");
    fetchSpy.mockRestore();
  });

  it("calls GET /api/memory/insights with projectId", async () => {
    const { fetchMemoryInsights } = await import("./api");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: {
        get: (name: string) => name.toLowerCase() === "content-type" ? "application/json" : null,
      },
      json: () => Promise.resolve({ content: null, exists: false }),
      text: () => Promise.resolve('{"content":null,"exists":false}'),
    } as unknown as Response);

    const result = await fetchMemoryInsights("proj_abc");

    expect(result).toEqual({ content: null, exists: false });
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit?];
    expect(call[0]).toContain("/api/memory/insights");
    expect(call[0]).toContain("projectId=proj_abc");
    fetchSpy.mockRestore();
  });
});

describe("saveMemoryInsights", () => {
  it("calls PUT /api/memory/insights without projectId", async () => {
    const { saveMemoryInsights } = await import("./api");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: {
        get: (name: string) => name.toLowerCase() === "content-type" ? "application/json" : null,
      },
      json: () => Promise.resolve({ success: true }),
      text: () => Promise.resolve('{"success":true}'),
    } as unknown as Response);

    const result = await saveMemoryInsights("## Patterns\n- New insight");

    expect(result).toEqual({ success: true });
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit?];
    expect(call[0]).toContain("/api/memory/insights");
    expect(call[1].method).toBe("PUT");
    expect(call[1].body).toBe(JSON.stringify({ content: "## Patterns\n- New insight" }));
    fetchSpy.mockRestore();
  });

  it("calls PUT /api/memory/insights with projectId", async () => {
    const { saveMemoryInsights } = await import("./api");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: {
        get: (name: string) => name.toLowerCase() === "content-type" ? "application/json" : null,
      },
      json: () => Promise.resolve({ success: true }),
      text: () => Promise.resolve('{"success":true}'),
    } as unknown as Response);

    const result = await saveMemoryInsights("## Patterns\n- New insight", "proj_abc");

    expect(result).toEqual({ success: true });
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit?];
    expect(call[0]).toContain("/api/memory/insights");
    expect(call[0]).toContain("projectId=proj_abc");
    expect(call[1].method).toBe("PUT");
    fetchSpy.mockRestore();
  });
});

describe("triggerInsightExtraction", () => {
  it("calls POST /api/memory/extract without projectId", async () => {
    const { triggerInsightExtraction } = await import("./api");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: {
        get: (name: string) => name.toLowerCase() === "content-type" ? "application/json" : null,
      },
      json: () => Promise.resolve({ success: true, summary: "Extracted 3 insights", insightCount: 3, pruned: false }),
      text: () => Promise.resolve('{"success":true,"summary":"Extracted 3 insights","insightCount":3,"pruned":false}'),
    } as unknown as Response);

    const result = await triggerInsightExtraction();

    expect(result).toEqual({ success: true, summary: "Extracted 3 insights", insightCount: 3, pruned: false });
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit?];
    expect(call[0]).toContain("/api/memory/extract");
    expect(call[1].method).toBe("POST");
    fetchSpy.mockRestore();
  });

  it("calls POST /api/memory/extract with projectId", async () => {
    const { triggerInsightExtraction } = await import("./api");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: {
        get: (name: string) => name.toLowerCase() === "content-type" ? "application/json" : null,
      },
      json: () => Promise.resolve({ success: true, summary: "Extracted 5 insights", insightCount: 5, pruned: true }),
      text: () => Promise.resolve('{"success":true,"summary":"Extracted 5 insights","insightCount":5,"pruned":true}'),
    } as unknown as Response);

    const result = await triggerInsightExtraction("proj_abc");

    expect(result).toEqual({ success: true, summary: "Extracted 5 insights", insightCount: 5, pruned: true });
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit?];
    expect(call[0]).toContain("/api/memory/extract");
    expect(call[0]).toContain("projectId=proj_abc");
    expect(call[1].method).toBe("POST");
    fetchSpy.mockRestore();
  });
});

describe("fetchMemoryAudit", () => {
  it("calls GET /api/memory/audit without projectId", async () => {
    const { fetchMemoryAudit } = await import("./api");
    const mockReport = {
      generatedAt: "2024-01-01T00:00:00.000Z",
      workingMemory: { exists: true, size: 100, sectionCount: 2 },
      insightsMemory: { exists: true, size: 50, insightCount: 5, categories: { pattern: 3 } },
      extraction: { runAt: "2024-01-01T00:00:00.000Z", success: true, insightCount: 5, duplicateCount: 0, skippedCount: 0, summary: "Extracted 5 insights" },
      pruning: { applied: false, reason: "No pruning needed", sizeDelta: 0, originalSize: 50, newSize: 50 },
      checks: [],
      health: "healthy" as const,
    };
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: {
        get: (name: string) => name.toLowerCase() === "content-type" ? "application/json" : null,
      },
      json: () => Promise.resolve(mockReport),
      text: () => Promise.resolve(JSON.stringify(mockReport)),
    } as unknown as Response);

    const result = await fetchMemoryAudit();

    expect(result).toEqual(mockReport);
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit?];
    expect(call[0]).toContain("/api/memory/audit");
    fetchSpy.mockRestore();
  });

  it("calls GET /api/memory/audit with projectId", async () => {
    const { fetchMemoryAudit } = await import("./api");
    const mockReport = {
      generatedAt: "2024-01-01T00:00:00.000Z",
      workingMemory: { exists: false, size: 0, sectionCount: 0 },
      insightsMemory: { exists: false, size: 0, insightCount: 0, categories: {} },
      extraction: { runAt: "", success: false, insightCount: 0, duplicateCount: 0, skippedCount: 0, summary: "" },
      pruning: { applied: false, reason: "", sizeDelta: 0, originalSize: 0, newSize: 0 },
      checks: [],
      health: "warning" as const,
    };
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: {
        get: (name: string) => name.toLowerCase() === "content-type" ? "application/json" : null,
      },
      json: () => Promise.resolve(mockReport),
      text: () => Promise.resolve(JSON.stringify(mockReport)),
    } as unknown as Response);

    const result = await fetchMemoryAudit("proj_xyz");

    expect(result).toEqual(mockReport);
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit?];
    expect(call[0]).toContain("/api/memory/audit");
    expect(call[0]).toContain("projectId=proj_xyz");
    fetchSpy.mockRestore();
  });
});

describe("fetchMemoryStats", () => {
  it("calls GET /api/memory/stats without projectId", async () => {
    const { fetchMemoryStats } = await import("./api");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: {
        get: (name: string) => name.toLowerCase() === "content-type" ? "application/json" : null,
      },
      json: () => Promise.resolve({ workingMemorySize: 150, insightsSize: 50, insightsExists: true }),
      text: () => Promise.resolve('{"workingMemorySize":150,"insightsSize":50,"insightsExists":true}'),
    } as unknown as Response);

    const result = await fetchMemoryStats();

    expect(result).toEqual({ workingMemorySize: 150, insightsSize: 50, insightsExists: true });
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit?];
    expect(call[0]).toContain("/api/memory/stats");
    fetchSpy.mockRestore();
  });

  it("calls GET /api/memory/stats with projectId", async () => {
    const { fetchMemoryStats } = await import("./api");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: {
        get: (name: string) => name.toLowerCase() === "content-type" ? "application/json" : null,
      },
      json: () => Promise.resolve({ workingMemorySize: 200, insightsSize: 0, insightsExists: false }),
      text: () => Promise.resolve('{"workingMemorySize":200,"insightsSize":0,"insightsExists":false}'),
    } as unknown as Response);

    const result = await fetchMemoryStats("proj_abc");

    expect(result).toEqual({ workingMemorySize: 200, insightsSize: 0, insightsExists: false });
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit?];
    expect(call[0]).toContain("/api/memory/stats");
    expect(call[0]).toContain("projectId=proj_abc");
    fetchSpy.mockRestore();
  });
});

describe("Roadmap API wrappers", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: {
        get: (name: string) =>
          name.toLowerCase() === "content-type" ? "application/json" : null,
      },
      json: () => Promise.resolve([]),
      text: () => Promise.resolve("[]"),
    } as unknown as Response);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  const mockRoadmap = {
    id: "RM-001",
    title: "Q2 Roadmap",
    description: "Q2 product roadmap",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  const mockRoadmapHierarchy = {
    ...mockRoadmap,
    milestones: [
      {
        id: "RMS-001",
        roadmapId: "RM-001",
        title: "Milestone 1",
        description: "First milestone",
        orderIndex: 0,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        features: [
          {
            id: "RF-001",
            milestoneId: "RMS-001",
            title: "Feature 1",
            description: "First feature",
            orderIndex: 0,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      },
    ],
  };

  it("fetchRoadmaps sends GET and propagates projectId", async () => {
    const { fetchRoadmaps } = await import("./api");

    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: {
        get: (name: string) =>
          name.toLowerCase() === "content-type" ? "application/json" : null,
      },
      json: () => Promise.resolve([mockRoadmap]),
      text: () => Promise.resolve(JSON.stringify([mockRoadmap])),
    } as unknown as Response);

    const result = await fetchRoadmaps("proj_abc");

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("RM-001");
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain("/api/roadmaps");
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain("projectId=proj_abc");
  });

  it("createRoadmap sends POST with input payload", async () => {
    const { createRoadmap } = await import("./api");

    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: {
        get: (name: string) =>
          name.toLowerCase() === "content-type" ? "application/json" : null,
      },
      json: () => Promise.resolve(mockRoadmap),
      text: () => Promise.resolve(JSON.stringify(mockRoadmap)),
    } as unknown as Response);

    const result = await createRoadmap({ title: "Q2 Roadmap", description: "Q2 product roadmap" }, "proj_abc");

    expect(result.id).toBe("RM-001");
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain("/api/roadmaps");
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain("projectId=proj_abc");
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].method).toBe("POST");
    const body = JSON.parse((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body.title).toBe("Q2 Roadmap");
  });

  it("fetchRoadmap returns roadmap with hierarchy", async () => {
    const { fetchRoadmap } = await import("./api");

    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: {
        get: (name: string) =>
          name.toLowerCase() === "content-type" ? "application/json" : null,
      },
      json: () => Promise.resolve(mockRoadmapHierarchy),
      text: () => Promise.resolve(JSON.stringify(mockRoadmapHierarchy)),
    } as unknown as Response);

    const result = await fetchRoadmap("RM-001");

    expect(result.id).toBe("RM-001");
    expect(result.milestones).toHaveLength(1);
    expect(result.milestones[0].features).toHaveLength(1);
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain("/api/roadmaps/RM-001");
  });

  it("updateRoadmap sends PATCH with updates", async () => {
    const { updateRoadmap } = await import("./api");

    const updatedRoadmap = { ...mockRoadmap, title: "Updated Roadmap" };

    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: {
        get: (name: string) =>
          name.toLowerCase() === "content-type" ? "application/json" : null,
      },
      json: () => Promise.resolve(updatedRoadmap),
      text: () => Promise.resolve(JSON.stringify(updatedRoadmap)),
    } as unknown as Response);

    const result = await updateRoadmap("RM-001", { title: "Updated Roadmap" });

    expect(result.title).toBe("Updated Roadmap");
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain("/api/roadmaps/RM-001");
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].method).toBe("PATCH");
  });

  it("deleteRoadmap sends DELETE and returns void", async () => {
    const { deleteRoadmap } = await import("./api");

    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 204,
      statusText: "No Content",
      headers: {
        get: (name: string) =>
          name.toLowerCase() === "content-type" ? null : null,
      },
      json: () => Promise.resolve(undefined),
      text: () => Promise.resolve(""),
    } as unknown as Response);

    const result = await deleteRoadmap("RM-001");

    expect(result).toBeUndefined();
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain("/api/roadmaps/RM-001");
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].method).toBe("DELETE");
  });

  it("createRoadmapMilestone sends POST with milestone input", async () => {
    const { createRoadmapMilestone } = await import("./api");

    const mockMilestone = {
      id: "RMS-001",
      roadmapId: "RM-001",
      title: "Milestone 1",
      orderIndex: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: {
        get: (name: string) =>
          name.toLowerCase() === "content-type" ? "application/json" : null,
      },
      json: () => Promise.resolve(mockMilestone),
      text: () => Promise.resolve(JSON.stringify(mockMilestone)),
    } as unknown as Response);

    const result = await createRoadmapMilestone("RM-001", { title: "Milestone 1" });

    expect(result.id).toBe("RMS-001");
    expect(result.roadmapId).toBe("RM-001");
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain("/api/roadmaps/RM-001/milestones");
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].method).toBe("POST");
  });

  it("updateRoadmapMilestone sends PATCH", async () => {
    const { updateRoadmapMilestone } = await import("./api");

    const updatedMilestone = {
      id: "RMS-001",
      roadmapId: "RM-001",
      title: "Updated Milestone",
      orderIndex: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: {
        get: (name: string) =>
          name.toLowerCase() === "content-type" ? "application/json" : null,
      },
      json: () => Promise.resolve(updatedMilestone),
      text: () => Promise.resolve(JSON.stringify(updatedMilestone)),
    } as unknown as Response);

    const result = await updateRoadmapMilestone("RMS-001", { title: "Updated Milestone" });

    expect(result.title).toBe("Updated Milestone");
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain("/api/roadmaps/milestones/RMS-001");
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].method).toBe("PATCH");
  });

  it("deleteRoadmapMilestone sends DELETE", async () => {
    const { deleteRoadmapMilestone } = await import("./api");

    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 204,
      statusText: "No Content",
      headers: {
        get: (name: string) =>
          name.toLowerCase() === "content-type" ? null : null,
      },
      json: () => Promise.resolve(undefined),
      text: () => Promise.resolve(""),
    } as unknown as Response);

    const result = await deleteRoadmapMilestone("RMS-001");

    expect(result).toBeUndefined();
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain("/api/roadmaps/milestones/RMS-001");
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].method).toBe("DELETE");
  });

  it("createRoadmapFeature sends POST with feature input", async () => {
    const { createRoadmapFeature } = await import("./api");

    const mockFeature = {
      id: "RF-001",
      milestoneId: "RMS-001",
      title: "Feature 1",
      orderIndex: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: {
        get: (name: string) =>
          name.toLowerCase() === "content-type" ? "application/json" : null,
      },
      json: () => Promise.resolve(mockFeature),
      text: () => Promise.resolve(JSON.stringify(mockFeature)),
    } as unknown as Response);

    const result = await createRoadmapFeature("RMS-001", { title: "Feature 1" });

    expect(result.id).toBe("RF-001");
    expect(result.milestoneId).toBe("RMS-001");
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain("/api/roadmaps/milestones/RMS-001/features");
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].method).toBe("POST");
  });

  it("updateRoadmapFeature sends PATCH", async () => {
    const { updateRoadmapFeature } = await import("./api");

    const updatedFeature = {
      id: "RF-001",
      milestoneId: "RMS-001",
      title: "Updated Feature",
      orderIndex: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: {
        get: (name: string) =>
          name.toLowerCase() === "content-type" ? "application/json" : null,
      },
      json: () => Promise.resolve(updatedFeature),
      text: () => Promise.resolve(JSON.stringify(updatedFeature)),
    } as unknown as Response);

    const result = await updateRoadmapFeature("RF-001", { title: "Updated Feature" });

    expect(result.title).toBe("Updated Feature");
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain("/api/roadmaps/features/RF-001");
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].method).toBe("PATCH");
  });

  it("deleteRoadmapFeature sends DELETE", async () => {
    const { deleteRoadmapFeature } = await import("./api");

    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 204,
      statusText: "No Content",
      headers: {
        get: (name: string) =>
          name.toLowerCase() === "content-type" ? null : null,
      },
      json: () => Promise.resolve(undefined),
      text: () => Promise.resolve(""),
    } as unknown as Response);

    const result = await deleteRoadmapFeature("RF-001");

    expect(result).toBeUndefined();
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain("/api/roadmaps/features/RF-001");
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].method).toBe("DELETE");
  });

  it("fetchRoadmapFeatures returns features for a milestone", async () => {
    const { fetchRoadmapFeatures } = await import("./api");

    const mockFeatures = [
      {
        id: "RF-001",
        milestoneId: "RMS-001",
        title: "Feature 1",
        orderIndex: 0,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "RF-002",
        milestoneId: "RMS-001",
        title: "Feature 2",
        orderIndex: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ];

    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: {
        get: (name: string) =>
          name.toLowerCase() === "content-type" ? "application/json" : null,
      },
      json: () => Promise.resolve(mockFeatures),
      text: () => Promise.resolve(JSON.stringify(mockFeatures)),
    } as unknown as Response);

    const result = await fetchRoadmapFeatures("RMS-001");

    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("RF-001");
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain("/api/roadmaps/milestones/RMS-001/features");
  });
});

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
      const { fetchSettingsByScope } = await import("./api");

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
        headers: { "Content-Type": "application/json" },
      }));
      // GET is the default method, so method should not be specified
      const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(call[1].method).toBeUndefined();
    });

    it("calls /api/settings/scopes?projectId=proj_123 when projectId is provided", async () => {
      const { fetchSettingsByScope } = await import("./api");

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
        headers: { "Content-Type": "application/json" },
      }));
      // GET is the default method
      const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(call[1].method).toBeUndefined();
    });

    it("returns the { global, project } shape", async () => {
      const { fetchSettingsByScope } = await import("./api");
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
      const { fetchSettingsByScope } = await import("./api");

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
      const { updateGlobalSettings } = await import("./api");

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
      const { updateGlobalSettings } = await import("./api");

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
      const { updateGlobalSettings } = await import("./api");

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
      const { updateSettings } = await import("./api");

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
      const { updateSettings } = await import("./api");

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
      const { fetchGlobalSettings } = await import("./api");

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
        headers: { "Content-Type": "application/json" },
      }));
      // GET is the default method
      const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(call[1].method).toBeUndefined();
    });

    it("returns GlobalSettings with known keys like themeMode", async () => {
      const { fetchGlobalSettings } = await import("./api");
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
      const { fetchGlobalSettings } = await import("./api");

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

  describe("roadmap reorder APIs", () => {
    it("reorderRoadmapMilestones sends POST with orderedMilestoneIds", async () => {
      const { reorderRoadmapMilestones } = await import("./api");

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 204,
        statusText: "No Content",
        headers: {
          get: () => null,
        },
        text: () => Promise.resolve(""),
      } as unknown as Response);

      await reorderRoadmapMilestones("RM-001", ["RMS-002", "RMS-001", "RMS-003"]);

      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      const [url, options] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toBe("/api/roadmaps/RM-001/milestones/reorder");
      expect(options.method).toBe("POST");
      expect(JSON.parse(options.body as string)).toEqual({
        orderedMilestoneIds: ["RMS-002", "RMS-001", "RMS-003"],
      });
    });

    it("reorderRoadmapMilestones includes projectId when provided", async () => {
      const { reorderRoadmapMilestones } = await import("./api");

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 204,
        statusText: "No Content",
        headers: {
          get: () => null,
        },
        text: () => Promise.resolve(""),
      } as unknown as Response);

      await reorderRoadmapMilestones("RM-001", ["RMS-001", "RMS-002"], "proj_abc");

      const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toBe("/api/roadmaps/RM-001/milestones/reorder?projectId=proj_abc");
    });

    it("reorderRoadmapFeatures sends POST with orderedFeatureIds", async () => {
      const { reorderRoadmapFeatures } = await import("./api");

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 204,
        statusText: "No Content",
        headers: {
          get: () => null,
        },
        text: () => Promise.resolve(""),
      } as unknown as Response);

      await reorderRoadmapFeatures("RMS-001", ["RF-002", "RF-001"]);

      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      const [url, options] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toBe("/api/roadmaps/milestones/RMS-001/features/reorder");
      expect(options.method).toBe("POST");
      expect(JSON.parse(options.body as string)).toEqual({
        orderedFeatureIds: ["RF-002", "RF-001"],
      });
    });

    it("moveRoadmapFeature sends POST with targetMilestoneId and targetIndex", async () => {
      const { moveRoadmapFeature } = await import("./api");

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 204,
        statusText: "No Content",
        headers: {
          get: () => null,
        },
        text: () => Promise.resolve(""),
      } as unknown as Response);

      await moveRoadmapFeature("RF-001", "RMS-002", 2);

      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      const [url, options] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toBe("/api/roadmaps/features/RF-001/move");
      expect(options.method).toBe("POST");
      expect(JSON.parse(options.body as string)).toEqual({
        targetMilestoneId: "RMS-002",
        targetIndex: 2,
      });
    });

    it("moveRoadmapFeature includes projectId when provided", async () => {
      const { moveRoadmapFeature } = await import("./api");

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 204,
        statusText: "No Content",
        headers: {
          get: () => null,
        },
        text: () => Promise.resolve(""),
      } as unknown as Response);

      await moveRoadmapFeature("RF-001", "RMS-002", 0, "proj_xyz");

      const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toBe("/api/roadmaps/features/RF-001/move?projectId=proj_xyz");
    });

    it("generateFeatureSuggestions sends POST with milestone ID", async () => {
      const { generateFeatureSuggestions } = await import("./api");

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: {
          get: (name: string) =>
            name.toLowerCase() === "content-type" ? "application/json" : null,
        },
        json: () => Promise.resolve({ suggestions: [{ title: "Feature 1" }, { title: "Feature 2" }] }),
        text: () => Promise.resolve(JSON.stringify({ suggestions: [{ title: "Feature 1" }, { title: "Feature 2" }] })),
      } as unknown as Response);

      const result = await generateFeatureSuggestions("RMS-001");

      expect(result.suggestions).toHaveLength(2);
      expect(result.suggestions[0].title).toBe("Feature 1");
      const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toContain("/api/roadmaps/milestones/RMS-001/suggestions/features");
    });

    it("generateFeatureSuggestions includes input parameters in body", async () => {
      const { generateFeatureSuggestions } = await import("./api");

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: {
          get: (name: string) =>
            name.toLowerCase() === "content-type" ? "application/json" : null,
        },
        json: () => Promise.resolve({ suggestions: [] }),
        text: () => Promise.resolve(JSON.stringify({ suggestions: [] })),
      } as unknown as Response);

      await generateFeatureSuggestions("RMS-001", { prompt: "Focus on auth", count: 3 });

      const [, options] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      const body = JSON.parse((options as RequestInit).body as string);
      expect(body.prompt).toBe("Focus on auth");
      expect(body.count).toBe(3);
    });

    it("generateFeatureSuggestions includes projectId when provided", async () => {
      const { generateFeatureSuggestions } = await import("./api");

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: {
          get: (name: string) =>
            name.toLowerCase() === "content-type" ? "application/json" : null,
        },
        json: () => Promise.resolve({ suggestions: [] }),
        text: () => Promise.resolve(JSON.stringify({ suggestions: [] })),
      } as unknown as Response);

      await generateFeatureSuggestions("RMS-001", undefined, "proj_abc");

      const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toContain("/api/roadmaps/milestones/RMS-001/suggestions/features");
      expect(url).toContain("projectId=proj_abc");
    });
  });

  describe("roadmap export/handoff APIs", () => {
    it("exportRoadmap sends GET to export endpoint", async () => {
      const { exportRoadmap } = await import("./api");
      const exportData = {
        roadmap: { id: "RM-001", title: "Test", createdAt: "2024-01-01", updatedAt: "2024-01-01" },
        milestones: [],
        features: [],
      };

      vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: {
          get: (name: string) =>
            name.toLowerCase() === "content-type" ? "application/json" : null,
        },
        json: () => Promise.resolve(exportData),
        text: () => Promise.resolve(JSON.stringify(exportData)),
      } as unknown as Response);

      const result = await exportRoadmap("RM-001");

      expect(result.roadmap.id).toBe("RM-001");
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toContain("/api/roadmaps/RM-001/export");
    });

    it("exportRoadmap includes projectId when provided", async () => {
      const { exportRoadmap } = await import("./api");
      const exportData = { roadmap: { id: "RM-001", title: "Test", createdAt: "2024-01-01", updatedAt: "2024-01-01" }, milestones: [], features: [] };

      vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: {
          get: (name: string) =>
            name.toLowerCase() === "content-type" ? "application/json" : null,
        },
        json: () => Promise.resolve(exportData),
        text: () => Promise.resolve(JSON.stringify(exportData)),
      } as unknown as Response);

      await exportRoadmap("RM-001", "proj_abc");

      const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toContain("/api/roadmaps/RM-001/export");
      expect(url).toContain("projectId=proj_abc");
    });

    it("getRoadmapMissionHandoff sends GET to mission handoff endpoint", async () => {
      const { getRoadmapMissionHandoff } = await import("./api");
      const handoffData = {
        sourceRoadmapId: "RM-001",
        title: "Test Roadmap",
        milestones: [],
      };

      vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: {
          get: (name: string) =>
            name.toLowerCase() === "content-type" ? "application/json" : null,
        },
        json: () => Promise.resolve(handoffData),
        text: () => Promise.resolve(JSON.stringify(handoffData)),
      } as unknown as Response);

      const result = await getRoadmapMissionHandoff("RM-001");

      expect(result.sourceRoadmapId).toBe("RM-001");
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toContain("/api/roadmaps/RM-001/handoff/mission");
    });

    it("getRoadmapFeatureHandoff sends GET to feature handoff endpoint", async () => {
      const { getRoadmapFeatureHandoff } = await import("./api");
      const handoffData = {
        source: {
          roadmapId: "RM-001",
          milestoneId: "RMS-001",
          featureId: "RF-001",
          roadmapTitle: "Test",
          milestoneTitle: "Phase 1",
          milestoneOrderIndex: 0,
          featureOrderIndex: 0,
        },
        title: "Feature 1",
      };

      vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: {
          get: (name: string) =>
            name.toLowerCase() === "content-type" ? "application/json" : null,
        },
        json: () => Promise.resolve(handoffData),
        text: () => Promise.resolve(JSON.stringify(handoffData)),
      } as unknown as Response);

      const result = await getRoadmapFeatureHandoff("RM-001", "RMS-001", "RF-001");

      expect(result.source.featureId).toBe("RF-001");
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toContain("/api/roadmaps/RM-001/milestones/RMS-001/features/RF-001/handoff/task");
    });

    it("getRoadmapFeatureHandoff includes projectId when provided", async () => {
      const { getRoadmapFeatureHandoff } = await import("./api");
      const handoffData = {
        source: { roadmapId: "RM-001", milestoneId: "RMS-001", featureId: "RF-001", roadmapTitle: "T", milestoneTitle: "M", milestoneOrderIndex: 0, featureOrderIndex: 0 },
        title: "F",
      };

      vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: {
          get: (name: string) =>
            name.toLowerCase() === "content-type" ? "application/json" : null,
        },
        json: () => Promise.resolve(handoffData),
        text: () => Promise.resolve(JSON.stringify(handoffData)),
      } as unknown as Response);

      await getRoadmapFeatureHandoff("RM-001", "RMS-001", "RF-001", "proj_xyz");

      const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toContain("/api/roadmaps/RM-001/milestones/RMS-001/features/RF-001/handoff/task");
      expect(url).toContain("projectId=proj_xyz");
    });
  });
});

// ── Automation / Scheduling Scope Tests ─────────────────────────────────────────

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

describe("Automation API scope forwarding", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("fetchAutomations sends GET to /automations without scope by default", async () => {
    const { fetchAutomations } = await import("./api");
    globalThis.fetch = vi.fn().mockReturnValue(mockSchedulingFetchResponse(true, []));

    await fetchAutomations();

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("/api/automations");
  });

  it("fetchAutomations includes scope=global when specified", async () => {
    const { fetchAutomations } = await import("./api");
    globalThis.fetch = vi.fn().mockReturnValue(mockSchedulingFetchResponse(true, []));

    await fetchAutomations({ scope: "global" });

    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain("/api/automations?scope=global");
  });

  it("fetchAutomations includes scope=project and projectId when project-scoped", async () => {
    const { fetchAutomations } = await import("./api");
    globalThis.fetch = vi.fn().mockReturnValue(mockSchedulingFetchResponse(true, []));

    await fetchAutomations({ scope: "project", projectId: "proj-123" });

    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain("/api/automations");
    expect(url).toContain("scope=project");
    expect(url).toContain("projectId=proj-123");
  });

  it("createAutomation forwards scope context in query params", async () => {
    const { createAutomation } = await import("./api");
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
    const { createAutomation } = await import("./api");
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
    const { runAutomation } = await import("./api");
    globalThis.fetch = vi.fn().mockReturnValue(mockSchedulingFetchResponse(true, { schedule: {}, result: { success: true } }));

    await runAutomation("sched-001", { scope: "project", projectId: "proj-123" });

    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain("/api/automations/sched-001/run?scope=project&projectId=proj-123");
  });

  it("toggleAutomation forwards scope context", async () => {
    const { toggleAutomation } = await import("./api");
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
    const { fetchRoutines } = await import("./api");
    globalThis.fetch = vi.fn().mockReturnValue(mockSchedulingFetchResponse(true, []));

    await fetchRoutines();

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("/api/routines");
  });

  it("fetchRoutines includes scope=global when specified", async () => {
    const { fetchRoutines } = await import("./api");
    globalThis.fetch = vi.fn().mockReturnValue(mockSchedulingFetchResponse(true, []));

    await fetchRoutines({ scope: "global" });

    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain("/api/routines?scope=global");
  });

  it("fetchRoutines includes scope=project and projectId when project-scoped", async () => {
    const { fetchRoutines } = await import("./api");
    globalThis.fetch = vi.fn().mockReturnValue(mockSchedulingFetchResponse(true, []));

    await fetchRoutines({ scope: "project", projectId: "proj-456" });

    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain("/api/routines");
    expect(url).toContain("scope=project");
    expect(url).toContain("projectId=proj-456");
  });

  it("createRoutine forwards scope context in query params", async () => {
    const { createRoutine } = await import("./api");
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
    const { updateRoutine } = await import("./api");
    globalThis.fetch = vi.fn().mockReturnValue(mockSchedulingFetchResponse(true, { id: "routine-001", name: "Updated" }));

    await updateRoutine("routine-001", { name: "Updated" }, { scope: "project", projectId: "proj-456" });

    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain("/api/routines/routine-001?scope=project&projectId=proj-456");
  });

  it("deleteRoutine forwards scope context", async () => {
    const { deleteRoutine } = await import("./api");
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
    const { runRoutine } = await import("./api");
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
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/pi-settings", expect.objectContaining({
      headers: expect.objectContaining({ "Content-Type": "application/json" }),
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
