/*
FNXC:ClaudeAcp 2026-07-11-14:00:
Host Fusion custom tools (fn_*) for the Claude ACP agent. ToolDefinition.execute
closures only work in-process, so ClaudeRuntimeAdapter starts a loopback HTTP
bridge and pairs it with fusion-tools-mcp-server.cjs (stdio MCP) that Claude
connects to via session/new.mcpServers. Dispose closes the bridge so no port
is left open after the session ends.
*/

import { createServer, type Server } from "node:http";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";
import { effectiveDisposition, runApprovalForCategory } from "./acp/control-handler.js";
import type { FusionCategory } from "./acp/types.js";
import type { AcpMcpServer } from "./mcp-forwarding.js";
import type { PermissionGate } from "./types.js";

const BUILT_IN_TOOL_NAMES = new Set(["read", "write", "edit", "bash", "grep", "find"]);
const MAX_TOOL_CALL_BODY_BYTES = 1_048_576;

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

export interface FusionToolBridgeOptions {
  /** Per-session engine action gate; absent gates default-deny custom tool calls. */
  actionGateContext?: PermissionGate;
  /** Honours the ACP runtime's explicit unrestricted-risk acknowledgement. */
  allowUnrestricted?: boolean;
}

/**
 * Fusion fn_* tools can mutate tasks, agents, secrets, and the workspace. They
 * therefore use the action gate's task/agent mutation category as the
 * conservative common floor instead of trusting a tool name supplied by ACP.
 */
const FUSION_TOOL_CATEGORY: FusionCategory = "task_agent_mutation";

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
 * Start a loopback tool bridge and return the ACP mcpServers entry Claude should
 * connect to for Fusion custom tools. Returns null when there are no tools.
 */
export async function startFusionToolBridge(
  tools: ReadonlyArray<ToolLike> | undefined,
  options: FusionToolBridgeOptions = {},
): Promise<FusionToolBridge | null> {
  const defs = toolsToMcpToolDefs(tools);
  if (defs.length === 0) return null;

  const byName = new Map<string, ToolLike>();
  for (const tool of tools ?? []) {
    if (tool && typeof tool.name === "string" && typeof tool.execute === "function") {
      byName.set(tool.name, tool);
    }
  }

  const schemaPath = join(tmpdir(), `fusion-claude-mcp-schemas-${process.pid}-${randomUUID()}.json`);
  writeFileSync(schemaPath, JSON.stringify(defs));
  const capabilityToken = randomBytes(32).toString("base64url");

  const server: Server = createServer(async (req, res) => {
    const reject = (statusCode: number, text: string): void => {
      res.statusCode = statusCode;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ isError: true, text }));
    };
    if (req.method !== "POST" || req.url !== "/tool-call") {
      reject(404, "not found");
      return;
    }
    if (req.headers.authorization !== `Bearer ${capabilityToken}`) {
      reject(401, "unauthorized");
      return;
    }
    let body = "";
    let bodyBytes = 0;
    try {
      for await (const chunk of req) {
        bodyBytes += Buffer.byteLength(chunk);
        if (bodyBytes > MAX_TOOL_CALL_BODY_BYTES) {
          // Drain the remaining stream before returning a bounded rejection so
          // the client receives a deterministic 413 instead of a reset socket.
          req.resume();
          reject(413, "tool call body exceeds limit");
          return;
        }
        body += chunk;
      }
    } catch {
      if (!res.writableEnded) reject(400, "invalid request body");
      return;
    }
    let parsed: { name?: string; arguments?: unknown };
    try {
      parsed = JSON.parse(body || "{}") as { name?: string; arguments?: unknown };
    } catch {
      reject(400, "invalid JSON body");
      return;
    }
    const name = typeof parsed.name === "string" ? parsed.name : "";
    const tool = byName.get(name);
    if (!tool?.execute) {
      reject(404, `Unknown Fusion tool: ${name}`);
      return;
    }

    /*
    FNXC:ClaudeAcp 2026-07-17-15:30:
    The loopback port is not an authorization boundary: another local process
    can discover it. Require the per-session capability token and evaluate each
    fn_* call through Fusion's action gate before its in-process closure runs.
    Missing policy/HITL support is default-deny; custom tools are conservatively
    categorized as task_agent_mutation rather than trusting ACP-provided names.
    */
    const gate = options.actionGateContext;
    if (!gate?.permissionPolicy) {
      reject(403, "Fusion action policy is unavailable for this tool call");
      return;
    }
    const disposition = effectiveDisposition(FUSION_TOOL_CATEGORY, gate, {
      allowUnrestricted: options.allowUnrestricted === true,
    });
    const allowed =
      disposition === "allow"
        ? true
        : disposition === "require-approval"
          ? await runApprovalForCategory(gate, {
              category: FUSION_TOOL_CATEGORY,
              toolName: name,
              dedupeKey: `claude-mcp|${name}|${JSON.stringify(parsed.arguments ?? {})}`,
              args:
                parsed.arguments && typeof parsed.arguments === "object"
                  ? (parsed.arguments as Record<string, unknown>)
                  : {},
            }) === "allow"
          : false;
    if (!allowed) {
      reject(403, "Fusion action policy denied this tool call");
      return;
    }
    try {
      const result = await tool.execute(`claude-mcp-${randomUUID()}`, parsed.arguments ?? {}, undefined, undefined, undefined);
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
      env: [
        { name: "FUSION_GROK_TOOL_BRIDGE_URL", value: bridgeUrl },
        { name: "FUSION_TOOL_BRIDGE_CAPABILITY", value: capabilityToken },
      ],
    },
    dispose: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      // FNXC:ClaudeAcp 2026-07-17-11:35: The schema is session-scoped and can
      // contain tool descriptions. Remove it with the loopback server so repeated
      // Claude sessions do not leave unbounded artifacts in the OS temp directory.
      rmSync(schemaPath, { force: true });
    },
  };
}
