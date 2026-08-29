import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEngineStatus } from "../useEngineStatus";
import * as api from "../../api";

vi.mock("../../api", () => ({
  fetchEngineStatus: vi.fn(),
  startEngine: vi.fn(),
}));

const mockFetchEngineStatus = vi.mocked(api.fetchEngineStatus);
const mockStartEngine = vi.mocked(api.startEngine);

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("useEngineStatus", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockFetchEngineStatus.mockReset();
    mockStartEngine.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fetches project-scoped engine status on mount", async () => {
    mockFetchEngineStatus.mockResolvedValueOnce({ connected: false, starting: false, canStart: true, projectId: "project-a" });

    const { result } = renderHook(() => useEngineStatus("project-a"));

    await act(async () => {
      await flushPromises();
    });

    expect(mockFetchEngineStatus).toHaveBeenCalledWith("project-a");
    expect(result.current.loading).toBe(false);
    expect(result.current.status).toEqual({ connected: false, starting: false, canStart: true, projectId: "project-a" });
    expect(result.current.canStart).toBe(true);
    expect(result.current.starting).toBe(false);
  });

  it("does not fetch or render stale status when no project is selected", async () => {
    const { result } = renderHook(() => useEngineStatus(undefined));

    await act(async () => {
      await flushPromises();
      await vi.advanceTimersByTimeAsync(10000);
    });

    expect(mockFetchEngineStatus).not.toHaveBeenCalled();
    expect(result.current.loading).toBe(false);
    expect(result.current.status).toBeNull();
    expect(result.current.canStart).toBe(false);
  });

  it("polls while disconnected and pauses polling once connected", async () => {
    mockFetchEngineStatus
      .mockResolvedValueOnce({ connected: false, starting: false, canStart: true, projectId: "project-a" })
      .mockResolvedValueOnce({ connected: true, starting: false, canStart: true, projectId: "project-a" });

    const { result } = renderHook(() => useEngineStatus("project-a"));

    await act(async () => {
      await flushPromises();
    });
    expect(result.current.status?.connected).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
      await flushPromises();
    });
    expect(result.current.status?.connected).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30000);
      await flushPromises();
    });
    expect(mockFetchEngineStatus).toHaveBeenCalledTimes(2);
  });

  it("treats status fetch failures as disconnected without enabling start", async () => {
    mockFetchEngineStatus.mockRejectedValueOnce(new Error("network down"));

    const { result } = renderHook(() => useEngineStatus("project-a"));

    await act(async () => {
      await flushPromises();
    });

    expect(result.current.status).toEqual({ connected: false, starting: false, canStart: false, reason: "unreachable", projectId: "project-a" });
    expect(result.current.canStart).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("starts the engine, exposes local in-flight state, and immediately refetches", async () => {
    mockFetchEngineStatus
      .mockResolvedValueOnce({ connected: false, starting: false, canStart: true, projectId: "project-a" })
      .mockResolvedValueOnce({ connected: true, starting: false, canStart: true, projectId: "project-a" });
    let resolveStart!: (status: { connected: boolean; starting: boolean; canStart: boolean; projectId: string }) => void;
    mockStartEngine.mockReturnValueOnce(new Promise((resolve) => {
      resolveStart = resolve;
    }));

    const { result } = renderHook(() => useEngineStatus("project-a"));
    await act(async () => {
      await flushPromises();
    });

    let startPromise!: Promise<void>;
    await act(async () => {
      startPromise = result.current.start();
      await flushPromises();
    });
    expect(result.current.starting).toBe(true);

    await act(async () => {
      resolveStart({ connected: false, starting: true, canStart: true, projectId: "project-a" });
      await startPromise;
      await flushPromises();
    });

    expect(mockStartEngine).toHaveBeenCalledWith("project-a");
    expect(mockFetchEngineStatus).toHaveBeenCalledTimes(2);
    expect(result.current.status).toEqual({ connected: true, starting: false, canStart: true, projectId: "project-a" });
    expect(result.current.starting).toBe(false);
  });

  it("surfaces start failures without throwing away the disconnected status", async () => {
    mockFetchEngineStatus.mockResolvedValueOnce({ connected: false, starting: false, canStart: true, projectId: "project-a" });
    mockStartEngine.mockRejectedValueOnce(new Error("start failed"));

    const { result } = renderHook(() => useEngineStatus("project-a"));
    await act(async () => {
      await flushPromises();
    });

    await act(async () => {
      await result.current.start();
    });

    expect(result.current.error).toBe("start failed");
    expect(result.current.status).toEqual({ connected: false, starting: false, canStart: true, projectId: "project-a" });
    expect(result.current.starting).toBe(false);
  });

  it("immediately refetches when the project changes", async () => {
    mockFetchEngineStatus
      .mockResolvedValueOnce({ connected: false, starting: false, canStart: true, projectId: "project-a" })
      .mockResolvedValueOnce({ connected: true, starting: false, canStart: true, projectId: "project-b" });

    const { result, rerender } = renderHook(({ projectId }) => useEngineStatus(projectId), {
      initialProps: { projectId: "project-a" },
    });
    await act(async () => {
      await flushPromises();
    });
    expect(result.current.status?.projectId).toBe("project-a");

    rerender({ projectId: "project-b" });
    await act(async () => {
      await flushPromises();
    });

    expect(mockFetchEngineStatus).toHaveBeenNthCalledWith(2, "project-b");
    expect(result.current.status).toEqual({ connected: true, starting: false, canStart: true, projectId: "project-b" });
  });
});
