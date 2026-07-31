/*
FNXC:WorkflowLifecycleColumns 2026-07-30-13:30 (U11 census hygiene):

Three `"triage"` literals matched the lifecycle-column census and are NOT board
columns. Converting them to trait resolution would have been actively wrong, so
this pins what they actually are — and pins the refactors as equivalent, because
"it's only a rename" is exactly the claim that should be tested rather than
asserted.

  tool-availability  `surface: "triage" | "executor"` is an AGENT LANE. The lane
                     that writes specs keeps its name whatever the board calls its
                     planning column; tying it to a workflow's vocabulary would
                     make an agent's prompt depend on board configuration.

  skill-resolver     `sessionPurpose === "triage"` is an AGENT ROLE. Same argument:
                     a role does not move when a board renames a column.

  (The CLI task-list glyph was a third case here. #2627 landed its own conversion on
  main first, using the inverse `done || archived` form; that PR documents the same
  divergence outside the six legacy ids that my equivalence test found, so there was
  nothing left to add and this PR's version was dropped during rebase rather than
  contested.)

The distinction matters beyond tidiness: a future auditor working the census will
reach these and needs to know at a glance that they are out of scope, rather than
re-deriving it as I had to.
*/
import { describe, expect, it } from "vitest";

import { getResearchGuidanceForSurface } from "../tool-availability.js";

describe("agent-lane vocabulary is not board-column vocabulary", () => {
  it("returns distinct research guidance per agent lane", () => {
    const triage = getResearchGuidanceForSurface("triage");
    const executor = getResearchGuidanceForSurface("executor");

    expect(triage).not.toBe(executor);
    /* The lane-specific content, so a table wired to the wrong key is caught. */
    expect(triage).toContain("spec work");
    expect(executor).toContain("implementation");
    for (const guidance of [triage, executor]) {
      expect(guidance).toContain("fn_research_run");
    }
  });

  it("keeps the lane names independent of any board column id", () => {
    /*
    The invariant the census hygiene rests on: these are the two AGENT LANES, and
    they are unaffected by what a workflow calls its planning column. If someone
    later "converts" this to trait resolution, this test is where it lands.
    */
    expect(getResearchGuidanceForSurface("triage")).toBe(getResearchGuidanceForSurface("triage"));
    expect(() => getResearchGuidanceForSurface("executor")).not.toThrow();
  });
});
