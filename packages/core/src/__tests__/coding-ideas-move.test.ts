import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTaskStoreTestHarness } from "./store-test-helpers.js";

/*
FNXC:WorkflowColumns 2026-07-05-19:10:
Regression for the disappearing move on custom workflow columns. Workflow columns graduated to
always-on (no experimental flag emitted), but moveTaskInternal still gated its workflow path on the
retired strict compatibility flag, so it fell back to the legacy VALID_TRANSITIONS table — which is
keyed only by the legacy column ids. A task in a non-legacy column (Coding (Ideas) → "ideas") could
not move: "Invalid transition: 'ideas' → 'todo'. Valid targets: none".

Surface enumeration (invariant: a move is validated by the task's WORKFLOW adjacency, not the legacy
table, on a default project with NO experimental flag set):
 - Custom intake column forward move: ideas → todo is allowed.
 - Full custom-column chain onward: todo → in-progress → in-review all succeed (→ done is gated by the
   workflow's own merge trait, which is orthogonal to transition adjacency and excluded here).
 - Non-adjacent move still rejects with the workflow's targets (ideas → in-progress).
 - Holds for both user- and engine-sourced moves.
 - Default workflow (legacy column ids) is unchanged (parity), verified in move-task-characterization.
*/
describe("Coding (Ideas) custom-column moves (workflow-columns graduation)", () => {
  const harness = createTaskStoreTestHarness();
  beforeEach(harness.beforeEach);
  afterEach(harness.afterEach);

  it("moves an ideas-workflow task from the ideas intake column to todo", async () => {
    const store = harness.store();
    const task = await store.createTask({ description: "idea", workflowId: "builtin:coding-ideas" });
    expect(task.column).toBe("ideas");

    const moved = await store.moveTask(task.id, "todo", { moveSource: "user" });
    expect(moved.column).toBe("todo");
  });

  it("advances an ideas task along the Coding (Ideas) custom-column chain", async () => {
    const store = harness.store();
    const task = await store.createTask({ description: "idea", workflowId: "builtin:coding-ideas" });

    await store.moveTask(task.id, "todo", { moveSource: "user" });
    await store.moveTask(task.id, "in-progress", { moveSource: "user" });
    const inReview = await store.moveTask(task.id, "in-review", { moveSource: "user", allowDirectInReviewMove: true });
    expect(inReview.column).toBe("in-review");
  });

  it("still rejects a non-adjacent move out of the ideas column", async () => {
    const store = harness.store();
    const task = await store.createTask({ description: "idea", workflowId: "builtin:coding-ideas" });
    await expect(
      store.moveTask(task.id, "in-progress", { moveSource: "user" }),
    ).rejects.toThrow(/Invalid transition: 'ideas' → 'in-progress'/);
  });

  it("allows the ideas → todo move from an engine source too", async () => {
    const store = harness.store();
    const task = await store.createTask({ description: "idea", workflowId: "builtin:coding-ideas" });
    const moved = await store.moveTask(task.id, "todo", { moveSource: "engine" });
    expect(moved.column).toBe("todo");
  });
});
