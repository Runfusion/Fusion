/*
FNXC:WorkflowColumns 2026-07-28-00:00 (U12 — PR #2512 review, greptile P1):
Direct coverage of what a completed workflow switch REPORTS.

Why a unit test rather than a store-level one: the case that matters — the task is
soft-deleted BETWEEN the switch's first read and its final one — is not reachable
through the public call, because `selectTaskWorkflow` rejects an already-deleted task
up front with `TaskDeletedError`. It is a genuine race. Testing the decision directly
is honest; asserting it from reading the code is not.

REVERT CHECK: restore the old `afterRow ? String(afterRow.column) : fromColumn`
fallback and the "vanished row" case fails — it reports `{ preserved: true, toColumn:
fromColumn }`, fabricating a live column for a row that is gone.
*/
import { describe, expect, it } from "vitest";
import { buildSwitchReconciliation } from "../workflow-reconciliation.js";

describe("workflow switch reconciliation reporting", () => {
  it("reports the ACTUAL column, not the intended one", () => {
    // The re-home landed somewhere other than the source: report where it is.
    expect(buildSwitchReconciliation("custom-hold", "triage")).toEqual({
      preserved: false,
      fromColumn: "custom-hold",
      toColumn: "triage",
    });
  });

  it("reports preserved when the card did not move", () => {
    expect(buildSwitchReconciliation("todo", "todo")).toEqual({
      preserved: true,
      fromColumn: "todo",
      toColumn: "todo",
    });
  });

  it("omits the reconciliation entirely when the row is gone", () => {
    // A soft-delete racing the switch leaves no readable row. Absent must read as
    // absent — never as "preserved in its old column".
    expect(buildSwitchReconciliation("todo", undefined)).toBeUndefined();
  });
});
