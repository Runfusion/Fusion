import { describe, it, expect } from "vitest";
import type { Node as FlowNode, Edge as FlowEdge } from "@xyflow/react";
import type { WorkflowFlowNodeData } from "../nodes/WorkflowNodeTypes";
import {
  LIFECYCLE_AUTOFIXABLE_CODES,
  lifecycleFixNodeSpec,
  lifecycleFixTargetEdgeId,
  applyLifecycleWarningFix,
  applyAllLifecycleWarningFixes,
} from "../workflow-lifecycle-autofix";

/*
FNXC:WorkflowLifecycleAutofix 2026-07-12-13:00:
Unit coverage for the deterministic lifecycle fixes: canonical node specs,
wiring-point selection (summary lands upstream of an existing merge region),
and the fix-all composition (merge first, then summary before it).
*/

type N = FlowNode<WorkflowFlowNodeData>;

function node(id: string, kind: WorkflowFlowNodeData["kind"], x = 0, y = 0, extra: Partial<N> = {}): N {
  return { id, type: kind, position: { x, y }, data: { kind, label: id, config: {} }, ...extra };
}

function edge(id: string, source: string, target: string, condition = "success"): FlowEdge {
  return { id, source, target, data: { condition } };
}

describe("lifecycleFixNodeSpec", () => {
  it("produces the canonical completion-summary config", () => {
    const spec = lifecycleFixNodeSpec("missing-completion-summary")!;
    expect(spec.kind).toBe("prompt");
    expect(spec.presetConfig?.summaryTarget).toBe("task");
    expect(spec.presetConfig?.toolMode).toBe("readonly");
    expect(typeof spec.presetConfig?.prompt).toBe("string");
  });

  it("produces a merge boundary for missing-merge-region and null otherwise", () => {
    expect(lifecycleFixNodeSpec("missing-merge-region")?.kind).toBe("merge");
    expect(lifecycleFixNodeSpec("unsafe-terminal-before-merge")).toBeNull();
    expect(LIFECYCLE_AUTOFIXABLE_CODES.has("optional-group-after-execution")).toBe(false);
  });
});

describe("lifecycleFixTargetEdgeId", () => {
  it("targets the edge into an existing merge node for the summary fix", () => {
    const nodes = [node("start", "start"), node("a", "prompt", 300, 0), node("m", "merge", 600, 0), node("end", "end", 900, 0)];
    const edges = [edge("e1", "start", "a"), edge("e2", "a", "m"), edge("e3", "m", "end")];
    expect(lifecycleFixTargetEdgeId(nodes, edges, "missing-completion-summary")).toBe("e2");
    expect(lifecycleFixTargetEdgeId(nodes, edges, "missing-merge-region")).toBe("e3");
  });

  it("falls back to the edge into end when no merge node exists", () => {
    const nodes = [node("start", "start"), node("end", "end", 360, 0)];
    const edges = [edge("e1", "start", "end")];
    expect(lifecycleFixTargetEdgeId(nodes, edges, "missing-completion-summary")).toBe("e1");
  });
});

describe("applyAllLifecycleWarningFixes", () => {
  it("wires start→summary→merge→end on a fresh graph", () => {
    const nodes = [node("start", "start"), node("end", "end", 360, 0)];
    const edges = [edge("e1", "start", "end")];
    const result = applyAllLifecycleWarningFixes(nodes, edges, [
      "missing-completion-summary",
      "missing-merge-region",
    ]);
    expect(result).not.toBeNull();
    const summary = result!.nodes.find((n) => n.data.config?.summaryTarget === "task");
    const merge = result!.nodes.find((n) => n.data.kind === "merge");
    expect(summary).toBeDefined();
    expect(merge).toBeDefined();
    const has = (from: string, to: string) => result!.edges.some((e) => e.source === from && e.target === to);
    expect(has("start", summary!.id)).toBe(true);
    expect(has(summary!.id, merge!.id)).toBe(true);
    expect(has(merge!.id, "end")).toBe(true);
    expect(has("start", "end")).toBe(false);
  });

  it("returns null when no wiring point exists and no fix applies", () => {
    // Two edges into end → ambiguous; no merge node to anchor on.
    const nodes = [node("start", "start"), node("a", "prompt", 300, 0), node("end", "end", 900, 0)];
    const edges = [edge("e1", "start", "end"), edge("e2", "a", "end")];
    expect(applyAllLifecycleWarningFixes(nodes, edges, ["missing-merge-region"])).toBeNull();
  });
});

describe("applyLifecycleWarningFix", () => {
  it("returns null for non-fixable codes", () => {
    const nodes = [node("start", "start"), node("end", "end", 360, 0)];
    expect(applyLifecycleWarningFix(nodes, [edge("e1", "start", "end")], "review-gate-without-failure-route")).toBeNull();
  });
});
