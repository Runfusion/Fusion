/*
FNXC:TaskLogProjections 2026-10-10-19:13 (RUFU-615):
The equivalence proof this task exists to produce.

`tasks.log` is 31.4 MB of the live board's 73.6 MB of live-row bytes, and it could not simply be
dropped from the list projection because five read-time derivations consume it. This file is the
evidence that dropping it changes NOTHING:

  1. CROSS-IMPLEMENTATION — `project.fusion_task_log_projections()` (the migration's one-time
     backfill) and `deriveTaskLogProjections()` (the steady-state write seam) agree value-for-value
     over crafted logs, including the malformed shapes the live table actually contains.
  2. READ PATH — every observable the five derivations produce (`timedExecutionMs`, `stalledReview`,
     the reason-driven-stall veto, `inReviewStalled`'s last-activity time, the identical-stall run
     count) is DEEP-EQUAL between a row read with `log` and the same row read with
     `excludeLog: true`.
  3. EFFECT — the `log` column is genuinely absent from the rows a log-free read returns, and
     `log_recent` stays TOAST-inline.
  4. PAIRING — no log-writing seam leaves the derived columns behind.
  5. BACKFILL — the SQL backfill reaches the same values the write seam would have written.

A green suite here is not acceptance on its own: the byte-and-wall-time numbers live in the task
document `bench`, and `pg_column_size` is measured below precisely so "we stopped transferring the
column" is a fact rather than an intention.
*/
import { expect, it, beforeAll, afterAll } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import {
  deriveTaskLogProjections,
  LOG_RECENT_INLINE_BYTE_BUDGET,
} from "../../task-store/task-log-projections.js";
import { readLiveTaskRows, TASK_READ_PROJECTION, TASK_SLIM_PROJECTION } from "../../task-store/async/async-persistence.js";
import { countRecentIdenticalStallEntries } from "../../tasks/in-review-stall.js";
import { tasks as tasksTable } from "../../postgres/schema/project.js";
import type { Task, TaskLogEntry } from "../../types.js";

const pgTest = pgDescribe;

/** The shipped migration file, so the backfill test executes the real statement. */
const TASK_LOG_PROJECTIONS_MIGRATION = fileURLToPath(new URL(
  "../../postgres/migrations/0092_rufu_615_task_log_projections.sql", import.meta.url,
));

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOW = Date.now();
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

const STALL_PREFIX = "In-review stall surfaced [merge-blocker]: ";
const REENQUEUE = "Auto-recovered: eligible in-review task re-enqueued for merge";
const INVALID_TRANSITION = "Recovery failed: Invalid transition: 'in-progress' → 'in-review'";
const STALL_SIGNAL = { code: "merge-blocker" as const, reason: "Merge is blocked by a pending gate" };

