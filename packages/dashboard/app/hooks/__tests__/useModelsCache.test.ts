import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SWR_CACHE_KEYS } from "../../utils/swrCache";
import { refreshModelsCache, useModelsCache } from "../useModelsCache";

vi.mock("../../api", () => ({
  fetchModels: vi.fn(),
}));

const { fetchModels } = await import("../../api");
const mockFetchModels = vi.mocked(fetchModels);

describe("useModelsCache", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mockFetchModels.mockResolvedValue({
      models: [{ provider: "openai", id: "gpt-4o", name: "GPT-4o" }],
      favoriteProviders: ["openai"],
      favoriteModels: ["gpt-4o"],
      defaultProvider: "openai",
      defaultModelId: "gpt-4o",
    });
  });

  it("hydrates synchronously from cache", async () => {
    localStorage.setItem(
      SWR_CACHE_KEYS.MODELS,
      JSON.stringify({
        savedAt: Date.now(),
        data: {
          models: [{ provider: "anthropic", id: "claude", name: "Claude" }],
          favoriteProviders: ["anthropic"],
          favoriteModels: ["claude"],
          defaultProvider: "anthropic",
          defaultModelId: "claude",
        },
      }),
    );

    const { result } = renderHook(() => useModelsCache());

    expect(result.current.loading).toBe(false);
    expect(result.current.models[0]?.id).toBe("claude");

    await waitFor(() => {
      expect(mockFetchModels).toHaveBeenCalledTimes(1);
    });
  });

  it("loads on cache miss and writes through", async () => {
    const { result } = renderHook(() => useModelsCache());

    expect(result.current.loading).toBe(true);

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
      expect(result.current.models[0]?.id).toBe("gpt-4o");
    });

    const cached = JSON.parse(localStorage.getItem(SWR_CACHE_KEYS.MODELS) ?? "null") as { data: { models: Array<{ id: string }> } };
    expect(cached.data.models[0]?.id).toBe("gpt-4o");
  });

  it("replaces a stale empty cached catalog for all mounted consumers", async () => {
    localStorage.setItem(
      SWR_CACHE_KEYS.MODELS,
      JSON.stringify({
        savedAt: Date.now(),
        data: {
          models: [],
          favoriteProviders: [],
          favoriteModels: [],
        },
      }),
    );
    mockFetchModels.mockResolvedValueOnce({
      models: [{ provider: "pi-claude-cli", id: "claude-sonnet-5", name: "Claude Sonnet 5 (CLI)" }],
      favoriteProviders: [],
      favoriteModels: [],
    });

    const hookA = renderHook(() => useModelsCache());
    const hookB = renderHook(() => useModelsCache());

    expect(hookA.result.current.loading).toBe(false);
    expect(hookA.result.current.models).toEqual([]);

    await waitFor(() => {
      expect(mockFetchModels).toHaveBeenCalledTimes(1);
      expect(hookA.result.current.models).toEqual([
        expect.objectContaining({ provider: "pi-claude-cli", id: "claude-sonnet-5" }),
      ]);
      expect(hookB.result.current.models).toEqual([
        expect.objectContaining({ provider: "pi-claude-cli", id: "claude-sonnet-5" }),
      ]);
    });

    const cached = JSON.parse(localStorage.getItem(SWR_CACHE_KEYS.MODELS) ?? "null") as { data: { models: Array<{ provider: string; id: string }> } };
    expect(cached.data.models).toEqual([
      expect.objectContaining({ provider: "pi-claude-cli", id: "claude-sonnet-5" }),
    ]);
  });

  it("deduplicates concurrent mounts", async () => {
    let resolveFetch: ((value: Awaited<ReturnType<typeof fetchModels>>) => void) | undefined;
    mockFetchModels.mockImplementationOnce(() => new Promise((resolve) => {
      resolveFetch = resolve;
    }));

    const hookA = renderHook(() => useModelsCache());
    const hookB = renderHook(() => useModelsCache());

    expect(mockFetchModels).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFetch?.({
        models: [{ provider: "openai", id: "gpt-4o", name: "GPT-4o" }],
        favoriteProviders: ["openai"],
        favoriteModels: ["gpt-4o"],
        defaultProvider: "openai",
        defaultModelId: "gpt-4o",
      });
    });

    await waitFor(() => {
      expect(hookA.result.current.loading).toBe(false);
      expect(hookB.result.current.loading).toBe(false);
      expect(hookB.result.current.models[0]?.id).toBe("gpt-4o");
    });
  });

  it("clears cache on failure without cached data", async () => {
    const swrCacheModule = await import("../../utils/swrCache");
    const clearCacheSpy = vi.spyOn(swrCacheModule, "clearCache");
    mockFetchModels.mockRejectedValueOnce(new Error("nope"));

    const { result } = renderHook(() => useModelsCache());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(clearCacheSpy).toHaveBeenCalledWith(SWR_CACHE_KEYS.MODELS);
  });

  it("refresh forces a new request", async () => {
    const { result } = renderHook(() => useModelsCache());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    mockFetchModels.mockResolvedValueOnce({
      models: [{ provider: "anthropic", id: "claude", name: "Claude" }],
      favoriteProviders: ["anthropic"],
      favoriteModels: ["claude"],
      defaultProvider: "anthropic",
      defaultModelId: "claude",
    });

    await act(async () => {
      await result.current.refresh();
    });

    expect(mockFetchModels).toHaveBeenCalledTimes(2);
    expect(result.current.models[0]?.id).toBe("claude");
  });

  describe("refreshModelsCache", () => {
    // FN-7710 symptom reproduction: a CLI provider toggle (grok-cli / cursor-cli) must
    // update every already-mounted useModelsCache() consumer without a remount.
    it("updates every mounted useModelsCache() subscriber in place after a CLI provider toggle, for grok-cli", async () => {
      // Seed the shared cache with a catalog that has NO grok-cli rows (pre-toggle state).
      mockFetchModels.mockResolvedValueOnce({
        models: [{ provider: "openai", id: "gpt-4o", name: "GPT-4o" }],
        favoriteProviders: [],
        favoriteModels: [],
      });

      const hookA = renderHook(() => useModelsCache());
      const hookB = renderHook(() => useModelsCache());

      await waitFor(() => {
        expect(hookA.result.current.loading).toBe(false);
        expect(hookB.result.current.loading).toBe(false);
      });

      // Before the fix's effect: neither consumer has any grok-cli rows yet.
      expect(hookA.result.current.models.some((m) => m.provider === "grok-cli")).toBe(false);
      expect(hookB.result.current.models.some((m) => m.provider === "grok-cli")).toBe(false);

      // Simulate toggling Grok CLI on: fetchModels() now returns grok-cli rows too.
      mockFetchModels.mockResolvedValueOnce({
        models: [
          { provider: "openai", id: "gpt-4o", name: "GPT-4o" },
          { provider: "grok-cli", id: "grok-4", name: "Grok 4 (CLI)" },
        ],
        favoriteProviders: [],
        favoriteModels: [],
      });

      await act(async () => {
        await refreshModelsCache();
      });

      // Both already-mounted consumers now see the grok-cli row, with no remount/navigation.
      expect(hookA.result.current.models.some((m) => m.provider === "grok-cli" && m.id === "grok-4")).toBe(true);
      expect(hookB.result.current.models.some((m) => m.provider === "grok-cli" && m.id === "grok-4")).toBe(true);

      // Disabling propagates too: a subsequent refresh with grok-cli rows removed hides them again.
      mockFetchModels.mockResolvedValueOnce({
        models: [{ provider: "openai", id: "gpt-4o", name: "GPT-4o" }],
        favoriteProviders: [],
        favoriteModels: [],
      });

      await act(async () => {
        await refreshModelsCache();
      });

      expect(hookA.result.current.models.some((m) => m.provider === "grok-cli")).toBe(false);
      expect(hookB.result.current.models.some((m) => m.provider === "grok-cli")).toBe(false);
    });

    it("updates mounted subscribers after a cursor-cli toggle", async () => {
      mockFetchModels.mockResolvedValueOnce({
        models: [{ provider: "openai", id: "gpt-4o", name: "GPT-4o" }],
        favoriteProviders: [],
        favoriteModels: [],
      });

      const { result } = renderHook(() => useModelsCache());
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.models.some((m) => m.provider === "cursor-cli")).toBe(false);

      mockFetchModels.mockResolvedValueOnce({
        models: [
          { provider: "openai", id: "gpt-4o", name: "GPT-4o" },
          { provider: "cursor-cli", id: "cursor/gpt-5", name: "GPT-5 (Cursor CLI)" },
        ],
        favoriteProviders: [],
        favoriteModels: [],
      });

      await act(async () => {
        await refreshModelsCache();
      });

      expect(result.current.models.some((m) => m.provider === "cursor-cli")).toBe(true);
    });

    it("writes through SWR_CACHE_KEYS.MODELS on refresh", async () => {
      mockFetchModels.mockResolvedValueOnce({
        models: [{ provider: "openai", id: "gpt-4o", name: "GPT-4o" }],
        favoriteProviders: [],
        favoriteModels: [],
      });
      renderHook(() => useModelsCache());
      await waitFor(() => expect(mockFetchModels).toHaveBeenCalledTimes(1));

      mockFetchModels.mockResolvedValueOnce({
        models: [{ provider: "grok-cli", id: "grok-4", name: "Grok 4" }],
        favoriteProviders: [],
        favoriteModels: [],
      });
      await act(async () => {
        await refreshModelsCache();
      });

      const cached = JSON.parse(localStorage.getItem(SWR_CACHE_KEYS.MODELS) ?? "null") as {
        data: { models: Array<{ provider: string }> };
      };
      expect(cached.data.models.some((m) => m.provider === "grok-cli")).toBe(true);
    });

    it("single-flights concurrent refreshModelsCache() calls", async () => {
      mockFetchModels.mockResolvedValueOnce({
        models: [{ provider: "openai", id: "gpt-4o", name: "GPT-4o" }],
        favoriteProviders: [],
        favoriteModels: [],
      });
      renderHook(() => useModelsCache());
      await waitFor(() => expect(mockFetchModels).toHaveBeenCalledTimes(1));

      let resolveFetch: ((value: Awaited<ReturnType<typeof fetchModels>>) => void) | undefined;
      mockFetchModels.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFetch = resolve;
          }),
      );

      const p1 = refreshModelsCache();
      const p2 = refreshModelsCache();

      expect(mockFetchModels).toHaveBeenCalledTimes(2); // 1 initial mount + 1 forced refresh (shared)

      await act(async () => {
        resolveFetch?.({
          models: [{ provider: "grok-cli", id: "grok-4", name: "Grok 4" }],
          favoriteProviders: [],
          favoriteModels: [],
        });
        await Promise.all([p1, p2]);
      });

      expect(mockFetchModels).toHaveBeenCalledTimes(2);
    });

    it("never throws and leaves an existing good list intact when the forced refresh fails", async () => {
      mockFetchModels.mockResolvedValueOnce({
        models: [{ provider: "openai", id: "gpt-4o", name: "GPT-4o" }],
        favoriteProviders: [],
        favoriteModels: [],
      });
      const { result } = renderHook(() => useModelsCache());
      await waitFor(() => expect(result.current.loading).toBe(false));

      mockFetchModels.mockRejectedValueOnce(new Error("network down"));

      await expect(refreshModelsCache()).resolves.toBeUndefined();
      expect(result.current.models[0]?.id).toBe("gpt-4o");
    });
  });
});
