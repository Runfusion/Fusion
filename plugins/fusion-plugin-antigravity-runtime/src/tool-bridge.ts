import { randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface ToolLike { name: string; description?: string; parameters?: Record<string, unknown>; execute?: (id: string, args: unknown, signal?: AbortSignal) => unknown | Promise<unknown> }
export interface AntigravityToolBridge { serverEntry: { command: string; args: string[]; env: Record<string, string> }; dispose: () => Promise<void>; toolCount: number }
const MAX_RESULT_LENGTH = 8_000;

/** FNXC:AntigravityMcpBridge 2026-09-20-18:32: A tokenized loopback bridge publishes only the engine-proven executable fn_* subset, never arbitrary configured MCP definitions. */
export function toolsToMcpToolDefs(tools: readonly ToolLike[] | undefined) {
  return (tools ?? []).filter((tool) => tool.name.startsWith("fn_") && typeof tool.execute === "function").map((tool) => ({ name: tool.name, description: tool.description ?? "", inputSchema: tool.parameters ?? { type: "object", properties: {} } }));
}
export function antigravityMcpSchemaServerPath(): string { return join(dirname(fileURLToPath(import.meta.url)), "mcp-schema-server.cjs"); }
function bounded(value: unknown): string { let text: string; try { text = typeof value === "string" ? value : JSON.stringify(value); } catch { text = "Tool result unavailable"; } return (text ?? "").slice(0, MAX_RESULT_LENGTH); }

export async function startAntigravityToolBridge(tools: readonly ToolLike[] | undefined): Promise<AntigravityToolBridge | null> {
  const definitions = toolsToMcpToolDefs(tools);
  if (!definitions.length) return null;
  const asset = antigravityMcpSchemaServerPath();
  if (!existsSync(asset)) throw Object.assign(new Error("Fusion MCP schema server is missing."), { code: "mcp-schema-server-missing" });
  const token = randomUUID();
  const approved = new Map((tools ?? []).filter((tool) => definitions.some((def) => def.name === tool.name) && typeof tool.execute === "function").map((tool) => [tool.name, tool]));
  const schema = join(tmpdir(), `fusion-antigravity-mcp-${process.pid}-${randomUUID()}.json`);
  writeFileSync(schema, JSON.stringify(definitions), { mode: 0o600 }); chmodSync(schema, 0o600);
  const server = createServer(async (request, response) => {
    const address = server.address(); const port = address && typeof address === "object" ? address.port : undefined;
    const expectedHost = `127.0.0.1:${port ?? ""}`;
    const bearer = request.headers.authorization?.startsWith("Bearer ") ? request.headers.authorization.slice(7) : "";
    const authenticated = bearer.length === token.length && timingSafeEqual(Buffer.from(bearer), Buffer.from(token));
    if (request.socket.remoteAddress !== "127.0.0.1" || request.headers.host !== expectedHost || !authenticated) { response.statusCode = 401; response.end(); return; }
    if (request.method !== "POST" || request.url !== "/tool-call") { response.statusCode = 404; response.end(); return; }
    let raw = ""; for await (const chunk of request) raw += String(chunk);
    let body: { name?: unknown; arguments?: unknown }; try { body = JSON.parse(raw) as { name?: unknown; arguments?: unknown }; } catch { response.statusCode = 400; response.end(); return; }
    const tool = typeof body.name === "string" ? approved.get(body.name) : undefined;
    response.setHeader("content-type", "application/json");
    if (!tool?.execute) { response.end(JSON.stringify({ isError: true, content: [{ type: "text", text: "Unknown Fusion tool" }] })); return; }
    try { const result = await tool.execute(`antigravity-mcp-${randomUUID()}`, body.arguments ?? {}); response.end(JSON.stringify({ isError: false, content: [{ type: "text", text: bounded(result) }] })); } catch { response.end(JSON.stringify({ isError: true, content: [{ type: "text", text: "Fusion tool failed" }] })); }
  });
  const port = await new Promise<number>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)); });
  let disposed = false;
  return { toolCount: definitions.length, serverEntry: { command: process.execPath, args: [asset, schema], env: { FUSION_ANTIGRAVITY_TOOL_BRIDGE_URL: `http://127.0.0.1:${port}`, FUSION_ANTIGRAVITY_TOOL_BRIDGE_TOKEN: token } }, dispose: async () => { if (disposed) return; disposed = true; await new Promise<void>((resolve) => server.close(() => resolve())); try { unlinkSync(schema); } catch { /* disposal remains idempotent after process cleanup */ } } };
}
