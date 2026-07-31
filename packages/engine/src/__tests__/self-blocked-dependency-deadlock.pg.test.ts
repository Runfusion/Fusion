/*
FNXC:PostgresCutover 2026-07-31-17:25 (regression — the SECOND instance of PR #2809's deadlock class):

`updateTaskDependenciesImpl` wraps its whole body in `store.withTaskLock(id, ...)` and then reads the
current blocker with `readDepTask(task.blockedBy)`, which calls `store.getTask()`. `getTaskImpl` opens
with `store.withTaskLock(id, ...)` too, and the per-task lock is NON-REENTRANT — the invariant stated
in prose in `branch-and-pr-entities.ts` and `workflow-ops.ts`. So when `blockedBy` happens to be the
task's OWN id, the call waits forever on a lock its own frame holds.

FOUND BY GENERALISING #2809 rather than by luck. That fix removed one `getTask`-inside-`withTaskLock`;
an AST scan for the same shape across core and engine returned exactly three sites — the one #2809
fixed and the two in this file. This is the reachable one.

WHY `blockedBy === id` IS REACHABLE. The dependencies list rejects self-reference explicitly
("Task X cannot depend on itself"), and that guard is why the sibling `assertTaskExists` read on this
same lock is safe. `blockedBy` has no such guard: `updateTask({ blockedBy })` accepts the task's own
id, which the first case below asserts rather than assumes — the whole regression rests on it, so it
is proven, not stipulated.

THE FIX returns the in-lock copy already in scope instead of re-reading. That is also strictly more
correct than a re-read: it is the state this mutation is reasoning about, rather than whatever a
concurrent writer left behind.

TIMEBOXED for the same reason as #2809: a deadlock otherwise surfaces as a suite-level timeout naming
no case. The deadline is not a flake knob — the fixed path completes in milliseconds and the broken
one never completes, so there is no value in between to tune to.

LANE. `.pg.test.ts`, skipped via `pgDescribe` when no PostgreSQL is reachable. Throwaway per-file
database; never port 4040.
*/
import { beforeAll, beforeEach, afterEach, afterAll, expect, it } from "vitest";
import "@fusion/core"; // registers the built-in column traits
import type { TaskStore } from "@fusion/core";

import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../../core/src/__test-utils__/pg-test-harness.js";

const DEADLINE_MS = 8_000;

async function within<T>(work: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not settle within ${DEADLINE_MS}ms — deadlock`)), DEADLINE_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

pgDescribe("dependency update does not deadlock on a self-blocked task", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_selfblock_deadlock",
  });

  beforeAll(h.beforeAll);
  afterAll(h.afterAll);
  beforeEach(async () => { await h.beforeEach(); });
  afterEach(async () => { await h.afterEach(); });

  it("PRECONDITION — `blockedBy` accepts the task's own id (dependencies do not)", async () => {
    /*
    The regression below is only meaningful if this state is reachable, so it is proven here rather
    than assumed. The asymmetry is the point: the dependencies list rejects self-reference and
    `blockedBy` does not.
    */
    const store = h.store();
    const task = await store.createTask({ description: "self-blocked precondition" });

    await store.updateTask(task.id, { blockedBy: task.id });
    store.taskCache.delete(task.id);
    expect((await store.getTask(task.id))?.blockedBy).toBe(task.id);

    await expect(
      store.updateTaskDependencies(task.id, { operation: "add", dependency: task.id } as never),
    ).rejects.toThrow(/cannot depend on itself/i);
  });

  it("REGRESSION — updating dependencies on a self-blocked task settles instead of hanging", async () => {
    /*
    Before the fix this never returned, and it held the task's lock while not returning, so the row
    was left permanently unlockable as well.
    */
    const store = h.store();
    const blocked = await store.createTask({ description: "self-blocked" });
    const other = await store.createTask({ description: "a real dependency" });
    await store.updateTask(blocked.id, { blockedBy: blocked.id });
    store.taskCache.delete(blocked.id);

    const updated = await within(
      store.updateTaskDependencies(blocked.id, { operation: "add", dependency: other.id } as never),
      "updateTaskDependencies",
    );

    expect(updated.dependencies).toContain(other.id);
  });

  it("the ordinary path — a task blocked by ANOTHER task — is unchanged", async () => {
    /*
    The differential. Without it the fix could have short-circuited every blocker read, not just the
    self-referential one, and every assertion above would still pass.
    */
    const store = h.store();
    const blocker = await store.createTask({ description: "blocker" });
    const dependent = await store.createTask({ description: "dependent" });
    const other = await store.createTask({ description: "second dependency" });
    await store.updateTask(dependent.id, { blockedBy: blocker.id, dependencies: [blocker.id] });
    store.taskCache.delete(dependent.id);

    const updated = await within(
      store.updateTaskDependencies(dependent.id, { operation: "add", dependency: other.id } as never),
      "updateTaskDependencies (ordinary)",
    );

    expect(updated.dependencies).toEqual(expect.arrayContaining([blocker.id, other.id]));
  });
});
