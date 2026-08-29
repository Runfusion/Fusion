import { afterEach, describe, expect, it, vi } from "vitest";
import { createWebFetchTool } from "../agent-tools.js";

describe("createWebFetchTool", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    vi.restoreAllMocks();
    global.fetch = originalFetch;
  });

  it("returns fetched content with metadata", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      url: "https://example.com/final",
      headers: new Headers({ "content-type": "text/plain" }),
      text: async () => "hello world",
    } as Response);

    const tool = createWebFetchTool();
    const result = await tool.execute("id", { url: "https://example.com" } as any, undefined, undefined, {} as any);
    const text = result.content[0] && "text" in result.content[0] ? result.content[0].text : "";

    expect((result as any).isError).toBeUndefined();
    expect(text).toContain("URL: https://example.com/final");
    expect(text).toContain("Status: 200");
    expect(text).toContain("hello world");
  });

  it("returns blocked-host error", async () => {
    const tool = createWebFetchTool();
    const result = await tool.execute("id", { url: "http://127.0.0.1" } as any, undefined, undefined, {} as any);
    const text = result.content[0] && "text" in result.content[0] ? result.content[0].text : "";

    expect((result as any).isError).toBe(true);
    expect(text).toContain("blocked-host");
  });

  it("requires url parameter", async () => {
    const tool = createWebFetchTool();
    await expect(tool.execute("id", {} as any, undefined, undefined, {} as any)).resolves.toMatchObject({ isError: true });
  });
});
