/*
FNXC:MergeBlockerReasons 2026-08-26-11:40:
A blocker MESSAGE is written for an operator to read. A blocker CONDITION is what code means. They
were conflated, and it cost a silent behaviour loss.

`merge-confirmed-finalize.ts` selects one case — a no-op merge with no landed commit whose work is
unfinished must fall through to stale-merge cleanup instead of consuming the run — and selected it by
comparing the blocker reason with `===` against "task has incomplete steps". The merge-authority work
then made refusals more informative, so a card in an error state reports
`task is marked 'failed': … task has incomplete steps`. Same meaning, different sentence. The
comparison stopped matching and the fall-through never happened again, with nothing failing in the
merge gate to say so.

These tests pin the two apart: the sentence may be reworded freely, the rule may not drift from the
door that enforces it.
*/
import { describe, expect, it } from "vitest";
import type { Task } from "../types.js";
import { getTaskMergeBlocker, hasNonTerminalSteps } from "../merge/task-merge.js";

function card(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-MB-1",
    column: "in-review",
    status: null,
    error: null,
    paused: false,
    steps: [],
    dependencies: [],
    autoMerge: true,
    ...overrides,
  } as unknown as Task;
}

const UNFINISHED = [{ name: "Implement", status: "pending" }] as Task["steps"];
const FINISHED = [{ name: "Implement", status: "done" }] as Task["steps"];

describe("merge blocker: condition versus message", () => {
  it("answers the same for a card whose refusal sentence carries a status prefix", () => {
    const plain = card({ steps: UNFINISHED });
    const failed = card({
      steps: UNFINISHED,
      status: "failed",
      error: "Merge confirmed but finalization blocked: task has incomplete steps",
    });

    // The sentences differ — this is exactly the drift that broke the carve-out.
    const plainReason = getTaskMergeBlocker(plain);
    const failedReason = getTaskMergeBlocker(failed);
    expect(plainReason).toBe("task has incomplete steps");
    expect(failedReason).not.toBe(plainReason);
    expect(failedReason).toContain("failed");

    // The rule does not care how the refusal was worded.
    expect(hasNonTerminalSteps(plain)).toBe(true);
    expect(hasNonTerminalSteps(failed)).toBe(true);
  });

  it("recognises every non-terminal step status, and no terminal one", () => {
    for (const status of ["pending", "in-progress"]) {
      expect(hasNonTerminalSteps(card({ steps: [{ name: "s", status }] as Task["steps"] })), status).toBe(true);
    }
    for (const status of ["done", "skipped"]) {
      expect(hasNonTerminalSteps(card({ steps: [{ name: "s", status }] as Task["steps"] })), status).toBe(false);
    }
    expect(hasNonTerminalSteps(card({ steps: [] }))).toBe(false);
    expect(hasNonTerminalSteps(card({ steps: undefined as unknown as Task["steps"] }))).toBe(false);
  });

  /*
  The rule and the door must be defined from the same set. If a future edit teaches the blocker about
  a new non-terminal status without teaching this predicate, a caller asking the condition would
  disagree with the door enforcing it — which is how the drift happened in the first place.
  */
  it("keeps the rule and the merge door in agreement", () => {
    for (const status of ["pending", "in-progress", "done", "skipped"]) {
      const subject = card({ steps: [{ name: "s", status }] as Task["steps"] });
      const doorRefusesForSteps = getTaskMergeBlocker(subject) === "task has incomplete steps";
      expect(hasNonTerminalSteps(subject), `status ${status}`).toBe(doorRefusesForSteps);
    }
  });

  it("does not claim incomplete steps when the card is refused for another reason entirely", () => {
    const paused = card({ steps: FINISHED, paused: true });
    expect(getTaskMergeBlocker(paused)).toBeTruthy();
    expect(hasNonTerminalSteps(paused), "a paused card with finished work has no unfinished steps").toBe(false);
  });
});
