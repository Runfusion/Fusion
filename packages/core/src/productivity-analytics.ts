import { sql } from "drizzle-orm";
import type { Database } from "./db.js";
import type { AsyncDataLayer } from "./postgres/data-layer.js";

/**
 * Productivity analytics: files modified (count + language distribution) from
 * `tasks.modifiedFiles`, commit associations from `task_commit_associations`,
 * pull requests from `pull_requests`, LOC from merge-time commit diff stats,
 * and estimated human hours saved derived from the same LOC source.
 *
 * **LOC availability.** Fusion persists nullable `additions`/`deletions` on
 * `task_commit_associations` when merge paths can capture git shortstat output.
 * LOC is reported as a real value only when at least one in-range association
 * has non-null stats. If the range has no recorded stats, the documented
 * unavailable sentinel — `{ value: null, unavailable: true }` — is preserved,
 * **never `0`**, so missing historical data is not mistaken for "zero lines
 * changed". Human-hours-saved uses the same sentinel because it is a
 * conservative estimate over real LOC rather than an independent data source.
 *
 * Inclusivity: `from`/`to` bounds are inclusive. Tasks are filtered by
 * `updatedAt` (the last time the task — and therefore its modifiedFiles — was
 * touched); completed-task durations by `executionCompletedAt`; commit
 * associations by `authoredAt`; PRs by `createdAt`.
 */

/*
FNXC:CommandCenterProductivity 2026-06-19-12:00:
Human hours saved is intentionally a rough headline estimate from already-aggregated changed LOC. Use one conservative exported rate so dashboards, CSV exports, and docs can cite the same assumption without adding a new data source or implying precision.
*/
export const HUMAN_LINES_PER_HOUR = 15;

export interface ProductivityAnalyticsQuery {
  /** ISO-8601 lower bound (inclusive). */
  from?: string;
  /** ISO-8601 upper bound (inclusive). */
  to?: string;
}

/** A single language's modified-file count. */
export interface LanguageCount {
  /** Lowercased file extension (no dot), or `other` when none. */
  language: string;
  count: number;
}

/**
 * LOC summary. `value` is null and `unavailable` true when no in-range commit
 * association has diff stats — never `0` for unknown data.
 */
export interface LocSummary {
  value: number | null;
  unavailable: boolean;
}

/**
 * Estimated human hours saved. `value` is an estimate in hours. It is null and
 * `unavailable` true when the underlying LOC source is unavailable — never `0`
 * for unknown data.
 */
export interface HoursSavedSummary {
  value: number | null;
  unavailable: boolean;
}

/**
 * FNXC:CommandCenterProductivity 2026-06-19-12:00:
 * Task-duration productivity stats are derived from combined planning (`cumulativePlanningMs`) and execution (`cumulativeActiveMs`) activity for done tasks completed in the selected range. Missing qualifying combined durations are unavailable, not zero, so old or untracked tasks do not read as instant work.
 */
export interface TaskDurationSummary {
  completedTasks: number;
  averageMs: number | null;
  medianMs: number | null;
  p90Ms: number | null;
  totalMs: number | null;
  unavailable: boolean;
}

/**
 * FNXC:CommandCenterProductivity 2026-06-30-10:17:
 * Operators need average and median task active duration over time from real completed-task planning plus execution history. Trend buckets are emitted only for days with qualifying completed tasks; missing history must stay absent/unavailable, never fabricated as zero-duration chart points.
 */
export interface TaskDurationTrendBucket {
  bucket: string;
  completedTasks: number;
  averageMs: number | null;
  medianMs: number | null;
  unavailable: boolean;
}

export interface ProductivityAnalytics {
  from: string | null;
  to: string | null;
  /** Total modified-file paths across matched tasks. */
  modifiedFiles: number;
  /** Modified files grouped by language (extension), descending by count. */
  byLanguage: LanguageCount[];
  /** Rows in `task_commit_associations` in range. */
  commits: number;
  /** Rows in `pull_requests` in range. */
  pullRequests: number;
  /** LOC from commit association diff stats when at least one in-range row has stats. */
  loc: LocSummary;
  /** Estimated human-hours equivalent derived from `loc` when LOC is available. */
  hoursSaved: HoursSavedSummary;
  /** Active execution duration for done tasks completed in range. */
  taskDuration: TaskDurationSummary;
  /** Per-day active execution duration for done tasks completed in range. */
  taskDurationTrend: TaskDurationTrendBucket[];
}

