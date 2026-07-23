// @vitest-environment node
//
// column-agent plan U1 — IR schema, validation, and parity registration for the
// per-column permanent-agent binding (`WorkflowIrColumn.agent`).
//
// Proves:
//   - a column `agent` binding parses + round-trips; absent field parses as today.
//   - typed validation errors for empty agentId / missing mode / unknown mode.
//   - v1 upgrade synthesizes columns with NO `agent` field (absent, not null).
//   - a template-subgraph node with a dangling `column` is a typed error.
//   - the default workflow IR round-trips byte-identically; a graph carrying a
//     column agent is flagged non-default (forces v2 — KTD-1/R9).
//   - a removed binding omits the `agent` key entirely on serialization.

import { describe, expect, it } from "vitest";
import {
  parseWorkflowIr,
  serializeWorkflowIr,
  downgradeIrToV1IfPure,
  WorkflowIrError,
} from "../workflows/workflow-ir.js";
import { BUILTIN_CODING_WORKFLOW_IR } from "../workflows/builtin-coding-workflow-ir.js";
import type {
  WorkflowColumnAgent,
  WorkflowIrEdge,
  WorkflowIrNode,
  WorkflowIrV1,
  WorkflowIrV2,
} from "../workflows/workflow-ir-types.js";

const baseColumns: WorkflowIrV2["columns"] = [
  { id: "todo", name: "todo", traits: [] },
  { id: "review", name: "review", traits: [] },
];

function v2(
  columns: WorkflowIrV2["columns"],
  nodes: WorkflowIrNode[],
  edges: WorkflowIrEdge[],
  extra: Partial<WorkflowIrV2> = {},
): WorkflowIrV2 {
  return { version: "v2", name: "test", columns, nodes, edges, ...extra };
}

/** start → work → end, work in the second column. */
function simpleGraph(reviewAgent?: WorkflowColumnAgent): WorkflowIrV2 {
  const columns: WorkflowIrV2["columns"] = [
    { id: "todo", name: "todo", traits: [] },
    { id: "review", name: "review", traits: [], ...(reviewAgent ? { agent: reviewAgent } : {}) },
  ];
  return v2(
    columns,
    [
      { id: "start", kind: "start", column: "todo" },
      { id: "work", kind: "prompt", column: "review", config: { prompt: "do" } },
      { id: "end", kind: "end", column: "review" },
    ],
    [
      { from: "start", to: "work" },
      { from: "work", to: "end" },
    ],
  );
}

