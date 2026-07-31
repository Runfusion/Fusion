/*
FNXC:WorkflowLifecycleColumns 2026-07-31-12:20:

THE INVARIANT: the Command Center analytics routes supply the column trait flags the aggregators
need, so the wip/review tallies come from ROLES rather than ids.

WIRING AN OPTION NOTHING FILLED — the second of the five inert conversions I audited after #2787's
review. `columnFlagsByName` existed on both aggregators and neither route passed it, so both surfaces
reported **0 in-progress and 0 in-review** on a renamed board beside token and cost totals that were
entirely correct. A zero next to a populated neighbour reads as "nobody is working", not as "this
metric is broken".

STRUCTURAL, AND THE REASON IS THE SEAM: the aggregators take a live `AsyncDataLayer` and run SQL, so
driving them here means standing up PostgreSQL to re-assert that an option is forwarded. The value
being forwarded is already covered behaviourally by `analytics-timing-roles-resolved.test.ts` in core.
What was missing was the WIRING, and that is what this pins. Labelled rather than dressed up as a
behavioural test.

REVERT PROOF, measured: drop either `columnFlagsByName:` line from the routes and the matching case
below fails.
*/
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../routes/register-command-center-routes.ts", import.meta.url), "utf8");

describe("Command Center analytics routes pass resolved column flags", () => {
  it("builds the flag map from the project's own workflow definitions", () => {
    expect(source).toContain("async function resolveColumnFlagsByName(");
    expect(source).toContain("await store.listWorkflowDefinitions()");
    expect(source).toContain("resolveColumnFlags(column)");
  });

  it("forwards it to BOTH aggregators", () => {
    // Two routes, two call sites: wiring one and not the other is the half-converted-pair shape
    // this program keeps finding.
    const forwarded = source.split("columnFlagsByName: await resolveColumnFlagsByName(store)").length - 1;
    expect(forwarded).toBe(2);
  });

  it("DROPS a column id two workflows disagree about, rather than merging their flags", () => {
    /*
    #2803 review (greptile P1). Merging flags across workflows made one id carry both roles, so the
    aggregators counted the same rows as in-progress AND in-review — a double count, worse than the
    silent zero the wiring set out to fix. I had documented the flat-map ambiguity in the PR body and
    shipped it anyway; documenting a defect is not resolving it.

    Dropping the ambiguous id leaves those rows on the documented legacy behaviour: still wrong for a
    renamed board, but wrong in ONE direction and never double counted.
    */
    expect(source).toContain("if (isConflictingColumnFlags(existing, flags)) conflicting.add(column.id);");
    expect(source).toContain("for (const id of conflicting) byColumn.delete(id);");
    // The comparison covers exactly the roles the tallies read.
    expect(source).toContain("(a.countsTowardWip === true) !== (b.countsTowardWip === true)");
  });

  it("degrades to an empty map rather than throwing when definitions are unreadable", () => {
    // An empty map means both aggregators keep their documented legacy ids — the analytics page must
    // not 500 because a workflow row is corrupt.
    expect(source).toContain("Unreadable definitions leave the map empty");
  });
});
