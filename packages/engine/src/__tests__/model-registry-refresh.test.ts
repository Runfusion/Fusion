import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MODEL_REGISTRY_REFRESH_TIMEOUT_MS,
  refreshFusionModelRegistry,
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
});
