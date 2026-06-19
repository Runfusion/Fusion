import type { Database } from "./db.js";
import type { MttrSummary } from "./activity-analytics.js";

/**
 * Command Center external-signal analytics over the existing `incidents` table.
 *
 * FNXC:CommandCenter 2026-06-19-00:00:
 * The Signals tab must be backed by real project data, not a swallowed 404. Use the scoped incidents table that monitor ingestion already owns; when no incident source is connected, return honest zeros plus the MTTR unavailable sentinel instead of fabricating signal volume.
 */
export interface SignalsAnalyticsQuery {
  /** ISO-8601 lower bound (inclusive). */
  from?: string;
  /** ISO-8601 upper bound (inclusive). */
  to?: string;
}

export interface SignalsBreakdown {
  source: string;
  count: number;
}

export interface SignalsSeverityBreakdown {
  severity: string;
  count: number;
}

export interface SignalsStatusBreakdown {
  status: string;
  count: number;
}

export interface SignalsAnalytics {
  from: string | null;
  to: string | null;
  /** Incidents opened in range. */
  totalSignals: number;
  /** Open incidents opened in range. */
  open: number;
  /** Incidents resolved in range. */
  resolved: number;
  /** Mean time to resolve for incidents resolved in range. */
  mttr: MttrSummary;
  /** Incidents opened in range, grouped by source. */
  bySource: SignalsBreakdown[];
  /** Incidents opened in range, grouped by severity. */
  bySeverity: SignalsSeverityBreakdown[];
  /** Incidents opened in range, grouped by current status. */
  byStatus: SignalsStatusBreakdown[];
}

interface CountRow {
  count: number;
}

interface GroupRow {
  key: string | null;
  count: number;
}

interface ResolvedIncidentRow {
  openedAt: string;
  resolvedAt: string;
}

function tableExists(db: Database, name: string): boolean {
  const row = db
    .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) as CountRow;
  return row.count > 0;
}

function rangeWhere(column: string, query: SignalsAnalyticsQuery): { where: string; params: string[] } {
  const clauses: string[] = [];
  const params: string[] = [];
  if (query.from !== undefined) {
    clauses.push(`${column} >= ?`);
    params.push(query.from);
  }
  if (query.to !== undefined) {
    clauses.push(`${column} <= ?`);
    params.push(query.to);
  }
  return {
    where: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "",
    params,
  };
}

function emptySignals(query: SignalsAnalyticsQuery): SignalsAnalytics {
  return {
    from: query.from ?? null,
    to: query.to ?? null,
    totalSignals: 0,
    open: 0,
    resolved: 0,
    mttr: { value: null, unavailable: true, sampleCount: 0 },
    bySource: [],
    bySeverity: [],
    byStatus: [],
  };
}

function count(db: Database, sql: string, params: string[]): number {
  return (db.prepare(sql).get(...params) as CountRow).count;
}

function groupByColumn(
  db: Database,
  column: "source" | "severity" | "status",
  openedWhere: string,
  params: string[],
  fallback: string,
): Array<{ key: string; count: number }> {
  const rows = db
    .prepare(
      `SELECT COALESCE(NULLIF(TRIM(${column}), ''), ?) AS key, COUNT(*) AS count
       FROM incidents ${openedWhere}
       GROUP BY key
       ORDER BY count DESC, key ASC`,
    )
    .all(fallback, ...params) as GroupRow[];
  return rows.map((row) => ({ key: row.key ?? fallback, count: row.count }));
}

function computeMttr(db: Database, query: SignalsAnalyticsQuery): MttrSummary {
  const resolvedRange = rangeWhere("resolvedAt", query);
  const resolvedWhere = resolvedRange.where
    ? `${resolvedRange.where} AND resolvedAt IS NOT NULL`
    : "WHERE resolvedAt IS NOT NULL";
  const rows = db
    .prepare(`SELECT openedAt, resolvedAt FROM incidents ${resolvedWhere}`)
    .all(...resolvedRange.params) as ResolvedIncidentRow[];

  let totalMinutes = 0;
  let sampleCount = 0;
  for (const row of rows) {
    const opened = Date.parse(row.openedAt);
    const resolved = Date.parse(row.resolvedAt);
    if (!Number.isFinite(opened) || !Number.isFinite(resolved) || resolved < opened) continue;
    totalMinutes += (resolved - opened) / 60_000;
    sampleCount += 1;
  }

  return sampleCount === 0
    ? { value: null, unavailable: true, sampleCount: 0 }
    : { value: totalMinutes / sampleCount, unavailable: false, sampleCount };
}

/**
 * Aggregate the Command Center Signals surface from locally recorded incidents.
 * Missing/older schemas return an honest empty payload so the dashboard can show
 * "no source connected" without pretending that a zero came from ingestion.
 */
export function aggregateSignalsAnalytics(
  db: Database,
  query: SignalsAnalyticsQuery = {},
): SignalsAnalytics {
  if (!tableExists(db, "incidents")) return emptySignals(query);

  const openedRange = rangeWhere("openedAt", query);
  const resolvedRange = rangeWhere("resolvedAt", query);
  const resolvedWhere = resolvedRange.where
    ? `${resolvedRange.where} AND resolvedAt IS NOT NULL`
    : "WHERE resolvedAt IS NOT NULL";
  const openWhere = openedRange.where
    ? `${openedRange.where} AND status = 'open'`
    : "WHERE status = 'open'";

  const totalSignals = count(
    db,
    `SELECT COUNT(*) AS count FROM incidents ${openedRange.where}`,
    openedRange.params,
  );
  const open = count(db, `SELECT COUNT(*) AS count FROM incidents ${openWhere}`, openedRange.params);
  const resolved = count(db, `SELECT COUNT(*) AS count FROM incidents ${resolvedWhere}`, resolvedRange.params);

  const bySource = groupByColumn(db, "source", openedRange.where, openedRange.params, "(unknown)")
    .map((row) => ({ source: row.key, count: row.count }));
  const bySeverity = groupByColumn(db, "severity", openedRange.where, openedRange.params, "unknown")
    .map((row) => ({ severity: row.key, count: row.count }));
  const byStatus = groupByColumn(db, "status", openedRange.where, openedRange.params, "unknown")
    .map((row) => ({ status: row.key, count: row.count }));

  return {
    from: query.from ?? null,
    to: query.to ?? null,
    totalSignals,
    open,
    resolved,
    mttr: computeMttr(db, query),
    bySource,
    bySeverity,
    byStatus,
  };
}
