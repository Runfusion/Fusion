import { MOCK_PROVIDER_ID } from "@fusion/core";
import { createLogger } from "../logger.js";

const mcpRuntimeLog = createLogger("mcp-runtime");
/*
FNXC:OmpAcp 2026-07-11-23:35:
`omp` is the Oh My Pi ACP runtime (fusion-plugin-omp-runtime). It speaks
session/new.mcpServers like other ACP agents, so operator MCP must be eligible
for forwarding when that runtime is selected.
*/
const SUPPORTED_RUNTIME_IDS = new Set([
  "pi",
  "default-pi",
  "claude",
  "claude-code",
  "claude-acp",
  "acp",
  "omp",
]);

function normalizeId(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

/**
 * FNXC:McpConfig 2026-06-25-21:35:
 * MCP server definitions may contain materialized secrets by the time they reach runtime forwarding, so support decisions must be pure and content-free. Only known MCP-capable pi/Claude/ACP runtimes receive servers; mock and unknown runtimes skip forwarding without inspecting or logging server definitions.
 */
export function runtimeSupportsMcp(runtimeId: string | undefined, provider?: string): boolean {
  if (normalizeId(provider) === MOCK_PROVIDER_ID) return false;
  const normalizedRuntimeId = normalizeId(runtimeId);
  if (!normalizedRuntimeId) return false;
  if (SUPPORTED_RUNTIME_IDS.has(normalizedRuntimeId)) return true;
  // Vendor/plugin runtime ids often include their transport family in a prefix/suffix; keep this content-free fuzzy match so future Claude/ACP runtimes do not need to expose server definitions to prove support.
  return normalizedRuntimeId.includes("claude") || normalizedRuntimeId.includes("acp");
}

export interface McpForwardingSkipDetails {
  runtimeId?: string;
  provider?: string;
  skippedCount: number;
  lane?: string;
}

export function logMcpForwardingSkipped(details: McpForwardingSkipDetails): void {
  if (details.skippedCount <= 0) return;
  mcpRuntimeLog.log(JSON.stringify({
    event: "mcp.forwarding.skipped",
    reason: "unsupported-runtime",
    runtimeId: details.runtimeId ?? null,
    provider: details.provider ?? null,
    lane: details.lane ?? null,
    skippedCount: details.skippedCount,
  }));
}
