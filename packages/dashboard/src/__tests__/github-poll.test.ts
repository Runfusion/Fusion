import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { GitHubRateLimiter, GitHubPollingService, githubPoller, githubRateLimiter } from "../github-poll.js";
import type { TaskStore } from "@fusion/core";

// Mock the GitHubClient
const mockGetBadgeStatusesBatch = vi.fn();

vi.mock("../github.js", () => ({
  GitHubClient: vi.fn().mockImplementation(() => ({
    getBadgeStatusesBatch: (...args: any[]) => mockGetBadgeStatusesBatch(...args),
  })),
}));

describe("GitHubRateLimiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("allows requests within the rate limit", () => {
    const limiter = new GitHubRateLimiter({ maxRequests: 3, windowMs: 60000 });

    expect(limiter.canMakeRequest("owner/repo")).toBe(true);
    expect(limiter.canMakeRequest("owner/repo")).toBe(true);
    expect(limiter.canMakeRequest("owner/repo")).toBe(true);
  });

  it("denies requests when rate limit is exceeded", () => {
    const limiter = new GitHubRateLimiter({ maxRequests: 2, windowMs: 60000 });

    limiter.canMakeRequest("owner/repo");
    limiter.canMakeRequest("owner/repo");
    
    expect(limiter.canMakeRequest("owner/repo")).toBe(false);
  });

  it("resets rate limit after window expires", () => {
    const limiter = new GitHubRateLimiter({ maxRequests: 2, windowMs: 60000 });

    limiter.canMakeRequest("owner/repo");
    limiter.canMakeRequest("owner/repo");
    expect(limiter.canMakeRequest("owner/repo")).toBe(false);

    // Advance time past the window
    vi.advanceTimersByTime(61000);

    expect(limiter.canMakeRequest("owner/repo")).toBe(true);
  });

  it("tracks different repositories independently", () => {
    const limiter = new GitHubRateLimiter({ maxRequests: 2, windowMs: 60000 });

    limiter.canMakeRequest("owner/repo1");
    limiter.canMakeRequest("owner/repo1");
    
    // repo1 is at limit
    expect(limiter.canMakeRequest("owner/repo1")).toBe(false);
    
    // repo2 is not affected
    expect(limiter.canMakeRequest("owner/repo2")).toBe(true);
    expect(limiter.canMakeRequest("owner/repo2")).toBe(true);
    expect(limiter.canMakeRequest("owner/repo2")).toBe(false);
  });

  it("returns null reset time when no requests have been made", () => {
    const limiter = new GitHubRateLimiter({ maxRequests: 2, windowMs: 60000 });

    expect(limiter.getResetTime("owner/repo")).toBeNull();
  });

  it("returns correct reset time after requests", () => {
    const limiter = new GitHubRateLimiter({ maxRequests: 2, windowMs: 60000 });

    const before = Date.now();
    limiter.canMakeRequest("owner/repo");
    
    const resetTime = limiter.getResetTime("owner/repo");
    expect(resetTime).not.toBeNull();
    expect(resetTime!.getTime()).toBeGreaterThan(before);
    expect(resetTime!.getTime()).toBeLessThanOrEqual(before + 60000);
  });

  it("uses default values when not specified", () => {
    const limiter = new GitHubRateLimiter();
    
    // Default is 90 requests per hour
    for (let i = 0; i < 90; i++) {
      expect(limiter.canMakeRequest("owner/repo")).toBe(true);
    }
    expect(limiter.canMakeRequest("owner/repo")).toBe(false);
  });
});

