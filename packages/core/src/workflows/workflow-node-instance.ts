import type { WorkflowIr, WorkflowIrNode } from "./workflow-ir-types.js";

/**
 * FNXC:WorkflowAgentRouting 2026-08-07-05:29:
 * Reviewer authority is fenced to the instantiated template node, not merely a
 * top-level ID. A foreach review attempt uses `<foreach>#<index>:<node>`, so
 * resolving only `ir.nodes` would leave an edited nested override authorized.
 */
export function findWorkflowNodeInstance(ir: WorkflowIr | undefined, nodeInstanceId: string): WorkflowIrNode | undefined {
  if (!ir) return undefined;
  return findTemplateNodeInstance(ir.nodes, nodeInstanceId);
}

/** Resolve recursively because template containers may be nested. */
function findTemplateNodeInstance(nodes: readonly WorkflowIrNode[], nodeInstanceId: string): WorkflowIrNode | undefined {
  const direct = nodes.find((node) => node.id === nodeInstanceId);
  if (direct) return direct;

  for (const container of nodes) {
    const templateNodes = (container.config as { template?: { nodes?: WorkflowIrNode[] } } | undefined)?.template?.nodes;
    if (!templateNodes) continue;
    const optionalPrefix = `${container.id}::`;
    if (nodeInstanceId.startsWith(optionalPrefix)) {
      const nested = findTemplateNodeInstance(templateNodes, nodeInstanceId.slice(optionalPrefix.length));
      if (nested) return nested;
    }
    const iterationPrefix = `${container.id}#`;
    if (!nodeInstanceId.startsWith(iterationPrefix)) continue;
    const separator = nodeInstanceId.indexOf(":", iterationPrefix.length);
    if (separator < 0 || !/^\d+$/.test(nodeInstanceId.slice(iterationPrefix.length, separator))) continue;
    const nested = findTemplateNodeInstance(templateNodes, nodeInstanceId.slice(separator + 1));
    if (nested) return nested;
  }
  return undefined;
}

