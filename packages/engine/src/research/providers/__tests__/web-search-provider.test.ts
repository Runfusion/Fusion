import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ResearchProviderError } from "../../types.js";
import { WebSearchProvider } from "../web-search-provider.js";

describe("WebSearchProvider", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    global.fetch = originalFetch;
  });

  it("validates configuration for each backend", () => {
    expect(new WebSearchProvider({ backend: "none" }).isConfigured()).toBe(false);
    expect(new WebSearchProvider({ backend: "searxng", searxngUrl: "https://sx" }).isConfigured()).toBe(true);
    expect(new WebSearchProvider({ backend: "brave", braveApiKey: "k" }).isConfigured()).toBe(true);
    expect(new WebSearchProvider({ backend: "google", googleApiKey: "k", googleCx: "cx" }).isConfigured()).toBe(true);
    expect(new WebSearchProvider({ backend: "tavily", tavilyApiKey: "k" }).isConfigured()).toBe(true);
  });

  it("normalizes searxng results", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [{ url: "https://a", title: "A", content: "Snippet" }] }),
    } as Response);

    const provider = new WebSearchProvider({ backend: "searxng", searxngUrl: "https://sx" });
    const results = await provider.search("fusion", {});

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      title: "A",
      reference: "https://a",
      excerpt: "Snippet",
      metadata: { backend: "searxng", rank: 1 },
    });
  });

  it("limits max results", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        web: {
          results: [
            { url: "https://a", title: "A", description: "1" },
            { url: "https://b", title: "B", description: "2" },
          ],
        },
      }),
    } as Response);

    const provider = new WebSearchProvider({ backend: "brave", braveApiKey: "k" });
    const results = await provider.search("fusion", { maxResults: 1 });
    expect(results).toHaveLength(1);
  });

  it("retries 429 and succeeds", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 429 } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ items: [{ link: "https://x", title: "X", snippet: "S" }] }),
      } as Response);

    const provider = new WebSearchProvider({ backend: "google", googleApiKey: "k", googleCx: "cx" });
    const promise = provider.search("fusion", {});
    await vi.runAllTimersAsync();
    const results = await promise;

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(results[0]?.reference).toBe("https://x");
  });

  it("classifies auth failures", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 401 } as Response);
    const provider = new WebSearchProvider({ backend: "tavily", tavilyApiKey: "k" });
    await expect(provider.search("fusion", {})).rejects.toMatchObject({ code: "auth-failed" });
  });

  it("propagates abort signal", async () => {
    global.fetch = vi.fn().mockImplementation(async (_url, init: RequestInit) => {
      await new Promise((_, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      });
      return { ok: true, json: async () => ({}) } as Response;
    });

    const controller = new AbortController();
    const provider = new WebSearchProvider({ backend: "brave", braveApiKey: "k" });
    const pending = provider.search("fusion", {}, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "abort", providerType: "web-search" });
  });

});
