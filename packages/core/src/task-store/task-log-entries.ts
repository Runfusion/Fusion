/*
FNXC:TaskLogSideTable 2026-11-01-17:35 (RUFU-312):
The task activity log's append-only home: `project.task_log_entries`, its envelope rollup, and the read
helpers that let the two views (legacy `tasks.log` jsonb + side rows) answer as one.

Why this module exists at all, measured on the production board 2026-10-31: the `log` jsonb column was
25 MB of 55 MB of live-row bytes (max single row 313 KB), so every diagnostic line rewrote a ~28 KB row
version, wrote a fresh TOAST chunk for the grown array, and re-maintained 16 indexes — 4 609 MB of heap
for 55 MB of data. The invariant this module enforces is therefore narrow and absolute:

  A PURE LOG APPEND WRITES NO `tasks` ROW AT ALL. Not the log column, not `updated_at`, not the
  RUFU-615 derived columns. `task-log-page-growth.pg.test.ts` measures it against `pg_table_size`.

Two consequences flow from that rule and shape every function below:

1. `tasks.timing_total_ms` / `tasks.log_recent` (RUFU-615's write-time board signals) can no longer be
   kept warm by the append, so the same envelope is authored into `task_log_rollup` instead. Which of the
   two authors a reader should trust is decided by comparing each author's own last stamp
   (`tasks.log_projection_at` vs `task_log_rollup.computed_at`) — see `pickTaskLogEnvelope`.
2. Readers may still be holding the legacy array (compound writers keep authoring it, and every daemon
   in a rolling restart wrote it until it was replaced), so a read answers from
   legacy ∪ side-table, de-duplicated on (timestamp, action, outcome) and capped by the shared retention
   limit. Batch list reads bound each task's fetch by THAT row's own newest entry — never by one page-wide
   watermark, which drops every card but the page's newest (see `readTaskLogEntriesBatch`).

Heap reclamation for the bytes the old write path already produced (`VACUUM FULL` / `pg_repack`) and the
eventual drop of the legacy column are operator-decided maintenance windows — see docs/storage.md.
Nothing in this file may ever automate them.
*/
import { and, asc, desc, eq, inArray, isNotNull, lt, or, sql, type SQL } from "drizzle-orm";
import * as schema from "../postgres/schema/index.js";
import type { AsyncDataLayer, DbTransaction, DrizzleDb } from "../postgres/data-layer.js";
import type { RunMutationContext, TaskLogEntry } from "../types.js";
import { getTaskActivityLogEntryLimit, truncateTaskLogOutcome } from "./comments.js";
import { deriveTaskLogProjections, type TaskLogRecentEnvelope } from "./task-log-projections.js";

/**
 * Both write surfaces: a normal `layer.db` statement or the transaction handle a caller already holds.
 * An append inside `updateTaskAtomic` must be as atomic as the write it rides alongside, which is why
 * the client is a parameter and never reached for internally.
 */
export type TaskLogClient = DbTransaction | DrizzleDb;

/** The unscoped partition marker `async-persistence` uses for a project-agnostic layer. */
export const TASK_LOG_UNSCOPED_PROJECT = "__legacy_unscoped__";

export function taskLogProjectId(layer: Pick<AsyncDataLayer, "projectId">): string {
  return layer.projectId?.trim() || TASK_LOG_UNSCOPED_PROJECT;
}

/** One log line as this module stores it. `seq` is assigned by the identity column, never by us. */
interface TaskLogEntryRow {
  seq: number;
  action: string;
  outcome: string | null;
  timestamp: string;
  runContext: unknown;
  dedupeKey: string | null;
}

function entryIdentity(entry: Pick<TaskLogEntry, "timestamp" | "action" | "outcome">): string {
  return `${entry.timestamp}\u0000${entry.action}\u0000${entry.outcome ?? ""}`;
}

