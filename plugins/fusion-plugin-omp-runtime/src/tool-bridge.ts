/*
FNXC:OmpAcp 2026-07-14-00:05:
Host Fusion custom tools (fn_*) for the OMP ACP agent. ToolDefinition.execute
closures only work in-process, so OmpRuntimeAdapter starts a loopback HTTP
bridge and pairs it with mcp-schema-server.cjs (stdio MCP) that omp connects to
via session/new.mcpServers. Dispose closes the bridge so no port is left open
after the session ends. Ported from fusion-plugin-grok-runtime for full fn_* parity.
*/

import { createServer, type Server } from "node:http";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type { AcpMcpServer } from "./mcp-forwarding.js";

/** Env var name the stdio MCP server uses to reach this process's tool bridge. */
export const FUSION_OMP_TOOL_BRIDGE_URL = "FUSION_OMP_TOOL_BRIDGE_URL";

const BUILT_IN_TOOL_NAMES = new Set(["read", "write", "edit", "bash", "grep", "find"]);

export interface ToolLike {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  execute?: (
    toolCallId: string,
    params: unknown,
    signal?: AbortSignal,
    onUpdate?: unknown,
    ctx?: unknown,
  ) => Promise<unknown> | unknown;
}

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface FusionToolBridge {
  mcpServer: AcpMcpServer;
  dispose: () => Promise<void>;
  toolCount: number;
}

export function toolsToMcpToolDefs(tools: ReadonlyArray<ToolLike> | undefined): McpToolDef[] {
  if (!Array.isArray(tools)) return [];
  return tools
    .filter(
      (tool) =>
        tool &&
        typeof tool.name === "string" &&
        tool.name.trim().length > 0 &&
        !BUILT_IN_TOOL_NAMES.has(tool.name),
    )
    .map((tool) => ({
      name: tool.name,
      description: typeof tool.description === "string" ? tool.description : "",
      inputSchema: tool.parameters ?? { type: "object", properties: {} },
    }));
}

function fusionToolsMcpServerPath(): string {
  // Packaged CLI copies this as mcp-schema-server.cjs next to the bundled plugin.
  return join(dirname(fileURLToPath(import.meta.url)), "mcp-schema-server.cjs");
}

function resultToText(result: unknown): string {
  if (result == null) return "";
  if (typeof result === "string") return result;
  if (typeof result === "object") {
    const obj = result as { content?: unknown; text?: unknown; details?: unknown };
    if (typeof obj.text === "string") return obj.text;
    if (Array.isArray(obj.content)) {
      return obj.content
        .map((block) => {
          if (
            block &&
            typeof block === "object" &&
            "text" in block &&
            typeof (block as { text: unknown }).text === "string"
          ) {
            return (block as { text: string }).text;
          }
          return JSON.stringify(block);
        })
        .join("\n");
    }
  }
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

/**
 * Start a loopback tool bridge and return the ACP mcpServers entry omp should
 * connect to for Fusion custom tools. Returns null when there are no tools.
 */
export async function startFusionToolBridge(
  tools: ReadonlyArray<ToolLike> | undefined,
): Promise<FusionToolBridge | null> {
  const defs = toolsToMcpToolDefs(tools);
  if (defs.length === 0) return null;

  const byName = new Map<string, ToolLike>();
  for (const tool of tools ?? []) {
    if (tool && typeof tool.name === "string" && typeof tool.execute === "function") {
      byName.set(tool.name, tool);
    }
  }

  const schemaPath = join(tmpdir(), `fusion-omp-mcp-schemas-${process.pid}-${randomUUID()}.json`);
  writeFileSync(schemaPath, JSON.stringify(defs));

  const server: Server = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/tool-call") {
      res.statusCode = 404;
      res.end(JSON.stringify({ isError: true, text: "not found" }));
      return;
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    let parsed: { name?: string; arguments?: unknown };
    try {
      parsed = JSON.parse(body || "{}") as { name?: string; arguments?: unknown };
    } catch {
      res.statusCode = 400;
      res.end(JSON.stringify({ isError: true, text: "invalid JSON body" }));
      return;
    }
    const name = typeof parsed.name === "string" ? parsed.name : "";
    const tool = byName.get(name);
    if (!tool?.execute) {
      res.statusCode = 404;
      res.end(JSON.stringify({ isError: true, text: `Unknown Fusion tool: ${name}` }));
      return;
    }
    try {
      const result = await tool.execute(
        `omp-mcp-${randomUUID()}`,
        parsed.arguments ?? {},
        undefined,
        undefined,
        undefined,
      );
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          isError: false,
          content: [{ type: "text", text: resultToText(result) }],
        }),
      );
    } catch (err) {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          isError: true,
          content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
        }),
      );
    }
  });

  const address = await new Promise<{ port: number }>((resolve, reject) => {
    server.once("error", reject);
    // Bind loopback only — never expose Fusion tools on a public interface.
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("tool bridge failed to bind"));
        return;
      }
      resolve({ port: addr.port });
    });
  });

  const bridgeUrl = `http://127.0.0.1:${address.port}`;
  const serverPath = fusionToolsMcpServerPath();

  return {
    toolCount: defs.length,
    mcpServer: {
      name: "fusion-custom-tools",
      command: process.execPath,
      args: [serverPath, schemaPath],
      env: [{ name: FUSION_OMP_TOOL_BRIDGE_URL, value: bridgeUrl }],
    },
    dispose: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
