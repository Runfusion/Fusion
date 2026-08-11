/**
 * FNXC:CodeOrganization 2026-08-03-12:10:
 * taskEffectiveAgentMatches peeled from TaskExecutor (U4).
 *
 * FNXC:WorkflowColumns 2026-06-22-18:00:
 * Workflow columns are the default runtime, so resume pass 2 always resolves the task workflow IR.
 */
import type { Task, TaskStore, WorkflowIrNode } from "@fusion/core";
import {
  instanceNodeId,
  resolveColumnAgentBinding,
  resolveEffectiveAgent,
  resolveWorkflowIrForTask,
} from "@fusion/core";
import { extractOwnSettings } from "./agent-binding-pure.js";

export async function taskEffectiveAgentMatches(
  store: TaskStore,
  task: Task,
  agentId: string,
): Promise<boolean> {
  const ir = await resolveWorkflowIrForTask(store, task.id);
  if (!ir || ir.version !== "v2") return false;

  const ownSettings = extractOwnSettings(task);
  const matchesNodeId = (nodeId: string): boolean => {
    const binding = resolveColumnAgentBinding(ir, nodeId);
    if (!binding) return false;
    const effective = resolveEffectiveAgent({ binding, ...ownSettings });
    return effective.source === "column-agent" && effective.agentId === agentId;
  };

  // Governing seam nodes: the execute-seam prompt node lives at the top level.
  for (const node of ir.nodes) {
    const seam = node.kind === "prompt" ? node.config?.seam : undefined;
    if (seam !== "execute" && seam !== "step-execute") continue;
    if (matchesNodeId(node.id)) return true;
  }

  // step-execute seam nodes are legal ONLY inside a foreach template
  // (workflow-ir.ts), so they never appear in ir.nodes above. Walk each foreach
  // node's template subgraph and resolve the binding via a synthesized instance
  // node id. Step index 0 is sufficient — column resolution is index-independent
  // (all instances share the same template node and thus the same binding, R4).
  for (const node of ir.nodes) {
    if (node.kind !== "foreach") continue;
    const templateNodes = (node.config as { template?: { nodes?: WorkflowIrNode[] } } | undefined)?.template?.nodes ?? [];
    for (const templateNode of templateNodes) {
      const seam = templateNode.kind === "prompt" ? templateNode.config?.seam : undefined;
      if (seam !== "step-execute") continue;
      if (matchesNodeId(instanceNodeId(node.id, 0, templateNode.id))) return true;
    }
  }
  return false;
}