/** Strict-enough ordering key: an unparseable timestamp is treated as oldest and keeps its neighbours. */
function entrySortKey(timestamp: string): number {
  const parsed = Date.parse(timestamp);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

function toEntry(row: TaskLogEntryRow): TaskLogEntry {
  const entry: TaskLogEntry = {
    timestamp: row.timestamp,
    action: row.action,
  };
  const outcome = truncateTaskLogOutcome(row.outcome ?? undefined);
  if (outcome) entry.outcome = outcome;
  if (row.runContext && typeof row.runContext === "object") {
    entry.runContext = row.runContext as RunMutationContext;
  }
  if (row.dedupeKey) entry.dedupeKey = row.dedupeKey;
  return entry;
}

/*
FNXC:TaskLogSideTable 2026-11-01-17:35 (RUFU-312):
The merge of the two views, in one place, because three readers need the identical answer: the History
tab (`getTaskLogEntries`), the single-task `getTask` hydration, and the batched list hydration. Legacy
lines come first in the ordering key's tie-break so a row whose array already held an entry keeps the
position it had before the cutover; side lines win a duplicate identity, which is what makes the boot
catch-up idempotent (re-copying a line it already copied is a no-op, not a second line).
*/
export function mergeTaskLogViews(legacy: readonly TaskLogEntry[], side: readonly TaskLogEntry[], cap?: number): TaskLogEntry[] {
  const limit = cap ?? getTaskActivityLogEntryLimit();
  const byIdentity = new Map<string, TaskLogEntry>();
  const ordered: Array<{ key: number; ord: number; entry: TaskLogEntry }> = [];
  legacy.forEach((entry, index) => {
    if (!entry || typeof entry !== "object") return;
    const identity = entryIdentity(entry);
    if (byIdentity.has(identity)) return;
    byIdentity.set(identity, entry);
    ordered.push({ key: entrySortKey(entry.timestamp), ord: index, entry });
  });
  const legacyCount = ordered.length;
  side.forEach((entry, index) => {
    if (!entry || typeof entry !== "object") return;
    const identity = entryIdentity(entry);
    const existing = byIdentity.get(identity);
    byIdentity.set(identity, entry);
    if (existing) {
      const prior = ordered.find((item) => item.entry === existing);
      if (prior) prior.entry = entry;
      return;
    }
    ordered.push({ key: entrySortKey(entry.timestamp), ord: legacyCount + index, entry });
  });
  ordered.sort((a, b) => (a.key - b.key) || (a.ord - b.ord));
  const merged = ordered.map((item) => item.entry);
  return merged.length > limit ? merged.slice(merged.length - limit) : merged;
}

/** Newest `cap` rows for one task, oldest-first — the shape `Task.log` has always had. */
export async function readTaskLogEntries(
  client: TaskLogClient,
  projectId: string,
  taskId: string,
  cap?: number,
): Promise<TaskLogEntry[]> {
  const limit = cap ?? getTaskActivityLogEntryLimit();
  const rows = await client
    .select({
      seq: schema.project.taskLogEntries.seq,
      action: schema.project.taskLogEntries.action,
      outcome: schema.project.taskLogEntries.outcome,
      timestamp: schema.project.taskLogEntries.timestamp,
      runContext: schema.project.taskLogEntries.runContext,
      dedupeKey: schema.project.taskLogEntries.dedupeKey,
    })
    .from(schema.project.taskLogEntries)
    .where(and(
      eq(schema.project.taskLogEntries.projectId, projectId),
      eq(schema.project.taskLogEntries.taskId, taskId),
    ))
    .orderBy(desc(schema.project.taskLogEntries.seq))
    .limit(limit);
  return rows.reverse().map(toEntry);
}

/** Ids per statement when every row carries its own bound (two bound parameters each). */
const PER_ROW_BOUND_CHUNK = 512;

/*
FNXC:TaskLogSideTable 2026-11-01-17:35 (RUFU-312):
The batched side of the same read, for list-shaped hydrations: ONE primary-key-range statement per page
(the caller's own cap bounds each task's bucket), never one query per card.

FNXC:TaskLogSideTable 2026-11-01-21:52 (RUFU-312 code-review P0):
The merge bound is PER ROW and must stay that way. The first version took one `sinceIso` for the whole
page — the MAXIMUM timestamp across every row's legacy array — and that silently deleted History: a card
whose own array is older than somebody else's loses every side entry stamped between the two, which is
precisely the set that exists ONLY in the side table once a pure append stopped touching the row. One card
taking a compound write next to a card that only appended is the steady state, not a corner case, so the
page-wide bound was not a perf knob that traded recall — it dropped the newest lines of every card but one.

Each task therefore carries its own bound in `bounds` (its own newest legacy timestamp, from
{@link latestEntryTimestamp}), applied to its own rows inside the same statement. Two rules decide what a
bound may not do:

- A task absent from `bounds`, or mapped to `null`, is read UNBOUNDED. That is the lossless default: an
  empty legacy array — every card created after the cutover — means no timestamp can describe where its
  History begins, and the per-task `cap` is what bounds the transfer.
- The comparison is `>=`, not `>`, against the row's own newest stamp. Identity is
  (timestamp, action, outcome), so a side line stamped in the same millisecond as the array's newest entry
  is a DIFFERENT line and a strict bound would hide it. The duplicates `>=` admits are removed by
  {@link mergeTaskLogViews}'s identity dedupe, and that dedupe is the only thing allowed to decide what a
  reader sees — a timestamp filter guessing which lines are "probably already in the array" is exactly how
  this class of loss returns.

Bounds cost two parameters per row, so a pathological page (a `listTasks()` over an entire board) is split
into {@link PER_ROW_BOUND_CHUNK}-sized statements instead of overflowing the parameter list. Chunks are
disjoint by task id, so one task's rows never split across statements and keep their order.
*/
export async function readTaskLogEntriesBatch(
  client: TaskLogClient,
  projectId: string,
  taskIds: readonly string[],
  options: {
    cap?: number;
    /** Each task's own lower bound (inclusive); absent or `null` = that task's newest `cap` rows. */
    bounds?: ReadonlyMap<string, string | null | undefined>;
  } = {},
): Promise<Map<string, TaskLogEntry[]>> {
  const byTask = new Map<string, TaskLogEntry[]>();
  const ids = [...new Set(taskIds)];
  if (ids.length === 0) return byTask;
  const cap = options.cap ?? getTaskActivityLogEntryLimit();
  for (let offset = 0; offset < ids.length; offset += PER_ROW_BOUND_CHUNK) {
    const chunk = ids.slice(offset, offset + PER_ROW_BOUND_CHUNK);
    const perRowBound: Array<SQL | undefined> = chunk.map((taskId) => {
      const ownRows = eq(schema.project.taskLogEntries.taskId, taskId);
      const bound = options.bounds?.get(taskId) ?? null;
      return bound === null
        ? ownRows
        : and(ownRows, sql`${schema.project.taskLogEntries.timestamp} >= ${bound}`);
    });
    const rows = await client
      .select({
        taskId: schema.project.taskLogEntries.taskId,
        seq: schema.project.taskLogEntries.seq,
        action: schema.project.taskLogEntries.action,
        outcome: schema.project.taskLogEntries.outcome,
        timestamp: schema.project.taskLogEntries.timestamp,
        runContext: schema.project.taskLogEntries.runContext,
        dedupeKey: schema.project.taskLogEntries.dedupeKey,
      })
      .from(schema.project.taskLogEntries)
      .where(and(
        eq(schema.project.taskLogEntries.projectId, projectId),
        // The task id is the partition of a bound, never a filter dropped onto another row's bound.
        inArray(schema.project.taskLogEntries.taskId, chunk),
        or(...perRowBound),
      ))
      .orderBy(asc(schema.project.taskLogEntries.taskId), desc(schema.project.taskLogEntries.seq))
      .limit(chunk.length * cap);
    for (const row of rows) {
      const bucket = byTask.get(row.taskId) ?? [];
      if (bucket.length >= cap) continue;
      bucket.push(toEntry(row));
      byTask.set(row.taskId, bucket);
    }
  }
  for (const [taskId, entries] of byTask) byTask.set(taskId, entries.reverse());
  return byTask;
}

export interface TaskLogRollupRow {
  entryCount: number;
  timingTotalMs: number;
  logRecent: TaskLogRecentEnvelope | null;
  computedAt: string;
}

/** Batched envelope fetch for log-free list reads. One PK-range statement per page, never one per row. */
export async function readTaskLogRollups(
  client: TaskLogClient,
  projectId: string,
  taskIds: readonly string[],
): Promise<Map<string, TaskLogRollupRow>> {
  const byTask = new Map<string, TaskLogRollupRow>();
  if (taskIds.length === 0) return byTask;
  const rows = await client
    .select({
      taskId: schema.project.taskLogRollup.taskId,
      entryCount: schema.project.taskLogRollup.entryCount,
      timingTotalMs: schema.project.taskLogRollup.timingTotalMs,
      logRecent: schema.project.taskLogRollup.logRecent,
      computedAt: schema.project.taskLogRollup.computedAt,
    })
    .from(schema.project.taskLogRollup)
    .where(and(
      eq(schema.project.taskLogRollup.projectId, projectId),
      inArray(schema.project.taskLogRollup.taskId, [...new Set(taskIds)]),
    ));
  for (const row of rows) {
    byTask.set(row.taskId, {
      entryCount: row.entryCount,
      timingTotalMs: row.timingTotalMs,
      logRecent: parseRollupEnvelope(row.logRecent),
      computedAt: row.computedAt,
    });
  }
  return byTask;
}

function parseRollupEnvelope(value: unknown): TaskLogRecentEnvelope | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<TaskLogRecentEnvelope>;
  if (typeof candidate.v !== "number") return null;
  return value as TaskLogRecentEnvelope;
}

