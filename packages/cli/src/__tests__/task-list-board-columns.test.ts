/*
FNXC:CliBoardVocabulary 2026-07-30-23:40:
THE INVARIANT: `fn task list` prints every card, whatever its board calls the lane.

`runTaskList` iterated the six-id `COLUMNS` constant and filtered `t.column === col`, so a card in a
workflow-defined column matched no iteration and was never printed — the board looked shorter and
healthy rather than broken, and a fully renamed board printed nothing but the header.

SCOPE OF THIS COVERAGE, stated rather than implied: these cases pin the lane-selection decision,
which is the entire content of the fix. They do NOT prove `runTaskList` calls it — that function
resolves a real project context and ends in `process.exit`, so driving it needs a mock-the-world
shell, the shape `docs/testing.md` says to avoid when a narrower seam exists. The call site is held
by the compiler instead: the loop's only source of lanes is this function.

Reverted — this function returning `[...COLUMNS]`, which is what the loop did — the first two cases
fail: renamed lanes vanish entirely, and `shipped` never appears.
*/
import { describe, expect, it } from "vitest";
import { boardColumnsForDisplay } from "../commands/task.js";

const at = (...columns: string[]) => columns.map((column) => ({ column }));

describe("boardColumnsForDisplay", () => {
  it("includes workflow-defined lanes the legacy enum has never heard of", () => {
    expect(boardColumnsForDisplay(at("backlog", "building", "checking"))).toEqual([
      "backlog",
      "building",
      "checking",
    ]);
  });

  it("keeps a renamed terminal lane, which the legacy filter dropped silently", () => {
    expect(boardColumnsForDisplay(at("todo", "shipped"))).toEqual(["todo", "shipped"]);
  });

  it("orders legacy lanes in their familiar board order, whatever order the cards arrive in", () => {
    expect(boardColumnsForDisplay(at("done", "todo", "in-review", "in-progress"))).toEqual([
      "todo",
      "in-progress",
      "in-review",
      "done",
    ]);
  });

  it("puts custom lanes after legacy ones and sorts them deterministically", () => {
    expect(boardColumnsForDisplay(at("zeta", "todo", "alpha"))).toEqual(["todo", "alpha", "zeta"]);
  });

  it("emits each lane once however many cards sit in it, and nothing for an empty board", () => {
    expect(boardColumnsForDisplay(at("building", "building", "building"))).toEqual(["building"]);
    expect(boardColumnsForDisplay([])).toEqual([]);
  });
});
