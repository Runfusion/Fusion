// FN-3548 / FN-3724 / FN-3751: keep agent-action-gate and permanent-agent-gating
// classifications sourced from one module to prevent two-path drift (see MEMORY.md drift note).

export const READONLY_BUILTIN_TOOLS: ReadonlySet<string> = new Set(["read", "find", "grep", "ls"]);
export const FILE_WRITE_BUILTIN_TOOLS: ReadonlySet<string> = new Set(["write", "edit"]);

/**
 * FNXC:ToolGovernance 2026-06-27-12:05:
 * Workflow edits, task status/custom-field updates, held-task promotion, and refinement creation are mutating heartbeat tools. Keep them in the shared task-agent bucket so action-gate and permanent-agent policy decisions cannot drift or fall through to silent exemption.
 */
const SHARED_TASK_AGENT_TOOLS = [
  "fn_task_add_dep",
  "fn_task_update",
  "fn_spawn_agent",
  "fn_update_agent_config",
  "fn_agent_create",
  "fn_agent_delete",
  "fn_workflow_select",
  "fn_workflow_create",
  "fn_workflow_update",
  "fn_workflow_delete",
  "fn_workflow_settings",
  "fn_task_promote",
  "fn_task_refine",
] as const;
const PROVISIONING_TOOLS = ["fn_agent_create", "fn_agent_delete"] as const;

/**
 * FNXC:ToolGovernance 2026-06-27-12:00:
 * Newly exposed mutating heartbeat tools must be positively classified before agents receive them, otherwise the action gate's unrecognized-tool fallback silently allows them. Verification and workspace acquisition execute subprocess/git-worktree work, so both gating paths use command_execution instead of a coordination exemption.
 */
export const COMMAND_EXECUTION_FN_TOOLS: ReadonlySet<string> = new Set([
  "fn_run_verification",
  "fn_acquire_repo_worktree",
]);

/**
 * FNXC:ToolGovernance 2026-06-27-11:24:
 * FN-7126 classifies task creation/delegation/import as task_agent_mutation in the action gate because they mutate the board and must honor operator approval/block policy. In the permanent-agent gate, delegate/import tools remain recognized `none` coordination primitives while fn_task_create is governed separately as a board mutation.
 *
 * FNXC:ToolGovernance 2026-06-27-12:31:
 * FN-7132 requires every live board-creation tool to avoid read-only classification in all gate paths. Classify fn_task_create as task_agent_mutation for both action and permanent agents so locked-down policies can block task-row creation; keep delegate and GitHub import tools in the action-only bucket until their permanent-agent coordination semantics are intentionally revisited.
 *
 * FNXC:ToolGovernance 2026-06-27-16:51:
 * Identity reflection stays out of this action-gate mutation-only list because it is heartbeat-critical coordination, not a task-board mutation. Keep it in COORDINATION_EXEMPT_TOOLS and READONLY_FN_TOOLS so exported mutation sets do not contradict action-gate exemption semantics.
 */
const PERMANENT_AND_ACTION_TASK_AGENT_TOOLS = ["fn_task_create"] as const;
const ACTION_GATE_TASK_AGENT_ONLY_TOOLS = [
  ...PERMANENT_AND_ACTION_TASK_AGENT_TOOLS,
  "fn_delegate_task",
  "fn_task_import_github",
  "fn_task_import_github_issue",
  "fn_task_import_gitlab_project_issues",
  "fn_task_import_gitlab_group_issues",
  "fn_task_import_gitlab_merge_requests",
] as const;
const ACTION_GATE_SHARED_TASK_AGENT_TOOLS = SHARED_TASK_AGENT_TOOLS.filter(
  (tool) => !(PROVISIONING_TOOLS as readonly string[]).includes(tool),
);
const PERMANENT_TASK_AGENT_ONLY_TOOLS = [
  "fn_task_pause",
  "fn_task_unpause",
  "fn_task_retry",
  "fn_task_duplicate",
  "fn_task_archive",
  "fn_task_unarchive",
  "fn_task_delete",
  "fn_task_plan",
  "fn_mission_create",
  "fn_mission_delete",
  "fn_mission_update",
  "fn_mission_backfill_assertions",
  "fn_milestone_add",
  "fn_slice_add",
  "fn_feature_add",
  "fn_feature_delete",
  "fn_slice_delete",
  "fn_milestone_delete",
  "fn_slice_activate",
  "fn_feature_link_task",
  "fn_feature_update",
  "fn_milestone_update",
  "fn_agent_stop",
  "fn_agent_start",
] as const;

