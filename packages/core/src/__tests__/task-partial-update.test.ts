import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { readFile } from "node:fs/promises";

import { TaskDeletedError, type TaskStore } from "../store.js";
import type { Task } from "../types.js";
import { createSharedTaskStoreTestHarness } from "./store-test-helpers.js";

describe("TaskStore partial task updates", () => {
  const harness = createSharedTaskStoreTestHarness();
  let store: TaskStore;
  let rootDir: string;

  beforeAll(harness.beforeAll);

  beforeEach(async () => {
    await harness.beforeEach();
    store = harness.store();
    rootDir = harness.rootDir();
  });

  afterEach(async () => {
    await harness.afterEach();
  });

  afterAll(harness.afterAll);

  async function captureTaskSql(action: () => Promise<unknown>): Promise<string[]> {
    const db = store.getDatabase();
    const originalPrepare = db.prepare.bind(db);
    const statements: string[] = [];
    const spy = vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
      if (/UPDATE tasks\s+SET|INSERT INTO tasks/i.test(sql)) {
        statements.push(sql.replace(/\s+/g, " ").trim());
      }
      return originalPrepare(sql);
    }) as typeof db.prepare);
    try {
      await action();
    } finally {
      spy.mockRestore();
    }
    return statements;
  }

  function expectLatestUpdate(statements: string[]): string {
    const sql = [...statements].reverse().find((statement) => statement.startsWith("UPDATE tasks SET") || statement.startsWith("UPDATE tasks SET "));
    expect(sql).toBeTruthy();
    return sql!;
  }

  it("updates only changed fields plus log and updatedAt for a hot updateTask path", async () => {
    const task = await store.createTask({ title: "Hot path", description: "status flip" });

    const statements = await captureTaskSql(() => store.updateTask(task.id, { status: "working" }));
    const sql = expectLatestUpdate(statements);

    expect(sql).toContain("status = ?");
    expect(sql).toContain("updatedAt = ?");
    expect(sql).not.toContain("description = ?");
    expect(sql).not.toContain("steps = ?");
    expect(sql).not.toContain("tokenUsageTotalTokens = ?");

    const diskTask = JSON.parse(await readFile(join(rootDir, ".fusion", "tasks", task.id, "task.json"), "utf8")) as Task;
    expect(diskTask.status).toBe("working");
  });

  it("keeps no-op updates narrow and excludes unchanged fields from the SET list", async () => {
    const task = await store.createTask({ title: "Same title", description: "unchanged" });

    const statements = await captureTaskSql(() => store.updateTask(task.id, { title: "Same title" }));
    const sql = expectLatestUpdate(statements);

    expect(sql).toContain("updatedAt = ?");
    expect(sql).not.toContain("title = ?");
    expect(sql).not.toContain("description = ?");
    expect(sql).not.toContain("steps = ?");
  });

  it("persists field clears via the partial path", async () => {
    const task = await store.createTask({ title: "Clear me", description: "field clear" });
    await store.updateTask(task.id, { error: "boom" });

    const statements = await captureTaskSql(() => store.updateTask(task.id, { error: null }));
    const sql = expectLatestUpdate(statements);
    expect(sql).toContain("error = ?");
    expect(sql).not.toContain("description = ?");

    const refreshed = await store.getTask(task.id);
    expect(refreshed?.error).toBeUndefined();
  });

  it("preserves FTS behavior for text changes and skips FTS rewrites for non-text changes", async () => {
    const task = await store.createTask({ title: "Alpha", description: "Bravo" });
    const db = store.getDatabase();
    const ftsRowQuery = `
      SELECT fts.rowid as rowid, tasks.id as id, fts.title as title, fts.description as description, fts.comments as comments
      FROM tasks_fts fts
      JOIN tasks ON tasks.rowid = fts.rowid
      WHERE tasks.id = ?
    `;

    const before = db.prepare(ftsRowQuery).get(task.id) as Record<string, unknown> | undefined;
    expect(before).toBeTruthy();

    await store.updateTask(task.id, { status: "queued" });
    const afterStatus = db.prepare(ftsRowQuery).get(task.id) as Record<string, unknown> | undefined;
    expect(afterStatus).toEqual(before);

    await store.updateTask(task.id, { title: "Needle title" });
    const results = await store.searchTasks("Needle");
    expect(results.map((entry) => entry.id)).toContain(task.id);
  });

  it("preserves soft-delete guard parity and records resurrection-blocked audit events", async () => {
    const task = await store.createTask({ title: "Deleted", description: "guard" });
    const dir = join(rootDir, ".fusion", "tasks", task.id);
    await store.deleteTask(task.id);

    await expect((store as any).atomicWriteTaskJson(dir, { ...task, title: "after delete" })).rejects.toBeInstanceOf(TaskDeletedError);

    const events = (store as any).db.prepare(
      "SELECT mutationType, metadata FROM runAuditEvents WHERE taskId = ? AND mutationType = ? ORDER BY timestamp ASC"
    ).all(task.id, "task:resurrection-blocked") as Array<{ mutationType: string; metadata: string | null }>;
    expect(events).toHaveLength(1);
    expect(events[0]?.mutationType).toBe("task:resurrection-blocked");
    expect(events[0]?.metadata ?? "").toContain("atomicWriteTaskJson");
  });

  it("keeps run-audit metadata parity on updateTask with runContext", async () => {
    const task = await store.createTask({ title: "Audit me", description: "audit" });

    await store.updateTask(task.id, { title: "Audited" }, { runId: "run-partial-update", agentId: "agent-1" });

    const events = store.getRunAuditEvents({ runId: "run-partial-update" });
    const updateEvent = events.find((event) => event.mutationType === "task:update");
    expect(updateEvent?.metadata).toEqual({ updatedFields: ["title"] });
  });

  it("bumps lastModified exactly once per converted update mutation", async () => {
    const task = await store.createTask({ title: "Single bump", description: "counter" });
    const db = store.getDatabase();
    const bumpSpy = vi.spyOn(db, "bumpLastModified");

    await store.updateTask(task.id, { status: "queued" });

    expect(bumpSpy).toHaveBeenCalledTimes(1);
  });

  it("renews checkout leases with a targeted checkout UPDATE", async () => {
    const task = await store.createTask({ title: "Lease", description: "renew" });
    await store.updateTask(task.id, {
      checkedOutBy: "agent-1",
      checkedOutAt: "2026-01-01T00:00:00.000Z",
      checkoutNodeId: "node-1",
      checkoutRunId: "run-old",
      checkoutLeaseRenewedAt: "2026-01-01T00:00:00.000Z",
      checkoutLeaseEpoch: 1,
    });

    const renewedAt = "2026-01-01T00:01:00.000Z";
    const statements = await captureTaskSql(() => store.renewCheckoutLease(task.id, {
      checkoutRunId: "run-new",
      checkoutLeaseRenewedAt: renewedAt,
    }));
    const sql = expectLatestUpdate(statements);

    expect(sql).toContain("checkoutRunId = ?");
    expect(sql).toContain("checkoutLeaseRenewedAt = ?");
    expect(sql).toContain("updatedAt = ?");
    expect(sql).not.toContain("title = ?");
    expect(sql).not.toContain("description = ?");
    expect(sql).not.toContain("steps = ?");

    const refreshed = await store.getTask(task.id);
    expect(refreshed?.checkoutRunId).toBe("run-new");
    expect(refreshed?.checkoutLeaseRenewedAt).toBe(renewedAt);
  });

  it("keeps create and direct upsert/replication paths on full-row SQL", async () => {
    const createStatements = await captureTaskSql(() => store.createTask({ title: "Create path", description: "full insert" }));
    expect(createStatements.some((statement) => statement.startsWith("INSERT INTO tasks (") && !statement.startsWith("UPDATE tasks SET"))).toBe(true);

    const task = await store.createTask({ title: "Replicate me", description: "full upsert" });
    const replicatedTask = { ...task, title: "Replicated title", updatedAt: new Date(Date.now() + 1_000).toISOString() };
    const upsertStatements = await captureTaskSql(async () => {
      (store as any).upsertTaskWithFtsRecovery(replicatedTask);
    });
    expect(upsertStatements.some((statement) => statement.includes("ON CONFLICT(id) DO UPDATE SET"))).toBe(true);
  });
});
