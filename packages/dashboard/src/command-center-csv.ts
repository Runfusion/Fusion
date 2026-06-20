import type {
  TokenAnalytics,
  ToolAnalytics,
  ActivityAnalytics,
  ProductivityAnalytics,
  GithubIssueAnalytics,
} from "@fusion/core";

/**
 * Command Center CSV serialization (U8).
 *
 * RFC-4180 serialization of the Phase-A analytics aggregator output so any
 * analytics table can be exported as `text/csv`. Pure: these helpers take an
 * already-aggregated, already-project-scoped result and emit a string. The
 * route handler (`register-command-center-routes.ts`) is responsible for
 * resolving the project-scoped store and running the aggregator first, exactly
 * like the JSON path — there is no DB access here, so there is no scoping leak
 * surface in this module.
 *
 * Format guarantees (RFC-4180):
 *  - A header row is always emitted, even for an empty result (header-only CSV,
 *    never a 204 / empty body).
 *  - Fields containing a comma, double-quote, CR, or LF are wrapped in double
 *    quotes; embedded double-quotes are doubled.
 *  - Records are terminated with CRLF (`\r\n`), consistently.
 */

const CRLF = "\r\n";

/** A scalar cell value. `null`/`undefined` serialize to an empty field. */
export type CsvCell = string | number | boolean | null | undefined;

/** A logical table: a fixed header plus zero or more rows of cells. */
export interface CsvTable {
  header: readonly string[];
  rows: readonly (readonly CsvCell[])[];
}

/** Quote a single field per RFC-4180 when (and only when) required. */
function quoteField(value: CsvCell): string {
  if (value === null || value === undefined) return "";
  const s = typeof value === "string" ? value : String(value);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/** Serialize one record (array of cells) to a CSV line (no terminator). */
function serializeRecord(record: readonly CsvCell[]): string {
  return record.map(quoteField).join(",");
}

/**
 * Serialize a {@link CsvTable} to an RFC-4180 string. Always emits the header
 * row; an empty `rows` yields a header-only document. The document is
 * CRLF-terminated, including a trailing CRLF after the final record (RFC-4180
 * permits this and it keeps the empty/non-empty cases uniform).
 */
export function serializeCsv(table: CsvTable): string {
  const lines: string[] = [serializeRecord(table.header)];
  for (const row of table.rows) {
    lines.push(serializeRecord(row));
  }
  return lines.join(CRLF) + CRLF;
}

// ---------------------------------------------------------------------------
// Aggregator → CsvTable converters
//
// Each analytics result is a small nested object; we flatten the
// developer-meaningful fields into a tabular shape. For token analytics with a
// groupBy, each group becomes a row; otherwise the grand total is a single row.
// ---------------------------------------------------------------------------

/** Token analytics → CSV. One row per group, or a single total row. */
export function tokenAnalyticsToTable(result: TokenAnalytics): CsvTable {
  const header = [
    "key",
    "inputTokens",
    "outputTokens",
    "cachedTokens",
    "cacheWriteTokens",
    "totalTokens",
    "nTasks",
    "costUsd",
    "costUnavailable",
  ];

  if (result.groupBy && result.groups.length > 0) {
    const rows = result.groups.map((g) => [
      g.key,
      g.inputTokens,
      g.outputTokens,
      g.cachedTokens,
      g.cacheWriteTokens,
      g.totalTokens,
      g.nTasks,
      g.cost.usd,
      g.cost.unavailable,
    ]);
    return { header, rows };
  }

  const t = result.totals;
  return {
    header,
    rows: [
      [
        "(total)",
        t.inputTokens,
        t.outputTokens,
        t.cachedTokens,
        t.cacheWriteTokens,
        t.totalTokens,
        t.nTasks,
        result.cost.usd,
        result.cost.unavailable,
      ],
    ],
  };
}

/** Tool analytics → CSV. One row per category plus a summary row. */
export function toolAnalyticsToTable(result: ToolAnalytics): CsvTable {
  const header = ["category", "count"];
  const rows: CsvCell[][] = result.byCategory.map((c) => [c.category, c.count]);
  // Always include the headline metrics so an empty byCategory is not empty.
  rows.push(["(toolCalls)", result.toolCalls]);
  rows.push(["(sessions)", result.sessions]);
  rows.push(["(interventions)", result.interventions.total]);
  rows.push(["(autonomyRatio)", result.autonomyRatio]);
  rows.push(["(fullyAutonomous)", result.fullyAutonomous]);
  return { header, rows };
}

/** Activity analytics → CSV. One row per day plus summary rows. */
export function activityAnalyticsToTable(result: ActivityAnalytics): CsvTable {
  const header = ["day", "messages", "activeNodes", "activeAgents", "agentRuns"];
  const rows: CsvCell[][] = result.daily.map((d) => [
    d.day,
    d.messages,
    d.activeNodes,
    d.activeAgents,
    d.agentRuns,
  ]);
  rows.push([
    "(total)",
    result.messages,
    result.activeNodes,
    result.activeAgents,
    result.agentRuns.total,
  ]);
  rows.push(["(sessions)", result.sessions, "", "", ""]);
  rows.push(["(stickiness)", result.stickiness, "", "", ""]);
  rows.push(["(agentRuns.total)", result.agentRuns.total, "", "", ""]);
  rows.push(["(agentRuns.active)", result.agentRuns.active, "", "", ""]);
  rows.push(["(agentRuns.completed)", result.agentRuns.completed, "", "", ""]);
  rows.push(["(agentRuns.failed)", result.agentRuns.failed, "", "", ""]);
  return { header, rows };
}

/** Productivity analytics → CSV. One row per language plus summary rows. */
export function productivityAnalyticsToTable(
  result: ProductivityAnalytics,
): CsvTable {
  const header = ["metric", "count"];
  const rows: CsvCell[][] = [];
  for (const lang of result.byLanguage) {
    rows.push([`language:${lang.language}`, lang.count]);
  }
  rows.push(["modifiedFiles", result.modifiedFiles]);
  rows.push(["commits", result.commits]);
  rows.push(["pullRequests", result.pullRequests]);
  rows.push(["loc", result.loc.value ?? ""]);
  rows.push(["hoursSaved", result.hoursSaved.value ?? ""]);
  rows.push(["completedTasks", result.taskDuration.completedTasks]);
  rows.push(["avgDurationMs", result.taskDuration.averageMs ?? ""]);
  rows.push(["medianDurationMs", result.taskDuration.medianMs ?? ""]);
  rows.push(["p90DurationMs", result.taskDuration.p90Ms ?? ""]);
  rows.push(["totalDurationMs", result.taskDuration.totalMs ?? ""]);
  return { header, rows };
}

/** GitHub issue analytics → CSV. Daily rows plus repo and summary rows. */
export function githubIssueAnalyticsToTable(
  result: GithubIssueAnalytics,
): CsvTable {
  const header = ["section", "key", "filed", "fixed", "net"];
  const rows: CsvCell[][] = result.daily.map((d) => [
    "daily",
    d.date,
    d.filed,
    d.fixed,
    d.filed - d.fixed,
  ]);
  for (const repo of result.byRepo) {
    rows.push(["repo", repo.repo, repo.filed, repo.fixed, repo.filed - repo.fixed]);
  }
  rows.push(["summary", "total", result.filed, result.fixed, result.net]);
  return { header, rows };
}
