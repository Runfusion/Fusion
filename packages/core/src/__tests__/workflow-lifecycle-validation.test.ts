import { describe, expect, it } from "vitest";
import { analyzeWorkflowLifecycle, type WorkflowIr } from "../index.js";

function baseIr(nodes: WorkflowIr["nodes"], edges: WorkflowIr["edges"]): WorkflowIr {
  return {
    version: "v2",
    name: "lifecycle-validation-test",
    columns: [
      { id: "todo", name: "Todo", traits: [] },
      { id: "in-progress", name: "In progress", traits: [] },
      { id: "in-review", name: "In review", traits: [] },
      { id: "done", name: "Done", traits: [] },
    ],
    nodes,
    edges,
  };
}

describe("analyzeWorkflowLifecycle", () => {
  it("warns when a full custom workflow omits summary and merge lifecycle primitives", () => {
    const warnings = analyzeWorkflowLifecycle(baseIr(
      [
        { id: "start", kind: "start", column: "todo" },
        { id: "execute", kind: "prompt", column: "in-progress", config: { seam: "execute" } },
        { id: "end", kind: "end", column: "done" },
      ],
      [
        { from: "start", to: "execute" },
        { from: "execute", to: "end", condition: "success" },
      ],
    ));

    expect(warnings.map((warning) => warning.code)).toEqual(expect.arrayContaining([
      "missing-completion-summary",
      "missing-merge-region",
    ]));
  });

  it("warns about terminal success paths that bypass the merge region", () => {
    const warnings = analyzeWorkflowLifecycle(baseIr(
      [
        { id: "start", kind: "start", column: "todo" },
        { id: "execute", kind: "prompt", column: "in-progress", config: { seam: "execute" } },
        { id: "completion-summary", kind: "prompt", column: "in-review", config: { summaryTarget: "task" } },
        { id: "merge-gate", kind: "merge-gate", column: "in-review" },
        { id: "end", kind: "end", column: "done" },
      ],
      [
        { from: "start", to: "execute" },
        { from: "execute", to: "completion-summary", condition: "success" },
        { from: "completion-summary", to: "merge-gate", condition: "success" },
        { from: "merge-gate", to: "end", condition: "success" },
        { from: "execute", to: "end", condition: "success" },
      ],
    ));

    expect(warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "unsafe-terminal-before-merge", nodeId: "execute" }),
    ]));
  });

  it("warns when Plan Review is placed after execution and blocking gates lack failure routes", () => {
    const warnings = analyzeWorkflowLifecycle(baseIr(
      [
        { id: "start", kind: "start", column: "todo" },
        { id: "execute", kind: "prompt", column: "in-progress", config: { seam: "execute" } },
        {
          id: "plan-review",
          kind: "optional-group",
          column: "in-progress",
          config: {
            name: "Plan Review",
            defaultOn: true,
            template: {
              nodes: [{ id: "plan-review-step", kind: "prompt", config: { gateMode: "gate" } }],
              edges: [],
            },
          },
        },
        { id: "completion-summary", kind: "prompt", column: "in-review", config: { summaryTarget: "task" } },
        { id: "merge-gate", kind: "merge-gate", column: "in-review" },
        { id: "end", kind: "end", column: "done" },
      ],
      [
        { from: "start", to: "execute" },
        { from: "execute", to: "plan-review", condition: "success" },
        { from: "plan-review", to: "completion-summary", condition: "success" },
        { from: "completion-summary", to: "merge-gate", condition: "success" },
        { from: "merge-gate", to: "end", condition: "success" },
      ],
    ));

    expect(warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "optional-group-after-execution", nodeId: "plan-review" }),
      expect.objectContaining({ code: "review-gate-without-failure-route", nodeId: "plan-review" }),
    ]));
  });

  it("does not warn for fragment templates", () => {
    const warnings = analyzeWorkflowLifecycle(baseIr(
      [
        { id: "start", kind: "start", column: "todo" },
        { id: "fragment-node", kind: "prompt", column: "todo", config: { prompt: "Reusable" } },
        { id: "end", kind: "end", column: "todo" },
      ],
      [
        { from: "start", to: "fragment-node" },
        { from: "fragment-node", to: "end" },
      ],
    ), { kind: "fragment" });

    expect(warnings).toEqual([]);
  });
});
