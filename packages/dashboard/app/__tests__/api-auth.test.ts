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
  reviseTaskReviewItems,
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
      body: JSON.stringify({ provider: "anthropic", origin: window.location.origin }),
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


describe("reviseTaskReviewItems", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("posts selected review items with review tab marker", async () => {
    const responseTask: Task = { ...FAKE_DETAIL, id: "FN-001" };
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, {
      task: responseTask,
      reviewState: { source: "pull-request", items: [], addressing: [] },
    }));

    await reviseTaskReviewItems("FN-001", [{ id: "ri-1", source: "pr-review", summary: "Fix x", body: "Fix x" }]);

    expect(globalThis.fetch).toHaveBeenCalledWith("/api/tasks/FN-001/review/address", {
      headers: { "Content-Type": "application/json" },
      method: "POST",
      body: JSON.stringify({
        selectedItems: [{ id: "ri-1", source: "pr-review", summary: "Fix x", body: "Fix x" }],
        tab: "review",
      }),
    });
  });
});


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

    const { fetchAgentChildren } = await import("../api");
    const result = await fetchAgentChildren("agent-001");

    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("child-1");
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/agents/agent-001/children", {
      headers: { "Content-Type": "application/json" },
    });
  });

  it("passes projectId as query param", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, []));

    const { fetchAgentChildren } = await import("../api");
    await fetchAgentChildren("agent-001", "proj_123");

    expect(globalThis.fetch).toHaveBeenCalledWith("/api/agents/agent-001/children?projectId=proj_123", {
      headers: { "Content-Type": "application/json" },
    });
  });

  it("returns empty array for 404 (agent not found)", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(
      mockFetchResponse(false, { error: "Agent not found" }, 404),
    );

    const { fetchAgentChildren } = await import("../api");
    const result = await fetchAgentChildren("agent-999");

    expect(result).toEqual([]);
  });

  it("throws on non-404 errors", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(
      mockFetchResponse(false, { error: "Internal server error" }, 500),
    );

    const { fetchAgentChildren } = await import("../api");
    await expect(fetchAgentChildren("agent-001")).rejects.toThrow("Internal server error");
  });
});

