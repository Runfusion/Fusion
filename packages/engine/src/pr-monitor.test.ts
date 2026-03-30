import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PrMonitor, type PrComment } from "./pr-monitor.js";

describe("PrMonitor", () => {
  let monitor: PrMonitor;
  const mockFetch = vi.fn();
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.useFakeTimers();
    monitor = new PrMonitor({ getGitHubToken: () => "test-token" });
    globalThis.fetch = mockFetch;
  });

  afterEach(() => {
    vi.useRealTimers();
    monitor.stopAll();
    globalThis.fetch = originalFetch;
    vi.clearAllMocks();
  });

  const mockPrInfo = {
    url: "https://github.com/owner/repo/pull/42",
    number: 42,
    status: "open" as const,
    title: "Test PR",
    headBranch: "kb/kb-001",
    baseBranch: "main",
    commentCount: 0,
  };

  const mockComment: PrComment = {
    id: 123,
    body: "Test comment",
    user: { login: "reviewer" },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    html_url: "https://github.com/owner/repo/pull/42#issuecomment-123",
  };

  describe("startMonitoring", () => {
    it("starts monitoring a PR", () => {
      monitor.startMonitoring("KB-001", "owner", "repo", mockPrInfo);

      const tracked = monitor.getTrackedPrs();
      expect(tracked.has("KB-001")).toBe(true);
      expect(tracked.get("KB-001")?.prInfo.number).toBe(42);
    });

    it("replaces existing monitoring for same task", () => {
      monitor.startMonitoring("KB-001", "owner", "repo", mockPrInfo);
      const newPrInfo = { ...mockPrInfo, number: 43 };
      monitor.startMonitoring("KB-001", "owner", "repo", newPrInfo);

      const tracked = monitor.getTrackedPrs();
      expect(tracked.get("KB-001")?.prInfo.number).toBe(43);
    });
  });

  describe("stopMonitoring", () => {
    it("stops monitoring a task", () => {
      monitor.startMonitoring("KB-001", "owner", "repo", mockPrInfo);
      monitor.stopMonitoring("KB-001");

      const tracked = monitor.getTrackedPrs();
      expect(tracked.has("KB-001")).toBe(false);
    });

    it("does nothing for untracked task", () => {
      expect(() => monitor.stopMonitoring("KB-999")).not.toThrow();
    });
  });

  describe("stopAll", () => {
    it("stops all monitoring", () => {
      monitor.startMonitoring("KB-001", "owner", "repo", mockPrInfo);
      monitor.startMonitoring("KB-002", "owner", "repo", mockPrInfo);

      monitor.stopAll();

      const tracked = monitor.getTrackedPrs();
      expect(tracked.size).toBe(0);
    });
  });

  describe("polling", () => {
    it("polls for comments on interval", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([]),
      });

      monitor.startMonitoring("KB-001", "owner", "repo", mockPrInfo);

      // Wait for initial check
      await vi.advanceTimersByTimeAsync(1);

      expect(mockFetch).toHaveBeenCalled();
    });

    it("calls onNewComments when new comments found", async () => {
      const callback = vi.fn();
      monitor.onNewComments(callback);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([mockComment]),
      });

      monitor.startMonitoring("KB-001", "owner", "repo", mockPrInfo);
      await vi.advanceTimersByTimeAsync(1);

      expect(callback).toHaveBeenCalledWith("KB-001", mockPrInfo, [mockComment]);
    });

    it("tracks lastCommentId to avoid duplicate notifications", async () => {
      const callback = vi.fn();
      monitor.onNewComments(callback);

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve([mockComment]),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve([mockComment]), // Same comment again
        });

      monitor.startMonitoring("KB-001", "owner", "repo", mockPrInfo);
      
      // First check
      await vi.advanceTimersByTimeAsync(1);
      expect(callback).toHaveBeenCalledTimes(1);

      // Second scheduled check after 30s
      await vi.advanceTimersByTimeAsync(30 * 1000);
      
      // Second poll should not trigger callback for same comment
      expect(callback).toHaveBeenCalledTimes(1);
    });
  });
});
