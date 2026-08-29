import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetModelRegistryRefreshCacheForTests,
  invalidateModelRegistryRefreshCache,
  refreshModelRegistryForRequest,
} from "../model-registry-refresh-cache.js";

const options = { timeoutMs: 20, successTtlMs: 60, failureRetryMs: 60 };

describe("model registry request refresh cache", () => {
  beforeEach(() => __resetModelRegistryRefreshCacheForTests());
  afterEach(() => vi.useRealTimers());

  it("caches successful refreshes per registry instance", async () => {
    const refreshA = vi.fn(async () => undefined);
    const refreshB = vi.fn(async () => undefined);
    const a = { refresh: refreshA };
    const b = { refresh: refreshB };
    expect(await refreshModelRegistryForRequest(a, options)).toBe("completed");
    expect(await refreshModelRegistryForRequest(a, options)).toBe("cached");
    expect(await refreshModelRegistryForRequest(b, options)).toBe("completed");
    expect(refreshA).toHaveBeenCalledOnce();
    expect(refreshB).toHaveBeenCalledOnce();
  });

  it("does not overlap a hung refresh and returns expired requests immediately", async () => {
    vi.useFakeTimers();
    const refresh = vi.fn(() => new Promise<void>(() => {}));
    const registry = { refresh };
    const first = refreshModelRegistryForRequest(registry, options);
    await vi.advanceTimersByTimeAsync(20);
    await expect(first).resolves.toBe("timed_out");
    await expect(refreshModelRegistryForRequest(registry, options)).resolves.toBe("timed_out");
    await Promise.all(Array.from({ length: 10 }, () => refreshModelRegistryForRequest(registry, options)));
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("suppresses settled failures from attempt start without calling them fresh", async () => {
    vi.useFakeTimers();
    const refresh = vi.fn(async () => { throw new Error("provider failed"); });
    const registry = { refresh };
    expect(await refreshModelRegistryForRequest(registry, options)).toBe("failed");
    await vi.runAllTicks();
    expect(await refreshModelRegistryForRequest(registry, options)).toBe("negative_cached");
    expect(refresh).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60);
    expect(await refreshModelRegistryForRequest(registry, options)).toBe("failed");
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("preserves a stale-generation flight and requires a current refresh after it settles", async () => {
    let resolve!: () => void;
    const first = new Promise<void>((done) => { resolve = done; });
    const refresh = vi.fn()
      .mockImplementationOnce(() => first)
      .mockResolvedValueOnce(undefined);
    const registry = { refresh };
    const pending = refreshModelRegistryForRequest(registry, options);
    invalidateModelRegistryRefreshCache(registry);
    await expect(refreshModelRegistryForRequest(registry, options)).resolves.toBe("stale_in_flight");
    expect(refresh).toHaveBeenCalledOnce();
    resolve();
    await expect(pending).resolves.toBe("completed");
    await Promise.resolve();
    expect(await refreshModelRegistryForRequest(registry, options)).toBe("completed");
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("invalidation bypasses a prior successful window", async () => {
    const refresh = vi.fn(async () => undefined);
    const registry = { refresh };
    await refreshModelRegistryForRequest(registry, options);
    invalidateModelRegistryRefreshCache(registry);
    await refreshModelRegistryForRequest(registry, options);
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});
