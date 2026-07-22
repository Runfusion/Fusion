import { describe, expect, it, vi } from "vitest";
import type { ProviderUsage } from "../usage.js";
import {
  hasUsableProviderCapacity,
  ProviderHealthMonitor,
  hasIndependentProviderHealthProbe,
  providerHealthProbeDelayMs,
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
  it("derives provider-qualified and legacy unqualified rate-limit parks", () => {
    expect(providerIdFromRateLimitReason("provider-rate-limit:Anthropic")).toBe("anthropic");
    expect(providerIdFromRateLimitReason("provider-rate-limit")).toBe("unknown");
    expect(providerIdFromRateLimitReason("manual")).toBeNull();
  });

  it("identifies providers with independent capacity meters", () => {
    expect(hasIndependentProviderHealthProbe("Anthropic")).toBe(true);
    expect(hasIndependentProviderHealthProbe("openai-codex")).toBe(true);
    expect(hasIndependentProviderHealthProbe("openrouter")).toBe(false);
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

  it("checks at five-minute cadence five times, then backs off to a one-hour cap", () => {
    expect(providerHealthProbeDelayMs(1)).toBe(300_000);
    expect(providerHealthProbeDelayMs(4)).toBe(300_000);
    expect(providerHealthProbeDelayMs(5)).toBe(600_000);
    expect(providerHealthProbeDelayMs(6)).toBe(1_200_000);
    expect(providerHealthProbeDelayMs(7)).toBe(2_400_000);
    expect(providerHealthProbeDelayMs(8)).toBe(3_600_000);
    expect(providerHealthProbeDelayMs(20)).toBe(3_600_000);
  });

  it("does not re-probe before a provider's growing backoff expires", async () => {
    let now = 0;
    const store = createStore([
      { id: "FN-9", paused: true, pausedReason: "provider-rate-limit:anthropic" },
    ]);
    const probe = vi.fn().mockResolvedValue(providerUsage({ status: "error", error: "HTTP 429" }));
    const monitor = new ProviderHealthMonitor({
      getStores: () => [store],
      logger: createLogger(),
      probe,
      now: () => now,
    });

    await monitor.checkNow();
    now = 299_999;
    await monitor.checkNow();
    expect(probe).toHaveBeenCalledTimes(1);

    now = 300_000;
    await monitor.checkNow();
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("requeues unsupported and legacy-unqualified provider parks after a bounded cooldown", async () => {
    let now = 0;
    const store = createStore([
      { id: "FN-7", paused: true, pausedReason: "provider-rate-limit:openrouter" },
      { id: "FN-8", paused: true, pausedReason: "provider-rate-limit:unknown" },
      { id: "FN-9", paused: true, pausedReason: "provider-rate-limit" },
    ]);
    const failedStore = createStore([
      { id: "FN-FAILED", paused: true, pausedReason: "provider-rate-limit:openrouter" },
    ]);
    failedStore.listTasks
      .mockResolvedValueOnce([{ id: "FN-FAILED", paused: true, pausedReason: "provider-rate-limit:openrouter" }])
      .mockRejectedValue(new Error("database unavailable"));
    const probe = vi.fn();
    const logger = createLogger();
    const monitor = new ProviderHealthMonitor({
      getStores: () => [failedStore, store],
      logger,
      probe,
      supportsProbe: () => false,
      now: () => now,
      pollIntervalMs: 1_000,
    });

    await monitor.checkNow();
    expect(store.pauseTask).not.toHaveBeenCalled();
    now = 1_000;
    await monitor.checkNow();

    expect(probe).not.toHaveBeenCalled();
    expect(store.pauseTask).toHaveBeenCalledWith("FN-7", false);
    expect(store.pauseTask).toHaveBeenCalledWith("FN-8", false);
    expect(store.pauseTask).toHaveBeenCalledWith("FN-9", false);
    expect(logger.warn).toHaveBeenCalledWith(
      "Failed to recover tasks after provider cooldown",
      { providerId: "openrouter", error: "database unavailable" },
    );
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

  it("continues scanning healthy project stores when one store cannot list tasks", async () => {
    const failedStore = createStore([]);
    failedStore.listTasks.mockRejectedValue(new Error("database unavailable"));
    const healthyStore = createStore([
      { id: "FN-6", paused: true, pausedReason: "provider-rate-limit:anthropic" },
    ]);
    const logger = createLogger();
    const probe = vi.fn().mockResolvedValue(providerUsage());
    const monitor = new ProviderHealthMonitor({
      getStores: () => [failedStore, healthyStore],
      logger,
      probe,
    });

    await monitor.checkNow();

    expect(logger.warn).toHaveBeenCalledWith(
      "Failed to list tasks for provider health scan",
      { error: "database unavailable" },
    );
    expect(probe).toHaveBeenCalledWith("anthropic", undefined);
    expect(healthyStore.pauseTask).toHaveBeenCalledWith("FN-6", false);
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