/*
FNXC:TaskLogSideTable 2026-11-01-17:35 (RUFU-312):
The precedence rule between the two envelope authors, stated once. Each author stamps its own row at the
moment it authors its envelope, so the newer stamp is the envelope that reflects the log — and `updated_at`
is deliberately not the witness, because a status change that touched no log would otherwise claim an
envelope the log has not carried for hours. A rollup that has never been computed is no author at all.
*/
export function pickTaskLogEnvelope(input: {
  rollup: TaskLogRollupRow | undefined;
  legacyProjectionAt: string | null | undefined;
  legacyTimingTotalMs: number | null | undefined;
  legacyLogRecent: TaskLogRecentEnvelope | null;
}): { timingTotalMs: number | null; logRecent: TaskLogRecentEnvelope | null } {
  const { rollup, legacyProjectionAt, legacyTimingTotalMs, legacyLogRecent } = input;
  if (!rollup) return { timingTotalMs: legacyTimingTotalMs ?? null, logRecent: legacyLogRecent };
  if (!legacyProjectionAt) return { timingTotalMs: rollup.timingTotalMs, logRecent: rollup.logRecent };
  const rollupMs = Date.parse(rollup.computedAt);
  const legacyMs = Date.parse(legacyProjectionAt);
  if (Number.isNaN(legacyMs) || (!Number.isNaN(rollupMs) && rollupMs >= legacyMs)) {
    return { timingTotalMs: rollup.timingTotalMs, logRecent: rollup.logRecent };
  }
  return { timingTotalMs: legacyTimingTotalMs ?? null, logRecent: legacyLogRecent };
}

