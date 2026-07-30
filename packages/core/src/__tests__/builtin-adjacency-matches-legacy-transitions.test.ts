/*
FNXC:WorkflowResolvedColumns 2026-07-29-00:00 (U12 — R8):
Pins the equivalence that let the dashboard's `VALID_TRANSITIONS` shortcut be DELETED.

The move menu could not use workflow adjacency because none was on the wire, so it
approximated targets from a column's neighbours in declared order and kept a legacy
shortcut for workflows whose column-id set matched the six built-ins — because the
approximation is strictly weaker (in-progress: 4 real targets vs 2 neighbours).

Adjacency is now on the board-workflows payload, and the shortcut is gone. That is
only safe because `resolveAllowedColumns(BUILTIN_CODING_WORKFLOW_IR, c)` is identical
to `VALID_TRANSITIONS[c]` — same members AND same order — for every built-in column.
This test is what stops that equivalence drifting silently: if the built-in workflow's
edges change without `VALID_TRANSITIONS` following, default-workflow move menus change
shape and this fails first.

It intentionally compares ORDER too, not just membership: the menu renders targets in
the order it receives them, so a reordering is an operator-visible change.
*/
import { describe, expect, it } from "vitest";
import { BUILTIN_CODING_WORKFLOW_IR } from "../builtin-coding-workflow-ir.js";
import { resolveAllowedColumns } from "../workflow-transitions.js";
import { COLUMNS } from "../types/board.js";
import { VALID_TRANSITIONS } from "../types/board-config.js";

describe("built-in workflow adjacency vs the legacy transition table", () => {
  it.each(COLUMNS)("column %s resolves the same targets, in the same order", (column) => {
    expect(resolveAllowedColumns(BUILTIN_CODING_WORKFLOW_IR, column)).toEqual([
      ...VALID_TRANSITIONS[column],
    ]);
  });

  it("covers every legacy column, so a new one cannot slip past this pin", () => {
    expect(COLUMNS.length).toBe(Object.keys(VALID_TRANSITIONS).length);
  });
});
