import { describe, expect, it } from "vitest";
import type { WorkflowIr } from "@fusion/core";
import { isUnplannedForExecution, resolvePreReleasePlanReviewNode } from "../execution/hold-release.js";

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
});
