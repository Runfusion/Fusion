import type { Database } from "./db.js";
import type { AsyncDataLayer } from "./postgres/data-layer.js";
import { and, gte, lte, sql } from "drizzle-orm";
import * as schema from "./postgres/schema/index.js";

/**
 * Plugin activation analytics over the project-scoped `plugin_activations` table.
 *
 * Fusion records one row when a plugin or workflow extension genuinely activates
 * through `PluginLoader.loadPlugin` or `reloadPlugin`. The Command Center
 * Ecosystem card may show a count only when at least one in-range row exists.
 * Empty ranges return `unavailable: true` and `activations: 0` as a transport
 * shape, but UI callers must keep the honest unavailable sentinel — never render
 * `0` as if missing historical capture meant zero activations.
 *
 * Inclusivity: `from`/`to` bounds are inclusive and filter `activatedAt`.
 *
 * FNXC:CommandCenterEcosystem 2026-06-19-08:05:
 * Plugin activation analytics are project-scoped event aggregates. Absence of rows means the metric is unavailable for the selected range, not that Fusion observed zero activations.
 */

export interface PluginActivationAnalyticsQuery {
  /** ISO-8601 lower bound (inclusive). */
  from?: string;
  /** ISO-8601 upper bound (inclusive). */
  to?: string;
}

/** Activation count for a single plugin id. */
export interface PluginActivationPluginCount {
  pluginId: string;
  count: number;
}

export interface PluginActivationAnalytics {
  from: string | null;
  to: string | null;
  /** Real activation rows in range. */
  activations: number;
  /** Activation rows grouped by plugin id, descending by count. */
  byPlugin: PluginActivationPluginCount[];
  /** True when no in-range activation rows exist; UI should render the sentinel, not 0. */
  unavailable: boolean;
}

interface CountRow {
  count: number;
}

interface PluginCountRow {
  pluginId: string;
  count: number;
}

function rangeWhere(query: PluginActivationAnalyticsQuery): { where: string; params: string[] } {
  const clauses: string[] = [];
  const params: string[] = [];
  if (query.from !== undefined) {
    clauses.push("activatedAt >= ?");
    params.push(query.from);
  }
  if (query.to !== undefined) {
    clauses.push("activatedAt <= ?");
    params.push(query.to);
  }
  return {
    where: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "",
    params,
  };
}

/**
 * Aggregate plugin activations over a date range.
 *
 * Empty range yields `{ activations: 0, byPlugin: [], unavailable: true }` so
 * callers can preserve the Command Center unavailable sentinel rather than
 * fabricating a zero-valued metric.
 *
 * FNXC:CommandCenterEcosystem 2026-06-24-13:10:
 * Backend dual-path: when an `AsyncDataLayer` is provided, queries run against
 * PostgreSQL via Drizzle. When absent, the legacy sync SQLite path runs.
 */
export async function aggregatePluginActivations(
  dbOrLayer: Database | AsyncDataLayer,
  query: PluginActivationAnalyticsQuery = {},
): Promise<PluginActivationAnalytics> {
  // FNXC:RuntimeSatelliteAsync 2026-06-24-13:10:
  // Backend mode: query the PostgreSQL plugin_activations table via Drizzle.
  // FNXC:MonitorStoreDiscriminator 2026-06-26-10:30:
  // P1 fix (review #17): use `"ping" in dbOrLayer` (unique to AsyncDataLayer)
  // instead of the broken `"execute" in dbOrLayer || ("transactionImmediate" in dbOrLayer)`.
  if ("ping" in dbOrLayer) {
    const layer = dbOrLayer as AsyncDataLayer;
    const conditions = [];
    if (query.from !== undefined) conditions.push(gte(schema.project.pluginActivations.activatedAt, query.from));
    if (query.to !== undefined) conditions.push(lte(schema.project.pluginActivations.activatedAt, query.to));
    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const countRows = await layer.db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.project.pluginActivations)
      .where(where);
    const activations = countRows[0]?.count ?? 0;

    const byPluginRows = await layer.db
      .select({
        pluginId: schema.project.pluginActivations.pluginId,
        count: sql<number>`count(*)::int`,
      })
      .from(schema.project.pluginActivations)
      .where(where)
      .groupBy(schema.project.pluginActivations.pluginId)
      .orderBy(sql`count(*) DESC`, schema.project.pluginActivations.pluginId);
    const byPlugin = byPluginRows.map((row) => ({ pluginId: row.pluginId, count: row.count }));

    return {
      from: query.from ?? null,
      to: query.to ?? null,
      activations,
      byPlugin,
      unavailable: activations === 0,
    };
  }

  // Legacy sync SQLite path
  const db = dbOrLayer as Database;
  const { where, params } = rangeWhere(query);

  const activations = (
    db
      .prepare(`SELECT COUNT(*) AS count FROM plugin_activations ${where}`)
      .get(...params) as CountRow
  ).count;

  const byPlugin = db
    .prepare(
      `SELECT pluginId, COUNT(*) AS count
       FROM plugin_activations ${where}
       GROUP BY pluginId
       ORDER BY count DESC, pluginId ASC`,
    )
    .all(...params) as PluginCountRow[];

  return {
    from: query.from ?? null,
    to: query.to ?? null,
    activations,
    byPlugin,
    unavailable: activations === 0,
  };
}
