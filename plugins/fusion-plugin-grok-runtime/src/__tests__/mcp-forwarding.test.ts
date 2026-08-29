import { describe, expect, it } from "vitest";
import { toAcpMcpServers } from "../mcp-forwarding.js";

describe("toAcpMcpServers", () => {
  it("returns empty for missing/empty input", () => {
    expect(toAcpMcpServers(undefined)).toEqual([]);
    expect(toAcpMcpServers([])).toEqual([]);
  });

  it("converts engine stdio ResolvedMcpServerDefinition", () => {
    expect(
      toAcpMcpServers([
        {
          name: "local-tools",
          transport: "stdio",
          command: "node",
          args: ["server.js"],
          env: { API_KEY: "secret" },
        },
      ]),
    ).toEqual([
      {
        name: "local-tools",
        command: "node",
        args: ["server.js"],
        env: [{ name: "API_KEY", value: "secret" }],
      },
    ]);
  });

  it("converts http and sse transports", () => {
    expect(
      toAcpMcpServers([
        { name: "docs", transport: "streamable-http", url: "https://example.test/mcp", headers: { Authorization: "Bearer x" } },
        { name: "events", transport: "sse", url: "https://example.test/sse" },
      ]),
    ).toEqual([
      {
        type: "http",
        name: "docs",
        url: "https://example.test/mcp",
        headers: [{ name: "Authorization", value: "Bearer x" }],
      },
      {
        type: "sse",
        name: "events",
        url: "https://example.test/sse",
        headers: [],
      },
    ]);
  });

  it("preserves legacy ACP stdio env pairs", () => {
    expect(
      toAcpMcpServers([
        {
          name: "custom-tools",
          command: "node",
          args: ["mcp.cjs", "schema.json"],
          env: [{ name: "FOO", value: "bar" }],
        },
      ]),
    ).toEqual([
      {
        name: "custom-tools",
        command: "node",
        args: ["mcp.cjs", "schema.json"],
        env: [{ name: "FOO", value: "bar" }],
      },
    ]);
  });

  it("skips disabled servers and incomplete definitions", () => {
    expect(
      toAcpMcpServers([
        { name: "off", enabled: false, transport: "stdio", command: "node" },
        { name: "missing-cmd", transport: "stdio" },
        { name: "missing-url", transport: "http" },
      ]),
    ).toEqual([]);
  });
});
