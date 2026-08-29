import { describe, expect, it, vi } from "vitest";
import { DashboardTUI } from "../controller.js";
import {
  DASHBOARD_STARTUP_STATUS,
  runTuiStartupPrelude,
} from "../../dashboard-startup-chain.js";

describe("dashboard startup chain", () => {
  it("exposes isReady and startupDurationMs on snapshot", () => {
    const controller = new DashboardTUI();
    controller.setSystemInfo({
      host: "localhost",
      port: 4040,
      baseUrl: "http://localhost:4040",
      authEnabled: false,
      engineMode: "active",
      fileWatcher: true,
      startTimeMs: Date.now(),
      startupDurationMs: 1234,
    });
    controller.setReady(true);

    const snapshot = controller.getSnapshot();
    expect(snapshot.isReady).toBe(true);
    expect(snapshot.systemInfo?.startupDurationMs).toBe(1234);
  });

  // Keep this helper-focused so we can validate startup ordering without
  // importing runDashboard() and all of its heavy runtime dependencies.
  it("yields once after start before first loading status", async () => {
    const calls: string[] = [];
    const tui = {
      start: vi.fn(async () => {
        calls.push("start");
      }),
      setLoadingStatus: vi.fn((status: string) => {
        calls.push(`status:${status}`);
      }),
    };
    const yieldFn = vi.fn(async () => {
      calls.push("yield");
    });

    await runTuiStartupPrelude(tui, yieldFn);

    expect(calls).toEqual([
      "start",
      "yield",
      `status:${DASHBOARD_STARTUP_STATUS.initializingTaskStore}`,
    ]);
    expect(yieldFn).toHaveBeenCalledTimes(1);
  });

  it("exports the startup status labels in order", () => {
    expect(Object.values(DASHBOARD_STARTUP_STATUS)).toEqual([
      "Initializing task store…",
      "Starting file watcher…",
      "Initializing agent store…",
      "Starting agents…",
      "Loading extensions…",
      "Starting engine…",
    ]);
  });
});
