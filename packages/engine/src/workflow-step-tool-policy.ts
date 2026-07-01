import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { TASK_AGENT_MUTATION_TOOLS } from "./gating-classifications.js";

export const READONLY_ALLOWLIST = [
  "read",
  "grep",
  "find",
  "ls",
  "WebSearch",
  "WebFetch",
  "fn_web_fetch",
  "fn_task_show",
  "fn_task_list",
  "fn_insight_list",
  "fn_insight_show",
  "fn_list_agents",
  "fn_get_agent_config",
] as const;

const WRITE_BUILTIN_TOOLS = ["edit", "write", "bash"] as const;

export const DENIED_IN_READONLY = [
  ...WRITE_BUILTIN_TOOLS,
  ...Array.from(TASK_AGENT_MUTATION_TOOLS).sort(),
] as const;

const READONLY_ALLOWLIST_SET = new Set<string>(READONLY_ALLOWLIST);
const DENIED_IN_READONLY_SET = new Set<string>(DENIED_IN_READONLY);

// Note: fn_task_browse_github_issues is read-only by behavior, but readonly sessions
// intentionally exclude host extensions in pi.ts, so it remains absent by default.

export class ReadonlyViolationError extends Error {
  readonly code = "READONLY_VIOLATION" as const;

  constructor(
    public readonly taskId: string,
    public readonly stepName: string,
    public readonly toolName: string,
  ) {
    super(`[readonly-violation] ${stepName} attempted to use denied tool "${toolName}" for task ${taskId}`);
    this.name = "ReadonlyViolationError";
  }
}

export function isReadonlyAllowed(toolName: string): boolean {
  return READONLY_ALLOWLIST_SET.has(toolName.trim());
}

export interface ReadonlyCustomToolFilterOptions {
  /**
   * FNXC:McpConfig 2026-06-29-00:00:
   * Planning and mission interviews use read-only sessions but intentionally opt into MCP session tools after Fusion has connected, namespaced, and materialized those tools. Keep this as a per-tool predicate instead of a blanket `mcp__` name allowlist so other read-only lanes and caller-supplied custom tools remain protected by default.
   */
  allowTool?: (tool: ToolDefinition) => boolean;
}

export function filterCustomToolsForReadonly(
  tools: ToolDefinition[],
  options: ReadonlyCustomToolFilterOptions = {},
): { allowed: ToolDefinition[]; denied: string[] } {
  const allowed: ToolDefinition[] = [];
  const denied: string[] = [];

  for (const tool of tools) {
    const name = tool.name?.trim() ?? "";
    if (!name) continue;
    if (isReadonlyAllowed(name) || options.allowTool?.(tool) === true) {
      allowed.push(tool);
      continue;
    }
    if (DENIED_IN_READONLY_SET.has(name)) {
      denied.push(name);
    }
  }

  return { allowed, denied };
}
