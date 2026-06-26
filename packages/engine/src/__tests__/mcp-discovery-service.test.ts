import { describe, expect, it, vi } from "vitest";
import { discoverMcpServers } from "../mcp-discovery-service.js";

describe("discoverMcpServers", () => {
  it("reads only requested-scope sources through the injectable reader", async () => {
    const readFile = vi.fn(async (path: string) => {
      if (path.endsWith(".cursor/mcp.json")) {
        return JSON.stringify({ mcpServers: { cursor: { command: "cursor-mcp" } } });
      }
      return undefined;
    });

    const result = await discoverMcpServers({ scope: "global", homeDir: "/home/ada", projectRootDir: "/repo", readFile });

    expect(result.sources.every((source) => source.scope === "global")).toBe(true);
    expect(readFile).toHaveBeenCalledTimes(result.sources.length);
    expect(readFile.mock.calls.every(([path]) => !String(path).startsWith("/repo/"))).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.servers).toHaveLength(1);
    expect(result.servers[0]?.source.label).toBe("Cursor global");
    expect(result.servers[0]?.definition).toMatchObject({ name: "cursor", transport: "stdio", command: "cursor-mcp" });
  });

  it("returns project servers, treats missing files as non-errors, and never exposes plaintext in definitions", async () => {
    const readFile = vi.fn(async (path: string) => {
      if (path.endsWith(".vscode/mcp.json")) {
        return JSON.stringify({ servers: { secure: { transport: "sse", url: "https://secure.example.test/sse", headers: { Authorization: "Bearer plaintext" } } } });
      }
      return undefined;
    });

    const result = await discoverMcpServers({ scope: "project", homeDir: "/home/ada", projectRootDir: "/repo", readFile });

    expect(result.sources.map((source) => source.id)).toEqual(["cursor-project", "vscode-project"]);
    expect(result.errors).toEqual([]);
    expect(result.servers).toHaveLength(1);
    expect(result.servers[0]?.source.label).toBe("VS Code project");
    expect(result.servers[0]?.secretsToCreate).toHaveLength(1);
    expect(JSON.stringify(result.servers[0]?.definition)).not.toContain("Bearer plaintext");
    expect(result.servers[0]?.definition).toMatchObject({
      name: "secure",
      headers: { Authorization: { secretRef: "mcp.secure.headers.Authorization", scope: "project" } },
    });
  });

  it("captures parse and reader failures without spawning or connecting to servers", async () => {
    const readFile = vi.fn(async (path: string) => {
      if (path.endsWith(".cursor/mcp.json")) throw new Error("permission denied");
      if (path.endsWith(".vscode/mcp.json")) return "{";
      return undefined;
    });

    const result = await discoverMcpServers({ scope: "project", homeDir: "/home/ada", projectRootDir: "/repo", readFile });

    expect(result.servers).toEqual([]);
    expect(result.errors.join("\n")).toContain("Cursor project: permission denied");
    expect(result.errors.join("\n")).toContain("VS Code project");
    expect(readFile).toHaveBeenCalledTimes(2);
  });
});
