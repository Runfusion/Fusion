/**
 * FNXC:CodeOrganization 2026-07-18-14:00:
 * Agent permissions, entity, ratings, and reflection types peeled from types.ts.
 * types.ts re-exports these for the Vite @fusion/core alias and package barrel.
 */

import type { AgentState } from "./agent-state.js";

export type AgentCapability = "triage" | "executor" | "reviewer" | "merger" | "scheduler" | "engineer" | "custom";


/** Single heartbeat event recorded for an agent */
export interface AgentHeartbeatEvent {
  /** ISO-8601 timestamp of when the heartbeat was recorded */
  timestamp: string;
  /** Status of the heartbeat */
  status: "ok" | "missed" | "recovered";
  /** ID of the heartbeat run this event belongs to */
  runId: string;
}

/** What triggered a heartbeat run */
export type HeartbeatInvocationSource = "on_demand" | "timer" | "assignment" | "automation" | "routine";

/** A continuous heartbeat session/run for an agent */
export interface AgentHeartbeatRun {
  /** Unique identifier for this run */
  id: string;
  /** ID of the agent this run belongs to */
  agentId: string;
  /** Task ID associated with this heartbeat run when bound to a task. */
  taskId?: string;
  /** ISO-8601 timestamp when the run started */
  startedAt: string;
  /** ISO-8601 timestamp when the run ended (null if active) */
  endedAt: string | null;
  /** Status of the run */
  status: "active" | "completed" | "terminated" | "failed";
  /** What triggered this run */
  invocationSource?: HeartbeatInvocationSource;
  /** Trigger detail (manual, ping, scheduler, system) */
  triggerDetail?: string;
  /** PID of the agent process */
  processPid?: number;
  /** Exit code of the agent process */
  exitCode?: number;
  /** Session ID before execution (for continuity tracking) */
  sessionIdBefore?: string;
  /** Session ID after execution */
  sessionIdAfter?: string;
  /** Token usage for this run */
  usageJson?: { inputTokens: number; outputTokens: number; cachedTokens: number; cacheWriteTokens: number };
  /** Structured result from the run */
  resultJson?: Record<string, unknown>;
  /** Snapshot of context at run start (taskId, projectId, etc.).
   *  May include optional comment-wake fields:
   *  - `triggeringCommentIds?: string[]`
   *  - `triggeringCommentType?: "steering" | "task" | "pr"` */
  contextSnapshot?: Record<string, unknown>;
  /** Excerpt of stdout output */
  stdoutExcerpt?: string;
  /** Excerpt of stderr output */
  stderrExcerpt?: string;
  /** Full assembled system prompt sent to the LLM for this run (truncated to 100,000 chars). */
  systemPrompt?: string;
  /** Full per-tick execution prompt sent to the LLM for this run (truncated to 100,000 chars). */
  executionPrompt?: string;
  /** Whether the run used a custom heartbeat procedure, the built-in default, or the no-task default override. */
  heartbeatProcedureSource?: "default" | "custom" | "default-no-task-override";
}


// ── Agent Permission Types ──────────────────────────────────────────────────

/** Canonical permission identifiers for agent access control.
 *  Each string represents a discrete capability that can be granted or denied. */
export const AGENT_PERMISSIONS = [
  "tasks:assign", // Assign tasks to agents
  "tasks:create", // Create new tasks
  "tasks:execute", // Execute/run tasks
  "tasks:review", // Review task output (code, specs)
  "tasks:merge", // Merge completed task branches
  "tasks:delete", // Delete tasks
  "tasks:archive", // Archive/unarchive tasks
  "agents:create", // Create new agents
  "agents:update", // Update agent configuration
  "agents:delete", // Delete agents
  "agents:view", // View agent details and logs
  "settings:read", // Read project settings
  "settings:update", // Modify project settings
  "workflows:manage", // Create/edit/delete workflow steps
  "missions:manage", // Create/edit/delete missions and slices
  "automations:manage", // Create/edit/delete scheduled automations
  "messages:send", // Send messages to agents/users
  "messages:read", // Read mailbox messages
] as const;

/** A single canonical permission string. */
export type AgentPermission = (typeof AGENT_PERMISSIONS)[number];

/**
 * Canonical v1 action categories for permanent-agent runtime gating.
 *
 * `none` is a classifier-only result for positively-recognized read-only actions.
 * It is never stored as a policy rule key.
 */
/**
 * FNXC:ToolPermissions 2026-07-09-00:00:
 * FN-7728 adds `review_gate_bypass` as a first-class sensitive action category distinct from `task_agent_mutation`. It governs merge-gate override tools (e.g. `fn_task_bypass_review`, delivered by FN-7720) so operators can independently allow/require-approval/block "who may bypass a failed review gate" without touching ordinary task-mutation policy. It defaults to a stricter disposition than the uniform preset default (see agent-permission-policy.ts) and is resolved identically by both evaluateAgentActionGate and the permanent-agent gate via the shared gating-classifications.ts source.
 *
 * FNXC:ToolPermissions 2026-07-09-08:30:
 * FN-7737 adds `file_scope` as a first-class sensitive action category governing the File Scope additional-approval action (`fn_task_file_scope_add`, an executor-visible tool that extends a task's declared `## File Scope` beyond its initial spec at runtime). Unlike `review_gate_bypass`, `file_scope` intentionally keeps the UNIFORM grant-all disposition — the `unrestricted` preset resolves it to `allow` via `buildRules("allow")` with no override patch, since File Scope self-extension is an ordinary executor-scope action, not a merge-gate override. It is resolved identically by both evaluateAgentActionGate and the permanent-agent gate via the shared `FILE_SCOPE_FN_TOOLS` set in gating-classifications.ts.
 */
