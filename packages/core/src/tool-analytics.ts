import { sql } from "drizzle-orm";
import type { Database } from "./db.js";
import type { AsyncDataLayer } from "./postgres/data-layer.js";
import { categorizeToolName } from "./usage-events.js";
import type { SteeringComment } from "./types.js";

/**
 * Tool-usage analytics over `usage_events`, plus the **autonomy ratio**.
 *
 * Autonomy ratio = tool_call count / human-intervention count. The denominator
 * is NOT raw user messages (which trend to zero for autonomous execution); it is
 * the count of human interventions, which has **three distinct sources** — they
 * are not one queryable table:
 *
 *   1. **Approvals** — rows in `approval_request_audit_events` whose `eventType`
 *      is `created` or `approved` (a human was asked to / did approve an action),
 *      timestamped by `createdAt`.
 *   2. **User-authored steers** — entries in the `steeringComments` JSON column
 *      on the `tasks` row, filtered to `author === "user"` (agent-authored steers
 *      are excluded), timestamped by each comment's `createdAt`.
 *   3. **Waiting-on-input** — a task *status*, not a counted event; intentionally
 *      DROPPED here (no concrete answer event is defined).
 *
 * A fully-autonomous session (zero interventions) must not divide by zero or
 * report ∞: when `interventions === 0` the ratio falls back to
 * tool-calls-per-session (`toolCalls / max(sessions, 1)`), and the result flags
 * `interventions: 0` so callers can render it as "fully autonomous".
 *
 * Inclusivity: `from`/`to` bounds are inclusive, matching `usage-events.ts`.
 */

export interface ToolAnalyticsQuery {
  /** ISO-8601 lower bound (inclusive). */
  from?: string;
  /** ISO-8601 upper bound (inclusive). */
  to?: string;
}

/** Tool-call count for a single coarse category. */
export interface ToolCategoryCount {
  category: string;
  count: number;
}

/** Breakdown of the autonomy-ratio denominator by source. */
export interface InterventionBreakdown {
  /** `created`/`approved` rows in `approval_request_audit_events`. */
  approvals: number;
  /** `steeringComments` entries with `author === "user"`. */
  userSteers: number;
  /** Total human interventions (sum of the components above). */
  total: number;
}

export interface ToolAnalytics {
  from: string | null;
  to: string | null;
  /** Total `tool_call` events in range. */
  toolCalls: number;
  /** Tool calls grouped by `category`, descending by count. */
  byCategory: ToolCategoryCount[];
  /** Distinct sessions (`session_start` events) in range. */
  sessions: number;
  interventions: InterventionBreakdown;
  /**
   * Autonomy ratio. When `interventions.total > 0` this is
   * `toolCalls / interventions.total`. When there are zero interventions it is
   * tool-calls-per-session (`toolCalls / max(sessions, 1)`) and
   * `fullyAutonomous` is true — never ∞ or NaN.
   */
  autonomyRatio: number;
  /** True when zero human interventions were recorded in range. */
  fullyAutonomous: boolean;
}

interface CountRow {
  count: number;
}

interface CategoryRow {
  toolName: string | null;
  category: string | null;
  count: number;
}

interface SteeringRow {
  steeringComments: string | null;
}

function inRange(ts: string, from?: string, to?: string): boolean {
  if (from !== undefined && ts < from) return false;
  if (to !== undefined && ts > to) return false;
  return true;
}

/**
 * Count human interventions from the three named sources (waiting-on-input is a
 * status, not counted). Returns the per-source breakdown plus the total.
 */
