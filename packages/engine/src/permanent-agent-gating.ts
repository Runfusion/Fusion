import type {
  AgentPermissionPolicyDisposition,
  PermanentAgentActionCategory,
  PermanentAgentGatingContext,
  PermanentAgentSensitiveActionCategory,
} from "@fusion/core";
import {
  COMMAND_EXECUTION_FN_TOOLS,
  FILE_SCOPE_FN_TOOLS,
  FILE_WRITE_BUILTIN_TOOLS,
  FILE_WRITE_DELETE_FN_TOOLS,
  NETWORK_API_TOOLS,
  PERMANENT_AGENT_TASK_MUTATION_TOOLS,
  READONLY_BUILTIN_TOOLS,
  READONLY_FN_TOOLS,
  REVIEW_GATE_BYPASS_FN_TOOLS,
  isGitWriteCommand,
} from "./gating-classifications.js";

export interface PermanentAgentToolClassification {
  category: PermanentAgentActionCategory;
  /** True only when the tool is positively recognized and mapped by this module. */
  recognized: boolean;
}

export interface PermanentAgentToolDecision extends PermanentAgentToolClassification {
  toolName: string;
  disposition: AgentPermissionPolicyDisposition;
}

const FILE_WRITE_TOOLS = FILE_WRITE_BUILTIN_TOOLS;

// FN-3724 / FN-3548: heartbeat-completion and internal coordination tools must remain
// category "none" so restrictive permanent-agent policies cannot deadlock heartbeats.
const TASK_AGENT_MUTATION_TOOLS = PERMANENT_AGENT_TASK_MUTATION_TOOLS;
const FILE_WRITE_DELETE_TOOLS = FILE_WRITE_DELETE_FN_TOOLS;
const COMMAND_EXECUTION_TOOLS = COMMAND_EXECUTION_FN_TOOLS;
// FNXC:ToolGovernance 2026-07-09-00:00: FN-7728 — mirror agent-action-gate.ts's review_gate_bypass classification here so the permanent-agent gate resolves fn_task_bypass_review identically (no two-path drift).
const REVIEW_GATE_BYPASS_TOOLS = REVIEW_GATE_BYPASS_FN_TOOLS;
// FNXC:ToolGovernance 2026-07-09-08:30: FN-7737 — mirror agent-action-gate.ts's file_scope classification here so the permanent-agent gate resolves fn_task_file_scope_add identically (no two-path drift).
const FILE_SCOPE_TOOLS = FILE_SCOPE_FN_TOOLS;

function normalizeArgs(args: unknown): Record<string, unknown> {
  return args && typeof args === "object" ? (args as Record<string, unknown>) : {};
}

function extractShellCommand(args: Record<string, unknown>): string {
  const command = args.command;
  return typeof command === "string" ? command.trim() : "";
}

const GATED_SUMMARY_COMMAND_MAX_LENGTH = 200;

function truncateForSummary(value: string, maxLength: number): string {
  const singleLine = value.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxLength) {
    return singleLine;
  }
  return `${singleLine.slice(0, maxLength - 1)}\u2026`;
}

function renderCompactArgs(args: Record<string, unknown>): string {
  const entries = Object.entries(args).filter(([, value]) => value !== undefined);
  if (entries.length === 0) {
    return "";
  }
  const rendered = entries
    .slice(0, 4)
    .map(([key, value]) => {
      const stringValue = typeof value === "string" ? value : JSON.stringify(value);
      return `${key}: ${truncateForSummary(String(stringValue ?? ""), 60)}`;
    })
    .join(", ");
  const suffix = entries.length > 4 ? ", \u2026" : "";
  return `{${rendered}${suffix}}`;
}

/**
 * FNXC:AgentGating 2026-07-05-00:00:
 * FN-7609: operators approving a gated agent action need to see the real
 * payload (shell command line, or tool arguments), not just a generic
 * "Agent gated action for <tool>" placeholder. This pure helper builds a
 * payload-bearing, human-readable summary shared by both permanent-agent
 * gating context builders (executor.ts and agent-heartbeat.ts) so approval
 * cards are actionable instead of blank.
 */
export function buildAgentGatedActionSummary(toolName: string, args: unknown): string {
  const normalizedArgs = normalizeArgs(args);

  if (toolName === "bash") {
    const command = extractShellCommand(normalizedArgs);
    if (command) {
      return `Run: ${truncateForSummary(command, GATED_SUMMARY_COMMAND_MAX_LENGTH)}`;
    }
  }

  const compactArgs = renderCompactArgs(normalizedArgs);
  if (compactArgs) {
    return `${toolName} ${compactArgs}`;
  }

  return `Agent gated action for ${toolName}`;
}


export function classifyPermanentAgentToolCall(
  toolName: string,
  args?: unknown,
): PermanentAgentToolClassification {
  if (FILE_WRITE_TOOLS.has(toolName)) {
    return { category: "file_write_delete", recognized: true };
  }
  if (toolName === "bash") {
    const command = extractShellCommand(normalizeArgs(args));
    return { category: isGitWriteCommand(command) ? "git_write" : "command_execution", recognized: true };
  }
  if (READONLY_BUILTIN_TOOLS.has(toolName)) {
    return { category: "none", recognized: true };
  }
  if (REVIEW_GATE_BYPASS_TOOLS.has(toolName)) {
    return { category: "review_gate_bypass", recognized: true };
  }
  if (FILE_SCOPE_TOOLS.has(toolName)) {
    return { category: "file_scope", recognized: true };
  }
  if (TASK_AGENT_MUTATION_TOOLS.has(toolName)) {
    return { category: "task_agent_mutation", recognized: true };
  }
  if (FILE_WRITE_DELETE_TOOLS.has(toolName)) {
    return { category: "file_write_delete", recognized: true };
  }
  if (COMMAND_EXECUTION_TOOLS.has(toolName)) {
    return { category: "command_execution", recognized: true };
  }
  if (NETWORK_API_TOOLS.has(toolName)) {
    return { category: "network_api", recognized: true };
  }
  if (READONLY_FN_TOOLS.has(toolName) || /^fn_(?:list|show|get|read|browse)_/.test(toolName)) {
    return { category: "none", recognized: true };
  }

  return { category: "none", recognized: false };
}

function resolvePolicyDisposition(
  toolName: string,
  category: PermanentAgentSensitiveActionCategory,
  gating: PermanentAgentGatingContext | undefined,
): AgentPermissionPolicyDisposition {
  /*
  FNXC:ToolPermissions 2026-07-01-00:00:
  Permanent-agent heartbeats use exact tool overrides before category rules so a policy can block `fn_task_create` while leaving sibling task-agent mutations allowed. Unknown tools still fail safe to approval and category `none` coordination tools remain non-configurable.
  */
  return gating?.permissionPolicy?.toolRules?.[toolName]
    ?? gating?.permissionPolicy?.rules?.[category]
    ?? "require-approval";
}

export function resolvePermanentAgentToolDecision(input: {
  toolName: string;
  args?: unknown;
  gating?: PermanentAgentGatingContext;
}): PermanentAgentToolDecision {
  const classification = classifyPermanentAgentToolCall(input.toolName, input.args);

  if (!input.gating?.permissionPolicy) {
    return {
      ...classification,
      toolName: input.toolName,
      disposition: "allow",
    };
  }

  if (classification.category === "none") {
    return {
      ...classification,
      toolName: input.toolName,
      disposition: classification.recognized ? "allow" : "require-approval",
    };
  }

  return {
    ...classification,
    toolName: input.toolName,
    disposition: resolvePolicyDisposition(input.toolName, classification.category, input.gating),
  };
}