export const PERMANENT_AGENT_ACTION_CATEGORIES = [
  "git_write",
  "file_write_delete",
  "command_execution",
  "network_api",
  "task_agent_mutation",
  "review_gate_bypass",
  "file_scope",
  "none",
] as const;

/** A single v1 permanent-agent action category. */
export type PermanentAgentActionCategory = (typeof PERMANENT_AGENT_ACTION_CATEGORIES)[number];

/** Sensitive runtime categories covered by policy rules (excludes classifier-only `none`). */
export type PermanentAgentSensitiveActionCategory = Exclude<PermanentAgentActionCategory, "none">;

/** Runtime action categories governed by agent permission policy presets. */
export const AGENT_PERMISSION_POLICY_ACTION_CATEGORIES: readonly PermanentAgentSensitiveActionCategory[] = [
  "git_write",
  "file_write_delete",
  "command_execution",
  "network_api",
  "task_agent_mutation",
  "review_gate_bypass",
  "file_scope",
] as const;

export const AGENT_PERMISSION_POLICY_CATEGORY_TOOL_EXAMPLES: Record<
  PermanentAgentSensitiveActionCategory,
  readonly string[]
> = {
  git_write: ["git commit", "git push", "git merge", "git branch -d", "git worktree add", "write", "edit"],
  file_write_delete: ["write", "edit", "fn_task_attach"],
  command_execution: ["bash (non-git)", "fn_run_verification", "fn_acquire_repo_worktree", "read", "find", "grep", "ls"],
  network_api: ["fn_research_run (web/research)", "fn_research_cancel", "fn_web_fetch", "worktrunk_install"],
  /* FNXC:ToolGovernance 2026-06-27-16:51: Dashboard policy examples must mirror action-gate mutation exports. Identity reflection is exempt heartbeat coordination, so it is intentionally not advertised as task_agent_mutation.
   * FNXC:WorkflowAuthoringTools 2026-06-29-23:40: Published workflow authoring tools are now agent-visible, so policy examples include the mutating workflow create/update/delete/settings/select surface operators can approve or block.
   * FNXC:ToolGovernance 2026-07-09-09:36: FN-7733 — the GitLab browse tools (fn_task_browse_gitlab_project_issues, fn_task_browse_gitlab_group_issues, fn_task_browse_gitlab_merge_requests) are read-only discovery tools that never create task rows and are already classified under READONLY_FN_TOOLS in gating-classifications.ts; they were never members of ACTION_GATE_TASK_AGENT_MANAGEMENT_TOOLS. Listing them here as task_agent_mutation examples broke the invariant that this list must be a subset of the action-gate mutation classification, so they are intentionally excluded. The mutating fn_task_import_gitlab_* variants (which do create task rows) remain listed below. */
  task_agent_mutation: [
    "fn_task_create",
    "fn_delegate_task",
    "fn_task_import_github",
    "fn_task_import_github_issue",
    "fn_task_import_gitlab_project_issues",
    "fn_task_import_gitlab_group_issues",
    "fn_task_import_gitlab_merge_requests",
    "fn_spawn_agent",
    "fn_update_agent_config",
    "fn_task_update",
    "fn_task_assign",
    "fn_workflow_create",
    "fn_workflow_update",
    "fn_workflow_delete",
    "fn_workflow_settings",
    "fn_workflow_select",
    "fn_task_promote",
    "fn_task_refine",
  ],
  /* FNXC:ToolPermissions 2026-07-09-00:00: FN-7728 — review_gate_bypass governs merge-gate override tools as a distinct, more-restricted permission from ordinary task mutation. fn_task_bypass_review (FN-7720) is CLI/pi-extension operator-tool-only; it is never exposed to executor/reviewer/triage agent tool lists. */
  review_gate_bypass: ["fn_task_bypass_review"],
  /* FNXC:ToolPermissions 2026-07-09-08:30: FN-7737 — file_scope governs the File Scope additional-approval action (fn_task_file_scope_add), which lets an executing agent extend its task's declared ## File Scope beyond the initial spec at runtime. Unlike review_gate_bypass, it keeps the uniform grant-all default (handled by "allow" under the unrestricted preset), so it is not patched by a *Override-style function. */
  file_scope: ["fn_task_file_scope_add"],
};

export const AGENT_PERMISSION_POLICY_EXEMPT_TOOL_EXAMPLES: readonly string[] = [
  "fn_send_message",
  "fn_post_room_message",
  "fn_read_messages",
  "fn_task_log",
  "fn_task_logs_read",
  "fn_task_done",
  "fn_heartbeat_done",
  "fn_task_document_write",
  "fn_task_document_read",
  "fn_workflow_list",
  "fn_workflow_get",
  "fn_trait_list",
  "fn_memory_search",
  "fn_memory_get",
  "fn_memory_append",
  "fn_read_evaluations",
  "fn_reflect_on_performance",
];

export const AGENT_PROVISIONING_APPROVAL_MODES = ["always", "trusted-only", "never"] as const;
export type AgentProvisioningApprovalMode = (typeof AGENT_PROVISIONING_APPROVAL_MODES)[number];

export const SECRET_ACCESS_POLICIES = ["auto", "prompt", "deny"] as const;
export type SecretAccessPolicy = (typeof SECRET_ACCESS_POLICIES)[number];

export const SANDBOX_PROVISIONING_APPROVAL_MODES = ["always", "trusted-only", "never"] as const;
export type SandboxProvisioningApprovalMode = (typeof SANDBOX_PROVISIONING_APPROVAL_MODES)[number];

/** A single runtime action category governed by permission policy. */
export type AgentPermissionPolicyActionCategory = PermanentAgentSensitiveActionCategory;
export type ApprovalRequestActionCategory =
  | AgentPermissionPolicyActionCategory
  | "agent_provisioning"
  | "sandbox_provisioning"
  | "secrets_access";