/** Log fixtures covering every enumerated data state, not only the reported reproduction. */
const FIXTURES: Record<string, TaskLogEntry[]> = {
  "timing inside AND outside the stalled-review window": [
    { timestamp: iso(5 * MINUTE), action: "[timing] step 2 completed in 1500ms", outcome: "" },
    { timestamp: iso(3 * HOUR), action: "[timing] step 3 completed in 2500ms", outcome: "took 2500ms" },
  ],
  "non-monotonic timestamps with the maximum early in the array": [
    { timestamp: iso(MINUTE), action: "newest entry sits first", outcome: "" },
    { timestamp: iso(90 * DAY), action: "an ancient entry sits in the middle", outcome: "" },
    { timestamp: iso(2 * MINUTE), action: "newer than the middle, older than the first", outcome: "" },
  ],
  "trailing identical stall run": [
    { timestamp: iso(6 * HOUR), action: "unrelated work", outcome: "" },
    { timestamp: iso(40 * MINUTE), action: `${STALL_PREFIX}Merge is blocked by a pending gate`, outcome: "" },
    { timestamp: iso(30 * MINUTE), action: `${STALL_PREFIX}Merge is blocked by a pending gate`, outcome: "" },
    { timestamp: iso(20 * MINUTE), action: `${STALL_PREFIX}Merge is blocked by a pending gate`, outcome: "" },
  ],
  "stall run broken by a different reason": [
    { timestamp: iso(40 * MINUTE), action: `${STALL_PREFIX}First blocker`, outcome: "" },
    { timestamp: iso(30 * MINUTE), action: `${STALL_PREFIX}Second blocker`, outcome: "" },
  ],
  "stall run interrupted by a non-stall entry": [
    { timestamp: iso(40 * MINUTE), action: `${STALL_PREFIX}Merge is blocked by a pending gate`, outcome: "" },
    { timestamp: iso(30 * MINUTE), action: "Something else entirely", outcome: "" },
  ],
  "reenqueue churn carried in action": [
    { timestamp: iso(50 * MINUTE), action: REENQUEUE, outcome: "" },
    { timestamp: iso(40 * MINUTE), action: REENQUEUE, outcome: "" },
    { timestamp: iso(30 * MINUTE), action: REENQUEUE, outcome: "" },
  ],
  "invalid transition carried in outcome, not action": [
    { timestamp: iso(50 * MINUTE), action: "Self-healing pass", outcome: INVALID_TRANSITION },
    { timestamp: iso(40 * MINUTE), action: "Self-healing pass", outcome: INVALID_TRANSITION },
  ],
  "reason-driven stall marker older than the live threshold": [
    { timestamp: iso(HOUR), action: "plain work", outcome: "" },
    { timestamp: iso(30 * HOUR), action: `${STALL_PREFIX}Waiting on a dependency`, outcome: "" },
  ],
  "unparseable timestamp alongside a valid one": [
    { timestamp: "2026-10-10 19:13", action: "[timing] legacy clock format in 7ms", outcome: "" },
    { timestamp: iso(10 * MINUTE), action: "modern entry", outcome: "" },
  ],
  "outcome at the 4 000-character retention cap": [
    { timestamp: iso(15 * MINUTE), action: "Self-healing pass", outcome: `${INVALID_TRANSITION} ${"x".repeat(4_000)}` },
  ],
};

/** A worst-case row: the entry-retention cap, each outcome at its cap, both match arrays near their caps. */
function worstCaseLog(): TaskLogEntry[] {
  const entries: TaskLogEntry[] = [];
  for (let i = 0; i < 1_000; i += 1) {
    entries.push({
      timestamp: iso(i * MINUTE),
      action: i % 2 === 0
        ? REENQUEUE
        : `${STALL_PREFIX}A long merge blocker sentence repeated across every entry up to the retention cap`,
      outcome: i % 3 === 0 ? INVALID_TRANSITION : "y".repeat(4_000),
    });
  }
  return entries;
}

/**
 * Send a fixture as JSON TEXT and cast it in SQL. postgres.js binds a JS array as a PostgreSQL ARRAY,
 * so `${sql.json(x)}::jsonb` cannot express the one live row whose `log` is a jsonb-type STRING — the
 * fixture that most needs to exist would have arrived as the shape it is meant to be not.
 */
function jsonParam(value: unknown): string {
  return JSON.stringify(value);
}

/**
 * The five log-derived observables, and nothing else.
 *
 * `observedAt` is stripped: it is the wall clock of whichever read produced the signal, so two
 * `listTasks()` calls taken 20 ms apart legitimately differ in it. Everything that could carry a
 * log-derived value stays in the comparison.
 */
function signalsOf(task: Task) {
  const stripObservedAt = <T extends { observedAt?: string }>(signal: T | undefined) => {
    if (!signal) return signal;
    const { observedAt, ...rest } = signal;
    return rest;
  };
  return {
    timedExecutionMs: task.timedExecutionMs,
    stalledReview: task.stalledReview,
    inReviewStalled: stripObservedAt(task.inReviewStalled),
    inReviewStall: stripObservedAt(task.inReviewStall),
    stallReason: stripObservedAt(task.stallReason),
  };
}

/** Seed through the same three columns the write seam would have written. */
async function seedLogRow(
  h: SharedPgTaskStoreHarness,
  id: string,
  column: string,
  log: unknown,
): Promise<void> {
  const derived = deriveTaskLogProjections(log);
  const sql = h.adminSql();
  await sql`
    INSERT INTO project.tasks (
      id, project_id, title, description, "column", steps, current_step,
      dependencies, log, timing_total_ms, log_recent, created_at, updated_at, workflow_step_results
    ) VALUES (
      ${id}, '', ${"log projection fixture"}, ${"seeded by RUFU-615"}, ${column}, '[]', 0,
      '[]', ${jsonParam(log)}::jsonb, ${derived.timingTotalMs},
      ${jsonParam(derived.logRecent)}::jsonb, now(), now(), '[]'
    )
    ON CONFLICT (project_id, id) DO NOTHING
  `;
}

