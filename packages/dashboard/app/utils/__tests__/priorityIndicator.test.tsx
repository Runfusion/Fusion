import { describe, expect, it } from "vitest";
import { ArrowDown, ArrowUp, Flag, TriangleAlert } from "lucide-react";
import { TASK_PRIORITIES, type TaskPriority } from "@fusion/core";
import { getPriorityColorVar, getPriorityIcon, getPriorityLabel, priorityIndicator } from "../priorityIndicator";

const expectedIndicators: Record<TaskPriority, { icon: unknown; label: string; colorVar: string }> = {
  low: { icon: ArrowDown, label: "Low", colorVar: "var(--color-info)" },
  normal: { icon: Flag, label: "Normal", colorVar: "var(--text-muted)" },
  high: { icon: ArrowUp, label: "High", colorVar: "var(--color-warning)" },
  urgent: { icon: TriangleAlert, label: "Urgent", colorVar: "var(--color-error)" },
};

describe("priorityIndicator", () => {
  it("returns the shared glyph and label for every task priority", () => {
    for (const priority of TASK_PRIORITIES) {
      expect(priorityIndicator(priority)).toEqual(expectedIndicators[priority]);
      expect(getPriorityIcon(priority)).toBe(expectedIndicators[priority].icon);
      expect(getPriorityLabel(priority)).toBe(expectedIndicators[priority].label);
      expect(getPriorityColorVar(priority)).toBe(expectedIndicators[priority].colorVar);
    }
  });
});
