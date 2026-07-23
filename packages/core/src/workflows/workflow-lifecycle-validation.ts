import type { WorkflowDefinitionKind } from "./workflow-definition-types.js";
import type { WorkflowIr, WorkflowIrEdge, WorkflowIrNode } from "./workflow-ir-types.js";
import { isCompletionSummaryNode } from "./builtin-completion-summary-node.js";

/**
 * FNXC:WorkflowLifecycle 2026-07-01-00:00:
 * Workflow-owned merge/retry/recovery policy primitives — a terminal,
 * engine-owned region that may branch internally. Formerly exported from the
 * (now-deleted) linear WorkflowStep compiler; the graph interpreter is the sole
 * executor, so this set now lives with its only remaining consumer.
 */
const MERGE_REGION_NODE_KINDS: ReadonlySet<WorkflowIrNode["kind"]> = new Set([
  "merge-gate",
  "merge-attempt",
  "manual-merge-hold",
  "retry-backoff",
  "recovery-router",
  "branch-group-member-integration",
  "branch-group-promotion",
]);

export type WorkflowLifecycleWarningCode =
  | "missing-completion-summary"
  | "missing-merge-region"
  | "unsafe-terminal-before-merge"
  | "optional-group-after-execution"
  | "review-gate-without-failure-route";

export interface WorkflowLifecycleWarning {
  code: WorkflowLifecycleWarningCode;
  nodeId?: string;
  message: string;
}

export interface AnalyzeWorkflowLifecycleOptions {
  kind?: WorkflowDefinitionKind;
}

function isSummaryNode(node: WorkflowIrNode): boolean {
  return isCompletionSummaryNode(node);
}

function isMergeNode(node: WorkflowIrNode): boolean {
  return MERGE_REGION_NODE_KINDS.has(node.kind) || node.config?.seam === "merge";
}

function isExecutionNode(node: WorkflowIrNode): boolean {
  return node.config?.seam === "execute" || node.kind === "foreach" || node.kind === "parse-steps";
}

function buildOutgoing(edges: readonly WorkflowIrEdge[]): Map<string, WorkflowIrEdge[]> {
  const outgoing = new Map<string, WorkflowIrEdge[]>();
  for (const edge of edges) {
    const list = outgoing.get(edge.from) ?? [];
    list.push(edge);
    outgoing.set(edge.from, list);
  }
  return outgoing;
}

function reachableBefore(
  startId: string,
  targetId: string,
  outgoing: Map<string, WorkflowIrEdge[]>,
): Set<string> {
  const reachable = new Set<string>();
  const queue = [startId];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (id === targetId || reachable.has(id)) continue;
    reachable.add(id);
    for (const edge of outgoing.get(id) ?? []) {
      if (edge.kind === "rework" || reachable.has(edge.to)) continue;
      queue.push(edge.to);
    }
  }
  return reachable;
}

/*
FNXC:WorkflowLifecycleValidation 2026-06-29-11:47:
Custom workflow authors need lifecycle-specific guidance without turning every
advanced graph into a hard parse failure. Emit warnings for missing summary,
missing merge proof regions, unsafe terminal paths, misplaced optional gates, and
review gates with no failure route; engine/store merge-proof guards remain the
hard invariant that prevents unsafe done.
*/
export function analyzeWorkflowLifecycle(
  ir: WorkflowIr,
  options: AnalyzeWorkflowLifecycleOptions = {},
): WorkflowLifecycleWarning[] {
  if (options.kind === "fragment") return [];
  const warnings: WorkflowLifecycleWarning[] = [];
  const nodes = ir.nodes;
  const outgoing = buildOutgoing(ir.edges);
  const hasSummary = nodes.some(isSummaryNode);
  const mergeNodeIds = new Set(nodes.filter(isMergeNode).map((node) => node.id));
  const endNode = nodes.find((node) => node.kind === "end");
  const startId = nodes.find((node) => node.kind === "start")?.id ?? "start";

  if (!hasSummary) {
    warnings.push({
      code: "missing-completion-summary",
      message: "Full task workflows should include a completion-summary node before review, merge, or done.",
    });
  }

  if (mergeNodeIds.size === 0) {
    warnings.push({
      code: "missing-merge-region",
      message: "Full task workflows should include a merge region so done is backed by merge proof.",
    });
  }

  if (endNode && mergeNodeIds.size > 0) {
    const beforeEnd = reachableBefore(startId, endNode.id, outgoing);
    const mergeReachableBeforeEnd = [...mergeNodeIds].some((id) => beforeEnd.has(id));
    for (const edge of ir.edges) {
      if (edge.to !== endNode.id) continue;
      if (edge.condition !== undefined && edge.condition !== "success") continue;
      if (mergeNodeIds.has(edge.from)) continue;
      if (!mergeReachableBeforeEnd || beforeEnd.has(edge.from)) {
        warnings.push({
          code: "unsafe-terminal-before-merge",
          nodeId: edge.from,
          message: `Node '${edge.from}' can terminate the workflow before a merge-proof region.`,
        });
      }
    }
  }

  const executionNodeIds = new Set(nodes.filter(isExecutionNode).map((node) => node.id));
  for (const node of nodes) {
    if (node.kind !== "optional-group") continue;
    const groupName = typeof node.config?.name === "string" ? node.config.name : node.id;
    const beforeGroup = reachableBefore(
      startId,
      node.id,
      outgoing,
    );
    const isPlanReview = node.id === "plan-review" || /plan review/i.test(groupName);
    if (isPlanReview && [...executionNodeIds].some((id) => beforeGroup.has(id))) {
      warnings.push({
        code: "optional-group-after-execution",
        nodeId: node.id,
        message: "Plan Review should be ordered before parse/execution so rejected plans cannot start work.",
      });
    }

    const template = node.config?.template;
    const templateNodes = template && typeof template === "object" && Array.isArray((template as { nodes?: unknown }).nodes)
      ? (template as { nodes: WorkflowIrNode[] }).nodes
      : [];
    const hasGateStep = templateNodes.some((inner) => inner.config?.gateMode === "gate");
    const isPostMergeGate = node.config?.phase === "post-merge";
    const hasFailureRoute = (outgoing.get(node.id) ?? []).some((edge) =>
      edge.condition === "failure" || String(edge.condition ?? "").startsWith("outcome:"),
    );
    if (hasGateStep && !hasFailureRoute && !isPostMergeGate) {
      warnings.push({
        code: "review-gate-without-failure-route",
        nodeId: node.id,
        message: `Review gate '${node.id}' should declare a failure/remediation route so blocking findings cannot fall through silently.`,
      });
    }
  }

  return warnings;
}
