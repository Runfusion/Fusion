import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { pgDescribe, createSharedPgTaskStoreTestHarness } from "../__test-utils__/pg-test-harness.js";

/*
FNXC:RuntimeTaskOrchestrationAsync 2026-07-29-18:35:
FN-8361 exercises the live TaskStore persistence path. SQLite runtime support
was removed (VAL-REMOVAL-005), so the PostgreSQL harness is the real supported
storage path rather than a mocked moveTaskInternal seam.
*/
pgDescribe("moveTaskIf live storage path", () => {
  const harness = createSharedPgTaskStoreTestHarness({ prefix: "fusion_move_task_if" });
  beforeAll(harness.beforeAll);
  beforeEach(harness.beforeEach);
  afterEach(harness.afterEach);
  afterAll(harness.afterAll);

  it("moves only when the live predicate permits a real transition", async () => {
    const store = harness.store();
    const task = await store.createTask({ description: "conditional move" });
    const result = await store.moveTaskIf(task.id, "todo", (live) => live.column === "triage");

    expect(result.moved).toBe(true);
    expect(result.task.column).toBe("todo");
    expect((await store.getTask(task.id))?.column).toBe("todo");
  });

  it("skips false predicates, advanced stale candidates, and same-column no-ops", async () => {
    const store = harness.store();
    const falseTask = await store.createTask({ description: "false conditional move" });
    expect((await store.moveTaskIf(falseTask.id, "todo", () => false)).moved).toBe(false);
    expect((await store.getTask(falseTask.id))?.column).toBe("triage");

    const staleTask = await store.createTask({ description: "stale conditional move" });
    await store.getTask(staleTask.id); // Caller captured a stale triage candidate.
    await store.moveTask(staleTask.id, "todo");
    const stale = await store.moveTaskIf(staleTask.id, "todo", (live) => live.column === "triage");
    expect(stale).toMatchObject({ moved: false, task: { column: "todo" } });

    const sameColumn = await store.moveTaskIf(staleTask.id, "todo", () => true);
    expect(sameColumn.moved).toBe(false);
    expect(sameColumn.task.column).toBe("todo");
  });
});
