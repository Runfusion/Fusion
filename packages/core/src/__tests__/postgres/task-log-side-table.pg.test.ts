/**
 * FNXC:TaskLogSideTable 2026-11-01-18:40 (RUFU-312):
 * Symptom-verification suite for the task-log side table.
 *
 * Original symptom (measured on the operator's live DB, 2026-11-01, project `9e457a0b`, 835 cards):
 * `tasks.log` held 25 MB of the 55 MB live-row bytes; the `tasks` heap was 4 609 MB for 814 live rows
 * (fillfactor 70 + continuous UPDATE pressure, 17.6 MB dead tuples in one scan); one card's mirror was
 * 3.99 MB of History; and 39 520 of 47 334 audit mutation rows were `task:updated` — because every
 * diagnostic line rewrote the card's own row. A board refresh cost 10.4 s and a card click 6.2 s.
 *
 * The invariant this file pins is the one the whole task turns on: **a pure log append must not write the
 * `tasks` row at all.** The probe is `xmin` — a new row version is created by a new transaction id, so an
 * unchanged `xmin` proves no UPDATE touched the row, which is a stronger claim than `xmax = 0` (the live
 * version always has that) or an unchanged `updated_at` (a column a writer can leave alone while still
 * rewriting the row). Before the fix every case below that asserts "row untouched" failed: `logEntry`
 * wrote `{log, updated_at}` and `logEntryOnce` wrote `{log, updated_at}` through a full-row read.
 *
 * The other half of the contract is that nothing a reader could observe got poorer: the merged `log` still
 * carries the entry in the same order with the same retention cap, the `task.json` mirror still carries it,
 * `task:updated` is still emitted, the dedupe window still suppresses a repeat, and the derived stall/
 * timing envelope is still authored — by `task_log_rollup`, because the row it used to ride on is gone.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Task } from "../../types.js";
import * as schema from "../../postgres/schema/index.js";
import { eq, sql as drizzleSql } from "drizzle-orm";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import {
  appendTaskLogEntries,
  catchUpLegacyTaskLogEntries,
  hasTaskLogEntryWithinWindow,
  pickTaskLogEnvelope,
  readTaskLogEntries,
  readTaskLogRollups,
  taskLogProjectId,
} from "../../task-store/task-log-entries.js";
import { truncateTaskLogOutcome } from "../../task-store/comments.js";
import { deriveTaskLogProjections } from "../../task-store/task-log-projections.js";

/** Row-version probe: `xmin` is the creating transaction, so a new version means a new id. */
async function probeRowVersion(h: SharedPgTaskStoreHarness, taskId: string) {
  const rows = await h.layer().db.execute(drizzleSql`
    SELECT xmin::text AS version, ctid::text AS location, updated_at,
           coalesce(jsonb_array_length(log), 0) AS log_entries,
           log_recent AS "logRecent", timing_total_ms AS "timingTotalMs",
           log_projection_at AS "logProjectionAt"
      FROM project.tasks WHERE id = ${taskId}`);
  return (rows as unknown as Record<string, unknown>[])[0]!;
}

async function sideEntryRows(h: SharedPgTaskStoreHarness, taskId: string) {
  return h.layer().db
    .select()
    .from(schema.project.taskLogEntries)
    .where(eq(schema.project.taskLogEntries.taskId, taskId))
    .orderBy(schema.project.taskLogEntries.seq);
}