/** How a runtime action category is handled by permission policy. */
export type AgentPermissionPolicyDisposition = "allow" | "block" | "require-approval";

/** Exact tool-name permission overrides layered above category rules. */
export type AgentPermissionPolicyToolRules = Record<string, AgentPermissionPolicyDisposition>;

/** Minimum portable agent gating context consumed by engine runtime wrappers. The legacy name is retained for API compatibility, but the context applies to permanent identity agents and ephemeral task-worker agents. */
export interface PermanentAgentGatingContext {
  permissionPolicy?: {
    presetId: string;
    rules: Partial<Record<PermanentAgentSensitiveActionCategory, AgentPermissionPolicyDisposition>>;
    toolRules?: AgentPermissionPolicyToolRules;
  };
  requester?: ApprovalRequestActorSnapshot;
  taskId?: string;
  runId?: string;
  sessionId?: string;
  createApprovalRequest?: (input: {
    category: AgentPermissionPolicyActionCategory;
    toolName: string;
    args: Record<string, unknown>;
    /**
     * FNXC:AgentGating 2026-07-05-00:00:
     * FN-7609: the dedupe key must be persisted into the created request's
     * targetAction.context so a retrying heartbeat's findPendingApprovalRequest
     * lookup (which matches on context.approvalDedupeKey) can actually find and
     * reuse the pending request instead of minting a new blank one every tick.
     */
    approvalDedupeKey?: string;
  }) => Promise<ApprovalRequest | null>;
  findPendingApprovalRequest?: (dedupeKey: string) => Promise<ApprovalRequest | null>;
}

/** Built-in permission policy preset identifiers for agent runtime policies. */
export const AGENT_PERMISSION_POLICY_PRESET_IDS = ["unrestricted", "approval-required", "locked-down", "custom"] as const;

/** A single built-in permission policy preset identifier. */
export type AgentPermissionPolicyPresetId = (typeof AGENT_PERMISSION_POLICY_PRESET_IDS)[number];

/** Canonical category->disposition map for a permission policy. */
export type AgentPermissionPolicyRules = Record<
  AgentPermissionPolicyActionCategory,
  AgentPermissionPolicyDisposition
>;

/**
 * First-class persisted permission policy contract for permanent and ephemeral agents.
 *
 * FNXC:ToolPermissions 2026-07-01-00:00:
 * Operators must be able to block a single governed tool such as `fn_task_create` without blocking every task-agent mutation. `toolRules` stores exact tool-name overrides and the engine resolves them before category rules while leaving heartbeat-critical exempt tools non-configurable.
 */
export interface AgentPermissionPolicy {
  presetId: AgentPermissionPolicyPresetId;
  rules: AgentPermissionPolicyRules;
  toolRules?: AgentPermissionPolicyToolRules;
}

/** Approval request lifecycle statuses. */
export const APPROVAL_REQUEST_STATUSES = ["pending", "approved", "denied", "completed"] as const;

/** A single approval request lifecycle status. */
export type ApprovalRequestStatus = (typeof APPROVAL_REQUEST_STATUSES)[number];

/** Append-only audit event types for approval requests. */
export const APPROVAL_REQUEST_AUDIT_EVENT_TYPES = [
  "created",
  "approved",
  "denied",
  "completed",
] as const;

/** A single append-only audit event type for approval requests. */
export type ApprovalRequestAuditEventType = (typeof APPROVAL_REQUEST_AUDIT_EVENT_TYPES)[number];

/** Immutable actor identity snapshot captured at request/audit event time. */
export interface ApprovalRequestActorSnapshot {
  actorId: string;
  actorType: "agent" | "user" | "system";
  actorName: string;
}

/** Legacy action-category aliases accepted for backward compatibility. */
export const LEGACY_AGENT_PERMISSION_POLICY_ACTION_CATEGORY_ALIASES = [
  "file_write",
  "file_delete",
  "command_execute",
  "network_access",
  "task_mutation",
  "agent_mutation",
] as const;

export type LegacyAgentPermissionPolicyActionCategory =
  (typeof LEGACY_AGENT_PERMISSION_POLICY_ACTION_CATEGORY_ALIASES)[number];

/** Canonical + compatibility action-category input accepted at boundaries. */
export type ApprovalRequestActionCategoryInput =
  | ApprovalRequestActionCategory
  | LegacyAgentPermissionPolicyActionCategory;

/** Normalize legacy action-category aliases to canonical v1 categories. */
export function normalizeApprovalRequestActionCategory(
  category: ApprovalRequestActionCategoryInput,
): ApprovalRequestActionCategory {
  switch (category) {
    case "file_write":
    case "file_delete":
      return "file_write_delete";
    case "command_execute":
      return "command_execution";
    case "network_access":
      return "network_api";
    case "task_mutation":
    case "agent_mutation":
      return "task_agent_mutation";
    case "agent_provisioning":
      return "agent_provisioning";
    case "sandbox_provisioning":
      return "sandbox_provisioning";
    case "secrets_access":
      return "secrets_access";
    default:
      return category;
  }
}

/** Action payload gated by an approval request. */
export interface ApprovalRequestTargetAction {
  category: ApprovalRequestActionCategory;
  action: string;
  summary: string;
  resourceType: string;
  resourceId: string;
  context?: Record<string, unknown>;
}

/** Append-only audit event row for approval request history. */
export interface ApprovalRequestAuditEvent {
  id: string;
  requestId: string;
  eventType: ApprovalRequestAuditEventType;
  actor: ApprovalRequestActorSnapshot;
  note?: string;
  createdAt: string;
}

