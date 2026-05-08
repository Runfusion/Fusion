import type {
  AgentPermissionPolicy,
  AgentPermissionPolicyActionCategory,
  AgentPermissionPolicyDisposition,
} from "@fusion/core";
import { runtimeLog } from "./logger.js";

export type AgentActionGateResourceType = "file" | "git" | "task" | "agent" | "research" | "command" | "other";

export interface AgentActionGateDecision {
  disposition: "allow" | "block" | "require-approval";
  category: AgentPermissionPolicyActionCategory | "exempt";
  toolName: string;
  operation: string;
  summary: string;
  resourceType: AgentActionGateResourceType;
  resourceId?: string;
  approvalDedupeKey: string;
  metadata: Record<string, unknown>;
}

export interface AgentActionGateContext {
  agentId: string;
  agentName: string;
  isEphemeral: boolean;
  taskId?: string;
  runId?: string;
  permissionPolicy: AgentPermissionPolicy;
  createApprovalRequest: (decision: AgentActionGateDecision, args: Record<string, unknown>) => Promise<unknown>;
  findPendingApprovalByDedupeKey: (dedupeKey: string) => Promise<unknown | null>;
}

// FN-3724: Internal Fusion runtime/coordinator tools never perform external mutations.
// They must bypass user-configurable approval/block policies so permanent-agent heartbeats cannot deadlock.
const DEFAULT_EXEMPT_TOOLS = [
  "read",
  "find",
  "grep",
  "ls",
  "fn_task_update",
  "fn_task_log",
  "fn_task_done",
  "fn_task_document_write",
  "fn_task_document_read",
  "fn_memory_search",
  "fn_memory_get",
  "fn_read_messages",
  "fn_heartbeat_done",
  "fn_task_create",
  "fn_delegate_task",
  "fn_list_agents",
  "fn_agent_show",
  "fn_agent_org_chart",
  "fn_send_message",
  "fn_memory_append",
  "fn_read_evaluations",
  "fn_update_identity",
  "fn_reflect_on_performance",
] as const;

let _exemptTools: Set<string> | null = null;

function getExemptTools(): Set<string> {
  if (!_exemptTools) {
    _exemptTools = new Set(DEFAULT_EXEMPT_TOOLS);
  }
  return _exemptTools;
}

/**
 * Reloads the exempt-tools registry used by the action gate.
 * If no tool list is provided, the canonical default exemption set is restored.
 */
export function reloadExemptTools(newTools?: string[]): string[] {
  const nextTools = newTools ?? [...DEFAULT_EXEMPT_TOOLS];
  _exemptTools = new Set(nextTools);
  const toolNames = [..._exemptTools];
  runtimeLog.log(`[action-gate] Reloaded exempt tools (${toolNames.length})`);
  return toolNames;
}

/**
 * Adds a tool to the exempt-tools registry at runtime.
 */
export function addToExemptTools(toolName: string): string[] {
  const nextTools = new Set(getExemptTools());
  nextTools.add(toolName);
  _exemptTools = new Set(nextTools);
  const toolNames = [..._exemptTools];
  runtimeLog.log(`[action-gate] Added exempt tool: ${toolName}`);
  return toolNames;
}

export function getExemptToolNames(): string[] {
  return [...getExemptTools()];
}

const TASK_AGENT_MANAGEMENT_TOOLS = new Set([
  "fn_task_create",
  "fn_task_add_dep",
  "fn_delegate_task",
  "fn_spawn_agent",
  "fn_update_agent_config",
  "fn_update_identity",
]);

const NETWORK_API_TOOLS = new Set(["fn_research_run"]);

const READONLY_DISCOVERY_TOOLS = new Set(["read", "find", "grep", "ls"]);

const GIT_WRITE_SUBCOMMANDS = new Set([
  "add",
  "commit",
  "merge",
  "rebase",
  "cherry-pick",
  "am",
  "apply",
  "stash",
  "tag",
  "push",
  "reset",
  "rm",
  "mv",
  "clean",
]);

const GIT_READONLY_SUBCOMMANDS = new Set([
  "status",
  "diff",
  "log",
  "show",
  "rev-parse",
]);

function normalizeArgs(args: unknown): Record<string, unknown> {
  return args && typeof args === "object" ? (args as Record<string, unknown>) : {};
}

function extractShellCommand(args: Record<string, unknown>): string {
  const command = args.command;
  return typeof command === "string" ? command.trim() : "";
}