describe("column-agent IR schema + validation (U1)", () => {
  it("parses and round-trips a column with a defer agent binding", () => {
    const ir = simpleGraph({ agentId: "agent-001", mode: "defer" });
    const parsed = parseWorkflowIr(serializeWorkflowIr(ir)) as WorkflowIrV2;
    const col = parsed.columns.find((c) => c.id === "review")!;
    expect(col.agent).toEqual({ agentId: "agent-001", mode: "defer" });
  });

  it("parses identically to today when no agent field is present", () => {
    const ir = simpleGraph();
    const parsed = parseWorkflowIr(serializeWorkflowIr(ir)) as WorkflowIrV2;
    const col = parsed.columns.find((c) => c.id === "review")!;
    expect("agent" in col).toBe(false);
  });

  it("rejects an empty agentId (typed error naming the column)", () => {
    const ir = simpleGraph({ agentId: "", mode: "defer" });
    expect(() => parseWorkflowIr(ir)).toThrow(WorkflowIrError);
    expect(() => parseWorkflowIr(ir)).toThrow(/column 'review'.*non-empty agentId/);
  });

  it("rejects a missing mode", () => {
    const ir = simpleGraph({ agentId: "agent-001" } as unknown as WorkflowColumnAgent);
    expect(() => parseWorkflowIr(ir)).toThrow(/column 'review'.*mode must be/);
  });

  it("rejects an unknown mode value", () => {
    const ir = simpleGraph({ agentId: "agent-001", mode: "always" as "defer" });
    expect(() => parseWorkflowIr(ir)).toThrow(/column 'review'.*mode must be/);
  });

  it("v1 upgrade synthesizes columns with no agent field (absent, not null)", () => {
    const v1: WorkflowIrV1 = {
      version: "v1",
      name: "legacy",
      nodes: [
        { id: "start", kind: "start" },
        { id: "p", kind: "prompt", config: { prompt: "hi" } },
        { id: "end", kind: "end" },
      ],
      edges: [
        { from: "start", to: "p" },
        { from: "p", to: "end" },
      ],
    };
    const upgraded = parseWorkflowIr(v1) as WorkflowIrV2;
    for (const col of upgraded.columns) {
      expect("agent" in col).toBe(false);
    }
    // And serialization carries no `agent` key at all.
    expect(serializeWorkflowIr(upgraded)).not.toContain('"agent"');
  });

  it("rejects a foreach template node whose column does not resolve (typed, names node)", () => {
    const ir = v2(
      baseColumns,
      [
        { id: "start", kind: "start" },
        {
          id: "ps",
          kind: "parse-steps",
          config: { artifact: "PROMPT.md", parser: "step-headings" },
        },
        {
          id: "fe",
          kind: "foreach",
          config: {
            source: "task-steps",
            template: {
              nodes: [
                // Dangling column reference on a template node.
                { id: "se", kind: "prompt", column: "nope", config: { seam: "step-execute" } },
                { id: "rev", kind: "step-review", config: { type: "code" } },
                { id: "exit", kind: "prompt" },
              ],
              edges: [
                { from: "se", to: "rev" },
                { from: "rev", to: "exit", condition: "outcome:approve" },
                { from: "rev", to: "se", condition: "outcome:revise", kind: "rework" },
              ],
            },
          },
        },
        { id: "end", kind: "end" },
      ],
      [
        { from: "start", to: "ps" },
        { from: "ps", to: "fe" },
        { from: "fe", to: "end" },
      ],
    );
    expect(() => parseWorkflowIr(ir)).toThrow(/node 'se' references undefined column 'nope'/);
  });

  it("accepts a foreach template node whose column resolves to a declared column", () => {
    const ir = v2(
      baseColumns,
      [
        { id: "start", kind: "start" },
        {
          id: "ps",
          kind: "parse-steps",
          config: { artifact: "PROMPT.md", parser: "step-headings" },
        },
        {
          id: "fe",
          kind: "foreach",
          column: "review",
          config: {
            source: "task-steps",
            template: {
              nodes: [
                { id: "se", kind: "prompt", column: "todo", config: { seam: "step-execute" } },
                { id: "rev", kind: "step-review", config: { type: "code" } },
                { id: "exit", kind: "prompt" },
              ],
              edges: [
                { from: "se", to: "rev" },
                { from: "rev", to: "exit", condition: "outcome:approve" },
                { from: "rev", to: "se", condition: "outcome:revise", kind: "rework" },
              ],
            },
          },
        },
        { id: "end", kind: "end" },
      ],
      [
        { from: "start", to: "ps" },
        { from: "ps", to: "fe" },
        { from: "fe", to: "end" },
      ],
    );
    expect(() => parseWorkflowIr(ir)).not.toThrow();
  });
});

describe("column-agent parity registration (U1, R9)", () => {
  it("default workflow IR round-trips byte-identically", () => {
    const serialized = serializeWorkflowIr(BUILTIN_CODING_WORKFLOW_IR);
    const reparsed = parseWorkflowIr(serialized);
    expect(serializeWorkflowIr(reparsed)).toBe(serialized);
  });

  it("a graph carrying a column agent is flagged non-default (forces v2)", () => {
    // A pure default-shaped graph downgrades to v1; adding an agent binding must
    // keep it v2 (the v2-only-feature gate registers the field).
    const bound = simpleGraph({ agentId: "agent-001", mode: "override" });
    expect(downgradeIrToV1IfPure(bound).version).toBe("v2");
  });

  it("serialization of a column whose binding was removed omits the key entirely", () => {
    const bound = simpleGraph({ agentId: "agent-001", mode: "defer" });
    const col = bound.columns.find((c) => c.id === "review")!;
    delete col.agent;
    const serialized = serializeWorkflowIr(bound);
    expect(serialized).not.toContain('"agent"');
    const reparsed = parseWorkflowIr(serialized) as WorkflowIrV2;
    expect("agent" in reparsed.columns.find((c) => c.id === "review")!).toBe(false);
  });
});