export interface AppendTaskLogEntriesInput {
  client: TaskLogClient;
  projectId: string;
  taskId: string;
  entries: readonly TaskLogEntry[];
  /**
   * The legacy array the merged envelope must be derived over. A caller that already holds it (the
   * compound writers, the catch-up) passes it; a pure append leaves it undefined and this module reads
   * the one column, which is a read of one TOAST pointer and never a write.
   */
  legacyLog?: readonly TaskLogEntry[] | null;
  /** Retention ceiling. Defaults to the shared 1 000-entry activity-log limit. */
  cap?: number;
  /** Skip the envelope author (a caller that will author it itself, or a bulk copy inside a migration). */
  skipRollup?: boolean;
}

export interface AppendTaskLogEntriesResult {
  appendedCount: number;
  trimmedCount: number;
}

/*
FNXC:TaskLogSideTable 2026-11-01-17:35 (RUFU-312):
THE APPEND. One INSERT, a bounded retention trim, and one small rollup UPSERT — no `tasks` write, which is
the whole point. The trim keeps the newest `cap` rows by `seq` (the same retention the jsonb array always
applied with `splice(0, length - limit)`, expressed as a delete of everything older than the cut-off row).
The envelope is re-derived over the MERGED view so a card's board badge cannot depend on which lane last
wrote: the legacy array is folded in, so a compound writer's line and this append's line are both counted.
*/
export async function appendTaskLogEntries(input: AppendTaskLogEntriesInput): Promise<AppendTaskLogEntriesResult> {
  const { client, projectId, taskId } = input;
  const cap = input.cap ?? getTaskActivityLogEntryLimit();
  const entries = input.entries.filter((entry) => entry && typeof entry === "object" && typeof entry.action === "string");
  if (entries.length === 0) return { appendedCount: 0, trimmedCount: 0 };

  await client.insert(schema.project.taskLogEntries).values(entries.map((entry) => ({
    projectId,
    taskId,
    action: entry.action,
    outcome: truncateTaskLogOutcome(entry.outcome ?? undefined) ?? null,
    timestamp: entry.timestamp,
    runContext: entry.runContext ?? null,
    dedupeKey: entry.dedupeKey ?? null,
  })));

  let trimmedCount = 0;
  const [cutOff] = await client
    .select({ seq: schema.project.taskLogEntries.seq })
    .from(schema.project.taskLogEntries)
    .where(and(
      eq(schema.project.taskLogEntries.projectId, projectId),
      eq(schema.project.taskLogEntries.taskId, taskId),
    ))
    .orderBy(desc(schema.project.taskLogEntries.seq))
    .offset(cap)
    .limit(1);
  if (cutOff) {
    const trimmed = await client
      .delete(schema.project.taskLogEntries)
      .where(and(
        eq(schema.project.taskLogEntries.projectId, projectId),
        eq(schema.project.taskLogEntries.taskId, taskId),
        lt(schema.project.taskLogEntries.seq, cutOff.seq),
      ))
      .returning({ seq: schema.project.taskLogEntries.seq });
    trimmedCount = trimmed.length;
  }

  if (!input.skipRollup) {
    const legacy = input.legacyLog === undefined
      ? await readLegacyTaskLog(client, projectId, taskId)
      : input.legacyLog;
    const side = await readTaskLogEntries(client, projectId, taskId, cap);
    await writeTaskLogRollup({
      client,
      projectId,
      taskId,
      merged: mergeTaskLogViews(legacy ?? [], side, cap),
      sideCount: side.length,
    });
  }
  return { appendedCount: entries.length, trimmedCount };
}

