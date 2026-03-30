import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchTaskDetail, updateTask, archiveTask, unarchiveTask, fetchAuthStatus, loginProvider, logoutProvider, fetchModels, addSteeringComment, fetchGitRemotes } from "./api";
import type { Task, TaskDetail } from "@kb/core";

const FAKE_DETAIL: TaskDetail = {
  id: "KB-001",
  description: "Test",
  column: "in-progress",
  dependencies: [],
  steps: [],
  currentStep: 0,
  log: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  prompt: "# KB-001",
};

function mockFetchResponse(ok: boolean, body: unknown, status = ok ? 200 : 500) {
  return Promise.resolve({
    ok,
    status,
    json: () => Promise.resolve(body),
  } as Response);
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

    const result = await fetchTaskDetail("KB-001");

    expect(result.id).toBe("KB-001");
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("retries once on failure then succeeds", async () => {
    globalThis.fetch = vi.fn()
      .mockReturnValueOnce(mockFetchResponse(false, { error: "Transient error" }))
      .mockReturnValueOnce(mockFetchResponse(true, FAKE_DETAIL));

    const result = await fetchTaskDetail("KB-001");

    expect(result.id).toBe("KB-001");
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it("throws after retry exhaustion", async () => {
    globalThis.fetch = vi.fn()
      .mockReturnValue(mockFetchResponse(false, { error: "Server error" }));

    await expect(fetchTaskDetail("KB-001")).rejects.toThrow("Server error");
    expect(globalThis.fetch).toHaveBeenCalledTimes(2); // initial + 1 retry
  });
});

describe("updateTask", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const FAKE_TASK: Task = {
    id: "KB-001",
    description: "Test",
    column: "in-progress",
    dependencies: ["KB-002"],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  it("sends PATCH with dependencies and returns updated task", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, FAKE_TASK));

    const result = await updateTask("KB-001", { dependencies: ["KB-002"] });

    expect(result.dependencies).toEqual(["KB-002"]);
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/tasks/KB-001", {
      headers: { "Content-Type": "application/json" },
      method: "PATCH",
      body: JSON.stringify({ dependencies: ["KB-002"] }),
    });
  });

  it("throws on error response", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(false, { error: "Not found" }));

    await expect(updateTask("KB-001", { dependencies: [] })).rejects.toThrow("Not found");
  });
});

describe("fetchModels", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns available models", async () => {
    const models = [
      { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", reasoning: true, contextWindow: 200000 },
    ];
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, models));

    const result = await fetchModels();

    expect(result).toEqual(models);
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/models", {
      headers: { "Content-Type": "application/json" },
    });
  });

  it("throws on error", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(false, { error: "Server error" }));

    await expect(fetchModels()).rejects.toThrow("Server error");
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
    id: "KB-001",
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

    const result = await addSteeringComment("KB-001", "Please handle the edge case");

    expect(result.id).toBe("KB-001");
    expect(result.steeringComments).toHaveLength(1);
    expect(result.steeringComments![0].text).toBe("Please handle the edge case");
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/tasks/KB-001/steer", {
      headers: { "Content-Type": "application/json" },
      method: "POST",
      body: JSON.stringify({ text: "Please handle the edge case" }),
    });
  });

  it("throws on error response", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(
      mockFetchResponse(false, { error: "Task not found" })
    );

    await expect(addSteeringComment("KB-001", "Test comment")).rejects.toThrow("Task not found");
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

    const result = await approvePlan("KB-001");

    expect(result.column).toBe("todo");
    expect(result.status).toBeUndefined();
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/tasks/KB-001/approve-plan", {
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
  });

  it("throws on error response", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(
      mockFetchResponse(false, { error: "Task must be in 'triage' column to approve plan" }, 400)
    );

    await expect(approvePlan("KB-001")).rejects.toThrow("triage");
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

    const result = await rejectPlan("KB-001");

    expect(result.column).toBe("triage");
    expect(result.status).toBeUndefined();
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/tasks/KB-001/reject-plan", {
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
  });

  it("throws on error response", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(
      mockFetchResponse(false, { error: "Task must have status 'awaiting-approval' to reject plan" }, 400)
    );

    await expect(rejectPlan("KB-001")).rejects.toThrow("awaiting-approval");
  });
});

// --- Git Management API tests ---

import {
  fetchGitStatus,
  fetchGitCommits,
  fetchCommitDiff,
  fetchGitBranches,
  fetchGitWorktrees,
  createBranch,
  checkoutBranch,
  deleteBranch,
  fetchRemote,
  pullBranch,
  pushBranch,
} from "./api";

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

      const response = await archiveTask("KB-001");

      expect(response.column).toBe("archived");
      expect(globalThis.fetch).toHaveBeenCalledWith("/api/tasks/KB-001/archive", {
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
    });

    it("throws on error", async () => {
      globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(false, { error: "Task not in done" }, 400));

      await expect(archiveTask("KB-001")).rejects.toThrow("Task not in done");
    });
  });

  describe("unarchiveTask", () => {
    it("sends POST to unarchive endpoint", async () => {
      const unarchivedTask: Task = { ...FAKE_DETAIL, column: "done" };
      globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, unarchivedTask));

      const response = await unarchiveTask("KB-001");

      expect(response.column).toBe("done");
      expect(globalThis.fetch).toHaveBeenCalledWith("/api/tasks/KB-001/unarchive", {
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
    });

    it("throws on error", async () => {
      globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(false, { error: "Task not in archived" }, 400));

      await expect(unarchiveTask("KB-001")).rejects.toThrow("Task not in archived");
    });
  });
});
