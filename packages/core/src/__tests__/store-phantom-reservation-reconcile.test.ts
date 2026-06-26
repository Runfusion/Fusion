import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TaskStore } from "../store.js";
import type { Task } from "../types.js";

/*
 * FNXC:TaskStoreConsistency 2026-06-26-00:00:
 * FN-7069 surface checklist covered by this file:
 * - readTaskJson/archiveTask both-absent path returns clean Task <id> not found, not ENOENT.
 * - DB row present + dir missing still archives via DB-first read.
 * - committed reservation with task row is skipped; committed reservation without row/archive/task.json is reconciled.
 * - inMemoryDb reconcile is a no-op.
 * - store init entry point runs the same reconcile as the direct API. Desktop/mobile UI surfaces are N/A.
 */

describe("TaskStore phantom committed-reservation reconciliation", () => {
  let rootDir: string;
  let globalDir: string;
  let store: TaskStore;

  beforeEach(async () => {
    rootDir = mkdtempSync(join(tmpdir(), "fusion-phantom-reservation-"));
    globalDir = mkdtempSync(join(tmpdir(), "fusion-phantom-reservation-global-"));
    store = new TaskStore(rootDir, globalDir);
    await store.init();
  });

  afterEach(async () => {
    store.close();
    await rm(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    await rm(globalDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  async function createCommittedReservationPhantom(description = "Phantom committed reservation"): Promise<Task> {
    const task = await store.createTask({ description });
    await rm(join(rootDir, ".fusion", "tasks", task.id), { recursive: true, force: true });
    store.getDatabase().prepare("DELETE FROM tasks WHERE id = ?").run(task.id);
    store.getDatabase().bumpLastModified();
    return task;
  }

  function seedOrphanedChildRows(taskId: string): { preexistingAuditId: string; agentId: string; runId: string } {
    const now = new Date().toISOString();
    const db = store.getDatabase();
    const agentId = `agent-${taskId}`;
    const runId = `run-${taskId}`;
    const preexistingAuditId = `audit-${taskId}`;

    db.prepare(
      `INSERT INTO activityLog (id, timestamp, type, taskId, taskTitle, details, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(`activity-${taskId}`, now, "task:created", taskId, "Phantom", "orphan activity", "{}");
    db.prepare(
      `INSERT INTO agents (id, name, role, state, taskId, createdAt, updatedAt, metadata, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(agentId, `Agent ${taskId}`, "executor", "idle", taskId, now, now, "{}", "{}");
    db.prepare(
      `INSERT INTO agentRuns (id, agentId, data, startedAt, endedAt, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(runId, agentId, "{}", now, null, "running");
    db.prepare(
      `INSERT INTO runAuditEvents (id, timestamp, taskId, agentId, runId, domain, mutationType, target, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(preexistingAuditId, now, taskId, "forensic-agent", `forensic-${taskId}`, "database", "task:forensic-preexisting", taskId, "{}");

    return { preexistingAuditId, agentId, runId };
  }

  function reservationStatus(taskId: string): string | undefined {
    const row = store
      .getDatabase()
      .prepare("SELECT status FROM distributed_task_id_reservations WHERE taskId = ?")
      .get(taskId) as { status?: string } | undefined;
    return row?.status;
  }

  it("archiveTask rejects cleanly when neither DB row nor task.json exists", async () => {
    await expect(store.archiveTask("FN-7999")).rejects.toThrow("Task FN-7999 not found");
    await expect(store.archiveTask("FN-7999")).rejects.not.toThrow(/ENOENT/);
  });

  it("prunes orphaned child rows for a phantom while preserving reservation and runAuditEvents", async () => {
    const phantom = await createCommittedReservationPhantom();
    const live = await store.createTask({ description: "Legitimate committed reservation with task row" });
    const { preexistingAuditId, agentId, runId } = seedOrphanedChildRows(phantom.id);

    const result = await store.reconcilePhantomCommittedReservations();

    expect(result.reconciled).toContain(phantom.id);
    expect(result.reconciled).not.toContain(live.id);
    expect(result.skipped).toEqual(expect.arrayContaining([{ id: live.id, reason: "task-row-present" }]));
    expect(store.getDatabase().prepare("SELECT COUNT(*) AS count FROM activityLog WHERE taskId = ?").get(phantom.id)).toMatchObject({ count: 0 });
    expect(store.getDatabase().prepare("SELECT COUNT(*) AS count FROM agents WHERE taskId = ?").get(phantom.id)).toMatchObject({ count: 0 });
    expect(store.getDatabase().prepare("SELECT COUNT(*) AS count FROM agentRuns WHERE id = ?").get(runId)).toMatchObject({ count: 0 });
    expect(store.getDatabase().prepare("SELECT COUNT(*) AS count FROM runAuditEvents WHERE id = ?").get(preexistingAuditId)).toMatchObject({ count: 1 });
    expect(store.getDatabase().prepare("SELECT COUNT(*) AS count FROM agents WHERE id = ?").get(agentId)).toMatchObject({ count: 0 });
    expect(reservationStatus(phantom.id)).toBe("committed");

    const events = store.getRunAuditEvents({ taskId: phantom.id, mutationType: "task:reconcile-phantom-committed-reservation" });
    expect(events).toHaveLength(1);
    expect(events[0]?.metadata).toMatchObject({
      reservationStatus: "committed",
      prunedAgents: 1,
    });
    expect(Number(events[0]?.metadata?.prunedActivityLog)).toBeGreaterThanOrEqual(1);
  });

  it("reconciles phantoms automatically during disk-backed store open", async () => {
    const phantom = await createCommittedReservationPhantom("Store-open phantom");
    const { preexistingAuditId, runId } = seedOrphanedChildRows(phantom.id);

    store.close();
    store = new TaskStore(rootDir, globalDir);
    await store.init();

    expect(reservationStatus(phantom.id)).toBe("committed");
    expect(store.getDatabase().prepare("SELECT COUNT(*) AS count FROM activityLog WHERE taskId = ?").get(phantom.id)).toMatchObject({ count: 0 });
    expect(store.getDatabase().prepare("SELECT COUNT(*) AS count FROM agentRuns WHERE id = ?").get(runId)).toMatchObject({ count: 0 });
    expect(store.getDatabase().prepare("SELECT COUNT(*) AS count FROM runAuditEvents WHERE id = ?").get(preexistingAuditId)).toMatchObject({ count: 1 });
    expect(store.getRunAuditEvents({ taskId: phantom.id, mutationType: "task:reconcile-phantom-committed-reservation" })).toHaveLength(1);
  });

  it("is a safe no-op for in-memory stores", async () => {
    store.close();
    store = new TaskStore(rootDir, globalDir, { inMemoryDb: true });
    await store.init();
    const phantom = await createCommittedReservationPhantom("In-memory phantom remains untouched");

    const result = await store.reconcilePhantomCommittedReservations();

    expect(result).toEqual({ reconciled: [], skipped: [] });
    expect(reservationStatus(phantom.id)).toBe("committed");
  });

  it("archives a DB-backed task even when its task directory is missing", async () => {
    const task = await store.createTask({ description: "Archive without task dir" });
    await rm(join(rootDir, ".fusion", "tasks", task.id), { recursive: true, force: true });

    const archived = await store.archiveTask(task.id, false);

    expect(archived).toMatchObject({ id: task.id, column: "archived" });
    expect(await store.getTask(task.id)).toMatchObject({ id: task.id, column: "archived" });
  });
});
