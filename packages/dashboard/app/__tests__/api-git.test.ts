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
    it("sends POST to pull with default rebase false", async () => {
      const result = { success: true, message: "Pulled 2 commits" };
      globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, result));

      const response = await pullBranch();

      expect(response).toEqual(result);
      expect(globalThis.fetch).toHaveBeenCalledWith("/api/git/pull", {
        headers: { "Content-Type": "application/json" },
        method: "POST",
        body: JSON.stringify({ rebase: false }),
      });
    });

    it("sends rebase true when requested", async () => {
      const result = { success: true, message: "Rebased and pulled" };
      globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, result));

      await pullBranch({ rebase: true });

      expect(globalThis.fetch).toHaveBeenCalledWith("/api/git/pull", {
        headers: { "Content-Type": "application/json" },
        method: "POST",
        body: JSON.stringify({ rebase: true }),
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

    it("sends removeLineageReferences=true when archive lineage unlink is requested", async () => {
      const archivedTask: Task = { ...FAKE_DETAIL, column: "archived" };
      globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, archivedTask));

      await archiveTask("FN-001", undefined, { removeLineageReferences: true });

      expect(globalThis.fetch).toHaveBeenCalledWith("/api/tasks/FN-001/archive?removeLineageReferences=true", {
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

    it("sends removeDependencyReferences=true when dependency rewrite is requested", async () => {
      const deletedTask: Task = { ...FAKE_DETAIL, column: "done" };
      globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, deletedTask));

      await deleteTask("FN-001", undefined, { removeDependencyReferences: true });

      expect(globalThis.fetch).toHaveBeenCalledWith("/api/tasks/FN-001?removeDependencyReferences=true", {
        headers: { "Content-Type": "application/json" },
        method: "DELETE",
      });
    });

    it("sends githubIssueAction when requested", async () => {
      const deletedTask: Task = { ...FAKE_DETAIL, column: "done" };
      globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, deletedTask));

      await deleteTask("FN-001", undefined, { githubIssueAction: "delete" });

      expect(globalThis.fetch).toHaveBeenCalledWith("/api/tasks/FN-001?githubIssueAction=delete", {
        headers: { "Content-Type": "application/json" },
        method: "DELETE",
      });
    });

    it("sends removeLineageReferences=true when lineage unlink is requested", async () => {
      const deletedTask: Task = { ...FAKE_DETAIL, column: "done" };
      globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, deletedTask));

      await deleteTask("FN-001", undefined, { removeLineageReferences: true });

      expect(globalThis.fetch).toHaveBeenCalledWith("/api/tasks/FN-001?removeLineageReferences=true", {
        headers: { "Content-Type": "application/json" },
        method: "DELETE",
      });
    });

    it("throws ApiRequestError on error and preserves details payload", async () => {
      globalThis.fetch = vi.fn().mockReturnValue(
        mockFetchResponse(
          false,
          {
            error: "Cannot delete task FN-001: still referenced as a dependency by FN-002.",
            details: {
              code: "TASK_HAS_DEPENDENTS",
              dependentIds: ["FN-002"],
            },
          },
          409,
        ),
      );

      await expect(deleteTask("FN-001")).rejects.toBeInstanceOf(ApiRequestError);
      await expect(deleteTask("FN-001")).rejects.toMatchObject({
        message: "Cannot delete task FN-001: still referenced as a dependency by FN-002.",
        status: 409,
        details: {
          code: "TASK_HAS_DEPENDENTS",
          dependentIds: ["FN-002"],
        },
      });
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
      const mergeResult = {
        task: { id: "FN-001", description: "", column: "done", dependencies: [], steps: [], currentStep: 0, log: [], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
        branch: "fn/FN-001",
        merged: true,
        worktreeRemoved: true,
        branchDeleted: true,
      } as unknown as MergeResult;
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
        mockFetchResponse(false, { error: "Rate limit exceeded. Maximum 1000 planning sessions per hour." }, 429)
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

/** Mock helper for HTML error responses (e.g., 404 page) */

