import { describe, expect, it, vi } from "vitest";
import type { Goal } from "@fusion/core";
import {
  buildGoalContextSection,
  DEFAULT_GOAL_INJECTION_CHAR_BUDGET,
} from "../goals/goal-context-injector.js";

function goal(id: string, title: string, createdAt: string): Goal {
  return {
    id,
    title,
    description: undefined,
    status: "active",
    createdAt,
    updatedAt: createdAt,
  };
}

describe("buildGoalContextSection", () => {
  it("returns empty payload for empty input", () => {
    expect(buildGoalContextSection({ activeGoals: [] })).toEqual({
      text: "",
      emittedGoalIds: [],
      truncated: null,
    });
  });

  it("renders one goal with header and no truncation", () => {
    const result = buildGoalContextSection({
      activeGoals: [goal("G-001", "Ship MVP", "2026-01-01T00:00:00.000Z")],
    });

    expect(result.text).toBe("## Active Goals\n\n- G-001: Ship MVP");
    expect(result.emittedGoalIds).toEqual(["G-001"]);
    expect(result.truncated).toBeNull();
  });

  it("emits exactly five goals in createdAt ascending order", () => {
    const result = buildGoalContextSection({
      activeGoals: [
        goal("G-001", "A", "2026-01-01T00:00:00.000Z"),
        goal("G-002", "B", "2026-01-02T00:00:00.000Z"),
        goal("G-003", "C", "2026-01-03T00:00:00.000Z"),
        goal("G-004", "D", "2026-01-04T00:00:00.000Z"),
        goal("G-005", "E", "2026-01-05T00:00:00.000Z"),
      ],
    });

    expect(result.emittedGoalIds).toEqual(["G-001", "G-002", "G-003", "G-004", "G-005"]);
    expect(result.truncated).toBeNull();
  });

  it("caps at five and emits cap truncation event", () => {
    const onTruncated = vi.fn();
    const result = buildGoalContextSection({
      activeGoals: [
        goal("G-001", "A", "2026-01-01T00:00:00.000Z"),
        goal("G-002", "B", "2026-01-02T00:00:00.000Z"),
        goal("G-003", "C", "2026-01-03T00:00:00.000Z"),
        goal("G-004", "D", "2026-01-04T00:00:00.000Z"),
        goal("G-005", "E", "2026-01-05T00:00:00.000Z"),
        goal("G-006", "F", "2026-01-06T00:00:00.000Z"),
        goal("G-007", "G", "2026-01-07T00:00:00.000Z"),
      ],
      onTruncated,
    });

    expect(result.emittedGoalIds).toEqual(["G-001", "G-002", "G-003", "G-004", "G-005"]);
    expect(result.truncated?.reason).toBe("cap");
    expect(result.truncated?.droppedGoalIds).toEqual(["G-006", "G-007"]);
    expect(onTruncated).toHaveBeenCalledTimes(1);
  });

  it("never exceeds injector cap even when caller maxGoals is larger", () => {
    const result = buildGoalContextSection({
      activeGoals: [
        goal("G-001", "A", "2026-01-01T00:00:00.000Z"),
        goal("G-002", "B", "2026-01-02T00:00:00.000Z"),
        goal("G-003", "C", "2026-01-03T00:00:00.000Z"),
        goal("G-004", "D", "2026-01-04T00:00:00.000Z"),
        goal("G-005", "E", "2026-01-05T00:00:00.000Z"),
        goal("G-006", "F", "2026-01-06T00:00:00.000Z"),
      ],
      maxGoals: 10,
    });

    expect(result.emittedGoalIds).toHaveLength(5);
  });

  it("uses id ascending tiebreaker when createdAt is identical", () => {
    const result = buildGoalContextSection({
      activeGoals: [
        goal("G-200", "Later ID", "2026-01-01T00:00:00.000Z"),
        goal("G-100", "Earlier ID", "2026-01-01T00:00:00.000Z"),
      ],
    });

    expect(result.emittedGoalIds).toEqual(["G-100", "G-200"]);
  });

  it("sanitizes title whitespace and embedded newlines", () => {
    const result = buildGoalContextSection({
      activeGoals: [goal("G-001", "  Multi\n line\n title  ", "2026-01-01T00:00:00.000Z")],
    });

    expect(result.text).toBe("## Active Goals\n\n- G-001: Multi line title");
  });

  it("drops newest goals first under budget pressure", () => {
    const onTruncated = vi.fn();
    const result = buildGoalContextSection({
      activeGoals: [
        goal("G-001", "Alpha", "2026-01-01T00:00:00.000Z"),
        goal("G-002", "Bravo", "2026-01-02T00:00:00.000Z"),
        goal("G-003", "Charlie", "2026-01-03T00:00:00.000Z"),
        goal("G-004", "Delta", "2026-01-04T00:00:00.000Z"),
        goal("G-005", "Echo", "2026-01-05T00:00:00.000Z"),
      ],
      charBudget: 45,
      onTruncated,
    });

    expect(result.truncated?.reason).toBe("budget");
    expect(result.emittedGoalIds).toEqual(["G-001"]);
    expect(result.truncated?.droppedGoalIds).toEqual(["G-005", "G-004", "G-003", "G-002"]);
    expect(result.truncated?.producedChars).toBe(result.text.length);
    expect(result.text.length <= 45 || result.emittedGoalIds.length === 1).toBe(true);
    expect(onTruncated).toHaveBeenCalledTimes(1);
  });

  it("emits a single budget truncation event when cap and budget both apply", () => {
    const result = buildGoalContextSection({
      activeGoals: [
        goal("G-001", "Alpha", "2026-01-01T00:00:00.000Z"),
        goal("G-002", "Bravo", "2026-01-02T00:00:00.000Z"),
        goal("G-003", "Charlie", "2026-01-03T00:00:00.000Z"),
        goal("G-004", "Delta", "2026-01-04T00:00:00.000Z"),
        goal("G-005", "Echo", "2026-01-05T00:00:00.000Z"),
        goal("G-006", "Foxtrot", "2026-01-06T00:00:00.000Z"),
        goal("G-007", "Golf", "2026-01-07T00:00:00.000Z"),
        goal("G-008", "Hotel", "2026-01-08T00:00:00.000Z"),
      ],
      charBudget: 45,
    });

    expect(result.truncated?.reason).toBe("budget");
    expect(result.emittedGoalIds).toEqual(["G-001"]);
    expect(result.truncated?.droppedGoalIds).toEqual([
      "G-006",
      "G-007",
      "G-008",
      "G-005",
      "G-004",
      "G-003",
      "G-002",
    ]);
  });

  it("defensively sorts shuffled input", () => {
    const shuffled = [
      goal("G-003", "C", "2026-01-03T00:00:00.000Z"),
      goal("G-001", "A", "2026-01-01T00:00:00.000Z"),
      goal("G-002", "B", "2026-01-02T00:00:00.000Z"),
    ];

    const sorted = [
      goal("G-001", "A", "2026-01-01T00:00:00.000Z"),
      goal("G-002", "B", "2026-01-02T00:00:00.000Z"),
      goal("G-003", "C", "2026-01-03T00:00:00.000Z"),
    ];

    expect(buildGoalContextSection({ activeGoals: shuffled })).toEqual(
      buildGoalContextSection({ activeGoals: sorted }),
    );
  });

  it("does not invoke onTruncated when no truncation occurs", () => {
    const onTruncated = vi.fn();

    buildGoalContextSection({
      activeGoals: [goal("G-001", "Ship MVP", "2026-01-01T00:00:00.000Z")],
      charBudget: DEFAULT_GOAL_INJECTION_CHAR_BUDGET,
      onTruncated,
    });

    expect(onTruncated).not.toHaveBeenCalled();
  });
});
