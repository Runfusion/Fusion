/*
FNXC:CliBoardGlyph 2026-07-31-20:23:
THE BOARD GLYPH'S TERMINAL-LANE RESOLVE, on a RENAMED board.

`fn task list` marks each lane with `○` (finished) or `●` (active). That is a lane question, resolved
via `resolveProjectColumnsForRoles(store, TERMINAL_ROLES)`.

WHY THIS FILE EXISTS. That resolve was unreachable by any test — it sat inline in `runTaskList`,
which resolves a real project context and ends in `process.exit`. Blinding it left the whole CLI
suite green (1,835 tests).

WHY ITS SIBLING FILE DOES NOT COVER IT. `task-list-board-columns.test.ts` pins
`boardColumnsForDisplay`, which decides WHICH lanes print — a different question, and one that takes
no lane set. It says so honestly in its own header. Neither it nor any helper test could fail when
this resolve is blinded, because the uncovered thing is the RESOLVE, not the decision it feeds. The
seam under test here resolves, so blinding fails it.

WHAT BREAKS WITHOUT THE CONVERSION. On a board whose complete lane is `shipped`, a finished lane
renders `●` — the same glyph as active work. The board says work is still in flight when it shipped.
Cosmetic next to the blank-board bug this area already fixed, but wrong in the direction an operator
reads at a glance.

DIFFERENTIAL. The same cards under two vocabularies with identical traits; only the ids differ, and
no renamed id collides with a legacy one. The default-vocabulary case is the control.
*/

import { describe, expect, it, vi } from "vitest";
import { buildTaskListBoardLines, type BoardLineTask } from "../commands/task.js";

const RENAMED_COMPLETE = "shipped";
function ir(complete: string) {
  return {
    version: "v2",
    id: "custom:renamed-cli-board",
    nodes: [],
    edges: [],
    columns: [
      { id: "todo", label: "Hold", traits: [{ trait: "hold", config: { release: "capacity" } }] },
      { id: "building", label: "Wip", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
      { id: complete, label: "Complete", traits: [{ trait: "complete" }] },
    ],
  };
}

/** A store that can answer differently from the legacy floor — i.e. one with workflow definitions. */
function storeWith(complete: string) {
  return {
    listWorkflowDefinitions: vi.fn(async () => [{ ir: ir(complete) }]),
    getWorkflowDefinition: vi.fn(async () => ({ ir: ir(complete) })),
  } as unknown as Parameters<typeof buildTaskListBoardLines>[0];
}

const card = (id: string, column: string): BoardLineTask => ({
  id,
  column,
  title: `card ${id}`,
  description: "",
  dependencies: [],
});

/** The glyph on the header line for `column`, or undefined if that lane did not render. */
function glyphFor(lines: string[], label: string): string | undefined {
  const header = lines.find((line) => line.includes(`${label} (`));
  return header?.trim().charAt(0);
}

describe("buildTaskListBoardLines terminal glyph", () => {
  it("default vocabulary: a finished lane renders the terminal glyph", async () => {
    const lines = await buildTaskListBoardLines(storeWith("done"), [card("KB-1", "done")]);
    expect(glyphFor(lines, "Done")).toBe("○");
  });

  it("renamed vocabulary: the RENAMED complete lane renders the terminal glyph", async () => {
    const lines = await buildTaskListBoardLines(
      storeWith(RENAMED_COMPLETE),
      [card("KB-1", RENAMED_COMPLETE)],
    );
    expect(glyphFor(lines, RENAMED_COMPLETE)).toBe("○");
  });

  it("an ACTIVE lane keeps the active glyph under both vocabularies", async () => {
    /*
    The paired negative. Widening the terminal set must not mark everything finished — that would
    turn a wrong-glyph bug into a board where nothing looks in flight, which is worse.
    */
    const renamed = await buildTaskListBoardLines(
      storeWith(RENAMED_COMPLETE),
      [card("KB-1", "building")],
    );
    expect(glyphFor(renamed, "building")).toBe("●");

    const legacy = await buildTaskListBoardLines(storeWith("done"), [card("KB-2", "in-progress")]);
    expect(glyphFor(legacy, "In Progress")).toBe("●");
  });

  it("renders every card whatever its lane, and falls back to Done when the board cannot be read", async () => {
    /*
    Two contracts the surrounding code documents. Cards come from the TASKS, not from a resolved IR,
    so a card must never depend on resolution succeeding to be VISIBLE; and a failed resolve degrades
    to the legacy completion id rather than failing the command.
    */
    const unreadable = {
      listWorkflowDefinitions: vi.fn(async () => {
        throw new Error("unreadable");
      }),
    } as unknown as Parameters<typeof buildTaskListBoardLines>[0];

    const lines = await buildTaskListBoardLines(unreadable, [card("KB-1", RENAMED_COMPLETE), card("KB-2", "done")]);

    expect(lines.some((line) => line.includes("KB-1"))).toBe(true);
    expect(glyphFor(lines, "Done")).toBe("○");
    /* An unresolved custom lane renders as active — the documented fail-open direction. */
    expect(glyphFor(lines, RENAMED_COMPLETE)).toBe("●");
  });
});
