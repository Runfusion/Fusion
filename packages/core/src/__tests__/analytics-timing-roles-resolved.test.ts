/*
FNXC:WorkflowLifecycleColumns 2026-07-31-03:20 (batch-core feed: team-analytics 2 → 0, workflow-analytics 2 → 0, task-timing 1 → 0):

THE INVARIANT: metrics count a card's lane by its ROLE, never by its name.

All three failures produce a NUMBER, not an error, which is why they are the worst kind:

  - both analytics surfaces reported `tasksInProgress: 0` and `tasksInReview: 0` on a renamed board,
    sitting beside token and cost totals that were entirely correct. A zero next to a populated cost
    column reads as "nobody is working", not as "this metric is broken";
  - `getTotalAgentActiveMs` dropped the LIVE execution segment, so the task an agent is working on
    right now under-reported by exactly the elapsed time of the current run — and it healed itself
    the moment the card moved on and the segment was persisted into `cumulativeActiveMs`. A metric
    that is wrong only while you are watching it is close to unreportable as a bug.

All three convert onto `column-roles.ts`, whose helpers own the legacy-id degraded mode, so none of
these files carries a hand-written fallback. The no-flags cases below exercise that degraded mode and
pass either way — they are not evidence for the change, only for the compatibility claim.

REVERT PROOF, measured: restore the three literal comparisons and 4 of the 7 cases fail — two
behavioural cases in `task-timing`, plus the structural ratchet on each analytics file.
*/
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getTotalAgentActiveMs } from "../tasks/task-timing.js";
import type { ColumnRoleTraitFlags } from "../column-roles.js";

const WIP_FLAGS = { countsTowardWip: true } as unknown as ColumnRoleTraitFlags;
const REVIEW_FLAGS = { mergeBlocker: true } as unknown as ColumnRoleTraitFlags;

const NOW = Date.parse("2026-07-31T12:00:00Z");
const STARTED = "2026-07-31T11:00:00Z";
const ONE_HOUR = 60 * 60 * 1000;

describe("getTotalAgentActiveMs counts the live segment in the board's own wip lane", () => {
  it("includes the in-flight run for a RENAMED wip lane", () => {
    // Pre-fix: `building` !== "in-progress", so the hour currently being worked was simply absent.
    const total = getTotalAgentActiveMs(
      { column: "building", cumulativeActiveMs: 0, executionStartedAt: STARTED } as never,
      NOW,
      WIP_FLAGS,
    );

    expect(total).toBe(ONE_HOUR);
  });

  it("does NOT count a live segment for a card outside the wip lane", () => {
    // The gate must still gate: a stale executionStartedAt on a review card is not active time.
    const total = getTotalAgentActiveMs(
      { column: "signoff", cumulativeActiveMs: 0, executionStartedAt: STARTED } as never,
      NOW,
      REVIEW_FLAGS,
    );

    expect(total).toBe(0);
  });

  it("keeps the legacy id when no flags are supplied", () => {
    const total = getTotalAgentActiveMs(
      { column: "in-progress", cumulativeActiveMs: 0, executionStartedAt: STARTED } as never,
      NOW,
    );

    expect(total).toBe(ONE_HOUR);
  });

  it("still returns null when the card has no timing data at all", () => {
    // Guards the null contract: "no data" must not become 0, which would read as "worked zero time".
    const total = getTotalAgentActiveMs({ column: "building" } as never, NOW, WIP_FLAGS);

    expect(total).toBeNull();
  });

  it("adds persisted execution time to the live segment rather than replacing it", () => {
    const total = getTotalAgentActiveMs(
      { column: "building", cumulativeActiveMs: ONE_HOUR, executionStartedAt: STARTED } as never,
      NOW,
      WIP_FLAGS,
    );

    expect(total).toBe(2 * ONE_HOUR);
  });
});

/*
The two analytics aggregators take a live SQL layer, so driving them here would mean standing up
PostgreSQL to re-assert a two-line substitution.

My first draft instead re-implemented their tally loop in the test and asserted THAT. It would have
passed with both source files reverted — it tested a copy, not the shipped code. Deleted rather than
shipped: a mirrored implementation is not coverage, it is a second place for the bug to be absent.

What replaces it is a STRUCTURAL ratchet over the real source, in the shape this repo already uses
for `engine-no-blocking-shellout`: the converted lines must call the role helpers, and the literal
comparisons must be gone. It fails on revert — verified by reverting — and it is honest about being
structural rather than behavioural. The behavioural guarantee for these two lines comes from
`column-roles.ts`'s own tests, which is the point of routing through a shared helper.
*/
describe("the analytics wip/review tallies key on role, not name", () => {
  const read = (relative: string): string =>
    readFileSync(new URL(relative, import.meta.url), "utf8");

  for (const file of ["../board/team-analytics.ts", "../board/workflow-analytics.ts"]) {
    it(`${file} tallies via the role helpers and holds no lane literal`, () => {
      const source = read(file);

      expect(source).toContain("isWipColumnRole(columnFlags, row.columnName)");
      expect(source).toContain("isReviewColumnRole(columnFlags, row.columnName)");
      expect(source).not.toContain('row.columnName === "in-progress"');
      expect(source).not.toContain('row.columnName === "in-review"');
    });
  }
});
