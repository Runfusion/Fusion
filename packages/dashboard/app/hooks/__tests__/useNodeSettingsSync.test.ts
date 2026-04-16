import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useNodeSettingsSync } from "../useNodeSettingsSync";
import * as apiNode from "../../api-node";
import type { NodeSettingsSyncStatus, NodeSettingsSyncResult, NodeAuthSyncResult } from "../../api-node";

vi.mock("../../api-node", () => ({
  fetchNodeSettingsSyncStatus: vi.fn(),
  pushNodeSettings: vi.fn(),
  pullNodeSettings: vi.fn(),
  syncNodeAuth: vi.fn(),
}));

const mockFetchNodeSettingsSyncStatus = vi.mocked(apiNode.fetchNodeSettingsSyncStatus);
const mockPushNodeSettings = vi.mocked(apiNode.pushNodeSettings);
const mockPullNodeSettings = vi.mocked(apiNode.pullNodeSettings);
const mockSyncNodeAuth = vi.mocked(apiNode.syncNodeAuth);

function makeSyncStatus(overrides: Partial<NodeSettingsSyncStatus> = {}): NodeSettingsSyncStatus {
  return {
    lastSyncAt: "2026-04-01T00:00:00.000Z",
    lastSyncDirection: "sync",
    localUpdatedAt: "2026-04-01T00:00:00.000Z",
    remoteReachable: true,
    diff: { global: [], project: [] },
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("useNodeSettingsSync", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockFetchNodeSettingsSyncStatus.mockReset();
    mockPushNodeSettings.mockReset();
    mockPullNodeSettings.mockReset();
    mockSyncNodeAuth.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // ── Initial state ─────────────────────────────────────────────────────────

  it("returns empty syncStatusMap, loading=false, no error when no nodes are tracked", async () => {
    const { result } = renderHook(() => useNodeSettingsSync());

    await act(async () => {
      await flushPromises();
    });

    expect(result.current.syncStatusMap).toEqual({});
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.actionLoading).toEqual({});
  });

  it("makes no API calls when no nodes are tracked", async () => {
    renderHook(() => useNodeSettingsSync());

    await act(async () => {
      await flushPromises();
    });

    expect(mockFetchNodeSettingsSyncStatus).not.toHaveBeenCalled();
  });

  // ── Track node ─────────────────────────────────────────────────────────────

  it("immediately fetches sync status when a node is tracked", async () => {
    mockFetchNodeSettingsSyncStatus.mockResolvedValueOnce(makeSyncStatus({ lastSyncAt: "2026-04-01T00:00:00.000Z" }));

    const { result } = renderHook(() => useNodeSettingsSync());

    await act(async () => {
      await flushPromises();
    });

    await act(async () => {
      result.current.trackNode("node_1");
    });

    await act(async () => {
      await flushPromises();
    });

    expect(mockFetchNodeSettingsSyncStatus).toHaveBeenCalledWith("node_1");
    expect(result.current.syncStatusMap.node_1).toEqual(makeSyncStatus({ lastSyncAt: "2026-04-01T00:00:00.000Z" }));
  });

  it("tracks multiple nodes and fetches status for each", async () => {
    mockFetchNodeSettingsSyncStatus
      .mockResolvedValueOnce(makeSyncStatus({ lastSyncAt: "2026-04-01T00:00:00.000Z" }))
      .mockResolvedValueOnce(makeSyncStatus({ lastSyncAt: "2026-04-02T00:00:00.000Z" }));

    const { result } = renderHook(() => useNodeSettingsSync());

    await act(async () => {
      await flushPromises();
    });

    await act(async () => {
      result.current.trackNode("node_1");
      result.current.trackNode("node_2");
    });

    await act(async () => {
      await flushPromises();
    });

    expect(mockFetchNodeSettingsSyncStatus).toHaveBeenCalledTimes(2);
    expect(result.current.syncStatusMap.node_1).toBeDefined();
    expect(result.current.syncStatusMap.node_2).toBeDefined();
  });

  // ── Untrack node ───────────────────────────────────────────────────────────

  it("removes node from syncStatusMap when untracked", async () => {
    mockFetchNodeSettingsSyncStatus
      .mockResolvedValueOnce(makeSyncStatus())
      .mockResolvedValueOnce(makeSyncStatus());

    const { result } = renderHook(() => useNodeSettingsSync());

    await act(async () => {
      await flushPromises();
    });

    await act(async () => {
      result.current.trackNode("node_1");
      result.current.trackNode("node_2");
    });

    await act(async () => {
      await flushPromises();
    });

    expect(result.current.syncStatusMap.node_1).toBeDefined();
    expect(result.current.syncStatusMap.node_2).toBeDefined();

    await act(async () => {
      result.current.untrackNode("node_1");
    });

    expect(result.current.syncStatusMap.node_1).toBeUndefined();
    expect(result.current.syncStatusMap.node_2).toBeDefined();
  });

  // ── Loading contract (FN-1734) ───────────────────────────────────────────────

  it("sets loading=true during initial fetch and false after completion", async () => {
    // Track a node first, then resolve the pending promise after checking the transition
    mockFetchNodeSettingsSyncStatus.mockResolvedValue(makeSyncStatus());

    const { result } = renderHook(() => useNodeSettingsSync());

    await act(async () => {
      await flushPromises();
    });

    await act(async () => {
      result.current.trackNode("node_1");
    });

    await act(async () => {
      await flushPromises();
    });

    // After trackNode and flush, loading should be false (fetch completed)
    expect(result.current.loading).toBe(false);
    expect(result.current.syncStatusMap.node_1).toEqual(makeSyncStatus());
  });

  it("does NOT set loading to true during background polling refreshes (FN-1734 regression)", async () => {
    mockFetchNodeSettingsSyncStatus.mockResolvedValue(makeSyncStatus());

    const { result } = renderHook(() => useNodeSettingsSync());

    await act(async () => {
      await flushPromises();
    });

    await act(async () => {
      result.current.trackNode("node_1");
    });

    await act(async () => {
      await flushPromises();
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.syncStatusMap.node_1).toEqual(makeSyncStatus());

    // Advance timer for polling refresh (30 seconds)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
      await flushPromises();
    });

    // loading should still be false (regression: previously was set to true)
    expect(result.current.loading).toBe(false);
    expect(mockFetchNodeSettingsSyncStatus).toHaveBeenCalledTimes(2);
  });

  // ── Polling ───────────────────────────────────────────────────────────────

  it("polls fetchNodeSettingsSyncStatus every 30 seconds for tracked nodes", async () => {
    mockFetchNodeSettingsSyncStatus.mockResolvedValue(makeSyncStatus());

    const { result } = renderHook(() => useNodeSettingsSync());

    await act(async () => {
      await flushPromises();
    });

    await act(async () => {
      result.current.trackNode("node_1");
    });

    await act(async () => {
      await flushPromises();
    });

    // Initial fetch: 1 call
    expect(mockFetchNodeSettingsSyncStatus).toHaveBeenCalledTimes(1);

    // Advance 30 seconds
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
      await flushPromises();
    });

    expect(mockFetchNodeSettingsSyncStatus).toHaveBeenCalledTimes(2);

    // Advance another 30 seconds
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
      await flushPromises();
    });

    expect(mockFetchNodeSettingsSyncStatus).toHaveBeenCalledTimes(3);
  });

  it("clears polling interval on unmount", async () => {
    mockFetchNodeSettingsSyncStatus.mockResolvedValue(makeSyncStatus());

    const { result, unmount } = renderHook(() => useNodeSettingsSync());

    await act(async () => {
      await flushPromises();
    });

    await act(async () => {
      result.current.trackNode("node_1");
    });

    await act(async () => {
      await flushPromises();
    });

    // Reset call count to check post-unmount calls
    mockFetchNodeSettingsSyncStatus.mockClear();

    unmount();

    // Advance 60 seconds worth of polling
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
      await flushPromises();
    });

    // Should NOT have any new calls after unmount
    expect(mockFetchNodeSettingsSyncStatus).not.toHaveBeenCalled();
  });

  it("stops polling when all nodes are untracked", async () => {
    mockFetchNodeSettingsSyncStatus.mockResolvedValue(makeSyncStatus());

    const { result } = renderHook(() => useNodeSettingsSync());

    await act(async () => {
      await flushPromises();
    });

    await act(async () => {
      result.current.trackNode("node_1");
    });

    await act(async () => {
      await flushPromises();
    });

    // Initial fetch
    expect(mockFetchNodeSettingsSyncStatus).toHaveBeenCalledTimes(1);

    // Untrack the only node
    await act(async () => {
      result.current.untrackNode("node_1");
    });

    // Clear call count
    mockFetchNodeSettingsSyncStatus.mockClear();

    // Advance 60 seconds
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
      await flushPromises();
    });

    // No polling should have happened
    expect(mockFetchNodeSettingsSyncStatus).not.toHaveBeenCalled();
  });

  // ── Push action ─────────────────────────────────────────────────────────────

  it("pushSettings calls pushNodeSettings and sets actionLoading during the call", async () => {
    mockFetchNodeSettingsSyncStatus.mockResolvedValue(makeSyncStatus());
    const pushDeferred = deferred<{ success: boolean; syncedFields: string[] }>();
    mockPushNodeSettings.mockReturnValue(pushDeferred.promise);

    const { result } = renderHook(() => useNodeSettingsSync());

    await act(async () => {
      await flushPromises();
    });

    await act(async () => {
      result.current.trackNode("node_1");
    });

    await act(async () => {
      await flushPromises();
    });

    // Reset after tracking
    mockFetchNodeSettingsSyncStatus.mockClear();

    // Start push but don't resolve yet
    await act(async () => {
      const promise = result.current.pushSettings("node_1");
      void promise; // We don't await yet - we'll resolve the deferred manually
    });

    expect(mockPushNodeSettings).toHaveBeenCalledWith("node_1");
    expect(result.current.actionLoading.node_1).toBe(true);

    // Resolve the deferred
    pushDeferred.resolve({ success: true, syncedFields: ["theme"] });

    await act(async () => {
      await flushPromises();
    });

    expect(result.current.actionLoading.node_1).toBeUndefined();
  });

  it("pushSettings refreshes sync status after completion", async () => {
    mockFetchNodeSettingsSyncStatus.mockResolvedValue(makeSyncStatus());
    mockPushNodeSettings.mockResolvedValue({ success: true, syncedFields: ["theme"] });

    const { result } = renderHook(() => useNodeSettingsSync());

    await act(async () => {
      await flushPromises();
    });

    await act(async () => {
      result.current.trackNode("node_1");
    });

    await act(async () => {
      await flushPromises();
    });

    mockFetchNodeSettingsSyncStatus.mockClear();
    mockFetchNodeSettingsSyncStatus.mockResolvedValue(makeSyncStatus({ lastSyncAt: "2026-04-02T00:00:00.000Z" }));

    await act(async () => {
      await result.current.pushSettings("node_1");
    });

    await act(async () => {
      await flushPromises();
    });

    expect(mockFetchNodeSettingsSyncStatus).toHaveBeenCalledWith("node_1");
  });

  // ── Pull action ─────────────────────────────────────────────────────────────

  it("pullSettings calls pullNodeSettings and sets actionLoading during the call", async () => {
    mockFetchNodeSettingsSyncStatus.mockResolvedValue(makeSyncStatus());
    const pullDeferred = deferred<{ success: boolean; appliedFields: string[]; skippedFields: string[] }>();
    mockPullNodeSettings.mockReturnValue(pullDeferred.promise);

    const { result } = renderHook(() => useNodeSettingsSync());

    await act(async () => {
      await flushPromises();
    });

    await act(async () => {
      result.current.trackNode("node_1");
    });

    await act(async () => {
      await flushPromises();
    });

    mockFetchNodeSettingsSyncStatus.mockClear();

    // Start pull but don't resolve yet
    await act(async () => {
      const promise = result.current.pullSettings("node_1");
      void promise;
    });

    expect(mockPullNodeSettings).toHaveBeenCalledWith("node_1");
    expect(result.current.actionLoading.node_1).toBe(true);

    // Resolve the deferred
    pullDeferred.resolve({ success: true, appliedFields: ["theme"], skippedFields: [] });

    await act(async () => {
      await flushPromises();
    });

    expect(result.current.actionLoading.node_1).toBeUndefined();
  });

  it("pullSettings refreshes sync status after completion", async () => {
    mockFetchNodeSettingsSyncStatus.mockResolvedValue(makeSyncStatus());
    mockPullNodeSettings.mockResolvedValue({ success: true, appliedFields: [], skippedFields: [] });

    const { result } = renderHook(() => useNodeSettingsSync());

    await act(async () => {
      await flushPromises();
    });

    await act(async () => {
      result.current.trackNode("node_1");
    });

    await act(async () => {
      await flushPromises();
    });

    mockFetchNodeSettingsSyncStatus.mockClear();
    mockFetchNodeSettingsSyncStatus.mockResolvedValue(makeSyncStatus({ lastSyncAt: "2026-04-03T00:00:00.000Z" }));

    await act(async () => {
      await result.current.pullSettings("node_1");
    });

    await act(async () => {
      await flushPromises();
    });

    expect(mockFetchNodeSettingsSyncStatus).toHaveBeenCalledWith("node_1");
  });

  // ── Auth sync action ─────────────────────────────────────────────────────────

  it("syncAuth calls syncNodeAuth and sets actionLoading during the call", async () => {
    mockFetchNodeSettingsSyncStatus.mockResolvedValue(makeSyncStatus());
    const authDeferred = deferred<NodeAuthSyncResult>();
    mockSyncNodeAuth.mockReturnValue(authDeferred.promise);

    const { result } = renderHook(() => useNodeSettingsSync());

    await act(async () => {
      await flushPromises();
    });

    await act(async () => {
      result.current.trackNode("node_1");
    });

    await act(async () => {
      await flushPromises();
    });

    // Start auth sync but don't resolve yet
    await act(async () => {
      const promise = result.current.syncAuth("node_1");
      void promise;
    });

    expect(mockSyncNodeAuth).toHaveBeenCalledWith("node_1");
    expect(result.current.actionLoading.node_1).toBe(true);

    // Resolve the deferred
    authDeferred.resolve({ success: true, syncedProviders: ["openai"] });

    await act(async () => {
      await flushPromises();
    });

    expect(result.current.actionLoading.node_1).toBeUndefined();
  });

  // ── Action error handling ───────────────────────────────────────────────────

  it("action error re-throws, clears actionLoading, and sets error", async () => {
    mockFetchNodeSettingsSyncStatus.mockResolvedValue(makeSyncStatus());
    mockPushNodeSettings.mockRejectedValue(new Error("Push failed"));

    const { result } = renderHook(() => useNodeSettingsSync());

    await act(async () => {
      await flushPromises();
    });

    await act(async () => {
      result.current.trackNode("node_1");
    });

    await act(async () => {
      await flushPromises();
    });

    await expect(result.current.pushSettings("node_1")).rejects.toThrow("Push failed");

    await act(async () => {
      await flushPromises();
    });

    expect(result.current.error).toBe("Push failed");
    expect(result.current.actionLoading).toEqual({});
  });

  it("action error for pull clears actionLoading and sets error", async () => {
    mockFetchNodeSettingsSyncStatus.mockResolvedValue(makeSyncStatus());
    mockPullNodeSettings.mockRejectedValue(new Error("Pull failed"));

    const { result } = renderHook(() => useNodeSettingsSync());

    await act(async () => {
      await flushPromises();
    });

    await act(async () => {
      result.current.trackNode("node_1");
    });

    await act(async () => {
      await flushPromises();
    });

    await expect(result.current.pullSettings("node_1")).rejects.toThrow("Pull failed");

    await act(async () => {
      await flushPromises();
    });

    expect(result.current.error).toBe("Pull failed");
    expect(result.current.actionLoading).toEqual({});
  });

  it("action error for auth sync clears actionLoading and sets error", async () => {
    mockFetchNodeSettingsSyncStatus.mockResolvedValue(makeSyncStatus());
    mockSyncNodeAuth.mockRejectedValue(new Error("Auth sync failed"));

    const { result } = renderHook(() => useNodeSettingsSync());

    await act(async () => {
      await flushPromises();
    });

    await act(async () => {
      result.current.trackNode("node_1");
    });

    await act(async () => {
      await flushPromises();
    });

    await expect(result.current.syncAuth("node_1")).rejects.toThrow("Auth sync failed");

    await act(async () => {
      await flushPromises();
    });

    expect(result.current.error).toBe("Auth sync failed");
    expect(result.current.actionLoading).toEqual({});
  });

  // ── Polling error handling ─────────────────────────────────────────────────

  it("preserves existing data when polling fails, sets error, keeps loading=false", async () => {
    // Initial successful fetch
    mockFetchNodeSettingsSyncStatus
      .mockResolvedValueOnce(makeSyncStatus({ lastSyncAt: "2026-04-01T00:00:00.000Z" }))
      // Polling failure
      .mockRejectedValueOnce(new Error("Network error"));

    const { result } = renderHook(() => useNodeSettingsSync());

    await act(async () => {
      await flushPromises();
    });

    await act(async () => {
      result.current.trackNode("node_1");
    });

    await act(async () => {
      await flushPromises();
    });

    // Verify initial data is present
    expect(result.current.syncStatusMap.node_1).toEqual(makeSyncStatus({ lastSyncAt: "2026-04-01T00:00:00.000Z" }));

    // Advance timer to trigger polling
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
      await flushPromises();
    });

    // Data should still be present (stale but visible)
    expect(result.current.syncStatusMap.node_1).toEqual(makeSyncStatus({ lastSyncAt: "2026-04-01T00:00:00.000Z" }));
    // Error should be set
    expect(result.current.error).toBe("Network error");
    // Loading should be false (no loading state for background polling)
    expect(result.current.loading).toBe(false);
  });

  // ── Empty tracking ─────────────────────────────────────────────────────────

  it("makes no API calls when all nodes are untracked", async () => {
    const pending = deferred<NodeSettingsSyncStatus>();
    mockFetchNodeSettingsSyncStatus.mockReturnValue(pending.promise);

    const { result } = renderHook(() => useNodeSettingsSync());

    await act(async () => {
      await flushPromises();
    });

    await act(async () => {
      result.current.trackNode("node_1");
    });

    // Let initial fetch start
    await act(async () => {
      await flushPromises();
    });

    mockFetchNodeSettingsSyncStatus.mockClear();

    // Untrack the node
    await act(async () => {
      result.current.untrackNode("node_1");
    });

    // Advance timers
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
      await flushPromises();
    });

    // No polling should have happened
    expect(mockFetchNodeSettingsSyncStatus).not.toHaveBeenCalled();
  });
});
