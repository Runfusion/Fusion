import { describe, expect, it } from "vitest";
import { notificationCard } from "../cards.js";

const baseTask = {
  id: "FN-1",
  description: "Desc",
  title: "Ship a very long feature title for notification card behavior",
  column: "in-review",
  updatedAt: "2026-05-08T10:00:00.000Z",
  dependencies: [],
  steps: [],
  currentStep: 1,
  log: [],
} as const;

describe("notificationCard", () => {
  it.each([
    ["entered-column", "In review ·"],
    ["new-task", "New task ·"],
    ["left-column", "Moved out ·"],
    ["completed", "Done ·"],
  ] as const)("prefixes %s", (reason, prefix) => {
    const card = notificationCard(baseTask as never, reason, { now: () => new Date("2026-05-08T10:01:00.000Z") });
    expect(card.title.startsWith(prefix)).toBe(true);
    expect(card.badge).toBe("in-review");
  });

  it("truncates title boundary", () => {
    const card = notificationCard(baseTask as never, "new-task", { maxCharsPerLine: 16 });
    expect(card.title).toContain("…");
  });

  it("is deterministic with fixed now", () => {
    const now = () => new Date("2026-05-08T10:05:00.000Z");
    const a = notificationCard(baseTask as never, "completed", { now });
    const b = notificationCard(baseTask as never, "completed", { now });
    expect(a).toEqual(b);
    expect(a.lines[1]).toBe("updated 5m ago");
  });
});
