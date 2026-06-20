import type { Database } from "./db.js";

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
 * Task-duration productivity stats are derived from `tasks.cumulativeActiveMs` for done tasks completed in the selected range. Missing qualifying durations are unavailable, not zero, so old or untracked tasks do not read as instant work.
 */
export interface TaskDurationSummary {
  completedTasks: number;
  averageMs: number | null;
  medianMs: number | null;
  p90Ms: number | null;
  totalMs: number | null;
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
  cumulativeActiveMs: number;
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
export function aggregateProductivityAnalytics(
  db: Database,
  query: ProductivityAnalyticsQuery = {},
): ProductivityAnalytics {
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
    "cumulativeActiveMs IS NOT NULL",
    "cumulativeActiveMs > 0",
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
      `SELECT cumulativeActiveMs FROM tasks WHERE ${durationClauses.join(" AND ")} ORDER BY cumulativeActiveMs ASC`,
    )
    .all(...durationParams) as TaskDurationRow[];
  const durations = durationRows.map((row) => row.cumulativeActiveMs);
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
  };
}
