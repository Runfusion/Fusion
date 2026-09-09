/*
FNXC:WorkflowLifecycleColumns 2026-07-31-14:20:

THE INVARIANT: the intake duplicate guard never reuses a FINISHED sibling as the canonical.

THE FIFTH AND LAST inert conversion from the #2787 audit — and the one with the worst blast radius.
`findSameAgentDuplicates` gained `columnFlagsByColumnId` and no caller passed it. On the two
agent-tools paths the cost of a bad match is a bad suggestion. On THIS path a match soft-deletes the
newly created duplicate and removes its directory. So on a renamed board a new task could be deleted
as a duplicate of work that had already finished.

Four of the five audited conversions turned out to have their real defect in the CALLER rather than
in the parameter; this is the fifth, and it holds. The generalisation stands: an optional parameter
no production caller fills is a marker pointing at an unexamined caller.

WHAT THE BEHAVIOURAL CASES DO AND DO NOT COVER, measured rather than assumed. They drive
`findSameAgentDuplicates` directly, so removing the WIRING in `task-creation.ts` leaves them green —
I checked, and they stayed green. They pin the predicate; they cannot pin the caller.

The wiring therefore gets its own structural check at the bottom. That split is deliberate: driving
`resolveSameAgentDuplicateIntake` end to end means an async layer, run-audit writes and filesystem
removal, which is a large harness around a one-line forward. Saying so beats letting three green
behavioural cases imply the wiring is covered — the exact illusion this whole audit was chasing.

REVERT PROOF, measured: restoring the literal fallback fails the renamed-complete case; removing the
`columnFlagsByColumnId:` argument fails the structural case.
*/
import { describe, expect, it } from "vitest";
import { findSameAgentDuplicates } from "../duplicates/duplicate-intake.js";
import type { ColumnRoleTraitFlags } from "../column-roles.js";

const COMPLETE_FLAGS = { complete: true } as unknown as ColumnRoleTraitFlags;
const WIP_FLAGS = { countsTowardWip: true } as unknown as ColumnRoleTraitFlags;

const NOW = Date.parse("2026-07-31T12:00:00Z");

const sibling = (id: string, column: string) => ({
  id,
  column,
  title: "add screenshot upload",
  description: "add screenshot upload to the composer",
  sourceAgentId: "AG-1",
  sourceParentTaskId: "FN-PARENT",
  createdAt: NOW - 60_000,
});

const input = {
  title: "add screenshot upload",
  description: "add screenshot upload to the composer",
  sourceParentTaskId: "FN-PARENT",
};

const run = (cands: ReturnType<typeof sibling>[], flags?: ReadonlyMap<string, ColumnRoleTraitFlags>) =>
  findSameAgentDuplicates(input as never, cands as never, {
    nowMs: NOW,
    sourceAgentId: "AG-1",
    ...(flags ? { columnFlagsByColumnId: flags } : {}),
  });

describe("intake dedup excludes finished siblings on a renamed board", () => {
  it("does not match a sibling in a RENAMED complete lane", async () => {
    // Pre-fix this matched, and the intake path then soft-deleted the NEW task.
    const matches = run([sibling("FN-DONE", "shipped")], new Map([["shipped", COMPLETE_FLAGS]]));

    expect(matches.map((m) => m.id)).toEqual([]);
  });

  it("still matches a live sibling — the guard must keep working", async () => {
    // The positive case is what makes the negative one evidence rather than an empty result.
    const matches = run([sibling("FN-LIVE", "building")], new Map([["building", WIP_FLAGS]]));

    expect(matches.map((m) => m.id)).toEqual(["FN-LIVE"]);
  });

  it("keeps the legacy ids when no flags are supplied", async () => {
    expect(run([sibling("FN-DONE", "done")]).map((m) => m.id)).toEqual([]);
    expect(run([sibling("FN-LIVE", "in-progress")]).map((m) => m.id)).toEqual(["FN-LIVE"]);
  });
});

describe("the intake path actually forwards the resolved flags", () => {
  it("passes columnFlagsByColumnId into findSameAgentDuplicates", () => {
    /*
    The behavioural cases above cannot see this — they call the predicate directly. An unforwarded
    option is precisely the class this audit found five times, so the forward gets its own guard
    rather than being assumed from a green predicate test.
    */
    const source = readFileSync(new URL("../task-store/task-creation.ts", import.meta.url), "utf8");

    expect(source).toContain("columnFlagsByColumnId: await resolveIntakeDuplicateColumnFlags(store, allCandidates)");
    expect(source).toContain("resolveTaskLifecycleColumns(store, candidate.id, irCache)");
  });
});

import { readFileSync } from "node:fs";
