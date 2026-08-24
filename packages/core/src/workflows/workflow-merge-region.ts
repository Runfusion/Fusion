import type { WorkflowIr, WorkflowIrNode, WorkflowIrNodeKind } from "./workflow-ir-types.js";

/*
FNXC:MergeAuthority 2026-08-23-18:05 (FN-9193 wedge):
THE MERGE REGION IS THE GRAPH'S MERGE AUTHORITY. A card whose active continuation sits on one of
these nodes has been authorized by its workflow to merge; a card anywhere else has not, no matter
what its column, steps, or status say.

This set is the canonical spelling. `INTERPRETER_ENTRY_NODE_KINDS` (workflow-ir.ts) is the same
membership and now re-exports it. Two NEARBY sets are deliberately different and must not be folded
in: `MERGE_CLASS_NODE_KINDS` (save-time merge-blocker reachability) drops `pr-create`/`pr-respond`
because neither clears a merge-blocker gate, and `MERGE_REGION_NODE_KINDS`
(workflow-lifecycle-validation.ts) drops every `pr-*` kind because it describes the engine-owned
policy region only. Admission needs the widest reading — a card parked at `pr-respond` IS inside its
workflow's merge lane and its merge may legitimately be re-driven.
*/
export const MERGE_REGION_ENTRY_NODE_KINDS: ReadonlySet<WorkflowIrNodeKind> = new Set([
  "merge-gate",
  "merge-attempt",
  "manual-merge-hold",
  "retry-backoff",
  "recovery-router",
  "branch-group-member-integration",
  "branch-group-promotion",
  "pr-create",
  "pr-respond",
  "pr-merge",
]);

/**
 * True when a node belongs to its workflow's merge region.
 *
 * `config.seam === "merge"` is included because linear built-ins and custom seam workflows express
 * their merge as a `prompt` node rather than a `merge-attempt` kind; omitting it would classify
 * every seam-workflow card as "not at a merge node" and freeze their auto-merge recovery.
 */
export function isMergeRegionNode(node: Pick<WorkflowIrNode, "kind" | "config">): boolean {
  return MERGE_REGION_ENTRY_NODE_KINDS.has(node.kind) || node.config?.seam === "merge";
}

/**
 * Resolve whether `nodeId` names a merge-region node in `ir`.
 *
 * Returns `"unknown"` when the id is absent from the graph — an IR that drifted under a live
 * continuation. Callers must fail OPEN on `"unknown"`: refusing a card whose node we cannot even
 * find would strand it with no other driver.
 */
export function classifyWorkflowNodeMergeRegion(
  ir: WorkflowIr,
  nodeId: string,
): "merge-region" | "outside-merge-region" | "unknown" {
  if (ir.version !== "v2" || !Array.isArray(ir.nodes)) return "unknown";
  const node = ir.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) return "unknown";
  return isMergeRegionNode(node) ? "merge-region" : "outside-merge-region";
}
