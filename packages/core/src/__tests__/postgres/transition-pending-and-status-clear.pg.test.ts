/**
 * FNXC:PostgresCutover 2026-07-10:
 * Regression coverage for the two production-readiness blockers flagged in the
 * PG-mode review:
 *
 * Blocker 1 — `recoverStaleTransitionPendingImpl` previously threw
 * "SQLite Database is not available in backend mode" on every startup and
 * maintenance sweep (unported `store.db.prepare`). These tests pin the ported
 * backend path: a flag-ON move writes the crash-safe marker inside the move
 * transaction and clears it post-commit; a stale marker (crash simulation) is
 * recovered and cleared by the sweep without throwing.
 *
 * Blocker 2 — triage's `status: "planning"` clear reportedly never took effect
 * in PG mode, leaving cards permanently "unplanned" so the scheduler refused
 * to dispatch them. These tests pin the exact store seam triage drives:
 * set-planning → clear(status:null) → moveTask(todo) → a FRESH read shows the
 * status cleared; plus interleaved same-task writers on different fields must
 * both persist (the full-row-upsert lost-update class fixed by the
 * changed-columns port in atomicWriteTaskJson/WithAudit).
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import {
  listTransitionPendingTaskIdsAsync,
  readTransitionPendingAsync,
  writeTransitionPendingAsync,
} from "../../task-store/async/async-transition-pending.js";
import { makeTransitionPending } from "../../transition-types.js";

const pgTest = pgDescribe;

pgTest("transitionPending marker + status-clear durability (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_tp_status",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  it("recoverStaleTransitionPending recovers and clears a stale marker without throwing (Blocker 1)", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "crash-recovery target" });

    // Simulate a crash mid-transition: marker written, post-commit clear never ran.
    await writeTransitionPendingAsync(
      h.layer().db,
      task.id,
      makeTransitionPending("todo", ["default-workflow:postCommit"], Date.now()),
    );
    expect(await listTransitionPendingTaskIdsAsync(h.layer().db)).toContain(task.id);

    const result = await store.recoverStaleTransitionPending();

    expect(result.scanned).toBeGreaterThanOrEqual(1);
    expect(result.recovered).toBeGreaterThanOrEqual(1);
    expect(await readTransitionPendingAsync(h.layer().db, task.id)).toBeNull();
  });

  it("a completed moveTask leaves no pending marker behind (write + post-commit clear round trip)", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "marker round trip" });

    await store.moveTask(task.id, "todo", { moveSource: "user" });

    expect(await readTransitionPendingAsync(h.layer().db, task.id)).toBeNull();
  });

  it("triage status lifecycle: planning → clear → move survives a fresh read (Blocker 2 seam)", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "triage status target" });

    // Exactly what TriageService does around specification:
    await store.updateTask(task.id, { status: "planning" });
    expect((await store.getTask(task.id)).status).toBe("planning");

    await store.updateTask(task.id, { status: null, error: null });
    await store.moveTask(task.id, "todo", { moveSource: "engine" });

    const fresh = await store.getTask(task.id);
    expect(fresh.status).toBeUndefined();
    expect(fresh.column).toBe("todo");

    // And directly at the row level — the scheduler's listTasks sweep must not
    // see a resurrected "planning".
    const listed = (await store.listTasks({ slim: true })).find((t) => t.id === task.id);
    expect(listed?.status).toBeUndefined();
  });

  it("interleaved writers on different fields both persist (lost-update class)", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "interleave target" });
    await store.updateTask(task.id, { status: "planning" });

    // Two logically-concurrent writers touching DIFFERENT fields. Each reads
    // fresh inside its own lock; neither may clobber the other's committed
    // column (the old full-row upsert stamped the whole row from each
    // writer's snapshot).
    await Promise.all([
      store.updateTask(task.id, { status: null }),
      store.updateTask(task.id, { priority: "high" }),
      store.updateTask(task.id, { summary: "interleave summary" }),
    ]);

    const fresh = await store.getTask(task.id);
    expect(fresh.status).toBeUndefined();
    expect(fresh.priority).toBe("high");
    expect(fresh.summary).toBe("interleave summary");
  });

  it("a SECOND store instance's field write does not resurrect a status another instance cleared (cross-instance lost update)", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "cross-instance target" });
    await store.updateTask(task.id, { status: "planning" });

    /*
     * Two TaskStore instances over the same PostgreSQL database — the shape of
     * a dashboard route store + engine store (separate in-memory task locks,
     * so their read-modify-write cycles genuinely interleave). Instance A
     * clears the status (triage); instance B then writes an unrelated field.
     * Under the old full-row upsert, B's write stamped its whole snapshot
     * back — including any stale column — so interleavings could resurrect
     * "planning" and permanently strand the card as "unplanned".
     */
    const { TaskStore } = await import("../../store.js");
    const storeB = new TaskStore(h.rootDir(), undefined, { asyncLayer: h.layer() });
    await store.updateTask(task.id, { status: null });
    await storeB.updateTask(task.id, { summary: "written by instance B" });

    const fresh = await store.getTask(task.id);
    expect(fresh.status).toBeUndefined();
    expect(fresh.summary).toBe("written by instance B");
  });
});
