import type { AgentLogEntry } from "./types.js";

export const AGENT_LOG_FILENAME = "agent-log.jsonl";
export const AGENT_LOG_TOOL_DETAIL_LIMIT = 4_096;
export const AGENT_LOG_TOOL_DETAIL_TRUNCATION_NOTICE =
  "\n\n[tool output truncated to keep dashboard log views responsive]";
export const AGENT_LOG_TOOL_TYPES = new Set<AgentLogEntry["type"]>([
  "tool",
  "tool_result",
  "tool_error",
]);

/*
 * FNXC:AgentLogging 2026-07-15-16:05:
 * FN-7995 makes failed tool_error detail persist even when verbose tool output is disabled. Keep its shared storage bound identical to other tool details so diagnostic stacks remain safe for JSONL and dashboard reads.
 */
export function truncateAgentLogDetail(
  detail: string | null | undefined,
  type: AgentLogEntry["type"],
): string | undefined {
  if (detail == null) return undefined;
  if (!AGENT_LOG_TOOL_TYPES.has(type)) return detail;
  if (detail.length <= AGENT_LOG_TOOL_DETAIL_LIMIT) return detail;
  return `${detail.slice(0, AGENT_LOG_TOOL_DETAIL_LIMIT)}${AGENT_LOG_TOOL_DETAIL_TRUNCATION_NOTICE}`;
}

export function buildAgentLogSourceRef(taskId: string, lineNo: number): string {
  return `agentLog:${taskId}:${lineNo}`;
}
