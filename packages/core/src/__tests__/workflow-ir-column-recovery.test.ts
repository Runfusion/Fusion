// @vitest-environment node
//
// FNXC:WorkflowRecoveryPolicy 2026-07-28-15:50 (PR #2478 review, two P1s):
//
// The recovery policy (`WorkflowIrColumn.recovery`, U4) needs the same two
// protections every other IR column field already has, and shipped without them:
//
//   P1 — DOWNGRADE. `downgradeIrToV1IfPure` did not treat `recovery` as v2-only.
//   The v1 shape has no `columns` at all, so a workflow with v1-compatible nodes
//   and default-shaped columns serialized WITHOUT columns and PERMANENTLY
//   DISCARDED the authored policy on save. Silent data loss: the card simply
//   stops being reconciled, with no error and nothing in the diff to explain it.
//
//   P1 — VALIDATION. `parseWorkflowIr` persisted a negative or non-finite
//   `stalenessMs`, an `onStale` missing its `code`, and unsupported actions, and
//   the reconciler consumed them directly. A negative threshold makes every card
//   instantly stale; a non-finite one makes no card ever stale. An invalid policy
//   must be refused at save, not discovered at 3am in a sweep.
//
// Mirrors `workflow-ir-column-agent.test.ts`, which is the precedent for both.

import { describe, expect, it } from "vitest";
import {
  parseWorkflowIr,
  serializeWorkflowIr,
  downgradeIrToV1IfPure,
  WorkflowIrError,
} from "../workflows/workflow-ir.js";
import type { WorkflowColumnRecovery, WorkflowIrEdge, WorkflowIrNode, WorkflowIrV2 } from "../workflows/workflow-ir-types.js";

function v2(
  columns: WorkflowIrV2["columns"],
  nodes: WorkflowIrNode[],
  edges: WorkflowIrEdge[],
): WorkflowIrV2 {
  return { version: "v2", name: "test", columns, nodes, edges };
}

/**
 * A graph whose columns are EXACTLY the default-shaped set — the only shape
 * `downgradeIrToV1IfPure` will collapse to v1. That is deliberate: the data-loss
 * bug only bites a workflow that would otherwise downgrade, so a custom-column
 * fixture would pass the downgrade test for the wrong reason.
 */
function defaultShapedGraph(recovery?: WorkflowColumnRecovery): WorkflowIrV2 {
  const columns: WorkflowIrV2["columns"] = [
    { id: "triage", name: "triage", traits: [] },
    { id: "todo", name: "todo", traits: [], ...(recovery ? { recovery } : {}) },
    { id: "in-progress", name: "in-progress", traits: [] },
    { id: "in-review", name: "in-review", traits: [] },
    { id: "done", name: "done", traits: [] },
  ];
  return v2(
    columns,
    [
      // Seamless nodes default to the "todo" column (see defaultColumnForNode);
      // placing them anywhere else forces v2 on PLACEMENT and the downgrade
      // control below would then pass for the wrong reason.
      { id: "start", kind: "start", column: "todo" },
      { id: "end", kind: "end", column: "todo" },
    ],
    [{ from: "start", to: "end" }],
  );
}

const VALID: WorkflowColumnRecovery = {
  stalenessMs: 86_400_000,
  onStale: { action: "surface", code: "stale-paused-todo" },
};

describe("column recovery — downgrade protection (P1: silent data loss)", () => {
  it("the fixture WITHOUT a recovery policy really does downgrade to v1", () => {
    /*
    The control. Without this the next test could pass because the fixture never
    downgrades for an unrelated reason, proving nothing about `recovery`.
    */
    expect(downgradeIrToV1IfPure(defaultShapedGraph()).version).toBe("v1");
  });

  it("a graph carrying a recovery policy is forced to stay v2", () => {
    expect(downgradeIrToV1IfPure(defaultShapedGraph(VALID)).version).toBe("v2");
  });

  it("an EMPTY recovery object still forces v2, because presence is the signal", () => {
    /*
    Matches the `optionalSteps` rule: an author who wrote the key intended v2, and
    downgrading would still mutate the persisted shape.
    */
    expect(downgradeIrToV1IfPure(defaultShapedGraph({} as WorkflowColumnRecovery)).version).toBe("v2");
  });

  it("the policy survives a serialize → parse → downgrade round trip", () => {
    /* The end-to-end shape of the reported bug: save must not eat the policy. */
    const parsed = parseWorkflowIr(serializeWorkflowIr(defaultShapedGraph(VALID)));
    const after = downgradeIrToV1IfPure(parsed) as WorkflowIrV2;

    expect(after.version).toBe("v2");
    expect(after.columns.find((c) => c.id === "todo")?.recovery).toEqual(VALID);
  });

  it("omits the key entirely when no policy is set", () => {
    const serialized = serializeWorkflowIr(defaultShapedGraph());
    expect(serialized).not.toContain('"recovery"');
    const reparsed = parseWorkflowIr(serialized) as WorkflowIrV2;
    expect("recovery" in reparsed.columns.find((c) => c.id === "todo")!).toBe(false);
  });
});

describe("column recovery — parse-time validation (P1: invalid policy persisted)", () => {
  function parseWith(recovery: unknown): WorkflowIrV2 {
    return parseWorkflowIr(defaultShapedGraph(recovery as WorkflowColumnRecovery)) as WorkflowIrV2;
  }

  it("accepts a well-formed policy and round-trips it", () => {
    const parsed = parseWith(VALID);
    expect(parsed.columns.find((c) => c.id === "todo")?.recovery).toEqual(VALID);
  });

  it.each([
    ["negative stalenessMs", { stalenessMs: -1, onStale: VALID.onStale }],
    ["zero stalenessMs", { stalenessMs: 0, onStale: VALID.onStale }],
    ["NaN stalenessMs", { stalenessMs: Number.NaN, onStale: VALID.onStale }],
    ["Infinity stalenessMs", { stalenessMs: Number.POSITIVE_INFINITY, onStale: VALID.onStale }],
    ["non-numeric stalenessMs", { stalenessMs: "86400000", onStale: VALID.onStale }],
  ])("rejects %s", (_label, recovery) => {
    expect(() => parseWith(recovery)).toThrow(WorkflowIrError);
  });

  it.each([
    ["unsupported action", { stalenessMs: 1000, onStale: { action: "rebound", code: "x" } }],
    ["missing action", { stalenessMs: 1000, onStale: { code: "x" } }],
    ["missing code", { stalenessMs: 1000, onStale: { action: "surface" } }],
    ["blank code", { stalenessMs: 1000, onStale: { action: "surface", code: "   " } }],
    ["non-object onStale", { stalenessMs: 1000, onStale: "surface" }],
  ])("rejects %s", (_label, recovery) => {
    expect(() => parseWith(recovery)).toThrow(WorkflowIrError);
  });

  it.each([
    ["threshold with no action", { stalenessMs: 1000 }],
    ["action with no threshold", { onStale: VALID.onStale }],
  ])("rejects a half-declared policy: %s", (_label, recovery) => {
    /*
    Either half alone silently does nothing — a threshold that never fires, or an
    action with nothing to fire on. Persisting that would produce exactly the
    "policy present but inert" failure this program keeps finding.
    */
    expect(() => parseWith(recovery)).toThrow(WorkflowIrError);
  });

  it("names the offending column in the error, so the author can find it", () => {
    expect(() => parseWith({ stalenessMs: -1, onStale: VALID.onStale })).toThrow(/column 'todo'/);
  });

  it("still accepts a column with NO recovery key at all", () => {
    expect(() => parseWorkflowIr(defaultShapedGraph())).not.toThrow();
  });
});
