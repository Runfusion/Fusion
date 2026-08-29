import { describe, expect, it } from "vitest";
import { toAcpMcpServers } from "../mcp-forwarding.js";

describe("toAcpMcpServers", () => {
  it("maps stdio, http, and sse transports", () => {
    const servers = toAcpMcpServers([
      {
        name: "local",
        transport: "stdio",
        command: "node",
        args: ["server.js"],
        env: { TOKEN: "x" },
      },
      {
        name: "remote",
        transport: "http",
        url: "https://example.com/mcp",
        headers: { Authorization: "Bearer t" },
      },
      {
        name: "events",
        type: "sse",
        url: "https://example.com/sse",
      },
      { name: "disabled", enabled: false, command: "noop" },
    ]);

    expect(servers).toEqual([
      {
        name: "local",
        command: "node",
        args: ["server.js"],
        env: [{ name: "TOKEN", value: "x" }],
      },
      {
        type: "http",
        name: "remote",
        url: "https://example.com/mcp",
        headers: [{ name: "Authorization", value: "Bearer t" }],
      },
      {
        type: "sse",
        name: "events",
        url: "https://example.com/sse",
        headers: [],
      },
    ]);
  });

  it("returns empty for non-arrays", () => {
    expect(toAcpMcpServers(undefined)).toEqual([]);
    expect(toAcpMcpServers(null)).toEqual([]);
  });
});
