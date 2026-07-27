import { describe, expect, it } from "vitest";
import {
  BUILTIN_CODING_WORKFLOW_IR,
  BUILTIN_STEPWISE_FINAL_REVIEW_CODING_WORKFLOW_IR,
  getBuiltinWorkflow,
  parseWorkflowIr,
  type WorkflowIr,
} from "@fusion/core";
import { resolveColumnResumeNode } from "../workflow-graph-executor.js";

/*
FNXC:WorkflowGraphEntry 2026-07-26-17:10:
THE GRAPH ENTRY CONTRACT. A run with no durable continuation resumes at the card's OWN column instead
of replaying the pipeline from `start`. Before this, every continuation-less run (self-healing graph
re-entry, a fresh dispatch, an operator drag into a processing column) re-entered at the first node of
the FIRST column and dragged the card backward through columns it had already left — aborting its live
session via `abort-on-exit`, and stranding it in any pre-wip column with no releaser. That backward
drag is the reason planning nodes had to live in the implementation column.

These assert the INVARIANT across every lifecycle position a card can hold, not just the plan-in-place
case that motivated it: behind (resume forward), at, and past each column, on the real built-in IRs.
*/

const codingIr = parseWorkflowIr(getBuiltinWorkflow("builtin:coding")!.ir as never);

describe("workflow graph entry contract — resume at the card's own column", () => {
  it("enters the planning prologue only for a card still in the planning lane", () => {
    // Intake: nothing is behind it, so the run starts at the graph's own start node.
    expect(resolveColumnResumeNode(codingIr, "triage")?.id).toBe("start");
    // Planning lane: the specification phase is exactly what this card still needs.
    expect(resolveColumnResumeNode(codingIr, "todo")?.id).toBe("plan");
  });

  it("never re-plans a card that already reached implementation", () => {
    const resumed = resolveColumnResumeNode(codingIr, "in-progress");
    expect(resumed?.id).toBe("parse");
    expect(resumed?.column).toBe("in-progress");
    // The regression this exists to prevent: resuming at a planning node would move the card
    // backward out of the wip column and abort its session.
    expect(["plan", "plan-review", "plan-replan"]).not.toContain(resumed?.id);
  });

  it("re-enters a review-column card at the FIRST review node so no gate is skipped", () => {
    const resumed = resolveColumnResumeNode(codingIr, "in-review");
    expect(resumed?.column).toBe("in-review");
    // Entering at the merge region instead would silently skip Code Review.
    expect(resumed?.id).toBe("browser-verification");
  });

  it("resolves the same way for the other built-in coding IRs", () => {
    expect(resolveColumnResumeNode(BUILTIN_STEPWISE_FINAL_REVIEW_CODING_WORKFLOW_IR, "in-progress")?.id).toBe("parse");
    // The base IR names its planning seam `planning`; the contract is about columns, not ids.
    expect(resolveColumnResumeNode(BUILTIN_CODING_WORKFLOW_IR, "todo")?.id).toBe("planning");
    expect(resolveColumnResumeNode(BUILTIN_CODING_WORKFLOW_IR, "in-progress")?.id).toBe("execute");
  });

  it("skips forward when the card rests in a column the pipeline has no node for", () => {
    const ir = parseWorkflowIr({
      version: "v2",
      name: "gap-column",
      columns: [
        { id: "intake", name: "Intake", traits: [{ trait: "intake" }] },
        // No node declares `staging` — a card parked here must resume at the next node forward.
        { id: "staging", name: "Staging", traits: [{ trait: "hold", config: { release: "capacity" } }] },
        { id: "work", name: "Work", traits: [{ trait: "wip" }] },
        { id: "done", name: "Done", traits: [{ trait: "complete" }] },
      ],
      nodes: [
        { id: "start", kind: "start", column: "intake" },
        { id: "build", kind: "prompt", column: "work" },
        { id: "end", kind: "end", column: "done" },
      ],
      edges: [
        { from: "start", to: "build", condition: "success" },
        { from: "build", to: "end", condition: "success" },
      ],
    } as WorkflowIr);
    expect(resolveColumnResumeNode(ir, "staging")?.id).toBe("build");
  });

  it("never resumes at a remediation node reached only by a failure or rework edge", () => {
    // `plan-replan` sits in the planning lane and is reachable only from a plan-review FAILURE,
    // so a planning-lane card must still resume at `plan` — remediation is not an entry point.
    expect(resolveColumnResumeNode(codingIr, "todo")?.id).not.toBe("plan-replan");
    // Same shape in the implementation column, where the code-review remediation node lives.
    expect(resolveColumnResumeNode(codingIr, "in-progress")?.id).not.toBe("code-review-remediation");
  });

  it("falls back to the start node for an unknown column or a v1 IR", () => {
    expect(resolveColumnResumeNode(codingIr, "not-a-column")).toBeUndefined();
    expect(resolveColumnResumeNode(codingIr, undefined)).toBeUndefined();
    expect(resolveColumnResumeNode({ version: "v1", name: "legacy", nodes: [], edges: [] } as never, "todo"))
      .toBeUndefined();
  });
});
