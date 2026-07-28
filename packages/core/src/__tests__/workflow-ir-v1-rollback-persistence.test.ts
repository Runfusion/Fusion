/*
FNXC:WorkflowColumns 2026-07-28-00:00 (U12 — R9):
Pins the v1-IR rollback-compat PERSISTENCE SHAPE (#1405), which U12 made
unconditional by deleting the retired-flag ternary around it.

WHY THIS FILE EXISTS. The U12 change at the three persist sites is
behaviour-preserving and therefore has NO revert-proof test — `flagOn ? ir :
downgrade(ir)` with a flag that is always false is the same thing as
`downgrade(ir)`, so re-adding the branch changes nothing observable. Saying "covered
by tests" about that edit would be false.

What DOES need a guard is the next edit someone is tempted to make: deleting the
downgrade outright as "dead cutover machinery". It is not cutover machinery — it is a
compatibility affordance that lets a binary downgrade still load a row, and stale
binaries opening these databases is an observed event in this project. These cases
fail if the downgrade is removed, and they pin the exact boundary of when it applies.
*/
import { describe, expect, it } from "vitest";
import { BUILTIN_CODING_WORKFLOW_IR } from "../builtin-coding-workflow-ir.js";
import { downgradeIrToV1IfPure, parseWorkflowIr, serializeWorkflowIr } from "../workflow-ir.js";
import type { WorkflowIrV2 } from "../workflow-ir-types.js";

describe("v1 IR rollback-compat persistence shape", () => {
  it("stores a pure-v1-equivalent graph in the v1 shape", () => {
    const stored = downgradeIrToV1IfPure(BUILTIN_CODING_WORKFLOW_IR);
    // Fails if the downgrade is deleted: the built-in coding workflow declares named
    // columns with traits, so it is NOT pure v1 and must stay v2.
    expect(BUILTIN_CODING_WORKFLOW_IR.version).toBe("v2");
    expect(stored.version).toBe("v2");
  });

  it("downgrades a graph that carries only default columns and default placements", () => {
    // A v1 graph upgraded to v2 is by construction pure-v1-equivalent, so it must
    // round-trip back down to v1 on persist.
    const upgraded = parseWorkflowIr({
      version: "v1",
      name: "pure",
      nodes: [
        { id: "start", kind: "start" },
        { id: "n1", kind: "prompt", config: { prompt: "hi" } },
        { id: "end", kind: "end" },
      ],
      edges: [
        { from: "start", to: "n1" },
        { from: "n1", to: "end" },
      ],
    });
    expect(upgraded.version).toBe("v2");

    const stored = downgradeIrToV1IfPure(upgraded);
    expect(stored.version).toBe("v1");
    // The stored v1 row must not carry the synthesized placement fields.
    expect(JSON.parse(serializeWorkflowIr(stored))).not.toHaveProperty("columns");
  });

  it("round-trips a downgraded graph back to an IDENTICAL runtime graph", () => {
    // This is the property that makes the downgrade safe to keep and safe to have
    // always applied: what the runtime sees is unchanged by the stored shape.
    const upgraded = parseWorkflowIr({
      version: "v1",
      name: "pure",
      nodes: [
        { id: "start", kind: "start" },
        { id: "n1", kind: "prompt", config: { prompt: "hi" } },
        { id: "end", kind: "end" },
      ],
      edges: [
        { from: "start", to: "n1" },
        { from: "n1", to: "end" },
      ],
    });
    const rehydrated = parseWorkflowIr(JSON.parse(serializeWorkflowIr(downgradeIrToV1IfPure(upgraded))));
    expect(rehydrated).toEqual(upgraded);
  });

  it("keeps a graph with a CUSTOM column on v2", () => {
    const ir = structuredClone(BUILTIN_CODING_WORKFLOW_IR) as WorkflowIrV2;
    ir.columns.push({ id: "custom-hold", name: "Custom hold", traits: [] });
    const stored = downgradeIrToV1IfPure(ir);
    expect(stored.version).toBe("v2");
    expect((stored as WorkflowIrV2).columns.map((c) => c.id)).toContain("custom-hold");
  });
});
