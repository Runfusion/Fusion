import { describe, it, expect } from "vitest";

import { stepsToWorkflowIr, stepToFragmentIr, layoutForIr } from "../workflow-steps-to-ir.js";
import { parseWorkflowIr } from "../workflow-ir.js";
import type { WorkflowStep } from "../types.js";

/*
FNXC:WorkflowStepCRUD 2026-07-01-00:00:
The linear WorkflowStep compiler (compileWorkflowToSteps) was removed — the graph
interpreter is the sole executor. `stepsToWorkflowIr` / `stepToFragmentIr` survive
only as legacy migration + fragment-layout helpers (they lower old persisted
WorkflowStep rows into IR). These tests now assert the produced IR STRUCTURE
(parseable, seam encoding, node ordering, layout) rather than the former
IR→steps→IR round-trip parity, which no longer has an inverse.
*/

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
    skillName: overrides.skillName,
    scriptName: overrides.scriptName,
    enabled: overrides.enabled ?? true,
    defaultOn: overrides.defaultOn,
    modelProvider: overrides.modelProvider,
    modelId: overrides.modelId,
    thinkingLevel: overrides.thinkingLevel,
    migratedFragmentId: overrides.migratedFragmentId,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("stepsToWorkflowIr — produces valid IR structure", () => {
  it("lowers a mixed step set into a parseable IR carrying each step's config", () => {
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
      step({ id: "WS-2", name: "Lint", mode: "script", gateMode: "gate", scriptName: "lint", phase: "pre-merge" }),
      step({
        id: "WS-4",
        name: "Document",
        mode: "prompt",
        gateMode: "advisory",
        prompt: "Write docs",
        phase: "post-merge",
      }),
    ];

    const ir = stepsToWorkflowIr(steps, "Migrated");
    expect(() => parseWorkflowIr(ir)).not.toThrow();
    // Pre-merge steps precede the merge seam; post-merge steps follow it.
    const ids = ir.nodes.map((n) => n.id);
    expect(ids.indexOf("step-1")).toBeLessThan(ids.indexOf("merge"));
    expect(ids.indexOf("merge")).toBeLessThan(ids.indexOf("step-3"));
    // The prompt node carries the source prompt through the lowering.
    expect(ir.nodes.find((n) => n.id === "step-1")?.config?.prompt).toBe("Implement the change");
  });

  it("lowers thinkingLevel independently from the model pair", () => {
    const thinkingOnly = step({ id: "WS-thinking", name: "Think", mode: "prompt", gateMode: "advisory", prompt: "x", thinkingLevel: "high" });
    const withoutThinking = step({ id: "WS-default", name: "Default", mode: "prompt", gateMode: "advisory", prompt: "y" });

    const fragment = stepToFragmentIr(thinkingOnly);
    expect(fragment.nodes.find((n) => n.id === "step-1")?.config).toMatchObject({ thinkingLevel: "high" });
    expect(fragment.nodes.find((n) => n.id === "step-1")?.config).not.toHaveProperty("modelProvider");
    expect(fragment.nodes.find((n) => n.id === "step-1")?.config).not.toHaveProperty("modelId");

    const ir = stepsToWorkflowIr([thinkingOnly, withoutThinking], "Thinking");
    expect(ir.nodes.find((n) => n.id === "step-1")?.config).toMatchObject({ thinkingLevel: "high" });
    expect(ir.nodes.find((n) => n.id === "step-2")?.config).not.toHaveProperty("thinkingLevel");
  });

  it("empty step list yields a minimal valid IR (start + seams + end)", () => {
    const ir = stepsToWorkflowIr([], "Empty");
    expect(() => parseWorkflowIr(ir)).not.toThrow();
    expect(ir.nodes.map((n) => n.id)).toEqual(["start", "execute", "review", "merge", "end"]);
  });

  it("post-merge-only set places nodes after the merge seam", () => {
    const steps: WorkflowStep[] = [
      step({ id: "WS-1", name: "After", mode: "prompt", gateMode: "advisory", prompt: "x", phase: "post-merge" }),
    ];
    const ir = stepsToWorkflowIr(steps, "PostOnly");
    const ids = ir.nodes.map((n) => n.id);
    expect(ids.indexOf("merge")).toBeLessThan(ids.indexOf("step-1"));
  });

  it("produced IR passes parseWorkflowIr and encodes seams exactly", () => {
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
    expect(ir.nodes.find((n) => n.id === "step-1")?.config?.prompt).toBe("Document the change");
  });

  it("script fragment carries scriptName through the lowering", () => {
    const ir = stepToFragmentIr(step({ id: "WS-1", name: "S", mode: "script", gateMode: "gate", scriptName: "lint" }));
    const node = ir.nodes.find((n) => n.id === "step-1");
    expect(node?.kind).toBe("script");
    expect(node?.config?.scriptName).toBe("lint");
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
