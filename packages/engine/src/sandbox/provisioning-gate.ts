import type {
  ApprovalRequest,
  ApprovalRequestActorSnapshot,
  ApprovalRequestStatus,
  ProjectSettings,
} from "@fusion/core";
import { resolveSandboxProvisioningPolicy } from "@fusion/core";
import {
  computeApprovalDedupeKey,
  resolveGateOutcome,
  type AgentActionGateDecision,
} from "../agents/agent-action-gate.js";

export class SandboxProvisioningPendingError extends Error {
  readonly approvalRequestId: string;
  readonly dedupeKey: string;
  readonly decision: AgentActionGateDecision;

  constructor(params: {
    message: string;
    approvalRequestId: string;
    dedupeKey: string;
    decision: AgentActionGateDecision;
  }) {
    super(params.message);
    this.name = "SandboxProvisioningPendingError";
    this.approvalRequestId = params.approvalRequestId;
    this.dedupeKey = params.dedupeKey;
    this.decision = params.decision;
  }
}

export interface SandboxProvisioningGateContext {
  taskId?: string;
  runId?: string;
  requester: ApprovalRequestActorSnapshot;
  settings: Pick<ProjectSettings, "sandboxProvisioning"> | undefined;
  createApprovalRequest: (input: {
    category: "sandbox_provisioning";
    toolName: string;
    args: Record<string, unknown>;
  }) => Promise<ApprovalRequest | null>;
  findApprovalByDedupeKey?: (dedupeKey: string) => Promise<{ id: string; status: ApprovalRequestStatus } | null>;
  pauseForApproval?: (info: { approvalRequestId: string; decision: AgentActionGateDecision }) => Promise<void>;
}

export async function requireSandboxProvisioningApproval(input: {
  backendId: string;
  operation: string;
  description: string;
  params?: Record<string, unknown>;
  context: SandboxProvisioningGateContext;
}): Promise<{ outcome: "allow" | "execute-once-then-complete"; approvalRequestId?: string }> {
  const { backendId, operation, description, context } = input;
  const params = input.params ?? {};

  const dedupeKey = computeApprovalDedupeKey({
    agentId: context.requester.actorId,
    taskId: context.taskId,
    toolName: `sandbox:provisioning:${backendId}`,
    category: "sandbox_provisioning",
    resourceType: "command",
    resourceId: operation,
    operation,
  });

  const policyDecision = resolveSandboxProvisioningPolicy({
    backendId,
    operation,
    caller: {
      id: context.requester.actorId,
      role: context.requester.actorType === "agent" ? "agent" : context.requester.actorType,
      isPrivileged: context.requester.actorType === "user",
    },
    settings: context.settings,
  });

  const decision: AgentActionGateDecision = {
    disposition:
      policyDecision.decision === "require-approval"
        ? "require-approval"
        : policyDecision.decision === "allow"
          ? "allow"
          : "block",
    category: "command_execution",
    toolName: `sandbox:provisioning:${backendId}`,
    operation,
    summary: description,
    resourceType: "command",
    resourceId: operation,
    approvalDedupeKey: dedupeKey,
    metadata: {
      backendId,
      operation,
      description,
      policyReason: policyDecision.reason,
      policyRule: policyDecision.matchedRule,
      policyMode: policyDecision.effectiveMode,
    },
  };

  if (policyDecision.decision === "allow") {
    return { outcome: "allow" };
  }

  if (policyDecision.decision === "deny") {
    throw new SandboxProvisioningPendingError({
      message: `Sandbox provisioning denied: ${policyDecision.reason}`,
      approvalRequestId: "",
      dedupeKey,
      decision,
    });
  }

  const existing = context.findApprovalByDedupeKey ? await context.findApprovalByDedupeKey(dedupeKey) : null;
  const gateOutcome = resolveGateOutcome(decision, existing);

  if (gateOutcome.outcome === "execute-once-then-complete") {
    return { outcome: "execute-once-then-complete", approvalRequestId: gateOutcome.approvalRequestId };
  }

  if (gateOutcome.outcome === "block") {
    throw new SandboxProvisioningPendingError({
      message: "Sandbox provisioning approval denied",
      approvalRequestId: gateOutcome.approvalRequestId ?? "",
      dedupeKey,
      decision,
    });
  }

  if (gateOutcome.approvalRequestId) {
    /*
    FNXC:AgentGating 2026-07-05-00:20:
    FN-7608: a reused-pending approval must also re-run pauseForApproval, not
    just the newly-created path below -- otherwise a repeated identical
    provisioning request after the first pause (e.g. task/agent resumed some
    other way) would silently re-block without re-pausing, mirroring the same
    gap fixed in wrapToolsWithActionGate (pi.ts).
    */
    if (context.pauseForApproval) {
      await context.pauseForApproval({ approvalRequestId: gateOutcome.approvalRequestId, decision });
    }
    throw new SandboxProvisioningPendingError({
      message: "Sandbox provisioning approval pending",
      approvalRequestId: gateOutcome.approvalRequestId,
      dedupeKey,
      decision,
    });
  }

  const created = await context.createApprovalRequest({
    category: "sandbox_provisioning",
    toolName: `sandbox:provisioning:${backendId}`,
    args: {
      backendId,
      operation,
      description,
      params,
      approvalDedupeKey: dedupeKey,
    },
  });

  if (!created) {
    throw new SandboxProvisioningPendingError({
      message: "Sandbox provisioning approval request was not created",
      approvalRequestId: "",
      dedupeKey,
      decision,
    });
  }

  if (context.pauseForApproval) {
    await context.pauseForApproval({ approvalRequestId: created.id, decision });
  }

  throw new SandboxProvisioningPendingError({
    message: "Sandbox provisioning approval pending",
    approvalRequestId: created.id,
    dedupeKey,
    decision,
  });
}
