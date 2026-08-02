// @vitest-environment node

/*
FNXC:TaskDeletion 2026-07-30-19:00 (PG cutover fallout):
What this file used to assert, and why most of it is GONE rather than repaired.

It covered "delete soft-deletes before delayed branch cleanup finishes", driven through a SQLite
store fake that matched raw SQL strings (`UPDATE tasks SET "column" = 'archived'`). Both cases went
red on main with "store.deleteTaskBackend is not a function": `deleteTaskImpl` is now a thin
delegator onto the PostgreSQL backend, and the SQLite arms the fake modelled were deleted
(FNXC:SqliteDualPathCleanup 2026-07-26).

The non-blocking-branch-cleanup behaviour this file was NAMED for no longer exists on the delete
path. `_scheduleDeleteBranchCleanup` in archive-lifecycle.ts has exactly ONE reference in the tree —
its own definition — and the only live `store.cleanupBranchForTask` call is in the ARCHIVE path
(archive-lifecycle-2.ts:306). So those cases were not adapted: asserting that delete schedules branch
cleanup would pin behaviour the product does not have, and reshaping the fake until they passed would
be appeasement.

What survives are the gates that are still real, rewritten against the PG backend so they exercise
the delegation rather than a mock.
*/

import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "../types.js";
import { softDeleteTaskRowInTransaction } from "../task-store/async-persistence.js";

let pgRow: Task | null = null;
let lineageChildIds: string[] = [];

vi.mock("../task-store/async-persistence.js", () => ({
  readTaskRow: vi.fn(async () => pgRow),
  readTaskRowInTransaction: vi.fn(async () => pgRow),
  softDeleteTaskRowInTransaction: vi.fn(async () => true),
}));
vi.mock("../task-store/async-lifecycle.js", () => ({
  findLiveLineageChildren: vi.fn(async () => lineageChildIds),
  projectPartition: vi.fn(() => undefined),
  removeLineageReferences: vi.fn(async () => undefined),
}));
/*
FNXC:LifecycleOutbox 2026-08-01-11:02:
This in-memory delete harness has no PostgreSQL transaction executor. Mock the
transaction-scoped writer at its module boundary so deletion-gate tests remain
focused while the real backend always persists the lifecycle event transactionally.
*/
vi.mock("../task-store/lifecycle-outbox.js", () => ({
  appendTaskLifecycleEventInTransaction: vi.fn(async () => ({ seq: "1", eventId: "test-event" })),
}));
vi.mock("../async-mission-store-queries.js", () => ({
  getFeatureByTaskId: vi.fn(async () => null),
  unlinkFeatureFromTaskId: vi.fn(async () => undefined),
  recordGeneratedFixOperatorStop: vi.fn(async () => undefined),
}));

import { deleteTaskImpl } from "../task-store/archive-lifecycle.js";
import { setupActivityLogListenersImpl } from "../task-store/lifecycle-ops.js";
import { deleteTaskBackendImpl } from "../task-store/archive-lifecycle-2.js";

function createTask(overrides: Partial<Task> & { id: string }): Task {
  const now = "2026-07-15T09:00:00.000Z";
  return {
    title: overrides.id,
    description: overrides.id,
    column: "todo",
    dependencies: [],
    createdAt: now,
    updatedAt: now,
    size: "M",
    subtasks: [],
    log: [],
    tags: [],
    blockedBy: [],
    source: { sourceType: "api" },
    ...overrides,
    id: overrides.id,
  } as Task;
}

type AuditRow = { mutationType: string; taskId?: string };

