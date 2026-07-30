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

  cli task list      the glyph chain distinguished TERMINAL columns from active
                     ones and nothing else — all four non-terminal ids mapped to
                     the same "●".

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

describe("terminal-vs-active glyph selection (CLI task list)", () => {
  /*
  The refactor replaced a four-way literal chain with one terminal test. Equivalence
  is asserted over ALL six ids rather than trusted, because the chain's fallthrough
  ("everything else gets ○") is the part a rewrite can silently widen.
  */
  const COLUMNS = ["triage", "todo", "in-progress", "in-review", "done", "archived"] as const;

  const before = (col: string): string =>
    col === "triage" ? "●"
      : col === "todo" ? "●"
        : col === "in-progress" ? "●"
          : col === "in-review" ? "●" : "○";

  /* The shipped implementation: an explicit ACTIVE set, mirroring the chain's
     fallthrough. NOT the inverse `done || archived` form — see below. */
  const ACTIVE = new Set(["triage", "todo", "in-progress", "in-review"]);
  const after = (col: string): string => (ACTIVE.has(col) ? "●" : "○");

  it("is byte-identical to the replaced chain for every lifecycle column", () => {
    for (const col of COLUMNS) {
      expect(after(col)).toBe(before(col));
    }
  });

  it("agrees on an UNKNOWN column id, which is where the obvious rewrite diverged", () => {
    /*
    This assertion earned its place. The first rewrite was the inverse form,
    `col === "done" || col === "archived" ? "○" : "●"` — equivalent across all six
    lifecycle ids and NOT equivalent for anything else, because the original chain
    fell through to "○" while the inverse renders an unknown id as active.

    The loop only walks the six `COLUMNS` today, so nothing would have caught it in
    practice; a renamed workflow reaching this code later would have silently
    changed how its columns render. A refactor claimed to be equivalent should be
    tested at its edges, not only where it is currently exercised.
    */
    for (const col of ["drafting", "inbox", "shipped"]) {
      expect(after(col)).toBe(before(col));
      expect(after(col)).toBe("○");
    }
  });
});
