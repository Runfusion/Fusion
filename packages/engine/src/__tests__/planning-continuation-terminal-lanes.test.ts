/*
FNXC:WorkflowLifecycleColumns 2026-08-02-16:50 (fleet: the planning-continuation drain):

THE INVARIANT: a due planning work item whose task is TERMINAL is an orphan to cancel, and "terminal" is the
task's own board.

WHY THIS ONE IS NOT LOCAL. FN-8470's own note on this drain says it: one orphan earlier in created_at FIFO
prevented every later planning continuation from dispatching. So on a renamed board the literal pair did not
merely mis-handle one card — a completed card's stale work item read as live, stayed in the due
set, and starved the drain behind it. A single stale row stops planning for the whole project.

THE OPTIONAL SET IS THE POINT of the design, and both halves are asserted: omitting it keeps the Done fallback
(every existing caller and test relies on that), supplying it makes the renamed board work. A fix that
required the set would have broken every current caller silently — they would compile and answer "not
terminal" for everything.
*/
import { describe, expect, it } from "vitest";
import type { Task } from "@fusion/core";

import {
  isPlanningContinuationTaskDispatchable,
  resolvePlanningContinuationCandidate,
} from "../runtimes/in-process-runtime.js";

const ITEM = { id: "wi-1", taskId: "FN-1", waitReason: "planning", state: "runnable" } as never;

function task(column: string): Task {
  return { id: "FN-1", column, dependencies: [], steps: [], currentStep: 0 } as unknown as Task;
}

const RENAMED_TERMINAL = new Set(["shipped", "done"]);

describe("the planning-continuation drain resolves terminal from the board", () => {
  it("treats a renamed board's COMPLETE card as terminal", () => {
    // Pre-fix: `shipped` matched neither literal, so this item stayed live and starved the FIFO behind it.
    expect(isPlanningContinuationTaskDispatchable(task("shipped"), RENAMED_TERMINAL)).toBe(false);
    expect(resolvePlanningContinuationCandidate(ITEM, task("shipped"), { terminalColumns: RENAMED_TERMINAL }))
      .toMatchObject({ kind: "orphan", reason: "task-terminal" });
  });

  it("still dispatches a card that is NOT terminal on that board", () => {
    // The paired positive: the guard must not turn into "nothing is dispatchable".
    expect(isPlanningContinuationTaskDispatchable(task("building"), RENAMED_TERMINAL)).toBe(true);
    expect(resolvePlanningContinuationCandidate(ITEM, task("building"), { terminalColumns: RENAMED_TERMINAL }))
      .toMatchObject({ kind: "actionable" });
  });

  it("keeps the Done fallback when no set is supplied", () => {
    /*
    The compatibility half, and the reason the parameter is optional rather than required: every existing
    caller and test omits it. A required parameter would have compiled and then answered "not terminal" for
    everything, which is the silent direction.
    */
    expect(isPlanningContinuationTaskDispatchable(task("done"))).toBe(false);
    expect(isPlanningContinuationTaskDispatchable(task("archived"))).toBe(true);
    expect(isPlanningContinuationTaskDispatchable(task("in-progress"))).toBe(true);
    // And a renamed terminal column is NOT recognised without the set — which is exactly why the runtime
    // wires a resolver at the call site.
    expect(isPlanningContinuationTaskDispatchable(task("shipped"))).toBe(true);
  });

  it("still orphans a lookup failure regardless of lanes", () => {
    expect(resolvePlanningContinuationCandidate(ITEM, undefined, { taskLookupFailed: true }))
      .toMatchObject({ kind: "orphan", reason: "task-not-found" });
  });
});
