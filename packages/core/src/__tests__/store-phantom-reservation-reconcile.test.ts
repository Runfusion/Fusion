import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, afterAll, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { TaskStore } from "../store.js";

pgTest("TaskStore phantom committed-reservation reconciliation", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_phantom_res",
  });

  beforeAll(h.beforeAll);
  afterAll(h.afterAll);
  beforeEach(async () => {
    await h.beforeEach();
  });
  afterEach(async () => {
    await h.afterEach();
  });

  it("archiveTask rejects cleanly when neither DB row nor task.json exists", async () => {
    const store = h.store();
    await expect(store.archiveTask("FN-7999")).rejects.toThrow("Task FN-7999 not found");
    await expect(store.archiveTask("FN-7999")).rejects.not.toThrow(/ENOENT/);
  });

  it("prunes orphaned child rows for a phantom while preserving reservation and runAuditEvents", async () => {
    const store = h.store();
    // Create a phantom: task row exists then is deleted, leaving a committed reservation orphan.
    const phantom = await store.createTask({ description: "Phantom committed reservation" });
    await rm(join(h.rootDir(), ".fusion", "tasks", phantom.id), { recursive: true, force: true });
    await h.adminDb().execute(sql`DELETE FROM project.tasks WHERE id = ${phantom.id}`);

    const live = await store.createTask({ description: "Legitimate committed reservation with task row" });
    const now = new Date().toISOString();
    const agentId = `agent-${phantom.id}`;
    const runId = `run-${phantom.id}`;
    const preexistingAuditId = `audit-${phantom.id}`;
    const adminDb = h.adminDb();

    await adminDb.execute(sql`
      INSERT INTO project.activity_log (id, timestamp, type, task_id, task_title, details, metadata)
      VALUES (${"activity-" + phantom.id}, ${now}, ${"task:created"}, ${phantom.id}, ${"Phantom"}, ${"orphan activity"}, ${"{}"}::jsonb)
    `);
    await adminDb.execute(sql`
      INSERT INTO project.agents (id, name, role, state, task_id, created_at, updated_at, metadata, data)
      VALUES (${agentId}, ${"Agent " + phantom.id}, ${"executor"}, ${"idle"}, ${phantom.id}, ${now}, ${now}, ${"{}"}::jsonb, ${"{}"}::jsonb)
    `);
    await adminDb.execute(sql`
      INSERT INTO project.agent_runs (id, agent_id, data, started_at, status)
      VALUES (${runId}, ${agentId}, ${"{}"}::jsonb, ${now}, ${"running"})
    `);
    await adminDb.execute(sql`
      INSERT INTO project.run_audit_events (id, timestamp, task_id, agent_id, run_id, domain, mutation_type, target, metadata)
      VALUES (${preexistingAuditId}, ${now}, ${phantom.id}, ${"forensic-agent"}, ${"forensic-" + phantom.id}, ${"database"}, ${"task:forensic-preexisting"}, ${phantom.id}, ${"{}"}::jsonb)
    `);

    const result = await store.reconcilePhantomCommittedReservations();

    expect(result.reconciled).toContain(phantom.id);
    expect(result.reconciled).not.toContain(live.id);
    expect(result.skipped).toEqual(expect.arrayContaining([{ id: live.id, reason: "task-row-present" }]));
    expect(await countByTaskId(adminDb, "activity_log", phantom.id)).toBe(0);
    expect(await countByTaskId(adminDb, "agents", phantom.id)).toBe(0);
    expect(await countById(adminDb, "agent_runs", runId)).toBe(0);
    expect(await countById(adminDb, "run_audit_events", preexistingAuditId)).toBe(1);
    expect(await countById(adminDb, "agents", agentId)).toBe(0);

    const resRows = await adminDb.execute(
      sql`SELECT status FROM project.distributed_task_id_reservations WHERE task_id = ${phantom.id}`,
    ) as unknown as Array<{ status: string }>;
    expect(resRows[0]?.status).toBe("committed");

    const events = store.getRunAuditEvents({ taskId: phantom.id, mutationType: "task:reconcile-phantom-committed-reservation" });
    expect(events).toHaveLength(1);
    expect(events[0]?.metadata).toMatchObject({
      reservationStatus: "committed",
      prunedAgents: 1,
    });
    expect(Number(events[0]?.metadata?.prunedActivityLog)).toBeGreaterThanOrEqual(1);
  });

  it("does not re-emit the reconcile audit row on a second tick once orphaned rows are pruned (idempotency)", async () => {
    const store = h.store();
    const phantom = await store.createTask({ description: "Phantom committed reservation (idempotency)" });
    await rm(join(h.rootDir(), ".fusion", "tasks", phantom.id), { recursive: true, force: true });
    await h.adminDb().execute(sql`DELETE FROM project.tasks WHERE id = ${phantom.id}`);

    const first = await store.reconcilePhantomCommittedReservations();
    expect(first.reconciled).toContain(phantom.id);

    const second = await store.reconcilePhantomCommittedReservations();
    expect(second.reconciled).toContain(phantom.id);

    expect(store.getRunAuditEvents({ taskId: phantom.id, mutationType: "task:reconcile-phantom-committed-reservation" })).toHaveLength(1);

    const resRows = await h.adminDb().execute(
      sql`SELECT status FROM project.distributed_task_id_reservations WHERE task_id = ${phantom.id}`,
    ) as unknown as Array<{ status: string }>;
    expect(resRows[0]?.status).toBe("committed");
  });

  it("archives a DB-backed task even when its task directory is missing", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "Archive without task dir" });
    await rm(join(h.rootDir(), ".fusion", "tasks", task.id), { recursive: true, force: true });

    const archived = await store.archiveTask(task.id, false);
    expect(archived).toMatchObject({ id: task.id, column: "archived" });
  });
});

/*
 * Separate describe for the store-reopen test since it needs an isolated PG database
 * (createTaskStoreForTest) to verify init() runs the reconcile automatically.
 */
pgTest("TaskStore phantom reconciliation during store open", () => {
  it("reconciles phantoms automatically during store open", async () => {
    const harness = await createTaskStoreForTest({ prefix: "fusion_phantom_open" });
    try {
      const phantom = await harness.store.createTask({ description: "Store-open phantom" });
      await rm(join(harness.rootDir, ".fusion", "tasks", phantom.id), { recursive: true, force: true });
      await harness.adminDb.execute(sql`DELETE FROM project.tasks WHERE id = ${phantom.id}`);

      // Reopen a second store against the same layer — init() runs the reconcile.
      const second = new TaskStore(harness.rootDir, undefined, { asyncLayer: harness.layer });
      await second.init();

      const resRows = await harness.adminDb.execute(
        sql`SELECT status FROM project.distributed_task_id_reservations WHERE task_id = ${phantom.id}`,
      ) as unknown as Array<{ status: string }>;
      expect(resRows[0]?.status).toBe("committed");

      expect(await countByTaskId(harness.adminDb, "activity_log", phantom.id)).toBe(0);
      expect(second.getRunAuditEvents({ taskId: phantom.id, mutationType: "task:reconcile-phantom-committed-reservation" })).toHaveLength(1);
    } finally {
      await harness.teardown();
    }
  });
});
