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

    // FNXC:ActivityLogTests 2026-06-27-17:10:
    // Prove the negative (no auto-refresh poll fires when autoRefresh:false) with
    // fake timers instead of a real wall-clock sleep. The hook polls every
    // POLL_INTERVAL_MS (5000ms); advancing well past two intervals deterministically
    // exercises the disabled-interval path with zero real wait (FN-5048: no slow tests).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(12_000);
    });

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

  // ── Retention cap vs. pagination ──────────────────────────────────

  /*
  FNXC:ActivityLogPaging 2026-07-26-18:45:
  Regression coverage for a silent pagination stop. With the 500-entry retention cap applied as
  `merged.slice(0, MAX)`, the eleventh "Load more" (limit 50) fetched a page and then threw away exactly
  that page, while `lastTimestampRef` still advanced past it and `hasMore` stayed true. The feed stopped
  moving, the button kept promising it would, and the skipped entries became unreachable because the
  cursor had passed them.

  The invariant asserted here is the user-visible one: every click of an offered "Load more" must put
  entries on screen that were not there before, at the cap as well as below it.
  */
  function paginatedLogPage(page: number, size: number) {
    return Array.from({ length: size }, (_, i) => ({
      id: `p${page}_${i}`,
      timestamp: new Date(Date.UTC(2024, 0, 1) - (page * size + i) * 60_000).toISOString(),
      type: "task:created" as const,
      taskId: "FN-001",
      taskTitle: "Test Task",
      details: "Task created",
    }));
  }

  it("keeps the page it just fetched when loadMore crosses the retention cap", async () => {
    const PAGE = 50;
    let page = 0;
    mockFetchActivityLog.mockImplementation(async () => paginatedLogPage(page++, PAGE));

    const { result } = renderHook(() => useActivityLog({ limit: PAGE, autoRefresh: false }));
    await waitFor(() => expect(result.current.entries).toHaveLength(PAGE));

    // Nine clicks fill the buffer exactly to the 500-entry cap.
    for (let click = 0; click < 9; click++) {
      await act(async () => {
        await result.current.loadMore();
      });
    }
    expect(result.current.entries).toHaveLength(500);
    expect(result.current.hasMore).toBe(true);

    const idsAtCap = result.current.entries.map((entry) => entry.id);

    // The tenth click is the one that used to be a no-op.
    await act(async () => {
      await result.current.loadMore();
    });

    const idsAfter = result.current.entries.map((entry) => entry.id);
    expect(idsAfter).toHaveLength(500);
    expect(idsAfter).not.toEqual(idsAtCap);
    // The whole freshly fetched (older) page is present…
    expect(idsAfter).toContain("p10_0");
    expect(idsAfter).toContain("p10_49");
    // …paid for from the head, which `refresh` can fetch again from offset 0.
    expect(idsAfter).not.toContain("p0_0");
    expect(mockFetchActivityLog).toHaveBeenCalledTimes(11);
  });

  it("continues to page backwards across several clicks past the cap", async () => {
    const PAGE = 50;
    let page = 0;
    mockFetchActivityLog.mockImplementation(async () => paginatedLogPage(page++, PAGE));

    const { result } = renderHook(() => useActivityLog({ limit: PAGE, autoRefresh: false }));
    await waitFor(() => expect(result.current.entries).toHaveLength(PAGE));

    for (let click = 0; click < 12; click++) {
      await act(async () => {
        await result.current.loadMore();
      });
    }

    // Twelve clicks past a 50-entry first page = pages 0..12; the oldest page must be on screen.
    expect(result.current.entries.map((entry) => entry.id)).toContain("p12_49");
    expect(result.current.entries).toHaveLength(500);
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
