/**
 * FNXC:CodeOrganization 2026-08-03-14:05:
 * resolveEffectivePrincipalId peeled from TaskExecutor (U4).
 *
 * FNXC:ColumnAgent 2026-07-19 (plan U5, R6):
 * Resolve the EFFECTIVE principal id for the in-flight seam WITHOUT fetching the full
 * Agent or emitting an adoption log — a light counterpart to resolveSeamColumnAgent used
 * by the heartbeat-deferral gate (which only needs the id to call shouldDeferForHeartbeat).
 * Returns the column-agent id when a governing binding selects it via resolveEffectiveAgent
 * (KTD-2/KTD-5), else task.assignedAgentId. Returns undefined only when there is no principal
 * at all (no binding AND no assigned agent) — keeping the no-binding path byte-identical.
 */
import type { Task, WorkflowColumnAgent } from "@fusion/core";
import { resolveEffectiveAgent } from "@fusion/core";
import { extractOwnSettings } from "./agent-binding-pure.js";

export type ResolveEffectivePrincipalIdDeps = {
  graphSeamGoverningNodeId: Map<string, string>;
  graphColumnAgentResolver: Map<string, (nodeId: string) => WorkflowColumnAgent | undefined>;
};

export function resolveEffectivePrincipalId(
  deps: ResolveEffectivePrincipalIdDeps,
  task: Task,
  detail: Task,
): string | undefined {
  const ownSettings = extractOwnSettings(detail);
  const assignedAgentId = ownSettings.ownAgentId;

  const governingNodeId = deps.graphSeamGoverningNodeId.get(task.id);
  const resolveBinding = deps.graphColumnAgentResolver.get(task.id);
  if (!governingNodeId || !resolveBinding) return assignedAgentId;

  const binding = resolveBinding(governingNodeId);
  if (!binding) return assignedAgentId;

  const effective = resolveEffectiveAgent({ binding, ...ownSettings });
  if (effective.source === "column-agent") return effective.agentId;
  return assignedAgentId;
}
