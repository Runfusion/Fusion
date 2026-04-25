import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useActivityLog } from "../useActivityLog";
import * as apiModule from "../../api";
import type { ActivityFeedEntry } from "../../api";

// Mock the API module
vi.mock("../../api", () => ({
  fetchActivityFeed: vi.fn(),
  fetchActivityLog: vi.fn(),
}));

const mockFetchActivityFeed = vi.mocked(apiModule.fetchActivityFeed);
const mockFetchActivityLog = vi.mocked(apiModule.fetchActivityLog);

/** Create ActivityFeedEntry[] entries (unified feed format) */
function createFeedEntries(
  count: number,
  projectId = "proj_123",
  projectName = "Test Project",
): ActivityFeedEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `feed_entry_${i}`,
    timestamp: new Date(Date.now() - i * 60000).toISOString(),
    type: "task:created" as const,
    projectId,
    projectName,
    taskId: "FN-001",
    taskTitle: "Test Task",
    details: "Task created",
  }));
}

describe("useActivityLog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // Default: both mocks return empty arrays
    mockFetchActivityFeed.mockResolvedValue([]);
    mockFetchActivityLog.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Single-project mode (default) ─────────────────────────────────

  it("initializes with empty entries and loads on mount", async () => {
    mockFetchActivityLog.mockResolvedValue([]);

    const { result } = renderHook(() => useActivityLog());

    expect(result.current.loading).toBe(true);
    expect(result.current.entries).toEqual([]);

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.entries).toEqual([]);
    // Should use per-project log, not unified feed
    expect(mockFetchActivityLog).toHaveBeenCalled();
    expect(mockFetchActivityFeed).not.toHaveBeenCalled();
  });

  it("fetches entries from per-project log in single-project mode", async () => {
    const mockEntries = createFeedEntries(1);
    mockFetchActivityLog.mockResolvedValue(
      mockEntries.map((e) => ({
        id: e.id,
        timestamp: e.timestamp,
        type: e.type,
        taskId: e.taskId,
        taskTitle: e.taskTitle,
        details: e.details,
        metadata: e.metadata,
      })),
    );

    const { result } = renderHook(() => useActivityLog());

    await waitFor(() => {
      expect(result.current.entries).toHaveLength(1);
    });

    // Hook converts ActivityLogEntry to ActivityFeedEntry with empty project fields
    expect(result.current.entries[0].type).toBe("task:created");
    expect(mockFetchActivityLog).toHaveBeenCalled();
    expect(mockFetchActivityFeed).not.toHaveBeenCalled();
  });

  it("filters by type via per-project log", async () => {
    mockFetchActivityLog.mockResolvedValue([]);

    renderHook(() => useActivityLog({ type: "task:created" }));

    await waitFor(() => {
      expect(mockFetchActivityLog).toHaveBeenCalledWith(
        expect.objectContaining({ type: "task:created" }),
      );
    });
  });

  it("respects custom limit via per-project log", async () => {
    mockFetchActivityLog.mockResolvedValue([]);

    renderHook(() => useActivityLog({ limit: 100 }));

    await waitFor(() => {
      expect(mockFetchActivityLog).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 100 }),
      );
    });
  });

  it("does not auto-refresh when disabled", async () => {
    mockFetchActivityLog.mockResolvedValue([]);

    renderHook(() => useActivityLog({ autoRefresh: false }));

    await waitFor(() => {
      expect(mockFetchActivityLog).toHaveBeenCalledTimes(1);
    });

    // Advance time — should not trigger another fetch
    vi.useRealTimers();
    await new Promise((r) => setTimeout(r, 100));

    expect(mockFetchActivityLog).toHaveBeenCalledTimes(1);
  });

  it("refresh function manually refreshes data", async () => {
    mockFetchActivityLog.mockResolvedValue([]);

    const { result } = renderHook(() => useActivityLog({ autoRefresh: false }));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    act(() => {
      result.current.refresh();
    });

    await waitFor(() => {
      expect(mockFetchActivityLog).toHaveBeenCalledTimes(2);
    });
  });

  it("clear removes all entries", async () => {
    const mockEntries = createFeedEntries(1);
    mockFetchActivityLog.mockResolvedValue(
      mockEntries.map((e) => ({
        id: e.id,
        timestamp: e.timestamp,
        type: e.type,
        taskId: e.taskId,
        taskTitle: e.taskTitle,
        details: e.details,
      })),
    );

    const { result } = renderHook(() => useActivityLog());

    await waitFor(() => {
      expect(result.current.entries).toHaveLength(1);
    });

    act(() => {
      result.current.clear();
    });

    expect(result.current.entries).toEqual([]);
    expect(result.current.hasMore).toBe(false);
  });

  it("handles errors gracefully", async () => {
    mockFetchActivityLog.mockRejectedValue(new Error("Server error"));

    const { result } = renderHook(() => useActivityLog());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).not.toBeNull();
  });

  it("sets hasMore when entries equal limit", async () => {
    const mockEntries = createFeedEntries(50);
    mockFetchActivityLog.mockResolvedValue(
      mockEntries.map((e) => ({
        id: e.id,
        timestamp: e.timestamp,
        type: e.type,
        taskId: e.taskId,
        taskTitle: e.taskTitle,
        details: e.details,
      })),
    );

    const { result } = renderHook(() => useActivityLog({ limit: 50 }));

    await waitFor(() => {
      expect(result.current.entries).toHaveLength(50);
    });

    expect(result.current.hasMore).toBe(true);
  });

  it("sets hasMore to false when fewer entries than limit", async () => {
    const mockEntries = createFeedEntries(30);
    mockFetchActivityLog.mockResolvedValue(
      mockEntries.map((e) => ({
        id: e.id,
        timestamp: e.timestamp,
        type: e.type,
        taskId: e.taskId,
        taskTitle: e.taskTitle,
        details: e.details,
      })),
    );

    const { result } = renderHook(() => useActivityLog({ limit: 50 }));

    await waitFor(() => {
      expect(result.current.entries).toHaveLength(30);
    });

    expect(result.current.hasMore).toBe(false);
  });

  // ── Multi-project mode (useCentralFeed) ───────────────────────────

  it("fetches from unified feed when useCentralFeed is true", async () => {
    const mockEntries = createFeedEntries(2, "proj_multi", "Multi Project");
    mockFetchActivityFeed.mockResolvedValue(mockEntries);

    const { result } = renderHook(() =>
      useActivityLog({ useCentralFeed: true }),
    );

    await waitFor(() => {
      expect(result.current.entries).toHaveLength(2);
    });

    expect(result.current.entries[0].projectName).toBe("Multi Project");
    expect(mockFetchActivityFeed).toHaveBeenCalled();
    expect(mockFetchActivityLog).not.toHaveBeenCalled();
  });

  it("passes projectId to unified feed when useCentralFeed is true", async () => {
    mockFetchActivityFeed.mockResolvedValue([]);

    renderHook(() =>
      useActivityLog({ projectId: "proj_456", useCentralFeed: true }),
    );

    await waitFor(() => {
      expect(mockFetchActivityFeed).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: "proj_456" }),
      );
    });
  });

  it("passes type filter to unified feed when useCentralFeed is true", async () => {
    mockFetchActivityFeed.mockResolvedValue([]);

    renderHook(() =>
      useActivityLog({ type: "task:failed", useCentralFeed: true }),
    );

    await waitFor(() => {
      expect(mockFetchActivityFeed).toHaveBeenCalledWith(
        expect.objectContaining({ type: "task:failed" }),
      );
    });
  });
});
