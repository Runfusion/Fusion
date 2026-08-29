import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const BUILT_IN_TOOL_NAMES = new Set(["read", "write", "edit", "bash", "grep", "find"]);

export interface ToolLike {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface OpenClawMcpBridgeFiles {
  schemaPath: string;
  serverConfigPath: string;
  serverName: string;
}

export function toolsToMcpToolDefs(tools: ReadonlyArray<ToolLike> | undefined): McpToolDef[] {
  if (!Array.isArray(tools)) return [];
  return tools
    .filter((tool) => tool && typeof tool.name === "string" && !BUILT_IN_TOOL_NAMES.has(tool.name))
    .map((tool) => ({
      name: tool.name,
      description: typeof tool.description === "string" ? tool.description : "",
      inputSchema: tool.parameters ?? { type: "object", properties: {} },
    }));
}

export function writeOpenClawMcpBridgeFiles(toolDefs: McpToolDef[], cacheKey?: string): OpenClawMcpBridgeFiles {
  const suffix = cacheKey ? `${process.pid}-${cacheKey}` : `${process.pid}`;
  const schemaPath = join(tmpdir(), `openclaw-runtime-mcp-schemas-${suffix}.json`);
  writeFileSync(schemaPath, JSON.stringify(toolDefs));

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const serverPath = join(__dirname, "mcp-schema-server.cjs");

  const serverConfig = {
    command: "node",
    args: [serverPath, schemaPath],
  };

  const serverConfigPath = join(tmpdir(), `openclaw-runtime-mcp-server-${suffix}.json`);
  writeFileSync(serverConfigPath, JSON.stringify(serverConfig));

  return {
    schemaPath,
    serverConfigPath,
    serverName: "fusion-custom-tools",
  };
}
