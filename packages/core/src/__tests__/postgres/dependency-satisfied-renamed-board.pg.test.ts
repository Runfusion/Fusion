/*
FNXC:WorkflowLifecycleColumns 2026-08-02-03:40 (fleet — settling "what does SATISFIED mean"):

THE INVARIANT: a dependency is satisfied when it rests in ITS OWN board's terminal pair.

I flagged this question in three files rather than guessing at it — `executor.ts:12325`,
`register-task-workflow-routes.ts:3995`, and `update-task-deps.ts` — because the answer has to be the same
in all three or the scheduler and the store will disagree about which cards are blocked. Settled here, in
the store, which is where `blockedBy` is actually written:

  SATISFIED   = the board's COMPLETE column, or its ARCHIVED column. Archived counts: an archived
                dependency is finished work the operator filed away, and reading it as unsatisfied blocks
                every dependent forever with no recourse short of editing the graph.
  NOT REVIEW  = a card in review is not done — its branch has not landed.
  UNION with the legacy ids, because a dependency row can outlive the column it is stored in (the U11
                shape), and "unsatisfied" is the expensive direction to be wrong in.

On a renamed board the old literals matched nothing, so EVERY dependency read as unresolved and `blockedBy`
was pinned to the first one permanently — the dependents never unblocked even after the work landed.

Driven through the real store on PostgreSQL because `blockedBy` is a persisted field and the resolution
path reads the workflow selection from the database; a mocked store would prove neither.
*/
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";

import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import type { TaskStore } from "../../store.js";

pgDescribe("dependency satisfaction on a renamed board (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_dep_satisfied",
  });

  beforeAll(h.beforeAll);
  afterAll(h.afterAll);
  let store: TaskStore;

  beforeEach(async () => {
    await h.beforeEach();
    store = h.store();
  });

  afterEach(h.afterEach);

  it("treats a dependency in the board's COMPLETE column as satisfied", async () => {
    const ir = {
      version: "v2", id: "custom:dep-renamed", name: "Renamed",
      nodes: [{ id: "start", kind: "start", column: "backlog" }, { id: "end", kind: "end", column: "shipped" }],
      edges: [{ from: "start", to: "end" }],
      columns: [
        { id: "backlog", label: "Backlog", traits: [{ trait: "intake" }] },
        { id: "queued", label: "Queued", traits: [{ trait: "hold", config: { release: "capacity" } }] },
        { id: "building", label: "Building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
        { id: "shipped", label: "Shipped", traits: [{ trait: "complete" }] },
        { id: "filed", label: "Filed", traits: [{ trait: "archived" }] },
      ],
    };
    const definition = await store.createWorkflowDefinition({ name: "Renamed", kind: "workflow", ir } as never);
    const workflowId = (definition as { id?: string }).id;

    const prerequisite = await store.createTask({ description: "prerequisite", column: "shipped" } as never);
    const dependent = await store.createTask({ description: "dependent" } as never);
    if (workflowId) {
      await store.writeTaskWorkflowSelection(prerequisite.id, workflowId, []);
      await store.writeTaskWorkflowSelection(dependent.id, workflowId, []);
    }

    const updated = await store.updateTaskDependencies(dependent.id, {
      operation: "add",
      dependency: prerequisite.id,
    } as never);

    /*
    Pre-fix: `shipped` matched neither `done` nor `archived`, so the dependency read as unresolved and
    `blockedBy` was pinned to it — permanently, because nothing would ever satisfy the comparison.
    */
    expect(updated.blockedBy).toBeUndefined();
  });

  it("still blocks on a dependency that is only in the WIP lane", async () => {
    // The paired negative: satisfaction must not degrade into "always satisfied".
    const prerequisite = await store.createTask({ description: "unfinished prerequisite" } as never);
    const dependent = await store.createTask({ description: "dependent" } as never);

    const updated = await store.updateTaskDependencies(dependent.id, {
      operation: "add",
      dependency: prerequisite.id,
    } as never);

    expect(updated.blockedBy).toBe(prerequisite.id);
  });

  it("treats a LEGACY `done` row as satisfied even when the board renames its complete column", async () => {
    /*
    The union case, and the one the existing refine suite caught for me: a row stored in `done` on a board
    that declares `shipped` is real (U11 leaves exactly this shape), and reading it as unsatisfied blocks
    its dependents with no operator recourse.
    */
    const prerequisite = await store.createTask({ description: "legacy done prerequisite", column: "done" } as never);
    const dependent = await store.createTask({ description: "dependent" } as never);

    const updated = await store.updateTaskDependencies(dependent.id, {
      operation: "add",
      dependency: prerequisite.id,
    } as never);

    expect(updated.blockedBy).toBeUndefined();
  });
});
