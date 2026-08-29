import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { McpServerDefinition } from "../types.js";
import { FUSION_MEMORY_MCP_SERVER_NAME } from "./mcp-builtin-descriptor.js";

/** Missing packaged/source entry is a normal bootstrap degradation, never a session failure. */
export function resolveFusionMemoryMcpEntry(): string | null {
  const override = process.env.FUSION_MEMORY_MCP_ENTRY;
  const candidates = [override, resolve(dirname(process.argv[1] ?? process.cwd()), "bin.js"), resolve(process.cwd(), "packages/cli/dist/bin.js"), process.argv[1]];
  return candidates.find((candidate): candidate is string => Boolean(candidate && existsSync(candidate))) ?? null;
}

export function buildFusionMemoryBuiltIns(projectRoot: string | undefined | null, entry: string | null | undefined = undefined): McpServerDefinition[] {
  const root = projectRoot?.trim();
  const resolved = entry === undefined ? resolveFusionMemoryMcpEntry() : entry;
  if (!root || !resolved) return [];
  return [{ name: FUSION_MEMORY_MCP_SERVER_NAME, transport: "stdio", command: process.execPath, args: [resolved, "mcp", "serve-memory", "--project-root", root] }];
}
