import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useFavorites } from "../useFavorites";
import * as api from "../../api";

vi.mock("../../api", () => ({
  fetchModels: vi.fn(),
  updateGlobalSettings: vi.fn(),
}));

const mockFetchModels = vi.mocked(api.fetchModels);
const mockUpdateGlobalSettings = vi.mocked(api.updateGlobalSettings);

describe("useFavorites", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockFetchModels.mockResolvedValue({
      models: [
        {
          provider: "anthropic",
          id: "claude-sonnet-4-5",
          name: "Claude Sonnet 4.5",
          reasoning: true,
          contextWindow: 200000,
        },
      ],
      favoriteProviders: ["openai"],
      favoriteModels: ["gpt-4o"],
    });

    mockUpdateGlobalSettings.mockResolvedValue({} as never);
  });

  it("loads available models and favorites from API", async () => {
    const { result } = renderHook(() => useFavorites());

    await waitFor(() => {
      expect(result.current.availableModels).toHaveLength(1);
      expect(result.current.favoriteProviders).toEqual(["openai"]);
      expect(result.current.favoriteModels).toEqual(["gpt-4o"]);
    });

    expect(mockFetchModels).toHaveBeenCalledTimes(1);
  });

  it("optimistically toggles provider favorite and persists settings", async () => {
    const { result } = renderHook(() => useFavorites());

    await waitFor(() => {
      expect(result.current.favoriteProviders).toEqual(["openai"]);
    });

    await act(async () => {
      await result.current.toggleFavoriteProvider("anthropic");
    });

    expect(result.current.favoriteProviders).toEqual(["anthropic", "openai"]);
    expect(mockUpdateGlobalSettings).toHaveBeenCalledWith({
      favoriteProviders: ["anthropic", "openai"],
      favoriteModels: ["gpt-4o"],
    });
  });

  it("rolls back provider favorite on update failure", async () => {
    mockUpdateGlobalSettings.mockRejectedValueOnce(new Error("network"));

    const { result } = renderHook(() => useFavorites());

    await waitFor(() => {
      expect(result.current.favoriteProviders).toEqual(["openai"]);
    });

    await act(async () => {
      await expect(result.current.toggleFavoriteProvider("anthropic")).rejects.toThrow("network");
    });

    expect(result.current.favoriteProviders).toEqual(["openai"]);
  });

  it("rolls back model favorite on update failure", async () => {
    mockUpdateGlobalSettings.mockRejectedValueOnce(new Error("network"));

    const { result } = renderHook(() => useFavorites());

    await waitFor(() => {
      expect(result.current.favoriteModels).toEqual(["gpt-4o"]);
    });

    await act(async () => {
      await expect(result.current.toggleFavoriteModel("claude-sonnet-4-5")).rejects.toThrow("network");
    });

    expect(result.current.favoriteModels).toEqual(["gpt-4o"]);
  });

  it("toggle model favorite preserves a prior provider favorite change", async () => {
    const { result } = renderHook(() => useFavorites());

    await waitFor(() => {
      expect(result.current.favoriteProviders).toEqual(["openai"]);
      expect(result.current.favoriteModels).toEqual(["gpt-4o"]);
    });

    await act(async () => {
      await result.current.toggleFavoriteProvider("anthropic");
    });

    await act(async () => {
      await result.current.toggleFavoriteModel("claude-sonnet-4-5");
    });

    expect(mockUpdateGlobalSettings).toHaveBeenNthCalledWith(2, {
      favoriteProviders: ["anthropic", "openai"],
      favoriteModels: ["claude-sonnet-4-5", "gpt-4o"],
    });
  });

  it("toggle provider favorite preserves a prior model favorite change", async () => {
    const { result } = renderHook(() => useFavorites());

    await waitFor(() => {
      expect(result.current.favoriteProviders).toEqual(["openai"]);
      expect(result.current.favoriteModels).toEqual(["gpt-4o"]);
    });

    await act(async () => {
      await result.current.toggleFavoriteModel("claude-sonnet-4-5");
    });

    await act(async () => {
      await result.current.toggleFavoriteProvider("anthropic");
    });

    expect(mockUpdateGlobalSettings).toHaveBeenNthCalledWith(2, {
      favoriteProviders: ["anthropic", "openai"],
      favoriteModels: ["claude-sonnet-4-5", "gpt-4o"],
    });
  });

  it("rapid toggles of both model and provider favorites persist correctly", async () => {
    const { result } = renderHook(() => useFavorites());

    await waitFor(() => {
      expect(result.current.favoriteProviders).toEqual(["openai"]);
      expect(result.current.favoriteModels).toEqual(["gpt-4o"]);
    });

    await act(async () => {
      const toggleModelPromise = result.current.toggleFavoriteModel("claude-sonnet-4-5");
      const toggleProviderPromise = result.current.toggleFavoriteProvider("anthropic");
      await Promise.all([toggleModelPromise, toggleProviderPromise]);
    });

    expect(mockUpdateGlobalSettings).toHaveBeenNthCalledWith(1, {
      favoriteProviders: ["openai"],
      favoriteModels: ["claude-sonnet-4-5", "gpt-4o"],
    });
    expect(mockUpdateGlobalSettings).toHaveBeenNthCalledWith(2, {
      favoriteProviders: ["anthropic", "openai"],
      favoriteModels: ["claude-sonnet-4-5", "gpt-4o"],
    });
  });
});