export async function countInterventions(
  dbOrLayer: Database | AsyncDataLayer,
  query: ToolAnalyticsQuery = {},
): Promise<InterventionBreakdown> {
  // FNXC:PostgresCommandCenterAnalytics 2026-06-27-10:00:
  // Backend (PostgreSQL) path. approval_request_audit_events.event_type /
  // created_at and tasks.steering_comments (jsonb, already parsed by
  // postgres-js) are read from schema-qualified project.* tables; the
  // user-authored-steer in-range counting mirrors the sync branch exactly.
  if ("ping" in dbOrLayer) {
    const layer = dbOrLayer as AsyncDataLayer;
    const aFrom = query.from !== undefined ? sql`AND created_at >= ${query.from}` : sql``;
    const aTo = query.to !== undefined ? sql`AND created_at <= ${query.to}` : sql``;
    const approvalRows = (await layer.db.execute(
      sql`SELECT count(*)::int AS count FROM project.approval_request_audit_events
          WHERE event_type IN ('created', 'approved') ${aFrom} ${aTo}`,
    )) as Array<{ count: number }>;
    const approvals = approvalRows[0]?.count ?? 0;

    const steeringRows = (await layer.db.execute(
      sql`SELECT steering_comments AS "steeringComments" FROM project.tasks
          WHERE steering_comments IS NOT NULL
            AND jsonb_typeof(steering_comments) = 'array'
            AND jsonb_array_length(steering_comments) > 0`,
    )) as Array<{ steeringComments: unknown }>;
    let userSteers = 0;
    for (const row of steeringRows) {
      const parsed = row.steeringComments;
      if (!Array.isArray(parsed)) continue;
      for (const comment of parsed as SteeringComment[]) {
        if (comment?.author !== "user") continue;
        if (!inRange(comment.createdAt ?? "", query.from, query.to)) continue;
        userSteers += 1;
      }
    }
    return { approvals, userSteers, total: approvals + userSteers };
  }

  const db = dbOrLayer as Database;
  // Source 1: approvals. `approval_request_audit_events.createdAt` is the ts;
  // count only the human-touch event types.
  const approvalClauses: string[] = ["eventType IN ('created', 'approved')"];
  const approvalParams: string[] = [];
  if (query.from !== undefined) {
    approvalClauses.push("createdAt >= ?");
    approvalParams.push(query.from);
  }
  if (query.to !== undefined) {
    approvalClauses.push("createdAt <= ?");
    approvalParams.push(query.to);
  }
  const approvals = (
    db
      .prepare(
        `SELECT COUNT(*) AS count FROM approval_request_audit_events WHERE ${approvalClauses.join(" AND ")}`,
      )
      .get(...approvalParams) as CountRow
  ).count;

  // Source 2: user-authored steers from the `steeringComments` JSON on tasks.
  // This re-introduces a per-task JSON read (documented in U2). Only rows with a
  // non-empty JSON array are scanned.
  const steeringRows = db
    .prepare(
      `SELECT steeringComments FROM tasks
       WHERE steeringComments IS NOT NULL AND steeringComments NOT IN ('', '[]')`,
    )
    .all() as SteeringRow[];
  let userSteers = 0;
  for (const row of steeringRows) {
    if (!row.steeringComments) continue;
    let parsed: SteeringComment[];
    try {
      parsed = JSON.parse(row.steeringComments) as SteeringComment[];
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) continue;
    for (const comment of parsed) {
      if (comment?.author !== "user") continue;
      if (!inRange(comment.createdAt ?? "", query.from, query.to)) continue;
      userSteers += 1;
    }
  }

  return { approvals, userSteers, total: approvals + userSteers };
}

/**
 * Aggregate tool usage and the autonomy ratio over a date range.
 *
 * Empty range yields zeroed structures (not nulls) and `autonomyRatio: 0`.
 */