interface CountRow {
  count: number;
}

interface CommitStatsRow {
  count: number;
  additions: number | null;
  deletions: number | null;
  statsRows: number;
}

interface ModifiedFilesRow {
  modifiedFiles: string | null;
}

interface TaskDurationRow {
  cumulativeActiveMs: number | null;
  cumulativePlanningMs: number | null;
  executionCompletedAt: string;
}

/** Extract a coarse language key from a file path (its lowercased extension). */
function languageOf(path: string): string {
  const base = path.split("/").pop() ?? path;
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return "other";
  return base.slice(dot + 1).toLowerCase();
}

function median(sortedValues: readonly number[]): number | null {
  if (sortedValues.length === 0) return null;
  const middle = Math.floor(sortedValues.length / 2);
  if (sortedValues.length % 2 === 1) return sortedValues[middle] ?? null;
  return ((sortedValues[middle - 1] ?? 0) + (sortedValues[middle] ?? 0)) / 2;
}

function nearestRankPercentile(sortedValues: readonly number[], percentile: number): number | null {
  if (sortedValues.length === 0) return null;
  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil(percentile * sortedValues.length) - 1),
  );
  return sortedValues[index] ?? null;
}

/**
 * Aggregate productivity metrics over a date range. Empty range yields zeroed
 * structures (not nulls); LOC and task duration remain unavailable sentinels
 * unless at least one in-range row carries real source data.
 */
