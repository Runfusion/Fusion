import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SWR_CACHE_KEYS } from "../../utils/swrCache";
import { useModelsCache } from "../useModelsCache";

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
});
