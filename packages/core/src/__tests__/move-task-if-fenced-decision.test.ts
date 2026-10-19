/**
 * GhostBug core-seam regression: a FENCED MOVE DECISION is transaction data, never a side effect.
 *
 * FNXC:TaskStoreMove 2026-10-11-14:15 (GhostBug):
 * The shape these cases forbid is the one the ghost-bug archive used to want: append a decision entry
 * with one write, then move with a second. Those are TWO commits, and the move upserts the row it
 * captured earlier — so a concurrent writer landing between them either loses the explanation or the
 * move lands on a row the caller never proved. `moveTaskIf`'s fenced decision closes that window: the
 * entry is appended to the FRESH in-transaction row and committed with the column transition and the
 * move's own `task:move` audit row, or nothing commits at all.
 *
 * The load-bearing assertions are therefore not "a log entry exists" but:
 *  - PRIOR HISTORY SURVIVES (the clobber this design prevents is a stripped-read overwrite), and
 *  - a MISMATCHED expected record lands NEITHER the decision NOR the move.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { pgDescribe, createSharedPgTaskStoreTestHarness } from "../__test-utils__/pg-test-harness.js";
import { __setTaskActivityLogLimitsForTesting } from "../task-store/comments.js";

pgDescribe("moveTaskIf fenced decision — atomic decision + transition", () => {
  const harness = createSharedPgTaskStoreTestHarness({ prefix: "fusion_fenced_move" });
  beforeAll(harness.beforeAll);
  beforeEach(harness.beforeEach);
  afterEach(harness.afterEach);
  afterAll(harness.afterAll);

  /** Read the durable row the way a move caller must: the full conversion, log included. */
  const readRow = async (store: ReturnType<typeof harness.store>, taskId: string) => {
    const row = await store.readTaskForMove(taskId);
    if (!row) throw new Error(`fixture row ${taskId} disappeared`);
    return row;
  };

  it("APPLIES the decision entry to the fresh in-transaction row and commits it WITH the transition", async () => {
    const store = harness.store();
    const task = await store.createTask({ description: "fenced decision applies" });
    const before = await readRow(store, task.id);
    const priorLog = before.log ?? [];
    expect(priorLog.length).toBeGreaterThan(0);

    const result = await store.moveTaskIf(
      task.id,
      "in-progress",
      (live) => live.column === "todo",
      { moveSource: "engine" },
      {
        entry: { action: "Ghost-bug preflight accepted archive decision — verified absence.", outcome: "{\"reasonCode\":\"accepted\"}" },
        expected: {
          expectedColumn: before.column,
          expectedUpdatedAt: before.updatedAt,
          identity: { status: before.status },
        },
      },
    );

    expect(result.moved).toBe(true);
    const after = await readRow(store, task.id);
    expect(after.column).toBe("in-progress");

    // PRIOR HISTORY SURVIVES and the decision rode the SAME commit — one row, one write, both facts.
    expect(after.log!.length).toBe(priorLog.length + 1);
    expect(after.log!.slice(0, priorLog.length)).toEqual(priorLog);
    expect(after.log![after.log!.length - 1].action).toContain("Ghost-bug preflight accepted archive decision");
  });

  it("LANDS NEITHER the decision nor the move when the expected row record no longer matches", async () => {
    const store = harness.store();
    const task = await store.createTask({ description: "fenced decision refuses" });
    const stale = await readRow(store, task.id);

    // A newer writer advances the durable revision AFTER the caller proved the row.
    await store.updateTask(task.id, { status: "needs-replan" });

    const result = await store.moveTaskIf(
      task.id,
      "archived",
      () => true,
      { moveSource: "engine" },
      {
        entry: { action: "Ghost-bug preflight accepted archive decision — must not land." },
        expected: {
          expectedColumn: stale.column,
          expectedUpdatedAt: stale.updatedAt,
          identity: { status: stale.status },
        },
      },
    );

    expect(result.moved).toBe(false);
    const after = await readRow(store, task.id);
    // NEITHER half landed: no transition, and no decision entry on a row this episode may not touch.
    expect(after.column).toBe("todo");
    expect(after.log).toEqual(stale.log);
    // The newer committed row survives untouched — the refusal must not roll back anything.
    expect(after.status).toBe("needs-replan");
  });

  it("REFUSES when a CROSS-CONNECTION writer commits a newer row inside the predicate→transaction window", async () => {
    /*
    FNXC:GhostBugPreflight 2026-10-11-15:19 (GhostBug):
    review validation-mandated race-shape evidence. A SEPARATE PostgreSQL connection (not a same-store
    pre-move write) commits a newer relevant row after `moveTaskIf`'s outer predicate has observed
    the initial row but before the transaction's fresh-row validation admits the move. The bounded
    barrier is the predicate itself: the cross-connection UPDATE is awaited to completion INSIDE
    the predicate before it returns true, so the commit is guaranteed to precede the in-transaction
    fresh-row re-read. The fence must refuse: neither decision nor transition persists, and the
    newer committed row (its revision AND its appended history) survives untouched.
    */
    const store = harness.store();
    const task = await store.createTask({ description: "cross-connection mid-window writer" });
    const before = await readRow(store, task.id);
    const admin = harness.adminSql();
    let barrierApplied = false;

    const result = await store.moveTaskIf(
      task.id,
      "in-progress",
      async (live) => {
        if (barrierApplied) return false; // predicate must run exactly once for this shape
        barrierApplied = true;
        // The outer predicate saw the initial row — now a foreign process's connection commits
        // a newer version of it (revision bump + its own history entry) BEFORE we let the move
        // proceed to the transaction.
        const taskId = live.id;
        const affected = await admin.unsafe(
          `UPDATE project.tasks SET updated_at = '2027-01-01T00:00:00.000Z', log = COALESCE(log, '[]'::jsonb) || `
          + `'[{"timestamp":"2027-01-01T00:00:00.000Z","action":"cross-connection newer writer"}]'::jsonb `
          + `WHERE id = '${taskId.replace(/'/g, "''")}' RETURNING id`,
        );
        expect(affected.count).toBe(1);
        return true;
      },
      { moveSource: "engine" },
      {
        entry: { action: "must not land — a newer cross-connection row exists" },
        expected: {
          expectedColumn: before.column,
          expectedUpdatedAt: before.updatedAt,
          identity: { status: before.status },
        },
      },
    );

    expect(barrierApplied).toBe(true);
    expect(result.moved).toBe(false);
    const after = await readRow(store, task.id);
    // NEITHER half of the fenced write persisted...
    expect(after.column).toBe("todo");
    // ...and the NEWER committed row — revision and history — survived untouched.
    expect(after.updatedAt).toBe("2027-01-01T00:00:00.000Z");
    expect(after.log!.some((entry) => entry.action === "cross-connection newer writer")).toBe(true);
    expect(after.log!.some((entry) => entry.action.includes("must not land"))).toBe(false);
  });

  it("KEEPS the archived read-only contract intact: a post-archive logEntry is still refused by production", async () => {
    /*
    FNXC:GhostBugPreflight 2026-10-11-15:19 (GhostBug):
    This is the fidelity assertion for the GhostBug archive design: the decision lands IN the move
    transaction precisely BECAUSE `logEntry` rejects an archived row — the guard stays exactly as
    it is, asserted unchanged against the real store here (not a double).
    */
    const store = harness.store();
    const task = await store.createTask({ description: "archived read-only fidelity" });
    const before = await readRow(store, task.id);
    const result = await store.moveTaskIf(task.id, "archived", () => true, { moveSource: "engine", recoveryRehome: true }, {
      entry: { action: "Ghost-bug preflight accepted archive decision — fidelity probe." },
      expected: {
        expectedColumn: before.column,
        expectedUpdatedAt: before.updatedAt,
        identity: { status: before.status },
      },
    });
    expect(result.moved).toBe(true);
    await expect(store.logEntry(task.id, "post-archive write")).rejects.toThrow(/read-only|archived/i);
    // Still exactly the in-transaction decision entry — the refused write appended nothing.
    const after = await readRow(store, task.id);
    expect(after.log![after.log!.length - 1].action).toContain("fidelity probe");
  });

  it("REFUSES on a mismatched identity field even when the revision token still lines up", async () => {
    const store = harness.store();
    const task = await store.createTask({ description: "fenced identity mismatch" });
    const before = await readRow(store, task.id);

    // A same-length in-transaction patch refreshes `updatedAt`, so a bare revision compare is not
    // enough — the identity fields are what carry the "same episode" claim.
    // (branchWriteOrigin is the production write-provenance guard `updateTask` requires for any
    // `branch` patch — task-update.ts:160; the fixture must satisfy it, not dodge it.)
    const advanced = await store.updateTask(task.id, { branch: "fusion/OTHER-9001", branchWriteOrigin: "engine" });
    const fresh = await readRow(store, task.id);
    expect(advanced?.id).toBe(task.id);

    const result = await store.moveTaskIf(
      task.id,
      "archived",
      () => true,
      { moveSource: "engine" },
      {
        entry: { action: "must not land on a re-branded row" },
        expected: {
          expectedColumn: fresh.column,
          expectedUpdatedAt: fresh.updatedAt,
          identity: { status: fresh.status, branch: before.branch },
        },
      },
    );

    expect(result.moved).toBe(false);
    const after = await readRow(store, task.id);
    expect(after.column).toBe("todo");
    expect(after.log).toEqual(before.log);
  });

  it("PRESERVES the absent-decision path exactly: a plain conditional move writes no task-log entry", async () => {
    const store = harness.store();
    const task = await store.createTask({ description: "plain conditional move unchanged" });
    const before = await readRow(store, task.id);

    const moved = await store.moveTaskIf(task.id, "in-progress", (live) => live.column === "todo");
    expect(moved.moved).toBe(true);

    const after = await readRow(store, task.id);
    expect(after.column).toBe("in-progress");
    // Byte-for-byte the same history the fenced path would never have written.
    expect(after.log).toEqual(before.log);
  });

  /**
   * review validation evidence rule: a thrown error only proves the INJECTED failure when its actual cause
   * chain carries the injected sentinel and the PostgreSQL RAISE code — a looser matcher would
   * accept an unrelated store/audit defect that also happens to leave the row unchanged.
   */
  const causeChain = (error: unknown): Array<{ message: string; code?: string }> => {
    const chain: Array<{ message: string; code?: string }> = [];
    for (let cursor = error as Error | undefined; cursor instanceof Error; cursor = (cursor as Error & { cause?: Error }).cause) {
      chain.push({ message: cursor.message, code: (cursor as Error & { code?: string }).code });
    }
    return chain;
  };

  it("ROLLS BACK both the decision and the transition when a genuine in-transaction failure lands after the append", async () => {
    /*
    FNXC:GhostBugPreflight 2026-10-11-15:19 (GhostBug):
    Operator-mandated atomicity evidence. The failure is not mocked: a real PL/pgSQL trigger aborts
    THIS task's `task:move` run-audit insert, which runs AFTER the decision-carrying row upsert has
    already succeeded inside the transaction. PostgreSQL then aborts the whole transaction — so if
    the decision had been a separate commit (the rejected two-commit shape) its entry would survive.
    The assertion that matters is exactly that: after the injected failure, NEITHER the appended
    decision NOR the transition is readable on the row, and the error is the injected one.
    */
    const store = harness.store();
    const task = await store.createTask({ description: "injected post-append transaction failure" });
    const before = await readRow(store, task.id);

    // DDL WHEN expressions take no bind parameters (PG rejects `$n` there), so the fixture-owned id
    // is embedded as a quote-escaped literal — a trivially safe task-id shaped value. postgres.js
    // tagged templates are the executed form here (the untagged call form no-ops silently).
    const admin = harness.adminSql();
    const taskIdLiteral = `'${task.id.replace(/'/g, "''")}'`;
    await admin`CREATE FUNCTION zp002_inject_move_audit_fail() RETURNS trigger LANGUAGE plpgsql AS $zp002$
      BEGIN RAISE EXCEPTION 'ZP002 injected post-append failure on task:move audit'; RETURN NEW;
      END$zp002$`;
    await admin.unsafe(`CREATE TRIGGER zp002_inject_move_audit_fail BEFORE INSERT ON project.run_audit_events
      FOR EACH ROW WHEN (NEW.mutation_type = 'task:move' AND NEW.task_id = '${task.id.replace(/'/g, "''")}')
      EXECUTE FUNCTION zp002_inject_move_audit_fail()`);
    try {
      let captured: unknown = null;
      try {
        await store.moveTaskIf(task.id, "in-progress", () => true, { moveSource: "engine" }, {
          entry: { action: "Ghost-bug preflight accepted archive decision — must roll back." },
          expected: {
            expectedColumn: before.column,
            expectedUpdatedAt: before.updatedAt,
            identity: { status: before.status },
          },
        });
      } catch (error) {
        captured = error;
      }
      expect(captured).toBeInstanceOf(Error);

      // review validation: the cause chain must carry the EXACT injected sentinel and, wherever available,
      // the PostgreSQL RAISE code (`P0001` raise_exception) — proving the AFTER-append trigger
      // fired, not an unrelated audit/store defect that also happens to leave the row unchanged.
      const chain = causeChain(captured);
      expect(chain.some((entry) => entry.message.includes("ZP002 injected post-append failure on task:move audit"))).toBe(true);
      expect(chain.some((entry) => entry.code === "P0001")).toBe(true);

      // The append rode the transaction — so the abort erased it along with the transition.
      const after = await readRow(store, task.id);
      expect(after.column).toBe("todo");
      expect(after.log).toEqual(before.log);
    } finally {
      await admin`DROP TRIGGER IF EXISTS zp002_inject_move_audit_fail ON project.run_audit_events`;
      await admin`DROP FUNCTION IF EXISTS zp002_inject_move_audit_fail()`;
    }
  });

  it("CAPS the composed log and truncates the decision outcome at the project's own limits", async () => {
    /*
    FNXC:GhostBugPreflight 2026-10-11-15:19 (GhostBug):
    The in-transaction append reproduces `comments.ts` discipline, so a fenced decision against a
    near-full history must keep the cap (oldest entry trimmed) and the outcome truncation — the same
    test-only override seam the project's own suites use, restored in `finally`.
    */
    const store = harness.store();
    const task = await store.createTask({ description: "fenced log cap and truncation" });
    __setTaskActivityLogLimitsForTesting({ entryLimit: 2, outcomeLimit: 24 });
    try {
      const seeded = await store.updateTask(task.id, {
        log: [
          { timestamp: new Date(Date.parse("2026-01-01T00:00:00.000Z")).toISOString(), action: "oldest entry trims out" },
          { timestamp: new Date(Date.parse("2026-01-02T00:00:00.000Z")).toISOString(), action: "second entry survives" },
        ],
      });
      expect(seeded?.log?.map((entry) => entry.action)).toEqual(["oldest entry trims out", "second entry survives"]);
      const before = await readRow(store, task.id);

      const result = await store.moveTaskIf(task.id, "in-progress", () => true, { moveSource: "engine" }, {
        entry: { action: "fenced decision lands", outcome: "x".repeat(200) },
        expected: {
          expectedColumn: before.column,
          expectedUpdatedAt: before.updatedAt,
          identity: { status: before.status },
        },
      });
      expect(result.moved).toBe(true);

      const after = await readRow(store, task.id);
      // Cap of 2 keeps the NEWEST pair: the survivor of the seeded history plus the decision.
      expect(after.log?.length).toBe(2);
      expect(after.log?.[0].action).toBe("second entry survives");
      expect(after.log?.[1].action).toBe("fenced decision lands");
      expect(after.log![1].outcome).toContain("... outcome truncated to 24 characters ...");
    } finally {
      __setTaskActivityLogLimitsForTesting(null);
    }
  });
});
