import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
} from "../__test-utils__/pg-test-harness.js";

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
/*
FNXC:PostgresCutover 2026-07-05-19:40:
Runs on the shared PostgreSQL harness (the sync SQLite TaskStore runtime was
removed under VAL-REMOVAL-005); pgDescribe auto-skips when PostgreSQL is
unreachable so the merge gate stays green.
*/
pgDescribe("Coding (Ideas) custom-column moves (workflow-columns graduation)", () => {
  const harness = createSharedPgTaskStoreTestHarness({ prefix: "fusion_ideas_move" });
  beforeAll(harness.beforeAll);
  beforeEach(harness.beforeEach);
  afterEach(harness.afterEach);
  afterAll(harness.afterAll);

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

  /*
  FNXC:CodingIdeasWorkflow 2026-07-25-10:05:
  Regression for the one-way Ideas intake. The reverse move (Todo → Ideas) was rejected with
  "Invalid transition: 'todo' → 'ideas'. Valid targets: in-progress, triage" because `todo`
  is a LEGACY column id, so validation used the closed VALID_TRANSITIONS map — which cannot know
  about a workflow-declared "ideas" column — instead of the task's own workflow adjacency. Legacy
  source columns now UNION both, so an operator can demote a card back to Ideas.

  Surface enumeration (invariant: a legacy source column honors the task's workflow adjacency in
  addition to the legacy table):
   - Board drag / context menu / task detail / List view / CLI + tools all funnel through
     store.moveTask, so the store-level assertions below cover every move surface.
   - User move succeeds; automatic engine movement back into intake remains forbidden by lifecycle containment.
   - Round-trip: the user-demoted card can be promoted again.
   - Default (legacy-column) workflow parity: the union never widens builtin:coding, and a column
     the workflow does not declare still rejects.
  */
  it("moves an ideas-workflow task back from todo to the ideas intake column", async () => {
    const store = harness.store();
    const task = await store.createTask({ description: "idea", workflowId: "builtin:coding-ideas" });
    await store.moveTask(task.id, "todo", { moveSource: "user" });

    const demoted = await store.moveTask(task.id, "ideas", { moveSource: "user" });
    expect(demoted.column).toBe("ideas");

    // Round-trip: still promotable after the demotion.
    expect((await store.moveTask(task.id, "todo", { moveSource: "user" })).column).toBe("todo");
  });

  it("keeps automatic todo → ideas movement out of the intake role", async () => {
    const store = harness.store();
    const task = await store.createTask({ description: "idea", workflowId: "builtin:coding-ideas" });
    await store.moveTask(task.id, "todo", { moveSource: "user" });

    await expect(store.moveTask(task.id, "ideas", { moveSource: "engine" }))
      .rejects.toThrow(/Automatic moves may not target the intake lifecycle role/);
  });

  it("keeps the default workflow's legacy adjacency unchanged", async () => {
    const store = harness.store();
    const task = await store.createTask({ description: "legacy", workflowId: "builtin:coding" });

    // A column the default workflow never declares is still rejected...
    await expect(
      store.moveTask(task.id, "ideas", { moveSource: "user" }),
    ).rejects.toThrow(/Invalid transition: '.*' → 'ideas'/);
    /*
    FNXC:WorkflowColumns 2026-07-30-04:30 (U12 — the move-path flag is resolved):
    ...and so is a non-adjacent target. The advertised target list changed from
    `in-progress, triage` to `in-progress`, and that is the FIX rather than a regression: the old
    list came from the hardcoded legacy adjacency table, which still offered
    `triage` — a column the default lineage stopped declaring at #2515. The move path now resolves
    adjacency from the task's own workflow, so it can no longer advertise a column that does not
    exist. An operator following the old message would have been told to move somewhere impossible.
    */
    await store.moveTask(task.id, "todo", { moveSource: "user" });
    await expect(
      store.moveTask(task.id, "in-review", { moveSource: "user" }),
    ).rejects.toThrow("Invalid transition: 'todo' → 'in-review'. Valid targets: in-progress");
  });

  it("cancels an active task continuation when a user sends implementation back to todo", async () => {
    const store = harness.store();
    const task = await store.createTask({ description: "idea", workflowId: "builtin:coding-ideas" });
    await store.moveTask(task.id, "todo", { moveSource: "user" });
    await store.moveTask(task.id, "in-progress", { moveSource: "user" });
    const continuation = await store.upsertWorkflowWorkItem({
      runId: `${task.id}:continuation:test`,
      taskId: task.id,
      nodeId: "steps",
      kind: "task",
      state: "running",
    });

    await store.moveTask(task.id, "todo", { moveSource: "user" });

    expect((await store.getWorkflowWorkItem(continuation.id))?.state).toBe("cancelled");
  });
});
