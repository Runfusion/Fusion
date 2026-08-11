import { MEMORY_MCP_TOOLS, isMemoryMcpToolName, validateMemoryMcpArguments, type MemoryMcpToolName } from "./memory-mcp-tools.js";
import { resolveMemoryToolBudget, serializeMemoryMcpError, serializeMemoryMcpResult } from "./memory-mcp-serialization.js";
import type { MemoryMcpBackends } from "./memory-mcp-backends.js";

export type MemoryMcpBudgetProvider = () => Promise<{ settings?: { agentToolOutputMaxChars?: number | null | unknown }; overrides?: Record<string, number | null | undefined> } | null>;
type JsonRpc = { jsonrpc: "2.0"; id: string | number; result?: unknown; error?: { code: number; message: string } };

/*
 * FNXC:MemoryMcp 2026-08-11-00:05:
 * Backend errors can include recall text, query values, or database diagnostics. MCP clients need
 * an actionable category, never that untrusted detail, so valid tool failures use this fixed map.
 */
function safeToolFailureMessage(tool: MemoryMcpToolName, error: unknown): string {
  const category = error instanceof Error ? error.message.toLowerCase() : "";
  if (/(duplicate|dedup)/.test(category)) return "Recall entry was rejected as a duplicate";
  if (/(unavailable|connect|database|store)/.test(category)) return tool.startsWith("recall_") ? "Recall store is unavailable" : "Knowledge graph is unavailable";
  return tool.startsWith("recall_") ? "Recall tool failed" : "Knowledge graph tool failed";
}

export class MemoryMcpHandler {
  private budgetPromise: Promise<{ settings?: { agentToolOutputMaxChars?: number | null | unknown }; overrides?: Record<string, number | null | undefined> } | null> | undefined;
  constructor(private readonly backends: MemoryMcpBackends, private readonly budgetProvider?: MemoryMcpBudgetProvider) {}

  private async budget(tool: string): Promise<number | null> {
    this.budgetPromise ??= (this.budgetProvider ? this.budgetProvider() : Promise.resolve(null)).catch(() => null);
    const value = await this.budgetPromise;
    return resolveMemoryToolBudget(value?.settings, value?.overrides, tool);
  }

  async handle(request: unknown): Promise<JsonRpc | undefined> {
    if (!request || typeof request !== "object" || Array.isArray(request)) return undefined;
    const value = request as Record<string, unknown>;
    const id = (typeof value.id === "string" || typeof value.id === "number") ? value.id : undefined;
    if (value.jsonrpc !== "2.0" || typeof value.method !== "string") return id === undefined ? undefined : { jsonrpc: "2.0", id, error: { code: -32600, message: "Invalid JSON-RPC request" } };
    if (id === undefined) return undefined;
    if (value.method === "initialize") return { jsonrpc: "2.0", id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fusion-memory" } } };
    if (value.method === "tools/list") return { jsonrpc: "2.0", id, result: { tools: MEMORY_MCP_TOOLS } };
    if (value.method !== "tools/call") return { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } };
    const params = value.params;
    if (!params || typeof params !== "object" || Array.isArray(params) || !isMemoryMcpToolName((params as Record<string, unknown>).name)) return { jsonrpc: "2.0", id, error: { code: -32602, message: "Unknown memory tool" } };
    const { name, arguments: args } = params as { name: MemoryMcpToolName; arguments?: unknown };
    const validation = validateMemoryMcpArguments(name, args ?? {});
    if (!validation.ok) return { jsonrpc: "2.0", id, error: { code: -32602, message: `Invalid ${validation.field}` } };
    const budget = await this.budget(name);
    try {
      const method = ({ graph_query: "graphQuery", graph_neighbors: "graphNeighbors", graph_shortest_path: "graphShortestPath", recall_search: "recallSearch", recall_append: "recallAppend" } as const)[name];
      const results = await this.backends[method](validation.value);
      const serialized = serializeMemoryMcpResult(name, results, budget, validation.value.limit as number | undefined);
      return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: serialized.text }] } };
    } catch (error) {
      return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: serializeMemoryMcpError(name, safeToolFailureMessage(name, error), budget) }], isError: true } };
    }
  }
}
