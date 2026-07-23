import type { NodeStatus, OwningNodeHandoffPolicy, Task, UnavailableNodePolicy } from "@fusion/core";
import type { EffectiveNode } from "./effective-node.js";

export type PolicyDecision =
  | { allowed: true; fallbackToLocal: false }
  | { allowed: true; fallbackToLocal: true; reason: string }
  | { allowed: false; reason: string };

export type HandoffDecision =
  | { action: "park"; reason: string }
  | { action: "reassign-local"; reason: string }
  | { action: "reassign-any"; reason: string };

const UNHEALTHY_STATUSES: ReadonlySet<NodeStatus> = new Set(["offline", "error", "connecting"]);

export function applyUnavailableNodePolicy(params: {
  effectiveNode: EffectiveNode;
  nodeHealth: NodeStatus | undefined;
  policy: UnavailableNodePolicy | undefined;
}): PolicyDecision {
  const { effectiveNode, nodeHealth, policy } = params;

  if (effectiveNode.source === "local") {
    return { allowed: true, fallbackToLocal: false };
  }

  if (nodeHealth === "online" || nodeHealth === undefined) {
    return { allowed: true, fallbackToLocal: false };
  }

  if (!effectiveNode.nodeId || !UNHEALTHY_STATUSES.has(nodeHealth)) {
    return { allowed: true, fallbackToLocal: false };
  }

  if (policy === "fallback-local") {
    return {
      allowed: true,
      fallbackToLocal: true,
      reason: `Node ${effectiveNode.nodeId} is ${nodeHealth}; falling back to local per policy`,
    };
  }

  return {
    allowed: false,
    reason: `Node ${effectiveNode.nodeId} is ${nodeHealth}; policy is block`,
  };
}

export function decideOwningNodeHandoff(params: {
  task: Task;
  ownerNodeId: string;
  ownerNodeHealth: NodeStatus | undefined;
  localNodeId: string;
  handoffPolicy: OwningNodeHandoffPolicy | undefined;
}): HandoffDecision {
  const { ownerNodeId, ownerNodeHealth, localNodeId, handoffPolicy } = params;
  if (ownerNodeHealth === "online") {
    return { action: "park", reason: "owner_recovered" };
  }

  if (ownerNodeId === localNodeId) {
    return { action: "reassign-local", reason: "owner_local_recover" };
  }

  if (handoffPolicy === "block") {
    return { action: "park", reason: "handoff_blocked_by_policy" };
  }

  if (handoffPolicy === "reassign-any-healthy") {
    return {
      action: "reassign-any",
      reason: `owner_${ownerNodeHealth ?? "unknown"}_any_healthy_eligible`,
    };
  }

  return {
    action: "reassign-local",
    reason: `owner_${ownerNodeHealth ?? "unknown"}_local_takes_over`,
  };
}
