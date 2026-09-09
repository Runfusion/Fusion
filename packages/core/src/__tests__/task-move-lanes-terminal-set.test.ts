/*
FNXC:WorkflowResolvedColumns 2026-07-31-11:15 (u12 — the payload could not express a two-complete board):
Pins the ONE renamed-board behaviour that supplying `task:moved` lanes did NOT fix when measured
(10 passed / 1 failed): a card landing in a SECOND complete-trait column left its dependents waiting
forever, because `TaskMoveLanes` carried one id per role and the scheduler rebuilt `terminal` from it.
*/
import { describe, expect, it } from "vitest";

import { toTaskMoveLanes } from "../workflows/workflow-lifecycle-traits.js";
import type { WorkflowIr } from "../workflows/workflow-ir.js";

const twoCompleteBoard = {
  version: "v2", id: "wf",
  columns: [
    { id: "inbox", name: "inbox", traits: [{ trait: "intake" }] },
    { id: "building", name: "building", traits: [{ trait: "wip" }] },
    { id: "done", name: "done", traits: [{ trait: "complete" }] },
    { id: "released", name: "released", traits: [{ trait: "complete" }] },
  ],
  nodes: [], edges: [],
} as unknown as WorkflowIr;

describe("the task:moved payload carries the terminal SET, not just the first complete lane", () => {
  it("includes BOTH complete-trait columns", () => {
    const lanes = toTaskMoveLanes(twoCompleteBoard);

    expect(lanes?.terminal).toContain("done");
    // The half that was impossible before: a second complete lane in the payload at all.
    expect(lanes?.terminal).toContain("released");
  });

  it("still reports a single first-match `complete` for move TARGETS", () => {
    // `complete` answers "where does a finished card go" and must stay first-match — a set would be
    // the wrong shape there. Both questions coexist; that is the point of the new field.
    const lanes = toTaskMoveLanes(twoCompleteBoard);

    expect(lanes?.complete).toBe("done");
  });

  it("excludes the historical archived sentinel from terminal routing", () => {
    expect(toTaskMoveLanes(twoCompleteBoard)?.terminal).not.toContain("archived");
  });

  it("omits terminal for an IR with no lifecycle columns rather than inventing one", () => {
    const bare = { version: "v2", id: "wf", columns: [], nodes: [], edges: [] } as unknown as WorkflowIr;

    expect(toTaskMoveLanes(bare)).toBeUndefined();
  });
});
