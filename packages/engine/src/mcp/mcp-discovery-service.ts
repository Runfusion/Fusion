import { readFile as fsReadFile } from "node:fs/promises";
import { homedir as osHomedir, platform as osPlatform } from "node:os";

import {
  getMcpDiscoverySources,
  parseDiscoveredMcpServersFromFile,
  type DiscoveredMcpServer,
  type McpDiscoverySource,
} from "@fusion/core";

export interface DiscoverMcpServersOptions {
  scope: "global" | "project";
  homeDir?: string;
  projectRootDir?: string;
  readFile?: (path: string) => Promise<string | undefined>;
}

export interface DiscoverMcpServersResult {
  sources: McpDiscoverySource[];
  servers: DiscoveredMcpServer[];
  errors: string[];
}

async function readOptionalTextFile(filePath: string): Promise<string | undefined> {
  try {
    return await fsReadFile(filePath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

/**
 * FNXC:McpConfig 2026-06-26-10:31:
 * Host MCP discovery only reads known config files and delegates parsing to @fusion/core. It never spawns, connects to, or validates discovered servers, and it never resolves Fusion secret references; inline third-party secrets stay confined to import descriptors until the dashboard opt-in flow converts them to managed secret references.
 */
export async function discoverMcpServers(opts: DiscoverMcpServersOptions): Promise<DiscoverMcpServersResult> {
  const homeDir = opts.homeDir ?? process.env.HOME ?? process.env.USERPROFILE ?? osHomedir();
  const readFile = opts.readFile ?? readOptionalTextFile;
  const sources = getMcpDiscoverySources({
    homeDir,
    platform: osPlatform(),
    projectRootDir: opts.projectRootDir,
  }).filter((source) => source.scope === opts.scope);

  const servers: DiscoveredMcpServer[] = [];
  const errors: string[] = [];
  for (const source of sources) {
    let contents: string | undefined;
    try {
      contents = await readFile(source.path);
    } catch (error) {
      errors.push(`${source.label}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (contents === undefined) continue;
    const parsed = parseDiscoveredMcpServersFromFile({ source, contents });
    servers.push(...parsed.servers);
    errors.push(...parsed.errors.map((message) => `${source.label}: ${message}`));
  }

  return { sources, servers, errors };
}