/** The legacy column, read narrow: one value for one task, never a full row materialization. */
export async function readLegacyTaskLog(
  client: TaskLogClient,
  projectId: string,
  taskId: string,
): Promise<TaskLogEntry[]> {
  const rows = await client
    .select({ log: schema.project.tasks.log })
    .from(schema.project.tasks)
    .where(and(
      eq(schema.project.tasks.projectId, projectId),
      eq(schema.project.tasks.id, taskId),
    ))
    .limit(1);
  const value = rows[0]?.log;
  return Array.isArray(value) ? (value as TaskLogEntry[]) : [];
}

/*
FNXC:TaskLogSideTable 2026-11-01-17:35 (RUFU-312):
The envelope author. Derivation is RUFU-615's own function — never a second implementation of the stall
grammar, the `[timing]` sum or the trailing-run walk — over the merged view this module just assembled.
*/
async function writeTaskLogRollup(input: {
  client: TaskLogClient;
  projectId: string;
  taskId: string;
  merged: readonly TaskLogEntry[];
  sideCount: number;
}): Promise<void> {
  const derived = deriveTaskLogProjections(input.merged as unknown as TaskLogEntry[]);
  await input.client.insert(schema.project.taskLogRollup)
    .values({
      projectId: input.projectId,
      taskId: input.taskId,
      entryCount: input.sideCount,
      timingTotalMs: derived.timingTotalMs,
      logRecent: derived.logRecent,
      computedAt: new Date().toISOString(),
    })
    .onConflictDoUpdate({
      target: [schema.project.taskLogRollup.projectId, schema.project.taskLogRollup.taskId],
      set: {
        entryCount: input.sideCount,
        timingTotalMs: derived.timingTotalMs,
        logRecent: derived.logRecent,
        computedAt: new Date().toISOString(),
      },
    });
}

/*
FNXC:TaskLogSideTable 2026-11-01-17:35 (RUFU-312):
`logEntryOnce`'s window probe, now an indexed side-table lookup instead of a scan of a jsonb array that
one measured card kept at 3.99 MB. The window rule is unchanged: the same key inside `windowMs` suppresses
the append, and only the timestamp comparison is loose (a malformed legacy timestamp parses to NaN and
therefore never suppresses, exactly as `Date.parse` arithmetic behaved on the array).
*/
export async function hasTaskLogEntryWithinWindow(
  client: TaskLogClient,
  projectId: string,
  taskId: string,
  dedupeKey: string,
  windowMs: number,
  nowMs: number,
): Promise<boolean> {
  const rows = await client
    .select({ timestamp: schema.project.taskLogEntries.timestamp })
    .from(schema.project.taskLogEntries)
    .where(and(
      eq(schema.project.taskLogEntries.projectId, projectId),
      eq(schema.project.taskLogEntries.taskId, taskId),
      eq(schema.project.taskLogEntries.dedupeKey, dedupeKey),
      isNotNull(schema.project.taskLogEntries.timestamp),
    ))
    .orderBy(desc(schema.project.taskLogEntries.seq))
    .limit(20);
  return rows.some((row) => {
    const parsed = Date.parse(row.timestamp);
    return !Number.isNaN(parsed) && nowMs - parsed < windowMs;
  });
}

