import { describe, expect, it, vi } from "vitest";
import type { ProviderUsage } from "../usage.js";
import {
  hasUsableProviderCapacity,
  ProviderHealthMonitor,
  providerIdFromRateLimitReason,
} from "../provider-health-monitor.js";

function providerUsage(overrides: Partial<ProviderUsage> = {}): ProviderUsage {
  return {
    name: "Claude",
    icon: "test",
    status: "ok",
    windows: [{
      label: "Weekly",
      percentUsed: 40,
      percentLeft: 60,
      resetText: "resets in 4d",
    }],
    ...overrides,
  };
}

function createStore(tasks: Array<Record<string, unknown>>) {
  return {
    listTasks: vi.fn().mockResolvedValue(tasks),
    logEntry: vi.fn().mockResolvedValue(undefined),
    pauseTask: vi.fn().mockImplementation(async (id: string, paused: boolean) => {
      const task = tasks.find((candidate) => candidate.id === id);
      if (task) {
        task.paused = paused || undefined;
        if (!paused) task.pausedReason = undefined;
      }
    }),
  } as any;
}

function createLogger() {
  return {
    scope: "test",
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  } as any;
}

describe("ProviderHealthMonitor", () => {
  it("derives only provider-qualified rate-limit parks", () => {
    expect(providerIdFromRateLimitReason("provider-rate-limit:Anthropic")).toBe("anthropic");
    expect(providerIdFromRateLimitReason("provider-rate-limit")).toBeNull();
    expect(providerIdFromRateLimitReason("manual")).toBeNull();
  });

  it("requires positive auth and non-exhausted metered capacity", () => {
    expect(hasUsableProviderCapacity(providerUsage())).toBe(true);
    expect(hasUsableProviderCapacity(providerUsage({ status: "no-auth" }))).toBe(false);
    expect(hasUsableProviderCapacity(providerUsage({ status: "error", error: "HTTP 429" }))).toBe(false);
    expect(hasUsableProviderCapacity(providerUsage({ windows: [] }))).toBe(false);
    expect(hasUsableProviderCapacity(providerUsage({
      windows: [{ label: "Weekly", percentUsed: 100, percentLeft: 0, resetText: "resets in 1h" }],
    }))).toBe(false);
  });

  it("probes a persisted unavailable provider once and resumes exact matching parks across projects", async () => {
    const claudeStoreA = createStore([
      { id: "FN-1", paused: true, pausedReason: "provider-rate-limit:anthropic" },
      { id: "FN-2", paused: true, pausedReason: "manual" },
    ]);
    const claudeStoreB = createStore([
      { id: "FN-3", paused: true, pausedReason: "provider-rate-limit:anthropic" },
      { id: "FN-4", paused: true, userPaused: true, pausedReason: "provider-rate-limit:anthropic" },
      { id: "FN-5", paused: true, pausedReason: "provider-rate-limit:openai-codex" },
    ]);
    const probe = vi.fn().mockImplementation(async (providerId: string) =>
      providerId === "anthropic"
        ? providerUsage()
        : providerUsage({ name: "Codex", status: "error", error: "HTTP 429" }));
    const logger = createLogger();
    const monitor = new ProviderHealthMonitor({
      getStores: () => [claudeStoreA, claudeStoreB],
      logger,
      probe,
    });

    await monitor.checkNow();

    expect(probe).toHaveBeenCalledTimes(2);
    expect(probe).toHaveBeenCalledWith("anthropic", undefined);
    expect(probe).toHaveBeenCalledWith("openai-codex", undefined);
    expect(claudeStoreA.pauseTask).toHaveBeenCalledWith("FN-1", false);
    expect(claudeStoreA.pauseTask).not.toHaveBeenCalledWith("FN-2", false);
    expect(claudeStoreB.pauseTask).toHaveBeenCalledWith("FN-3", false);
    expect(claudeStoreB.pauseTask).not.toHaveBeenCalledWith("FN-4", false);
    expect(claudeStoreB.pauseTask).not.toHaveBeenCalledWith("FN-5", false);
    expect(logger.info).toHaveBeenCalledWith(
      "Provider available again; resumed provider-paused tasks",
      { providerId: "anthropic", recoveredTasks: 2 },
    );
  });

  it.each([
    providerUsage({ status: "no-auth", error: "login required" }),
    providerUsage({ status: "error", error: "HTTP 429" }),
    providerUsage({ windows: [{ label: "Weekly", percentUsed: 100, percentLeft: 0, resetText: null }] }),
  ])("keeps tasks parked without using task execution as a recovery probe", async (usage) => {
    const store = createStore([
      { id: "FN-10", paused: true, pausedReason: "provider-rate-limit:anthropic" },
    ]);
    const monitor = new ProviderHealthMonitor({
      getStores: () => [store],
      logger: createLogger(),
      probe: vi.fn().mockResolvedValue(usage),
    });

    await monitor.checkNow();

    expect(store.pauseTask).not.toHaveBeenCalled();
  });
});
