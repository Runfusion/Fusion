import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_GOOGLE_SEARCH_URL, WebSearchProvider } from "../web-search-provider.js";

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

  it("calls Google's Custom Search endpoint when no base URL is set", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ items: [{ link: "https://a", title: "A", snippet: "Snippet" }] }),
    } as Response);
    global.fetch = fetchMock;

    const provider = new WebSearchProvider({ backend: "google", googleApiKey: "k", googleCx: "cx" });
    const results = await provider.search("fusion", {});

    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(DEFAULT_GOOGLE_SEARCH_URL).toBe("https://www.googleapis.com/customsearch/v1");
    expect(url.origin + url.pathname).toBe(DEFAULT_GOOGLE_SEARCH_URL);
    expect(url.searchParams.get("cx")).toBe("cx");
    expect(results[0]).toMatchObject({ reference: "https://a", metadata: { backend: "google", rank: 1 } });
  });

  it("calls the configured Google base URL with the same parameters", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ items: [{ link: "https://a", title: "A", snippet: "Snippet" }] }),
    } as Response);
    global.fetch = fetchMock;

    const provider = new WebSearchProvider({
      backend: "google",
      googleApiKey: "k",
      googleCx: "cx",
      googleBaseUrl: "http://127.0.0.1:8080/customsearch/v1",
    });
    await provider.search("fusion", { maxResults: 3 });

    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.origin + url.pathname).toBe("http://127.0.0.1:8080/customsearch/v1");
    expect(url.searchParams.get("key")).toBe("k");
    expect(url.searchParams.get("cx")).toBe("cx");
    expect(url.searchParams.get("q")).toBe("fusion");
    expect(url.searchParams.get("num")).toBe("3");
  });
});
