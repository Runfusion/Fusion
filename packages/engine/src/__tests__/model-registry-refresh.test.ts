import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MODEL_REGISTRY_REFRESH_TIMEOUT_MS,
  boundExistingModelRegistryRefresh,
  refreshFusionModelRegistry,
  startFusionModelRegistryRefresh,
} from "../auth/model-registry-refresh.js";

describe("refreshFusionModelRegistry", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns completed when runtime refresh resolves", async () => {
    const refresh = vi.fn(async () => ({ aborted: false }));
    const outcome = await refreshFusionModelRegistry(
      { refresh: vi.fn(), modelRuntime: { refresh } },
      { allowNetwork: false },
    );
    expect(outcome).toBe("completed");
    expect(refresh).toHaveBeenCalledWith(
      expect.objectContaining({ allowNetwork: false, signal: expect.any(AbortSignal) }),
    );
  });

  it("times out a hung refresh instead of hanging forever", async () => {
    vi.useFakeTimers();
    const refresh = vi.fn(
      () =>
        new Promise(() => {
          /* never settles */
        }),
    );
    const log = vi.fn();
    const pending = refreshFusionModelRegistry(
      { refresh: vi.fn(), modelRuntime: { refresh } },
      { timeoutMs: 50, log },
    );
    await vi.advanceTimersByTimeAsync(50);
    await expect(pending).resolves.toBe("timed_out");
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("timed out after 50ms"),
    );
  });

  it("falls back to ModelRegistry.refresh when modelRuntime is absent", async () => {
    const refresh = vi.fn(async () => undefined);
    const outcome = await refreshFusionModelRegistry({ refresh });
    expect(outcome).toBe("completed");
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("defaults timeout to the create-path bound", () => {
    expect(DEFAULT_MODEL_REGISTRY_REFRESH_TIMEOUT_MS).toBe(15_000);
  });

  it("exposes one faithful underlying refresh alongside its bounded outcome", async () => {
    const refresh = vi.fn(async () => "catalog");
    const started = startFusionModelRegistryRefresh({ refresh });
    await expect(started.underlying).resolves.toBe("catalog");
    await expect(started.bounded).resolves.toBe("completed");
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("bounds an existing promise without starting another refresh", async () => {
    vi.useFakeTimers();
    const refresh = vi.fn();
    let resolve!: () => void;
    const underlying = new Promise<void>((done) => { resolve = done; });
    const pending = boundExistingModelRegistryRefresh(underlying, { timeoutMs: 20 });
    await vi.advanceTimersByTimeAsync(20);
    await expect(pending).resolves.toBe("timed_out");
    expect(refresh).not.toHaveBeenCalled();
    const completed = boundExistingModelRegistryRefresh(Promise.resolve(), { timeoutMs: 20 });
    await expect(completed).resolves.toBe("completed");
    resolve();
  });

  it("maps a late existing rejection to failed without an unhandled rejection", async () => {
    let reject!: (reason: Error) => void;
    const underlying = new Promise<void>((_, fail) => { reject = fail; });
    const started = startFusionModelRegistryRefresh({ refresh: () => underlying });
    void started.bounded;
    reject(new Error("late provider failure"));
    await expect(started.bounded).resolves.toBe("failed");
  });
});
