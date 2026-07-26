import { createHash } from "node:crypto";
import { isApprovalRequestExpired } from "@fusion/core";
import type {
  AgentPermissionPolicy,
  AgentPermissionPolicyActionCategory,
  AgentPermissionPolicyDisposition,
  ApprovalRequestStatus,
} from "@fusion/core";
import {
  ACTION_GATE_NETWORK_API_TOOLS,
  ACTION_GATE_PROVISIONING_POLICY_TOOLS,
  ACTION_GATE_TASK_AGENT_MANAGEMENT_TOOLS,
  COMMAND_EXECUTION_FN_TOOLS,
  COORDINATION_EXEMPT_TOOLS,
  FILE_SCOPE_FN_TOOLS,
  FILE_WRITE_DELETE_FN_TOOLS,
  READONLY_BUILTIN_TOOLS,
  READONLY_FN_TOOLS,
  REVIEW_GATE_BYPASS_FN_TOOLS,
  classifyGitCommand,
} from "./gating-classifications.js";
import { runtimeLog } from "./logger.js";

/*
FNXC:AgentGating 2026-07-12-18:35:
MAIN-008 review: project MCP tools must not share the "research" resource type used by built-in network research tools. Operators and approval-dedupe keys need a distinct label for external MCP side effects; "mcp" is that resource type.
*/
export type AgentActionGateResourceType = "file" | "git" | "task" | "agent" | "research" | "command" | "mcp" | "other";

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
  /**
   * FNXC:ApprovalRedemption 2026-07-26-13:05:
   * `decidedAt` lets resolveGateOutcome apply the approval-grant TTL at
   * redemption time (approved-but-unredeemed grants were redeemable forever —
   * live DB showed 17 approved / 0 completed). Optional for backward
   * compatibility: a closure that omits it skips TTL evaluation.
   */
  findApprovalByDedupeKey?: (dedupeKey: string) => Promise<{ id: string; status: ApprovalRequestStatus; decidedAt?: string } | null>;
  /** @deprecated Use findApprovalByDedupeKey */
  findPendingApprovalByDedupeKey?: (dedupeKey: string) => Promise<{ id: string } | null>;
  pauseForApproval?: (info: { approvalRequestId: string; decision: AgentActionGateDecision }) => Promise<void>;
  markApprovalCompleted?: (approvalRequestId: string) => Promise<void>;
}

// FN-3724: Internal Fusion runtime/coordinator tools never perform external mutations.
// They must bypass user-configurable approval/block policies so permanent-agent heartbeats cannot deadlock.
const DEFAULT_EXEMPT_TOOLS = COORDINATION_EXEMPT_TOOLS;

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

const TASK_AGENT_MANAGEMENT_TOOLS = ACTION_GATE_TASK_AGENT_MANAGEMENT_TOOLS;
const NETWORK_API_TOOLS = ACTION_GATE_NETWORK_API_TOOLS;
const COMMAND_EXECUTION_TOOLS = COMMAND_EXECUTION_FN_TOOLS;
const READONLY_DISCOVERY_TOOLS = READONLY_BUILTIN_TOOLS;
const REVIEW_GATE_BYPASS_TOOLS = REVIEW_GATE_BYPASS_FN_TOOLS;
const FILE_SCOPE_TOOLS = FILE_SCOPE_FN_TOOLS;

function normalizeArgs(args: unknown): Record<string, unknown> {
  return args && typeof args === "object" ? (args as Record<string, unknown>) : {};
}

