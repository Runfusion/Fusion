import { describe, it, expect } from "vitest";

import { BUILTIN_CODING_WORKFLOW_IR } from "../builtin-coding-workflow-ir.js";
import { BUILTIN_STEPWISE_CODING_WORKFLOW_IR } from "../builtin-stepwise-coding-workflow-ir.js";
import {
  compileWorkflowToSteps,
  validateLinearity,
  WorkflowCompileError,
  WORKFLOW_INTERPRETER_DEFERRED_SUFFIX,
} from "../workflow-compiler.js";
import { serializeWorkflowIr, parseWorkflowIr } from "../workflow-ir.js";
import type { WorkflowIr } from "../workflow-ir-types.js";

/** Linear graph: start → (user nodes) → execute → review → merge → (user nodes) → end. */
function graph(
  preMerge: WorkflowIr["nodes"],
  postMerge: WorkflowIr["nodes"] = [],
  { withSeams = true }: { withSeams?: boolean } = {},
): WorkflowIr {
  const seamNodes: WorkflowIr["nodes"] = withSeams
    ? [
        { id: "execute", kind: "prompt", config: { seam: "execute" } },
        { id: "review", kind: "prompt", config: { seam: "review" } },
        { id: "merge", kind: "prompt", config: { seam: "merge" } },
      ]
    : [];

  const ordered = [
    { id: "start", kind: "start" as const },
    ...preMerge,
    ...seamNodes,
    ...postMerge,
    { id: "end", kind: "end" as const },
  ];

  const edges: WorkflowIr["edges"] = [];
  for (let i = 0; i < ordered.length - 1; i += 1) {
    edges.push({ from: ordered[i].id, to: ordered[i + 1].id, condition: "success" });
  }
  // Canonical seam failure edges to end.
  if (withSeams) {
    for (const seam of ["execute", "review", "merge"]) {
      edges.push({ from: seam, to: "end", condition: "failure" });
    }
  }

  return { version: "v1", name: "test", nodes: ordered, edges };
}

