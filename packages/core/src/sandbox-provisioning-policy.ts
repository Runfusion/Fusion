import type { ApprovalRequest, ProjectSettings, SandboxProvisioningApprovalMode } from "./types.js";

type SandboxProvisioningSettings = Pick<ProjectSettings, "sandboxProvisioning">;

export interface SandboxProvisioningPolicyInput {
  /** Sandbox backend id (for example: native, bubblewrap, sandbox-exec, podman, docker). */
  backendId: string;
  operation: string;
  caller?: { id: string; role?: string; isPrivileged?: boolean };
  settings: SandboxProvisioningSettings | undefined;
}

export interface SandboxProvisioningPolicyDecision {
  decision: "allow" | "require-approval" | "deny";
  reason: string;
  matchedRule:
    | "auto-approve-backend"
    | "privileged-caller"
    | "trusted-agent-id"
    | "trusted-role"
    | "approval-mode-always"
    | "approval-mode-trusted-only"
    | "approval-mode-never"
    | "missing-caller";
  effectiveMode: SandboxProvisioningApprovalMode;
}

function normalizeMode(settings: SandboxProvisioningSettings | undefined): SandboxProvisioningApprovalMode {
  return settings?.sandboxProvisioning?.approvalMode ?? "always";
}

export function resolveSandboxProvisioningPolicy(
  input: SandboxProvisioningPolicyInput,
): SandboxProvisioningPolicyDecision {
  const effectiveMode = normalizeMode(input.settings);
  const caller = input.caller;

  if (!caller) {
    return { decision: "deny", reason: "missing caller", matchedRule: "missing-caller", effectiveMode };
  }

  const autoApproveBackendIds = input.settings?.sandboxProvisioning?.autoApproveBackendIds ?? ["native"];
  if (autoApproveBackendIds.includes(input.backendId)) {
    return {
      decision: "allow",
      reason: `backend ${input.backendId} is auto-approved`,
      matchedRule: "auto-approve-backend",
      effectiveMode,
    };
  }

  if (caller.isPrivileged === true) {
    return { decision: "allow", reason: "privileged caller", matchedRule: "privileged-caller", effectiveMode };
  }

  if (effectiveMode === "never") {
    return { decision: "allow", reason: "approval mode never", matchedRule: "approval-mode-never", effectiveMode };
  }

  const trustedAgentIds = input.settings?.sandboxProvisioning?.trustedAgentIds ?? [];
  if (trustedAgentIds.includes(caller.id)) {
    return { decision: "allow", reason: "trusted agent id", matchedRule: "trusted-agent-id", effectiveMode };
  }

  const trustedRoles = (input.settings?.sandboxProvisioning?.trustedRoles ?? []).map((role) => role.toLowerCase());
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

export function extractSandboxProvisioningRequest(approvalRequest: ApprovalRequest): {
  backendId: string;
  operation: string;
  params: Record<string, unknown>;
} {
  if (approvalRequest.targetAction.category !== "sandbox_provisioning") {
    throw new Error(`Approval request ${approvalRequest.id} is not a sandbox_provisioning request`);
  }

  const context = approvalRequest.targetAction.context;
  if (!context || typeof context !== "object") {
    throw new Error(`Approval request ${approvalRequest.id} is missing provisioning context`);
  }

  const backendId = context.backendId;
  if (typeof backendId !== "string" || backendId.trim().length === 0) {
    throw new Error(`Approval request ${approvalRequest.id} has invalid provisioning backend id`);
  }

  const operation = context.operation;
  if (typeof operation !== "string" || operation.trim().length === 0) {
    throw new Error(`Approval request ${approvalRequest.id} has invalid provisioning operation`);
  }

  const params = context.params;
  if (!params || typeof params !== "object") {
    throw new Error(`Approval request ${approvalRequest.id} has invalid provisioning params`);
  }

  return { backendId, operation, params: params as Record<string, unknown> };
}