function classifyGitCommand(command: string): { write: boolean; operation: string } | null {
  const match = command.match(/(?:^|&&|\|\||;|\n)\s*git\s+([^\s]+)/);
  if (!match) return null;
  const sub = match[1]?.trim() ?? "";
  if (!sub) return { write: false, operation: "git" };

  if (GIT_READONLY_SUBCOMMANDS.has(sub)) {
    if (sub === "rev-parse" && /--show-current\b/.test(command)) {
      return { write: false, operation: "git rev-parse --show-current" };
    }
    return { write: false, operation: `git ${sub}` };
  }

  if (sub === "branch") {
    const mutatingFlags = /\s-d\b|\s-D\b|\s-m\b|\s-M\b|\s-c\b|\s-C\b/.test(command);
    if (mutatingFlags) {
      return { write: true, operation: "git branch" };
    }
    const tail = command.replace(/^[\s\S]*?\bgit\s+branch\b/, "").trim();
    const hasPositionalArg = tail.length > 0 && !tail.startsWith("-");
    if (hasPositionalArg) {
      return { write: true, operation: "git branch" };
    }
    return { write: false, operation: /--show-current\b/.test(command) ? "git branch --show-current" : "git branch" };
  }

  if (sub === "switch") {
    return { write: /\s-c\b/.test(command), operation: /\s-c\b/.test(command) ? "git switch -c" : "git switch" };
  }

  if (sub === "checkout") {
    return { write: /\s-b\b/.test(command), operation: /\s-b\b/.test(command) ? "git checkout -b" : "git checkout" };
  }

  if (sub === "pull") {
    return { write: /--rebase\b/.test(command), operation: /--rebase\b/.test(command) ? "git pull --rebase" : "git pull" };
  }

  if (sub === "restore") {
    return { write: /--staged\b/.test(command), operation: /--staged\b/.test(command) ? "git restore --staged" : "git restore" };
  }

  if (sub === "remote") {
    const write = /\s+add\b|\s+remove\b|\s+rename\b|\s+set-url\b/.test(command);
    return { write, operation: /\s-v\b/.test(command) ? "git remote -v" : "git remote" };
  }

  if (sub === "worktree") {
    if (/\s+add\b/.test(command)) return { write: true, operation: "git worktree add" };
    if (/\s+remove\b/.test(command)) return { write: true, operation: "git worktree remove" };
    return { write: false, operation: "git worktree" };
  }

  return { write: GIT_WRITE_SUBCOMMANDS.has(sub), operation: `git ${sub}` };
}

export function computeApprovalDedupeKey(input: {
  agentId: string;
  taskId?: string;
  toolName: string;
  category: string;
  resourceType: AgentActionGateResourceType;
  resourceId?: string;
  operation: string;
}): string {
  return [
    input.agentId,
    input.taskId ?? "",
    input.toolName,
    input.category,
    input.resourceType,
    input.resourceId ?? "",
    input.operation,
  ].join("|");
}

export function evaluateAgentActionGate(params: {
  agentId: string;
  taskId?: string;
  toolName: string;
  args: unknown;
  permissionPolicy: AgentPermissionPolicy;
}): AgentActionGateDecision {
  const args = normalizeArgs(params.args);

  let category: AgentPermissionPolicyActionCategory | "exempt" = "exempt";
  let operation = params.toolName;
  let resourceType: AgentActionGateResourceType = "other";
  let resourceId: string | undefined;

  if (params.toolName === "bash") {
    const command = extractShellCommand(args);
    const git = classifyGitCommand(command);
    if (git?.write) {
      category = "git_write";
      operation = git.operation;
      resourceType = "git";
    } else {
      category = "command_execution";
      operation = git?.operation ?? "shell command";
      resourceType = git ? "git" : "command";
    }
  } else if (params.toolName === "write" || params.toolName === "edit") {
    category = "file_write_delete";
    operation = params.toolName;
    resourceType = "file";
    resourceId = typeof args.path === "string" ? args.path : undefined;
  } else if (getExemptTools().has(params.toolName)) {
    category = "exempt";
    operation = params.toolName;
  } else if (READONLY_DISCOVERY_TOOLS.has(params.toolName)) {
    category = "command_execution";
    operation = params.toolName;
    resourceType = "file";
  } else if (TASK_AGENT_MANAGEMENT_TOOLS.has(params.toolName)) {
    category = "task_agent_mutation";
    operation = params.toolName;
    resourceType = params.toolName.includes("agent") || params.toolName.includes("spawn") ? "agent" : "task";
  } else if (NETWORK_API_TOOLS.has(params.toolName)) {
    category = "network_api";
    operation = params.toolName;
    resourceType = "research";
  }

  const disposition: AgentPermissionPolicyDisposition | "allow" = category === "exempt"
    ? "allow"
    : params.permissionPolicy.rules[category];

  const dedupeKey = computeApprovalDedupeKey({
    agentId: params.agentId,
    taskId: params.taskId,
    toolName: params.toolName,
    category,
    resourceType,
    resourceId,
    operation,
  });

  return {
    disposition,
    category,
    toolName: params.toolName,
    operation,
    summary: `${params.toolName}: ${operation}`,
    resourceType,
    ...(resourceId ? { resourceId } : {}),
    approvalDedupeKey: dedupeKey,
    metadata: {},
  };
}

export function buildGateRejection(decision: AgentActionGateDecision, reason: string) {
  return {
    content: [{ type: "text", text: reason }],
    isError: true,
    ok: false,
    error: reason,
    decision,
  };
}