/** Durable approval request record used by engine and dashboard surfaces. */
export interface ApprovalRequest {
  id: string;
  status: ApprovalRequestStatus;
  requester: ApprovalRequestActorSnapshot;
  targetAction: ApprovalRequestTargetAction;
  taskId?: string;
  runId?: string;
  requestedAt: string;
  decidedAt?: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** Create input for a new pending approval request. */
export interface ApprovalRequestCreateInput {
  requester: ApprovalRequestActorSnapshot;
  targetAction: Omit<ApprovalRequestTargetAction, "category"> & {
    category: ApprovalRequestActionCategoryInput;
  };
  taskId?: string;
  runId?: string;
}

/** Input for pending->approved / pending->denied decisions. */
export interface ApprovalRequestDecisionInput {
  actor: ApprovalRequestActorSnapshot;
  note?: string;
}

/** Input for approved->completed transition. */
export interface ApprovalRequestCompletionInput {
  actor: ApprovalRequestActorSnapshot;
  note?: string;
}

/** Query filters for approval request listings. */
export interface ApprovalRequestListInput {
  status?: ApprovalRequestStatus;
  requesterActorId?: string;
  taskId?: string;
  runId?: string;
  limit?: number;
  offset?: number;
}

/** True when a transition is valid for approval request lifecycle rules. */
export function isValidApprovalRequestTransition(
  from: ApprovalRequestStatus,
  to: ApprovalRequestStatus,
): boolean {
  if (from === to) {
    return true;
  }
  if (from === "pending") {
    return to === "approved" || to === "denied";
  }
  if (from === "approved") {
    return to === "completed";
  }
  return false;
}

/** Describes how an agent's task assignment capability was determined. */
export type TaskAssignSource =
  | "role_default" // Granted automatically by role (e.g., scheduler gets tasks:assign)
  | "explicit_grant" // Explicitly granted via permissions field
  | "denied"; // Not granted by any source

/** Computed access state for an agent, derived from its role and permissions. */
export interface AgentAccessState {
  /** The agent ID this access state belongs to. */
  agentId: string;
  /** Whether this agent can assign tasks to other agents. */
  canAssignTasks: boolean;
  /** How the tasks:assign permission was determined. */
  taskAssignSource: TaskAssignSource;
  /** Whether this agent can create new agents. */
  canCreateAgents: boolean;
  /** Whether this agent can execute tasks. */
  canExecuteTasks: boolean;
  /** Whether this agent can review task output. */
  canReviewTasks: boolean;
  /** Whether this agent can merge task branches. */
  canMergeTasks: boolean;
  /** Whether this agent can delete agents. */
  canDeleteAgents: boolean;
  /** Whether this agent can manage missions. */
  canManageMissions: boolean;
  /** Whether this agent can send messages. */
  canSendMessages: boolean;
  /** Full set of resolved permissions (union of role defaults + explicit grants). */
  resolvedPermissions: Set<AgentPermission>;
  /** Permissions explicitly granted on this agent (from the permissions field). */
  explicitPermissions: Set<AgentPermission>;
  /** Permissions granted by role default (not explicitly set). */
  roleDefaultPermissions: Set<AgentPermission>;
}

/** Agent record stored in the system */
export interface Agent {
  /** Unique identifier (e.g., "agent-001") */
  id: string;
  /** Display name */
  name: string;
  /** Role/capability of the agent */
  role: AgentCapability;
  /** Current lifecycle state */
  state: AgentState;
  /** ID of the task this agent is currently working on (if any) */
  taskId?: string;
  /** ISO-8601 timestamp when the agent was created */
  createdAt: string;
  /** ISO-8601 timestamp of last update */
  updatedAt: string;
  /** ISO-8601 timestamp of last successful heartbeat */
  lastHeartbeatAt?: string;
  /** Optional metadata */
  metadata: Record<string, unknown>;
  /** Job title / description for the agent */
  title?: string;
  /** Custom icon identifier */
  icon?: string;
  /** Uploaded avatar image URL */
  imageUrl?: string;
  /** Agent ID this agent reports to (org hierarchy) */
  reportsTo?: string;
  /** Runtime configuration. Supports: AgentHeartbeatConfig keys (heartbeatIntervalMs, heartbeatTimeoutMs, maxConcurrentRuns) */
  runtimeConfig?: Record<string, unknown>;
  /** Why the agent was paused (error, manual, etc.) */
  pauseReason?: string;
  /** Capability permission flags */
  permissions?: Record<string, boolean>;
  /** Runtime action gating policy (preset + normalized category rules). */
  permissionPolicy?: AgentPermissionPolicy;
  /** Cumulative input tokens across all runs */
  totalInputTokens?: number;
  /** Cumulative output tokens across all runs */
  totalOutputTokens?: number;
  /** Last error message */
  lastError?: string;
  /** Number of currently pending approvals requested by this agent. */
  pendingApprovalCount?: number;
  /**
   * FNXC:AgentTaskStateDrift 2026-06-27-16:20:
   * Dashboard/API responses need a transient linked-task column so coordinators can distinguish legitimate parked/active agent linkages from execution drift; unresolved lookups use the response-only "unresolved" sentinel. This is resolved per request and must not be persisted by AgentStore.
   */
  taskColumn?: string;
  /** Path to a markdown file containing custom instructions (resolved relative to project root).
   *  Must end in `.md`, no `..` traversal. Max 500 chars. */
  instructionsPath?: string;
  /** Inline custom instructions appended to the agent's system prompt at execution time. Max 50,000 chars. */
  instructionsText?: string;
  /** Agent personality/identity description — defines the agent's character, tone, and behavioral traits. Max 10,000 chars. */
  soul?: string;
  /** Per-agent accumulated knowledge — stores learnings, preferences, and context the agent has gathered. Max 50,000 chars. */
  memory?: string;
  /** Structured instruction bundle configuration for managed/external markdown files. */
  bundleConfig?: InstructionsBundleConfig;
  /** Optional path to a markdown file containing this agent's per-tick heartbeat procedure
   *  (overrides the default HEARTBEAT_PROCEDURE constant). Resolved relative to project root.
   *  Must end in `.md`, no `..` traversal. Max 500 chars. */
  heartbeatProcedurePath?: string;
}

/** Recursive node in the agent org tree. */
export interface OrgTreeNode {
  agent: Agent;
  children: OrgTreeNode[];
}

export type MessageResponseMode = "immediate" | "on-heartbeat";

/** Per-agent heartbeat configuration, stored in agent.runtimeConfig */
export interface AgentHeartbeatConfig {
  /** Whether heartbeat triggers are enabled for this agent (default: true) */
  enabled?: boolean;
  /** Whether this agent should auto-claim relevant unowned tasks during no-task heartbeats (default: true when unset). */
  autoClaimRelevantTasks?: boolean;
  /**
   * FNXC:AgentRouting 2026-07-12-11:20:
   * Per-agent task-routing eligibility (GitHub issue Runfusion/Fusion#2015). "auto" (default) = current behavior;
   * "explicit-only" = never auto-assigned/auto-claimed but accepts explicit delegation; "none" = never bound to
   * implementation tasks by ANY path, including delegation with override=true. Set "none" on liaison/observer agents.
   */
  assignmentPolicy?: "auto" | "explicit-only" | "none";
  /** Number of auto-claim candidates to inject into no-task heartbeat prompts. Default: 5, range: 0-10. */
  autoClaimCandidatesInPrompt?: number;
  /** Per-agent override for opting engineer-role agents into no-task backlog auto-claim. Default: project setting or false. */
  engineerBacklogAutoClaim?: boolean;
  /** Polling interval in ms (default: 30000). Min: 1000 */
  heartbeatIntervalMs?: number;
  /** Heartbeat timeout in ms (default: 60000). Min: 5000 */
  heartbeatTimeoutMs?: number;
  /** Max concurrent heartbeat runs per agent (default: 1). Min: 1 */
  maxConcurrentRuns?: number;
  /** Whether periodic self-improvement is enabled (default: true) */
  selfImproveEnabled?: boolean;
  /** Interval between self-improvement cycles in ms (default: 14400000 = 4h). Min: 3600000 (1h) */
  selfImproveIntervalMs?: number;
  /** ISO timestamp of last self-improvement run */
  lastSelfImproveAt?: string;
  /**
   * How this agent responds to incoming messages.
   * "immediate" triggers a heartbeat run when a message arrives.
   * "on-heartbeat" defers message handling to the next scheduled heartbeat (default).
   */
  messageResponseMode?: MessageResponseMode;
  /** Per-agent budget governance configuration. When set, enables budget tracking and enforcement. */
  budgetConfig?: AgentBudgetConfig;
  /** Per-agent override for memory prompt inclusion mode. */
  agentMemoryInclusionMode?: "full" | "index" | "off";
  /** Per-agent override for heartbeat scope-discipline procedure mode. */
  heartbeatScopeDiscipline?: "strict" | "lite" | "off";
  /** Per-agent override for heartbeat execution prompt template mode. */
  heartbeatPromptTemplate?: "default" | "compact";
  /** Last resolved memory inclusion mode recorded by engine for transition logging. */
  lastAgentMemoryInclusionMode?: "full" | "index" | "off";
  /**
   * When true, the engine fires a catch-up heartbeat at server startup if the
   * agent's last heartbeat is older than its interval — i.e., the server was
   * down across a scheduled tick. Default: false.
   */
  runMissedHeartbeatOnStartup?: boolean;
  /**
   * When true (default), an agent's heartbeat runs and its task execution session can run
   * concurrently. When false, the two paths serialize: a heartbeat will not start while the
   * agent's bound task has an active executor session, and an executor session will not start
   * while the agent has an active heartbeat run.
   *
   * Permanent agents only — ignored for ephemeral agents. Default: true when unset.
   */
  allowParallelExecution?: boolean;
  /**
   * When true, timer-triggered heartbeats are skipped while the agent has no currently assigned
   * task (`agent.taskId` is unset). Assignment and on-demand triggers are unaffected.
   * Default: false (timer fires regardless of assignment).
   */
  skipHeartbeatWhenIdle?: boolean;
}

/** Per-agent budget configuration, stored in agent.runtimeConfig.budgetConfig */
export interface AgentBudgetConfig {
  /** Total token cap (input + output). When undefined, no budget limit is enforced. */
  tokenBudget?: number;
  /** Warning threshold as a fraction (0–1). Default: 0.8. Triggers isOverThreshold when usagePercent >= this value * 100. */
  usageThreshold?: number;
  /** Budget accumulation period. Default: "lifetime". */
  budgetPeriod?: "daily" | "weekly" | "monthly" | "lifetime";
  /** Day of month/week for period reset (1–31 for monthly, 0–6 for weekly where 0=Sunday). Only used when budgetPeriod is "monthly" or "weekly". */
  resetDay?: number;
}

/** Computed budget status for an agent at a point in time. */
export interface AgentBudgetStatus {
  /** The agent this status belongs to */
  agentId: string;
  /** Total tokens consumed (input + output) */
  currentUsage: number;
  /** Token cap from config, or null when no budget is configured */
  budgetLimit: number | null;
  /** Usage as a percentage of budget (0–100), or null when no budget */
  usagePercent: number | null;
  /** The configured threshold fraction (e.g., 0.8), or null when no budget */
  thresholdPercent: number | null;
  /** Whether currentUsage >= budgetLimit */
  isOverBudget: boolean;
  /** Whether usagePercent >= thresholdPercent * 100 */
  isOverThreshold: boolean;
  /** ISO-8601 timestamp of the last budget reset, or null */
  lastResetAt: string | null;
  /** ISO-8601 timestamp of the next scheduled reset, or null for lifetime/no budget */
  nextResetAt: string | null;
}

/** Configuration for an agent's instruction bundle — a collection of markdown files
 *  that together form the agent's custom instructions. */
export interface InstructionsBundleConfig {
  /** Bundle mode — "managed" = system-managed directory, "external" = user-specified path */
  mode: "managed" | "external";
  /** Primary instructions file name (default: "AGENTS.md") */
  entryFile: string;
  /** List of all file names in the bundle directory */
  files: string[];
  /** User-specified directory path for external mode (required when mode is "external") */
  externalPath?: string;
}

/** Extended agent information including heartbeat history */
export interface AgentDetail extends Agent {
  /** Recent heartbeat events (last N events) */
  heartbeatHistory: AgentHeartbeatEvent[];
  /** Current active heartbeat run (if any) */
  activeRun?: AgentHeartbeatRun;
  /** All completed runs for this agent */
  completedRuns: AgentHeartbeatRun[];
}

/** Input for creating a new agent */
export interface AgentCreateInput {
  name: string;
  role: AgentCapability;
  metadata?: Record<string, unknown>;
  title?: string;
  icon?: string;
  imageUrl?: string;
  reportsTo?: string;
  runtimeConfig?: Record<string, unknown>;
  permissions?: Record<string, boolean>;
  permissionPolicy?: AgentPermissionPolicy;
  instructionsPath?: string;
  instructionsText?: string;
  soul?: string;
  memory?: string;
  bundleConfig?: InstructionsBundleConfig;
  heartbeatProcedurePath?: string;
}

/** Input for updating an existing agent */
export interface AgentUpdateInput {
  name?: string;
  role?: AgentCapability;
  metadata?: Record<string, unknown>;
  title?: string;
  icon?: string;
  imageUrl?: string;
  reportsTo?: string;
  runtimeConfig?: Record<string, unknown>;
  pauseReason?: string;
  permissions?: Record<string, boolean>;
  permissionPolicy?: AgentPermissionPolicy;
  lastError?: string;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  instructionsPath?: string;
  instructionsText?: string;
  soul?: string;
  memory?: string;
  bundleConfig?: InstructionsBundleConfig;
  heartbeatProcedurePath?: string;
}

/** An API key associated with an agent for bearer token authentication. */
export interface AgentApiKey {
  /** Unique key identifier (e.g., "key-a1b2c3d4") */
  id: string;
  /** The agent this key belongs to */
  agentId: string;
  /** SHA-256 hash of the plaintext token (hex-encoded, 64 chars) */
  tokenHash: string;
  /** Optional human-readable label for the key */
  label?: string;
  /** ISO-8601 timestamp when the key was created */
  createdAt: string;
  /** ISO-8601 timestamp when the key was revoked, null if active */
  revokedAt?: string;
}

/** Result returned when creating a new API key — includes the plaintext token exactly once. */
export interface AgentApiKeyCreateResult {
  /** The persisted key metadata (不含 plaintext token) */
  key: AgentApiKey;
  /** The plaintext token — shown only at creation, never stored */
  token: string;
}

/** Per-task session persistence for an agent */
export interface AgentTaskSession {
  /** Agent ID */
  agentId: string;
  /** Task ID */
  taskId: string;
  /** Session state for resuming context across runs */
  sessionParams: Record<string, unknown>;
  /** Human-readable session identifier */
  sessionDisplayId?: string;
  /** ISO-8601 timestamp when session was created */
  createdAt: string;
  /** ISO-8601 timestamp of last update */
  updatedAt: string;
}

/** A single performance rating for an agent */
export interface AgentRating {
  id: string;
  agentId: string;
  raterType: "user" | "agent" | "system";
  raterId?: string;
  score: number;
  category?: string;
  comment?: string;
  runId?: string;
  taskId?: string;
  createdAt: string;
}

/** Aggregated rating statistics for an agent */
export interface AgentRatingSummary {
  agentId: string;
  averageScore: number;
  totalRatings: number;
  categoryAverages: Record<string, number>;
  recentRatings: AgentRating[];
  trend: "improving" | "declining" | "stable" | "insufficient-data";
}

/** Input payload for creating an agent rating */
export interface AgentRatingInput {
  raterType: "user" | "agent" | "system";
  raterId?: string;
  score: number;
  category?: string;
  comment?: string;
  runId?: string;
  taskId?: string;
}

/** Trackable configuration fields for revision history.
 *  Excludes budget-related items, state, taskId, token counts, and timestamps. */
export interface AgentConfigSnapshot {
  name: string;
  role: AgentCapability;
  title?: string;
  icon?: string;
  imageUrl?: string;
  reportsTo?: string;
  runtimeConfig?: Record<string, unknown>;
  permissions?: Record<string, boolean>;
  permissionPolicy?: AgentPermissionPolicy;
  instructionsPath?: string;
  instructionsText?: string;
  soul?: string;
  memory?: string;
  bundleConfig?: InstructionsBundleConfig;
  heartbeatProcedurePath?: string;
  metadata: Record<string, unknown>;
}

/** A single key-value change within a config revision */
export interface RevisionFieldDiff {
  field: string;
  oldValue: unknown;
  newValue: unknown;
}

/*
FNXC:ConfigVersioning 2026-07-18-00:00:
FN-8282 requires every durable configuration mutation to retain an immutable
before/after snapshot. Targets stay structured JSON; target keys are derived
from canonical JSON rather than delimiter-concatenated identifiers.

FNXC:ConfigVersioning 2026-07-18-10:30:
Every provenance variant carries a stable ID. This makes agent and authenticated
human writes auditable and makes intentional internal writes explicit as the
system actor instead of allowing anonymous history rows.
*/
export type ConfigKind = "project-settings" | "global-settings" | "workflow-settings" | "routine" | "automation";
export type ConfigChangedBy =
  | { kind: "human"; id: string }
  | { kind: "agent"; id: string }
  | { kind: "system"; id: string }
  | { kind: "rollback"; id: string };
export type ConfigurationOwnerScope = "project" | "global";
export type ConfigurationTarget = Readonly<Record<string, string>>;
export interface ConfigurationRevision {
  id: string;
  projectId: string;
  ownerScope: ConfigurationOwnerScope;
  configKind: ConfigKind;
  configTarget: ConfigurationTarget;
  /** Canonical JSON representation used only for exact target indexing. */
  configTargetKey: string;
  before: unknown;
  after: unknown;
  diffs: RevisionFieldDiff[];
  changedBy: ConfigChangedBy;
  createdAt: string;
  source: "mutation" | "rollback";
  rollbackToRevisionId?: string;
}

/** A revision entry recording a configuration change to an agent */
export interface AgentConfigRevision {
  /** Unique revision identifier */
  id: string;
  /** Agent ID this revision belongs to */
  agentId: string;
  /** ISO-8601 timestamp when the revision was created */
  createdAt: string;
  /** Snapshot of config BEFORE the change */
  before: AgentConfigSnapshot;
  /** Snapshot of config AFTER the change */
  after: AgentConfigSnapshot;
  /** Field-level diffs between before and after */
  diffs: RevisionFieldDiff[];
  /** Description of what changed (e.g., "Updated runtimeConfig, name") */
  summary: string;
  /** Who or what triggered the change */
  source: "user" | "system" | "rollback";
  /** If this was a rollback, the revision ID that was restored */
  rollbackToRevisionId?: string;
}

/**
 * Legacy project-relative shared path for the heartbeat procedure markdown
 * file. Older builds defaulted every non-ephemeral agent to this single
 * file, which prevented per-agent customization. New code should use
 * {@link getDefaultHeartbeatProcedurePath} instead. This constant is kept
 * exported only so migrations can detect agents still pointing at the
 * shared path and re-route them to their own per-agent file.
 *
 * @deprecated Use {@link getDefaultHeartbeatProcedurePath} for new agent
 *   creation and upgrade flows.
 */
export const DEFAULT_HEARTBEAT_PROCEDURE_PATH = ".fusion/HEARTBEAT.md";

function slugifyAgentAssetSegment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function getSafeAgentAssetIdSegment(agentId: string): string {
  const slug = slugifyAgentAssetSegment(agentId);
  return slug || "agent";
}

/**
 * Compute the canonical per-agent asset directory segment.
 *
 * Canonical format: `<slugged-display-name>-<safe-agent-id>`.
 * Example: `CEO` + `agent2736` => `ceo-agent2736`.
 *
 * If the display-name slug is empty (for example name has only symbols), the
 * id-derived segment is used as the directory prefix so the result is always
 * filesystem-safe and non-empty.
 */
export function getCanonicalAgentAssetDirectoryName(agentName: string, agentId: string): string {
  if (!agentId || typeof agentId !== "string") {
    throw new Error("getCanonicalAgentAssetDirectoryName requires a non-empty agentId");
  }
  const safeId = getSafeAgentAssetIdSegment(agentId);
  const nameSlug = slugifyAgentAssetSegment(agentName ?? "");
  const prefix = nameSlug || safeId;
  return `${prefix}-${safeId}`;
}

/** Legacy per-agent asset directory segment used by older builds. */
export function getLegacyAgentAssetDirectoryName(agentId: string): string {
  if (!agentId || typeof agentId !== "string") {
    throw new Error("getLegacyAgentAssetDirectoryName requires a non-empty agentId");
  }
  return agentId;
}

/** Canonical managed instruction bundle directory name for an agent. */
export function getCanonicalAgentInstructionsBundleDirName(agentName: string, agentId: string): string {
  return `${getCanonicalAgentAssetDirectoryName(agentName, agentId)}-instructions`;
}

/** Legacy managed instruction bundle directory name used by older builds. */
export function getLegacyAgentInstructionsBundleDirName(agentId: string): string {
  return `${getLegacyAgentAssetDirectoryName(agentId)}-instructions`;
}

/**
 * Compute the project-relative default heartbeat procedure file path for a
 * given agent. Each agent gets their own editable HEARTBEAT.md so operators
 * can tune the per-tick procedure without changes leaking across the team.
 *
 * The path is laid out under `.fusion/agents/<canonical-agent-dir>/HEARTBEAT.md`.
 */
export function getDefaultHeartbeatProcedurePath(agentId: string, agentName?: string): string {
  if (!agentId || typeof agentId !== "string") {
    throw new Error("getDefaultHeartbeatProcedurePath requires a non-empty agentId");
  }
  const directory = agentName
    ? getCanonicalAgentAssetDirectoryName(agentName, agentId)
    : getLegacyAgentAssetDirectoryName(agentId);
  return `.fusion/agents/${directory}/HEARTBEAT.md`;
}

/** Extract trackable config fields from an Agent into a snapshot */
export function agentToConfigSnapshot(agent: Agent): AgentConfigSnapshot {
  return {
    name: agent.name,
    role: agent.role,
    title: agent.title,
    icon: agent.icon,
    imageUrl: agent.imageUrl,
    reportsTo: agent.reportsTo,
    runtimeConfig: agent.runtimeConfig ? { ...agent.runtimeConfig } : undefined,
    permissions: agent.permissions ? { ...agent.permissions } : undefined,
    permissionPolicy: agent.permissionPolicy
      ? {
          presetId: agent.permissionPolicy.presetId,
          rules: { ...agent.permissionPolicy.rules },
          ...(agent.permissionPolicy.toolRules ? { toolRules: { ...agent.permissionPolicy.toolRules } } : {}),
        }
      : undefined,
    instructionsPath: agent.instructionsPath,
    instructionsText: agent.instructionsText,
    soul: agent.soul,
    memory: agent.memory,
    bundleConfig: agent.bundleConfig
      ? {
          ...agent.bundleConfig,
          files: [...agent.bundleConfig.files],
        }
      : undefined,
    heartbeatProcedurePath: agent.heartbeatProcedurePath,
    metadata: { ...agent.metadata },
  };
}

/** Compare two config snapshots and return field-level diffs */
export function diffConfigSnapshots(
  before: AgentConfigSnapshot,
  after: AgentConfigSnapshot,
): RevisionFieldDiff[] {
  const trackedFields: Array<keyof AgentConfigSnapshot> = [
    "name",
    "role",
    "title",
    "icon",
    "imageUrl",
    "reportsTo",
    "runtimeConfig",
    "permissions",
    "permissionPolicy",
    "instructionsPath",
    "instructionsText",
    "soul",
    "memory",
    "bundleConfig",
    "heartbeatProcedurePath",
    "metadata",
  ];

  const diffs: RevisionFieldDiff[] = [];

  for (const field of trackedFields) {
    const oldVal = before[field];
    const newVal = after[field];

    if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
      diffs.push({ field, oldValue: oldVal, newValue: newVal });
    }
  }

