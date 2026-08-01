/*
FNXC:WorkflowLifecycleColumns 2026-07-30-11:30 (Phase B conversion — spec-staleness):

`shouldSkipSpecStalenessForPreservedProgress` refuses to skip staleness for a card in the
INTAKE column — a card being specified has no preserved progress to protect. It compared
against the literal `triage`, so on a renamed board an intake card looked like started work
and its stale spec was skipped rather than re-planned.

The predicate is PURE (a task, no store), so the role arrives as a parameter and the two
callers resolve it. That optionality is the caller-omission hazard, which is why the function
is also registered in core's role-parameter-caller-audit — this file proves the parameter is
HONOURED, the audit proves it is PASSED. Neither alone is enough.
*/
import { describe, expect, it } from "vitest";
import { shouldSkipSpecStalenessForPreservedProgress } from "../spec-staleness.js";

const started = { column: "drafting", currentStep: 2, status: undefined } as never;

describe("spec staleness preserved-progress skip under a renamed intake column", () => {
  it("does NOT skip for a card in the RENAMED intake column", () => {
    /* The conversion: with `drafting` named as intake this must refuse to skip, exactly as
       it refuses for `triage` on the default board. */
    expect(shouldSkipSpecStalenessForPreservedProgress(started, "drafting")).toBe(false);
  });

  it("DOES skip started work in a non-intake column of the same board", () => {
    /* The negative half — otherwise "never skip" would send every card with real progress
       back through re-planning and discard it. */
    expect(shouldSkipSpecStalenessForPreservedProgress({ ...started, column: "building" } as never, "drafting")).toBe(true);
  });

  it("still refuses to skip for `triage` when no role is supplied (regression floor)", () => {
    expect(
      shouldSkipSpecStalenessForPreservedProgress({ ...started, column: "triage" } as never),
    ).toBe(false);
  });
});
