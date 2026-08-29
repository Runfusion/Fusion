import { describe, expect, it } from "vitest";
import type { Task } from "@fusion/core";
import { formatTaskLine } from "../extension.js";

function makeTask(overrides: Partial<Task>): Task {
  return {
    id: "FN-0001",
    title: "Example task",
    description: "Example description",
    priority: "normal",
    column: "todo",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    size: "S",
    reviewLevel: 1,
    ...overrides,
  } as Task;
}

describe("formatTaskLine", () => {
  it.each([
    { paused: true, column: "todo", expectPaused: true },
    { paused: true, column: "in-progress", expectPaused: true },
    { paused: true, column: "in-review", expectPaused: true },
    { paused: true, column: "done", expectPaused: false },
    { paused: true, column: "archived", expectPaused: false },
    { paused: false, column: "done", expectPaused: false },
  ] as const)("suppresses paused marker for terminal columns (%o)", ({ paused, column, expectPaused }) => {
    const line = formatTaskLine(makeTask({ paused, column }));
    if (expectPaused) {
      expect(line).toContain("(paused)");
    } else {
      expect(line).not.toContain("(paused)");
    }
  });
});
