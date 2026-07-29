/*
FNXC:SpecStalenessPostU11 2026-07-29-18:10 (U11 #2515 audit — U7's assigned site):

`shouldSkipSpecStalenessForPreservedProgress` decides whether a card's leftover
progress EXEMPTS it from spec-staleness evaluation. It listed three "no, still
evaluate" conditions: the card is in `triage`, or carries `needs-replan`, or
carries `planning`.

The audit answers, per the coordinator's three questions:

  (a) Does `column === "triage"` still fire for a default-workflow card after
      #2515?  NO. The default lineage no longer declares `triage` at all.

  (b) What silently stops happening?  A card resting in the merged Planning column
      with leftover steps and NO planning-stage status now takes the "preserved
      progress" exemption, so its spec is never evaluated for staleness. The
      scheduler's stale-spec rebound therefore never fires and the card can be
      dispatched against a spec the reviewer already superseded.

      That combination is not exotic: finalize clears `status` to null after the
      handoff, and steps parsed from the previous planning pass remain on the row.
      It is the FN-8596 shape exactly.

  (c) Fix: resolve the planner lane instead of naming `triage`. The function is
      pure and synchronous — one of its two callers invokes it inside a scheduler
      filter — so the lane is INJECTED, defaulting to the legacy id. Callers that
      know the workflow pass it; the rest are byte-identical.

The status conditions are deliberately untouched: `needs-replan` and `planning` are
statuses, not columns, and U11 did not move them.
*/
import { describe, expect, it } from "vitest";

import { shouldSkipSpecStalenessForPreservedProgress } from "../spec-staleness.js";

/** A card with leftover progress from a previous planning pass. */
const withProgress = (over: Record<string, unknown> = {}) => ({
  column: "todo",
  status: null,
  currentStep: 0,
  steps: [{ name: "s1", status: "done" }],
  ...over,
} as never);

describe("spec-staleness progress exemption resolves the planner lane", () => {
  it("still evaluates a card in the DEFAULT planner column (no-regression half)", () => {
    // Legacy vocabulary, legacy default lane: unchanged.
    expect(shouldSkipSpecStalenessForPreservedProgress(withProgress({ column: "triage" }))).toBe(false);
  });

  it("still evaluates a card in the MERGED planning column when told the lane", () => {
    /*
    The #2515 gap. Without the lane this returns `true` — the card is exempted from
    staleness evaluation entirely, so a superseded spec is never detected and the
    scheduler's rebound never fires.
    */
    expect(
      shouldSkipSpecStalenessForPreservedProgress(withProgress({ column: "todo" }), { intake: "todo" }),
    ).toBe(false);
  });

  it("still evaluates a card in a RENAMED planner column when told the lane", () => {
    expect(
      shouldSkipSpecStalenessForPreservedProgress(withProgress({ column: "backlog" }), { intake: "backlog" }),
    ).toBe(false);
  });

  it("EXEMPTS a card with progress that has genuinely left the planner lane", () => {
    // The other side, so "always evaluate" cannot pass for "correctly in the lane":
    // a card actually executing keeps its progress exemption.
    expect(
      shouldSkipSpecStalenessForPreservedProgress(withProgress({ column: "in-progress" }), { intake: "todo" }),
    ).toBe(true);
  });

  it("keeps the legacy answer when no lane is supplied (strictly additive)", () => {
    // A caller with no resolved roles behaves exactly as before — including the old
    // WRONG answer for the merged column, which is what makes this safe to land
    // ahead of the call-site wiring.
    expect(shouldSkipSpecStalenessForPreservedProgress(withProgress({ column: "todo" }))).toBe(true);
    expect(shouldSkipSpecStalenessForPreservedProgress(withProgress({ column: "triage" }))).toBe(false);
  });

  it("leaves the STATUS conditions untouched — they are not columns", () => {
    // U11 moved a column, not a status; `needs-replan` and `planning` still force
    // evaluation regardless of lane or progress.
    for (const status of ["needs-replan", "planning"]) {
      expect(
        shouldSkipSpecStalenessForPreservedProgress(withProgress({ column: "in-progress", status }), { intake: "todo" }),
      ).toBe(false);
    }
  });
});
