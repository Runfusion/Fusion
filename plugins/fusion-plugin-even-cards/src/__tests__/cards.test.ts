import { describe, expect, it } from "vitest";
import { boardToDeck } from "../cards/board-cards.js";
import { formatRelativeAge, formatTaskId, statusBadge, truncateLine, wrapLines } from "../cards/format.js";
import { taskToCard } from "../cards/task-cards.js";
import type { FusionTask } from "../cards/types.js";

function makeTask(id: string, column: FusionTask["column"], updatedAt: string): FusionTask {
  return {
    id,
    description: `Task ${id}`,
    title: `Title ${id}`,
    column,
    status: "pending",
    priority: "normal",
    currentStep: 0,
    steps: [],
    dependencies: [],
    createdAt: "2026-05-08T10:00:00.000Z",
    updatedAt,
  } as FusionTask;
}

describe("cards format", () => {
  it("truncates at boundary", () => {
    expect(truncateLine("12345", 5)).toBe("12345");
    expect(truncateLine("123456", 5)).toBe("1234…");
  });

  it("wraps across lines", () => {
    expect(wrapLines("one two three four", 7, 3)).toEqual(["one two", "three", "four"]);
  });

  it("formats task id and relative age", () => {
    expect(formatTaskId("fn-42")).toBe("FN-42");
    expect(formatRelativeAge("2026-05-08T11:58:00.000Z", "2026-05-08T12:00:00.000Z")).toBe("2m");
  });

  it("maps all task columns to badges", () => {
    expect(statusBadge("triage").tone).toBe("triage");
    expect(statusBadge("todo").tone).toBe("todo");
    expect(statusBadge("in-progress").tone).toBe("in-progress");
    expect(statusBadge("in-review").tone).toBe("in-review");
    expect(statusBadge("done").tone).toBe("done");
    expect(statusBadge("archived").tone).toBe("neutral");
  });
});

describe("board deck", () => {
  it("summarizes counts and handles empty board", () => {
    const deck = boardToDeck([], { now: "2026-05-08T12:00:00.000Z" });
    expect(deck.cards).toHaveLength(1);
    expect(deck.summary.counts.todo).toBe(0);
  });

  it("creates a task card", () => {
    const card = taskToCard(makeTask("FN-7", "in-review", "2026-05-08T12:00:00.000Z"), { now: "2026-05-08T12:10:00.000Z" });
    expect(card.id).toBe("FN-7");
    expect(card.badge.tone).toBe("in-review");
    expect(card.lines.join(" ")).toContain("Assignee unassigned");
  });

  it("caps deck and sorts deterministically", () => {
    const tasks: FusionTask[] = [
      makeTask("FN-1", "todo", "2026-05-08T11:00:00.000Z"),
      makeTask("FN-9", "in-progress", "2026-05-08T11:00:00.000Z"),
      makeTask("FN-2", "done", "2026-05-08T12:00:00.000Z"),
      makeTask("FN-3", "archived", "2026-05-08T12:00:00.000Z"),
    ];
    const deck = boardToDeck(tasks, { maxCards: 3, now: "2026-05-08T12:00:00.000Z" });

    expect(deck.cards).toHaveLength(3);
    expect(deck.cards[1].id).toBe("FN-9");
    expect(deck.cards[2].id).toBe("FN-1");
  });
});