pgDescribe("task log side table (RUFU-312)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({ prefix: "rufu312_log_entries" });
  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterAll(h.afterAll);

  it("appends through logEntry without writing the task row at all", async () => {
    const task = await h.createTestTask();
    const store = h.store();
    const before = await probeRowVersion(h, task.id);

    const returned = await store.logEntry(task.id, "Preflight: verified the branch", "clean");

    const after = await probeRowVersion(h, task.id);
    // The invariant: same row version, same physical location, same updated_at, same log array.
    expect(after.version).toBe(before.version);
    expect(after.location).toBe(before.location);
    expect(after.updated_at).toBe(before.updated_at);
    expect(after.log_entries).toBe(before.log_entries);

    const entries = await sideEntryRows(h, task.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.action).toBe("Preflight: verified the branch");
    expect(entries[0]!.outcome).toBe("clean");
    // The returned card still carries the entry — a caller that reads what it just wrote sees it.
    expect(returned.log?.at(-1)?.action).toBe("Preflight: verified the branch");
  });

  it("keeps History, the task.json mirror and the task:updated emission observably intact", async () => {
    const task = await h.createTestTask();
    const store = h.store();
    const events: unknown[] = [];
    store.on("task:updated", (payload: unknown) => events.push(payload));

    await store.logEntry(task.id, "Step 0 done: preflight complete", "2 files, duration_ms=2500");
    await store.logEntry(task.id, "Step 1 in-progress: schema work", undefined);

    const detail = await store.getTask(task.id);
    expect((detail.log ?? []).map((entry) => entry.action)).toEqual([
      "Task created",
      "Step 0 done: preflight complete",
      "Step 1 in-progress: schema work",
    ]);

    /*
    `readTaskJson` answers from the database row (the file is only the no-row fallback), so the merged view
    is asserted twice on purpose: through the store read boundary, and through the bytes actually written
    to `.fusion/tasks/<ID>/task.json`, which is what a CLI/agent reading the card off disk consumes.
    */
    const mirrored = await store.readTaskJson(store.taskDir(task.id));
    expect((mirrored.log ?? []).at(-1)?.action).toBe("Step 1 in-progress: schema work");
    const onDisk = JSON.parse(await readFile(join(store.taskDir(task.id), "task.json"), "utf-8")) as Task;
    expect((onDisk.log ?? []).map((entry) => entry.action)).toEqual([
      "Task created",
      "Step 0 done: preflight complete",
      "Step 1 in-progress: schema work",
    ]);
    expect(events.length).toBeGreaterThanOrEqual(2);
    store.removeAllListeners("task:updated");
  });

  it("authors the derived stall/timing envelope in the rollup because the row no longer carries it", async () => {
    const task = await h.createTestTask();
    const store = h.store();
    const projectId = taskLogProjectId(h.layer());
    const before = await probeRowVersion(h, task.id);

    // RUFU-615's stall marker, delivered through the seam that used to rewrite the row.
    await store.logEntry(task.id, "In-review stall surfaced [merge-blocker]", "waiting on merge");

    const after = await probeRowVersion(h, task.id);
    expect(after.version).toBe(before.version);
    expect(after.log_recent).toBe(before.log_recent);
    expect(after.timing_total_ms).toBe(before.timing_total_ms);

    const rollup = (await readTaskLogRollups(h.layer().db, projectId, [task.id])).get(task.id);
    expect(rollup).toBeDefined();
    // The precedence rule: with no legacy author after this append, the rollup IS the answer, and it
    // equals what RUFU-615's pairing would have derived from the same merged array.
    const merged = await readTaskLogEntries(h.layer().db, projectId, task.id);
    const picked = pickTaskLogEnvelope({
      rollup,
      legacyProjectionAt: (after.logProjectionAt as string | null | undefined) ?? null,
      legacyTimingTotalMs: after.timingTotalMs as number | null,
      legacyLogRecent: null,
    });
    expect(picked.logRecent).toEqual(deriveTaskLogProjections(merged as never).logRecent);
    expect(picked.timingTotalMs).toBe(deriveTaskLogProjections(merged as never).timingTotalMs);
  });

  it("suppresses a repeated diagnostic key inside the window without touching the row", async () => {
    const task = await h.createTestTask();
    const store = h.store();
    const before = await probeRowVersion(h, task.id);
    const key = "plan-admission-throttled:cap-3-dep-FN-1";

    const first = await store.logEntryOnce(task.id, {
      action: "Planning admission throttled", outcome: "waiting for a planner", dedupeKey: key, windowMs: 15 * 60_000,
    });
    const second = await store.logEntryOnce(task.id, {
      action: "Planning admission throttled", outcome: "waiting for a planner", dedupeKey: key, windowMs: 15 * 60_000,
    });

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(await sideEntryRows(h, task.id)).toHaveLength(1);
    const after = await probeRowVersion(h, task.id);
    expect(after.version).toBe(before.version);
    expect(after.updated_at).toBe(before.updated_at);

    // The dedupe probe reads the entries, not the card: a key outside the window re-arms.
    expect(await hasTaskLogEntryWithinWindow(h.layer().db, taskLogProjectId(h.layer()), task.id, key, 0)).toBe(false);
  });

  it("routes a compound queue transition's entry to the side table while its queue state stays on the row", async () => {
    const task = await h.createTestTask();
    const store = h.store();
    const before = await probeRowVersion(h, task.id);

    const result = await store.transitionQueuedEpisode(task.id, {
      signature: "dependency:RUFU-001",
      blockedBy: "RUFU-001",
      overlapBlockedBy: null,
      action: "Task queued: waiting on dependency RUFU-001",
      outcome: "dependency:RUFU-001",
    });

    expect(result.appended).toBe(true);
    expect(result.task.status).toBe("queued");
    // The queue mutation still rewrites the row (that is its own cost), but the log array it writes does
    // not grow: the entry lives in the side table and the merged read is where a reader finds it.
    const after = await probeRowVersion(h, task.id);
    expect(after.log_entries).toBe(before.log_entries);
    expect(after.version).not.toBe(before.version);
    const entries = await sideEntryRows(h, task.id);
    expect(entries.at(-1)?.action).toBe("Task queued: waiting on dependency RUFU-001");
    const detail = await store.getTask(task.id);
    expect((detail.log ?? []).at(-1)?.action).toBe("Task queued: waiting on dependency RUFU-001");
  });

  it("copies only legacy entries newer than the backfill mark, once", async () => {
    const layer = h.layer();
    const projectId = taskLogProjectId(layer);
    const task = await h.createTestTask();
    const mark = new Date(Date.now() - 60_000).toISOString();

    /*
    The mixed-version window this pass exists for: a daemon running the PREVIOUS build kept appending to the
    legacy column after migration 0093 copied the arrays. Entries older than the mark were already copied by
    the migration and must not be re-copied (that is what makes the pass bounded); entries stamped after it
    exist nowhere else and must be copied.
    */
    await layer.db.delete(schema.project.taskLogBackfillMarker)
      .where(eq(schema.project.taskLogBackfillMarker.projectId, projectId));
    await layer.db.insert(schema.project.taskLogBackfillMarker)
      .values({ projectId, backfilledAt: mark, copiedEntryCount: 0 });
    const before = new Date(Date.parse(mark) - 5_000).toISOString();
    const after1 = new Date(Date.parse(mark) + 1_000).toISOString();
    const after2 = new Date(Date.parse(mark) + 2_000).toISOString();
    const legacy = [
      { timestamp: before, action: "Copied by the migration", outcome: null },
      { timestamp: after1, action: "Appended by the old build", outcome: "first" },
      { timestamp: after2, action: "Appended again by the old build", outcome: "second" },
    ];
    await layer.db.update(schema.project.tasks)
      .set({ log: legacy as never })
      .where(eq(schema.project.tasks.id, task.id));

    const first = await catchUpLegacyTaskLogEntries(layer);
    expect(first.backfilledAt).toBe(mark);
    expect(first.copiedEntryCount).toBe(2);
    const entries = await readTaskLogEntries(layer.db, projectId, task.id);
    expect(entries.map((entry) => entry.action)).toEqual([
      "Appended by the old build",
      "Appended again by the old build",
    ]);
    expect(entries[0]!.timestamp).toBe(after1);

    // Idempotent: the second pass finds nothing it has not already copied.
    const second = await catchUpLegacyTaskLogEntries(layer);
    expect(second.copiedEntryCount).toBe(0);
    expect(await readTaskLogEntries(layer.db, projectId, task.id)).toHaveLength(2);

    // And a project the migration never marked stays untouched — no mark means no copy window to honour.
    await layer.db.delete(schema.project.taskLogBackfillMarker)
      .where(eq(schema.project.taskLogBackfillMarker.projectId, projectId));
    expect((await catchUpLegacyTaskLogEntries(layer)).examinedTaskCount).toBe(0);
  });

  it("honours the retention cap and outcome truncation the legacy array enforced", async () => {
    const layer = h.layer();
    const projectId = taskLogProjectId(layer);
    const task = await h.createTestTask();
    const wide = "x".repeat(6_000);

    const appended = await appendTaskLogEntries({
      client: layer.db,
      projectId,
      taskId: task.id,
      entries: Array.from({ length: 1_050 }, (_, i) => ({
        timestamp: new Date(Date.now() + i).toISOString(),
        action: `Bulk line ${i}`,
        outcome: i === 1000 ? wide : undefined,
      })),
    });
    expect(appended.appendedCount).toBe(1_050);

    const readBack = await readTaskLogEntries(layer.db, projectId, task.id);
    expect(readBack.length).toBeLessThanOrEqual(1_000);
    expect(readBack.at(-1)!.action).toBe("Bulk line 1049");
    expect(readBack[0]!.action).toBe("Bulk line 50");
    // The cap is RUFU-615's own truncation, applied on write, not a second bound invented here.
    expect(readBack.find((entry) => entry.action === "Bulk line 1000")!.outcome)
      .toBe(truncateTaskLogOutcome(wide));
  });

  it("refuses a soft-deleted card exactly as the legacy write path did", async () => {
    const task = await h.createTestTask();
    const store = h.store();
    await store.deleteTask(task.id);
    await expect(store.logEntry(task.id, "late line", "nope")).rejects.toThrow();
    // And the FK is ON DELETE CASCADE: a card that leaves the board takes its History rows with it.
    expect(await sideEntryRows(h, task.id)).toHaveLength(0);
  });

  /*
  FNXC:TaskLogSideTable 2026-11-01-21:52 (RUFU-312 code-review P0):
  The mixed-page regression the review named, and the reason it is P0 rather than a perf nit.

  The batched list merge originally asked for side entries newer than ONE page-wide watermark — the
  MAXIMUM timestamp across every row's loaded legacy array. Legacy arrays are per-row and independent, so
  any card whose own array is older than somebody else's lost every side entry stamped between the two.
  Those are precisely the entries that exist ONLY in the side table after the cutover, because a pure append
  no longer rewrites the array: card A takes a compound write, card B next to it only appends, and B's newest
  History lines vanish from `Task.log` on that read — permanently, in the steady state. Every consumer that
  greps markers off `task.log` (`hasAutoHealableVerificationBufferFailure`, `surfacing-sweeps` alreadySurfaced,
  the reflection/triage marker reads) then reads a card whose log-derived badge still came from the rollup
  lane, so one card answered two different stories.

  The assertion that fails on the page-wide watermark is B's 3-hour-old append (and C's 5-hour-old one):
  the watermark is A's one-minute-old compound write, so both are filtered out in SQL. The bound is now each
  row's own newest array entry, with NO bound for a row whose array is empty — the shape every card created
  after the cutover has.
  */
  it("merges each card's own side entries on a list read instead of one page-wide watermark", async () => {
    const store = h.store();
    const layer = h.layer();
    const projectId = taskLogProjectId(layer);
    const now = Date.now();
    const iso = (msAgo: number) => new Date(now - msAgo).toISOString();

    // Card A: a compound write stamps its legacy array one minute ago — the page's newest array, and
    // therefore the watermark the old code applied to every other card on the page.
    const cardA = await h.createTestTask();
    await store.updateTask(cardA.id, { log: [{ timestamp: iso(60_000), action: "Card A compound write", outcome: "a" }] });

    // Card B: an array authored six hours ago (its own bound), then pure appends at three hours and at
    // thirty seconds — the older one is the entry the page-wide watermark swallowed.
    const cardB = await h.createTestTask();
    await store.updateTask(cardB.id, { log: [{ timestamp: iso(6 * 60 * 60_000), action: "Card B legacy line", outcome: "b0" }] });
    await appendTaskLogEntries({
      client: layer.db,
      projectId,
      taskId: cardB.id,
      entries: [
        { timestamp: iso(3 * 60 * 60_000), action: "Card B pure append", outcome: "b1" },
        { timestamp: iso(30_000), action: "Card B newest append", outcome: "b2" },
      ],
    });

    // Card C: the post-cutover shape — an EMPTY legacy array with all of its History in the side table.
    // No timestamp bound can describe this card, so it must be read unbounded (capped) rather than merged
    // against somebody else's watermark.
    const cardC = await h.createTestTask();
    await store.updateTask(cardC.id, { log: [] });
    await appendTaskLogEntries({
      client: layer.db,
      projectId,
      taskId: cardC.id,
      entries: [{ timestamp: iso(5 * 60 * 60_000), action: "Card C side-only line", outcome: "c1" }],
    });

    const listed = await store.listTasks();
    const rowOf = (taskId: string) => listed.find((task) => task.id === taskId)!;
    const actions = (taskId: string) => rowOf(taskId).log.map((entry) => entry.action);

    // The two entries the page-wide watermark dropped.
    expect(actions(cardB.id)).toContain("Card B pure append");
    expect(actions(cardC.id)).toContain("Card C side-only line");
    // Ordering and the legacy half both survive the merge, and an entry the array already carries is
    // mirrored into the side table by the compound write — the identity dedupe must collapse it, not double it.
    expect(actions(cardB.id)).toEqual([
      "Card B legacy line",
      "Card B pure append",
      "Card B newest append",
    ]);
    expect(actions(cardA.id)).toEqual(["Card A compound write"]);
    // A per-row bound must not leak one card's rows into another card's merge.
    expect(actions(cardB.id)).not.toContain("Card A compound write");
    expect(actions(cardA.id)).not.toContain("Card B pure append");

    // The two read lanes agree: the detail hydration (unbounded, capped) and this batched list merge
    // answer the same History for the same card in the same order.
    for (const taskId of [cardA.id, cardB.id, cardC.id]) {
      const detail = await store.getTask(taskId);
      expect(rowOf(taskId).log.map((entry) => `${entry.timestamp}|${entry.action}|${entry.outcome ?? ""}`))
        .toEqual(detail.log.map((entry) => `${entry.timestamp}|${entry.action}|${entry.outcome ?? ""}`));
    }
  });
});
