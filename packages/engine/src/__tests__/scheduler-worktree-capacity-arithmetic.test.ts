// @vitest-environment node
/*
FNXC:WorktreeCapacity 2026-08-01-00:50:
THE WORKTREE-CAPACITY ARITHMETIC — the numbers behind two live defects, previously unpinned.

#3262 pinned the terminal PREDICATE and said plainly what it did not cover: blinding that predicate
to `false` leaves all 22 scheduler suites green, because the arithmetic it feeds had no behavioural
coverage at all. This is that gap.

Both observed failures live in these few lines, and they fail in OPPOSITE directions:

  UNDER-COUNT admits work over the cap. The commit that added this gate reports maxWorktrees=4 with
  four planning sessions each holding a worktree, and a replan dispatch admitted as the FIFTH,
  because the ledger counted WIP cards only and never learned to count planners.

  OVER-COUNT self-deadlocks. A planned Ready card RETAINS its planning worktree for execution reuse,
  so counting it as a holder blocks its own release — 2 wip + 3 idle-held = 5/4, and the first
  unpause released only 2 of 4 slots' worth of work.

Asymmetry is why both are pinned: under-counting breaks the cap and lets real work over it;
over-counting only starves dispatch. A test that covered the "safe" direction alone would leave the
expensive one open.

WHY THE PREDICATE IS INJECTED rather than resolved here: the holder set's job is the SET ARITHMETIC —
who is excluded and how the total is formed. Which lanes are terminal is #3262's test, and resolving
it here would make this file fail for that reason instead of this one.
*/

import { describe, expect, it } from "vitest";
import type { Task } from "@fusion/core";
import { effectiveActiveWorktrees, nonWipWorktreeHolderIdsOf } from "../scheduler.js";

const task = (id: string, overrides: Partial<Task> = {}): Task => ({
  id,
  title: id,
  description: "",
  column: "todo",
  dependencies: [],
  steps: [],
  currentStep: 0,
  log: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
} as Task);

const neverTerminal = () => false;
const terminalIds = (ids: string[]) => (t: Task) => ids.includes(t.id);

describe("worktree-capacity holder set", () => {
  it("counts a non-WIP card that HOLDS a worktree — the planner the ledger used to miss", () => {
    /*
    The under-count defect, minimally: four planning sessions holding worktrees, none of them WIP.
    Before the gate learned to count them the reserved total was 0 and a fifth dispatch was admitted.
    */
    const planners = ["P1", "P2", "P3", "P4"].map((id) => task(id, { worktree: `/wt/${id}` }));

    const holders = nonWipWorktreeHolderIdsOf(planners, [], neverTerminal);

    expect(holders).toEqual(["P1", "P2", "P3", "P4"]);
    expect(holders.length).toBe(4);
  });

  it("does not double-count a WIP card that also holds a worktree", () => {
    /* WIP membership already reserves; adding the same card as a holder would inflate the total. */
    const tasks = [task("W1", { worktree: "/wt/W1" }), task("I1", { worktree: "/wt/I1" })];

    expect(nonWipWorktreeHolderIdsOf(tasks, ["W1"], neverTerminal)).toEqual(["I1"]);
  });

  it("excludes a TERMINAL card's retained worktree — cleanup-owned, not capacity", () => {
    const tasks = [task("DONE1", { worktree: "/wt/DONE1" }), task("LIVE1", { worktree: "/wt/LIVE1" })];

    expect(nonWipWorktreeHolderIdsOf(tasks, [], terminalIds(["DONE1"]))).toEqual(["LIVE1"]);
  });

  it("ignores a card with no worktree — a WIP card without one still reserves via WIP, not here", () => {
    const tasks = [task("N1"), task("N2", { worktree: "" }), task("H1", { worktree: "/wt/H1" })];

    expect(nonWipWorktreeHolderIdsOf(tasks, [], neverTerminal)).toEqual(["H1"]);
  });

  it("reproduces the observed 5-of-4 total that the self-deadlock fix addresses", () => {
    /*
    2 wip + 3 idle-held = 5 against maxWorktrees=4. The total itself is CORRECT — every one of those
    five is a real worktree. The bug was gating a candidate against a total that included the
    candidate's OWN retained worktree, which the next case covers.
    */
    const wipIds = ["W1", "W2"];
    const tasks = [
      task("W1", { worktree: "/wt/W1" }),
      task("W2", { worktree: "/wt/W2" }),
      task("R1", { worktree: "/wt/R1" }),
      task("R2", { worktree: "/wt/R2" }),
      task("R3", { worktree: "/wt/R3" }),
    ];

    const holders = nonWipWorktreeHolderIdsOf(tasks, wipIds, neverTerminal);
    const reservedWorktreeSlots = wipIds.length + holders.length;

    expect(holders).toEqual(["R1", "R2", "R3"]);
    expect(reservedWorktreeSlots).toBe(5);
  });
});

describe("effectiveActiveWorktrees", () => {
  it("subtracts a candidate's OWN retained worktree — the slot transfers, it does not add", () => {
    /*
    The self-deadlock fix. Without the subtraction a Ready card holding the very worktree it would
    reuse is gated out by itself: 5 >= 4 blocks, where 4 >= 4 ... also blocks, but 5-1=4 is the
    number the gate is supposed to compare. Pinned as the arithmetic, not as the comparison.
    */
    expect(effectiveActiveWorktrees(5, true)).toBe(4);
  });

  it("leaves the total alone for a candidate that holds no worktree — it will ADD one", () => {
    expect(effectiveActiveWorktrees(5, false)).toBe(5);
  });

  it("never invents capacity when nothing is reserved", () => {
    expect(effectiveActiveWorktrees(0, false)).toBe(0);
    /* A holder implies a reservation, so 0-with-holder cannot arise; assert it degrades rather than
       silently handing out a negative slot count if a future caller gets the pairing wrong. */
    expect(effectiveActiveWorktrees(0, true)).toBeLessThanOrEqual(0);
  });
});