  return diffs;
}

/** Aggregate statistics for agents */
export interface AgentStats {
  /** Number of agents in active/running state */
  activeCount: number;
  /** Number of tasks assigned to agents */
  assignedTaskCount: number;
  /** Total completed runs */
  completedRuns: number;
  /** Total failed runs */
  failedRuns: number;
  /** Success rate (0-1) */
  successRate: number;
  /** Number of idle non-ephemeral agents available for queue drain */
  idleNonEphemeralCount: number;
  /** Number of tasks currently in the todo column */
  todoTaskCount: number;
}

/** Trigger source for an agent self-reflection run */
export type ReflectionTrigger = "periodic" | "post-task" | "manual" | "user-requested";

/**
 * FNXC:AgentReflection 2026-07-04-00:00:
 * FN-7528 adds a deterministic, non-LLM post-task performance capture that runs on every
 * completed task (guarded by settings.reflectionEnabled), distinct from the LLM-backed
 * generateReflection path. These extra fields are a compact structured snapshot — duration
 * drivers, packages/files touched, verification command(s)/scope, and retry/rework count.
 * All fields are optional (backward-compatible with existing JSONL records) and outcome-only:
 * no free-form prose, prompt text, or reflection narrative is ever stored here or emitted to
 * run-audit (FN-7158 ids/counts/outcomes-only contract). Omit a field rather than fabricate it
 * when its source data is unavailable.
 */
