import type { McpServersSettings } from "../types.js";

export const FUSION_MEMORY_MCP_SERVER_NAME = "fusion-memory";
export const FUSION_MEMORY_MCP_LABEL = "Fusion memory";
export const FUSION_MEMORY_MCP_TOOL_IDS = ["graph_query", "graph_neighbors", "graph_shortest_path", "recall_search", "recall_append"] as const;
export const FUSION_MEMORY_MCP_DESCRIPTION = "Built-in Fusion knowledge graph and durable recall tools.";
export function isBuiltInMcpServerName(name: string): boolean { return name === FUSION_MEMORY_MCP_SERVER_NAME; }

type Toggle = { scope: "global" | "project"; intent: "enable" | "disable"; lowerScopeTombstoned?: boolean };
/** Shared pure settings mutation keeps CLI and browser toggle semantics byte-identical. */
export function applyBuiltInMcpToggle(settings: McpServersSettings | undefined, toggle: Toggle): McpServersSettings {
  const servers = (settings?.servers ?? []).filter(server => server.name !== FUSION_MEMORY_MCP_SERVER_NAME);
  if (toggle.intent === "disable") servers.push({ name: FUSION_MEMORY_MCP_SERVER_NAME, enabled: false } as never);
  if (toggle.intent === "enable" && toggle.scope === "project" && toggle.lowerScopeTombstoned) servers.push({ name: FUSION_MEMORY_MCP_SERVER_NAME, enabled: true } as never);
  return { enabled: settings?.enabled ?? true, servers };
}
