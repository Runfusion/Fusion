/*
FNXC:WorkflowLifecycleColumns 2026-07-29-13:10 (evidence for `columnIsIntakeOrHold`):

`live-agent-count.ts`'s waiting predicate is the last converted site in this program with NO
executable evidence. My own unproven-sites ledger listed it as unreachable because "its consumers
are dashboard-side" — which is a statement about the LANE, not about provability. It has exactly
one consumer, `deriveStatsFromTasks`, and that is an exported pure function, so the narrow seam
FN-5048 asks for is right here. Correcting the ledger rather than leaving the site unproven.

WHAT THIS PINS. `isWaitingAgentTask` resolves membership as:

    task.columnIsIntakeOrHold ?? (task.column === "triage" || task.column === "todo")

so the footer's queued total is correct on a renamed or merged board ONLY while flags are supplied
for the card's column. The code says as much in prose:

    "These id fallbacks are REACHABLE, not fixture-only ... A card in such a column then matches no
     arm and is counted as neither running nor waiting, so the footer's queued total under-reports
     it."

That is an admitted, operator-visible defect deliberately left unconverted, because converting it
means deciding what an ABSENT flag set should mean and either choice moves a visible count. The
last case below is therefore a CHARACTERIZATION test: it asserts the undercount as it exists today
so the admission is executable instead of a comment, and so the number cannot drift further
without a test turning red. It is not an endorsement — if the fallback is ever converted, that case
is expected to change, and the comment explains what to change it to.
*/
import { describe, it, expect } from "vitest";
import type { Task } from "@fusion/core";
import { deriveStatsFromTasks } from "../useExecutorStats";

type Flags = Parameters<typeof deriveStatsFromTasks>[3] extends ReadonlyMap<string, infer F> ? F : never;

function card(id: string, column: string): Task {
  return { id, column, description: `card ${id}`, title: `card ${id}` } as unknown as Task;
}

/** A renamed board: no id overlaps the legacy enum, so a literal fallback goes silent here. */
const RENAMED_HOLD = "backlog";
/** The U11 merged lane: one column carrying BOTH intake and hold. */
const MERGED_LANE = "planning";

describe("footer queued count resolves the intake/hold ROLE, not the legacy column ids", () => {
  it("counts a card in a RENAMED hold lane as queued when flags are supplied", () => {
    const flags = new Map<string, Flags>([[RENAMED_HOLD, { hold: true } as Flags]]);

    const stats = deriveStatsFromTasks([card("FN-Q-1", RENAMED_HOLD)], undefined, undefined, flags);

    expect(stats.queuedTaskCount).toBe(1);
  });

  it("counts a card in the MERGED intake+hold lane exactly ONCE", () => {
    /* The merged shape's specific hazard: the predicate is `intake === true || hold === true`, and
       both are true here. An implementation that added a count per matching role rather than per
       card would double-count every card on the post-U11 default board. */
    const flags = new Map<string, Flags>([[MERGED_LANE, { intake: true, hold: true } as Flags]]);

    const stats = deriveStatsFromTasks([card("FN-Q-2", MERGED_LANE)], undefined, undefined, flags);

    expect(stats.queuedTaskCount).toBe(1);
  });

  it("does NOT count a card whose resolved lane is neither intake nor hold", () => {
    /* The differential. Without it, every assertion above would also pass for a predicate that
       counted all cards — which is how this guard could go dead while looking covered. */
    const flags = new Map<string, Flags>([["building", { countsTowardWip: true } as Flags]]);

    const stats = deriveStatsFromTasks([card("FN-Q-3", "building")], undefined, undefined, flags);

    expect(stats.queuedTaskCount).toBe(0);
  });

  it("counts a legacy-id card with no flags at all, via the documented fallback", () => {
    /* The fallback's INTENDED use: an unresolved column on the legacy board still counts. This is
       the behaviour the fallback exists to preserve, so it is pinned separately from the defect
       below — otherwise a conversion could delete both and only one test would notice. */
    const stats = deriveStatsFromTasks([card("FN-Q-4", "todo")], undefined, undefined, undefined);

    expect(stats.queuedTaskCount).toBe(1);
  });

  it("CHARACTERIZATION — under-reports a RENAMED hold lane when no flags are supplied", () => {
    /*
    The admitted defect, made executable. `columnIsIntakeOrHold` is undefined with no flags, so the
    `??` falls through to the legacy pair, which a renamed board does not contain: the card is
    counted as neither running nor waiting and the operator's queued total is short by one.

    Asserting the WRONG-but-current number deliberately. If the fallback is converted to resolve
    the role (or to treat an absent flag set as intake), this expectation becomes 1 and this test
    is the one that tells you the operator-visible count moved.
    */
    const stats = deriveStatsFromTasks([card("FN-Q-5", RENAMED_HOLD)], undefined, undefined, undefined);

    expect(stats.queuedTaskCount).toBe(0);
    // ...and it is not silently absorbed into another bucket either — it vanishes from all of them.
    expect(stats.runningTaskCount).toBe(0);
  });
});
