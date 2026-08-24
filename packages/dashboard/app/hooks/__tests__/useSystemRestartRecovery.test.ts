import { createElement } from "react";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __test_resetSystemRestartRecovery, systemRestartRecovery, useSystemRestartRecovery } from "../useSystemRestartRecovery";

const mockFetchSystemInfo = vi.hoisted(() => vi.fn());
const mockFetchDashboardHealth = vi.hoisted(() => vi.fn());

vi.mock("../../api", () => ({
  fetchSystemInfo: (...args: unknown[]) => mockFetchSystemInfo(...args),
  fetchDashboardHealth: (...args: unknown[]) => mockFetchDashboardHealth(...args),
}));

function RecoveryProbe() {
  const recovery = useSystemRestartRecovery();
  return createElement("output", undefined, `${recovery.phase}:${recovery.version ?? ""}`);
}

async function flushRecovery() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("systemRestartRecovery", () => {
  const reload = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("location", { reload });
    reload.mockReset();
    mockFetchSystemInfo.mockReset();
    mockFetchDashboardHealth.mockReset();
    __test_resetSystemRestartRecovery();
  });

  afterEach(() => {
    __test_resetSystemRestartRecovery();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("waits through old, unavailable, and boot-holding hosts before reloading the installed version once", async () => {
    mockFetchSystemInfo
      .mockResolvedValueOnce({ pid: 10 })
      .mockResolvedValueOnce({ pid: 11 })
      .mockResolvedValueOnce({ pid: 12 })
      .mockResolvedValueOnce({ pid: 13 });
    mockFetchDashboardHealth
      .mockResolvedValueOnce({ version: "0.77.0-beta.2", status: "ok" })
      .mockRejectedValueOnce(new Error("host is restarting"))
      .mockResolvedValueOnce({ version: "0.77.0-beta.4", status: "starting", holding: true })
      .mockResolvedValueOnce({ version: "0.77.0-beta.4", status: "degraded", holding: false });
    render(createElement(RecoveryProbe));

    act(() => systemRestartRecovery.arm("0.77.0-beta.4", 10));
    await flushRecovery();
    expect(screen.getByText("waiting:0.77.0-beta.4")).toBeInTheDocument();

    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });

    expect(screen.getByText("back:0.77.0-beta.4")).toBeInTheDocument();
    expect(reload).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("times out a never-settling readiness request and fences its late success", async () => {
    let resolveInfo: ((value: { pid: number }) => void) | undefined;
    mockFetchSystemInfo.mockImplementationOnce(() => new Promise((resolve) => { resolveInfo = resolve; }));
    mockFetchDashboardHealth.mockResolvedValue({ version: "0.77.0-beta.4", status: "ok" });
    render(createElement(RecoveryProbe));

    act(() => systemRestartRecovery.arm("0.77.0-beta.4", 10));
    await act(async () => { await vi.advanceTimersByTimeAsync(90_000); });

    expect(systemRestartRecovery.getSnapshot()).toEqual({ phase: "timeout", version: "0.77.0-beta.4" });
    expect(reload).not.toHaveBeenCalled();
    await act(async () => { resolveInfo?.({ pid: 11 }); });
    expect(systemRestartRecovery.getSnapshot()).toEqual({ phase: "timeout", version: "0.77.0-beta.4" });
    expect(reload).not.toHaveBeenCalled();
  });

  it("fences an in-flight generation and lets a retry generation poll without overlap", async () => {
    let resolveFirst: ((value: { pid: number }) => void) | undefined;
    mockFetchSystemInfo.mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }));
    mockFetchDashboardHealth.mockResolvedValue({ version: "0.77.0-beta.4", status: "ok" });
    render(createElement(RecoveryProbe));

    act(() => systemRestartRecovery.arm("0.77.0-beta.4", 10));
    act(() => systemRestartRecovery.arm("0.77.0-beta.4", 10));
    expect(mockFetchSystemInfo).toHaveBeenCalledTimes(1);

    await act(async () => { resolveFirst?.({ pid: 10 }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(mockFetchSystemInfo).toHaveBeenCalledTimes(2);
  });

  it("times out and allows a fresh retry after the initiating component unmounts", async () => {
    mockFetchSystemInfo.mockResolvedValue({ pid: 10 });
    mockFetchDashboardHealth.mockResolvedValue({ version: "wrong-version", status: "ok" });
    const mounted = render(createElement(RecoveryProbe));

    act(() => systemRestartRecovery.arm("0.77.0-beta.4", 10));
    mounted.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(90_000); });
    expect(systemRestartRecovery.getSnapshot()).toEqual({ phase: "timeout", version: "0.77.0-beta.4" });

    mockFetchSystemInfo.mockResolvedValue({ pid: 11 });
    mockFetchDashboardHealth.mockResolvedValue({ version: "0.77.0-beta.4", status: "ok" });
    act(() => systemRestartRecovery.retry());
    await flushRecovery();
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
