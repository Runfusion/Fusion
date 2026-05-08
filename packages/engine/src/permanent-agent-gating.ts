import type {
  AgentPermissionPolicyDisposition,
  PermanentAgentActionCategory,
  PermanentAgentGatingContext,
  PermanentAgentSensitiveActionCategory,
} from "@fusion/core";

export interface PermanentAgentToolClassification {
  category: PermanentAgentActionCategory;
  /** True only when the tool is positively recognized and mapped by this module. */
  recognized: boolean;
}

export interface PermanentAgentToolDecision extends PermanentAgentToolClassification {
  toolName: string;
  disposition: AgentPermissionPolicyDisposition;
}

const READONLY_BUILTIN_TOOLS = new Set(["read", "grep", "find", "ls"]);
const FILE_WRITE_TOOLS = new Set(["write", "edit"]);

// FN-3724 / FN-3548: heartbeat-completion and internal coordination tools must remain
// category "none" so restrictive permanent-agent policies cannot deadlock heartbeats.
const TASK_AGENT_MUTATION_TOOLS = new Set([
  "fn_task_add_dep",
  "fn_task_pause",
  "fn_task_unpause",
  "fn_task_retry",
  "fn_task_duplicate",
  "fn_task_refine",
  "fn_task_archive",
  "fn_task_unarchive",
  "fn_task_delete",
  "fn_task_import_github",
  "fn_task_import_github_issue",
  "fn_task_plan",
  "fn_mission_create",
  "fn_mission_delete",
  "fn_milestone_add",
  "fn_slice_add",
  "fn_feature_add",
  "fn_slice_activate",
  "fn_feature_link_task",
  "fn_agent_stop",
  "fn_agent_start",
  "fn_update_agent_config",
  "fn_spawn_agent",
  "fn_task_add_dep",
]);

const FILE_WRITE_DELETE_TOOLS = new Set([
  "fn_task_attach",
]);

const NETWORK_API_TOOLS = new Set([
  "fn_research_run",
  "fn_research_cancel",
  "fn_research_retry",
]);

const READONLY_FN_TOOLS = new Set([
  "fn_task_list",
  "fn_task_show",
  "fn_task_create",
  "fn_task_document_write",
  "fn_task_document_read",
  "fn_delegate_task",
  "fn_research_list",
  "fn_research_get",
  "fn_insight_list",
  "fn_insight_show",
  "fn_insight_run_list",
  "fn_insight_run_show",
  "fn_mission_list",
  "fn_mission_show",
  "fn_list_agents",
  "fn_agent_show",
  "fn_agent_org_chart",
  "fn_skills_search",
  "fn_memory_search",
  "fn_memory_get",
  "fn_task_update",
  "fn_task_log",
  "fn_task_done",
  "fn_heartbeat_done",
  "fn_memory_append",
  "fn_send_message",
  "fn_read_messages",
  "fn_update_identity",
  "fn_reflect_on_performance",
  "fn_read_evaluations",
]);

const MUTATING_GIT_SUBCOMMANDS = new Set([
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

const READONLY_GIT_SUBCOMMANDS = new Set(["status", "diff", "log", "show", "rev-parse"]);

function normalizeArgs(args: unknown): Record<string, unknown> {
  return args && typeof args === "object" ? (args as Record<string, unknown>) : {};
}

function extractShellCommand(args: Record<string, unknown>): string {
  const command = args.command;
  return typeof command === "string" ? command.trim() : "";
}

function isGitWriteCommand(command: string): boolean {
  const match = command.match(/(?:^|&&|\|\||;|\n)\s*git\s+([^\s]+)/);
  if (!match) {
    return false;
  }
  const subcommand = match[1]?.trim() ?? "";
  if (!subcommand || READONLY_GIT_SUBCOMMANDS.has(subcommand)) {
    return false;
  }
  if (subcommand === "branch") {
    const tail = command.replace(/^[\s\S]*?\bgit\s+branch\b/, "").trim();
    const hasPositionalArg = tail.length > 0 && !tail.startsWith("-");
    return hasPositionalArg || /\s-d\b|\s-D\b|\s-m\b|\s-M\b|\s-c\b|\s-C\b/.test(command);
  }
  if (subcommand === "switch") {
    return /\s-c\b/.test(command);
  }
  if (subcommand === "checkout") {
    return /\s-b\b/.test(command);
  }
  if (subcommand === "pull") {
    return /--rebase\b/.test(command);
  }
  if (subcommand === "restore") {
    return /--staged\b/.test(command);
  }
  if (subcommand === "remote") {
    return /\s+add\b|\s+remove\b|\s+rename\b|\s+set-url\b/.test(command);
  }
  if (subcommand === "worktree") {
    return /\s+add\b|\s+remove\b/.test(command);
  }

  return MUTATING_GIT_SUBCOMMANDS.has(subcommand);
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
