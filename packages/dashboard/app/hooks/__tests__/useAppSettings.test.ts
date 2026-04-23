import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useAppSettings } from "../useAppSettings";
import * as api from "../../api";

vi.mock("../../api", () => ({
  fetchConfig: vi.fn(),
  fetchSettings: vi.fn(),
  updateSettings: vi.fn(),
}));

const mockFetchConfig = vi.mocked(api.fetchConfig);
const mockFetchSettings = vi.mocked(api.fetchSettings);
const mockUpdateSettings = vi.mocked(api.updateSettings);

describe("useAppSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockFetchConfig.mockResolvedValue({
      maxConcurrent: 4,
      rootDir: "/workspace/project",
    });

    mockFetchSettings.mockResolvedValue({
      autoMerge: false,
      globalPause: true,
      enginePaused: false,
      prAuthAvailable: true,
      taskStuckTimeoutMs: 600000,
      showQuickChatFAB: false,
    } as never);

    mockUpdateSettings.mockResolvedValue({} as never);
  });

  it("loads settings state from API", async () => {
    const { result } = renderHook(() => useAppSettings("proj_123"));

    await waitFor(() => {
      expect(result.current.maxConcurrent).toBe(4);
      expect(result.current.rootDir).toBe("/workspace/project");
      expect(result.current.autoMerge).toBe(false);
      expect(result.current.globalPaused).toBe(true);
      expect(result.current.enginePaused).toBe(false);
      expect(result.current.prAuthAvailable).toBe(true);
      expect(result.current.taskStuckTimeoutMs).toBe(600000);
      expect(result.current.showQuickChatFAB).toBe(false);
    });

    expect(mockFetchConfig).toHaveBeenCalledWith("proj_123");
    expect(mockFetchSettings).toHaveBeenCalledWith("proj_123");
  });

  it("optimistically toggles autoMerge and persists to API", async () => {
    const { result } = renderHook(() => useAppSettings("proj_123"));

    await waitFor(() => {
      expect(result.current.autoMerge).toBe(false);
    });

    await act(async () => {
      await result.current.toggleAutoMerge();
    });

    expect(result.current.autoMerge).toBe(true);
    expect(mockUpdateSettings).toHaveBeenCalledWith({ autoMerge: true }, "proj_123");
  });

  it("rolls back optimistic state when toggle update fails", async () => {
    mockUpdateSettings.mockRejectedValueOnce(new Error("network"));

    const { result } = renderHook(() => useAppSettings("proj_123"));

    await waitFor(() => {
      expect(result.current.globalPaused).toBe(true);
    });

    await act(async () => {
      await result.current.toggleGlobalPause();
    });

    expect(result.current.globalPaused).toBe(true);
    expect(mockUpdateSettings).toHaveBeenCalledWith(
      { globalPause: false, globalPauseReason: undefined },
      "proj_123",
    );
  });

  it("sets globalPauseReason to manual when pausing", async () => {
    mockFetchSettings.mockResolvedValueOnce({
      autoMerge: false,
      globalPause: false,
      enginePaused: false,
      prAuthAvailable: true,
      taskStuckTimeoutMs: 600000,
      showQuickChatFAB: false,
    } as never);

    const { result } = renderHook(() => useAppSettings("proj_123"));

    await waitFor(() => {
      expect(result.current.globalPaused).toBe(false);
    });

    await act(async () => {
      await result.current.toggleGlobalPause();
    });

    expect(result.current.globalPaused).toBe(true);
    expect(mockUpdateSettings).toHaveBeenCalledWith(
      { globalPause: true, globalPauseReason: "manual" },
      "proj_123",
    );
  });

  it("refresh() re-fetches and updates state", async () => {
    const { result } = renderHook(() => useAppSettings("proj_123"));

    // Initial state from first mock
    await waitFor(() => {
      expect(result.current.showQuickChatFAB).toBe(false);
    });

    // Change mock to return different value
    mockFetchSettings.mockResolvedValueOnce({
      autoMerge: false,
      globalPause: true,
      enginePaused: false,
      prAuthAvailable: true,
      taskStuckTimeoutMs: 600000,
      showQuickChatFAB: true,
    } as never);

    // Call refresh
    await act(async () => {
      await result.current.refresh();
    });

    // Verify state was updated
    await waitFor(() => {
      expect(result.current.showQuickChatFAB).toBe(true);
    });

    // Verify fetchSettings was called again with correct projectId
    expect(mockFetchSettings).toHaveBeenCalledWith("proj_123");
  });

  it("refresh() tolerates partial fetch failure", async () => {
    mockFetchConfig.mockRejectedValueOnce(new Error("network"));

    const { result } = renderHook(() => useAppSettings("proj_123"));

    // settings should still be set even though config failed
    await waitFor(() => {
      expect(result.current.autoMerge).toBe(false);
    });

    // config defaults remain (maxConcurrent stays at initial 2)
    expect(result.current.maxConcurrent).toBe(2);
  });
});
