import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_CONTENT_CHARS, PageFetchProvider } from "../page-fetch-provider.js";

describe("PageFetchProvider", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    vi.restoreAllMocks();
    global.fetch = originalFetch;
  });

  it("extracts readable html content", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "text/html" }),
      text: async () =>
        "<html><head><title>Hello</title><meta name='description' content='Desc'></head><body><main><h1>Title</h1><p>Body</p></main></body></html>",
    } as Response);

    const provider = new PageFetchProvider();
    const result = await provider.fetchContent("https://example.com", {});

    expect(result.content).toContain("Title Body");
    expect(result.metadata).toMatchObject({ title: "Hello", description: "Desc", contentType: "text/html" });
    expect(result.mimeType).toBe("text/html");
  });

  it("pretty prints json", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "application/json" }),
      text: async () => '{"a":1}',
    } as Response);

    const provider = new PageFetchProvider();
    const result = await provider.fetchContent("https://example.com", {});
    expect(result.content).toContain('"a": 1');
  });

  it("passes through text", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "text/plain" }),
      text: async () => "hello world",
    } as Response);

    const provider = new PageFetchProvider();
    const result = await provider.fetchContent("https://example.com", {});
    expect(result.content).toBe("hello world");
  });

  it("maps status errors", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404 } as Response);
    const provider = new PageFetchProvider();
    await expect(provider.fetchContent("https://example.com", {})).rejects.toMatchObject({ code: "network-error" });
  });

  it("maps 500 as provider unavailable", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 } as Response);
    const provider = new PageFetchProvider();
    await expect(provider.fetchContent("https://example.com", {})).rejects.toMatchObject({ code: "provider-unavailable" });
  });

  it("truncates large content", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "text/plain" }),
      text: async () => "x".repeat(600 * 1024),
    } as Response);
    const provider = new PageFetchProvider();
    const result = await provider.fetchContent("https://example.com", {});
    expect(result.content.length).toBe(MAX_CONTENT_CHARS);
  });

  it("maps timeout", async () => {
    global.fetch = vi.fn().mockRejectedValue(Object.assign(new Error("Timed out"), { name: "TimeoutError" }));
    const provider = new PageFetchProvider({ timeoutMs: 50 });
    await expect(provider.fetchContent("https://example.com", {})).rejects.toMatchObject({ code: "timeout" });
  });

  it("maps abort", async () => {
    global.fetch = vi.fn().mockImplementation(async (_url, init: RequestInit) => {
      await new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))));
      return { ok: true, headers: new Headers(), text: async () => "" } as Response;
    });
    const provider = new PageFetchProvider();
    const controller = new AbortController();
    const pending = provider.fetchContent("https://example.com", {}, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "abort" });
  });
});
