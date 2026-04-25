/**
 * Custom tool discovery and MCP config file generation.
 *
 * Discovers non-built-in tools from pi, writes their schemas to a temp file,
 * and generates an MCP config that points to the schema-only MCP server.
 */

import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

/**
 * A single tool descriptor returned by pi.getAllTools().
 */
interface PiToolInfo {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * Minimal duck-type interface for the pi ExtensionAPI instance.
 * We only call getAllTools(), so we only declare that method.
 * The return type is unknown to accommodate defensive runtime checks.
 */
interface PiInstance {
  getAllTools(): unknown;
}

/** The 6 built-in tools that pi handles natively (match pi tool names). */
const BUILT_IN_TOOL_NAMES = new Set([
  "read",
  "write",
  "edit",
  "bash",
  "grep",
  "find",
]);

/** A custom tool definition with MCP-compatible schema. */
export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Get custom tool definitions from pi, filtering out built-in tools.
 *
 * @param pi - The pi ExtensionAPI instance
 * @returns Array of custom tool definitions (empty if all tools are built-in)
 */
export function getCustomToolDefs(pi: PiInstance): McpToolDef[] {
  const allTools = pi.getAllTools();

  if (!Array.isArray(allTools)) {
    return [];
  }

  return (allTools as PiToolInfo[])
    .filter((tool) => !BUILT_IN_TOOL_NAMES.has(tool.name))
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.parameters,
    }));
}

/**
 * Write MCP config and tool schemas to temp files.
 *
 * Creates two temp files:
 * 1. Schema file: JSON array of tool definitions
 * 2. Config file: MCP config pointing to the schema-only server
 *
 * @param toolDefs - Array of custom tool definitions
 * @param cacheKey - Optional suffix appended to filenames so that distinct
 *   tool sets (e.g. session-scoped tool registrations) get distinct files
 *   and don't race on a single shared path.
 * @returns Path to the MCP config file
 */
export function writeMcpConfig(
  toolDefs: McpToolDef[],
  cacheKey?: string,
): string {
  const suffix = cacheKey ? `${process.pid}-${cacheKey}` : `${process.pid}`;

  // Write tool schemas to temp file
  const schemaFilePath = join(
    tmpdir(),
    `pi-claude-mcp-schemas-${suffix}.json`,
  );
  writeFileSync(schemaFilePath, JSON.stringify(toolDefs));

  // Resolve path to the schema server .cjs file (sibling of this module)
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const serverPath = join(__dirname, "mcp-schema-server.cjs");

  // Build MCP config
  const config = {
    mcpServers: {
      "custom-tools": {
        command: "node",
        args: [serverPath, schemaFilePath],
      },
    },
  };

  // Write config to temp file
  const configFilePath = join(
    tmpdir(),
    `pi-claude-mcp-config-${suffix}.json`,
  );
  writeFileSync(configFilePath, JSON.stringify(config));

  return configFilePath;
}
