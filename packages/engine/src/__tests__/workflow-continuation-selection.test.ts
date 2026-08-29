import { describe, expect, it } from "vitest";
import type { Task, WorkflowWorkItem } from "@fusion/core";
import {
  isPlanningContinuationTaskDispatchable,
  resolvePlanningContinuationCandidate,
  selectActionablePlanningContinuations,
} from "../runtimes/in-process-runtime.js";

function workItem(
  id: string,
  waitReason: WorkflowWorkItem["waitReason"],
  patch: Partial<WorkflowWorkItem> = {},
): WorkflowWorkItem {
  return { id, taskId: `task-${id}`, waitReason, ...patch } as WorkflowWorkItem;
}

function task(id: string, patch: Partial<Task> = {}): Task {
  return { id, column: "todo", paused: false, userPaused: false, ...patch } as Task;
}

describe("isPlanningContinuationTaskDispatchable", () => {
  it("rejects missing, paused, soft-deleted, archived, and done tasks", () => {
    expect(isPlanningContinuationTaskDispatchable(undefined)).toBe(false);
    expect(isPlanningContinuationTaskDispatchable(null)).toBe(false);
    expect(isPlanningContinuationTaskDispatchable(task("T-1", { paused: true }))).toBe(false);
    expect(isPlanningContinuationTaskDispatchable(task("T-2", { userPaused: true }))).toBe(false);
    expect(isPlanningContinuationTaskDispatchable(task("T-3", { deletedAt: "2026-07-22T05:15:38.174Z" }))).toBe(false);
    expect(isPlanningContinuationTaskDispatchable(task("T-4", { column: "archived" }))).toBe(false);
    expect(isPlanningContinuationTaskDispatchable(task("T-5", { column: "done" }))).toBe(false);
    expect(isPlanningContinuationTaskDispatchable(task("T-6", { column: "todo" }))).toBe(true);
  });
});

describe("resolvePlanningContinuationCandidate", () => {
  it("marks lookup failures and missing tasks as orphans to cancel", () => {
    const item = workItem("orphan-missing", "planning");
    expect(resolvePlanningContinuationCandidate(item, undefined, { taskLookupFailed: true })).toEqual({
      kind: "orphan",
      item,
      reason: "task-not-found",
    });
    expect(resolvePlanningContinuationCandidate(item, null)).toEqual({
      kind: "orphan",
      item,
      reason: "task-not-found",
    });
  });

  it("marks terminal board tasks as orphans even when getTask returns an archive fallback", () => {
    const item = workItem("orphan-terminal", "planning");
    expect(
      resolvePlanningContinuationCandidate(item, task("FN-8470", { column: "archived" })),
    ).toEqual({ kind: "orphan", item, reason: "task-terminal" });
    expect(
      resolvePlanningContinuationCandidate(item, task("FN-8401", { column: "done" })),
    ).toEqual({ kind: "orphan", item, reason: "task-terminal" });
    expect(
      resolvePlanningContinuationCandidate(
        item,
        task("FN-soft", { deletedAt: "2026-07-22T05:15:38.174Z", column: "todo" }),
      ),
    ).toEqual({ kind: "orphan", item, reason: "task-terminal" });
  });

  /*
  FNXC:WorkflowScheduling 2026-08-11-17:30:
  The invariant, not the repro: EVERY waitReason a writer can persist must dispatch. The board strand
  was found through `capacity` rows, but five of the eight stuck cards carried a NULL reason, so a
  capacity-only assertion would have re-shipped the wedge for the majority case. Enumerated surfaces:
  `"planning"` (`plan-review-continuation.ts`), `"capacity"` (`workflow-column-boundary-hooks.ts`), and
  undefined (every upsert path that omits it). Skipping is now reserved for operator parks alone.
  */
  it.each(["planning", "capacity", undefined] as const)(
    "dispatches a due continuation whatever stopped it (waitReason=%s)",
    (waitReason) => {
      const item = workItem(`live-${waitReason ?? "none"}`, waitReason);
      const live = task("T-live", { column: "todo" });

      expect(resolvePlanningContinuationCandidate(item, live)).toEqual({
        kind: "actionable",
        item,
        task: live,
      });
    },
  );

  /*
  FNXC:WorkflowScheduling 2026-08-11-17:30:
  An operator park still outranks the waitReason relaxation above — a capacity-parked card belonging
  to a PAUSED task must stay skipped, or the relaxation would start dispatching work a human stopped.
  */
  it("still skips an operator-parked task even on a non-planning continuation", () => {
    const capacity = workItem("cap-paused", "capacity");
    expect(resolvePlanningContinuationCandidate(capacity, task("T-cap", { paused: true }))).toEqual({
      kind: "skip",
      item: capacity,
      reason: "paused",
    });
  });

  it("skips paused planning items without cancelling", () => {
    const paused = workItem("paused", "planning");
    expect(resolvePlanningContinuationCandidate(paused, task("T-p", { paused: true }))).toEqual({
      kind: "skip",
      item: paused,
      reason: "paused",
    });
  });

  it("selects unpaused planning items on live non-terminal tasks", () => {
    const item = workItem("eligible", "planning");
    const live = task("FN-8471", { column: "todo" });
    expect(resolvePlanningContinuationCandidate(item, live)).toEqual({
      kind: "actionable",
      item,
      task: live,
    });
  });
});

