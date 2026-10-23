/**
 * FNXC:TaskLogSignalEntries 2026-10-18-18:00:
 * `project.tasks.log_signal_entries` is maintained by a trigger: the in-order subset of `log` that a
 * slim-list signal can read. These tests pin that subset to the live detector constants (so changing a
 * pattern in TypeScript without updating the SQL fails here), check the trigger keeps it current, and
 * check slim-list signals computed from it equal a full-log read on generated boards.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import {
  STALLED_REVIEW_INVALID_TRANSITION_PATTERN,
  STALLED_REVIEW_REENQUEUE_PATTERN,
} from "../../tasks/stalled-review-detector.js";
import { IN_REVIEW_STALL_LOG_PREFIX } from "../../tasks/in-review-stall.js";

type Entry = { timestamp?: unknown; action?: unknown; outcome?: unknown; tag?: string };
const HOUR = 3_600_000;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

/** The JS-side predicates the slim path can act on, built from the live constants. */
function jsMayRead(e: Entry): boolean {
  const action = typeof e.action === "string" ? e.action : "";
  const outcome = typeof e.outcome === "string" ? e.outcome : "";
  return action.includes("[timing]") || outcome.includes("[timing]")
    || action.includes(STALLED_REVIEW_REENQUEUE_PATTERN)
    || STALLED_REVIEW_INVALID_TRANSITION_PATTERN.test(action)
    || STALLED_REVIEW_INVALID_TRANSITION_PATTERN.test(outcome)
    || action.startsWith(IN_REVIEW_STALL_LOG_PREFIX);
}

function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generatedLog(rand: () => number, n: number, opts: { nonStringActions?: boolean } = {}): Entry[] {
  const kinds: Array<() => Entry> = [
    () => ({ action: "ordinary progress" }),
    () => ({ action: `[timing] step took ${Math.floor(rand() * 900)}ms` }),
    () => ({ action: "x", outcome: `[timing] ${Math.floor(rand() * 90)}.5ms done` }),
    () => ({ action: `${STALLED_REVIEW_REENQUEUE_PATTERN} (attempt)` }),
    () => ({ action: "recovery", outcome: "Invalid transition: 'in-review' → 'todo'" }),
    () => ({ action: "Invalid transition: 'a' → 'b' while merging" }),
    () => ({ action: `${IN_REVIEW_STALL_LOG_PREFIX}merge-retries-exhausted]: quiet` }),
    ...(opts.nonStringActions ? [() => ({ action: 42 })] : []),
  ];
  const log: Entry[] = [];
  for (let i = 0; i < n; i++) {
    const entry = kinds[Math.floor(rand() * kinds.length)]!();
    const r = rand();
    entry.timestamp = r < 0.04 ? "2026-01-01 10:00:00+02" : r < 0.06 ? undefined : iso(Math.floor(rand() * 200) * HOUR + Math.floor(rand() * HOUR));
    log.push(entry);
  }
  return log;
}

