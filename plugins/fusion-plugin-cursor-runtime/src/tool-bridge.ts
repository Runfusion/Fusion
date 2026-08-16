/*
FNXC:CursorMcpBridge 2026-08-15-20:56:
Cursor launches MCP servers from its project config, but Fusion tool closures remain in this process.
A per-session capability token limits the loopback bridge to its stdio child; never expose this endpoint beyond localhost or log its token.
*/
import { timingSafeEqual, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, unlinkSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface ToolLike { name: string; description?: string; parameters?: Record<string, unknown>; execute?: (id: string, args: unknown, signal?: AbortSignal, update?: unknown, context?: unknown) => unknown | Promise<unknown>; }
export interface McpToolDef { name: string; description: string; inputSchema: Record<string, unknown>; }
export interface CursorToolBridge { serverEntry: { command: string; args: string[]; env: Record<string, string> }; dispose: () => Promise<void>; toolCount: number; token: string; }
/*
FNXC:CursorMcpBridge 2026-08-15-23:46:
The engine passes a dedicated identity-derived Fusion-tool subset. Keep fn_* and executable checks here as defense in depth; names alone never establish provenance.
*/
export const toolsToMcpToolDefs = (tools: readonly ToolLike[] | undefined): McpToolDef[] => (tools ?? [])
  .filter((tool) => tool?.name.startsWith("fn_") && typeof tool.execute === "function")
  .map((tool) => ({ name: tool.name, description: tool.description ?? "", inputSchema: tool.parameters ?? { type: "object", properties: {} } }));
export const cursorMcpSchemaServerPath = (): string => join(dirname(fileURLToPath(import.meta.url)), "mcp-schema-server.cjs");
const text = (value: unknown): string => { if (value == null) return ""; if (typeof value === "string") return value; if (typeof value === "object" && value && "text" in value && typeof (value as { text?: unknown }).text === "string") return (value as { text: string }).text; try { return JSON.stringify(value); } catch { return String(value); } };
const loopback = (address: string | undefined) => address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
export async function startCursorToolBridge(tools: readonly ToolLike[] | undefined): Promise<CursorToolBridge | null> {
  const defs = toolsToMcpToolDefs(tools); if (!defs.length) return null;
  const asset = cursorMcpSchemaServerPath(); if (!existsSync(asset)) { const error = Object.assign(new Error(`Fusion MCP schema server is missing: ${asset}`), { code: "mcp-schema-server-missing" }); throw error; }
  const token = randomUUID();
  const publishedNames = new Set(defs.map((tool) => tool.name));
  const byName = new Map((tools ?? []).filter((tool) => publishedNames.has(tool.name) && typeof tool.execute === "function").map((tool) => [tool.name, tool]));
  const schema = join(tmpdir(), `fusion-cursor-mcp-schemas-${process.pid}-${randomUUID()}.json`); writeFileSync(schema, JSON.stringify(defs), { mode: 0o600 }); chmodSync(schema, 0o600);
  const server = createServer(async (req, res) => {
    const host = req.headers.host; const localHost = `127.0.0.1:${(server.address() as { port: number } | null)?.port ?? ""}`;
    const auth = req.headers.authorization; const provided = auth?.startsWith("Bearer ") ? auth.slice(7) : "";
    const matches = provided.length === token.length && timingSafeEqual(Buffer.from(provided), Buffer.from(token));
    if (!loopback(req.socket.remoteAddress) || host !== localHost || !matches) { res.statusCode = 401; res.end(); return; }
    if (req.method !== "POST" || req.url !== "/tool-call") { res.statusCode = 404; res.end(); return; }
    let raw = ""; for await (const chunk of req) raw += chunk;
    let body: { name?: string; arguments?: unknown }; try { body = JSON.parse(raw || "{}"); } catch { res.statusCode = 400; res.end(JSON.stringify({ isError: true, text: "invalid JSON body" })); return; }
    const tool = typeof body.name === "string" ? byName.get(body.name) : undefined;
    res.setHeader("content-type", "application/json");
    if (!tool?.execute) { res.end(JSON.stringify({ isError: true, content: [{ type: "text", text: "Unknown Fusion tool" }] })); return; }
    try { const result = await tool.execute(`cursor-mcp-${randomUUID()}`, body.arguments ?? {}); res.end(JSON.stringify({ isError: false, content: [{ type: "text", text: text(result) }] })); } catch (error) { res.end(JSON.stringify({ isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] })); }
  });
  const port = await new Promise<number>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)); });
  return { token, toolCount: defs.length, serverEntry: { command: process.execPath, args: [asset, schema], env: { FUSION_CURSOR_TOOL_BRIDGE_URL: `http://127.0.0.1:${port}`, FUSION_CURSOR_TOOL_BRIDGE_TOKEN: token } }, dispose: async () => { await new Promise<void>((resolve) => server.close(() => resolve())); try { unlinkSync(schema); } catch { /* schema was already removed */ } } };
}
