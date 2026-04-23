import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PrMonitor, type PrComment } from "./pr-monitor.js";
import type { PrMonitorGhClient } from "./pr-monitor-gh.js";

describe("PrMonitor", () => {
  let monitor: PrMonitor;
  let checkAuth: ReturnType<typeof vi.fn<PrMonitorGhClient["checkAuth"]>>;
  let fetchComments: ReturnType<typeof vi.fn<PrMonitorGhClient["fetchComments"]>>;

  const flushAsync = async () => {
    await Promise.resolve();
    await Promise.resolve();
  };

  const mockPrInfo = {
    url: "https://github.com/owner/repo/pull/42",
    number: 42,
    status: "open" as const,
    title: "Test PR",
    headBranch: "fusion/fn-001",
    baseBranch: "main",
    commentCount: 0,
  };

  beforeEach(() => {
    vi.useFakeTimers();
    checkAuth = vi.fn(async () => true);
    fetchComments = vi.fn(async () => []);
    monitor = new PrMonitor({
      ghClient: {
        checkAuth,
        fetchComments,
      },
    });
  });

  afterEach(() => {
    monitor.stopAll();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  describe("startMonitoring", () => {
    it("starts monitoring a PR", () => {
      monitor.startMonitoring("FN-001", "owner", "repo", mockPrInfo);

      const tracked = monitor.getTrackedPrs();
      expect(tracked.has("FN-001")).toBe(true);
      expect(tracked.get("FN-001")?.prInfo.number).toBe(42);
    });

    it("replaces existing monitoring for same task", () => {
      monitor.startMonitoring("FN-001", "owner", "repo", mockPrInfo);
      const newPrInfo = { ...mockPrInfo, number: 43 };
      monitor.startMonitoring("FN-001", "owner", "repo", newPrInfo);

      const tracked = monitor.getTrackedPrs();
      expect(tracked.get("FN-001")?.prInfo.number).toBe(43);
    });
  });

  describe("polling", () => {
    it("polls successfully and updates tracking state with filtered new comments", async () => {
      fetchComments.mockResolvedValueOnce([]).mockResolvedValueOnce([
        {
          id: 5,
          body: "older",
          user: { login: "reviewer1" },
          created_at: "2024-01-01T00:00:00.000Z",
          updated_at: "2024-01-01T00:00:00.000Z",
          html_url: "https://example.com/5",
        },
        {
          id: 12,
          body: "new feedback",
          user: { login: "reviewer2" },
          created_at: "2024-01-02T00:00:00.000Z",
          updated_at: "2024-01-02T00:00:00.000Z",
          html_url: "https://example.com/12",
        },
      ]);

      monitor.startMonitoring("FN-001", "owner", "repo", mockPrInfo);
      await flushAsync(); // initial immediate poll

      const tracked = monitor.getTrackedPrs().get("FN-001")!;
      tracked.lastCommentId = 10;
      tracked.lastCheckedAt = new Date("2024-01-01T00:00:00.000Z");
      tracked.consecutiveErrors = 3;

      vi.setSystemTime(new Date("2024-01-01T00:00:30.000Z"));
      await vi.advanceTimersByTimeAsync(30_000);

      expect(checkAuth).toHaveBeenCalledTimes(2);
      expect(fetchComments).toHaveBeenNthCalledWith(2, {
        owner: "owner",
        repo: "repo",
        prNumber: 42,
        since: "2024-01-01T00:00:00.000Z",
      });

      expect(tracked.lastCommentId).toBe(12);
      expect(tracked.lastCheckedAt.toISOString()).toBe("2024-01-01T00:01:00.000Z");
      expect(tracked.consecutiveErrors).toBe(0);
      expect(tracked.bufferedComments).toHaveLength(1);
      expect(tracked.bufferedComments[0].id).toBe(12);
    });

    it("keeps buffered comments even when callback throws, and drainComments is single-consumption", async () => {
      const newComment: PrComment = {
        id: 101,
        body: "please update",
        user: { login: "reviewer" },
        created_at: "2024-01-02T00:00:00.000Z",
        updated_at: "2024-01-02T00:00:00.000Z",
        html_url: "https://example.com/101",
      };

      fetchComments.mockResolvedValueOnce([]).mockResolvedValueOnce([newComment]);
      monitor.onNewComments(async () => {
        throw new Error("callback failure");
      });

      monitor.startMonitoring("FN-001", "owner", "repo", mockPrInfo);
      await flushAsync();

      await vi.advanceTimersByTimeAsync(30_000);

      const drained = monitor.drainComments("FN-001");
      expect(drained).toEqual([newComment]);
      expect(monitor.drainComments("FN-001")).toEqual([]);
    });

    it("returns false on auth failure, increments errors, does not fetch comments, and keeps task tracked", async () => {
      checkAuth.mockResolvedValue(false);
      monitor.startMonitoring("FN-001", "owner", "repo", mockPrInfo);
      await flushAsync();

      const tracked = monitor.getTrackedPrs().get("FN-001")!;
      const result = await (monitor as any).checkForComments("FN-001", tracked);

      expect(result).toBe(false);
      expect(tracked.consecutiveErrors).toBe(2);
      expect(fetchComments).not.toHaveBeenCalled();
      expect(monitor.getTrackedPrs().has("FN-001")).toBe(true);
    });

    it("increments consecutive failures and stops monitoring after 5 fetch errors", async () => {
      fetchComments.mockRejectedValue(new Error("gh failed"));

      monitor.startMonitoring("FN-001", "owner", "repo", mockPrInfo);
      await flushAsync(); // failure #1

      expect(monitor.getTrackedPrs().get("FN-001")?.consecutiveErrors).toBe(1);

      await vi.runOnlyPendingTimersAsync(); // #2
      await vi.runOnlyPendingTimersAsync(); // #3
      await vi.runOnlyPendingTimersAsync(); // #4
      await vi.runOnlyPendingTimersAsync(); // #5 -> stop monitoring

      expect(checkAuth).toHaveBeenCalledTimes(5);
      expect(fetchComments).toHaveBeenCalledTimes(5);
      expect(monitor.getTrackedPrs().has("FN-001")).toBe(false);
    });

    it("marks tracked PR idle after no new comments for >5 minutes and then polls on idle interval", async () => {
      fetchComments.mockResolvedValue([]);
      monitor.startMonitoring("FN-001", "owner", "repo", mockPrInfo);
      await flushAsync();

      const tracked = monitor.getTrackedPrs().get("FN-001")!;
      tracked.lastCheckedAt = new Date("2024-01-01T00:00:00.000Z");
      vi.setSystemTime(new Date("2024-01-01T00:10:00.000Z"));

      await vi.advanceTimersByTimeAsync(30_000); // active interval poll sets isActive=false
      expect(tracked.isActive).toBe(false);
      const fetchCallsAfterIdleFlip = fetchComments.mock.calls.length;

      await vi.advanceTimersByTimeAsync(4 * 60 * 1000 + 59_000);
      expect(fetchComments).toHaveBeenCalledTimes(fetchCallsAfterIdleFlip);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(fetchComments).toHaveBeenCalledTimes(fetchCallsAfterIdleFlip + 1);
    });
  });

  describe("updatePrInfo", () => {
    it("updates tracked PR metadata without restarting monitoring", () => {
      monitor.startMonitoring("FN-001", "owner", "repo", mockPrInfo);
      const updatedPrInfo = { ...mockPrInfo, status: "merged" as const };

      monitor.updatePrInfo("FN-001", updatedPrInfo);

      const tracked = monitor.getTrackedPrs();
      expect(tracked.get("FN-001")?.prInfo.status).toBe("merged");
      expect(tracked.get("FN-001")?.owner).toBe("owner");
    });
  });

  describe("stopMonitoring", () => {
    it("stops monitoring a task", () => {
      monitor.startMonitoring("FN-001", "owner", "repo", mockPrInfo);
      monitor.stopMonitoring("FN-001");

      const tracked = monitor.getTrackedPrs();
      expect(tracked.has("FN-001")).toBe(false);
    });

    it("does nothing for untracked task", () => {
      expect(() => monitor.stopMonitoring("KB-999")).not.toThrow();
    });
  });

  describe("constructor", () => {
    it("no longer requires getGitHubToken option", () => {
      expect(() => new PrMonitor()).not.toThrow();
    });

    it("ignores getGitHubToken if provided (backward compat)", () => {
      expect(() => new PrMonitor({ getGitHubToken: () => "token" })).not.toThrow();
    });
  });

  describe("drainComments", () => {
    it("returns empty array when task is not tracked", () => {
      const result = monitor.drainComments("FN-999");
      expect(result).toEqual([]);
    });

    it("returns empty array after PR is stopped", () => {
      monitor.startMonitoring("FN-001", "owner", "repo", mockPrInfo);
      const tracked = monitor.getTrackedPrs().get("FN-001")!;
      tracked.bufferedComments.push({
        id: 1,
        body: "Fix this",
        user: { login: "reviewer" },
        created_at: "2024-01-01",
        updated_at: "2024-01-01",
        html_url: "",
      });

      monitor.stopMonitoring("FN-001");
      const result = monitor.drainComments("FN-001");
      expect(result).toEqual([]);
    });
  });
});
