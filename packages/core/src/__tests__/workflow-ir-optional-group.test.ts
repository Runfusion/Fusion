import { describe, expect, it } from "vitest";
import { WorkflowIrError, parseWorkflowIr, serializeWorkflowIr } from "../workflows/workflow-ir.js";
import { resolveOptionalStepRevisionBudget } from "../workflows/workflow-ir-types.js";
import type { WorkflowIrEdge, WorkflowIrNode, WorkflowIrV2 } from "../workflows/workflow-ir-types.js";

/*
FNXC:WorkflowOptionalGroup 2026-06-21-11:00:
U1 validation contract for the `optional-group` container node — the single-pass,
toggle-gated subgraph that replaces the declaration-based optional-steps model.
Mirrors the loop validation suite minus loop-specific exit config.
*/

const columns: WorkflowIrV2["columns"] = [{ id: "work", name: "Work", traits: [] }];

function groupTemplate(): { nodes: WorkflowIrNode[]; edges: WorkflowIrEdge[] } {
  return {
    nodes: [
      { id: "verify", kind: "prompt", config: { prompt: "verify in browser" } },
      { id: "report", kind: "prompt", config: { prompt: "report" } },
    ],
    edges: [{ from: "verify", to: "report" }],
  };
}

function groupIr(config: Record<string, unknown> = {}): WorkflowIrV2 {
  return {
    version: "v2",
    name: "optional-group-test",
    columns,
    nodes: [
      { id: "start", kind: "start" },
      {
        id: "browser-verification",
        kind: "optional-group",
        config: {
          name: "Browser Verification",
          defaultOn: false,
          template: groupTemplate(),
          ...config,
        },
      },
      { id: "end", kind: "end" },
    ],
    edges: [
      { from: "start", to: "browser-verification" },
      { from: "browser-verification", to: "end" },
    ],
  };
}

