import { isMergeRegionNode } from "./workflow-merge-region.js";
import { resolveWorkflowOptionalSteps } from "./workflow-optional-steps.js";
import type { WorkflowIr, WorkflowIrNode } from "./workflow-ir-types.js";

/** The single synthetic implementation occurrence created for a fast task. */
export const FAST_LANE_STEP_NAME = "Fast implementation";

/** Synthetic graph result for a top-level fast-lane bypass. */
export const FAST_LANE_SKIP_VALUE = "fast-lane-skip";

/*
FNXC:FastLane 2026-08-29-02:44:
A bypassed template step-review must follow its existing approve EDGE so the
foreach instance reaches its ordinary template exit. This is routing only, not
a fabricated reviewer verdict: no review result is created for a fast task.
*/
/** Result value that follows a template step-review's `outcome:approve` edge. */
export const FAST_LANE_STEP_REVIEW_ROUTE_VALUE = "approve";

export interface FastLaneTask {
  executionMode?: string | null;
}

export interface FastLaneRoute {
  active: boolean;
  bypassedNodeIds: ReadonlySet<string>;
  bypassedPreMergeGroups: ReadonlyArray<{ nodeId: string; name: string }>;
  parseStepsNodeIds: ReadonlySet<string>;
  implementationNodeId?: string;
  implementationKind?: "foreach-steps" | "execute-seam";
  unsupportedReason?: "no-implementation-node";
}

/** The sole shared definition of whether a task requested the fast lane. */
export function isFastExecutionMode(task: FastLaneTask): boolean {
  return task.executionMode === "fast";
}

function configString(node: WorkflowIrNode, key: string): string | undefined {
  const value = node.config?.[key];
  return typeof value === "string" ? value : undefined;
}

function isTaskStepsForeach(node: WorkflowIrNode): boolean {
  return node.kind === "foreach" && node.config?.source === "task-steps";
}

/**
 * Whether a custom top-level node is the old fast-mode review/validation skip
 * candidate. Callers still decide whether the route is active and whether a
 * node was selected for bypass; this predicate preserves the custom-node
 * carve-outs as a standalone pure policy.
 */
export function isFastLaneSkippableCustomNode(
  node: WorkflowIrNode,
  opts: { optionalGroupId?: string } = {},
): boolean {
  if (node.config?.summaryTarget === "task" || node.id === "completion-summary") return false;
  if (opts.optionalGroupId) return false;
  if (node.config?.seam) return false;
  return node.kind === "prompt" || node.kind === "script" || node.kind === "gate";
}

/** Template nodes are distinct from top-level IR nodes and route independently. */
export function isFastLaneBypassedTemplateNode(node: WorkflowIrNode): boolean {
  return node.kind === "step-review";
}

function inactiveRoute(): FastLaneRoute {
  return {
    active: false,
    bypassedNodeIds: new Set(),
    bypassedPreMergeGroups: [],
    parseStepsNodeIds: new Set(),
  };
}

/**
 * Resolve the fast-lane overlay for an already-selected workflow graph.
 *
 * The resolver is deliberately descriptive: graph execution owns dispatching
 * and synthetic results, while this core policy supplies one stable route to
 * every caller that needs to know what Fast means.
 */
export function resolveFastLaneRoute(ir: WorkflowIr, task: FastLaneTask): FastLaneRoute {
  if (!isFastExecutionMode(task)) return inactiveRoute();

  const foreachNode = ir.nodes.find(isTaskStepsForeach);
  const executeNode = ir.nodes.find((node) => configString(node, "seam") === "execute");
  const implementationNode = foreachNode ?? executeNode;
  if (!implementationNode) {
    return { ...inactiveRoute(), unsupportedReason: "no-implementation-node" };
  }

  const implementationKind = foreachNode ? "foreach-steps" : "execute-seam";
  const bypassedPreMergeGroups = resolveWorkflowOptionalSteps(ir)
    .filter((step) => step.phase === "pre-merge")
    .map((step) => ({ nodeId: step.templateId, name: step.name }));
  const bypassedGroupIds = new Set(bypassedPreMergeGroups.map((group) => group.nodeId));
  const bypassedNodeIds = new Set<string>();

  for (const node of ir.nodes) {
    if (isMergeRegionNode(node) || node.id === "completion-summary" || node.config?.summaryTarget === "task") continue;
    if (configString(node, "seam") === "planning") {
      bypassedNodeIds.add(node.id);
      continue;
    }
    if (bypassedGroupIds.has(node.id)) {
      bypassedNodeIds.add(node.id);
      continue;
    }
    const workflowAction = configString(node, "workflowAction");
    const groupId = configString(node, "forWorkflowStepId");
    if (
      workflowAction === "plan-replan" ||
      workflowAction === "plan-review-no-op" ||
      workflowAction === "pre-merge-remediation" ||
      workflowAction === "review-remediation-steps" ||
      (groupId !== undefined && bypassedGroupIds.has(groupId))
    ) {
      bypassedNodeIds.add(node.id);
    }
  }

  const parseStepsNodeIds = new Set(ir.nodes.filter((node) => node.kind === "parse-steps").map((node) => node.id));
  /*
  FNXC:FastLane 2026-08-29-02:44:
  `validateForeachDominance` requires parse-steps to dominate task-steps foreach,
  and a zero-step expansion takes the success edge. Parse is retargeted rather
  than bypassed so fast execution produces its one implementation occurrence.
  */
  for (const parseNodeId of parseStepsNodeIds) {
    if (bypassedNodeIds.has(parseNodeId)) {
      throw new Error(`Fast lane cannot bypass parse-steps node '${parseNodeId}'`);
    }
  }

  return {
    active: true,
    bypassedNodeIds,
    bypassedPreMergeGroups,
    parseStepsNodeIds,
    implementationNodeId: implementationNode.id,
    implementationKind,
  };
}