describe("compileWorkflowToSteps (U2)", () => {
  it("compiles a linear pre-merge gate + prompt in authored order", () => {
    const ir = graph([
      { id: "lint", kind: "gate", config: { name: "Lint", scriptName: "lint" } },
      { id: "spec", kind: "prompt", config: { name: "Spec check", prompt: "Check the spec" } },
    ]);
    const steps = compileWorkflowToSteps(ir);
    expect(steps).toHaveLength(2);
    expect(steps[0].name).toBe("Lint");
    expect(steps[0].phase).toBe("pre-merge");
    expect(steps[0].mode).toBe("script");
    expect(steps[0].gateMode).toBe("gate");
    expect(steps[1].name).toBe("Spec check");
    expect(steps[1].mode).toBe("prompt");
    expect(steps[1].gateMode).toBe("advisory");
  });

  it("partitions nodes after the merge seam into post-merge", () => {
    const ir = graph(
      [{ id: "pre", kind: "prompt", config: { prompt: "before" } }],
      [{ id: "post", kind: "script", config: { scriptName: "notify" } }],
    );
    const steps = compileWorkflowToSteps(ir);
    expect(steps.map((s) => s.phase)).toEqual(["pre-merge", "post-merge"]);
    expect(steps[1].mode).toBe("script");
    expect(steps[1].scriptName).toBe("notify");
  });

  it("does not emit the execute/review/merge seams as steps", () => {
    const ir = graph([{ id: "only", kind: "prompt", config: { prompt: "x" } }]);
    const steps = compileWorkflowToSteps(ir);
    expect(steps).toHaveLength(1);
    expect(steps.every((s) => s.name !== "execute" && s.name !== "review" && s.name !== "merge")).toBe(true);
  });

  it("treats a gate node as gateMode=gate regardless of mode", () => {
    const ir = graph([{ id: "g", kind: "gate", config: { prompt: "block?" } }]);
    const steps = compileWorkflowToSteps(ir);
    expect(steps[0].gateMode).toBe("gate");
    expect(steps[0].mode).toBe("prompt");
  });

  it("carries prompt-node model overrides into the step", () => {
    const ir = graph([
      {
        id: "p",
        kind: "prompt",
        config: { prompt: "x", modelProvider: "anthropic", modelId: "claude-sonnet-4-5" },
      },
    ]);
    const [step] = compileWorkflowToSteps(ir);
    expect(step.modelProvider).toBe("anthropic");
    expect(step.modelId).toBe("claude-sonnet-4-5");
  });

  it("rejects a graph with branching (fan-out beyond success/failure)", () => {
    const ir: WorkflowIr = {
      version: "v1",
      name: "branchy",
      nodes: [
        { id: "start", kind: "start" },
        { id: "a", kind: "prompt", config: { prompt: "a" } },
        { id: "b", kind: "prompt", config: { prompt: "b" } },
        { id: "end", kind: "end" },
      ],
      edges: [
        { from: "start", to: "a", condition: "success" },
        { from: "a", to: "b", condition: "success" },
        { from: "a", to: "end", condition: "success" }, // illegal second success branch
        { from: "b", to: "end", condition: "success" },
      ],
    };
    const err = validateLinearity(ir);
    expect(err).toBeInstanceOf(WorkflowCompileError);
    expect(err?.message).toContain(WORKFLOW_INTERPRETER_DEFERRED_SUFFIX);
    expect(() => compileWorkflowToSteps(ir)).toThrow(WorkflowCompileError);
    expect(() => compileWorkflowToSteps(ir)).toThrow(/interpreter \(deferred\)/i);
  });

  it("defers both builtin coding and stepwise to the interpreter (U6: coding now carries an optional-group)", () => {
    // U6: builtin:coding gained the `browser-verification` optional-group on its
    // pre-merge path — a branching, single-pass container the linear WorkflowStep
    // runner cannot lower. Like stepwise, coding is now interpreter-deferred.
    const codingErr = validateLinearity(BUILTIN_CODING_WORKFLOW_IR);
    expect(codingErr).toBeInstanceOf(WorkflowCompileError);
    expect(codingErr?.message).toContain(WORKFLOW_INTERPRETER_DEFERRED_SUFFIX);

    const stepwiseErr = validateLinearity(BUILTIN_STEPWISE_CODING_WORKFLOW_IR);
    expect(stepwiseErr).toBeInstanceOf(WorkflowCompileError);
    expect(stepwiseErr?.message).toContain(WORKFLOW_INTERPRETER_DEFERRED_SUFFIX);
  });

  it("defers compiling the builtin coding workflow to the interpreter (U6)", () => {
    // The browser-verification optional-group makes the graph non-linear, so
    // compileWorkflowToSteps throws the interpreter-deferred error rather than
    // producing a (previously empty) linear pre-merge step list.
    expect(() => compileWorkflowToSteps(BUILTIN_CODING_WORKFLOW_IR)).toThrow(WorkflowCompileError);
    expect(() => compileWorkflowToSteps(BUILTIN_CODING_WORKFLOW_IR)).toThrow(/interpreter \(deferred\)/i);
  });

  it("compiles a workflow whose post-review merge region branches into primitives (FN-6035)", () => {
    // Mirrors the builtin:coding shape: review → merge-gate fans out into the
    // engine-owned merge/branch-group/retry subgraph. These primitive kinds are a
    // terminal boundary, so the graph still compiles to its pre-merge step list
    // instead of failing as interpreter-only.
    const ir: WorkflowIr = {
      version: "v1",
      name: "merge-region",
      nodes: [
        { id: "start", kind: "start" },
        { id: "spec", kind: "prompt", config: { name: "Spec", prompt: "spec" } },
        { id: "review", kind: "prompt", config: { seam: "review" } },
        { id: "merge-gate", kind: "merge-gate", config: { gate: "auto-merge" } },
        { id: "merge-attempt", kind: "merge-attempt" },
        { id: "merge-hold", kind: "manual-merge-hold" },
        { id: "end", kind: "end" },
      ],
      edges: [
        { from: "start", to: "spec", condition: "success" },
        { from: "spec", to: "review", condition: "success" },
        { from: "review", to: "merge-gate", condition: "success" },
        { from: "review", to: "end", condition: "failure" },
        { from: "merge-gate", to: "merge-attempt", condition: "outcome:auto-on" },
        { from: "merge-gate", to: "merge-hold", condition: "outcome:auto-off" },
        { from: "merge-attempt", to: "end", condition: "success" },
        { from: "merge-hold", to: "merge-attempt", condition: "success" },
      ],
    };
    expect(validateLinearity(parseWorkflowIr(ir))).toBeNull();
    const steps = compileWorkflowToSteps(ir);
    // Only the pre-merge user node lowers; the merge primitives emit no steps.
    expect(steps.map((s) => s.name)).toEqual(["Spec"]);
  });

  it("rejects a graph missing the start/end nodes via parse", () => {
    const ir = { version: "v1", name: "x", nodes: [{ id: "p", kind: "prompt" }], edges: [] } as WorkflowIr;
    expect(() => compileWorkflowToSteps(ir)).toThrow();
  });

  it("rejects a disconnected node not on the main path", () => {
    const ir: WorkflowIr = {
      version: "v1",
      name: "orphan",
      nodes: [
        { id: "start", kind: "start" },
        { id: "a", kind: "prompt", config: { prompt: "a" } },
        { id: "orphan", kind: "prompt", config: { prompt: "o" } },
        { id: "end", kind: "end" },
      ],
      edges: [
        { from: "start", to: "a", condition: "success" },
        { from: "a", to: "end", condition: "success" },
        { from: "orphan", to: "end", condition: "success" },
      ],
    };
    const err = validateLinearity(ir);
    expect(err).toBeInstanceOf(WorkflowCompileError);
    expect(err?.message).toContain(WORKFLOW_INTERPRETER_DEFERRED_SUFFIX);
    expect(err?.message).toMatch(/disconnected nodes/);
  });

  it("rejects seams that are out of the planning -> execute -> workflow-step -> review -> merge order", () => {
    const ir: WorkflowIr = {
      version: "v1",
      name: "misordered-seams",
      nodes: [
        { id: "start", kind: "start" },
        { id: "merge", kind: "prompt", config: { seam: "merge" } },
        { id: "review", kind: "prompt", config: { seam: "review" } },
        { id: "end", kind: "end" },
      ],
      edges: [
        { from: "start", to: "merge", condition: "success" },
        { from: "merge", to: "review", condition: "success" },
        { from: "review", to: "end", condition: "success" },
      ],
    };
    const err = validateLinearity(ir);
    expect(err).toBeInstanceOf(WorkflowCompileError);
    expect(err?.message).toMatch(/planning -> execute -> workflow-step -> review -> merge order/);
  });

  it("rejects a graph with a duplicated seam role", () => {
    const ir: WorkflowIr = {
      version: "v1",
      name: "dup-merge",
      nodes: [
        { id: "start", kind: "start" },
        { id: "merge1", kind: "prompt", config: { seam: "merge" } },
        { id: "merge2", kind: "prompt", config: { seam: "merge" } },
        { id: "end", kind: "end" },
      ],
      edges: [
        { from: "start", to: "merge1", condition: "success" },
        { from: "merge1", to: "merge2", condition: "success" },
        { from: "merge2", to: "end", condition: "success" },
      ],
    };
    const err = validateLinearity(ir);
    expect(err).toBeInstanceOf(WorkflowCompileError);
    expect(err?.message).toMatch(/appears more than once/);
  });

  it("returns an empty step set for a graph with only start/seams/end", () => {
    const ir = graph([]);
    expect(compileWorkflowToSteps(ir)).toEqual([]);
  });

  it("is deterministic across a serialize/parse round-trip", () => {
    const ir = graph([
      { id: "lint", kind: "gate", config: { name: "Lint", scriptName: "lint" } },
      { id: "spec", kind: "prompt", config: { name: "Spec", prompt: "x" } },
    ]);
    const first = compileWorkflowToSteps(ir);
    const second = compileWorkflowToSteps(parseWorkflowIr(serializeWorkflowIr(ir)));
    expect(second).toEqual(first);
  });
});