/*
FNXC:TaskLogSideTable 2026-11-01-19:20 (RUFU-312):
The run-mutation read (`getMutationsForRun`). It used to be the worst consumer of the old shape: it listed
EVERY card with its full `log` column and filtered in JavaScript, i.e. it transferred the whole 55 MB of log
bytes to answer "which entries did this run write?". The side table answers the same question from a narrow
seq scan over a column that is never TOASTed, ordered by the timestamp the caller already sorts on.
Completeness argument: migration 0093 copied every legacy array across, and post-cutover only the seam that
carries a `runContext` writes those entries — into this table. So the side table is the authoritative set,
and the legacy column needs no second scan.
*/
export async function readTaskLogEntriesForRun(
  client: TaskLogClient,
  projectId: string,
  runId: string,
  cap?: number,
): Promise<(TaskLogEntry & { taskId: string })[]> {
  const limit = cap ?? getTaskActivityLogEntryLimit();
  const rows = await client
    .select({
      taskId: schema.project.taskLogEntries.taskId,
      action: schema.project.taskLogEntries.action,
      outcome: schema.project.taskLogEntries.outcome,
      timestamp: schema.project.taskLogEntries.timestamp,
      runContext: schema.project.taskLogEntries.runContext,
      dedupeKey: schema.project.taskLogEntries.dedupeKey,
    })
    .from(schema.project.taskLogEntries)
    .where(and(
      eq(schema.project.taskLogEntries.projectId, projectId),
      sql`jsonb_typeof(${schema.project.taskLogEntries.runContext}) = 'object'`,
      sql`${schema.project.taskLogEntries.runContext} ->> 'runId' = ${runId}`,
    ))
    .orderBy(asc(schema.project.taskLogEntries.timestamp))
    .limit(limit);
  return rows.map((row) => ({ ...toEntry(row as unknown as TaskLogEntryRow), taskId: row.taskId }));
}

/*
FNXC:TaskLogSideTable 2026-11-01-19:55 (RUFU-312):
Wholesale replacement. A writer that assigns `task.log` outright (rather than appending) means "this is the
History now" — that is what `updateTask({ log })` has always meant, and a caller must not have to know that
half the history moved to another table. So the side rows are dropped and the given array becomes the whole
set: the merged read equals the written array, the envelope is derived from that same array, and the two can
never disagree. Without this, `log: []` would empty the row's half while History kept showing entries, which
is precisely the envelope-vs-data drift RUFU-615 was written to prevent.
*/
export async function replaceTaskLogEntries(input: {
  client: TaskLogClient;
  projectId: string;
  taskId: string;
  entries: readonly TaskLogEntry[];
}): Promise<void> {
  await input.client.delete(schema.project.taskLogEntries)
    .where(and(
      eq(schema.project.taskLogEntries.projectId, input.projectId),
      eq(schema.project.taskLogEntries.taskId, input.taskId),
    ));
  if (input.entries.length === 0) {
    // An empty History is a real answer: author the empty envelope rather than leave a stale one behind.
    await writeTaskLogRollup({
      client: input.client,
      projectId: input.projectId,
      taskId: input.taskId,
      merged: [],
      sideCount: 0,
    });
    return;
  }
  await appendTaskLogEntries({
    client: input.client,
    projectId: input.projectId,
    taskId: input.taskId,
    entries: input.entries,
    legacyLog: input.entries,
  });
}

/*
FNXC:TaskLogSideTable 2026-11-01-17:35 (RUFU-312):
The bounded boot catch-up for the mixed-version rolling-restart window. A daemon running the previous
build appended to the legacy column until it was replaced, so a legacy line stamped at or after this
project's backfill mark can exist in no other place. This copies exactly those — never the whole array,
which is what made the column expensive — and it is a no-op once every legacy array is older than the
mark, including the ordinary steady-state boot. Candidate tasks are capped per pass so a backlog can
never delay readiness; the next boot takes the rest.
*/
export const TASK_LOG_CATCH_UP_TASK_LIMIT = 200;