export const TASK_AGENT_MUTATION_TOOLS: ReadonlySet<string> = new Set([
  ...SHARED_TASK_AGENT_TOOLS,
  ...ACTION_GATE_TASK_AGENT_ONLY_TOOLS,
  ...PERMANENT_TASK_AGENT_ONLY_TOOLS,
]);

// FN-3953: provisioning tools are gated by dedicated agent_provisioning policy;
// keep them out of action-gate task_agent_mutation to avoid double approval rows.
export const ACTION_GATE_TASK_AGENT_MANAGEMENT_TOOLS: ReadonlySet<string> = new Set([
  ...ACTION_GATE_SHARED_TASK_AGENT_TOOLS,
  ...ACTION_GATE_TASK_AGENT_ONLY_TOOLS,
]);

export const PERMANENT_AGENT_TASK_MUTATION_TOOLS: ReadonlySet<string> = new Set([
  ...SHARED_TASK_AGENT_TOOLS,
  ...PERMANENT_AND_ACTION_TASK_AGENT_TOOLS,
  ...PERMANENT_TASK_AGENT_ONLY_TOOLS,
]);

/**
 * FNXC:ToolGovernance 2026-07-09-00:00:
 * FN-7728 gives `fn_task_bypass_review` (FN-7720's merge-gate override, CLI/pi-extension operator-tool-only — never on executor/reviewer/triage agent tool lists) its own `review_gate_bypass` classification, distinct from `task_agent_mutation`, so operators can govern "who may bypass a failed review gate" independently of ordinary task mutations and it can never fall through to the unrecognized-tool exempt fallback. Both evaluateAgentActionGate (agent-action-gate.ts) and the permanent-agent gate (permanent-agent-gating.ts) must consume this same set so the two gate paths cannot drift.
 */
export const REVIEW_GATE_BYPASS_FN_TOOLS: ReadonlySet<string> = new Set(["fn_task_bypass_review"]);

/**
 * FNXC:ToolGovernance 2026-07-09-08:30:
 * FN-7737 gives `fn_task_file_scope_add` (the File Scope additional-approval action — lets an executing agent extend its task's declared `## File Scope` beyond the initial spec at runtime) its own `file_scope` classification, distinct from `task_agent_mutation`/`file_write_delete`, so operators can independently allow/require-approval/block it. Preflight confirmed the tool was previously unclassified in both gate paths and fell through to the exempt/allow fallback; it is now positively recognized here so it can never silently bypass policy. Both evaluateAgentActionGate (agent-action-gate.ts) and the permanent-agent gate (permanent-agent-gating.ts) must consume this same set so the two gate paths cannot drift.
 */
export const FILE_SCOPE_FN_TOOLS: ReadonlySet<string> = new Set(["fn_task_file_scope_add"]);

export const FILE_WRITE_DELETE_FN_TOOLS: ReadonlySet<string> = new Set(["fn_task_attach"]);

export const NETWORK_API_TOOLS: ReadonlySet<string> = new Set([
  "fn_research_run",
  "fn_research_cancel",
  "fn_research_retry",
  "fn_web_fetch", // FN-4603: outbound HTTP fetch should be network-classified.
  "worktrunk_install", // FN-4624: binary auto-install downloads from GitHub.
]);

export const ACTION_GATE_NETWORK_API_TOOLS: ReadonlySet<string> = new Set([
  "fn_research_run",
  "fn_research_cancel",
  "fn_web_fetch", // FN-4603: honor network_api approval policy for web fetches.
  "worktrunk_install", // FN-4624: gate binary auto-install under network_api policy.
]);

