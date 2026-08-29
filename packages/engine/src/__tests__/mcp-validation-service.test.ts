import { describe, expect, it, vi } from "vitest";
import type { ResolvedMcpServerDefinition } from "@fusion/core";
import { validateMcpServer } from "../mcp/mcp-validation-service.js";

describe("mcp-validation-service", () => {
  it("uses an injected stdio probe for stdio servers", async () => {
    const server: ResolvedMcpServerDefinition = {
      name: "local",
      transport: "stdio",
      command: "node",
      args: ["server.js"],
      env: { TOKEN: "secret-value" },
    };
    const stdioProbe = vi.fn(async () => ({ status: "valid" as const, message: "ok" }));

    await expect(validateMcpServer(server, { stdioProbe, timeoutMs: 25 })).resolves.toEqual({ status: "valid", message: "ok" });
    expect(stdioProbe).toHaveBeenCalledWith(server, { timeoutMs: 25, cwd: undefined });
  });

  it("treats reachable SSE responses below 500 as valid", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 401 }));
    const server: ResolvedMcpServerDefinition = {
      name: "events",
      transport: "sse",
      url: "https://example.test/sse",
      headers: { Authorization: "Bearer secret-value" },
    };

    const result = await validateMcpServer(server, { fetchImpl, timeoutMs: 25 });

    expect(result).toEqual({ status: "valid", message: "server responded with HTTP 401" });
    expect(fetchImpl).toHaveBeenCalledWith("https://example.test/sse", expect.objectContaining({
      method: "GET",
      headers: { Authorization: "Bearer secret-value" },
    }));
  });

  it("returns error for streamable HTTP 5xx responses", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 503 }));
    const server: ResolvedMcpServerDefinition = {
      name: "http",
      transport: "streamable-http",
      url: "https://example.test/mcp",
    };

    await expect(validateMcpServer(server, { fetchImpl, timeoutMs: 25 })).resolves.toEqual({
      status: "error",
      message: "server responded with HTTP 503",
    });
  });

  it("returns unreachable for fetch failures without echoing headers", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const server: ResolvedMcpServerDefinition = {
      name: "http",
      transport: "streamable-http",
      url: "https://example.test/mcp",
      headers: { Authorization: "super-secret" },
    };

    const result = await validateMcpServer(server, { fetchImpl, timeoutMs: 25 });

    expect(result.status).toBe("unreachable");
    expect(result.message).toBe("ECONNREFUSED");
    expect(JSON.stringify(result)).not.toContain("super-secret");
  });
});