pgDescribe("task log signal entries (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({ prefix: "fusion_log_signals" });
  beforeAll(h.beforeAll);
  afterAll(h.afterAll);
  beforeEach(async () => { await h.beforeEach(); });
  afterEach(async () => { await h.afterEach(); });

  async function setLog(id: string, log: unknown[]): Promise<void> {
    const sql = h.adminSql();
    await sql`update project.tasks set log = ${JSON.stringify(log)}::jsonb where id = ${id}`;
  }
  async function signals(id: string): Promise<Entry[]> {
    const sql = h.adminSql();
    const rows = await sql`select log_signal_entries as s from project.tasks where id = ${id}`;
    const s = rows[0]?.s;
    return (typeof s === "string" ? JSON.parse(s) : s) as Entry[];
  }

  describe("pinned to the detector constants", () => {
    it("keeps every entry a slim-path detector can match, in order, and drops the rest", async () => {
      const task = await h.store().createTask({ description: "pins", column: "in-review" });
      const log: Entry[] = [
        { tag: "plain-old", timestamp: iso(300 * HOUR), action: "ordinary" },
        { tag: "timing-action", timestamp: iso(299 * HOUR), action: "[timing] build 700ms" },
        { tag: "timing-outcome", timestamp: iso(298 * HOUR), action: "x", outcome: "[timing] 12ms" },
        { tag: "reenqueue", timestamp: iso(297 * HOUR), action: `${STALLED_REVIEW_REENQUEUE_PATTERN} again` },
        { tag: "invalid-action", timestamp: iso(296 * HOUR), action: "Invalid transition: 'a' → 'b'" },
        { tag: "invalid-outcome", timestamp: iso(295 * HOUR), action: "y", outcome: "Invalid transition: 'c' → 'd'" },
        { tag: "stall-prefix", timestamp: iso(294 * HOUR), action: `${IN_REVIEW_STALL_LOG_PREFIX}code]: z` },
        { tag: "odd-timestamp", timestamp: "2026-01-01 10:00:00+02", action: "ordinary" },
        { tag: "no-timestamp", action: "ordinary" },
        { tag: "numeric-action", timestamp: iso(293 * HOUR), action: 7 },
        { tag: "newest", timestamp: iso(1 * HOUR), action: "ordinary" },
        { tag: "plain-recent", timestamp: iso(2 * HOUR), action: "ordinary" },
      ];
      await setLog(task.id, log);

      const kept = (await signals(task.id)).map((e) => e.tag);
      expect(kept).toEqual([
        "timing-action", "timing-outcome", "reenqueue", "invalid-action", "invalid-outcome",
        "stall-prefix", "odd-timestamp", "no-timestamp", "newest",
      ]);
      for (const entry of log) {
        if (jsMayRead(entry)) expect(kept, `JS can read ${entry.tag}`).toContain(entry.tag);
      }
    });

    it("keeps every JS-readable entry across generated logs", async () => {
      const rand = mulberry32(4682);
      const task = await h.store().createTask({ description: "generated", column: "todo" });
      for (let round = 0; round < 20; round++) {
        const log = generatedLog(rand, 40, { nonStringActions: true }).map((e, i) => ({ ...e, tag: `e${i}` }));
        await setLog(task.id, log);
        const kept = new Set((await signals(task.id)).map((e) => e.tag));
        for (const entry of log) if (jsMayRead(entry)) expect(kept.has(entry.tag), `round ${round} ${entry.tag}`).toBe(true);
      }
    });
  });

  it("recomputes when the log changes and keeps it current on appends", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "appends", column: "in-review" });
    await store.logEntry(task.id, `${STALLED_REVIEW_REENQUEUE_PATTERN} via logEntry`);
    expect((await signals(task.id)).some((e) => String(e.action).includes(STALLED_REVIEW_REENQUEUE_PATTERN))).toBe(true);

    await store.updateTask(task.id, { title: "renamed" });
    expect((await signals(task.id)).some((e) => String(e.action).includes(STALLED_REVIEW_REENQUEUE_PATTERN))).toBe(true);

    const sql = h.adminSql();
    await sql`update project.tasks set log_signal_entries = '[]'::jsonb where id = ${task.id}`;
    expect((await signals(task.id)).some((e) => String(e.action).includes(STALLED_REVIEW_REENQUEUE_PATTERN))).toBe(true);
  });

  it("derives the same slim-list signals as a full-log read on generated boards", async () => {
    const store = h.store();
    const rand = mulberry32(17);
    const columns = ["in-review", "in-review", "todo", "in-progress"] as const;
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) {
      const task = await store.createTask({ description: `board ${i}`, column: columns[i % columns.length] });
      await setLog(task.id, generatedLog(rand, 30 + Math.floor(rand() * 60)));
      ids.push(task.id);
    }
    const slim = await store.listTasks({ slim: true, includeArchived: false });
    const full = await store.listTasks({ slim: false, includeArchived: false });
    for (const id of ids) {
      const s = slim.find((t) => t.id === id)!;
      const f = full.find((t) => t.id === id)!;
      expect(s.log, id).toEqual([]);
      expect(s.timedExecutionMs, id).toBe(store.computeTimedExecutionMs(f.log));
      expect(s.stalledReview, id).toEqual(f.stalledReview);
      expect(s.inReviewStalled, id).toEqual(f.inReviewStalled);
      expect(s.ageStaleness, id).toEqual(f.ageStaleness);
    }
  });
});
