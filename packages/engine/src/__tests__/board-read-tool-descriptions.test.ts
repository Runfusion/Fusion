/*
WHY A NEW FILE: no existing suite asserted anything about board-read tool DESCRIPTIONS.
`agent-task-read-tools.test.ts` pins tool *names* and *output text* across the same surfaces, and
`triage-duplicate-search-regression.test.ts` pins that `fn_task_search` exists at all — none of them
could notice a description that tells a duplicate-checking agent its truncated intake stub is the card's
description. RUFU-378 changed exactly that model-visible text, so the assertion needs its own file.
*/
import { describe, expect, it, vi } from "vitest";
import { TASK_BOARD_READ_CAVEAT, type TaskStore } from "@fusion/core";
import { createTaskListTool, createTaskSearchTool, createTaskShowTool } from "../agent-tools.js";
import { TriageProcessor } from "../triage.js";

/**
 * FNXC:BoardReadToolDescriptions 2026-10-15-00:01 (RUFU-378):
 * `fn_task_list` / `fn_task_search` render each row as `ID (column): label`, where the label is
 * `task.title` or the first 80 characters of the card's raw intake description. A model comparing
 * duplicates was reading that stub as if it were the card and reporting "no duplicate found". The
 * shared caveat names the stub for what it is and sends the caller to `fn_task_show` for the full
 * description and PROMPT.md; this file owns the rule that every engine-side registration carries it.
 */

function createStore(): TaskStore {
  return {
    listTasks: vi.fn(async () => []),
    searchTasks: vi.fn(async () => []),
    getTask: vi.fn(async () => null),
    getSettings: vi.fn(async () => ({})),
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as TaskStore;
}

function triageTools(): Array<{ name: string; description: string }> {
  const processor = new TriageProcessor(createStore() as never, "/tmp/fn-rufu-378");
  return (
    processor as unknown as {
      createTriageTools: (opts: unknown) => Array<{ name: string; description: string }>;
    }
  ).createTriageTools({ parentTaskId: "FN-RUFU-378", allowTaskCreate: true });
}

function descriptionOf(tools: Array<{ name: string; description: string }>, name: string): string {
  const tool = tools.find((candidate) => candidate.name === name);
  expect(tool, `registration ${name} must exist`).toBeDefined();
  return tool!.description;
}

/** Every model-visible board-read registration whose rows carry the truncated label. */
function boardReadDescriptions(): Record<string, string> {
  const store = createStore();
  const triage = triageTools();
  return {
    "agent-tools fn_task_list": createTaskListTool(store).description,
    "agent-tools fn_task_search": createTaskSearchTool(store).description,
    "triage fn_task_list": descriptionOf(triage, "fn_task_list"),
    "triage fn_task_search": descriptionOf(triage, "fn_task_search"),
  };
}

describe("RUFU-378 board-read tool descriptions carry the intake-stub caveat", () => {
  it("states the follow-up tool and document it sends the caller to", () => {
    expect(TASK_BOARD_READ_CAVEAT).toContain("fn_task_show");
    expect(TASK_BOARD_READ_CAVEAT).toContain("intake stub");
    expect(TASK_BOARD_READ_CAVEAT).toContain("PROMPT.md");
  });

  it("stays renderable in the surfaces that embed it: one line, no table delimiter", () => {
    // `scripts/sync-fusion-skill-tools.mjs` extracts double-quoted literals and `references/
    // fusion-capabilities.md` renders the description into a Markdown table cell.
    expect(TASK_BOARD_READ_CAVEAT).not.toMatch(/[\r\n]/);
    expect(TASK_BOARD_READ_CAVEAT).not.toContain("|");
    expect(TASK_BOARD_READ_CAVEAT).not.toMatch(/\s{2,}/);
  });

  it("appends the shared sentence verbatim to every engine-side board-read registration", () => {
    const descriptions = boardReadDescriptions();
    expect(Object.keys(descriptions).length).toBe(4);
    for (const [surface, description] of Object.entries(descriptions)) {
      expect(description, surface).toContain(TASK_BOARD_READ_CAVEAT);
    }
  });

  it("no longer promises a description the row does not contain", () => {
    for (const [surface, description] of Object.entries(boardReadDescriptions())) {
      expect(description, surface).not.toContain("Returns ID, description, column");
    }
    // Only the list surfaces ever named a field; the search registrations never claimed one.
    const store = createStore();
    expect(createTaskListTool(store).description).toContain("Returns ID, label, column");
    expect(descriptionOf(triageTools(), "fn_task_list")).toContain("Returns ID, label, column");
  });

  it("withholds the caveat from fn_task_show, the tool that resolves the stub", () => {
    // Non-vacuous control: the caveat is not sprayed over every tool description. `fn_task_show` is
    // the resolution step the caveat points at, so a description of it must not point at itself.
    const show = createTaskShowTool(createStore()).description;
    expect(show).not.toContain(TASK_BOARD_READ_CAVEAT);
    expect(descriptionOf(triageTools(), "fn_task_show")).not.toContain(TASK_BOARD_READ_CAVEAT);
  });
});