pgTest("the SQL backfill and the TypeScript write seam derive the same value", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({ prefix: "fusion_log_proj_x" });
  beforeAll(h.beforeAll);
  afterAll(h.afterAll);

  const shapes: Array<[string, unknown]> = [
    ...Object.entries(FIXTURES),
    ["empty log", []],
    ["jsonb string log (the live malformed shape)", '[{"action":"log stored as a string"}]'],
    ["jsonb object log", { notAnArray: true }],
    ["log containing a non-object element", [1, "two", null, { timestamp: iso(MINUTE), action: "real entry" }]],
    ["stall entry with an empty code bracket", [{ timestamp: iso(MINUTE), action: "In-review stall surfaced []: x" }]],
    ["stall entry whose reason is longer than the stored cap", [{ timestamp: iso(MINUTE), action: `${STALL_PREFIX}${"r".repeat(400)}` }]],
    ["match array beyond its retention cap", Array.from({ length: 40 }, (_, i) => ({ timestamp: iso(i * MINUTE + 1), action: REENQUEUE, outcome: "" }))],
    ["trailing run beyond its retention cap", Array.from({ length: 40 }, () => ({ timestamp: iso(MINUTE), action: `${STALL_PREFIX}${STALL_SIGNAL.reason}`, outcome: "" }))],
  ] as Array<[string, unknown]>;

  for (const [name, log] of shapes) {
    it(`derives "${name}" identically in both implementations`, async () => {
      const sql = h.adminSql();
      const rows = (await sql`
        SELECT (project.fusion_task_log_projections(${jsonParam(log)}::jsonb)).*
      `) as unknown as Array<{ timing_total_ms: number; log_recent: unknown }>;
      const derived = deriveTaskLogProjections(log);
      expect(rows).toHaveLength(1);
      expect(Number(rows[0]!.timing_total_ms)).toBe(derived.timingTotalMs);
      expect(rows[0]!.log_recent).toEqual(derived.logRecent);
    });
  }

  it("keeps the envelope TOAST-inline on the 1 000-entry / 4 000-char worst case", async () => {
    const derived = deriveTaskLogProjections(worstCaseLog());
    const sql = h.adminSql();
    const rows = (await sql`
      SELECT pg_column_size(${jsonParam(derived.logRecent)}::jsonb) AS bytes
    `) as unknown as Array<{ bytes: number }>;
    expect(Number(rows[0]!.bytes)).toBeLessThan(LOG_RECENT_INLINE_BYTE_BUDGET);
  });

  it("backfills existing rows to exactly what the write seam would have written", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "backfill target", title: "Backfill target", column: "todo" });
    await store.logEntry(task.id, "[timing] pre-migration entry in 25ms", "body");
    const sql = h.adminSql();
    // Simulate a database that predates the columns: blank them, then run the migration's own backfill.
    await sql`UPDATE project.tasks SET timing_total_ms = NULL, log_recent = NULL WHERE id = ${task.id}`;
    const live = await store.getTask(task.id);
    /*
    FNXC:TaskLogProjections 2026-10-10-19:13 (RUFU-615): the migration's OWN backfill block is executed
    here, extracted from the shipped .sql, so this proves the statement that runs on a real upgrade and
    not a copy that could drift away from it.
    */
    const migrationSql = await readFile(TASK_LOG_PROJECTIONS_MIGRATION, "utf8");
    const backfill = migrationSql.slice(migrationSql.indexOf("DO $fn$"));
    expect(backfill).toContain("fusion_task_log_projections(p.log)");
    await sql.unsafe(backfill);
    const rows = (await sql`
      SELECT timing_total_ms, log_recent FROM project.tasks WHERE id = ${task.id}
    `) as unknown as Array<{ timing_total_ms: number; log_recent: unknown }>;
    const expected = deriveTaskLogProjections(live.log);
    expect(Number(rows[0]!.timing_total_ms)).toBe(expected.timingTotalMs);
    expect(rows[0]!.log_recent).toEqual(expected.logRecent);
  });
});

