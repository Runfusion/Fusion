import { describe, expect, it } from "vitest";
import { toAcpMcpServers } from "../mcp-forwarding.js";

describe("toAcpMcpServers", () => {
  it("converts resolved stdio, streamable HTTP, and SSE definitions", () => {
    expect(toAcpMcpServers([
      { name: "local", transport: "stdio", command: "node", args: ["server.js"], env: { TOKEN: "secret" } },
      { name: "remote", transport: "streamable-http", url: "https://mcp.example/mcp", headers: { Authorization: "Bearer secret" } },
      { name: "events", transport: "sse", url: "https://mcp.example/sse" },
    ])).toEqual([
      { name: "local", command: "node", args: ["server.js"], env: [{ name: "TOKEN", value: "secret" }] },
      { type: "http", name: "remote", url: "https://mcp.example/mcp", headers: [{ name: "Authorization", value: "Bearer secret" }] },
      { type: "sse", name: "events", url: "https://mcp.example/sse", headers: [] },
    ]);
  });

  it("preserves the legacy ACP stdio shape used by the Fusion tool bridge", () => {
    expect(toAcpMcpServers([{ name: "fusion-custom-tools", command: "node", args: ["bridge.cjs"], env: [{ name: "TOKEN", value: "secret" }] }])).toEqual([
      { name: "fusion-custom-tools", command: "node", args: ["bridge.cjs"], env: [{ name: "TOKEN", value: "secret" }] },
    ]);
  });

  it("skips disabled, unnamed, incomplete, and unsupported entries", () => {
    expect(toAcpMcpServers([
      null,
      { name: "off", enabled: false, transport: "stdio", command: "node" },
      { name: "", transport: "stdio", command: "node" },
      { name: "missing-command", transport: "stdio" },
      { name: "missing-url", transport: "streamable-http" },
      { name: "unsupported", transport: "other", url: "https://mcp.example" },
    ])).toEqual([]);
  });
  it("omits remote transports not advertised by the agent", () => {
    expect(toAcpMcpServers([
      { name: "http", transport: "http", url: "https://mcp.example/http" },
      { name: "sse", transport: "sse", url: "https://mcp.example/sse" },
    ], { http: true })).toEqual([
      { type: "http", name: "http", url: "https://mcp.example/http", headers: [] },
    ]);
  });

});
