import type { McpSecretImportDescriptor } from "./mcp-config.js";
import { importMcpServersJson } from "./mcp-config.js";
import type { McpServerDefinition } from "../types.js";

export interface McpDiscoverySource {
  id: string;
  tool: string;
  label: string;
  scope: "global" | "project";
  path: string;
}

export interface DiscoveredMcpServer {
  source: McpDiscoverySource;
  definition: McpServerDefinition;
  secretsToCreate: McpSecretImportDescriptor[];
}

export interface McpDiscoverySourcesOptions {
  homeDir: string;
  platform: NodeJS.Platform;
  projectRootDir?: string;
}

function joinDiscoveryPath(platform: NodeJS.Platform, ...segments: string[]): string {
  const separator = platform === "win32" ? "\\" : "/";
  const [first = "", ...rest] = segments;
  return [first.replace(/[\\/]+$/, ""), ...rest.map((segment) => segment.replace(/^[\\/]+|[\\/]+$/g, ""))].filter(Boolean).join(separator);
}

function claudeDesktopConfigDir(opts: { homeDir: string; platform: NodeJS.Platform }): string {
  if (opts.platform === "darwin") return joinDiscoveryPath(opts.platform, opts.homeDir, "Library", "Application Support");
  if (opts.platform === "win32") return joinDiscoveryPath(opts.platform, opts.homeDir, "AppData", "Roaming");
  return joinDiscoveryPath(opts.platform, opts.homeDir, ".config");
}

/**
 * FNXC:McpConfig 2026-06-26-10:31:
 * MCP discovery resolves only well-known third-party config paths and parses them as inert candidates. Discovery is read-only and opt-in; sensitive env/header/token values are converted into secretsToCreate descriptors by the shared import parser instead of remaining inline plaintext in returned definitions. This resolver/parser never throws so a malformed on-host tool config cannot break settings reads.
 */
export function getMcpDiscoverySources(opts: McpDiscoverySourcesOptions): McpDiscoverySource[] {
  const homeDir = opts.homeDir.trim();
  if (!homeDir) return [];
  const sources: McpDiscoverySource[] = [
    {
      id: "claude-desktop-global",
      tool: "Claude Desktop",
      label: "Claude Desktop",
      scope: "global",
      path: joinDiscoveryPath(opts.platform, claudeDesktopConfigDir({ homeDir, platform: opts.platform }), "Claude", "claude_desktop_config.json"),
    },
    {
      id: "claude-code-global",
      tool: "Claude Code",
      label: "Claude Code",
      scope: "global",
      path: joinDiscoveryPath(opts.platform, homeDir, ".claude.json"),
    },
    {
      id: "cursor-global",
      tool: "Cursor",
      label: "Cursor global",
      scope: "global",
      path: joinDiscoveryPath(opts.platform, homeDir, ".cursor", "mcp.json"),
    },
    {
      id: "windsurf-global",
      tool: "Windsurf",
      label: "Windsurf",
      scope: "global",
      path: joinDiscoveryPath(opts.platform, homeDir, ".codeium", "windsurf", "mcp_config.json"),
    },
  ];

  if (opts.projectRootDir?.trim()) {
    sources.push(
      {
        id: "cursor-project",
        tool: "Cursor",
        label: "Cursor project",
        scope: "project",
        path: joinDiscoveryPath(opts.platform, opts.projectRootDir, ".cursor", "mcp.json"),
      },
      {
        id: "vscode-project",
        tool: "VS Code",
        label: "VS Code project",
        scope: "project",
        path: joinDiscoveryPath(opts.platform, opts.projectRootDir, ".vscode", "mcp.json"),
      },
    );
  }

  return sources;
}

function normalizeDiscoveryContents(source: McpDiscoverySource, contents: string): string | unknown {
  if (source.id !== "vscode-project") return contents;
  const parsed = JSON.parse(contents) as unknown;
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const record = parsed as Record<string, unknown>;
    if (record.mcpServers === undefined && record.servers !== undefined) {
      return { ...record, mcpServers: record.servers };
    }
  }
  return parsed;
}

export function parseDiscoveredMcpServersFromFile(args: { source: McpDiscoverySource; contents: string }): { servers: DiscoveredMcpServer[]; errors: string[] } {
  try {
    const normalized = normalizeDiscoveryContents(args.source, args.contents);
    const result = importMcpServersJson(normalized, { scope: args.source.scope });
    const servers = result.definitions.map((definition) => ({
      source: args.source,
      definition,
      secretsToCreate: result.secretsToCreate.filter((secret) => secret.serverName === definition.name),
    }));
    return { servers, errors: result.errors };
  } catch (error) {
    return {
      servers: [],
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }
}
