import { describe, expect, it } from "vitest";
import { getMcpDiscoverySources, parseDiscoveredMcpServersFromFile } from "../config/mcp-discovery.js";

function pathsFor(platform: NodeJS.Platform, projectRootDir?: string) {
  return getMcpDiscoverySources({ homeDir: platform === "win32" ? "C:\\Users\\Ada" : "/Users/ada", platform, projectRootDir });
}

describe("MCP discovery core helpers", () => {
  it("resolves well-known global and project paths per platform", () => {
    expect(pathsFor("darwin").map((source) => source.path)).toEqual([
      "/Users/ada/Library/Application Support/Claude/claude_desktop_config.json",
      "/Users/ada/.claude.json",
      "/Users/ada/.cursor/mcp.json",
      "/Users/ada/.codeium/windsurf/mcp_config.json",
    ]);
    expect(pathsFor("linux", "/repo").map((source) => source.path)).toEqual([
      "/Users/ada/.config/Claude/claude_desktop_config.json",
      "/Users/ada/.claude.json",
      "/Users/ada/.cursor/mcp.json",
      "/Users/ada/.codeium/windsurf/mcp_config.json",
      "/repo/.cursor/mcp.json",
      "/repo/.vscode/mcp.json",
    ]);
    expect(pathsFor("win32", "C:\\repo").map((source) => source.path)).toEqual([
      "C:\\Users\\Ada\\AppData\\Roaming\\Claude\\claude_desktop_config.json",
      "C:\\Users\\Ada\\.claude.json",
      "C:\\Users\\Ada\\.cursor\\mcp.json",
      "C:\\Users\\Ada\\.codeium\\windsurf\\mcp_config.json",
      "C:\\repo\\.cursor\\mcp.json",
      "C:\\repo\\.vscode\\mcp.json",
    ]);
  });

  it("parses Claude-style MCP config and converts plaintext secrets to descriptors", () => {
    const [source] = pathsFor("darwin");
    const result = parseDiscoveredMcpServersFromFile({
      source,
      contents: JSON.stringify({
        mcpServers: {
          github: { command: "github-mcp", args: ["serve"], env: { GITHUB_TOKEN: "ghp_secret" } },
          docs: { transport: "streamable-http", url: "https://docs.example.test/mcp", headers: { Authorization: "Bearer secret" } },
        },
      }),
    });

    expect(result.errors).toEqual([]);
    expect(result.servers.map((server) => server.definition.name)).toEqual(["github", "docs"]);
    expect(result.servers[0]?.definition).toMatchObject({
      name: "github",
      transport: "stdio",
      env: { GITHUB_TOKEN: { secretRef: "mcp.github.env.GITHUB_TOKEN", scope: "global" } },
    });
    expect(result.servers.flatMap((server) => server.secretsToCreate).map(({ plaintextValue, ...rest }) => rest)).toEqual([
      { serverName: "github", field: "env", key: "GITHUB_TOKEN", scope: "global", suggestedKey: "mcp.github.env.GITHUB_TOKEN" },
      { serverName: "docs", field: "headers", key: "Authorization", scope: "global", suggestedKey: "mcp.docs.headers.Authorization" },
    ]);
    expect(JSON.stringify(result.servers.map((server) => server.definition))).not.toContain("ghp_secret");
    expect(JSON.stringify(result.servers.map((server) => server.definition))).not.toContain("Bearer secret");
  });

  it("normalizes VS Code servers and reports malformed JSON without throwing", () => {
    const source = pathsFor("linux", "/repo").find((candidate) => candidate.id === "vscode-project")!;
    const parsed = parseDiscoveredMcpServersFromFile({
      source,
      contents: JSON.stringify({ servers: { local: { command: "node", args: ["server.js"] } } }),
    });
    expect(parsed.errors).toEqual([]);
    expect(parsed.servers[0]?.definition).toMatchObject({ name: "local", transport: "stdio", command: "node" });

    const malformed = parseDiscoveredMcpServersFromFile({ source, contents: "{" });
    expect(malformed.servers).toEqual([]);
    expect(malformed.errors[0]).toMatch(/JSON|position|Expected/i);
  });
});