pgTest("a log-free board read derives the same signals as a read that loaded the log", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({ prefix: "fusion_log_proj_read" });
  beforeAll(h.beforeAll);
  afterAll(h.afterAll);

  it("keeps all five deep-equal across every fixture, in the review lane", async () => {
    const store = h.store();
    const ids: string[] = [];
    let i = 0;
    for (const name of Object.keys(FIXTURES)) {
      const id = `RUFU-PROJ-${i}`;
      await seedLogRow(h, id, "in-review", FIXTURES[name]);
      ids.push(id);
      i += 1;
    }
    const withLog = await store.listTasks({ columns: ["in-review"] as never });
    const withoutLog = await store.listTasks({ columns: ["in-review"] as never, excludeLog: true });
    expect(withoutLog.length).toBe(withLog.length);
    for (const id of ids) {
      const name = Object.keys(FIXTURES)[Number(id.slice(-1))] ?? id;
      const a = withLog.find((t) => t.id === id)!;
      const b = withoutLog.find((t) => t.id === id)!;
      expect(b, `fixture "${name}" disappeared from the log-free read`).toBeTruthy();
      expect(
        signalsOf(b),
        `fixture "${name}" disagrees between a log-loaded and a log-free read`,
      ).toEqual(signalsOf(a));
      expect(b.log).toEqual([]);
    }
    /*
    A comparison that compares two `undefined`s proves nothing, so the fixtures are required to have
    actually lit the signals up: `stalledReview` must be present on the churn/invalid-transition cards.
    */
    const lit = withLog.filter((t) => t.stalledReview !== undefined).map((t) => t.id);
    expect(lit.length, "no fixture produced a stalledReview signal — the fixtures, not the projection, are broken")
      .toBeGreaterThan(0);
    for (const id of lit) {
      const a = withLog.find((t) => t.id === id)!;
      const b = withoutLog.find((t) => t.id === id)!;
      expect(b.stalledReview!.matchCount).toBe(a.stalledReview!.matchCount);
      expect(b.stalledReview!.firstMatchAt).toBe(a.stalledReview!.firstMatchAt);
      expect(b.stalledReview!.lastMatchAt).toBe(a.stalledReview!.lastMatchAt);
      expect(b.stalledReview!.reason).toBe(a.stalledReview!.reason);
    }
  });

  it("keeps slim's timedExecutionMs identical, which is the figure that summed the whole log", async () => {
    const store = h.store();
    const withLog = await store.listTasks({ columns: ["in-review"] as never, slim: true });
    const withoutLog = await store.listTasks({ columns: ["in-review"] as never, slim: true, excludeLog: true });
    for (const a of withLog) {
      const b = withoutLog.find((t) => t.id === a.id)!;
      expect(b.timedExecutionMs).toEqual(a.timedExecutionMs);
    }
  });

  it("answers the trailing identical-stall run from the envelope, not from the log", async () => {
    const log = FIXTURES["trailing identical stall run"];
    const derived = deriveTaskLogProjections(log);
    const fromLog = countRecentIdenticalStallEntries({ log }, STALL_SIGNAL);
    const fromEnvelope = countRecentIdenticalStallEntries(
      { log: [] },
      STALL_SIGNAL,
      undefined,
      { logLoaded: false, projection: derived.logRecent },
    );
    expect(fromLog).toBe(3);
    expect(fromEnvelope).toBe(fromLog);
    // The progress boundary must still cut the run the same way with and without the log.
    const midProgress = Date.parse(log[2]!.timestamp);
    expect(countRecentIdenticalStallEntries({ log }, STALL_SIGNAL, midProgress)).toBe(
      countRecentIdenticalStallEntries({ log: [] }, STALL_SIGNAL, midProgress, { logLoaded: false, projection: derived.logRecent }),
    );
  });

  /*
  FNXC:TaskLogProjections 2026-10-10-20:01 (RUFU-615):
  The other half of the equivalence the task is built on. `slim` already strips `log` from the row it
  RETURNS (it only never stopped READING it in SQL), so the byte saving must not move a single byte of
  the HTTP payload — not a key, not a derived value, not a field order. This compares the serialized
  rows, with only the reads' own wall-clock stamps normalised, because `observedAt` is `Date.now()` of
  whichever call produced the signal and two calls are never the same millisecond.
  */
  it("keeps the serialized board row byte-identical when the log column is dropped", async () => {
    const store = h.store();
    const withLog = await store.listTasks({ slim: true, startupMemo: false });
    const withoutLog = await store.listTasks({ slim: true, excludeLog: true, startupMemo: false });
    expect(withoutLog.length).toBe(withLog.length);
    const normalize = (rows: Task[]) => JSON.stringify(rows.map((row) => {
      const clone = { ...(row as unknown as Record<string, unknown>) };
      /*
      `lineageId` is synthesised per row-per-read when the row carries no lineage, so two reads of the
      SAME row never agree on it and it has nothing to do with the log. Everything else stays in the
      compared bytes, including key order, which is what makes this a payload test rather than a
      field-equality test.
      */
      if ("lineageId" in clone) clone.lineageId = "<per-read>";
      for (const key of ["inReviewStalled", "inReviewStall", "stallReason"]) {
        const signal = clone[key] as { observedAt?: string } | undefined;
        if (signal && typeof signal === "object" && "observedAt" in signal) {
          clone[key] = { ...signal, observedAt: "<read-clock>" };
        }
      }
      return clone;
    }));
    expect(normalize(withoutLog)).toBe(normalize(withLog));
  });

  /*
  FNXC:TaskLogProjections 2026-10-10-20:15 (RUFU-615): the mirror half of the wire/mirror stability
  requirement. `timingTotalMs`/`logRecent` are row-and-database-only on purpose: the per-task
  `.fusion/tasks/<ID>/task.json` mirror is written from a `Task`, and an operator-visible mirror that
  grows two new keys on every upgrade is a migration of its own. A future author who adds either field
  to the `Task` type will make this fail with a diff that explains the consequence.
  */
  it("keeps the two derived columns out of the task.json mirror", async () => {
    const store = h.store();
    const task = await store.getTask("RUFU-PROJ-0");
    expect(task).toBeTruthy();
    const dir = store.taskDir("RUFU-PROJ-0");
    await store.writeTaskJsonFile(dir, task!);
    const mirror = JSON.parse(await readFile(join(dir, "task.json"), "utf8")) as Record<string, unknown>;
    expect(Object.keys(mirror)).not.toContain("timingTotalMs");
    expect(Object.keys(mirror)).not.toContain("logRecent");
    // The log itself still mirrors: a single-task read loads it, and the mirror is that read's record.
    expect(Array.isArray(mirror.log)).toBe(true);
    expect((mirror.log as unknown[]).length).toBe(task!.log.length);
  });

  it("omits the log column from the executed read while keeping both derived columns", async () => {
    const layer = h.layer();
    const full = await readLiveTaskRows(layer, {});
    const pruned = await readLiveTaskRows(layer, { excludeLog: true });
    expect(full.length).toBeGreaterThan(0);
    expect(Object.keys(full[0]!)).toContain("log");
    expect(Object.keys(pruned[0]!)).not.toContain("log");
    expect(pruned[0]).toHaveProperty("logRecent");
    expect(pruned[0]).toHaveProperty("timingTotalMs");
  });

  /*
  FNXC:TaskLogProjections 2026-10-10-21:28 (RUFU-615):
  The shape above proves what came BACK; this proves what was SENT, which is the acceptance wording
  ("the executed SELECT for that shape does not reference the `log` column"). The row-key assertion alone
  would still pass if the reader selected the column and discarded it client-side — which is precisely
  the cost the task exists to remove, since the transfer is the bill. So the projection objects the
  reader itself uses are rendered to SQL text and inspected.
  */
  it("sends SQL that stops naming the log column once the caller opts out", () => {
    const layer = h.layer();
    const fullSql = layer.db.select(TASK_READ_PROJECTION).from(tasksTable).toSQL().sql;
    const prunedSql = layer.db.select(TASK_SLIM_PROJECTION).from(tasksTable).toSQL().sql;

    // Drizzle quotes every identifier, so `"log"` cannot be matched by `"log_recent"` — the quoted form
    // is what makes this a column-level claim rather than a substring accident.
    expect(fullSql).toContain('"log"');
    expect(prunedSql).not.toContain('"log"');
    expect(prunedSql).toContain('"log_recent"');
    expect(prunedSql).toContain('"timing_total_ms"');

    // And the two shapes differ by exactly that one column: the log-free read is not silently losing a
    // second figure on the way, which is how a bandwidth flag turns into a blanked badge.
    const fullKeys = Object.keys(TASK_READ_PROJECTION).sort();
    const prunedKeys = Object.keys(TASK_SLIM_PROJECTION).sort();
    expect(fullKeys.filter((key) => !prunedKeys.includes(key))).toEqual(["log"]);
    expect(prunedKeys.filter((key) => !fullKeys.includes(key))).toEqual([]);
  });

  it("transfers a fraction of the bytes on the row that motivated the task", async () => {
    await seedLogRow(h, "RUFU-PROJ-WORST", "todo", worstCaseLog());
    const sql = h.adminSql();
    const rows = (await sql`
      SELECT pg_column_size(log) AS log_bytes, pg_column_size(log_recent) AS recent_bytes
        FROM project.tasks WHERE id = 'RUFU-PROJ-WORST'
    `) as unknown as Array<{ log_bytes: number; recent_bytes: number }>;
    const logBytes = Number(rows[0]!.log_bytes);
    const recentBytes = Number(rows[0]!.recent_bytes);
    // The claim in numbers: the history is megabytes, the envelope that answers for it is one inline
    // value, so a board that reads only the envelope stops transferring the difference per refresh.
    // The history is compared AFTER TOAST compression, which is exactly what a read would have paid
    // for, so the ratio below understates rather than overstates the saving.
    expect(logBytes).toBeGreaterThan(20_000);
    expect(recentBytes).toBeLessThan(LOG_RECENT_INLINE_BYTE_BUDGET);
    expect(recentBytes * 50).toBeLessThan(logBytes);
  });
});