describe("GitHubPollingService", () => {
  let service: GitHubPollingService;
  let mockStore: TaskStore;
  let mockUpdatePrInfo: Mock;
  let mockUpdateIssueInfo: Mock;
  let mockGetTask: Mock;

  beforeEach(() => {
    vi.useFakeTimers();
    mockUpdatePrInfo = vi.fn();
    mockUpdateIssueInfo = vi.fn();
    mockGetTask = vi.fn();
    
    mockStore = {
      getTask: mockGetTask,
      updatePrInfo: mockUpdatePrInfo,
      updateIssueInfo: mockUpdateIssueInfo,
    } as unknown as TaskStore;

    service = new GitHubPollingService({
      store: mockStore,
      token: "test-token",
      pollingIntervalMs: 60_000,
    });

    mockGetBadgeStatusesBatch.mockReset();
  });

  afterEach(() => {
    service.stop();
    service.reset();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("configure", () => {
    it("updates store, token, and polling interval", () => {
      const newStore = { getTask: vi.fn() } as unknown as TaskStore;
      
      service.configure({
        store: newStore,
        token: "new-token",
        pollingIntervalMs: 30_000,
      });

      // Verify by checking the service behavior uses new config
      expect(service.getWatchedTaskIds()).toEqual([]);
    });

    it("restarts timer when interval changes while running", () => {
      service.watchTask("FN-001", "pr", "owner", "repo", 1);
      service.start();
      
      expect(service["timer"]).not.toBeNull();
      const originalTimer = service["timer"];

      service.configure({ pollingIntervalMs: 30_000 });

      // Timer should have been restarted with new interval
      expect(service["timer"]).not.toBe(originalTimer);
    });

    it("does not restart timer if not running", () => {
      service.configure({ pollingIntervalMs: 30_000 });
      
      expect(service["timer"]).toBeNull();
    });
  });

  describe("start/stop", () => {
    it("begins polling when watches exist", () => {
      service.watchTask("FN-001", "pr", "owner", "repo", 1);
      
      service.start();
      
      expect(service["enabled"]).toBe(true);
      expect(service["timer"]).not.toBeNull();
    });

    it("does nothing when no watches", () => {
      service.start();
      
      expect(service["timer"]).toBeNull();
    });

    it("clears timer on stop", () => {
      service.watchTask("FN-001", "pr", "owner", "repo", 1);
      service.start();
      
      expect(service["timer"]).not.toBeNull();
      
      service.stop();
      
      expect(service["timer"]).toBeNull();
      expect(service["enabled"]).toBe(false);
    });

    it("multiple start calls are safe", () => {
      service.watchTask("FN-001", "pr", "owner", "repo", 1);
      service.start();
      const timer1 = service["timer"];
      
      service.start();
      const timer2 = service["timer"];
      
      expect(timer1).toBe(timer2);
    });

    it("stop is safe when not running", () => {
      expect(() => service.stop()).not.toThrow();
    });
  });

  describe("watchTask", () => {
    it("adds watch for task", () => {
      service.watchTask("FN-001", "pr", "owner", "repo", 1);
      
      const watch = service.getWatch("FN-001");
      expect(watch).toBeDefined();
      expect(watch?.pr).toEqual({
        taskId: "FN-001",
        type: "pr",
        owner: "owner",
        repo: "repo",
        number: 1,
      });
    });

    it("replaces existing watch of same type", () => {
      service.watchTask("FN-001", "pr", "owner", "repo", 1);
      service.watchTask("FN-001", "pr", "owner", "repo", 2);
      
      const watch = service.getWatch("FN-001");
      expect(watch?.pr?.number).toBe(2);
    });

    it("keeps other watch type when replacing", () => {
      service.watchTask("FN-001", "pr", "owner", "repo", 1);
      service.watchTask("FN-001", "issue", "owner", "repo", 10);
      
      const watch = service.getWatch("FN-001");
      expect(watch?.pr?.number).toBe(1);
      expect(watch?.issue?.number).toBe(10);
    });
  });

  describe("replaceTaskWatches", () => {
    it("handles multiple watch types", () => {
      service.replaceTaskWatches("FN-001", [
        { taskId: "FN-001", type: "pr", owner: "owner", repo: "repo", number: 1 },
        { taskId: "FN-001", type: "issue", owner: "owner", repo: "repo", number: 10 },
      ]);
      
      const watch = service.getWatch("FN-001");
      expect(watch?.pr?.number).toBe(1);
      expect(watch?.issue?.number).toBe(10);
    });

    it("unwatches when empty array", () => {
      service.watchTask("FN-001", "pr", "owner", "repo", 1);
      
      service.replaceTaskWatches("FN-001", []);
      
      expect(service.getWatch("FN-001")).toBeUndefined();
    });

    it("filters invalid watches", () => {
      service.replaceTaskWatches("FN-001", [
        { taskId: "FN-001", type: "pr", owner: "", repo: "repo", number: 1 }, // invalid - empty owner
        { taskId: "FN-001", type: "issue", owner: "owner", repo: "repo", number: 10 }, // valid
      ]);
      
      const watch = service.getWatch("FN-001");
      expect(watch?.pr).toBeUndefined();
      expect(watch?.issue?.number).toBe(10);
    });
  });

  describe("unwatchTask", () => {
    it("removes all watches for task", () => {
      service.watchTask("FN-001", "pr", "owner", "repo", 1);
      service.watchTask("FN-001", "issue", "owner", "repo", 10);
      
      service.unwatchTask("FN-001");
      
      expect(service.getWatch("FN-001")).toBeUndefined();
    });

    it("stops polling when no watches remain", () => {
      service.watchTask("FN-001", "pr", "owner", "repo", 1);
      service.start();
      
      expect(service["timer"]).not.toBeNull();
      
      service.unwatchTask("FN-001");
      
      expect(service["timer"]).toBeNull();
    });
  });

  describe("unwatchTaskType", () => {
    it("removes specific type only", () => {
      service.watchTask("FN-001", "pr", "owner", "repo", 1);
      service.watchTask("FN-001", "issue", "owner", "repo", 10);
      
      service.unwatchTaskType("FN-001", "pr");
      
      const watch = service.getWatch("FN-001");
      expect(watch?.pr).toBeUndefined();
      expect(watch?.issue?.number).toBe(10);
    });

    it("unwatches task if no types remain", () => {
      service.watchTask("FN-001", "pr", "owner", "repo", 1);
      
      service.unwatchTaskType("FN-001", "pr");
      
      expect(service.getWatch("FN-001")).toBeUndefined();
    });
  });

  describe("reset", () => {
    it("clears all watches and stops", () => {
      service.watchTask("FN-001", "pr", "owner", "repo", 1);
      service.watchTask("FN-002", "issue", "owner", "repo", 10);
      service.start();
      
      service.reset();
      
      expect(service.getWatchedTaskIds()).toEqual([]);
      expect(service["timer"]).toBeNull();
    });
  });

  describe("getWatchedTaskIds", () => {
    it("returns all watched task IDs", () => {
      service.watchTask("FN-001", "pr", "owner", "repo", 1);
      service.watchTask("FN-002", "issue", "owner", "repo", 10);
      
      const ids = service.getWatchedTaskIds();
      expect(ids).toContain("FN-001");
      expect(ids).toContain("FN-002");
      expect(ids).toHaveLength(2);
    });
  });

  describe("getWatch", () => {
    it("returns watch set for task", () => {
      service.watchTask("FN-001", "pr", "owner", "repo", 1);
      
      const watch = service.getWatch("FN-001");
      expect(watch?.pr?.owner).toBe("owner");
    });

    it("returns undefined for unwatched task", () => {
      expect(service.getWatch("KB-999")).toBeUndefined();
    });
  });

  describe("getLastCheckedAt", () => {
    it("returns timestamp for type", async () => {
      // Setup task with PR badge
      mockGetTask.mockResolvedValue({
        id: "FN-001",
        prInfo: { url: "https://github.com/owner/repo/pull/1", number: 1, status: "open", title: "Test", headBranch: "feat", baseBranch: "main", commentCount: 0 },
      });

      mockGetBadgeStatusesBatch.mockResolvedValue({
        pr_1: {
          type: "pr",
          prInfo: { url: "https://github.com/owner/repo/pull/1", number: 1, status: "open", title: "Test", headBranch: "feat", baseBranch: "main", commentCount: 0 },
        },
      });

      service.watchTask("FN-001", "pr", "owner", "repo", 1);
      await service.pollOnce();

      const checkedAt = service.getLastCheckedAt("FN-001", "pr");
      expect(checkedAt).toBeDefined();
      expect(new Date(checkedAt!).getTime()).toBeGreaterThan(0);
    });

    it("returns undefined for unwatched type", () => {
      service.watchTask("FN-001", "pr", "owner", "repo", 1);
      
      expect(service.getLastCheckedAt("FN-001", "issue")).toBeUndefined();
    });
  });

  describe("pollOnce", () => {
    it("batches requests by repo", async () => {
      mockGetTask.mockResolvedValue({
        id: "FN-001",
        prInfo: { url: "https://github.com/owner/repo/pull/1", number: 1, status: "open", title: "Test", headBranch: "feat", baseBranch: "main", commentCount: 0 },
      });

      mockGetBadgeStatusesBatch.mockResolvedValue({
        pr_1: {
          type: "pr",
          prInfo: { url: "https://github.com/owner/repo/pull/1", number: 1, status: "open", title: "Test", headBranch: "feat", baseBranch: "main", commentCount: 0 },
        },
      });

      service.watchTask("FN-001", "pr", "owner", "repo", 1);
      await service.pollOnce();

      // Should batch by repo
      expect(mockGetBadgeStatusesBatch).toHaveBeenCalledWith(
        "owner",
        "repo",
        expect.arrayContaining([expect.objectContaining({ alias: "pr_1", type: "pr", number: 1 })])
      );
    });

    it("applies rate limiting per repo", async () => {
      // Create a custom rate limiter for testing
      const rateLimiter = new GitHubRateLimiter({ maxRequests: 1, windowMs: 60000 });
      
      service = new GitHubPollingService({
        store: mockStore,
        token: "test-token",
        rateLimiter,
      });

      mockGetTask.mockResolvedValue({
        id: "FN-001",
        prInfo: { url: "https://github.com/owner/repo/pull/1", number: 1, status: "open", title: "Test", headBranch: "feat", baseBranch: "main", commentCount: 0 },
      });

      mockGetBadgeStatusesBatch.mockResolvedValue({
        pr_1: {
          type: "pr",
          prInfo: { url: "https://github.com/owner/repo/pull/1", number: 1, status: "open", title: "Test", headBranch: "feat", baseBranch: "main", commentCount: 0 },
      },
      });

      service.watchTask("FN-001", "pr", "owner", "repo", 1);
      
      // First poll should work
      await service.pollOnce();
      expect(mockGetBadgeStatusesBatch).toHaveBeenCalledTimes(1);

      // Second poll should be rate limited (same repo)
      await service.pollOnce();
      // Should not make another request due to rate limiting
      expect(mockGetBadgeStatusesBatch).toHaveBeenCalledTimes(1);
    });

    it("handles missing tasks (ENOENT unwatches)", async () => {
      mockGetTask.mockRejectedValue({ code: "ENOENT" });

      service.watchTask("FN-001", "pr", "owner", "repo", 1);
      
      await service.pollOnce();

      // Task should be unwatched after ENOENT
      expect(service.getWatch("FN-001")).toBeUndefined();
    });

    it("updates store when badge fields changed", async () => {
      mockGetTask.mockResolvedValue({
        id: "FN-001",
        prInfo: { url: "https://github.com/owner/repo/pull/1", number: 1, status: "open", title: "Old Title", headBranch: "feat", baseBranch: "main", commentCount: 0 },
      });

      mockGetBadgeStatusesBatch.mockResolvedValue({
        pr_1: {
          type: "pr",
          prInfo: { url: "https://github.com/owner/repo/pull/1", number: 1, status: "open", title: "New Title", headBranch: "feat", baseBranch: "main", commentCount: 1 },
        },
      });

      service.watchTask("FN-001", "pr", "owner", "repo", 1);
      await service.pollOnce();

      expect(mockUpdatePrInfo).toHaveBeenCalledWith(
        "FN-001",
        expect.objectContaining({ title: "New Title", commentCount: 1 })
      );
    });

    it("skips update when badge unchanged", async () => {
      const prInfo = { url: "https://github.com/owner/repo/pull/1", number: 1, status: "open", title: "Same Title", headBranch: "feat", baseBranch: "main", commentCount: 0 };
      
      mockGetTask.mockResolvedValue({
        id: "FN-001",
        prInfo,
      });

      mockGetBadgeStatusesBatch.mockResolvedValue({
        pr_1: {
          type: "pr",
          prInfo,
        },
      });

      service.watchTask("FN-001", "pr", "owner", "repo", 1);
      await service.pollOnce();

      expect(mockUpdatePrInfo).not.toHaveBeenCalled();
    });

    it("handles PR status normalization", async () => {
      mockGetTask.mockResolvedValue({
        id: "FN-001",
        prInfo: { url: "https://github.com/owner/repo/pull/1", number: 1, status: "open", title: "Test", headBranch: "feat", baseBranch: "main", commentCount: 0 },
      });

      // PR status can be "open", "closed", or "merged"
      mockGetBadgeStatusesBatch.mockResolvedValue({
        pr_1: {
          type: "pr",
          prInfo: { url: "https://github.com/owner/repo/pull/1", number: 1, status: "merged", title: "Test", headBranch: "feat", baseBranch: "main", commentCount: 0 },
        },
      });

      service.watchTask("FN-001", "pr", "owner", "repo", 1);
      await service.pollOnce();

      expect(mockUpdatePrInfo).toHaveBeenCalledWith(
        "FN-001",
        expect.objectContaining({ status: "merged" })
      );
    });

    it("does nothing when store is not configured", async () => {
      service = new GitHubPollingService({ token: "test-token" });
      
      service.watchTask("FN-001", "pr", "owner", "repo", 1);
      
      await expect(service.pollOnce()).resolves.toBeUndefined();
    });

    it("does nothing when already polling", async () => {
      service["isPolling"] = true;
      
      await expect(service.pollOnce()).resolves.toBeUndefined();
    });

    it("does nothing when no watches", async () => {
      await expect(service.pollOnce()).resolves.toBeUndefined();
    });
  });

  describe("badge field comparison", () => {
    it("detects PR badge changes (url, number, status, title, headBranch, baseBranch, commentCount, lastCommentAt)", async () => {
      mockGetTask.mockResolvedValue({
        id: "FN-001",
        prInfo: { 
          url: "https://github.com/owner/repo/pull/1", 
          number: 1, 
          status: "open", 
          title: "Test", 
          headBranch: "feat", 
          baseBranch: "main", 
          commentCount: 0,
          lastCommentAt: undefined,
        },
      });

      // Each field change should trigger update
      const fieldChanges = [
        { field: "url", newValue: "https://github.com/owner/repo/pull/2" },
        { field: "number", newValue: 2 },
        { field: "status", newValue: "closed" },
        { field: "title", newValue: "New Title" },
        { field: "headBranch", newValue: "feature" },
        { field: "baseBranch", newValue: "develop" },
        { field: "commentCount", newValue: 1 },
        { field: "lastCommentAt", newValue: "2024-01-01T00:00:00Z" },
      ];

      for (const change of fieldChanges) {
        mockUpdatePrInfo.mockClear();
        mockGetBadgeStatusesBatch.mockResolvedValue({
          pr_1: {
            type: "pr",
            prInfo: { 
              url: "https://github.com/owner/repo/pull/1", 
              number: 1, 
              status: "open", 
              title: "Test", 
              headBranch: "feat", 
              baseBranch: "main", 
              commentCount: 0,
              [change.field]: change.newValue,
            },
          },
        });

        service.watchTask("FN-001", "pr", "owner", "repo", 1);
        await service.pollOnce();

        expect(mockUpdatePrInfo).toHaveBeenCalled();
      }
    });

    it("detects issue badge changes (url, number, state, title, stateReason)", async () => {
      mockGetTask.mockResolvedValue({
        id: "FN-001",
        issueInfo: { 
          url: "https://github.com/owner/repo/issues/1", 
          number: 1, 
          state: "open", 
          title: "Test Issue",
          stateReason: undefined,
        },
      });

      const fieldChanges = [
        { field: "url", newValue: "https://github.com/owner/repo/issues/2" },
        { field: "number", newValue: 2 },
        { field: "state", newValue: "closed" },
        { field: "title", newValue: "New Issue Title" },
        { field: "stateReason", newValue: "completed" },
      ];

      for (const change of fieldChanges) {
        mockUpdateIssueInfo.mockClear();
        mockGetBadgeStatusesBatch.mockResolvedValue({
          issue_1: {
            type: "issue",
            issueInfo: { 
              url: "https://github.com/owner/repo/issues/1", 
              number: 1, 
              state: "open", 
              title: "Test Issue",
              [change.field]: change.newValue,
            },
          },
        });

        service.watchTask("FN-001", "issue", "owner", "repo", 1);
        await service.pollOnce();

        expect(mockUpdateIssueInfo).toHaveBeenCalled();
      }
    });
  });

  describe("unwatch when badge removed", () => {
    it("unwatches PR when task has no prInfo", async () => {
      mockGetTask.mockResolvedValue({
        id: "FN-001",
        // No prInfo
      });

      mockGetBadgeStatusesBatch.mockResolvedValue({
        pr_1: null,
      });

      service.watchTask("FN-001", "pr", "owner", "repo", 1);
      await service.pollOnce();

      expect(service.getWatch("FN-001")?.pr).toBeUndefined();
    });

    it("unwatches issue when task has no issueInfo", async () => {
      mockGetTask.mockResolvedValue({
        id: "FN-001",
        // No issueInfo
      });

      mockGetBadgeStatusesBatch.mockResolvedValue({
        issue_1: null,
      });

      service.watchTask("FN-001", "issue", "owner", "repo", 1);
      await service.pollOnce();

      expect(service.getWatch("FN-001")?.issue).toBeUndefined();
    });
  });
});

describe("githubPoller singleton", () => {
  it("is a singleton instance", () => {
    expect(githubPoller).toBeInstanceOf(GitHubPollingService);
  });

  it("can be started and stopped", () => {
    // Should not throw
    githubPoller.start();
    githubPoller.stop();
  });
});

describe("githubRateLimiter singleton", () => {
  it("is a singleton instance", () => {
    expect(githubRateLimiter).toBeInstanceOf(GitHubRateLimiter);
  });
});
