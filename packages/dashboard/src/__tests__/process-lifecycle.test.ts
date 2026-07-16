import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const DASHBOARD_MODULES_WITH_BEFORE_EXIT_CLEANUP = [
  "../agent-generation.js",
  "../ai-refine.js",
  "../planning.js",
  "../subtask-breakdown.js",
  "../mission-interview.js",
  "../milestone-slice-interview.js",
  "../server.js",
] as const;

async function importProcessLifecycle() {
  return import("../process-lifecycle.js");
}

async function resetDashboardBeforeExitRegistry(): Promise<void> {
  const lifecycle = await importProcessLifecycle();
  lifecycle.__resetBeforeExitRegistryForTests();
}

describe("dashboard process lifecycle cleanup", () => {
  beforeEach(async () => {
    await resetDashboardBeforeExitRegistry();
    vi.resetModules();
  });

  afterEach(async () => {
    await resetDashboardBeforeExitRegistry();
    vi.resetModules();
  });

  it("keeps one dashboard beforeExit listener across repeated module evaluation", async () => {
    const warnings: Error[] = [];
    const onWarning = (warning: Error) => {
      warnings.push(warning);
    };
    process.on("warning", onWarning);
    const baselineListeners = process.listenerCount("beforeExit");

    try {
      for (let iteration = 0; iteration < 15; iteration += 1) {
        vi.resetModules();
        for (const modulePath of DASHBOARD_MODULES_WITH_BEFORE_EXIT_CLEANUP) {
          await import(modulePath);
        }
      }
    } finally {
      process.off("warning", onWarning);
    }

    const addedListeners = process.listenerCount("beforeExit") - baselineListeners;
    /*
    FNXC:DashboardProcessLifecycle 2026-07-16-08:28:
    This suite owns the dashboard's beforeExit registration invariant. The host
    process may independently register exit cleanup listeners, so only a
    beforeExit MaxListeners warning proves this module-evaluation regression.
    */
    const maxListenerWarnings = warnings.filter(
      (warning) => warning.name === "MaxListenersExceededWarning" && (warning as { type?: string }).type === "beforeExit",
    );

    expect(addedListeners).toBeLessThanOrEqual(1);
    expect(maxListenerWarnings).toEqual([]);
  });

  it("runs every cleanup registered behind the shared beforeExit listener", async () => {
    const lifecycle = await importProcessLifecycle();
    const cleanupOne = vi.fn();
    const cleanupTwo = vi.fn();

    lifecycle.registerBeforeExitCleanup(cleanupOne);
    lifecycle.registerBeforeExitCleanup(cleanupTwo);

    expect(lifecycle.__getBeforeExitCleanupCount()).toBe(2);

    lifecycle.__runBeforeExitCleanupsForTests();

    expect(cleanupOne).toHaveBeenCalledOnce();
    expect(cleanupTwo).toHaveBeenCalledOnce();
  });
});