pgTest("every log-writing seam writes the log together with its projections", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({ prefix: "fusion_log_proj_pair" });
  beforeAll(h.beforeAll);
  afterAll(h.afterAll);

  const readColumns = async (id: string) => {
    const sql = h.adminSql();
    const rows = (await sql`
      SELECT timing_total_ms, log_recent FROM project.tasks WHERE id = ${id}
    `) as unknown as Array<{ timing_total_ms: number | null; log_recent: unknown }>;
    return rows[0]!;
  };

  it("stays paired through the targeted-UPDATE append seam", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "log append pairing", title: "Log append pairing", column: "todo" });
    await store.logEntry(task.id, "[timing] appended step in 12ms", "outcome body");
    const live = await store.getTask(task.id);
    const row = await readColumns(task.id);
    const expected = deriveTaskLogProjections(live.log);
    expect(Number(row.timing_total_ms)).toBe(expected.timingTotalMs);
    expect(row.log_recent).toEqual(expected.logRecent);
  });

  it("stays paired through a wholesale `task.log = []` rewrite", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "log clear pairing", title: "Log clear pairing", column: "todo" });
    await store.logEntry(task.id, "something happened", "with an outcome");
    await store.updateTask(task.id, { log: [] });
    const live = await store.getTask(task.id);
    const row = await readColumns(task.id);
    expect(live.log).toEqual([]);
    expect(Number(row.timing_total_ms)).toBe(0);
    expect(row.log_recent).toEqual(deriveTaskLogProjections([]).logRecent);
  });

  it("refuses both derived columns for a row whose log writes are read-only", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "read-only log", title: "Read-only log", column: "todo" });
    await store.logEntry(task.id, "an entry", "body");
    const before = await readColumns(task.id);
    const sql = h.adminSql();
    // A soft-deleted row refuses log writes; the derived columns must not be authored for it either.
    await sql`UPDATE project.tasks SET deleted_at = now() WHERE id = ${task.id}`;
    await expect(store.logEntry(task.id, "refused entry", "body")).rejects.toThrow(/read-only|not found/);
    const after = await readColumns(task.id);
    expect(after.log_recent).toEqual(before.log_recent);
    expect(Number(after.timing_total_ms)).toBe(Number(before.timing_total_ms));
  });
});