export interface ReflectionMetrics {
  /** Tasks completed in the analysis window */
  tasksCompleted?: number;
  /** Tasks failed in the analysis window */
  tasksFailed?: number;
  /** Average task duration in milliseconds */
  avgDurationMs?: number;
  /** Total tokens consumed in the analysis window */
  totalTokensUsed?: number;
  /** Number of errors encountered */
  errorCount?: number;
  /** Recurring error patterns */
  commonErrors?: string[];
  /** Single task's wall-clock duration in milliseconds (distinct from the aggregate avgDurationMs) */
  durationMs?: number;
  /** Short deterministic labels describing what drove the duration (e.g. "retries:2", "rework:1", "verification-broad") — never free-form prose */
  durationDrivers?: string[];
  /** Package names derived from touched file paths (e.g. "@fusion/core" or "packages/core") */
  packagesTouched?: string[];
  /** Count of files touched, when available */
  filesTouchedCount?: number;
  /** Verification command(s) recorded for the task */
  verificationCommands?: string[];
  /** reworkCount + retry/recovery count */
  retryReworkCount?: number;
  /** True when verification was file-scoped, false when broader/full-suite */
  verificationFileScoped?: boolean;
  /** Short reason label when verification scope was broader (e.g. "whole-package test script has no file-scoped filter"); omitted when file-scoped */
  verificationScopeReason?: string;
}

