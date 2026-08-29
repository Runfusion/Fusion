import {afterAll, afterEach, beforeAll, beforeEach, expect, it} from "vitest";
import {findArchivedTaskEntry} from "../../task-store/async/async-archive-lineage.js";
import {acquireTaskAdvisoryXactLock, taskAdvisoryLockKey} from "../../task-store/task-advisory-lock.js";
import {TaskIsLiveError} from "../../tasks/task-archive-liveness.js";
import {createSharedPgTaskStoreTestHarness, pgDescribe, type SharedPgTaskStoreHarness} from "../../__test-utils__/pg-test-harness.js";

/*
FNXC:WorkflowLifecycle 2026-08-15-06:35:
The archive verdict must serialize with task admission. These integration cases use the real PG
archive transaction to prove a WIP row writes neither cold storage nor soft-delete state, while
preserving default-off compatibility for other archive owners.
*/
pgDescribe("archive live-task advisory-lock fence", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({prefix: "archive_live_fence"});
  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  it("refuses a live row without writing cold storage or changing its lane", async () => {
    const store = h.store();
    const task = await store.createTask({column: "in-progress", title: "live", description: "live"});

    await expect(store.archiveTask(task.id, {cleanup: false, liveExecutionGuard: "refuse"})).rejects.toBeInstanceOf(TaskIsLiveError);

    const live = await store.getTask(task.id, {includeDeleted: true});
    expect(live.column).toBe("in-progress");
    expect(live.deletedAt).toBeUndefined();
    expect(await findArchivedTaskEntry(h.layer().db, task.id, h.layer().projectId)).toBeUndefined();
  });

  it("rejects a task admitted from todo before its archive transaction", async () => {
    const store = h.store();
    const task = await store.createTask({column: "todo", title: "raced", description: "raced"});
    await store.moveTask(task.id, "in-progress");

    await expect(store.archiveTask(task.id, {cleanup: false, liveExecutionGuard: "refuse"})).rejects.toBeInstanceOf(TaskIsLiveError);

    const live = await store.getTask(task.id, {includeDeleted: true});
    expect(live.column).toBe("in-progress");
    expect(live.deletedAt).toBeUndefined();
    expect(await findArchivedTaskEntry(h.layer().db, task.id, h.layer().projectId)).toBeUndefined();
  });

  it("waits on the same exported advisory key that admission writers hold", async () => {
    const store = h.store();
    const task = await store.createTask({column: "in-progress", title: "serialized", description: "serialized"});
    let settled = false;
    let archive!: Promise<unknown>;

    await h.layer().transactionImmediate(async (tx) => {
      await acquireTaskAdvisoryXactLock(tx, h.layer().projectId, task.id);
      archive = store.archiveTask(task.id, {cleanup: false, liveExecutionGuard: "refuse"}).finally(() => { settled = true; });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(settled, `archive bypassed ${taskAdvisoryLockKey(h.layer().projectId, task.id)}`).toBe(false);
    });
    await expect(archive).rejects.toBeInstanceOf(TaskIsLiveError);
  });

  it("preserves default-off behavior for existing archive callers", async () => {
    const store = h.store();
    const task = await store.createTask({column: "in-progress", title: "legacy", description: "legacy"});

    await store.archiveTask(task.id, {cleanup: false});

    expect((await store.getTask(task.id, {includeDeleted: true})).deletedAt).toBeTruthy();
    expect(await findArchivedTaskEntry(h.layer().db, task.id, h.layer().projectId)).toBeDefined();
  });
});
