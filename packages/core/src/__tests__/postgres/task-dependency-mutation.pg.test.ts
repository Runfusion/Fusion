/**
 * FNXC:SqliteFinalRemoval 2026-06-25-00:00:
 * PostgreSQL-backed counterpart of task-dependency-mutation.test.ts.
 *
 * Migrated from `createSharedTaskStoreTestHarness` (SQLite) to
 * `createSharedPgTaskStoreTestHarness`. Validates dependency mutation
 * operations (replace/add/remove/set) work identically against PostgreSQL
 * backend mode.
 */
import { afterEach, beforeEach, describe, expect, it, beforeAll, afterAll } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import type { TaskStore } from "../../store.js";

const pgTest = pgDescribe;

pgTest("TaskStore dependency mutations (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_dep_mut",
  });

  beforeAll(h.beforeAll);
  afterAll(h.afterAll);
  let store: TaskStore;

  beforeEach(async () => {
    await h.beforeEach();
    store = h.store();
  });

  afterEach(h.afterEach);

  it("replaces an obsolete dependency and clears stale blockers when the replacement is done", async () => {
    const obsolete = await store.createTask({ description: "obsolete prerequisite" });
    const canonical = await store.createTask({ description: "canonical prerequisite", column: "done" });
    const dependent = await store.createTask({
      description: "dependent task",
      column: "todo",
      dependencies: [obsolete.id],
    });
    await store.updateTask(dependent.id, { status: "queued", blockedBy: obsolete.id });

    const updated = await store.updateTaskDependencies(dependent.id, {
      operation: "replace",
      from: obsolete.id,
      to: canonical.id,
    });

    expect(updated.dependencies).toEqual([canonical.id]);
    expect(updated.blockedBy).toBeUndefined();
    expect(updated.status).toBeUndefined();
    /*
    FNXC:WorkflowLifecycleColumns 2026-08-02-03:20 (fleet — this assertion pinned a live bug):
    THE RE-SPECIFICATION TARGET IS THE BOARD'S INTAKE COLUMN, and on today's default lineage that is
    `todo`, not `triage`. U11 (#2515) merged Todo into Planning KEEPING the id `todo` and DELETING
    `triage` — measured from `resolveDefaultWorkflowIr()`:

      todo[intake,hold,reset-on-entry]  in-progress[wip,...]  in-review[merge,...]  done[complete]  archived

    So the old code wrote a column the shipped board does not declare, and this expectation locked that in.
    A test asserting `"triage"` was not protecting behaviour; it was protecting a stale literal that
    outlived its column.

    The rest of the re-specification contract is unchanged and still asserted above: dependencies replaced,
    stale blocker cleared, status cleared. What changes is that a board whose intake and hold are the SAME
    column performs no move — and therefore emits no `task:moved` for one, which is correct: announcing a
    move into the column the card already occupies re-runs reset-on-entry effects in every listener.
    */
    expect(updated.column).toBe("todo");

    const reloaded = await store.getTask(dependent.id);
    expect(reloaded.dependencies).toEqual([canonical.id]);
    expect(reloaded.blockedBy).toBeUndefined();

    const taskJson = JSON.parse(
      await readFile(join(h.rootDir(), ".fusion", "tasks", dependent.id, "task.json"), "utf-8"),
    ) as { dependencies: string[]; blockedBy?: string; column: string; status?: string };
    expect(taskJson.dependencies).toEqual([canonical.id]);
    expect(taskJson.blockedBy).toBeUndefined();
    // Same reasoning as above: the intake column of the default lineage is `todo` post-U11.
    expect(taskJson.column).toBe("todo");
  });

  /*
  FNXC:WorkflowLifecycleColumns 2026-07-31-02:05 (PR #2720 review — greptile):
  DISTINCT HOLD AND INTAKE LANES, the configuration the default lineage does not exercise.

  Post-U11 the default board merges hold and intake into one column, so every existing case here runs
  the branch where the re-specification "move" goes nowhere. A board that declares them SEPARATELY is
  supported and takes the other path — and both halves of this branch (the destination write and the
  move timestamp) behave differently there.

  Paired with the merged-lane case below, these pin the rule: the column moves only when the lanes
  differ, and `columnMovedAt` moves only when the column does.
  */
  async function splitLaneWorkflow() {
    return store.createWorkflowDefinition({
      name: "split-lanes",
      ir: {
        version: "v2",
        name: "split-lanes",
        columns: [
          { id: "inbox", name: "Inbox", traits: [{ trait: "intake" }] },
          { id: "ready", name: "Ready", traits: [{ trait: "hold", config: { release: "capacity" } }] },
          { id: "building", name: "Building", traits: [{ trait: "wip" }] },
          { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
        ],
        nodes: [{ id: "start", kind: "start", column: "inbox" }, { id: "end", kind: "end", column: "shipped" }],
        edges: [{ from: "start", to: "end" }],
      },
    } as never);
  }

  it("sends a HOLD-lane card back to a DISTINCT intake lane when a dependency is added", async () => {
    const definition = await splitLaneWorkflow();
    const blocker = await store.createTask({ description: "prerequisite", workflowId: definition.id } as never);
    const dependent = await store.createTask({ description: "dependent", workflowId: definition.id } as never);
    await store.moveTask(dependent.id, "ready" as never, { bypassGuards: true } as never);

    const before = await store.getTask(dependent.id);

    const updated = await store.updateTaskDependencies(dependent.id, {
      operation: "add",
      dependency: blocker.id,
    } as never);

    expect(updated.column).toBe("inbox");
    // A real move, so the move timestamp advances.
    expect(updated.columnMovedAt).not.toBe(before.columnMovedAt);
  });

  it("does NOT refresh columnMovedAt when hold and intake are the SAME column", async () => {
    /*
    The default lineage. The card does not move, so the move timestamp must not advance — refreshing it
    restarts time-in-column and every staleness sweep that reads it, making a dependency edit look like
    a fresh arrival.
    */
    const blocker = await store.createTask({ description: "prerequisite" });
    const dependent = await store.createTask({ description: "dependent" });
    const before = await store.getTask(dependent.id);

    const updated = await store.updateTaskDependencies(dependent.id, {
      operation: "add",
      dependency: blocker.id,
    } as never);

    expect(updated.column).toBe(before.column);
    expect(updated.columnMovedAt).toBe(before.columnMovedAt);
  });

  it("removes dependencies and recomputes stale blockers", async () => {
    const active = await store.createTask({ description: "active prerequisite" });
    const resolved = await store.createTask({ description: "resolved prerequisite", column: "done" });
    const dependent = await store.createTask({
      description: "dependent task",
      dependencies: [active.id, resolved.id],
    });
    await store.updateTask(dependent.id, { blockedBy: active.id });

    await expect(
      store.updateTaskDependencies(dependent.id, { operation: "remove", dependency: "FN-404" }),
    ).rejects.toThrow(/does not depend on/);

    const updated = await store.updateTaskDependencies(dependent.id, {
      operation: "remove",
      dependency: active.id,
    });

    expect(updated.dependencies).toEqual([resolved.id]);
    expect(updated.blockedBy).toBeUndefined();
  });

  it("rejects missing replacements, duplicates, self dependencies, and cycles", async () => {
    const a = await store.createTask({ description: "a" });
    const b = await store.createTask({ description: "b", dependencies: [a.id] });
    const c = await store.createTask({ description: "c", dependencies: [a.id] });

    await expect(
      store.updateTaskDependencies(c.id, { operation: "replace", from: b.id, to: a.id }),
    ).rejects.toThrow(/does not depend on/);

    await expect(
      store.updateTaskDependencies(c.id, { operation: "add", dependency: a.id }),
    ).rejects.toThrow(/already depends on/);

    await expect(
      store.updateTaskDependencies(c.id, { operation: "add", dependency: c.id }),
    ).rejects.toThrow(/cannot depend on itself/);

    await expect(
      store.updateTaskDependencies(a.id, { operation: "add", dependency: c.id }),
    ).rejects.toThrow(/Dependency cycle detected/);
  });
});
