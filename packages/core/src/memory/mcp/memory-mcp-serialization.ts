import {
  DEFAULT_TOOL_OUTPUT_MAX_CHARS,
  buildToolOutputTruncationMarker,
  clampToolOutputText,
  resolveAgentToolOutputMaxChars,
  resolveToolOutputBudget,
} from "../../tool-output-budget.js";

export const MEMORY_TOOL_TRUNCATION_HINT = "narrow the memory query or lower its limit";
export const CLAMP_PREFIX = "Memory MCP response was character-truncated and is not parseable JSON.\n";
/** The prefix and canonical marker must fit together before the fallback can satisfy its cap. */
export const MEMORY_TOOL_MIN_TEXT_BUDGET = CLAMP_PREFIX.length + buildToolOutputTruncationMarker(MEMORY_TOOL_TRUNCATION_HINT).length + 1;

export function resolveMemoryToolBudget(
  settings: { agentToolOutputMaxChars?: number | null | unknown } | undefined,
  overrides: Readonly<Record<string, number | null | undefined>> | undefined,
  toolName: string,
): number | null {
  const base = resolveAgentToolOutputMaxChars(settings ?? { agentToolOutputMaxChars: DEFAULT_TOOL_OUTPUT_MAX_CHARS });
  if (base === null) return null;
  let resolved = base;
  try { resolved = resolveToolOutputBudget(toolName, overrides, base); } catch { /* invalid user override must not break MCP transport */ }
  return Math.max(resolved, MEMORY_TOOL_MIN_TEXT_BUDGET);
}

export type MemoryMcpSerialized = { text: string; truncated: boolean; omittedCount: number };

/**
 * FNXC:MemoryMcp 2026-08-10-19:21:
 * Memory traversal output drops complete trailing results before character clamping so retained graph
 * edges keep their extracted/inferred provenance and ordinary responses remain parseable JSON.
 */
export function serializeMemoryMcpResult(tool: string, items: readonly unknown[], budget: number | null, requestedLimit?: number): MemoryMcpSerialized {
  const results = items.slice(0, Math.min(requestedLimit ?? items.length, 100));
  if (budget === null) return { text: JSON.stringify({ tool, results, truncated: false, omittedCount: 0 }), truncated: false, omittedCount: 0 };
  const kept = results.slice(); let omittedCount = 0; let text = JSON.stringify({ tool, results: kept, truncated: false, omittedCount: 0 });
  while (text.length > budget && kept.length > 1) {
    kept.pop(); omittedCount += 1;
    text = JSON.stringify({ tool, results: kept, truncated: true, omittedCount });
  }
  if (text.length <= budget) return { text, truncated: omittedCount > 0, omittedCount };
  return { text: clampToolOutputText(CLAMP_PREFIX + text, { maxChars: budget, hint: MEMORY_TOOL_TRUNCATION_HINT }), truncated: true, omittedCount };
}

export function serializeMemoryMcpError(tool: string, message: string, budget: number | null): string {
  const text = JSON.stringify({ tool, results: [], truncated: false, omittedCount: 0, error: message });
  return budget === null ? text : clampToolOutputText(text, { maxChars: budget, hint: MEMORY_TOOL_TRUNCATION_HINT });
}