describe("optional-group validation", () => {
  it("parses and round-trips a valid optional-group node", () => {
    const parsed = parseWorkflowIr(groupIr()) as WorkflowIrV2;
    const group = parsed.nodes.find((n) => n.id === "browser-verification");

    expect(group?.kind).toBe("optional-group");
    expect(parseWorkflowIr(serializeWorkflowIr(parsed))).toEqual(parsed);
  });

  it("does not require defaultOn (defaults to off via the resolver)", () => {
    expect(() => parseWorkflowIr(groupIr({ defaultOn: undefined }))).not.toThrow();
  });

  it("rejects a non-boolean defaultOn", () => {
    expect(() => parseWorkflowIr(groupIr({ defaultOn: "yes" as unknown as boolean }))).toThrow(
      /defaultOn must be a boolean/,
    );
  });

  it("accepts and round-trips per-step maxRevisions budgets", () => {
    for (const maxRevisions of [2, "unbounded"] as const) {
      const parsed = parseWorkflowIr(groupIr({ maxRevisions })) as WorkflowIrV2;
      const group = parsed.nodes.find((n) => n.id === "browser-verification");
      expect(group?.config?.maxRevisions).toBe(maxRevisions);
      expect(parseWorkflowIr(serializeWorkflowIr(parsed))).toEqual(parsed);
    }
  });

  it("rejects invalid per-step maxRevisions budgets", () => {
    for (const maxRevisions of [-1, 1.5, "sometimes"] as const) {
      expect(() => parseWorkflowIr(groupIr({ maxRevisions }))).toThrow(WorkflowIrError);
      expect(() => parseWorkflowIr(groupIr({ maxRevisions }))).toThrow(
        /maxRevisions must be a non-negative integer or "unbounded"/,
      );
    }
  });

  it("resolves optional-step revision budgets from numeric, unbounded, and fallback states", () => {
    expect(resolveOptionalStepRevisionBudget(2, 3)).toEqual({ unbounded: false, max: 2 });
    expect(resolveOptionalStepRevisionBudget(0, 3)).toEqual({ unbounded: false, max: 0 });
    expect(resolveOptionalStepRevisionBudget("unbounded", 3)).toEqual({ unbounded: true, max: Number.POSITIVE_INFINITY });
    expect(resolveOptionalStepRevisionBudget(undefined, 3)).toEqual({ unbounded: false, max: 3 });
    expect(resolveOptionalStepRevisionBudget("sometimes", 3)).toEqual({ unbounded: false, max: 3 });
  });

  it("rejects an empty template", () => {
    expect(() => parseWorkflowIr(groupIr({ template: { nodes: [], edges: [] } }))).toThrow(/non-empty/);
  });

  it("rejects a missing template", () => {
    expect(() => parseWorkflowIr(groupIr({ template: undefined }))).toThrow(
      /must declare a template/,
    );
  });

  it("rejects duplicate template node ids", () => {
    const template = groupTemplate();
    template.nodes.push({ id: "verify", kind: "script" });
    expect(() => parseWorkflowIr(groupIr({ template }))).toThrow(/duplicate node ids/);
  });

  it("rejects template edges that leave the template", () => {
    const template = groupTemplate();
    template.edges.push({ from: "report", to: "end" });
    expect(() => parseWorkflowIr(groupIr({ template }))).toThrow(/references a node outside/);
  });

  it("rejects rework edges inside the template (single-pass guarantee)", () => {
    const template = groupTemplate();
    template.edges.push({ from: "report", to: "verify", kind: "rework" });
    expect(() => parseWorkflowIr(groupIr({ template }))).toThrow(/may not contain rework edges/);
  });

  it("rejects failure-condition edges inside the template (single-pass bails before routing them)", () => {
    const template = groupTemplate();
    // A parallel failure edge that the single-pass walk would silently never take.
    template.edges.push({ from: "verify", to: "report", condition: "failure" });
    expect(() => parseWorkflowIr(groupIr({ template }))).toThrow(/may not contain failure-condition edges/);
  });

  it("rejects nested loop/foreach/optional-group regions", () => {
    const template = groupTemplate();
    template.nodes.push({
      id: "nested",
      kind: "optional-group",
      config: { template: groupTemplate() },
    });
    template.edges.push({ from: "report", to: "nested" });
    expect(() => parseWorkflowIr(groupIr({ template }))).toThrow(
      /nested loop\/foreach\/optional-group/,
    );
  });

  it("rejects more than one entry node", () => {
    const template: ReturnType<typeof groupTemplate> = {
      nodes: [
        { id: "a", kind: "prompt", config: { prompt: "a" } },
        { id: "b", kind: "prompt", config: { prompt: "b" } },
        { id: "join", kind: "prompt", config: { prompt: "join" } },
      ],
      // a and b both have no incoming edge → two entries.
      edges: [
        { from: "a", to: "join" },
        { from: "b", to: "join" },
      ],
    };
    expect(() => parseWorkflowIr(groupIr({ template }))).toThrow(/exactly one entry node/);
  });

  it("rejects a template node id colliding with a top-level node id", () => {
    const template = groupTemplate();
    template.nodes[0] = { id: "start", kind: "prompt", config: { prompt: "collide" } };
    template.edges = [{ from: "start", to: "report" }];
    expect(() => parseWorkflowIr(groupIr({ template }))).toThrow(/collides with a top-level node id/);
  });

  it("leaves graphs without optional-group nodes byte-identical", () => {
    const ir: WorkflowIrV2 = {
      version: "v2",
      name: "plain",
      columns,
      nodes: [
        { id: "start", kind: "start" },
        { id: "end", kind: "end" },
      ],
      edges: [{ from: "start", to: "end" }],
    };
    const parsed = parseWorkflowIr(ir);
    expect(parseWorkflowIr(serializeWorkflowIr(parsed))).toEqual(parsed);
  });
});