export async function aggregateProductivityAnalytics(
  dbOrLayer: Database | AsyncDataLayer,
  query: ProductivityAnalyticsQuery = {},
): Promise<ProductivityAnalytics> {
  // FNXC:PostgresCommandCenterAnalytics 2026-06-27-10:00:
  // Backend (PostgreSQL) path. The async connection does not put `project` on
  // the search_path, so every table is schema-qualified (project.*) and uses
  // snake_case columns. `modified_files` is jsonb (postgres-js returns it
  // already parsed), so the language/file count runs over the parsed array
  // rather than JSON.parse. pull_requests.created_at is a bigint epoch-ms
  // column (mirrors the SQLite INTEGER column), so ISO bounds are converted to
  // epoch ms. Semantics (range columns, COALESCE/SUM/COUNT, statsRows gate, LOC
  // unavailable sentinel, duration percentiles) mirror the sync branch exactly.
  if ("ping" in dbOrLayer) {
    return aggregateProductivityAnalyticsAsync(dbOrLayer, query);
  }
  const db = dbOrLayer as Database;
  // Modified files: read the JSON array off tasks updated in range.
  const taskClauses: string[] = [
    "modifiedFiles IS NOT NULL",
    "modifiedFiles NOT IN ('', '[]')",
  ];
  const taskParams: string[] = [];
  if (query.from !== undefined) {
    taskClauses.push("updatedAt >= ?");
    taskParams.push(query.from);
  }
  if (query.to !== undefined) {
    taskClauses.push("updatedAt <= ?");
    taskParams.push(query.to);
  }
  const taskRows = db
    .prepare(
      `SELECT modifiedFiles FROM tasks WHERE ${taskClauses.join(" AND ")}`,
    )
    .all(...taskParams) as ModifiedFilesRow[];

  let modifiedFiles = 0;
  const langMap = new Map<string, number>();
  for (const row of taskRows) {
    if (!row.modifiedFiles) continue;
    let files: unknown;
    try {
      files = JSON.parse(row.modifiedFiles);
    } catch {
      continue;
    }
    if (!Array.isArray(files)) continue;
    for (const f of files) {
      if (typeof f !== "string" || f.length === 0) continue;
      modifiedFiles += 1;
      const lang = languageOf(f);
      langMap.set(lang, (langMap.get(lang) ?? 0) + 1);
    }
  }
  const byLanguage: LanguageCount[] = [...langMap.entries()]
    .map(([language, count]) => ({ language, count }))
    .sort((a, b) => b.count - a.count);

  // Commits from task_commit_associations (by authoredAt).
  const commitClauses: string[] = [];
  const commitParams: string[] = [];
  if (query.from !== undefined) {
    commitClauses.push("authoredAt >= ?");
    commitParams.push(query.from);
  }
  if (query.to !== undefined) {
    commitClauses.push("authoredAt <= ?");
    commitParams.push(query.to);
  }
  const commitWhere =
    commitClauses.length > 0 ? `WHERE ${commitClauses.join(" AND ")}` : "";
  const commitStats = db
    .prepare(
      `SELECT
         COUNT(*) AS count,
         SUM(additions) AS additions,
         SUM(deletions) AS deletions,
         COUNT(CASE WHEN additions IS NOT NULL OR deletions IS NOT NULL THEN 1 END) AS statsRows
       FROM task_commit_associations ${commitWhere}`,
    )
    .get(...commitParams) as CommitStatsRow;
  const commits = commitStats.count;
  const loc: LocSummary = commitStats.statsRows > 0
    ? { value: (commitStats.additions ?? 0) + (commitStats.deletions ?? 0), unavailable: false }
    : { value: null, unavailable: true };
  const hoursSaved: HoursSavedSummary = loc.unavailable || loc.value === null
    ? { value: null, unavailable: true }
    : { value: Math.round((loc.value / HUMAN_LINES_PER_HOUR) * 10) / 10, unavailable: false };

  const durationClauses: string[] = [
    `"column" = 'done'`,
    "executionCompletedAt IS NOT NULL",
    "(COALESCE(cumulativeActiveMs, 0) + COALESCE(cumulativePlanningMs, 0)) > 0",
  ];
  const durationParams: string[] = [];
  if (query.from !== undefined) {
    durationClauses.push("executionCompletedAt >= ?");
    durationParams.push(query.from);
  }
  if (query.to !== undefined) {
    durationClauses.push("executionCompletedAt <= ?");
    durationParams.push(query.to);
  }
  const durationRows = db
    .prepare(
      `SELECT cumulativeActiveMs, cumulativePlanningMs, executionCompletedAt FROM tasks WHERE ${durationClauses.join(" AND ")} ORDER BY executionCompletedAt ASC`,
    )
    .all(...durationParams) as TaskDurationRow[];
  const durations = durationRows.map((row) => (row.cumulativeActiveMs ?? 0) + (row.cumulativePlanningMs ?? 0)).sort((a, b) => a - b);
  const totalDurationMs = durations.reduce((sum, durationMs) => sum + durationMs, 0);
  const taskDuration: TaskDurationSummary = durations.length > 0
    ? {
      completedTasks: durations.length,
      averageMs: totalDurationMs / durations.length,
      medianMs: median(durations),
      p90Ms: nearestRankPercentile(durations, 0.9),
      totalMs: totalDurationMs,
      unavailable: false,
    }
    : {
      completedTasks: 0,
      averageMs: null,
      medianMs: null,
      p90Ms: null,
      totalMs: null,
      unavailable: true,
    };

  const durationBuckets = new Map<string, number[]>();
  for (const row of durationRows) {
    const bucket = row.executionCompletedAt.slice(0, 10);
    const bucketDurations = durationBuckets.get(bucket) ?? [];
    bucketDurations.push((row.cumulativeActiveMs ?? 0) + (row.cumulativePlanningMs ?? 0));
    durationBuckets.set(bucket, bucketDurations);
  }
  const taskDurationTrend: TaskDurationTrendBucket[] = [...durationBuckets.entries()].map(([bucket, bucketDurations]) => {
    const sortedBucketDurations = [...bucketDurations].sort((a, b) => a - b);
    const bucketTotalMs = sortedBucketDurations.reduce((sum, durationMs) => sum + durationMs, 0);
    return {
      bucket,
      completedTasks: sortedBucketDurations.length,
      averageMs: sortedBucketDurations.length > 0 ? bucketTotalMs / sortedBucketDurations.length : null,
      medianMs: median(sortedBucketDurations),
      unavailable: sortedBucketDurations.length === 0,
    };
  });

  // Pull requests. `pull_requests.createdAt` is an INTEGER epoch-ms column, so
  // convert the ISO bounds to epoch ms for comparison.
  const prClauses: string[] = [];
  const prParams: number[] = [];
  if (query.from !== undefined) {
    prClauses.push("createdAt >= ?");
    prParams.push(Date.parse(query.from));
  }
  if (query.to !== undefined) {
    prClauses.push("createdAt <= ?");
    prParams.push(Date.parse(query.to));
  }
  const prWhere = prClauses.length > 0 ? `WHERE ${prClauses.join(" AND ")}` : "";
  const pullRequests = (
    db
      .prepare(`SELECT COUNT(*) AS count FROM pull_requests ${prWhere}`)
      .get(...prParams) as CountRow
  ).count;

  return {
    from: query.from ?? null,
    to: query.to ?? null,
    modifiedFiles,
    byLanguage,
    commits,
    pullRequests,
    loc,
    hoursSaved,
    taskDuration,
    taskDurationTrend,
  };
}

