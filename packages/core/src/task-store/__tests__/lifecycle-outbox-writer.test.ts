/*
FNXC:LifecycleOutbox 2026-08-01-10:51:
The lifecycle outbox is a PostgreSQL cross-process contract, so these tests use real independent
connections rather than mocks. In particular the barrier holds two live snapshots before either
conditional delete claim, which proves the old TOCTOU duplication cannot return unnoticed.
*/
import { afterEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { readFile } from "node:fs/promises";
import {
  createTaskStoreForTest,
  pgDescribe,
  type PgTestHarness,
} from "../../__test-utils__/pg-test-harness.js";
import { TaskStore } from "../../store.js";
import { createAsyncDataLayer, type AsyncDataLayer } from "../../postgres/data-layer.js";
import { createConnectionSetFromUrl } from "../../postgres/connection.js";
import type { ResolvedBackend } from "../../postgres/backend-resolver.js";
import * as schema from "../../postgres/schema/index.js";
import { countRunAuditEvents } from "../async/async-audit.js";
import { softDeleteTaskRowInTransaction } from "../async/async-persistence.js";
import {
  makeTaskLifecycleEventId,
  type TaskDeletedLifecyclePayload,
} from "../lifecycle-outbox.js";
import { registerTaskDeleteNoticeMailbox } from "../../task-delete-notice.js";

const pgTest = pgDescribe;
const PROJECT_ID = "__legacy_unscoped__";

type DeleteTestStore = TaskStore & {
  __beforeDeleteClaimForTest?: (taskId: string) => void | Promise<void>;
  __afterLifecycleOutboxWriteForTest?: () => void | Promise<void>;
};

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function lifecycleRows(h: PgTestHarness, taskId: string) {
  return h.layer.db.select().from(schema.project.taskLifecycleEvents).where(and(
    eq(schema.project.taskLifecycleEvents.projectId, PROJECT_ID),
    eq(schema.project.taskLifecycleEvents.taskId, taskId),
  ));
}

async function newIndependentStore(h: PgTestHarness): Promise<{ store: TaskStore; layer: AsyncDataLayer }> {
  const backend: ResolvedBackend = {
    mode: "external", runtimeUrl: h.testUrl, migrationUrl: h.testUrl, migrationUrlOverridden: false,
  };
  const connections = await createConnectionSetFromUrl(backend, { poolMax: 1, connectTimeoutSeconds: 5 });
  const layer = createAsyncDataLayer(connections);
  return { store: new TaskStore(h.rootDir, undefined, { asyncLayer: layer }), layer };
}

function attachMailbox(store: TaskStore, notices: string[]): void {
  registerTaskDeleteNoticeMailbox(store, {
    sendMessageOnce: vi.fn(async (_input, key) => { notices.push(key); return { inserted: true }; }),
  });
}

const payload: TaskDeletedLifecyclePayload = {
  taskId: "FN-1", previousColumn: "todo", previousStatus: null,
  deletedAt: "2026-08-01T10:33:00.000Z", allowResurrection: false,
  githubIssueAction: null, deletedBy: null,
};

describe("task lifecycle outbox identity", () => {
  it("uses a deterministic opaque project-scoped identity and fixed ids-only payload", () => {
    const input = ["project-a", "task:deleted", payload.taskId, payload.deletedAt] as const;
    expect(makeTaskLifecycleEventId(...input)).toBe(makeTaskLifecycleEventId(...input));
    expect(makeTaskLifecycleEventId(...input)).not.toBe(makeTaskLifecycleEventId("project-b", ...input.slice(1)));
    expect(Object.keys(payload).sort()).toEqual([
      "allowResurrection", "deletedAt", "deletedBy", "githubIssueAction",
      "previousColumn", "previousStatus", "taskId",
    ]);
  });
});

pgTest("transactional task:deleted lifecycle outbox writer (PostgreSQL)", () => {
  let h: PgTestHarness | undefined;
  let second: Awaited<ReturnType<typeof newIndependentStore>> | undefined;

  afterEach(async () => {
    await second?.store.close().catch(() => {});
    await second?.layer.close().catch(() => {});
    second = undefined;
    await h?.teardown();
    h = undefined;
  });

  it("wins exactly one deterministic two-store same-task race and returns the re-read deletion", async () => {
    h = await createTaskStoreForTest({ prefix: "lifecycle_outbox_race", copyFromGolden: true });
    second = await newIndependentStore(h);
    const task = await h.store.createTask({ description: "same-task race" });
    const notices: string[] = [];
    attachMailbox(h.store, notices);
    attachMailbox(second.store, notices);
    const arrivedA = deferred();
    const arrivedB = deferred();
    const release = deferred();
    (h.store as DeleteTestStore).__beforeDeleteClaimForTest = async () => { arrivedA.resolve(); await release.promise; };
    (second.store as DeleteTestStore).__beforeDeleteClaimForTest = async () => { arrivedB.resolve(); await release.promise; };
    const emitA = vi.spyOn(h.store, "emit");
    const emitB = vi.spyOn(second.store, "emit");

    const deletingA = h.store.deleteTask(task.id);
    const deletingB = second.store.deleteTask(task.id);
    await Promise.all([arrivedA.promise, arrivedB.promise]);
    release.resolve();
    const [resultA, resultB] = await Promise.all([deletingA, deletingB]);

    const rows = await lifecycleRows(h, task.id);
    expect(rows).toHaveLength(1);
    expect(await countRunAuditEvents(h.layer.db, { taskId: task.id, mutationType: "task:deleted" })).toBe(1);
    expect(notices).toHaveLength(1);
    expect([emitA, emitB].flatMap((spy) => spy.mock.calls).filter(([event]) => event === "task:deleted")).toHaveLength(1);
    expect(resultA.deletedAt).toBeTruthy();
    expect(resultB.deletedAt).toBe(resultA.deletedAt);
    await expect(h.layer.transactionImmediate((tx) => softDeleteTaskRowInTransaction(tx, task.id, new Date().toISOString(), false, PROJECT_ID, true))).resolves.toBe(false);
  });

  it("reports only the claim winner as deleted in a deterministic two-store deleteTaskIf race", async () => {
    h = await createTaskStoreForTest({ prefix: "lifecycle_outbox_conditional_race", copyFromGolden: true });
    second = await newIndependentStore(h);
    const task = await h.store.createTask({ description: "same-task conditional race" });
    const notices: string[] = [];
    attachMailbox(h.store, notices);
    attachMailbox(second.store, notices);
    const arrivedA = deferred();
    const arrivedB = deferred();
    const release = deferred();
    (h.store as DeleteTestStore).__beforeDeleteClaimForTest = async () => { arrivedA.resolve(); await release.promise; };
    (second.store as DeleteTestStore).__beforeDeleteClaimForTest = async () => { arrivedB.resolve(); await release.promise; };
    const emitA = vi.spyOn(h.store, "emit");
    const emitB = vi.spyOn(second.store, "emit");

    const deletingA = h.store.deleteTaskIf(task.id, () => true);
    const deletingB = second.store.deleteTaskIf(task.id, () => true);
    await Promise.all([arrivedA.promise, arrivedB.promise]);
    release.resolve();
    const [resultA, resultB] = await Promise.all([deletingA, deletingB]);

    expect([resultA.deleted, resultB.deleted].filter(Boolean)).toHaveLength(1);
    expect(resultA.task.deletedAt).toBeTruthy();
    expect(resultB.task.deletedAt).toBe(resultA.task.deletedAt);
    expect(await lifecycleRows(h, task.id)).toHaveLength(1);
    expect(await countRunAuditEvents(h.layer.db, { taskId: task.id, mutationType: "task:deleted" })).toBe(1);
    expect(notices).toHaveLength(1);
    expect([emitA, emitB].flatMap((spy) => spy.mock.calls).filter(([event]) => event === "task:deleted")).toHaveLength(1);
  });

  it("rolls back the soft-delete, audit, outbox, and transactional counter together", async () => {
    h = await createTaskStoreForTest({ prefix: "lifecycle_outbox_atomic", copyFromGolden: true });
    const task = await h.store.createTask({ description: "rollback target" });
    const notices: string[] = [];
    attachMailbox(h.store, notices);
    (h.store as DeleteTestStore).__afterLifecycleOutboxWriteForTest = () => { throw new Error("inject rollback"); };

    await expect(h.store.deleteTask(task.id)).rejects.toThrow("inject rollback");
    expect(await lifecycleRows(h, task.id)).toHaveLength(0);
    expect(await countRunAuditEvents(h.layer.db, { taskId: task.id, mutationType: "task:deleted" })).toBe(0);
    expect((await h.store.getTask(task.id, { includeDeleted: true })).deletedAt).toBeFalsy();
    expect(notices).toHaveLength(0);
    expect(await h.layer.db.select().from(schema.project.taskLifecycleEventSeq)).toHaveLength(0);

    delete (h.store as DeleteTestStore).__afterLifecycleOutboxWriteForTest;
    await h.store.deleteTask(task.id);
    const rows = await lifecycleRows(h, task.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.seq).toBe(1n);
  });

  it("serializes distinct deletes without collisions while no-op paths write nothing", async () => {
    h = await createTaskStoreForTest({ prefix: "lifecycle_outbox_distinct", copyFromGolden: true });
    const tasks = await Promise.all(Array.from({ length: 4 }, (_, index) => h!.store.createTask({ description: `distinct ${index}` })));
    await Promise.all(tasks.map((task) => h!.store.deleteTask(task.id)));
    const rows = await h.layer.db.select().from(schema.project.taskLifecycleEvents).orderBy(schema.project.taskLifecycleEvents.seq);
    expect(rows.map((row) => row.seq)).toEqual([1n, 2n, 3n, 4n]);
    expect((await Promise.all(tasks.map((task) => h!.store.getTask(task.id, { includeDeleted: true })))).every((task) => Boolean(task.deletedAt))).toBe(true);

    await h.store.deleteTask(tasks[0]!.id);
    expect(await lifecycleRows(h, tasks[0]!.id)).toHaveLength(1);
    await expect(h.store.deleteTask("FN-DOES-NOT-EXIST")).rejects.toThrow();
    expect(await h.layer.db.select().from(schema.project.taskLifecycleEvents)).toHaveLength(4);
  });

  it("keeps private deterministic fault hooks absent from ordinary stores and production source", async () => {
    h = await createTaskStoreForTest({ prefix: "lifecycle_outbox_hook", copyFromGolden: true });
    expect((h.store as DeleteTestStore).__beforeDeleteClaimForTest).toBeUndefined();
    expect((h.store as DeleteTestStore).__afterLifecycleOutboxWriteForTest).toBeUndefined();
    const source = await readFile(new URL("../archive-lifecycle-2.ts", import.meta.url), "utf8");
    expect(source.match(/__beforeDeleteClaimForTest\s*=/g) ?? []).toHaveLength(0);
    expect(source.match(/__afterLifecycleOutboxWriteForTest\s*=/g) ?? []).toHaveLength(0);
  });
});
