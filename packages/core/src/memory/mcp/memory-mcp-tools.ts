export const MEMORY_MCP_TOOL_NAMES = [
  "graph_query",
  "graph_neighbors",
  "graph_shortest_path",
  "recall_search",
  "recall_append",
] as const;

export type MemoryMcpToolName = typeof MEMORY_MCP_TOOL_NAMES[number];
export const MEMORY_MCP_MAX_RESULTS = 100;

const limit = { type: "integer", minimum: 1, maximum: MEMORY_MCP_MAX_RESULTS } as const;

/** MCP 2024-11-05 schemas are deliberately JSON Schema objects, not SDK-specific schemas. */
export const MEMORY_MCP_TOOLS = [
  { name: "graph_query", description: "Query deterministic Fusion knowledge graph nodes.", inputSchema: { type: "object", properties: { filter: { type: "object" }, limit }, additionalProperties: false } },
  { name: "graph_neighbors", description: "Find graph neighbors while retaining edge provenance.", inputSchema: { type: "object", required: ["nodeId"], properties: { nodeId: { type: "string", minLength: 1 }, direction: { enum: ["in", "out", "both"] }, edgeKinds: { type: "array", items: { type: "string" } }, depth: { type: "integer", minimum: 0 }, limit }, additionalProperties: false } },
  { name: "graph_shortest_path", description: "Find a graph shortest path with provenance-bearing edges.", inputSchema: { type: "object", required: ["fromId", "toId"], properties: { fromId: { type: "string", minLength: 1 }, toId: { type: "string", minLength: 1 }, limit }, additionalProperties: false } },
  { name: "recall_search", description: "Search persisted project recall.", inputSchema: { type: "object", required: ["query"], properties: { query: { type: "string", minLength: 1 }, kinds: { type: "array", items: { enum: ["decision", "preference", "solution"] } }, tags: { type: "array", items: { type: "string" } }, limit }, additionalProperties: false } },
  { name: "recall_append", description: "Append durable project recall, subject to deduplication.", inputSchema: { type: "object", required: ["kind", "content", "source"], properties: { kind: { enum: ["decision", "preference", "solution"] }, content: { type: "string", minLength: 1 }, source: { type: "object" }, tags: { type: "array", items: { type: "string" } }, graphNodeIds: { type: "array", items: { type: "string" } } }, additionalProperties: false } },
] as const;

export function isMemoryMcpToolName(value: unknown): value is MemoryMcpToolName {
  return typeof value === "string" && (MEMORY_MCP_TOOL_NAMES as readonly string[]).includes(value);
}

/** Returns a compact protocol-safe validation message instead of allowing tool dispatch to throw. */
export function validateMemoryMcpArguments(name: MemoryMcpToolName, args: unknown): { ok: true; value: Record<string, unknown> } | { ok: false; field: string } {
  if (!args || typeof args !== "object" || Array.isArray(args)) return { ok: false, field: "arguments" };
  const value = args as Record<string, unknown>;
  const allowed = {
    graph_query: ["filter", "limit"],
    graph_neighbors: ["nodeId", "direction", "edgeKinds", "depth", "limit"],
    graph_shortest_path: ["fromId", "toId", "limit"],
    recall_search: ["query", "kinds", "tags", "limit"],
    recall_append: ["kind", "content", "source", "tags", "graphNodeIds"],
  }[name];
  const nonEmpty = (field: string) => typeof value[field] === "string" && value[field].trim().length > 0;
  const stringArray = (field: string) => value[field] === undefined || (Array.isArray(value[field]) && value[field].every(item => typeof item === "string"));
  const unknownField = Object.keys(value).find(field => !allowed.includes(field));
  if (unknownField) return { ok: false, field: unknownField };
  if (value.limit !== undefined && (!Number.isInteger(value.limit) || (value.limit as number) < 1 || (value.limit as number) > MEMORY_MCP_MAX_RESULTS)) return { ok: false, field: "limit" };
  if (name === "graph_query" && value.filter !== undefined && (!value.filter || typeof value.filter !== "object" || Array.isArray(value.filter))) return { ok: false, field: "filter" };
  if (name === "graph_neighbors") {
    if (!nonEmpty("nodeId")) return { ok: false, field: "nodeId" };
    if (value.direction !== undefined && value.direction !== "in" && value.direction !== "out" && value.direction !== "both") return { ok: false, field: "direction" };
    if (!stringArray("edgeKinds")) return { ok: false, field: "edgeKinds" };
    if (value.depth !== undefined && (!Number.isInteger(value.depth) || (value.depth as number) < 0)) return { ok: false, field: "depth" };
  }
  if (name === "graph_shortest_path" && (!nonEmpty("fromId") || !nonEmpty("toId"))) return { ok: false, field: !nonEmpty("fromId") ? "fromId" : "toId" };
  if (name === "recall_search") {
    if (!nonEmpty("query")) return { ok: false, field: "query" };
    if (!stringArray("tags")) return { ok: false, field: "tags" };
    if (value.kinds !== undefined && (!Array.isArray(value.kinds) || !value.kinds.every(kind => kind === "decision" || kind === "preference" || kind === "solution"))) return { ok: false, field: "kinds" };
  }
  if (name === "recall_append") {
    if (value.kind !== "decision" && value.kind !== "preference" && value.kind !== "solution") return { ok: false, field: "kind" };
    if (!nonEmpty("content")) return { ok: false, field: "content" };
    if (!value.source || typeof value.source !== "object" || Array.isArray(value.source)) return { ok: false, field: "source" };
    if (!stringArray("tags")) return { ok: false, field: "tags" };
    if (!stringArray("graphNodeIds")) return { ok: false, field: "graphNodeIds" };
  }
  return { ok: true, value };
}
