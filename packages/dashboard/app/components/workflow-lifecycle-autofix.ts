import type { Node as FlowNode, Edge as FlowEdge } from "@xyflow/react";
import { completionSummaryNode } from "@fusion/core";
import type { WorkflowLifecycleWarningCode } from "@fusion/core";
import type { WorkflowFlowNodeData } from "./nodes/WorkflowNodeTypes";
import {
  insertNodeOnEdge,
  findAppendEdgeId,
  edgeSupportsSimpleInsert,
  type SimpleInsertSpec,
  type SimpleInsertResult,
} from "./workflow-simple-layout";

/*
FNXC:WorkflowLifecycleAutofix 2026-07-12-13:00:
Two of the five lifecycle warning codes have a deterministic remedy, so the
editor's warning banner offers one-click fixes for them (all view modes; the
simplified view is the motivating surface since its users cannot drag nodes
into place):
 - missing-completion-summary → insert the CANONICAL completion-summary
   prompt node (config from @fusion/core's completionSummaryNode, keyed by
   summaryTarget:"task") in front of the merge region when one exists,
   otherwise in front of `end`.
 - missing-merge-region → insert a Merge boundary node (serializes to
   prompt + seam:"merge") in front of `end`.
The remaining codes (unsafe-terminal-before-merge, optional-group-after-
execution, review-gate-without-failure-route) are structural judgment calls
and stay manual.
*/

type LayoutNode = FlowNode<WorkflowFlowNodeData>;

export const LIFECYCLE_AUTOFIXABLE_CODES: ReadonlySet<WorkflowLifecycleWarningCode> = new Set([
  "missing-completion-summary",
  "missing-merge-region",
] as WorkflowLifecycleWarningCode[]);

/** The node the fix inserts, shared by the edge-splice path and the
 *  free-floating fallback so both produce identical configs. */
export function lifecycleFixNodeSpec(code: WorkflowLifecycleWarningCode): SimpleInsertSpec | null {
  if (code === "missing-merge-region") {
    return { kind: "merge", label: "Merge boundary" };
  }
  if (code === "missing-completion-summary") {
    // Canonical config (name/prompt/toolMode/summaryTarget) from core; the
    // column argument only stamps the IR node's column, which the editor
    // derives from placement instead.
    const canonical = completionSummaryNode("");
    return {
      kind: "prompt",
      label: "Completion summary",
      presetConfig: { ...(canonical.config ?? {}) },
    };
  }
  return null;
}

function singleInboundEdgeId(nodes: LayoutNode[], edges: FlowEdge[], targetId: string): string | null {
  const inbound = edges.filter(
    (e) => e.target === targetId && edgeSupportsSimpleInsert(e) && nodes.some((n) => n.id === e.source),
  );
  return inbound.length === 1 ? inbound[0].id : null;
}

/** The edge the fix should splice into, or null when no unambiguous wiring
 *  point exists (caller falls back to a free-floating node). */
export function lifecycleFixTargetEdgeId(
  nodes: LayoutNode[],
  edges: FlowEdge[],
  code: WorkflowLifecycleWarningCode,
): string | null {
  if (code === "missing-merge-region") {
    return findAppendEdgeId(nodes, edges);
  }
  if (code === "missing-completion-summary") {
    // Prefer directly upstream of the merge region so the summary runs
    // before review/merge/done, matching the built-in workflows' shape.
    const mergeNode = nodes.find((n) => !n.parentId && n.data.kind === "merge");
    if (mergeNode) {
      const beforeMerge = singleInboundEdgeId(nodes, edges, mergeNode.id);
      if (beforeMerge) return beforeMerge;
    }
    return findAppendEdgeId(nodes, edges);
  }
  return null;
}

/**
 * Apply one lifecycle fix. Returns the updated graph (and the inserted node
 * id) or null when the code is not auto-fixable or no unambiguous wiring
 * point exists.
 */
export function applyLifecycleWarningFix(
  nodes: LayoutNode[],
  edges: FlowEdge[],
  code: WorkflowLifecycleWarningCode,
): SimpleInsertResult | null {
  const spec = lifecycleFixNodeSpec(code);
  if (!spec) return null;
  const edgeId = lifecycleFixTargetEdgeId(nodes, edges, code);
  if (!edgeId) return null;
  return insertNodeOnEdge(nodes, edges, edgeId, spec);
}

/**
 * Apply every auto-fixable warning in one pass. Merge region first, then the
 * completion summary — with the merge boundary in place, the summary lands
 * directly upstream of it. Returns null when nothing could be applied.
 */
export function applyAllLifecycleWarningFixes(
  nodes: LayoutNode[],
  edges: FlowEdge[],
  codes: readonly WorkflowLifecycleWarningCode[],
): SimpleInsertResult | null {
  const wanted = new Set(codes.filter((code) => LIFECYCLE_AUTOFIXABLE_CODES.has(code)));
  let current: SimpleInsertResult | null = null;
  for (const code of ["missing-merge-region", "missing-completion-summary"] as WorkflowLifecycleWarningCode[]) {
    if (!wanted.has(code)) continue;
    const next = applyLifecycleWarningFix(current?.nodes ?? nodes, current?.edges ?? edges, code);
    if (next) current = next;
  }
  return current;
}
