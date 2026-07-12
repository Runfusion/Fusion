import { describe, expect, it } from "vitest";
import type { McpSecretReader } from "@fusion/core";
import { resolveMcpServersForRuntime } from "../mcp-resolution.js";

function secrets(values: Record<string, string>): McpSecretReader {
  return {
    async revealSecret(id) {
      const plaintextValue = values[id];
      if (plaintextValue === undefined) throw new Error(`missing ${id}`);
      return { key: id, plaintextValue };
    },
  };
}

describe("resolveMcpServersForRuntime", () => {
  it("resolves effective settings and materializes secret references", async () => {
    const result = await resolveMcpServersForRuntime({
      globalSettings: {
        mcpServers: {
          enabled: true,
          servers: [
            { name: "global", transport: "stdio", command: "node", args: ["server.js"], env: { API_KEY: { secretRef: "global-key", scope: "global" } } },
          ],
        },
      },
      projectSettings: null,
      secrets: secrets({ "global-key": "SECRET_VALUE" }),
      reader: { agentId: "agent-1" },
    });

    expect(result.errors).toEqual([]);
    expect(result.servers).toEqual([
      { name: "global", transport: "stdio", command: "node", args: ["server.js"], env: { API_KEY: "SECRET_VALUE" } },
    ]);
  });

  it("excludes disabled servers and lets project definitions override global definitions", async () => {
    const result = await resolveMcpServersForRuntime({
      globalSettings: {
        mcpServers: {
          enabled: true,
          servers: [
            { name: "override", transport: "stdio", command: "old" },
            { name: "removed", transport: "stdio", command: "remove-me" },
          ],
        },
      },
      projectSettings: {
        mcpServers: {
          enabled: true,
          servers: [
            { name: "override", transport: "sse", url: "https://mcp.example/sse", headers: { Authorization: { secretRef: "auth", scope: "project" } } },
            { name: "removed", enabled: false, transport: "stdio", command: "noop" },
          ],
        },
      },
      secrets: secrets({ auth: "Bearer SECRET" }),
    });

    expect(result.errors).toEqual([]);
    expect(result.servers).toEqual([
      { name: "override", transport: "sse", url: "https://mcp.example/sse", headers: { Authorization: "Bearer SECRET" } },
    ]);
  });

  it("resolves through the TaskStore-compatible settings split seam", async () => {
    const { resolveMcpServersForStore } = await import("../mcp-resolution.js");
    const result = await resolveMcpServersForStore({
      async getSettingsByScope() {
        return {
          global: { mcpServers: { enabled: true, servers: [{ name: "store", transport: "stdio", command: "node" }] } },
          project: { mcpServers: { enabled: true, servers: [] } },
        };
      },
      async getSecretsStore() {
        return secrets({});
      },
    });

    expect(result).toEqual({
      servers: [{ name: "store", transport: "stdio", command: "node" }],
      errors: [],
    });
  });

  it("treats a missing settings seam as a genuine empty configuration", async () => {
    const { resolveMcpServersForStore } = await import("../mcp-resolution.js");
    await expect(resolveMcpServersForStore({})).resolves.toEqual({ servers: [], errors: [] });
  });

  it("honors an explicitly disabled project scope and disabled project shadow", async () => {
    const disabledScope = await resolveMcpServersForRuntime({
      globalSettings: { mcpServers: { enabled: true, servers: [{ name: "global", transport: "stdio", command: "node" }] } },
      projectSettings: { mcpServers: { enabled: false, servers: [] } },
      secrets: secrets({}),
    });
    const disabledShadow = await resolveMcpServersForRuntime({
      globalSettings: { mcpServers: { enabled: true, servers: [{ name: "global", transport: "stdio", command: "node" }] } },
      projectSettings: { mcpServers: { enabled: true, servers: [{ name: "global", enabled: false, transport: "stdio", command: "noop" }] } },
      secrets: secrets({}),
    });

    expect(disabledScope).toEqual({ servers: [], errors: [] });
    expect(disabledShadow).toEqual({ servers: [], errors: [] });
  });

  it("returns materialization errors without leaking through logs", async () => {
    const result = await resolveMcpServersForRuntime({
      globalSettings: {
        mcpServers: {
          enabled: true,
          servers: [
            { name: "broken", transport: "streamable-http", url: "https://mcp.example", headers: { Authorization: { secretRef: "missing", scope: "project" } } },
          ],
        },
      },
      projectSettings: null,
      secrets: secrets({}),
    });

    expect(result.servers).toEqual([{ name: "broken", transport: "streamable-http", url: "https://mcp.example" }]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.serverName).toBe("broken");
  });
});