function extractShellCommand(args: Record<string, unknown>): string {
  const command = args.command;
  return typeof command === "string" ? command.trim() : "";
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
    /*
    FNXC:ApprovalRedemption 2026-07-26-13:05:
    Bind bash approvals to the EXACT command. Previously the dedupe key for
    non-git bash collapsed to operation "shell command", so one approved
    request authorized arbitrary future shell commands for that agent+task.
    Hashing the full command string into resourceId makes each distinct
    command a distinct approval, and redemption (execute-once-then-complete)
    can only consume an approval minted for that same command.
    */
    resourceId = command ? `cmd:${createHash("sha256").update(command).digest("hex").slice(0, 16)}` : undefined;
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
  } else if (REVIEW_GATE_BYPASS_TOOLS.has(params.toolName)) {
    // FNXC:ToolGovernance 2026-07-09-00:00: FN-7728 — fn_task_bypass_review is a merge-gate override, governed by its own review_gate_bypass category rather than task_agent_mutation so operators can dial bypass approval independently of ordinary task mutations.
    category = "review_gate_bypass";
    operation = params.toolName;
    resourceType = "task";
  } else if (FILE_SCOPE_TOOLS.has(params.toolName)) {
    // FNXC:ToolGovernance 2026-07-09-08:30: FN-7737 — fn_task_file_scope_add (File Scope additional-approval) is governed by its own file_scope category, distinct from task_agent_mutation/file_write_delete, so operators can dial it independently. Uniform grant-all default (no stricter override like review_gate_bypass).
    category = "file_scope";
    operation = params.toolName;
    resourceType = "file";
  } else if (TASK_AGENT_MANAGEMENT_TOOLS.has(params.toolName)) {
    category = "task_agent_mutation";
    operation = params.toolName;
    resourceType = params.toolName.includes("agent") || params.toolName.includes("spawn") ? "agent" : "task";
  } else if (COMMAND_EXECUTION_TOOLS.has(params.toolName)) {
    category = "command_execution";
    operation = params.toolName;
    resourceType = "command";
  } else if (NETWORK_API_TOOLS.has(params.toolName) || params.toolName.startsWith("mcp__")) {
    /*
    FNXC:AgentGating 2026-07-12-17:18:
    MAIN-008 requires every namespaced project MCP operation to remain inside
    the external-action approval boundary. MCP tools are dynamically named and
    therefore cannot live in the static tool registry; classify the namespace
    as network_api instead of falling through to the exempt default.

    FNXC:AgentGating 2026-07-12-18:35:
    Built-in research tools keep resourceType "research". Namespaced mcp__*
    tools use "mcp" so approval UI/audit metadata and dedupe keys describe an
    external MCP action rather than a research read.
    */
    category = "network_api";
    operation = params.toolName;
    resourceType = params.toolName.startsWith("mcp__") ? "mcp" : "research";
  } else if (FILE_WRITE_DELETE_FN_TOOLS.has(params.toolName)) {
    // FNXC:AgentGating 2026-07-26-15:10: fn_task_attach mutates persisted task
    // attachments; the permanent gate already classifies it file_write_delete.
    // The action gate previously let it through via the exempt fallback — a
    // silent-exemption defect. Positive parity classification; still "allow"
    // under the default unrestricted preset.
    category = "file_write_delete";
    operation = params.toolName;
    resourceType = "file";
  } else if (ACTION_GATE_PROVISIONING_POLICY_TOOLS.has(params.toolName)) {
    // FNXC:AgentGating 2026-07-26-15:05: FN-3953 — provisioning tools are governed
    // solely by the dedicated agent_provisioning policy; positive exemption here
    // avoids double approval rows now that the unknown fallback fails closed.
    category = "exempt";
    operation = params.toolName;
  } else if (READONLY_FN_TOOLS.has(params.toolName)) {
    /*
    FNXC:AgentGating 2026-07-26-15:00:
    Read-only fn_* discovery tools were previously "recognized" only by
    falling into the exempt default. With the unknown-tool fallback now fail
    closed, they need a POSITIVE exempt classification (matching the
    permanent gate's recognized "none" class) so read paths stay ungated in
    both directions.
    */
    category = "exempt";
    operation = params.toolName;
  } else {
    /*
    FNXC:AgentGating 2026-07-26-13:10:
    Audit finding: an UNCLASSIFIED tool used to fall through with category
    "exempt" → hardcoded allow, so anything the classifier missed bypassed
    even a locked-down policy. Fail closed instead: unknown tools resolve to
    the policy-governed `command_execution` category. Under the shipped
    default `unrestricted` preset this is still "allow", so out-of-the-box
    behavior is UNCHANGED; under strict presets unknown tools are now
    actually governed. Genuine coordination exemptions must be positively
    registered in COORDINATION_EXEMPT_TOOLS.
    */
    category = "command_execution";
    operation = params.toolName;
    resourceType = "other";
  }

  /*
  FNXC:MissionAdmission 2026-07-22-13:07:
  Freeform chat/user-directed creates omit mission_lineage and must remain policy-
  governed (allow/require-approval/block), not hard-blocked at the gate. Autonomous
  heartbeat patrol still enforces lineage via createTaskCreateTool/createDelegateTaskTool
  requireMissionLineage + resolveApprovedMissionLineage before any task row is written.
  Supplied lineage is validated at the tool factory; the gate does not re-encode that
  admission rule so chat freeform intake and heartbeat requirements can diverge safely.
  */

  /*
  FNXC:ToolPermissions 2026-07-01-00:00:
  Exact tool-name overrides must be resolved before category policy so operators can block a single governed tool such as `fn_task_create` without blocking every `task_agent_mutation` tool. Exempt coordination tools remain hard-bypassed to avoid heartbeat deadlocks.
  */
  const exactDisposition = category === "exempt" ? undefined : params.permissionPolicy.toolRules?.[params.toolName];
  const disposition: AgentPermissionPolicyDisposition | "allow" = category === "exempt"
    ? "allow"
    : exactDisposition ?? params.permissionPolicy.rules[category];

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
    metadata: exactDisposition
      ? {
          permissionPolicyMatch: {
            type: "toolRule",
            toolName: params.toolName,
            disposition: exactDisposition,
          },
        }
      : {},
  };
}

export function resolveGateOutcome(
  decision: AgentActionGateDecision,
  latestRequest: { id: string; status: ApprovalRequestStatus; decidedAt?: string } | null,
): { outcome: "allow" | "block" | "execute-once-then-complete" | "wait-for-approval"; approvalRequestId?: string } {
  if (decision.disposition === "allow") {
    return { outcome: "allow" };
  }
  if (decision.disposition === "block") {
    return { outcome: "block" };
  }
  if (!latestRequest) {
    return { outcome: "wait-for-approval" };
  }
  if (latestRequest.status === "pending") {
    return { outcome: "wait-for-approval", approvalRequestId: latestRequest.id };
  }
  if (latestRequest.status === "approved") {
    /*
    FNXC:ApprovalRedemption 2026-07-26-13:05:
    Approved-but-unredeemed grants expire after the grant TTL instead of
    staying redeemable forever. An expired grant is treated as absent so a
    fresh request is minted (wait-for-approval), never silently executed.
    Closures that do not yet supply decidedAt skip TTL evaluation
    (backward-compatible; both engine closures now supply it).
    */
    if (
      latestRequest.decidedAt !== undefined
      && isApprovalRequestExpired({ status: "approved", requestedAt: latestRequest.decidedAt, decidedAt: latestRequest.decidedAt })
    ) {
      return { outcome: "wait-for-approval" };
    }
    return { outcome: "execute-once-then-complete", approvalRequestId: latestRequest.id };
  }
  if (latestRequest.status === "denied") {
    return { outcome: "block", approvalRequestId: latestRequest.id };
  }
  return { outcome: "wait-for-approval" };
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
