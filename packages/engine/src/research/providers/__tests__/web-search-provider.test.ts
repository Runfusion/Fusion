import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSearchProvider } from "../web-search-provider.js";

const { createFnAgentMock, promptWithFallbackMock } = vi.hoisted(() => ({
  createFnAgentMock: vi.fn(),
  promptWithFallbackMock: vi.fn(),
}));

vi.mock("../../../pi.js", () => ({
  createFnAgent: createFnAgentMock,
  promptWithFallback: promptWithFallbackMock,
}));

describe("WebSearchProvider", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.useFakeTimers();
    createFnAgentMock.mockReset();
    promptWithFallbackMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    global.fetch = originalFetch;
  });

  it("validates configuration for each backend", () => {
    expect(new WebSearchProvider({ backend: "builtin", projectRoot: process.cwd() }).isConfigured()).toBe(true);
    expect(new WebSearchProvider({ backend: "searxng", searxngUrl: "https://sx" }).isConfigured()).toBe(true);
    expect(new WebSearchProvider({ backend: "brave", braveApiKey: "k" }).isConfigured()).toBe(true);
    expect(new WebSearchProvider({ backend: "google", googleApiKey: "k", googleCx: "cx" }).isConfigured()).toBe(true);
    expect(new WebSearchProvider({ backend: "tavily", tavilyApiKey: "k" }).isConfigured()).toBe(true);
  });

  it("invokes builtin tools and maps json response", async () => {
    const session = {
      state: {
        messages: [
          {
            role: "assistant",
            content: "```json\n{\"results\":[{\"url\":\"https://a\",\"title\":\"A\",\"snippet\":\"Snippet\"}]}\n```",
          },
        ],
      },
      dispose: vi.fn(),
    };
    createFnAgentMock.mockResolvedValue({ session });
    promptWithFallbackMock.mockResolvedValue(undefined);

    const provider = new WebSearchProvider({
      backend: "builtin",
      projectRoot: process.cwd(),
      defaultProvider: "anthropic",
      defaultModelId: "x",
    });

    const results = await provider.search("fusion", { maxResults: 3 });

    expect(createFnAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        builtinToolsAllowlist: ["WebSearch", "WebFetch"],
        defaultProvider: "anthropic",
        defaultModelId: "x",
      }),
    );
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      reference: "https://a",
      title: "A",
      excerpt: "Snippet",
      metadata: { backend: "builtin", rank: 1 },
    });
  });

  it("throws provider-unavailable on malformed builtin response", async () => {
    const session = {
      state: { messages: [{ role: "assistant", content: "not-json" }] },
      dispose: vi.fn(),
    };
    createFnAgentMock.mockResolvedValue({ session });
    promptWithFallbackMock.mockResolvedValue(undefined);

    const provider = new WebSearchProvider({ backend: "builtin", projectRoot: process.cwd() });
    await expect(provider.search("fusion", {})).rejects.toMatchObject({ code: "provider-unavailable" });
  });

  it("normalizes searxng results", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [{ url: "https://a", title: "A", content: "Snippet" }] }),
    } as Response);

    const provider = new WebSearchProvider({ backend: "searxng", searxngUrl: "https://sx" });
    const results = await provider.search("fusion", {});

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ metadata: { backend: "searxng", rank: 1 } });
  });
});
