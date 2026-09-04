import { describe, expect, it } from "vitest";
import { BUILTIN_CODING_IDEAS_WORKFLOW_IR } from "../workflows/builtin-coding-ideas-workflow-ir.js";
import { BUILTIN_STEPWISE_CODING_WORKFLOW_IR } from "../workflows/builtin-stepwise-coding-workflow-ir.js";
import { BUILTIN_WORKFLOWS } from "../workflows/builtin-workflows.js";
import {
  FAST_LANE_STEP_REVIEW_ROUTE_VALUE,
  isFastExecutionMode,
  isFastLaneBypassedTemplateNode,
  isFastLaneSkippableCustomNode,
  resolveFastLaneRoute,
} from "../workflows/workflow-fast-lane.js";
import type { WorkflowIr } from "../workflows/workflow-ir-types.js";

describe("workflow fast-lane route", () => {
  it("routes the real Coding Ideas graph around planning and pre-merge review without bypassing parse", () => {
    const route = resolveFastLaneRoute(BUILTIN_CODING_IDEAS_WORKFLOW_IR, { executionMode: "fast" });

    expect([...route.bypassedNodeIds].sort()).toEqual([
      "code-review",
      "code-review-remediation",
      "plan",
      "plan-replan",
      "plan-review",
      "plan-review-no-op",
    ]);
    expect(route.bypassedPreMergeGroups.map((group) => group.nodeId).sort()).toEqual(["code-review", "plan-review"]);
    expect(route.parseStepsNodeIds).toEqual(new Set(["parse"]));
    expect(route.bypassedNodeIds.has("parse")).toBe(false);
    expect([...route.parseStepsNodeIds].every((id) => !route.bypassedNodeIds.has(id))).toBe(true);
    expect(route.implementationNodeId).toBe("steps");
    expect(route.implementationKind).toBe("foreach-steps");
    for (const nodeId of ["completion-summary", "merge-gate", "merge-attempt", "end"]) {
      expect(route.bypassedNodeIds.has(nodeId)).toBe(false);
    }
  });

  it("uses the execute seam in the real Quick fix graph", () => {
    const quickFix = BUILTIN_WORKFLOWS.find((workflow) => workflow.id === "builtin:quick-fix");
    expect(quickFix).toBeDefined();

    const route = resolveFastLaneRoute(quickFix!.ir, { executionMode: "fast" });
    expect(route.implementationNodeId).toBe("execute");
    expect(route.implementationKind).toBe("execute-seam");
  });

  it("bypasses only per-step review inside the real stepwise template", () => {
    const route = resolveFastLaneRoute(BUILTIN_STEPWISE_CODING_WORKFLOW_IR, { executionMode: "fast" });
    const steps = BUILTIN_STEPWISE_CODING_WORKFLOW_IR.nodes.find((node) => node.id === "steps");
    const templateNodes = (steps?.config?.template as { nodes: Array<{ id: string; kind: "prompt" | "gate" | "step-review" }> }).nodes;

    expect(route.implementationKind).toBe("foreach-steps");
    expect(isFastLaneBypassedTemplateNode(templateNodes.find((node) => node.id === "step-review")!)).toBe(true);
    expect(isFastLaneBypassedTemplateNode(templateNodes.find((node) => node.id === "step-execute")!)).toBe(false);
    expect(isFastLaneBypassedTemplateNode(templateNodes.find((node) => node.id === "step-done")!)).toBe(false);
    expect(FAST_LANE_STEP_REVIEW_ROUTE_VALUE).toBe("approve");
  });

  it("leaves unsupported fast graphs on the standard route", () => {
    const noImplementation: WorkflowIr = {
      version: "v2",
      name: "no-implementation",
      columns: [],
      nodes: [
        { id: "start", kind: "start" },
        { id: "plan", kind: "prompt", config: { seam: "planning" } },
        { id: "end", kind: "end" },
      ],
      edges: [
        { from: "start", to: "plan", condition: "success" },
        { from: "plan", to: "end", condition: "success" },
      ],
    };

    const route = resolveFastLaneRoute(noImplementation, { executionMode: "fast" });
    expect(route.active).toBe(false);
    expect(route.unsupportedReason).toBe("no-implementation-node");
    expect(route.bypassedNodeIds).toEqual(new Set());
  });

  it("is inactive for standard tasks", () => {
    for (const executionMode of [undefined, null, "standard"]) {
      const route = resolveFastLaneRoute(BUILTIN_CODING_IDEAS_WORKFLOW_IR, { executionMode });
      expect(route.active).toBe(false);
      expect(route.bypassedNodeIds).toEqual(new Set());
      expect(route.parseStepsNodeIds).toEqual(new Set());
      expect(isFastExecutionMode({ executionMode })).toBe(false);
    }
  });

  it("preserves the custom-node carve-outs when classifying Fast skips", () => {
    expect(isFastLaneSkippableCustomNode({ id: "check", kind: "prompt" })).toBe(true);
    expect(isFastLaneSkippableCustomNode({ id: "completion-summary", kind: "prompt" })).toBe(false);
    expect(isFastLaneSkippableCustomNode({ id: "summary", kind: "prompt", config: { summaryTarget: "task" } })).toBe(false);
    expect(isFastLaneSkippableCustomNode({ id: "inside-group", kind: "gate" }, { optionalGroupId: "code-review" })).toBe(false);
    expect(isFastLaneSkippableCustomNode({ id: "execution", kind: "prompt", config: { seam: "execute" } })).toBe(false);
  });

  it("never bypasses a post-merge optional group", () => {
    const postMerge = BUILTIN_STEPWISE_CODING_WORKFLOW_IR.nodes.find((node) => node.id === "post-merge-verification");
    expect(postMerge).toBeDefined();

    const route = resolveFastLaneRoute(BUILTIN_STEPWISE_CODING_WORKFLOW_IR, { executionMode: "fast" });
    expect(route.bypassedNodeIds.has(postMerge!.id)).toBe(false);
  });
});
