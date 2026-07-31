import { describe, expect, it } from "vitest";
import type { Task } from "@fusion/core";
import { boardSummaryCard, boardToDeck, notificationCard, statusBadge, taskToCard } from "../cards.js";

const task = {
  id: "FN-1",
  title: "Ship",
  description: "desc",
  column: "in-review",
  updatedAt: "2026-01-01T00:00:00.000Z",
  dependencies: [],
  steps: [],
  currentStep: 1,
  log: [],
} as any;

describe("cards", () => {
  it("maps task to card", () => {
    const card = taskToCard(task);
    expect(card.kind).toBe("task");
    expect(card.badge).toBe("in-review");
    expect(card.taskId).toBe("FN-1");
  });

  it("creates board summary", () => {
    const card = boardSummaryCard({ todo: 2, done: 1 });
    expect(card.lines).toContain("todo: 2");
  });

  /*
  FNXC:WorkflowLifecycleColumns 2026-07-30-22:20:
  THE INVARIANT: the summary card reports the lanes the board HAS, whatever they are called.

  Untested before this — the only summary coverage above exercises `boardSummaryCard`, an export no
  production file calls, while the card the deck actually ships (`boardSummaryCardFromCounts`, via
  `boardToDeck`) had none. That gap is why five hardcoded lane ids survived here.

  Reverted, the first case reports `Triage 0 Todo 0 Doing 0 Review 0 Done 0` for a board holding four
  live cards and fails on every assertion below; the second still carries the dead `Triage 0`.
  */
  it("summarises a renamed board by its real lanes, not the legacy five", () => {
    const renamed = ["backlog", "backlog", "building", "shipped"].map((column, i) => ({
      ...task,
      id: `FN-${i + 10}`,
      column,
    }));

    const text = boardToDeck(renamed, { terminalColumns: new Set(["shipped"]) }).cards[0]!.lines.join(" ");

    expect(text).toContain("backlog 2");
    expect(text).toContain("building 1");
    expect(text).toContain("shipped 1");
    expect(text).not.toContain("Todo 0");
    expect(text).not.toMatch(/Triage/);
  });

  it("drops the triage lane U11 deleted instead of spending display width on it", () => {
    const text = boardToDeck([{ ...task, column: "todo" }], {}).cards[0]!.lines.join(" ");

    expect(text).toContain("Todo 1");
    expect(text).not.toMatch(/Triage/);
  });

  it("says so plainly when no lane holds work, rather than rendering an empty line", () => {
    expect(boardToDeck([], {}).cards[0]!.lines.join(" ")).toBe("No active work");
  });

  it("creates notification cards", () => {
    const card = notificationCard(task, "entered-column");
    expect(card.id).toBe("notif:FN-1:entered-column");
    expect(card.title.startsWith("In review")).toBe(true);
  });

  /*
  FNXC:WorkflowLifecycleColumns 2026-07-31-02:40:
  THE INVARIANT: a finished card never occupies a deck slot, whatever its lane is called.

  `boardToDeck` filtered on the literals `archived`/`done`, and the consequence on a renamed board is
  not a wrong label — the deck is CAPPED at `maxCards`, so every completed card counted as active and
  pushed real work off the glasses display. The wearer sees fewer live tasks the more the team
  finishes, which reads as "nothing is happening" rather than as a bug.

  `maxCards: 2` is the whole point of the fixture: one summary card plus exactly one task slot, so a
  finished card that is not filtered out DISPLACES the live one instead of merely joining it. A
  larger cap would let both through and the case would pass either way.

  REVERT PROOF, measured: restore the two literals and this fails with
  `expected 'FN-SHIPPED' to be 'FN-LIVE'` — the finished card takes the only slot.
  */
  it("does not let a card in a RENAMED complete lane displace live work", () => {
    const row = (id: string, column: string, updatedAt: string) =>
      ({ ...task, id, column, updatedAt }) as never;

    const deck = boardToDeck(
      [row("FN-SHIPPED", "shipped", "2026-01-02T00:00:00.000Z"), row("FN-LIVE", "building", "2026-01-01T00:00:00.000Z")],
      { maxCards: 2, terminalColumns: new Set(["shipped", "vault"]) },
    );

    expect(deck.cards.map((c) => c.id)).toEqual(["summary", "FN-LIVE"]);
  });

  it("keeps the legacy done/archived lanes when the caller resolved nothing", () => {
    // The degraded default must still hold — most boards never rename anything.
    const row = (id: string, column: string) => ({ ...task, id, column }) as never;

    const deck = boardToDeck([row("FN-DONE", "done"), row("FN-ARCH", "archived"), row("FN-LIVE", "todo")], { maxCards: 5 });

    expect(deck.cards.map((c) => c.id)).toEqual(["summary", "FN-LIVE"]);
  });
  /*
  FNXC:WorkflowLifecycleColumns 2026-07-31-11:05:
  THE INVARIANT: a card's badge names its OWN lane, and never asserts a lane it is not in.

  `statusBadge` fell back to the literal `"todo"` whenever `COLUMN_BADGES` missed, so on a renamed
  board EVERY card badged `todo` — a card in review told the wearer it was un-started. On a display
  with room for one word, a confident wrong answer is worse than an unrecognised one.

  Missed by #2968, which fixed the summary counts in this same file without looking one function
  further at the badge those counts sit above.

  Reverted, both cases below come back as "todo".
  */
  it("badges an unrecognised lane with its own name, not the legacy default", () => {
    expect(statusBadge("checking" as Task["column"])).toBe("checking");
    expect(taskToCard({ ...task, column: "building" } as Task).badge).toBe("building");
  });

  it("still badges the legacy ids exactly as before", () => {
    expect(statusBadge("in-review")).toBe("in-review");
    expect(statusBadge("done")).toBe("done");
  });
});
