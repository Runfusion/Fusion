import { beforeEach, describe, expect, it, vi } from "vitest";
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
  it("does not apply the mount fetch after unmount", async () => {
    let resolveMount: (value: { status: string }) => void = () => {};
    fetchDashboardHealth.mockImplementation(
      () =>
        new Promise<{ status: string }>((resolve) => {
          resolveMount = resolve;
        }),
    );

    const { result, unmount } = renderHook(() => useDashboardHealth());
    expect(result.current.health).toBeNull();

    unmount();
    resolveMount({ status: "ok" });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // The cancelled flag suppresses setState — health stays at its initial null.
    expect(result.current.health).toBeNull();
  });
});
