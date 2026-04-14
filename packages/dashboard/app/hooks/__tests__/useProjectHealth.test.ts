import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useProjectHealth } from "../useProjectHealth";
import * as api from "../../api";
import type { ProjectHealth } from "../../api";

vi.mock("../../api", () => ({
  fetchProjectHealth: vi.fn(),
}));

const mockFetchProjectHealth = vi.mocked(api.fetchProjectHealth);

function createHealth(projectId: string, overrides: Partial<ProjectHealth> = {}): ProjectHealth {
  return {
    projectId,
    status: "active",
    activeTaskCount: 1,
    inFlightAgentCount: 0,
    totalTasksCompleted: 10,
    totalTasksFailed: 1,
    updatedAt: "2026-01-01T00:00:00.000Z",
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

function renderUseProjectHealth(projectIds: string[]) {
  return renderHook(({ ids }) => useProjectHealth(ids), {
    initialProps: { ids: projectIds },
  });
}

describe("useProjectHealth", () => {
  beforeEach(() => {
    mockFetchProjectHealth.mockReset();
    mockFetchProjectHealth.mockImplementation(async (id: string) => createHealth(id));
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("returns empty healthMap and no error when projectIds is empty", async () => {
    const { result } = renderUseProjectHealth([]);

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.healthMap).toEqual({});
    expect(result.current.error).toBeNull();
    expect(mockFetchProjectHealth).not.toHaveBeenCalled();
  });

  it("fetches health for each project ID and populates healthMap", async () => {
    const ids = ["p1", "p2", "p3"];
    const { result } = renderUseProjectHealth(ids);

    await waitFor(() => {
      expect(result.current.healthMap).toEqual({
        p1: createHealth("p1"),
        p2: createHealth("p2"),
        p3: createHealth("p3"),
      });
    });
  });

  it("sets loading true during fetch and false after completion", async () => {
    const pending = deferred<ProjectHealth>();
    mockFetchProjectHealth.mockReturnValueOnce(pending.promise);

    const { result } = renderUseProjectHealth(["p1"]);

    await waitFor(() => {
      expect(result.current.loading).toBe(true);
    });

    pending.resolve(createHealth("p1"));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
  });

  it("handles individual project fetch failures gracefully", async () => {
    mockFetchProjectHealth.mockImplementation(async (id: string) => {
      if (id === "p2") {
        throw new Error("fetch failed");
      }
      return createHealth(id);
    });

    const { result } = renderUseProjectHealth(["p1", "p2", "p3"]);

    await waitFor(() => {
      expect(result.current.healthMap).toEqual({
        p1: createHealth("p1"),
        p2: null,
        p3: createHealth("p3"),
      });
    });

    expect(result.current.error).toBeNull();
  });

  it("batches fetches with 5 concurrent per batch", async () => {
    const firstBatchDeferred = Array.from({ length: 5 }, () => deferred<ProjectHealth>());
    const called: string[] = [];

    mockFetchProjectHealth.mockImplementation((id: string) => {
      called.push(id);
      const index = Number(id.slice(1)) - 1;
      if (index < 5) return firstBatchDeferred[index].promise;
      return Promise.resolve(createHealth(id));
    });

    const ids = ["p1", "p2", "p3", "p4", "p5", "p6", "p7"];
    renderUseProjectHealth(ids);

    await waitFor(() => {
      expect(called).toEqual(["p1", "p2", "p3", "p4", "p5"]);
    });

    expect(called).not.toContain("p6");
    expect(called).not.toContain("p7");

    firstBatchDeferred.forEach((d, idx) => {
      d.resolve(createHealth(`p${idx + 1}`));
    });

    await waitFor(() => {
      expect(called).toContain("p6");
      expect(called).toContain("p7");
    });
  });

  it("refresh aborts in-flight requests when called again", async () => {
    const abortSpy = vi.spyOn(AbortController.prototype, "abort");
    const pending = deferred<ProjectHealth>();
    mockFetchProjectHealth.mockReturnValue(pending.promise);

    const { result } = renderUseProjectHealth(["p1"]);

    await waitFor(() => {
      expect(result.current.loading).toBe(true);
    });

    await act(async () => {
      void result.current.refresh();
    });

    expect(abortSpy).toHaveBeenCalled();

    pending.resolve(createHealth("p1"));
  });

  it("refreshProject updates a single project's health", async () => {
    mockFetchProjectHealth.mockImplementation(async (id: string) => createHealth(id));

    const { result } = renderUseProjectHealth(["p1", "p2"]);

    await waitFor(() => {
      expect(result.current.healthMap.p1).toEqual(createHealth("p1"));
      expect(result.current.healthMap.p2).toEqual(createHealth("p2"));
    });

    mockFetchProjectHealth.mockResolvedValueOnce(
      createHealth("p2", { activeTaskCount: 99, totalTasksCompleted: 42 }),
    );

    await act(async () => {
      await result.current.refreshProject("p2");
    });

    expect(result.current.healthMap.p2).toEqual(
      createHealth("p2", { activeTaskCount: 99, totalTasksCompleted: 42 }),
    );
    expect(result.current.healthMap.p1).toEqual(createHealth("p1"));
  });

  it("polling sets up interval and refreshes every 10 seconds", async () => {
    vi.useFakeTimers();
    mockFetchProjectHealth.mockResolvedValue(createHealth("p1"));

    renderUseProjectHealth(["p1"]);

    await act(async () => {
      await Promise.resolve();
    });

    expect(mockFetchProjectHealth).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
      await Promise.resolve();
    });

    expect(mockFetchProjectHealth).toHaveBeenCalledTimes(2);
  });

  it("polling clears interval on unmount", async () => {
    vi.useFakeTimers();
    mockFetchProjectHealth.mockResolvedValue(createHealth("p1"));

    const { unmount } = renderUseProjectHealth(["p1"]);

    await act(async () => {
      await Promise.resolve();
    });

    expect(mockFetchProjectHealth).toHaveBeenCalledTimes(1);

    unmount();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
      await Promise.resolve();
    });

    expect(mockFetchProjectHealth).toHaveBeenCalledTimes(1);
  });

  it("cleanup aborts in-flight requests on unmount", async () => {
    const abortSpy = vi.spyOn(AbortController.prototype, "abort");
    const pending = deferred<ProjectHealth>();
    mockFetchProjectHealth.mockReturnValue(pending.promise);

    const { unmount } = renderUseProjectHealth(["p1"]);

    await waitFor(() => {
      expect(mockFetchProjectHealth).toHaveBeenCalled();
    });

    unmount();

    expect(abortSpy).toHaveBeenCalled();

    pending.resolve(createHealth("p1"));
  });

  it("does not set loading to true during background polling refreshes", async () => {
    // This is a regression test for FN-1734: polling refreshes should NOT
    // set loading=true, as that would cause UI flicker and scroll position resets
    vi.useFakeTimers();
    mockFetchProjectHealth.mockResolvedValue(createHealth("p1"));

    const { result } = renderUseProjectHealth(["p1"]);

    // Flush initial effects
    await act(async () => {
      await Promise.resolve();
    });

    // Initial load should be complete - loading should be false
    expect(result.current.loading).toBe(false);
    expect(result.current.healthMap.p1).toEqual(createHealth("p1"));

    // Capture loading state before polling
    const loadingBeforePolling = result.current.loading;

    // Advance timer for polling refresh (10 seconds)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
      await Promise.resolve();
    });

    // After polling refresh: loading should still be false
    // (Regression: this was the bug - loading was set to true on every refresh)
    expect(result.current.loading).toBe(false);
    expect(loadingBeforePolling).toBe(false);

    // Health data should still be present
    expect(result.current.healthMap.p1).toEqual(createHealth("p1"));
  });

  it("handles projectIds transition from empty to non-empty correctly", async () => {
    // This tests that switching from no projects to having projects works correctly
    const { result, rerender } = renderUseProjectHealth([]);

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.healthMap).toEqual({});

    // Now switch to having projects
    rerender({ ids: ["p1"] });

    // Should start loading again for the new project
    await waitFor(() => {
      expect(result.current.loading).toBe(true);
    });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.healthMap.p1).toEqual(createHealth("p1"));
  });
});
