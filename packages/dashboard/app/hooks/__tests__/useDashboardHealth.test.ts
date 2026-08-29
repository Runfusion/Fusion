import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

const fetchDashboardHealth = vi.fn();
const refreshDashboardHealth = vi.fn();
vi.mock("../../api", () => ({
  fetchDashboardHealth: (...a: unknown[]) => fetchDashboardHealth(...a),
  refreshDashboardHealth: (...a: unknown[]) => refreshDashboardHealth(...a),
}));

import { useDashboardHealth } from "../useDashboardHealth";

describe("useDashboardHealth", () => {
  beforeEach(() => {
    fetchDashboardHealth.mockReset();
    refreshDashboardHealth.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("seeds health from the mount fetch and falls back to null on failure", async () => {
    fetchDashboardHealth.mockResolvedValue({ status: "ok" });
    const { result } = renderHook(() => useDashboardHealth());

    await waitFor(() => expect(result.current.health).toEqual({ status: "ok" }));

    fetchDashboardHealth.mockResolvedValue(undefined);
    fetchDashboardHealth.mockRejectedValue(new Error("boom"));
    const failing = renderHook(() => useDashboardHealth());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(failing.result.current.health).toBeNull();
  });

  it("refresh sets refreshing, updates health, and clears refreshing on success", async () => {
    fetchDashboardHealth.mockResolvedValue(null);
    refreshDashboardHealth.mockResolvedValue({ status: "degraded" });
    const { result } = renderHook(() => useDashboardHealth());

    await act(async () => {
      await result.current.refresh();
    });

    expect(refreshDashboardHealth).toHaveBeenCalledTimes(1);
    expect(result.current.health).toEqual({ status: "degraded" });
    expect(result.current.refreshing).toBe(false);
    expect(result.current.refreshError).toBeNull();
  });

  it("refresh records an error message on failure", async () => {
    fetchDashboardHealth.mockResolvedValue(null);
    refreshDashboardHealth.mockRejectedValue(new Error("nope"));
    const { result } = renderHook(() => useDashboardHealth());

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.refreshError).toBe("nope");
    expect(result.current.refreshing).toBe(false);
  });

  it("polls health so a transient unavailable desktop startup response is replaced", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fetchDashboardHealth
      .mockResolvedValueOnce({ status: "ok", engine: { available: false } })
      .mockResolvedValueOnce({ status: "ok", engine: { available: true } });

    const { result } = renderHook(() => useDashboardHealth());

    await waitFor(() => expect(result.current.health).toEqual({ status: "ok", engine: { available: false } }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });

    await waitFor(() => expect(result.current.health).toEqual({ status: "ok", engine: { available: true } }));
    expect(fetchDashboardHealth).toHaveBeenCalledTimes(2);
  });
  it("fires the mount fetch and tolerates an unmount before it resolves", async () => {
    let resolveMount: (value: { status: string }) => void = () => {};
    fetchDashboardHealth.mockImplementation(
      () =>
        new Promise<{ status: string }>((resolve) => {
          resolveMount = resolve;
        }),
    );

    const { result, unmount } = renderHook(() => useDashboardHealth());
    // The effect has fired the mount fetch; health starts null until it settles.
    expect(fetchDashboardHealth).toHaveBeenCalledTimes(1);
    expect(result.current.health).toBeNull();

    // Unmount while the fetch is still in flight, then resolve it.
    unmount();
    resolveMount({ status: "ok" });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // NOTE: the effect's `cancelled` guard defensively suppresses setHealth
    // after unmount, but under React 19 setState on an unmounted component is
    // silently dropped — `result.current.health` stays null *whether or not the
    // guard exists*. Asserting state here would give false confidence (the test
    // passes even with the guard removed), so the guard is treated as a
    // React-19-untestable-via-state invariant and is intentionally NOT asserted
    // here. Verified empirically: removing the guard leaves the suite green.
  });
});