/** PostgreSQL-path store fake; the real backend impl is wired in, not stubbed. */
function makeDeleteStore(task: Task, children: string[] = []) {
  const events = new EventEmitter();
  const auditEvents: AuditRow[] = [];
  pgRow = task;
  lineageChildIds = children;

  const store = {
    backendMode: true,
    isWatching: true,
    taskCache: new Map<string, Task>([[task.id, task]]),
    laneCache: { invalidate: vi.fn() },
    asyncLayer: {
      db: {},
      projectId: "project-1",
      transactionImmediate: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
    },
    rowToTask: vi.fn((row: unknown) => row as Task),
    pgRowToTaskRow: vi.fn((row: unknown) => row),
    // Signature is (tx, event) — the transaction handle comes FIRST.
    recordRunAuditEventBackend: vi.fn(async (_tx: unknown, event: AuditRow) => {
      auditEvents.push(event);
    }),
    makeSyntheticDeleteRunId: vi.fn((id: string) => `synthetic-delete-${id}`),
    laneCache: { invalidate: vi.fn() },
    withTaskLock: vi.fn(async (_id: string, fn: () => Promise<unknown>) => fn()),
    cleanupBranchForTask: vi.fn(async () => [] as string[]),
    clearNearDuplicateReferencesToFailSoft: vi.fn(async () => undefined),
    emit: vi.fn((event: string, ...args: unknown[]) => events.emit(event, ...args)),
    on: events.on.bind(events),
    getAuditEvents: () => auditEvents,
  } as Record<string, unknown>;

  store.deleteTaskBackend = (id: string, options?: unknown) =>
    deleteTaskBackendImpl(store as never, id, options as never);
  return store as typeof store & {
    getAuditEvents: () => AuditRow[];
    cleanupBranchForTask: ReturnType<typeof vi.fn>;
  };
}

