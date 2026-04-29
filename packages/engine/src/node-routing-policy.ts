import type { NodeStatus, UnavailableNodePolicy } from "@fusion/core";
import type { EffectiveNode } from "./effective-node.js";

export type PolicyDecision =
  | { allowed: true; fallbackToLocal: false }
  | { allowed: true; fallbackToLocal: true; reason: string }
  | { allowed: false; reason: string };

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
