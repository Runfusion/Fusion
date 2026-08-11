import type { AgentMemoryInclusionMode } from "../types/settings/settings-scope.js";

/** A stable assertion marker shared by every memory instruction surface. */
export const MEMORY_PRE_STEERING_MARKER = "query memory before re-reading";

/** Prompt-footprint cap for the detailed memory-first instruction. */
export const MAX_PRE_STEERING_FULL_BYTES = 360;

/** Prompt-footprint cap for the terse index-mode instruction. */
export const MAX_PRE_STEERING_INDEX_BYTES = 180;

function clampUtf8(input: string, maxBytes: number): string {
  if (Buffer.byteLength(input, "utf8") <= maxBytes) return input;
  let output = "";
  for (const character of input) {
    if (Buffer.byteLength(output + character, "utf8") > maxBytes) break;
    output += character;
  }
  return output;
}

/*
FNXC:MemoryPreSteering 2026-08-11-11:13:
FN-8934 prevents a single-lane memory prompt from silently leaving other agent
lanes to re-discover raw sources. Off must emit no nudge, while explicit UTF-8
budgets keep index and full steering from growing prompt footprints. This only
steers retrieval order; extraction, recall persistence, and MCP remain unchanged.
*/
export function buildMemoryPreSteeringNudge(mode: AgentMemoryInclusionMode): string {
  if (mode === "off") return "";
  if (mode === "index") {
    return clampUtf8(
      "Memory-first: query memory before re-reading raw sources. Use fn_memory_search, then fn_memory_get only for relevant excerpts.",
      MAX_PRE_STEERING_INDEX_BYTES,
    );
  }
  return clampUtf8(
    `Memory-first:\n- query memory before re-reading raw sources or re-deriving context.\n- Prefer fn_memory_search, then fn_memory_get for relevant excerpts.\n- Treat durable conventions, decisions, and pitfalls as higher priority than re-scanning; skip memory when irrelevant.`,
    MAX_PRE_STEERING_FULL_BYTES,
  );
}
