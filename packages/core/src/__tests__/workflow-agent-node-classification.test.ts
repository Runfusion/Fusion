import { describe, expect, it } from "vitest";
import { parseWorkflowIr } from "../workflows/workflow-ir.js";
import { classifyWorkflowAgentNode } from "../workflows/workflow-ir-types.js";

describe("workflow agent node classification", () => {
  it("classifies only production session seams", () => {
    expect(classifyWorkflowAgentNode({ id: "plan", kind: "prompt", config: { seam: "planning" } })).toBe("triage");
    expect(classifyWorkflowAgentNode({ id: "exec", kind: "prompt", config: { seam: "execute" } })).toBe("executor");
    expect(classifyWorkflowAgentNode({ id: "review", kind: "prompt", config: { seam: "review" } })).toBe("reviewer");
    expect(classifyWorkflowAgentNode({ id: "merge", kind: "prompt", config: { seam: "merge" } })).toBe("merger");
    expect(classifyWorkflowAgentNode({ id: "reviewer-session", kind: "prompt", config: { workflowRole: "reviewer" } })).toBe("reviewer");
    expect(classifyWorkflowAgentNode({ id: "handoff", kind: "prompt", config: { seam: "review-handoff" } })).toBeUndefined();
    expect(classifyWorkflowAgentNode({ id: "hold", kind: "hold" })).toBeUndefined();
  });

  it("permits reviewer override only at reviewer session nodes", () => {
    const valid = parseWorkflowIr({ version: "v2", name: "review", columns: [{ id: "todo", name: "Todo", traits: [] }], nodes: [
      { id: "start", kind: "start", column: "todo" },
      { id: "review", kind: "prompt", column: "todo", reviewerAgentId: "agent-any", config: { workflowRole: "reviewer" } },
      { id: "end", kind: "end", column: "todo" },
    ], edges: [{ from: "start", to: "review" }, { from: "review", to: "end" }] });
    expect(valid.nodes[1].reviewerAgentId).toBe("agent-any");
    expect(() => parseWorkflowIr({ ...valid, nodes: valid.nodes.map((node) => node.id === "review" ? { ...node, config: { seam: "execute" } } : node) })).toThrow("only legal on reviewer-session nodes");
  });
});
