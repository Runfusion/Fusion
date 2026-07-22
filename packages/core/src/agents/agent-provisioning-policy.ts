import type { AgentProvisioningApprovalMode, ApprovalRequest, ProjectSettings } from "../types.js";

type AgentProvisioningSettings = Pick<ProjectSettings, "agentProvisioning">;

export type AgentProvisioningTool = "fn_agent_create" | "fn_agent_delete";

export interface AgentProvisioningPolicyInput {
  tool: AgentProvisioningTool;
  caller?: { id: string; role?: string; isPrivileged?: boolean };
  settings: AgentProvisioningSettings | undefined;
}

export interface AgentProvisioningPolicyDecision {
  decision: "allow" | "require-approval" | "deny";
  reason: string;
  matchedRule:
    | "privileged-caller"
    | "trusted-agent-id"
    | "trusted-role"
    | "approval-mode-always"
    | "approval-mode-trusted-only"
    | "approval-mode-never"
    | "delete-always-approve"
    | "missing-caller";
  effectiveMode: AgentProvisioningApprovalMode;
}

function normalizeMode(settings: AgentProvisioningSettings | undefined): AgentProvisioningApprovalMode {
  return settings?.agentProvisioning?.approvalMode ?? "trusted-only";
}

export function resolveAgentProvisioningPolicy(input: AgentProvisioningPolicyInput): AgentProvisioningPolicyDecision {
  const effectiveMode = normalizeMode(input.settings);
  const caller = input.caller;
  if (!caller) {
    return { decision: "deny", reason: "missing caller", matchedRule: "missing-caller", effectiveMode };
  }

  if (caller.isPrivileged === true) {
    return { decision: "allow", reason: "privileged caller", matchedRule: "privileged-caller", effectiveMode };
  }

  if (effectiveMode === "never") {
    return { decision: "allow", reason: "approval mode never", matchedRule: "approval-mode-never", effectiveMode };
  }

  const alwaysApproveDelete = input.settings?.agentProvisioning?.alwaysApproveDelete ?? true;
  if (input.tool === "fn_agent_delete" && alwaysApproveDelete) {
    return {
      decision: "require-approval",
      reason: "delete requires approval by policy",
      matchedRule: "delete-always-approve",
      effectiveMode,
    };
  }

  const trustedAgentIds = input.settings?.agentProvisioning?.trustedAgentIds ?? [];
  if (trustedAgentIds.includes(caller.id)) {
    return { decision: "allow", reason: "trusted agent id", matchedRule: "trusted-agent-id", effectiveMode };
  }

  const trustedRoles = (input.settings?.agentProvisioning?.trustedRoles ?? []).map((role) => role.toLowerCase());
  if (caller.role && trustedRoles.includes(caller.role.toLowerCase())) {
    return { decision: "allow", reason: "trusted role", matchedRule: "trusted-role", effectiveMode };
  }

  if (effectiveMode === "always") {
    return {
      decision: "require-approval",
      reason: "approval mode always",
      matchedRule: "approval-mode-always",
      effectiveMode,
    };
  }

  return {
    decision: "require-approval",
    reason: "trusted-only requires trusted caller",
    matchedRule: "approval-mode-trusted-only",
    effectiveMode,
  };
}

export function extractAgentProvisioningRequest(approvalRequest: ApprovalRequest): {
  tool: AgentProvisioningTool;
  params: Record<string, unknown>;
} {
  if (approvalRequest.targetAction.category !== "agent_provisioning") {
    throw new Error(`Approval request ${approvalRequest.id} is not an agent_provisioning request`);
  }
  const context = approvalRequest.targetAction.context;
  if (!context || typeof context !== "object") {
    throw new Error(`Approval request ${approvalRequest.id} is missing provisioning context`);
  }

  const tool = context.tool;
  if (tool !== "fn_agent_create" && tool !== "fn_agent_delete") {
    throw new Error(`Approval request ${approvalRequest.id} has invalid provisioning tool`);
  }

  const params = context.params;
  if (!params || typeof params !== "object") {
    throw new Error(`Approval request ${approvalRequest.id} has invalid provisioning params`);
  }

  return { tool, params: params as Record<string, unknown> };
}