/**
 * FNXC:PostgresCommandCenterAnalytics 2026-06-27-10:00:
 * PostgreSQL implementation of {@link aggregateProductivityAnalytics}. Mirrors
 * the sync SQLite aggregation one-for-one against the real `project.*` tables.
 */
async function aggregateProductivityAnalyticsAsync(
  layer: AsyncDataLayer,
  query: ProductivityAnalyticsQuery,
): Promise<ProductivityAnalytics> {
  // Modified files: tasks updated in range whose modified_files is a non-empty
  // jsonb array. postgres-js returns jsonb already parsed.
  const mfFrom = query.from !== undefined ? sql`AND updated_at >= ${query.from}` : sql``;
  const mfTo = query.to !== undefined ? sql`AND updated_at <= ${query.to}` : sql``;
  const taskRows = (await layer.db.execute(
    sql`SELECT modified_files AS "modifiedFiles" FROM project.tasks
        WHERE modified_files IS NOT NULL
          AND jsonb_typeof(modified_files) = 'array'
          AND jsonb_array_length(modified_files) > 0
          ${mfFrom} ${mfTo}`,
  )) as Array<{ modifiedFiles: unknown }>;

  let modifiedFiles = 0;
  const langMap = new Map<string, number>();
  for (const row of taskRows) {
    const files = row.modifiedFiles;
    if (!Array.isArray(files)) continue;
    for (const f of files) {
      if (typeof f !== "string" || f.length === 0) continue;
      modifiedFiles += 1;
      const lang = languageOf(f);
      langMap.set(lang, (langMap.get(lang) ?? 0) + 1);
    }
  }
  const byLanguage: LanguageCount[] = [...langMap.entries()]
    .map(([language, count]) => ({ language, count }))
    .sort((a, b) => b.count - a.count);

  // Commits + LOC from task_commit_associations (by authored_at).
  const cFrom = query.from !== undefined ? sql`AND authored_at >= ${query.from}` : sql``;
  const cTo = query.to !== undefined ? sql`AND authored_at <= ${query.to}` : sql``;
  const commitStatsRows = (await layer.db.execute(
    sql`SELECT
          count(*)::int AS count,
          COALESCE(SUM(additions), 0)::int AS additions,
          COALESCE(SUM(deletions), 0)::int AS deletions,
          COUNT(CASE WHEN additions IS NOT NULL OR deletions IS NOT NULL THEN 1 END)::int AS "statsRows"
        FROM project.task_commit_associations
        WHERE 1=1 ${cFrom} ${cTo}`,
  )) as Array<{ count: number; additions: number; deletions: number; statsRows: number }>;
  const commitStats = commitStatsRows[0] ?? { count: 0, additions: 0, deletions: 0, statsRows: 0 };
  const commits = commitStats.count;
  const loc: LocSummary = commitStats.statsRows > 0
    ? { value: (commitStats.additions ?? 0) + (commitStats.deletions ?? 0), unavailable: false }
    : { value: null, unavailable: true };
  const hoursSaved: HoursSavedSummary = loc.unavailable || loc.value === null
    ? { value: null, unavailable: true }
    : { value: Math.round((loc.value / HUMAN_LINES_PER_HOUR) * 10) / 10, unavailable: false };

  // Active-execution duration for done tasks completed in range.
  const dFrom = query.from !== undefined ? sql`AND execution_completed_at >= ${query.from}` : sql``;
  const dTo = query.to !== undefined ? sql`AND execution_completed_at <= ${query.to}` : sql``;
  const durationRows = (await layer.db.execute(
    sql`SELECT cumulative_active_ms AS "cumulativeActiveMs", cumulative_planning_ms AS "cumulativePlanningMs", execution_completed_at AS "executionCompletedAt"
        FROM project.tasks
        WHERE "column" = 'done'
          AND execution_completed_at IS NOT NULL
          AND (COALESCE(cumulative_active_ms, 0) + COALESCE(cumulative_planning_ms, 0)) > 0
          ${dFrom} ${dTo}
        ORDER BY (COALESCE(cumulative_active_ms, 0) + COALESCE(cumulative_planning_ms, 0)) ASC`,
  )) as Array<{ cumulativeActiveMs: number | null; cumulativePlanningMs: number | null; executionCompletedAt: string }>;
  const durations = durationRows.map((row) => Number(row.cumulativeActiveMs ?? 0) + Number(row.cumulativePlanningMs ?? 0));
  const totalDurationMs = durations.reduce((sum, durationMs) => sum + durationMs, 0);
  const taskDuration: TaskDurationSummary = durations.length > 0
    ? {
      completedTasks: durations.length,
      averageMs: totalDurationMs / durations.length,
      medianMs: median(durations),
      p90Ms: nearestRankPercentile(durations, 0.9),
      totalMs: totalDurationMs,
      unavailable: false,
    }
    : {
      completedTasks: 0,
      averageMs: null,
      medianMs: null,
      p90Ms: null,
      totalMs: null,
      unavailable: true,
    };

  const durationBuckets = new Map<string, number[]>();
  for (const row of durationRows) {
    const bucket = row.executionCompletedAt.slice(0, 10);
    const bucketDurations = durationBuckets.get(bucket) ?? [];
    bucketDurations.push(Number(row.cumulativeActiveMs ?? 0) + Number(row.cumulativePlanningMs ?? 0));
    durationBuckets.set(bucket, bucketDurations);
  }
  const taskDurationTrend: TaskDurationTrendBucket[] = [...durationBuckets.entries()].map(([bucket, bucketDurations]) => {
    const sortedBucketDurations = [...bucketDurations].sort((a, b) => a - b);
    const bucketTotalMs = sortedBucketDurations.reduce((sum, durationMs) => sum + durationMs, 0);
    return {
      bucket,
      completedTasks: sortedBucketDurations.length,
      averageMs: sortedBucketDurations.length > 0 ? bucketTotalMs / sortedBucketDurations.length : null,
      medianMs: sortedBucketDurations.length > 0 ? median(sortedBucketDurations) : null,
      unavailable: false,
    };
  });

  // Pull requests. pull_requests.created_at is a bigint epoch-ms column, so the
  // ISO bounds are converted to epoch ms for comparison (mirrors sync branch).
  const prFrom = query.from !== undefined ? sql`AND created_at >= ${Date.parse(query.from)}` : sql``;
  const prTo = query.to !== undefined ? sql`AND created_at <= ${Date.parse(query.to)}` : sql``;
  const prRows = (await layer.db.execute(
    sql`SELECT count(*)::int AS count FROM project.pull_requests WHERE 1=1 ${prFrom} ${prTo}`,
  )) as Array<{ count: number }>;
  const pullRequests = prRows[0]?.count ?? 0;

  return {
    from: query.from ?? null,
    to: query.to ?? null,
    modifiedFiles,
    byLanguage,
    commits,
    pullRequests,
    loc,
    hoursSaved,
    taskDuration,
    taskDurationTrend,
  };
}
