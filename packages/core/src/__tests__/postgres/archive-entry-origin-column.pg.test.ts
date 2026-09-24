import {afterAll, afterEach, beforeAll, beforeEach, expect, it} from "vitest";
import {findArchivedTaskEntry} from "../../task-store/async/async-archive-lineage.js";
import {TaskIsLiveError} from "../../tasks/task-archive-liveness.js";
import {createSharedPgTaskStoreTestHarness, pgDescribe, type SharedPgTaskStoreHarness} from "../../__test-utils__/pg-test-harness.js";
import type {TaskStore} from "../../store.js";

/*
FNXC:ArchiveLogAttribution 2026-09-19-07:22:
THE RACE, ON THE REAL BACKEND. `archiveTask` reads the row, then does work that can outlive a
concurrent move (workspace-disposal preparation, lineage resolution) before opening its archive
transaction. The snapshot used to be built from that first read, so the committed archive named a
lane the card had already left. These cases move the row INSIDE that window on a real PostgreSQL
store and assert what cold storage ends up saying.
*/
pgDescribe("the archive entry's origin column comes from the archive transaction's row", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({prefix: "archive_origin_column"});
  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  /*
  Land a concurrent write in the window the finding names: after `archiveTaskBackendImpl`'s
  pre-transaction `getTask`, before its transaction. The wrapper is removed before it acts, so the
  action's own reads run untouched, and it fires exactly once.
  */
  async function actInsideTheArchiveWindow(store: TaskStore, taskId: string, action: () => Promise<void>): Promise<void> {
    const originalRead = store.getTask.bind(store);
    let raced = false;
    (store as unknown as {getTask: unknown}).getTask = async (id: string, options?: {includeDeleted?: boolean}) => {
      const read = await originalRead(id, options);
      if (!raced && id === taskId) {
        raced = true;
        (store as unknown as {getTask: unknown}).getTask = originalRead;
        await action();
      }
      return read;
    };
  }

  const moveInsideTheArchiveWindow = (store: TaskStore, taskId: string, to: string) =>
    actInsideTheArchiveWindow(store, taskId, async () => { await store.moveTask(taskId, to); });

  it("files the snapshot under the lane the transaction read, not the pre-transaction read", async () => {
    const store = h.store();
    const task = await store.createTask({column: "todo", title: "raced", description: "raced"});
    await moveInsideTheArchiveWindow(store, task.id, "in-progress");

    await store.archiveTask(task.id, {
      cleanup: false,
      auditContext: {agentId: "engine", runId: `auto-archive-${task.id}-1`, callerKind: "engine"},
    });

    const entry = await findArchivedTaskEntry(h.layer().db, task.id, h.layer().projectId);
    // Pre-fix both of these named `todo` — the lane from before the move.
    expect(entry?.preArchiveColumn).toBe("in-progress");
    expect(entry?.log[0].action).toBe("Task archived from in-progress by engine (engine)");
  });

  it("carries the locked row's mutable state into the snapshot, not the pre-transaction read", async () => {
    /*
    FNXC:ArchiveLogAttribution 2026-09-24-00:20:
    Devin PR-3561 flag "Archive snapshot mixes two row versions": the re-anchored origin named the
    locked row while status/timestamps stayed on the earlier read's version. The snapshot must be
    ONE row version — the one the archive transaction read under the lock.
    */
    const store = h.store();
    const task = await store.createTask({column: "todo", title: "raced-state", description: "raced-state"});
    let racedRow: Awaited<ReturnType<TaskStore["getTask"]>> | undefined;
    await actInsideTheArchiveWindow(store, task.id, async () => {
      await store.moveTask(task.id, "in-progress");
      await store.updateTask(task.id, {title: "renamed-inside-the-window", description: "rewritten-inside-the-window", autoMerge: true, sourceIssue: {id: "ISS-9", provider: "github", type: "issue"}});
      racedRow = await store.getTask(task.id);
    });

    await store.archiveTask(task.id, {
      cleanup: false,
      auditContext: {agentId: "engine", runId: `auto-archive-${task.id}-3`, callerKind: "engine"},
    });

    const entry = await findArchivedTaskEntry(h.layer().db, task.id, h.layer().projectId);
    // Pre-fix: the new column with the pre-move timestamps — two row versions in one record.
    expect(entry?.updatedAt).toBe(racedRow?.updatedAt);
    expect(entry?.columnMovedAt).toBe(racedRow?.columnMovedAt);
    /*
    Greptile P1 "Archive Snapshot Keeps Stale Fields" (PR-3561): EVERY row-derived field must come
    from the locked read, not only the re-anchored origin — a concurrent title/description edit is
    otherwise lost from the archive forever.
    */
    expect(entry?.title).toBe("renamed-inside-the-window");
    expect(entry?.description).toBe("rewritten-inside-the-window");
    /*
    Greptile P1 "Raw Row Corrupts Snapshot" + Devin "Archived tasks lose source and branch context"
    (PR-3561): the locked row is RAW - composite (sourceIssue) and coerced (autoMerge) fields must
    come hydrated through pgRowToTaskRow/rowToTask, not straight off the row cast to Task.
    */
    expect(entry?.autoMerge).toBe(true);
    expect(entry?.sourceIssue).toEqual(racedRow?.sourceIssue);
  });

  it("emits task:moved naming the lane the transaction read, not the pre-transaction read", async () => {
    const store = h.store();
    const task = await store.createTask({column: "todo", title: "raced-event", description: "raced-event"});
    const movedFrom: string[] = [];
    const originalEmit = store.emit.bind(store) as (...args: unknown[]) => unknown;
    (store as unknown as {emit: unknown}).emit = (...args: unknown[]) => {
      const [event, payload] = args as [string, { from?: unknown; to?: unknown }];
      if (event === "task:moved" && payload.to === "archived") movedFrom.push(String(payload.from));
      return originalEmit(...args);
    };
    try {
      await moveInsideTheArchiveWindow(store, task.id, "in-progress");
      await store.archiveTask(task.id, {
        cleanup: false,
        auditContext: {agentId: "engine", runId: `auto-archive-${task.id}-2`, callerKind: "engine"},
      });
    } finally {
      (store as unknown as {emit: unknown}).emit = originalEmit;
    }
    // Pre-fix this event named `todo` — the pre-transaction read — while the snapshot filed beside
    // it named `in-progress`: one move, two permanent records, disagreeing.
    expect(movedFrom).toEqual(["in-progress"]);
  });

  it("refuses the same race under the live-execution guard, which reads the same row", async () => {
    const store = h.store();
    const task = await store.createTask({column: "todo", title: "guarded", description: "guarded"});
    await moveInsideTheArchiveWindow(store, task.id, "in-progress");

    // The guard sees the lane the transaction read, so attribution and refusal cannot disagree
    // about which row they are describing.
    await expect(store.archiveTask(task.id, {cleanup: false, liveExecutionGuard: "refuse"}))
      .rejects.toBeInstanceOf(TaskIsLiveError);
    expect(await findArchivedTaskEntry(h.layer().db, task.id, h.layer().projectId)).toBeUndefined();
  });

  it("keeps the legacy api-unattributed/system line for a context-less archive", async () => {
    const store = h.store();
    const task = await store.createTask({column: "todo", title: "legacy", description: "legacy"});
    await moveInsideTheArchiveWindow(store, task.id, "in-progress");

    await store.archiveTask(task.id, {cleanup: false});

    const entry = await findArchivedTaskEntry(h.layer().db, task.id, h.layer().projectId);
    expect(entry?.log[0].action).toBe("Task archived from in-progress by api-unattributed (system)");
  });

  it("refuses the archive when the row is deleted inside the archive window", async () => {
    const store = h.store();
    const task = await store.createTask({column: "todo", title: "vanishing", description: "vanishing"});
    // A concurrent delete commits after the archive request's own read. The transaction's
    // authoritative read then finds no live row, so there is nothing to re-anchor to and nothing
    // for the soft-delete to claim: a conflict, never a success on the stale snapshot.
    await actInsideTheArchiveWindow(store, task.id, async () => {
      await store.deleteTaskBackend(task.id, {});
    });

    await expect(store.archiveTask(task.id, {
      cleanup: false,
      auditContext: {agentId: "engine", runId: `auto-archive-${task.id}-9`, callerKind: "engine"},
    })).rejects.toThrow(/was deleted before the archive transaction/);
  });
});
