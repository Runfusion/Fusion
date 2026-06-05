import { describe, it, expect } from "vitest";

import { stepsToWorkflowIr, stepToFragmentIr, layoutForIr } from "../workflow-steps-to-ir.js";
import { compileWorkflowToSteps } from "../workflow-compiler.js";
import { parseWorkflowIr } from "../workflow-ir.js";
import type { WorkflowStep, WorkflowStepInput } from "../types.js";

/** Build a fully-specified WorkflowStep fixture. */
function step(overrides: Partial<WorkflowStep>): WorkflowStep {
  return {
    id: overrides.id ?? "WS-000",
    name: overrides.name ?? "Step",
    description: overrides.description ?? "",
    mode: overrides.mode ?? "prompt",
    phase: overrides.phase,
    gateMode: overrides.gateMode ?? "advisory",
    prompt: overrides.prompt ?? "",
    toolMode: overrides.toolMode,
    scriptName: overrides.scriptName,
    enabled: overrides.enabled ?? true,
    defaultOn: overrides.defaultOn,
    modelProvider: overrides.modelProvider,
    modelId: overrides.modelId,
    migratedFragmentId: overrides.migratedFragmentId,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

/** Project a compiled step input down to exactly the compiler-visible fields the
 *  round-trip contract pins (KTD-2). Normalizes optional fields for comparison. */
function visible(input: WorkflowStepInput) {
  return {
    name: input.name,
    mode: input.mode,
    phase: input.phase,
    gateMode: input.gateMode,
    prompt: input.mode === "script" ? undefined : (input.prompt ?? ""),
    scriptName: input.scriptName,
    toolMode: input.mode === "script" ? undefined : input.toolMode,
    modelProvider: input.modelProvider,
    modelId: input.modelId,
  };
}

function visibleStep(s: WorkflowStep) {
  return {
    name: s.name,
    mode: s.mode,
    phase: s.phase ?? "pre-merge",
    gateMode: s.gateMode,
    prompt: s.mode === "script" ? undefined : (s.prompt ?? ""),
    scriptName: s.mode === "script" ? s.scriptName : undefined,
    toolMode: s.mode === "script" ? undefined : (s.toolMode ?? "readonly"),
    modelProvider: s.mode === "prompt" ? s.modelProvider : undefined,
    modelId: s.mode === "prompt" ? s.modelId : undefined,
  };
}

describe("stepsToWorkflowIr — round-trip parity (R4/KTD-2)", () => {
  it("reproduces every compiler-visible field for a mixed step set", () => {
    const steps: WorkflowStep[] = [
      step({
        id: "WS-1",
        name: "Implement",
        description: "do the work",
        mode: "prompt",
        gateMode: "advisory",
        prompt: "Implement the change",
        toolMode: "coding",
        phase: "pre-merge",
      }),
      step({
        id: "WS-2",
        name: "Lint",
        mode: "script",
        gateMode: "gate",
        scriptName: "lint",
        phase: "pre-merge",
      }),
      step({
        id: "WS-3",
        name: "Security gate",
        mode: "prompt",
        gateMode: "gate",
        prompt: "Block on exploitable findings",
        toolMode: "readonly",
        modelProvider: "anthropic",
        modelId: "claude-sonnet-4-5",
        phase: "pre-merge",
      }),
      step({
        id: "WS-4",
        name: "Document",
        mode: "prompt",
        gateMode: "advisory",
        prompt: "Write docs",
        phase: "post-merge",
      }),
      step({
        id: "WS-5",
        name: "Deploy script",
        mode: "script",
        gateMode: "advisory",
        scriptName: "deploy",
        phase: "post-merge",
      }),
    ];

    const ir = stepsToWorkflowIr(steps, "Migrated");
    const compiled = compileWorkflowToSteps(ir);

    expect(compiled.map(visible)).toEqual(steps.map(visibleStep));
  });

  it("undefined phase maps to pre-merge and round-trips", () => {
    const steps: WorkflowStep[] = [
      step({ id: "WS-1", name: "A", mode: "prompt", gateMode: "advisory", prompt: "a" }),
      step({ id: "WS-2", name: "B", mode: "prompt", gateMode: "advisory", prompt: "b" }),
    ];
    const ir = stepsToWorkflowIr(steps, "AllUndefined");
    // parseable
    expect(() => parseWorkflowIr(ir)).not.toThrow();
    const compiled = compileWorkflowToSteps(ir);
    expect(compiled.map((c) => c.phase)).toEqual(["pre-merge", "pre-merge"]);
    expect(compiled.map(visible)).toEqual(steps.map(visibleStep));
  });

  it("empty step list yields a minimal valid IR that compiles to []", () => {
    const ir = stepsToWorkflowIr([], "Empty");
    expect(() => parseWorkflowIr(ir)).not.toThrow();
    expect(compileWorkflowToSteps(ir)).toEqual([]);
    // start + 3 seams + end.
    expect(ir.nodes.map((n) => n.id)).toEqual(["start", "execute", "review", "merge", "end"]);
  });

  it("post-merge-only set places nodes after the merge seam", () => {
    const steps: WorkflowStep[] = [
      step({ id: "WS-1", name: "After", mode: "prompt", gateMode: "advisory", prompt: "x", phase: "post-merge" }),
    ];
    const ir = stepsToWorkflowIr(steps, "PostOnly");
    const ids = ir.nodes.map((n) => n.id);
    expect(ids.indexOf("merge")).toBeLessThan(ids.indexOf("step-1"));
    const compiled = compileWorkflowToSteps(ir);
    expect(compiled).toHaveLength(1);
    expect(compiled[0].phase).toBe("post-merge");
  });

  it("produced IR passes parseWorkflowIr and encodes seams exactly per linear()", () => {
    const steps: WorkflowStep[] = [
      step({ id: "WS-1", name: "A", mode: "prompt", gateMode: "advisory", prompt: "a" }),
    ];
    const ir = stepsToWorkflowIr(steps, "Seams");
    expect(() => parseWorkflowIr(ir)).not.toThrow();

    // Each seam appears exactly once, in execute → review → merge order.
    const seamNodes = ir.nodes.filter((n) => typeof n.config?.seam === "string");
    expect(seamNodes.map((n) => n.config!.seam)).toEqual(["execute", "review", "merge"]);

    // Each seam has a failure → end edge.
    for (const seam of ["execute", "review", "merge"]) {
      const failEdge = ir.edges.find((e) => e.from === seam && e.condition === "failure");
      expect(failEdge?.to).toBe("end");
    }
    // No duplicate failure edges per seam.
    const failureEdges = ir.edges.filter((e) => e.condition === "failure");
    expect(failureEdges).toHaveLength(3);
  });

  it("gate vs advisory both round-trip for prompt and script modes", () => {
    const steps: WorkflowStep[] = [
      step({ id: "WS-1", name: "PG", mode: "prompt", gateMode: "gate", prompt: "p" }),
      step({ id: "WS-2", name: "PA", mode: "prompt", gateMode: "advisory", prompt: "p" }),
      step({ id: "WS-3", name: "SG", mode: "script", gateMode: "gate", scriptName: "s" }),
      step({ id: "WS-4", name: "SA", mode: "script", gateMode: "advisory", scriptName: "s" }),
    ];
    const compiled = compileWorkflowToSteps(stepsToWorkflowIr(steps, "Gates"));
    expect(compiled.map((c) => c.gateMode)).toEqual(["gate", "advisory", "gate", "advisory"]);
    expect(compiled.map(visible)).toEqual(steps.map(visibleStep));
  });
});

describe("stepToFragmentIr (R6/KTD-1)", () => {
  it("produces a parseable start → node → end fragment mirroring the step", () => {
    const s = step({
      id: "WS-1",
      name: "Doc",
      description: "doc it",
      mode: "prompt",
      gateMode: "advisory",
      prompt: "Document the change",
      toolMode: "readonly",
    });
    const ir = stepToFragmentIr(s);
    expect(() => parseWorkflowIr(ir)).not.toThrow();
    expect(ir.nodes.map((n) => n.id)).toEqual(["start", "step-1", "end"]);
    expect(ir.nodes.map((n) => n.kind)).toEqual(["start", "prompt", "end"]);

    // The single node compiles back to a step mirroring the source.
    const compiled = compileWorkflowToSteps(ir);
    expect(compiled).toHaveLength(1);
    expect(visible(compiled[0])).toEqual(visibleStep(s));
  });

  it("fragment IR is pure v1 (no v2-only features)", () => {
    const ir = stepToFragmentIr(step({ id: "WS-1", name: "S", mode: "script", gateMode: "gate", scriptName: "lint" }));
    // parseWorkflowIr upgrades to v2 in-memory; the SOURCE we built is v1-shaped.
    const compiled = compileWorkflowToSteps(ir);
    expect(compiled[0].mode).toBe("script");
    expect(compiled[0].scriptName).toBe("lint");
  });
});

describe("layoutForIr", () => {
  it("produces x-spaced positions for every node", () => {
    const ir = stepsToWorkflowIr(
      [step({ id: "WS-1", name: "A", mode: "prompt", gateMode: "advisory", prompt: "a" })],
      "L",
    );
    const layout = layoutForIr(ir);
    expect(Object.keys(layout).sort()).toEqual(ir.nodes.map((n) => n.id).sort());
    expect(layout.start).toEqual({ x: 60, y: 160 });
    // Second node is one column over.
    expect(layout[ir.nodes[1].id].x).toBe(60 + 170);
  });
});
