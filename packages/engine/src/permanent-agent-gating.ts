import type {
  AgentPermissionPolicyDisposition,
  PermanentAgentActionCategory,
  PermanentAgentGatingContext,
  PermanentAgentSensitiveActionCategory,
} from "@fusion/core";
import {
  FILE_WRITE_BUILTIN_TOOLS,
  FILE_WRITE_DELETE_FN_TOOLS,
  NETWORK_API_TOOLS,
  PERMANENT_AGENT_TASK_MUTATION_TOOLS,
  READONLY_BUILTIN_TOOLS,
  READONLY_FN_TOOLS,
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

function normalizeArgs(args: unknown): Record<string, unknown> {
  return args && typeof args === "object" ? (args as Record<string, unknown>) : {};
}

function extractShellCommand(args: Record<string, unknown>): string {
  const command = args.command;
  return typeof command === "string" ? command.trim() : "";
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
  if (TASK_AGENT_MUTATION_TOOLS.has(toolName)) {
    return { category: "task_agent_mutation", recognized: true };
  }
  if (FILE_WRITE_DELETE_TOOLS.has(toolName)) {
    return { category: "file_write_delete", recognized: true };
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
  category: PermanentAgentSensitiveActionCategory,
  gating: PermanentAgentGatingContext | undefined,
): AgentPermissionPolicyDisposition {
  return gating?.permissionPolicy?.rules?.[category] ?? "require-approval";
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
    disposition: resolvePolicyDisposition(classification.category, input.gating),
  };
}