export const READONLY_FN_TOOLS: ReadonlySet<string> = new Set([
  "fn_artifact_register",
  "fn_artifact_list",
  "fn_artifact_view",
  "fn_task_list",
  "fn_task_show",
  // FNXC:ToolGovernance 2026-06-27-14:16: Task search is a read-only duplicate-discovery tool; classify it positively so heartbeat/triage calls never rely on the unknown-tool exempt fallback.
  "fn_task_search",
  // FNXC:ToolGovernance 2026-06-27-00:00: `fn_task_get` is a deprecated recognition-only alias. It is no longer registered as a live tool, but historical/in-flight calls must still classify as read-only instead of falling through to unknown-tool handling.
  "fn_task_get",
  "fn_task_document_write",
  "fn_task_document_read",
  "fn_delegate_task",
  "fn_task_import_github",
  "fn_task_import_github_issue",
  "fn_task_import_gitlab_project_issues",
  "fn_task_import_gitlab_group_issues",
  "fn_task_import_gitlab_merge_requests",
  "fn_task_browse_gitlab_project_issues",
  "fn_task_browse_gitlab_group_issues",
  "fn_task_browse_gitlab_merge_requests",
  "fn_research_list",
  "fn_research_get",
  "fn_insight_list",
  "fn_insight_show",
  "fn_insight_run_list",
  "fn_insight_run_show",
  "fn_goal_list",
  "fn_goal_show",
  // FNXC:ToolGovernance 2026-06-29-23:36: Workflow and trait discovery tools are read-only authoring support. Positively classify list/get/trait vocabulary so newly exposed published and prompt-injectable lanes never rely on unknown-tool fallback.
  "fn_workflow_list",
  "fn_workflow_get",
  "fn_trait_list",
  "fn_mission_list",
  "fn_mission_show",
  "fn_list_agents",
  "fn_agent_show",
  "fn_agent_org_chart",
  "fn_skills_search",
  "fn_memory_search",
  "fn_memory_get",
  "fn_task_log",
  "fn_task_done",
  "fn_heartbeat_done",
  "fn_memory_append",
  /**
   * FNXC:ToolGovernance 2026-06-28-00:00:
   * FN-7191 requires permanent agents to call fn_ask_question directly without an approval gate. The tool only posts a structured question to the user's inbox, so it has the same trust level as fn_send_message and must be positively recognized in both gate paths.
   */
  "fn_ask_question",
  "fn_send_message",
  "fn_read_messages",
  "fn_post_room_message",
  "fn_update_identity",
  "fn_reflect_on_performance",
  "fn_read_evaluations",
]);

export const COORDINATION_EXEMPT_TOOLS = [
  "read",
  "find",
  "grep",
  "ls",
  "fn_task_log",
  "fn_task_done",
  /* FNXC:ArtifactRegistry 2026-06-21-00:00: Artifact registration mutates persisted registry state, but it is a low-risk coordination action classified like fn_task_document_write so permanent agents can publish discoverable deliverables without broad mutation approval. */
  "fn_artifact_register",
  "fn_artifact_list",
  "fn_artifact_view",
  "fn_task_document_write",
  "fn_task_document_read",
  /**
   * FNXC:ToolGovernance 2026-06-27-15:22:
   * Task list/show/search tools are read-only discovery tools. Put them on the action-gate exempt registry, not only READONLY_FN_TOOLS, because evaluateAgentActionGate recognizes coordination exemptions directly and otherwise unknown fn_task_* reads silently fall through to exempt allow.
   *
   * FNXC:ToolGovernance 2026-06-27-00:00:
   * `fn_task_get` is no longer registered as a live tool, but it remains here as a deprecated recognition-only alias so stray in-flight legacy calls classify as known read-only coordination instead of relying on the unknown-tool fallback.
   */
  "fn_task_list",
  "fn_task_show",
  "fn_task_search",
  "fn_task_get",
  "fn_memory_search",
  "fn_memory_get",
  "fn_read_messages",
  "fn_heartbeat_done",
  "fn_goal_list",
  "fn_goal_show",
  "fn_list_agents",
  "fn_agent_show",
  "fn_agent_org_chart",
  "fn_workflow_list",
  "fn_workflow_get",
  "fn_trait_list",
  /**
   * FNXC:ToolGovernance 2026-06-28-00:00:
   * FN-7191 requires fn_ask_question to bypass permanent-agent approval gates like other user-messaging coordination tools; membership here makes the action gate classify it as exempt/allow even under locked-down policies.
   */
  "fn_ask_question",
  "fn_send_message",
  "fn_post_room_message",
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
