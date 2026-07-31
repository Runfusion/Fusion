import { describe, expect, it } from "vitest";
import { boardSummaryCard, boardToDeck, notificationCard, taskToCard } from "../cards.js";

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

  it("creates notification cards", () => {
    const card = notificationCard(task, "entered-column");
    expect(card.id).toBe("notif:FN-1:entered-column");
    expect(card.title.startsWith("In review")).toBe(true);
  });

  /*
  FNXC:WorkflowLifecycleColumns 2026-07-30-02:40:
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
});