export async function aggregateToolAnalytics(
  dbOrLayer: Database | AsyncDataLayer,
  query: ToolAnalyticsQuery = {},
): Promise<ToolAnalytics> {
  // FNXC:PostgresCommandCenterAnalytics 2026-06-27-10:00:
  // Backend (PostgreSQL) path. tool_call / session_start counts and the
  // tool_name/category group come from schema-qualified project.usage_events
  // (snake_case columns; the async connection has no `project` on search_path).
  // Category re-derivation, autonomy-ratio, and the zero-intervention fallback
  // run via the shared buildToolAnalytics, identical to the sync branch.
  if ("ping" in dbOrLayer) {
    const layer = dbOrLayer as AsyncDataLayer;
    const eFrom = query.from !== undefined ? sql`AND ts >= ${query.from}` : sql``;
    const eTo = query.to !== undefined ? sql`AND ts <= ${query.to}` : sql``;

    const toolCallsRows = (await layer.db.execute(
      sql`SELECT count(*)::int AS count FROM project.usage_events
          WHERE kind = 'tool_call' ${eFrom} ${eTo}`,
    )) as Array<{ count: number }>;
    const toolCalls = toolCallsRows[0]?.count ?? 0;

    const categoryRows = (await layer.db.execute(
      sql`SELECT tool_name AS "toolName", category AS category, count(*)::int AS count
          FROM project.usage_events
          WHERE kind = 'tool_call' ${eFrom} ${eTo}
          GROUP BY tool_name, category`,
    )) as unknown as CategoryRow[];

    const sessionsRows = (await layer.db.execute(
      sql`SELECT count(*)::int AS count FROM project.usage_events
          WHERE kind = 'session_start' ${eFrom} ${eTo}`,
    )) as Array<{ count: number }>;
    const sessions = sessionsRows[0]?.count ?? 0;

    const interventions = await countInterventions(layer, query);
    return buildToolAnalytics(toolCalls, categoryRows, sessions, interventions, query);
  }

  const db = dbOrLayer as Database;
  const eventClauses: string[] = [];
  const eventParams: string[] = [];
  if (query.from !== undefined) {
    eventClauses.push("ts >= ?");
    eventParams.push(query.from);
  }
  if (query.to !== undefined) {
    eventClauses.push("ts <= ?");
    eventParams.push(query.to);
  }
  const rangeWhere = eventClauses.length > 0 ? `AND ${eventClauses.join(" AND ")}` : "";

  const toolCalls = (
    db
      .prepare(
        `SELECT COUNT(*) AS count FROM usage_events WHERE kind = 'tool_call' ${rangeWhere}`,
      )
      .get(...eventParams) as CountRow
  ).count;

  /**
   * FNXC:CommandCenter 2026-06-17-21:43:
   * Historical usage rows were logged with `category = "other"` before Fusion tool families were mapped, so aggregation must re-derive those buckets from `toolName`.
   * Preserve explicit non-`other` categories because external callers may already provide a deliberate custom bucket.
   */
  const categoryRows = db
    .prepare(
      `SELECT toolName AS toolName, category AS category, COUNT(*) AS count
       FROM usage_events
       WHERE kind = 'tool_call' ${rangeWhere}
       GROUP BY toolName, category`,
    )
    .all(...eventParams) as CategoryRow[];

  const sessions = (
    db
      .prepare(
        `SELECT COUNT(*) AS count FROM usage_events WHERE kind = 'session_start' ${rangeWhere}`,
      )
      .get(...eventParams) as CountRow
  ).count;

  const interventions = await countInterventions(db, query);

  return buildToolAnalytics(toolCalls, categoryRows, sessions, interventions, query);
}

/**
 * FNXC:PostgresCommandCenterAnalytics 2026-06-27-10:00:
 * Pure assembly shared by the sync (SQLite) and async (PostgreSQL) paths of
 * {@link aggregateToolAnalytics}. Re-derives `other` categories from toolName,
 * sorts the category breakdown, and computes the autonomy ratio with the
 * zero-intervention tool-calls-per-session fallback. No I/O.
 */
function buildToolAnalytics(
  toolCalls: number,
  categoryRows: CategoryRow[],
  sessions: number,
  interventions: InterventionBreakdown,
  query: ToolAnalyticsQuery,
): ToolAnalytics {
  const categoryCounts = new Map<string, number>();
  for (const row of categoryRows) {
    const category = row.category && row.category !== "other" ? row.category : categorizeToolName(row.toolName);
    categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + row.count);
  }
  const byCategory: ToolCategoryCount[] = [...categoryCounts.entries()]
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category));

  let autonomyRatio: number;
  let fullyAutonomous: boolean;
  if (interventions.total > 0) {
    autonomyRatio = toolCalls / interventions.total;
    fullyAutonomous = false;
  } else {
    // Zero interventions: report tool-calls-per-session, never ∞ / divide-by-zero.
    autonomyRatio = toolCalls / Math.max(sessions, 1);
    fullyAutonomous = true;
  }

  return {
    from: query.from ?? null,
    to: query.to ?? null,
    toolCalls,
    byCategory,
    sessions,
    interventions,
    autonomyRatio,
    fullyAutonomous,
  };
}
