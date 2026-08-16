/*
FNXC:AcpCustomTools 2026-08-16-00:30:
Host Fusion custom tools (fn_*) for any ACP agent (Hermes ACP, Prime, ...).
ToolDefinition.execute closures only run in-process, so AcpRuntimeAdapter starts
a loopback HTTP bridge and pairs it with mcp-schema-server.cjs (stdio MCP) that
the agent connects to via session/new.mcpServers. Dispose closes the bridge and
removes the temporary schema so no port or file outlives the session.
*/
import { createServer, type Server } from "node:http";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";
import type { AcpMcpServerStdio } from "./types.js";

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
  mcpServer: AcpMcpServerStdio;
  dispose: () => Promise<void>;
  toolCount: number;
}

export function toolsToMcpToolDefs(tools: ReadonlyArray<ToolLike> | undefined): McpToolDef[] {
  if (!Array.isArray(tools)) return [];
  return tools
    .filter((tool) => tool && typeof tool.name === "string" && tool.name.trim().length > 0 && !BUILT_IN_TOOL_NAMES.has(tool.name))
    .map((tool) => ({
      name: tool.name,
      description: typeof tool.description === "string" ? tool.description : "",
      inputSchema: tool.parameters ?? { type: "object", properties: {} },
    }));
}

/*
FNXC:AcpCustomToolsPackaging 2026-08-16-00:30:
The stdio MCP child resolves this asset beside the loaded bridge module. Keep the
source asset co-located for source-loaded plugins and copy it beside dist output
on builds (the Grok postbuild pattern); otherwise the host reports
`handshake failed: connection closed: initialize response` for fusion-custom-tools.
*/
export function fusionToolsMcpServerPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "mcp-schema-server.cjs");
}

function missingMcpSchemaServerError(serverPath: string): Error {
  const error = new Error(`Fusion MCP schema server is missing: ${serverPath}`) as Error & { code?: string };
  error.code = "mcp-schema-server-missing";
  return error;
}

function resultToText(result: unknown): string {
  if (result == null) return "";
  if (typeof result === "string") return result;
  if (typeof result === "object") {
    const obj = result as { content?: unknown; text?: unknown };
    if (typeof obj.text === "string") return obj.text;
    if (Array.isArray(obj.content)) {
      return obj.content
        .map((block) => {
          if (block && typeof block === "object" && "text" in block && typeof (block as { text: unknown }).text === "string") {
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
 * Start a loopback tool bridge and return the ACP mcpServers stdio entry the
 * agent should connect to for Fusion custom tools. Returns null when there are
 * no tools. The bridge authenticates every request with a per-session bearer
 * token so a same-host probe cannot invoke Fusion closures.
 */
export async function startFusionToolBridge(tools: ReadonlyArray<ToolLike> | undefined): Promise<FusionToolBridge | null> {
  const defs = toolsToMcpToolDefs(tools);
  if (defs.length === 0) return null;

  const serverPath = fusionToolsMcpServerPath();
  if (!existsSync(serverPath)) {
    throw missingMcpSchemaServerError(serverPath);
  }

  const byName = new Map<string, ToolLike>();
  for (const tool of tools ?? []) {
    if (tool && typeof tool.name === "string" && typeof tool.execute === "function") {
      byName.set(tool.name, tool);
    }
  }

  const token = randomBytes(24).toString("hex");
  const schemaPath = join(tmpdir(), `fusion-acp-mcp-schemas-${process.pid}-${randomUUID()}.json`);
  writeFileSync(schemaPath, JSON.stringify(defs));

  const server: Server = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/tool-call") {
      res.statusCode = 404;
      res.end(JSON.stringify({ isError: true, text: "not found" }));
      return;
    }
    // Per-session bearer token: the MCP shim carries it; anything else is rejected.
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${token}`) {
      res.statusCode = 401;
      res.end(JSON.stringify({ isError: true, text: "unauthorized" }));
      return;
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    let parsed: { name?: string; toolCallId?: string; arguments?: unknown };
    try {
      parsed = JSON.parse(body || "{}") as { name?: string; toolCallId?: string; arguments?: unknown };
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
      // Thread the real MCP request id as the toolCallId so correlation,
      // cancellation, and dedupe keep working (never a fabricated id).
      const result = await tool.execute(typeof parsed.toolCallId === "string" && parsed.toolCallId ? parsed.toolCallId : `acp-mcp-${randomUUID()}`, parsed.arguments ?? {}, undefined, undefined, undefined);
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
  let disposed = false;

  return {
    toolCount: defs.length,
    mcpServer: {
      name: "fusion-custom-tools",
      command: process.execPath,
      args: [serverPath, schemaPath],
      env: [
        { name: "FUSION_ACP_TOOL_BRIDGE_URL", value: bridgeUrl },
        { name: "FUSION_ACP_TOOL_BRIDGE_TOKEN", value: token },
      ],
    },
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      try {
        unlinkSync(schemaPath);
      } catch {
        // Schema may already be gone; disposal stays idempotent.
      }
    },
  };
}