describe("selectActionablePlanningContinuations", () => {
  it("retains every continuation whose task is present, unpaused, and non-terminal", () => {
    /*
    FNXC:WorkflowScheduling 2026-07-21-22:31:
    Regression for the FN-8470→FN-8471 starvation class: a deleted/archived
    earlier due row must not remain "actionable" and must not prevent a later
    live planning continuation from being selected.

    FNXC:WorkflowScheduling 2026-08-11-17:30:
    `capacity` and NULL-waitReason rows on live tasks now survive selection — they are this drain's
    work too. Only the TASK's condition (missing, parked, terminal) removes a row; why the
    continuation stopped never does.
    */
    const selected = selectActionablePlanningContinuations([
      { item: workItem("eligible", "planning"), task: task("T-1") },
      { item: workItem("capacity", "capacity"), task: task("T-2") },
      { item: workItem("missing", "planning"), task: undefined },
      { item: workItem("null-task", "planning"), task: null },
      { item: workItem("no-wait-reason", null), task: task("T-5") },
      { item: workItem("paused", "planning"), task: task("T-3", { paused: true }) },
      { item: workItem("user-paused", "planning"), task: task("T-4", { userPaused: true }) },
      { item: workItem("archived", "planning"), task: task("FN-8470", { column: "archived" }) },
      { item: workItem("done", "planning"), task: task("FN-done", { column: "done" }) },
      { item: workItem("soft-deleted", "planning"), task: task("FN-soft", { deletedAt: "2026-07-22T05:15:38.174Z" }) },
      { item: workItem("later-live", "planning"), task: task("FN-8471", { column: "todo" }) },
    ]);

    expect(selected.map(({ item, task: selectedTask }) => [item.id, selectedTask.id])).toEqual([
      ["eligible", "T-1"],
      ["capacity", "T-2"],
      ["no-wait-reason", "T-5"],
      ["later-live", "FN-8471"],
    ]);
  });
});

/*
FNXC:WorkflowResolvedColumns 2026-07-30-01:40 (closing the partially-threaded half of the gap that
workflow-planning-continuation-terminal-gap-live-e2e.pg.test.ts documented):

`resolvePlanningContinuationCandidate` applied the caller's resolved terminal set to its OWN check and
then delegated to `isPlanningContinuationTaskDispatchable(task)` WITHOUT it, so the inner predicate
re-tested against the legacy `done`/`archived` pair.

THE REACHABLE CASE is a board that declares `done` as a NON-terminal column id — legal, and the shape a
project gets by repurposing a default column rather than renaming one. The outer check passes (the
resolved set says not terminal), the inner one calls it terminal per the legacy pair, and the card is
skipped as "paused": stalled by a lane name.

REVERT CHECK, measured: dropping the threaded set makes this fail — the candidate resolves `skip`
instead of `actionable`.
*/
describe("the inner dispatchable predicate uses the caller's resolved terminal set", () => {
  it("does not treat a NON-terminal `done` column as terminal", () => {
    const item = { taskId: "FN-1", waitReason: "planning" } as never;
    const task = {
      id: "FN-1",
      column: "done",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: "2026-07-30T00:00:00.000Z",
      updatedAt: "2026-07-30T00:00:00.000Z",
    } as never;

    /* This board declares `done` as an ordinary lane; its terminal lane is `shipped`. */
    const resolved = resolvePlanningContinuationCandidate(item, task, {
      terminalColumns: new Set(["shipped", "boxed"]),
    });

    expect(resolved.kind).toBe("actionable");
  });

  it("still treats the board's OWN terminal lane as terminal", () => {
    /* Non-vacuous companion: without it, a predicate that never classified anything terminal passes. */
    const item = { taskId: "FN-2", waitReason: "planning" } as never;
    const task = {
      id: "FN-2",
      column: "shipped",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: "2026-07-30T00:00:00.000Z",
      updatedAt: "2026-07-30T00:00:00.000Z",
    } as never;

    const resolved = resolvePlanningContinuationCandidate(item, task, {
      terminalColumns: new Set(["shipped", "boxed"]),
    });

    expect(resolved.kind).toBe("orphan");
  });
});
