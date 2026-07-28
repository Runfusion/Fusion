import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runAutoUpdateCycle, startAutoUpdateWatcher } from "../auto-update.js";
import type { AutoUpdateDeps } from "../auto-update.js";

/*
FNXC:AutoUpdate 2026-07-25-10:05:
Contract for the unattended update watcher: opt-in only, supervised hosts only,
install before restart, never restart on a failed install.
*/

function makeDeps(overrides: Partial<AutoUpdateDeps> = {}): AutoUpdateDeps & {
  requestRestart: ReturnType<typeof vi.fn>;
  installUpdate: ReturnType<typeof vi.fn>;
  checkForUpdate: ReturnType<typeof vi.fn>;
} {
  const checkForUpdate = vi.fn().mockResolvedValue({
    currentVersion: "1.0.0",
    latestVersion: "2.0.0",
    updateAvailable: true,
    lastChecked: 0,
  });
  const installUpdate = vi.fn().mockResolvedValue({
    currentVersion: "1.0.0",
    latestVersion: "2.0.0",
    updated: true,
  });
  return {
    getSettings: async () => ({ autoUpdateAndRestart: true }),
    currentVersion: "1.0.0",
    supervised: true,
    requestRestart: vi.fn().mockReturnValue(true),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    fusionDir: "/tmp/fusion-auto-update-test",
    checkForUpdate,
    installUpdate,
    ...overrides,
  } as never;
}

describe("runAutoUpdateCycle", () => {
  it("installs and restarts when enabled on a supervised host", async () => {
    const deps = makeDeps();

    await expect(runAutoUpdateCycle(deps)).resolves.toBe("restarting");

    expect(deps.installUpdate).toHaveBeenCalledWith("1.0.0", "2.0.0", { fusionDir: deps.fusionDir });
    expect(deps.requestRestart).toHaveBeenCalledWith("auto-update");
  });

  it("does nothing when the setting is off (default)", async () => {
    const deps = makeDeps({ getSettings: async () => ({}) });

    await expect(runAutoUpdateCycle(deps)).resolves.toBe("disabled");

    expect(deps.checkForUpdate).not.toHaveBeenCalled();
    expect(deps.requestRestart).not.toHaveBeenCalled();
  });

  it("does nothing when update checks are disabled", async () => {
    const deps = makeDeps({
      getSettings: async () => ({ autoUpdateAndRestart: true, updateCheckEnabled: false }),
    });

    await expect(runAutoUpdateCycle(deps)).resolves.toBe("checks-disabled");
    expect(deps.checkForUpdate).not.toHaveBeenCalled();
  });

  it("never installs on an unsupervised host", async () => {
    const deps = makeDeps({ supervised: false });

    await expect(runAutoUpdateCycle(deps)).resolves.toBe("unsupervised");

    expect(deps.checkForUpdate).not.toHaveBeenCalled();
    expect(deps.installUpdate).not.toHaveBeenCalled();
    expect(deps.requestRestart).not.toHaveBeenCalled();
  });

  it("treats unreadable settings as opted out", async () => {
    const deps = makeDeps({
      getSettings: async () => {
        throw new Error("settings unavailable");
      },
    });

    await expect(runAutoUpdateCycle(deps)).resolves.toBe("disabled");
    expect(deps.installUpdate).not.toHaveBeenCalled();
  });

  it("passes the configured release channel to the check", async () => {
    const deps = makeDeps({
      getSettings: async () => ({ autoUpdateAndRestart: true, updateChannel: "beta" }),
    });

    await runAutoUpdateCycle(deps);

    expect(deps.checkForUpdate).toHaveBeenCalledWith("/tmp/fusion-auto-update-test", "1.0.0", {
      force: true,
      channel: "beta",
    });
  });

  it("does not install or restart when already up to date", async () => {
    const deps = makeDeps();
    deps.checkForUpdate.mockResolvedValue({
      currentVersion: "1.0.0",
      latestVersion: "1.0.0",
      updateAvailable: false,
      lastChecked: 0,
    });

    await expect(runAutoUpdateCycle(deps)).resolves.toBe("up-to-date");
    expect(deps.installUpdate).not.toHaveBeenCalled();
    expect(deps.requestRestart).not.toHaveBeenCalled();
  });

  it("never restarts when the install fails", async () => {
    const deps = makeDeps();
    deps.installUpdate.mockResolvedValue({
      currentVersion: "1.0.0",
      latestVersion: "2.0.0",
      updated: false,
      error: "npm exploded",
    });

    await expect(runAutoUpdateCycle(deps)).resolves.toBe("install-failed");
    expect(deps.requestRestart).not.toHaveBeenCalled();
  });

  it("reports a rejected install without throwing", async () => {
    const deps = makeDeps();
    deps.installUpdate.mockRejectedValue(new Error("EACCES"));

    await expect(runAutoUpdateCycle(deps)).resolves.toBe("install-failed");
    expect(deps.requestRestart).not.toHaveBeenCalled();
  });

  it("reports a failed check without installing", async () => {
    const deps = makeDeps();
    deps.checkForUpdate.mockResolvedValue({
      currentVersion: "1.0.0",
      latestVersion: null,
      updateAvailable: false,
      lastChecked: 0,
      error: "registry unreachable",
    });

    await expect(runAutoUpdateCycle(deps)).resolves.toBe("check-failed");
    expect(deps.installUpdate).not.toHaveBeenCalled();
  });

  it("surfaces an installed update whose restart could not be scheduled", async () => {
    const deps = makeDeps();
    deps.requestRestart.mockReturnValue(false);

    await expect(runAutoUpdateCycle(deps)).resolves.toBe("restart-unavailable");
    expect(deps.log.warn).toHaveBeenCalled();
  });
});

describe("startAutoUpdateWatcher", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs a first cycle after the initial delay and stops once a restart is scheduled", async () => {
    const deps = makeDeps();

    const stop = startAutoUpdateWatcher(deps, { initialDelayMs: 1_000, intervalMs: 10_000 });

    expect(deps.checkForUpdate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(deps.checkForUpdate).toHaveBeenCalledTimes(1);

    // The process is shutting down for the restart — no further cycles.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(deps.checkForUpdate).toHaveBeenCalledTimes(1);
    stop();
  });

  it("keeps polling while no update is available", async () => {
    const deps = makeDeps();
    deps.checkForUpdate.mockResolvedValue({
      currentVersion: "1.0.0",
      latestVersion: "1.0.0",
      updateAvailable: false,
      lastChecked: 0,
    });

    const stop = startAutoUpdateWatcher(deps, { initialDelayMs: 1_000, intervalMs: 10_000 });

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(deps.checkForUpdate).toHaveBeenCalledTimes(3);

    stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(deps.checkForUpdate).toHaveBeenCalledTimes(3);
  });

  it("never overlaps cycles when an install outlives the interval", async () => {
    const deps = makeDeps();
    let releaseInstall: (() => void) | undefined;
    deps.installUpdate.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseInstall = () => resolve({ currentVersion: "1.0.0", latestVersion: "2.0.0", updated: true });
        }),
    );

    const stop = startAutoUpdateWatcher(deps, { initialDelayMs: 1_000, intervalMs: 5_000 });

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(20_000);

    expect(deps.checkForUpdate).toHaveBeenCalledTimes(1);
    expect(deps.installUpdate).toHaveBeenCalledTimes(1);

    releaseInstall?.();
    stop();
  });
});