export interface TaskLogCatchUpResult {
  examinedTaskCount: number;
  copiedEntryCount: number;
  backfilledAt: string | null;
}

export async function catchUpLegacyTaskLogEntries(
  layer: AsyncDataLayer,
  options: { limit?: number } = {},
): Promise<TaskLogCatchUpResult> {
  const projectId = taskLogProjectId(layer);
  const limit = options.limit ?? TASK_LOG_CATCH_UP_TASK_LIMIT;
  const [marker] = await layer.db
    .select({ backfilledAt: schema.project.taskLogBackfillMarker.backfilledAt })
    .from(schema.project.taskLogBackfillMarker)
    .where(eq(schema.project.taskLogBackfillMarker.projectId, projectId))
    .limit(1);
  if (!marker) return { examinedTaskCount: 0, copiedEntryCount: 0, backfilledAt: null };
  const backfilledAt = marker.backfilledAt;

  const candidates = await layer.db
    .select({ taskId: schema.project.tasks.id, log: schema.project.tasks.log })
    .from(schema.project.tasks)
    .where(and(
      eq(schema.project.tasks.projectId, projectId),
      sql`EXISTS (
             SELECT 1 FROM jsonb_array_elements(${schema.project.tasks.log}) AS e
              WHERE jsonb_typeof(e) = 'object'
                AND coalesce(e ->> 'timestamp', '') >= ${backfilledAt}
           )`,
    ))
    .orderBy(asc(schema.project.tasks.id))
    .limit(limit);

  let copiedEntryCount = 0;
  for (const candidate of candidates) {
    const legacy = Array.isArray(candidate.log) ? (candidate.log as TaskLogEntry[]) : [];
    const pending = legacy.filter((entry) => entry
      && typeof entry === "object"
      && typeof entry.action === "string"
      && (entry.timestamp ?? "") >= backfilledAt);
    if (pending.length === 0) continue;
    const existing = await readTaskLogEntries(layer.db, projectId, candidate.taskId);
    const seen = new Set(existing.map((entry) => entryIdentity(entry)));
    const missing = pending.filter((entry) => !seen.has(entryIdentity(entry)));
    if (missing.length === 0) continue;
    await appendTaskLogEntries({
      client: layer.db,
      projectId,
      taskId: candidate.taskId,
      entries: missing,
      legacyLog: legacy,
    });
    copiedEntryCount += missing.length;
  }
  return { examinedTaskCount: candidates.length, copiedEntryCount, backfilledAt };
}

/**
 * Newest timestamp ONE row's legacy array carries — that row's own merge bound for
 * {@link readTaskLogEntriesBatch}. `undefined` means the array holds nothing, so no bound describes that
 * card's History and the read must stay unbounded for it (see the P0 note on the batch read: a page-wide
 * bound is what made a card's own newest lines disappear).
 */
export function latestEntryTimestamp(entries: readonly TaskLogEntry[]): string | undefined {
  let newest: string | undefined;
  for (const entry of entries) {
    const timestamp = entry?.timestamp;
    if (typeof timestamp !== "string" || timestamp.length === 0) continue;
    if (newest === undefined || timestamp > newest) newest = timestamp;
  }
  return newest;
}

/** The retention limit this module shares with the legacy array's own compaction. Exported for tests. */
export const taskLogRetentionLimit = getTaskActivityLogEntryLimit;

/*
FNXC:TaskLogSideTable 2026-11-01-17:55 (RUFU-312):
Single-task hydration: replace a Task's `log` with the merged view so History, the per-card engine
consumers and the `.fusion/tasks/<ID>/task.json` mirror all keep seeing the same entries they saw before
the cutover, with the same 1 000-entry retention and 4 000-char outcome caps (the caps are applied where
the entries are read and written, never here — a second implementation of a cap is a second cap to drift).
Pass `sideEntries` when the caller already fetched them (a batch read) so one page never fetches twice.
*/
export async function hydrateTaskLogEntries(input: {
  client: TaskLogClient;
  projectId: string;
  taskId: string;
  legacyLog: readonly TaskLogEntry[] | null | undefined;
  cap?: number;
  sideEntries?: readonly TaskLogEntry[];
}): Promise<TaskLogEntry[]> {
  const side = input.sideEntries ?? await readTaskLogEntries(input.client, input.projectId, input.taskId, input.cap);
  return mergeTaskLogViews(input.legacyLog ?? [], side, input.cap);
}
