/**
 * FNXC:CodeOrganization 2026-08-03-14:05:
 * resolveEffectivePrincipalId peeled from TaskExecutor (U4).
 *
 * Column-agent seam: prefer governing node column-agent binding over assignedAgentId.
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
