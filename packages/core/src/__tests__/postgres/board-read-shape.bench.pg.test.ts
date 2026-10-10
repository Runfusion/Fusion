/*
FNXC:TaskLogProjections 2026-10-10-20:15 (RUFU-615):
This is a MEASUREMENT harness, not a test. It is skipped unless `FUSION_BOARD_BENCH=1`, because seeding a
2 417-row board with ~31 MB of task history is minutes of work the suite has no reason to pay. Run it:

  FUSION_BOARD_BENCH=1 FUSION_PG_TEST_URL_BASE=postgresql://localhost:25432 \
    pnpm --filter @fusion/core exec vitest run \
    src/__tests__/postgres/board-read-shape.bench.pg.test.ts --reporter=dot --silent=false

The board is SYNTHETIC with a distribution matched to the live board measured 2026-10-10 over 2 417
live rows: 31.4 MB of `log`, 42.7% of live-row bytes, 17 rows between 0.5 MB and 2.2 MB and the rest a
few KB each. The live embedded cluster is never connected to — only a COPY of a real board may be, per
this task's testing constraints — and it was not running at measurement time, so the SHAPE was
reproduced rather than the bytes. `pg_column_size` is read after TOAST compression, so the byte figures
below understate the saving rather than overstate it.
*/

import { it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import { tasks as tasksTable } from "../../postgres/schema/project.js";
import { deriveTaskLogProjections, LOG_RECENT_INLINE_BYTE_BUDGET } from "../../task-store/task-log-projections.js";

const RUN = process.env.FUSION_BOARD_BENCH === "1";
const benchIt = RUN ? it : it.skip;

/** Matched to the live board measured 2026-10-10: 2 417 rows, ~31 MB of log, 17 heavy rows. */
const BOARD_ROWS = 2_417;
const HEAVY_ROWS = 17;
const HEAVY_BYTES = 1_100_000;
const LIGHT_BYTES = 5_300;

const PROMPT_MD = "## Steps\n1. do the thing\n2. verify it\n\n## File Scope\n- src/x.ts\n";

/*
The filler is pseudo-RANDOM, not a repeated character: `pg_column_size` reports the value AFTER TOAST
compression, and a megabyte of `yyyy…` collapses to ~1 KB, so a naive fixture would measure a board a
fiftieth the size of the live one. This stays deterministic while being incompressible.
*/
function randomChars(n: number, seed: number): string {
  let a = seed >>> 0;
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let out = "";
  for (let k = 0; k < n; k += 1) {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    out += alphabet[((t ^ (t >>> 14)) >>> 0) % 64];
  }
  return out;
}

function logOfChars(target: number, seed: number): unknown[] {
  const entries: unknown[] = [];
  let chars = 0;
  let i = 0;
  const base = Date.UTC(2026, 9, 10, 12, 0, 0);
  while (chars < target) {
    const pad = Math.min(4_000, target - chars);
    const outcome = randomChars(pad, seed * 1_000_003 + i);
    entries.push({
      timestamp: new Date(base + i * 60_000).toISOString(),
      action: `step-${i % 40} progress`,
      outcome,
    });
    chars += outcome.length + 60;
    i += 1;
  }
  return entries;
}

const pgTest = pgDescribe;

/** The shipped migration file, so the bench backfills with the statement an upgrade actually runs. */
const TASK_LOG_PROJECTIONS_MIGRATION = fileURLToPath(new URL(
  "../../postgres/migrations/0092_rufu_615_task_log_projections.sql", import.meta.url,
));

pgTest("benchmarks every read shape the callers can ask for", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({ prefix: "fusion_board_bench" });
  beforeAll(h.beforeAll);
  afterAll(h.afterAll);

  benchIt("measures the board shapes", async () => {
    const store = h.store();
    const columns = ["intake", "hold", "todo", "in-progress", "review", "done"] as const;

    const db = h.adminDb();
    const batch: Array<Record<string, unknown>> = [];
    for (let i = 0; i < BOARD_ROWS; i += 1) {
      const heavy = i < HEAVY_ROWS;
      batch.push({
        id: `RUFU-${String(i).padStart(5, "0")}`,
        projectId: "",
        title: `Board row ${i}`,
        description: "Bench row",
        status: null,
        column: columns[i % columns.length],
        priority: "normal",
        labels: "[]",
        dependencies: "[]",
        source: "manual",
        prompt: null,
        log: JSON.stringify(logOfChars(heavy ? HEAVY_BYTES : LIGHT_BYTES, i)),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      if (batch.length === 50 || i === BOARD_ROWS - 1) {
        await db.insert(tasksTable).values(batch as never).onConflictDoNothing();
        batch.length = 0;
      }
      /*
      One PROMPT.md per card, so `slim` carries the same per-card document work it carries on a real
      board. Skipping this would flatter `slim` against `{}` for a reason that has nothing to do with
      the log column.
      */
      if (i % 25 === 0) {
        // The read path parses `join(store.taskDir(id), "PROMPT.md")`, so the bench writes exactly that
        // file — the cost being measured is the real fs read plus parse, not a mock of it.
        const dir = store.taskDir(`RUFU-${String(i).padStart(5, "0")}`);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "PROMPT.md"), PROMPT_MD, "utf8");
      }
    }

    /*
    FNXC:TaskLogProjections 2026-10-10-20:15 (RUFU-615): the seeded INSERTs deliberately bypass the write
    seam, so the projections are filled here by the migration's OWN backfill block. Measuring a board
    whose `log_recent` is NULL would time a read of nothing and flatter the very shape being evaluated.
    */
    const migrationSql = await readFile(TASK_LOG_PROJECTIONS_MIGRATION, "utf8");
    await h.adminSql().unsafe(migrationSql.slice(migrationSql.indexOf("DO $fn$")));
    const projected = (await h.adminSql()`
      SELECT count(*) FILTER (WHERE log_recent IS NOT NULL) AS with_envelope, count(*) AS all_rows
        FROM project.tasks
    `) as unknown as Array<{ with_envelope: string; all_rows: string }>;
    expect(Number(projected[0]!.with_envelope)).toBe(Number(projected[0]!.all_rows));

    const shapes: Array<[string, Record<string, unknown>]> = [
      ["today's board (default derive, full row)", {}],
      ["derive:false", { derive: false }],
      ["excludeLog (the RUFU-202 shape)", { derive: false, excludeLog: true }],
      ["slim + excludeLog (board page, no PROMPT.md parse)", { slim: true, excludeLog: true, startupMemo: false }],
      ["slim alone (PROMPT.md parse included)", { slim: true, startupMemo: false }],
      ["derive:true + excludeLog (projections answer)", { excludeLog: true }],
    ];

    const report: string[] = [];
    for (const [label, opts] of shapes) {
      // Warm once: the first call pays catalog, page-cache and prepared-statement costs no steady-state
      // refresh pays, then take the median of three.
      const warm = await store.listTasks(opts as never);
      const samples: number[] = [];
      /*
      The symptom this task was filed against is allocation churn, not CPU: the board refresh was
      accounted for ~91% of the server's allocation and the RSS growth ended in a watchdog kill. So the
      measurement records what the process actually retained across the runs — RSS delta (always
      available) and, when the runner was started with `--expose-gc`, the post-GC heap delta, which is
      the honest allocation figure rather than the allocator's high-water mark.
      */
      const rssBefore = process.memoryUsage().rss;
      const gc = (globalThis as { gc?: () => void }).gc;
      gc?.();
      const heapBefore = process.memoryUsage().heapUsed;
      for (let run = 0; run < 3; run += 1) {
        const t0 = process.hrtime.bigint();
        await store.listTasks(opts as never);
        samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
      }
      samples.sort((a, b) => a - b);
      const heapAfter = process.memoryUsage().heapUsed;
      const rssAfter = process.memoryUsage().rss;
      report.push(
        `${label}\n  ${warm.length} rows  median ${samples[1]!.toFixed(0)} ms  (min ${samples[0]!.toFixed(0)}, max ${samples[2]!.toFixed(0)})  ` +
        `rss-delta ${(rssAfter - rssBefore) / 1024 / 1024 <= 0 ? "~0" : ((rssAfter - rssBefore) / 1024 / 1024).toFixed(1) + " MB"}  ` +
        `heap-delta${gc ? "(gc)" : "(raw)"} ${(heapAfter - heapBefore) / 1024 / 1024 <= 0 ? "~0" : ((heapAfter - heapBefore) / 1024 / 1024).toFixed(1) + " MB"}`,
      );
    }

    const bytes = (await h.adminSql()`
      SELECT sum(pg_column_size(log)) AS log_bytes,
             sum(coalesce(pg_column_size(log_recent), 0)) AS recent_bytes,
             count(*) AS rows
        FROM project.tasks
    `) as unknown as Array<{ log_bytes: string; recent_bytes: string; rows: string }>;
    report.push(
      `stored bytes: log ${Number(bytes[0]!.log_bytes).toLocaleString()}  ` +
      `envelope ${Number(bytes[0]!.recent_bytes).toLocaleString()}  ` +
      `ratio ${(Number(bytes[0]!.log_bytes) / Math.max(1, Number(bytes[0]!.recent_bytes))).toFixed(0)}:1  ` +
      `over ${bytes[0]!.rows} rows`,
    );

    /*
    FNXC:TaskLogProjections 2026-10-10-20:15 (RUFU-615): the write side of the trade. The derivation now
    runs on EVERY log append, so the honest question is what that costs on the worst row on the board —
    a 1.1 MB, ~1 000-entry log at the retention cap. If the append path had become pathological, the
    board would be cheap and the engine's hottest write would be the new bottleneck, which is only a
    different outage.
    */
    const heavyId = "RUFU-00000";
    const lightId = `RUFU-${String(HEAVY_ROWS + 500).padStart(5, "0")}`;
    for (const [label, id] of [["worst-case row (1.1 MB log)", heavyId], ["typical row (~5 KB log)", lightId]] as const) {
      const appends: number[] = [];
      for (let n = 0; n < 20; n += 1) {
        const t0 = process.hrtime.bigint();
        await store.logEntry(id, `[bench] append ${n} to measure the derivation cost per write`);
        appends.push(Number(process.hrtime.bigint() - t0) / 1e6);
      }
      appends.sort((a, b) => a - b);
      report.push(`log append on ${label}: median ${appends[10]!.toFixed(1)} ms (max ${appends[appends.length - 1]!.toFixed(1)})`);
    }

    /*
    The append figure above includes the row write itself, which already rewrote a 1.1 MB `log` before
    this task existed. The number that isolates NEW work is the derivation alone, run over the same
    worst-case array: that is the cost the write seam added, and it is what would have to be pathological
    for the trade to be wrong.
    */
    const worstLog = logOfChars(HEAVY_BYTES, 0);
    const deriveSamples: number[] = [];
    for (let n = 0; n < 20; n += 1) {
      const t0 = process.hrtime.bigint();
      deriveTaskLogProjections(worstLog);
      deriveSamples.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    deriveSamples.sort((a, b) => a - b);
    report.push(
      `derivation alone over the worst-case log (${worstLog.length} entries): median ${deriveSamples[10]!.toFixed(2)} ms ` +
      `(max ${deriveSamples[deriveSamples.length - 1]!.toFixed(2)})`,
    );

    console.log("\n=== RUFU-615 board read shapes ===\n" + report.join("\n") + "\n");

    // A benchmark that cannot differ is not measuring anything.
    expect((await store.listTasks({})).length).toBe(BOARD_ROWS);
    const narrow = await store.listTasks({ excludeLog: true } as never);
    expect(narrow.length).toBe(BOARD_ROWS);
    expect(narrow[0]!.log).toEqual([]);
    expect(LOG_RECENT_INLINE_BYTE_BUDGET).toBeLessThan(LIGHT_BYTES);
  }, 1_800_000);
});
