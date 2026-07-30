// @vitest-environment node
/*
FNXC:WorkflowLifecycleColumns 2026-07-31-08:10:

THE INVARIANT: the stale-spec guard skips cards the board's OWN workflow calls active.

THIS GUARD DID THE EXACT THING ITS OWN COMMENT SAYS IT MUST NOT. The comment above the code reads:
"Skip for tasks that are already in-progress, in-review, merging, or done — these should not be
interrupted and sent back to triage for re-planning." Keyed on a hard-coded `Set`, a renamed board
matched NOTHING, so `isActiveTask` was false for a card in a renamed wip/review/complete lane, the
guard ran on a LIVE task, and `moveTaskToReplanColumn` + `status: "needs-replan"` pulled it out of
execution mid-flight.

`activeMergeStatuses` still covered the merging states, so a merging card was protected BY ACCIDENT
while a plain in-progress card was not — which is why the failure looks arbitrary from outside.

CENSUS-INVISIBLE: a `Set` literal is a definition, not a comparison, so nothing in the lifecycle
backlog pointed at this site. Found by grepping for lane-shaped list literals.

---

WHY THIS FILE IS PURELY STRUCTURAL, AND A MISTAKE I MADE TWICE.

My first draft added four "behavioural" cases that built the union themselves from
`resolveLifecycleColumns` and asserted membership. Measured against a revert, **only the structural
case failed** — the other four passed with the fix removed, because they exercised a MIRROR of the
guard rather than the guard. They were really a test of core's `resolveLifecycleColumns`, which has
its own coverage.

That is the same mirrored-implementation trap I caught and deleted in
`analytics-timing-roles-resolved.test.ts` earlier in this program. Twice is a pattern, so the rule is
written down here: **if a test constructs the value the product is supposed to construct, reverting
the product cannot fail it.** Deleted rather than shipped.

The guard sits deep inside `execute()`, behind worktree and session setup a unit test has no business
standing up, so what remains is a source ratchet in the shape this repo already uses for
`engine-no-blocking-shellout`. It fails on revert — verified — and it is not a behavioural proof.
Whoever next touches `execute()`'s test scaffolding should add the end-to-end case.
*/
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../executor.ts", import.meta.url), "utf8");

describe("the stale-spec skip resolves the board's own active lanes", () => {
  /*
  FNXC:WorkflowLifecycleColumns 2026-07-31-13:30:
  RE-POINTED AT MEMBERSHIP, and SCOPED to this site.

  The two cases here pinned the old implementation verbatim —
  `resolveLifecycleColumns(...)` into `activeLifecycle?.wip / .review / .complete`. #2820 replaced
  that with `columnsWithFlag`, and the replacement is a FIX, not churn: `resolveLifecycleColumns`
  returns the FIRST column carrying each trait, so a board with two wip lanes (or a review lane plus a
  second merge-blocking one) had only one of each recognised as active, and a card in the second read
  as INACTIVE — its prompt file treated as reclaimable, which is the interruption this whole file
  exists to prevent. Widening to every column carrying the trait is strictly the safe direction.

  Asserted against a SLICE bounded by this site's own markers rather than the whole file.
  `columnsWithFlag` has four call sites in executor.ts, so a file-wide `toContain` would pass no
  matter what this particular guard does — a guard that cannot fail for its own subject. Both markers
  are proven unique first, because a repeated marker makes the slice meaningless.

  Still a source ratchet, deliberately — see the note at the top of this file on why the behavioural
  mirrors were deleted rather than shipped.
  */
  function activeLaneBlock(): string {
    /* Starts at the IR resolution, which sits one line ABOVE the seed and is part of this site. */
    const from = "const activeIr = await resolveWorkflowIrForTask(this.store, task.id);";
    const to = 'const activeMergeStatuses = new Set(["merging", "merging-pr", "merging-fix"]);';
    const start = source.indexOf(from);
    const end = source.indexOf(to, start + from.length);
    expect(start, "the active-lane IR resolution is gone from executor.ts").toBeGreaterThan(-1);
    expect(end, "the merge-status escape hatch is gone from executor.ts").toBeGreaterThan(start);
    // A repeated marker would silently widen the slice past the site under test.
    expect(source.indexOf(from, start + from.length)).toBe(-1);
    expect(source.indexOf(to, end + to.length)).toBe(-1);
    return source.slice(start, end);
  }

  it("resolves the task's own workflow IR before deciding the skip", () => {
    expect(activeLaneBlock()).toContain("resolveWorkflowIrForTask(this.store, task.id)");
  });

  it("adds EVERY column carrying an active trait, not the first per role", () => {
    const block = activeLaneBlock();
    expect(block).toContain("columnsWithFlag(activeIr, flag)");
    expect(block).toContain("activeColumns.add(lane)");
    for (const flag of ["countsTowardWip", "mergeOrchestration", "mergeBlocker", "humanReview", "complete"]) {
      expect(block, `the active set no longer unions the "${flag}" lanes`).toContain(`"${flag}"`);
    }
    // The first-per-role resolver is what under-reported active lanes; it must not come back here.
    expect(block).not.toContain("resolveLifecycleColumns");
  });

  it("UNIONS rather than replaces, so a degraded IR cannot narrow the set", () => {
    /*
    `resolveWorkflowIrForTask` hands back the BUILT-IN IR on a missing or corrupt definition instead
    of throwing. If this replaced the legacy trio with the resolved lanes, that degraded case would
    silently drop `in-progress` on a board still using it — re-opening the interruption this fixes in
    the one situation hardest to notice. The legacy trio must remain the seed.
    */
    expect(source).toContain('const activeColumns = new Set<string>(["in-progress", "in-review", "done"]);');
  });

  it("keeps the merge-status escape hatch alongside the column check", () => {
    // A merging card was protected by accident before; that protection must survive the conversion
    // rather than be replaced by it.
    expect(source).toContain('const activeMergeStatuses = new Set(["merging", "merging-pr", "merging-fix"]);');
    expect(source).toContain(
      'const isActiveTask = activeColumns.has(task.column) || activeMergeStatuses.has(task.status ?? "");',
    );
  });
});
