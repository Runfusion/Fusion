import { describe, expect, it } from "vitest";
import type { WorkflowIr } from "@fusion/core";
import { isUnplannedForExecution, resolvePreReleasePlanReviewNode } from "../hold-release.js";

function workflow(reviewColumn = "todo"): WorkflowIr {
  return {
    version: "v2",
    name: "pre-release-review",
    columns: [
      { id: "todo", name: "Todo", traits: [{ trait: "hold", config: { release: "capacity" } }] },
      { id: "in-progress", name: "In progress", traits: [{ trait: "wip" }] },
      { id: "done", name: "Done", traits: [{ trait: "complete" }] },
    ],
    nodes: [
      { id: "start", kind: "start", column: "todo" },
      { id: "plan-review", kind: "optional-group", column: reviewColumn, config: { defaultOn: true, template: { nodes: [], edges: [] } } },
      { id: "end", kind: "end", column: "done" },
    ],
    edges: [
      { from: "start", to: "plan-review" },
      { from: "plan-review", to: "end", condition: "success" },
    ],
  };
}

describe("pre-release Plan Review readiness", () => {
  it("traverses the pre-release boundary even when its optional review is disabled", () => {
    expect(resolvePreReleasePlanReviewNode(workflow())?.id).toBe("plan-review");
  });

  it("does not classify a review already inside WIP as a pre-release gate", () => {
    expect(resolvePreReleasePlanReviewNode(workflow("in-progress"))).toBeUndefined();
  });

  /*
  FNXC:PlanReview 2026-07-26-14:05:
  Plan-in-place is the whole gate: Plan Review must run in the column the card is HELD in. When the
  default workflow moved Plan Review from the wip column to the planning column, "not a wip column"
  alone made every Todo card look pre-release-gated, and the capacity sweep stopped releasing cards
  whose graph never routes through Todo (they can never produce a continuation for that boundary).
  Asserted on the store-free path so the regression cannot hide behind a continuation fixture.
  */
  it("does not gate a held card on a Plan Review that lives in an upstream column", async () => {
    const ir = workflow("triage");
    (ir as { columns: Array<{ id: string; name: string; traits: Array<{ trait: string }> }> }).columns.push({
      id: "triage",
      name: "Planning",
      traits: [{ trait: "intake" }],
    });
    // No listWorkflowWorkItemsForTask: a gated card would be held on the missing store method.
    const store = {} as any;
    await expect(isUnplannedForExecution(store, { id: "T-6", column: "todo" } as any, ir)).resolves.toBe(false);
    // ...while the same review IN the held column still gates.
    await expect(isUnplannedForExecution(store, { id: "T-7", column: "todo" } as any, workflow())).resolves.toBe(true);
  });

  it("keys release readiness to the durable capacity continuation", async () => {
    const task = { id: "T-4", column: "todo" } as any;
    const item = {
      id: "continuation",
      taskId: task.id,
      kind: "task",
      state: "held",
      waitReason: "capacity",
      sourceColumn: "todo",
    };
    const store = {
      listWorkflowWorkItemsForTask: async () => [item],
    } as any;

    await expect(isUnplannedForExecution(store, task, workflow())).resolves.toBe(false);
    item.waitReason = "planning";
    await expect(isUnplannedForExecution(store, task, workflow())).resolves.toBe(true);
  });

  it("does not filter active continuations to task kind", async () => {
    const task = { id: "T-5", column: "todo" } as any;
    const store = {
      listWorkflowWorkItemsForTask: async () => [{
        id: "non-task-continuation",
        taskId: task.id,
        kind: "workflow-step",
        state: "held",
        waitReason: "capacity",
        sourceColumn: "todo",
      }],
    } as any;

    // A capacity continuation remains graph-owned regardless of its kind.
    await expect(isUnplannedForExecution(store, task, workflow())).resolves.toBe(false);
  });
});