describe("deleteTask gates that survived the PostgreSQL cutover", () => {
  it("keeps in-process task:deleted emissions and activity rows exact for each delete data state", async () => {
    const activityRows: Array<{ type: string; taskId?: string }> = [];
    const deletedEvents: string[] = [];
    const liveStore = makeDeleteStore(createTask({ id: "FN-LIVE" }));
    liveStore.activityListenersWired = false;
    liveStore.recordActivityFromListener = vi.fn((entry: { type: string; taskId?: string }) => activityRows.push(entry));
    setupActivityLogListenersImpl(liveStore as never);
    liveStore.on("task:deleted", (task: Task) => deletedEvents.push(task.id));

    await deleteTaskImpl(liveStore as never, "FN-LIVE");
    expect(deletedEvents).toEqual(["FN-LIVE"]);
    expect(activityRows.filter((entry) => entry.type === "task:deleted")).toEqual([{ type: "task:deleted", taskId: "FN-LIVE", taskTitle: "FN-LIVE", details: "Task FN-LIVE deleted: FN-LIVE" }]);

    const archivedRows: Array<{ type: string; taskId?: string }> = [];
    const archivedEvents: string[] = [];
    const archivedStore = makeDeleteStore(createTask({ id: "FN-ARCHIVED", column: "archived" }));
    archivedStore.activityListenersWired = false;
    archivedStore.recordActivityFromListener = vi.fn((entry: { type: string; taskId?: string }) => archivedRows.push(entry));
    setupActivityLogListenersImpl(archivedStore as never);
    archivedStore.on("task:deleted", (task: Task) => archivedEvents.push(task.id));

    await deleteTaskImpl(archivedStore as never, "FN-ARCHIVED");
    expect(archivedEvents).toEqual(["FN-ARCHIVED"]);
    expect(archivedRows.filter((entry) => entry.type === "task:deleted")).toHaveLength(1);

    const alreadyDeletedRows: Array<{ type: string }> = [];
    const alreadyDeletedEvents: string[] = [];
    const alreadyDeletedStore = makeDeleteStore(createTask({ id: "FN-ALREADY-DELETED", deletedAt: "2026-07-15T09:01:00.000Z", column: "archived" }));
    alreadyDeletedStore.activityListenersWired = false;
    alreadyDeletedStore.recordActivityFromListener = vi.fn((entry: { type: string }) => alreadyDeletedRows.push(entry));
    setupActivityLogListenersImpl(alreadyDeletedStore as never);
    alreadyDeletedStore.on("task:deleted", (task: Task) => alreadyDeletedEvents.push(task.id));

    await deleteTaskImpl(alreadyDeletedStore as never, "FN-ALREADY-DELETED");
    expect(alreadyDeletedEvents).toEqual([]);
    expect(alreadyDeletedRows.filter((entry) => entry.type === "task:deleted")).toEqual([]);

    const unknownRows: Array<{ type: string }> = [];
    const unknownEvents: string[] = [];
    const unknownStore = makeDeleteStore(createTask({ id: "FN-UNKNOWN-SEED" }));
    pgRow = null;
    unknownStore.activityListenersWired = false;
    unknownStore.recordActivityFromListener = vi.fn((entry: { type: string }) => unknownRows.push(entry));
    setupActivityLogListenersImpl(unknownStore as never);
    unknownStore.on("task:deleted", (task: Task) => unknownEvents.push(task.id));

    await expect(deleteTaskImpl(unknownStore as never, "FN-UNKNOWN")).rejects.toMatchObject({ name: "TaskNotFoundError", taskId: "FN-UNKNOWN" });
    expect(unknownEvents).toEqual([]);
    expect(unknownRows.filter((entry) => entry.type === "task:deleted")).toEqual([]);
  });


  /*
  FNXC:TaskDeletion 2026-07-30-20:15 (PR #2697 review — greptile):
  The module mock is shared across this file and the config clears nothing, so a call-count
  assertion would otherwise depend on which tests ran before it. Cleared per test so the count
  means "this test", not "the file so far".
  */
  beforeEach(() => {
    vi.mocked(softDeleteTaskRowInTransaction).mockClear();
  });

  it("is idempotent: re-deleting an already soft-deleted task is a no-op with no audit row", async () => {
    const task = createTask({ id: "FN-DELETED", deletedAt: "2026-07-15T09:01:00.000Z", column: "archived" });
    const store = makeDeleteStore(task);

    await expect(deleteTaskImpl(store as never, task.id)).resolves.toMatchObject({ id: task.id });

    // No second audit row, and no destructive work on a row that is already gone.
    expect(store.getAuditEvents()).toHaveLength(0);
    expect(store.cleanupBranchForTask).not.toHaveBeenCalled();
  });

  it("refuses to delete a parent with live lineage children unless references are removed", async () => {
    const parent = createTask({ id: "FN-LINEAGE-PARENT", branch: "fusion/lineage-parent" });
    const store = makeDeleteStore(parent, ["FN-LINEAGE-CHILD"]);

    await expect(deleteTaskImpl(store as never, parent.id))
      .rejects.toMatchObject({ name: "TaskHasLineageChildrenError" });

    // A rejected gate must not emit an audit row for a delete that did not happen.
    expect(store.getAuditEvents()).toHaveLength(0);
  });

  it("deletes a clean task and records exactly one task:deleted audit row", async () => {
    const task = createTask({ id: "FN-CLEAN" });
    const store = makeDeleteStore(task);

    const emitted: string[] = [];
    store.on("task:deleted", (deleted: Task) => emitted.push(deleted.id));

    const deleted = await deleteTaskImpl(store as never, task.id);

    expect(deleted).toMatchObject({ id: task.id });
    /*
    FNXC:TaskDeletion 2026-07-30-20:15 (PR #2697 review — greptile):
    THE PERSISTENCE CALL IS THE DELETION; the audit row and the event are only its announcements.
    Asserted first and by name because without it, removing the soft-delete write while leaving the
    two side effects in place still passed — the suite would have reported a task deleted that was
    still in the table, which is the one outcome this file exists to prevent.
    */
    expect(softDeleteTaskRowInTransaction).toHaveBeenCalledTimes(1);
    expect(vi.mocked(softDeleteTaskRowInTransaction).mock.calls[0]?.[1]).toBe(task.id);

    expect(store.getAuditEvents().filter((event) => event.mutationType === "task:deleted")).toHaveLength(1);
    expect(emitted).toEqual([task.id]);
    /*
    Deliberately NOT asserting `deleted.deletedAt`. The PG backend returns the PRE-delete snapshot —
    its own comment says so ("`task` is still the pre-delete snapshot at this point") because the
    lifecycle emit and the audit row both need the previous column. My first draft asserted a
    populated `deletedAt` here and failed: that was my assumption about the contract, not the
    contract. Recorded so nobody "fixes" the impl to satisfy the wrong expectation.
    */
  });
});

/*
FNXC:TaskDeletion 2026-07-30-19:00 FLAGGED, NOT FIXED:
The DEPENDENTS gate is not asserted here because it appears to be GONE from the delete path.

The removed version of this file asserted `TaskHasDependentsError` when deleting a task other live
tasks depend on. That error is neither imported nor thrown anywhere in archive-lifecycle-2.ts — the
PG backend raises only `TaskHasLineageChildrenError`, `TaskNotFoundError` and `TaskSelfDeleteError`.

Two readings, and choosing between them is a product question rather than a test fix: either the
delete path now REWRITES dependency references (there is a `removeDependencyReferences` option and a
`rewriteDependentsForRemoval` impl) and blocking was dropped deliberately, or the gate was lost in
the cutover and a task can be soft-deleted out from under its dependents. Asserting either shape
would encode a guess, so this records the question instead.
*/
