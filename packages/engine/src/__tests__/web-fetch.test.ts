import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dnsResolver, fetchWebContent, WebFetchError } from "../web-fetch.js";

describe("web-fetch", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.spyOn(dnsResolver, "lookup").mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
    ] as unknown as Awaited<ReturnType<typeof dnsResolver.lookup>>);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    global.fetch = originalFetch;
  });

  it("extracts html content", async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response(
      "<html><head><title>Hello</title><meta name='description' content='Desc'></head><body><main><h1>Title</h1><p>Body</p></main></body></html>",
      { status: 200, headers: { "content-type": "text/html" } },
    ));

    const result = await fetchWebContent("https://example.com");
    expect(result.content).toContain("Title Body");
    expect(result.title).toBe("Hello");
    expect(result.description).toBe("Desc");
    expect(result.finalUrl).toBe("https://example.com");
  });

  it("pretty prints json", async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response('{"a":1}', {
      status: 200,
      headers: { "content-type": "application/json" },
    }));

    const result = await fetchWebContent("https://example.com");
    expect(result.content).toContain('"a": 1');
  });

  it("passes through plain text", async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response("hello world", {
      status: 200,
      headers: { "content-type": "text/plain" },
    }));

    const result = await fetchWebContent("https://example.com");
    expect(result.content).toBe("hello world");
  });

  it("maps timeout", async () => {
    global.fetch = vi.fn().mockImplementation(async (_url, init: RequestInit) => {
      await new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))));
      return new Response("");
    });
    await expect(fetchWebContent("https://example.com", { timeoutMs: 1 })).rejects.toMatchObject({ code: "timeout" });
  });

  it("truncates content to max bytes", async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response("x".repeat(100), {
      status: 200,
      headers: { "content-type": "text/plain" },
    }));

    const result = await fetchWebContent("https://example.com", { maxBytes: 10 });
    expect(result.content).toHaveLength(10);
    expect(result.truncated).toBe(true);
    expect(result.bytesRead).toBe(100);
  });

  it("validates each redirect destination before following it", async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response(null, {
      status: 302,
      headers: { location: "http://127.0.0.1/admin" },
    }));

    await expect(fetchWebContent("https://example.com/start")).rejects.toMatchObject({ code: "blocked-host" });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith(
      "https://example.com/start",
      expect.objectContaining({ redirect: "manual" }),
    );
  });

  it("follows safe relative redirects", async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "/final" } }))
      .mockResolvedValueOnce(new Response("safe", { status: 200, headers: { "content-type": "text/plain" } }));

    const result = await fetchWebContent("https://example.com/start");
    expect(result.finalUrl).toBe("https://example.com/final");
    expect(result.content).toBe("safe");
  });

  it("maps non-ok response to http-error", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404 } as Response);
    await expect(fetchWebContent("https://example.com")).rejects.toMatchObject({ code: "http-error" });
  });

  it.each(["file:///tmp/test", "ftp://example.com", "data:text/plain,hello"])("blocks unsupported scheme %s", async (url) => {
    await expect(fetchWebContent(url)).rejects.toMatchObject({ code: "blocked-scheme" });
  });

  it.each(["http://127.0.0.1", "http://10.0.0.5", "http://[::1]", "http://169.254.0.1"])("blocks private literal host %s", async (url) => {
    await expect(fetchWebContent(url)).rejects.toMatchObject({ code: "blocked-host" });
  });

  it("blocks dns-resolved private host", async () => {
    vi.spyOn(dnsResolver, "lookup").mockResolvedValue([{ address: "10.0.0.1", family: 4 }] as unknown as Awaited<ReturnType<typeof dnsResolver.lookup>>);
    const pending = fetchWebContent("https://internal.example.com");
    await expect(pending).rejects.toBeInstanceOf(WebFetchError);
    await expect(pending).rejects.toMatchObject({ code: "blocked-host" });
  });
});
