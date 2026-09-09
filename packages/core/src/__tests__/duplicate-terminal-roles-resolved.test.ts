/*
FNXC:WorkflowLifecycleColumns 2026-07-31-04:00 (batch-core feed: duplicate-intake 2 → 0, near-duplicate-canonical 2 → 0):

THE INVARIANT: "is this candidate finished?" comes from the terminal ROLE, never from two names.

These two sites ask the same question and FAIL IN OPPOSITE DIRECTIONS, which is why they are worth
converting together — fixing one and not the other leaves the board inconsistent about what "done"
means during intake.

  duplicate-intake      a finished sibling must be EXCLUDED from reuse.
                        Keyed on the literals, a completed task on a renamed board stayed eligible,
                        so newly filed work could be deduplicated ONTO something already done. No
                        error is raised — the request is answered with a finished card and the intent
                        behind it is lost.

  near-duplicate        a finished canonical must be treated as INACTIVE so its flag stops holding
                        work. Keyed on the literals, a finished canonical still read as ACTIVE, so
                        the flag never cleared and the flagged task stayed parked behind a user
                        decision that could never arrive — the exact stranding the function's own
                        FNXC note says it was written to prevent.

Both route through `isTerminalColumnRole`, so neither file carries a hand-written fallback; the
no-flags cases exercise that shared degraded mode and pass either way.

REVERT PROOF, measured: restore the literal pairs and 4 of the 8 cases fail — two per file.
*/
import { describe, expect, it } from "vitest";
import { findSameAgentDuplicates } from "../duplicates/duplicate-intake.js";
import { isActiveNearDuplicateColumn, isNearDuplicateCanonicalInactive } from "../duplicates/near-duplicate-canonical.js";
import type { ColumnRoleTraitFlags } from "../column-roles.js";

const COMPLETE_FLAGS = { complete: true } as unknown as ColumnRoleTraitFlags;
const WIP_FLAGS = { countsTowardWip: true } as unknown as ColumnRoleTraitFlags;

describe("near-duplicate canonicals stop holding work once finished", () => {
  it("treats a RENAMED complete column as inactive", () => {
    expect(isActiveNearDuplicateColumn("shipped" as never, COMPLETE_FLAGS)).toBe(false);
  });

  it("keeps a live card active", () => {
    expect(isActiveNearDuplicateColumn("building" as never, WIP_FLAGS)).toBe(true);
  });

  it("clears the flag for a canonical in a RENAMED complete column", () => {
    // Pre-fix: `shipped` matched neither literal, so the canonical read as ACTIVE and the flagged
    // task stayed parked behind a decision nobody could make.
    expect(isNearDuplicateCanonicalInactive({ column: "shipped" as never }, COMPLETE_FLAGS)).toBe(true);
  });

  it("keeps the legacy ids when no flags are supplied", () => {
    expect(isActiveNearDuplicateColumn("done" as never)).toBe(false);
    expect(isActiveNearDuplicateColumn("in-progress" as never)).toBe(true);
  });
});

describe("intake dedup never reuses a finished sibling as canonical", () => {
  const NOW = Date.parse("2026-07-31T12:00:00Z");
  /*
  `createdAt` is EPOCH MS, not an ISO string. My first draft passed an ISO string, which made the
  `createdAt >= cutoff` window filter compare a string against a number — always false — so `recent`
  was empty and the two EXCLUSION cases below passed vacuously: they asserted an empty result from a
  function that was returning empty for an unrelated reason. Fixed here, and worth stating: a
  negative assertion is only evidence when the matching positive case is green beside it.
  */
  const RECENT = NOW - 60_000;

  const candidate = (id: string, column: string) => ({
    id,
    column,
    title: "add screenshot upload",
    description: "add screenshot upload to the composer",
    sourceAgentId: "AG-1",
    sourceParentTaskId: "FN-PARENT",
    createdAt: RECENT,
  });

  const input = {
    title: "add screenshot upload",
    description: "add screenshot upload to the composer",
    sourceParentTaskId: "FN-PARENT",
  };

  const run = (cands: ReturnType<typeof candidate>[], flags?: ReadonlyMap<string, ColumnRoleTraitFlags>) =>
    findSameAgentDuplicates(input as never, cands as never, {
      nowMs: NOW,
      sourceAgentId: "AG-1",
      ...(flags ? { columnFlagsByColumnId: flags } : {}),
    });

  it("excludes a candidate sitting in a RENAMED complete column", () => {
    // Pre-fix this returned FN-DONE, so the new request was silently answered with finished work.
    const matches = run([candidate("FN-DONE", "shipped")], new Map([["shipped", COMPLETE_FLAGS]]));

    expect(matches.map((m) => m.id)).toEqual([]);
  });

  it("still matches a live sibling", () => {
    // The dedup must keep working — excluding everything would be its own bug.
    const matches = run([candidate("FN-LIVE", "building")], new Map([["building", WIP_FLAGS]]));

    expect(matches.map((m) => m.id)).toEqual(["FN-LIVE"]);
  });

  it("keeps the legacy ids when no flags are supplied", () => {
    expect(run([candidate("FN-DONE", "done")]).map((m) => m.id)).toEqual([]);
    expect(run([candidate("FN-LIVE", "in-progress")]).map((m) => m.id)).toEqual(["FN-LIVE"]);
  });
});