/** A persisted self-reflection generated by an agent */
export interface AgentReflection {
  /** Unique reflection ID */
  id: string;
  /** The agent this reflection belongs to */
  agentId: string;
  /** ISO-8601 timestamp when the reflection was created */
  timestamp: string;
  /** What caused this reflection */
  trigger: ReflectionTrigger;
  /** Optional trigger detail context */
  triggerDetail?: string;
  /** Associated task ID (for post-task reflections) */
  taskId?: string;
  /** Quantitative reflection metrics */
  metrics: ReflectionMetrics;
  /** Key observations from self-analysis */
  insights: string[];
  /** Suggested improvements for future runs */
  suggestedImprovements: string[];
  /** One-paragraph narrative summary */
  summary: string;
}

/** Aggregated performance summary derived from recent reflections */
export interface AgentPerformanceSummary {
  /** Agent identifier */
  agentId: string;
  /** Total tasks completed in the analysis window */
  totalTasksCompleted: number;
  /** Total tasks failed in the analysis window */
  totalTasksFailed: number;
  /** Average task duration in milliseconds */
  avgDurationMs: number;
  /** Success ratio from 0 to 1 */
  successRate: number;
  /** Top recurring errors */
  commonErrors: string[];
  /** Derived strengths from successful patterns */
  strengths: string[];
  /** Derived weaknesses from failure patterns */
  weaknesses: string[];
  /** Number of reflections considered in this summary */
  recentReflectionCount: number;
  /** ISO-8601 timestamp when summary was computed */
  computedAt: string;
}

