/*
WHY A NEW FILE: the dashboard's planning-mode board tools are a separate model-visible surface from
the engine's `agent-tools.ts` registrations, and nothing asserted their descriptions. RUFU-378 had to
close the same intake-stub misreading on this surface too, so the pin lives beside this surface.
*/
import { describe, expect, it, vi } from "vitest";
import { TASK_BOARD_READ_CAVEAT, type TaskStore } from "@fusion/core";
import { createPlanningBoardTools } from "../planning-board-tools.js";

/**
 * FNXC:BoardReadToolDescriptions 2026-10-15-00:01 (RUFU-378):
 * Planning mode lets the planner list the board before it files a card, and `fn_task_list` here rendered
 * the same `ID (column): label` row as every other surface — a label clamped to 80 characters of the raw
 * intake description. The planner judged duplicates on that stub, so it carries the shared caveat and no
 * longer claims it returns a `description`.
 */

function createStore(): TaskStore {
  return {
    listTasks: vi.fn(async () => []),
    listTasksModifiedSince: vi.fn(async () => []),
    getTask: vi.fn(async () => null),
    getSettings: vi.fn(async () => ({})),
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as TaskStore;
}

function descriptionOf(name: string): string {
  const tool = createPlanningBoardTools(createStore()).find((candidate) => candidate.name === name);
  expect(tool, `registration ${name} must exist`).toBeDefined();
  return tool!.description;
}

describe("RUFU-378 planning-mode board tool descriptions carry the intake-stub caveat", () => {
  it("appends the shared sentence verbatim to fn_task_list", () => {
    const description = descriptionOf("fn_task_list");
    expect(description).toContain(TASK_BOARD_READ_CAVEAT);
    expect(description).toContain("fn_task_show");
    expect(description).toContain("PROMPT.md");
  });

  it("no longer promises a description the row does not contain", () => {
    const description = descriptionOf("fn_task_list");
    expect(description).not.toContain("Returns ID, description, column");
    expect(description).toContain("Returns ID, label, column");
  });

  it("withholds the caveat from fn_task_show, the tool that resolves the stub", () => {
    expect(descriptionOf("fn_task_show")).not.toContain(TASK_BOARD_READ_CAVEAT);
  });
});
