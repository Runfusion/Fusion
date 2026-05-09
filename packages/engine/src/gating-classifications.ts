// FN-3548 / FN-3724 / FN-3751: keep agent-action-gate and permanent-agent-gating
// classifications sourced from one module to prevent two-path drift (see MEMORY.md drift note).

export const READONLY_BUILTIN_TOOLS: ReadonlySet<string> = new Set(["read", "find", "grep", "ls"]);
export const FILE_WRITE_BUILTIN_TOOLS: ReadonlySet<string> = new Set(["write", "edit"]);

const SHARED_TASK_AGENT_TOOLS = ["fn_task_add_dep", "fn_spawn_agent", "fn_update_agent_config", "fn_agent_create", "fn_agent_delete"] as const;

const ACTION_GATE_TASK_AGENT_ONLY_TOOLS = ["fn_task_create", "fn_delegate_task", "fn_update_identity"] as const;
const PERMANENT_TASK_AGENT_ONLY_TOOLS = [
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
] as const;

export const TASK_AGENT_MUTATION_TOOLS: ReadonlySet<string> = new Set([
  ...SHARED_TASK_AGENT_TOOLS,
  ...ACTION_GATE_TASK_AGENT_ONLY_TOOLS,
  ...PERMANENT_TASK_AGENT_ONLY_TOOLS,
]);

export const ACTION_GATE_TASK_AGENT_MANAGEMENT_TOOLS: ReadonlySet<string> = new Set([
  ...SHARED_TASK_AGENT_TOOLS,
  ...ACTION_GATE_TASK_AGENT_ONLY_TOOLS,
]);

export const PERMANENT_AGENT_TASK_MUTATION_TOOLS: ReadonlySet<string> = new Set([
  ...SHARED_TASK_AGENT_TOOLS,
  ...PERMANENT_TASK_AGENT_ONLY_TOOLS,
]);

export const FILE_WRITE_DELETE_FN_TOOLS: ReadonlySet<string> = new Set(["fn_task_attach"]);

export const NETWORK_API_TOOLS: ReadonlySet<string> = new Set([
  "fn_research_run",
  "fn_research_cancel",
  "fn_research_retry",
]);

export const ACTION_GATE_NETWORK_API_TOOLS: ReadonlySet<string> = new Set(["fn_research_run"]);

export const READONLY_FN_TOOLS: ReadonlySet<string> = new Set([
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

export const COORDINATION_EXEMPT_TOOLS = [
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

export const MUTATING_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set([
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

export const READONLY_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set(["status", "diff", "log", "show", "rev-parse"]);

export function classifyGitCommand(command: string): { write: boolean; operation: string } | null {
  const match = command.match(/(?:^|&&|\|\||;|\||\n)\s*git\s+([^\s]+)/);
  if (!match) return null;
  const sub = match[1]?.trim() ?? "";
  if (!sub) return { write: false, operation: "git" };

  if (READONLY_GIT_SUBCOMMANDS.has(sub)) {
    if (sub === "rev-parse" && /--show-current\b/.test(command)) {
      return { write: false, operation: "git rev-parse --show-current" };
    }
    return { write: false, operation: `git ${sub}` };
  }

  if (sub === "branch") {
    const mutatingFlags = /\s-d\b|\s-D\b|\s-m\b|\s-M\b|\s-c\b|\s-C\b/.test(command);
    if (mutatingFlags) return { write: true, operation: "git branch" };
    const tail = command.replace(/^[\s\S]*?\bgit\s+branch\b/, "").trim();
    const hasPositionalArg = tail.length > 0 && !tail.startsWith("-");
    if (hasPositionalArg) return { write: true, operation: "git branch" };
    return { write: false, operation: /--show-current\b/.test(command) ? "git branch --show-current" : "git branch" };
  }

  if (sub === "switch") {
    const write = /\s-c\b/.test(command);
    return { write, operation: write ? "git switch -c" : "git switch" };
  }

  if (sub === "checkout") {
    const write = /\s-b\b/.test(command);
    return { write, operation: write ? "git checkout -b" : "git checkout" };
  }

  if (sub === "pull") {
    const write = /--rebase\b/.test(command);
    return { write, operation: write ? "git pull --rebase" : "git pull" };
  }

  if (sub === "restore") {
    const write = /--staged\b/.test(command);
    return { write, operation: write ? "git restore --staged" : "git restore" };
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

  return { write: MUTATING_GIT_SUBCOMMANDS.has(sub), operation: `git ${sub}` };
}

export function isGitWriteCommand(command: string): boolean {
  return classifyGitCommand(command)?.write ?? false;
}
