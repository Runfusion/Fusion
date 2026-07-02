/**
 * Async Drizzle audit / activity-log / run-audit helpers (U14).
 *
 * FNXC:TaskStoreAudit 2026-06-24-09:00:
 * Async equivalents of the sync SQLite audit, activity-log, and run-audit
 * call sites in store.ts (`insertRunAuditEventRow`, `queryRunAuditEvents`,
 * `recordActivity`, `getActivityLog`, `getTaskMovedCountsByDay`). These
 * helpers target the PostgreSQL `project.run_audit_events` and
 * `project.activity_log` tables via Drizzle.
 *
 * The run-audit-event-within-transaction behavior is provided by the data-layer
 * foundation (`recordRunAuditEventWithinTransaction` in data-layer.ts). This
 * module adds the query-side helpers (filtering, pagination, aggregation) and
 * the activity-log record/query helpers that the migrating store consumes.
 *
 * Audit mutations and run-audit events commit or roll back together because
 * both writes run inside the same `transactionImmediate(async (tx) => ...)`
 * handle. This is the atomicity contract VAL-DATA-002/003 require.
 *
 * Transition context (see library/taskstore-persistence-notes.md):
 *   `getDatabase()` still returns the sync `Database` until U15 flips it. The
 *   TaskStore facade keeps its sync audit path (the gate depends on it).
 *   These helpers are the async target the migrating store and the PostgreSQL
 *   integration tests consume.
 */
import { and, count, desc, eq, gte, lte, sql } from "drizzle-orm";
import * as schema from "../postgres/schema/index.js";
import type { AsyncDataLayer, DbTransaction } from "../postgres/data-layer.js";
import {
  recordRunAuditEventWithinTransaction,
  recordRunAuditEvent,
  type RunAuditEvent,
} from "../postgres/data-layer.js";
import type { ActivityLogEntry, ActivityEventType, RunAuditEventFilter } from "../types.js";
import type { ActivityLogRow, RunAuditEventRow } from "./row-types.js";

// ── Run-audit events ─────────────────────────────────────────────────

/**
 * Re-export the data-layer run-audit helpers so the migrating store can import
 * them from a single task-store entry point.
 */
export { recordRunAuditEventWithinTransaction, recordRunAuditEvent };

/**
 * Convert a raw `run_audit_events` row into the public `RunAuditEvent` shape.
 * The `metadata` column is jsonb, so Drizzle returns it already-parsed.
 */
function rowToRunAuditEvent(row: RunAuditEventRow): RunAuditEvent {
  // The metadata column is jsonb in PostgreSQL (already-parsed). In SQLite it
  // was TEXT (needs JSON.parse). Handle both for transition safety.
  const metadata =
    typeof row.metadata === "string"
      ? safeJsonParse(row.metadata)
      : (row.metadata as Record<string, unknown> | null);
  return {
    id: row.id,
    timestamp: row.timestamp,
    taskId: row.taskId,
    agentId: row.agentId,
    runId: row.runId,
    domain: row.domain,
    mutationType: row.mutationType,
    target: row.target,
    metadata,
  };
}

function safeJsonParse(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * FNXC:TaskStoreAudit 2026-06-24-09:05:
 * Query run-audit events with optional filtering by runId, taskId, agentId,
 * domain, mutationType, and timestamp range. This is the async equivalent of
 * `queryRunAuditEvents`. Ordered by timestamp DESC (newest first), with an
 * optional limit.
 *
 * @param db The Drizzle instance.
 * @param filter Optional filter (runId, taskId, agentId, domain, mutationType, startTime, endTime, limit).
 * @returns The matching run-audit events.
 */
export async function queryRunAuditEvents(
  db: AsyncDataLayer["db"] | DbTransaction,
  filter: RunAuditEventFilter = {},
): Promise<RunAuditEvent[]> {
  const conditions = [];
  if (filter.runId) {
    conditions.push(eq(schema.project.runAuditEvents.runId, filter.runId));
  }
  if (filter.taskId) {
    conditions.push(eq(schema.project.runAuditEvents.taskId, filter.taskId));
  }
  if (filter.agentId) {
    conditions.push(eq(schema.project.runAuditEvents.agentId, filter.agentId));
  }
  if (filter.domain) {
    conditions.push(eq(schema.project.runAuditEvents.domain, filter.domain));
  }
  if (filter.mutationType) {
    conditions.push(eq(schema.project.runAuditEvents.mutationType, filter.mutationType));
  }
  if (filter.startTime) {
    conditions.push(gte(schema.project.runAuditEvents.timestamp, filter.startTime));
  }
  if (filter.endTime) {
    conditions.push(lte(schema.project.runAuditEvents.timestamp, filter.endTime));
  }

  // FNXC:TaskStoreAudit 2026-06-26-10:15:
  // Apply LIMIT in SQL, not JS. Previously the whole matching set was fetched
  // then `.slice()`d in memory; with no rotation on `run_audit_events` this
  // pulled unbounded rows over the wire. Build the WHERE/LIMIT into the SELECT
  // chain so only the requested page is transferred.
  const baseQuery = db
    .select()
    .from(schema.project.runAuditEvents)
    .orderBy(desc(schema.project.runAuditEvents.timestamp));
  const filtered =
    conditions.length > 0 ? baseQuery.where(and(...conditions)) : baseQuery;
  const limited =
    filter.limit && filter.limit > 0 ? filtered.limit(filter.limit) : filtered;
  const rows = (await limited) as RunAuditEventRow[];
  return rows.map((row) => rowToRunAuditEvent(row));
}

/**
 * Count run-audit events matching a filter. Useful for dashboards/metrics.
 */
export async function countRunAuditEvents(
  db: AsyncDataLayer["db"] | DbTransaction,
  filter: RunAuditEventFilter = {},
): Promise<number> {
  const conditions = [];
  if (filter.runId) {
    conditions.push(eq(schema.project.runAuditEvents.runId, filter.runId));
  }
  if (filter.taskId) {
    conditions.push(eq(schema.project.runAuditEvents.taskId, filter.taskId));
  }
  if (filter.agentId) {
    conditions.push(eq(schema.project.runAuditEvents.agentId, filter.agentId));
  }
  if (filter.domain) {
    conditions.push(eq(schema.project.runAuditEvents.domain, filter.domain));
  }
  if (filter.mutationType) {
    conditions.push(eq(schema.project.runAuditEvents.mutationType, filter.mutationType));
  }
  if (filter.startTime) {
    conditions.push(gte(schema.project.runAuditEvents.timestamp, filter.startTime));
  }
  if (filter.endTime) {
    conditions.push(lte(schema.project.runAuditEvents.timestamp, filter.endTime));
  }

  const query = db
    .select({ value: count() })
    .from(schema.project.runAuditEvents);
  const rows = conditions.length > 0 ? await query.where(and(...conditions)) : await query;
  return rows[0]?.value ?? 0;
}

// ── Activity log ─────────────────────────────────────────────────────

/**
 * Convert a raw `activity_log` row into the public `ActivityLogEntry` shape.
 * The `metadata` column is jsonb in PostgreSQL (already-parsed).
 */
function rowToActivityLogEntry(row: ActivityLogRow): ActivityLogEntry {
  // The metadata column is jsonb in PostgreSQL (already-parsed). In SQLite it
  // was TEXT (needs JSON.parse). Handle both for transition safety.
  const metadata =
    typeof row.metadata === "string"
      ? safeJsonParse(row.metadata)
      : (row.metadata as Record<string, unknown> | null);
  return {
    id: row.id,
    timestamp: row.timestamp,
    type: row.type as ActivityEventType,
    taskId: row.taskId || undefined,
    taskTitle: row.taskTitle || undefined,
    details: row.details,
    metadata: metadata ?? undefined,
  };
}

/**
 * FNXC:TaskStoreAudit 2026-06-24-09:10:
 * Record an activity-log entry. This is the async equivalent of
 * `recordActivity`. The entry is written best-effort (errors are swallowed,
 * matching the sync behavior — the activity log is non-critical and must not
 * break operations).
 *
 * @param db The Drizzle instance.
 * @param entry The activity entry (without id/timestamp, which are generated).
 * @returns The full entry with id and timestamp.
 */
export async function recordActivityLogEntry(
  db: AsyncDataLayer["db"] | DbTransaction,
  entry: Omit<ActivityLogEntry, "id" | "timestamp">,
): Promise<ActivityLogEntry> {
  const fullEntry: ActivityLogEntry = {
    ...entry,
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
  };

  try {
    await db.insert(schema.project.activityLog).values({
      id: fullEntry.id,
      timestamp: fullEntry.timestamp,
      type: fullEntry.type,
      taskId: fullEntry.taskId ?? null,
      taskTitle: fullEntry.taskTitle ?? null,
      details: fullEntry.details,
      // jsonb column: Drizzle serializes the JS value.
      metadata: fullEntry.metadata ?? null,
    });
  } catch {
    // Best-effort: swallow errors so the activity log never breaks operations
    // (matches the sync behavior).
  }

  return fullEntry;
}

/**
 * FNXC:TaskStoreAudit 2026-06-24-09:15:
 * Query the activity log with optional filtering by timestamp range and type.
 * This is the async equivalent of `getActivityLog`. Ordered by timestamp DESC
 * (newest first), with an optional limit.
 *
 * @param db The Drizzle instance.
 * @param options Optional filter (since, type, limit).
 * @returns The matching activity entries.
 */
export async function getActivityLog(
  db: AsyncDataLayer["db"] | DbTransaction,
  options?: { limit?: number; since?: string; type?: ActivityEventType },
): Promise<ActivityLogEntry[]> {
  const conditions = [];
  if (options?.since) {
    conditions.push(gte(schema.project.activityLog.timestamp, options.since));
  }
  if (options?.type) {
    conditions.push(eq(schema.project.activityLog.type, options.type));
  }

  // FNXC:TaskStoreAudit 2026-06-26-10:15:
  // Apply LIMIT in SQL, not JS (same fix as getRunAuditEvents). `activity_log`
  // has no rotation, so the previous in-memory `.slice()` pulled the entire
  // matching set over the wire on every call.
  const baseQuery = db
    .select()
    .from(schema.project.activityLog)
    .orderBy(desc(schema.project.activityLog.timestamp));
  const filtered =
    conditions.length > 0 ? baseQuery.where(and(...conditions)) : baseQuery;
  const limited =
    options?.limit && options.limit > 0 ? filtered.limit(options.limit) : filtered;
  const rows = (await limited) as ActivityLogRow[];
  return rows.map((row) => rowToActivityLogEntry(row));
}

/**
 * FNXC:TaskStoreAudit 2026-06-24-09:20:
 * Aggregate task:moved events by day, optionally filtered by from/to column.
 * This is the async equivalent of `getTaskMovedCountsByDay`. The day is
 * extracted from the ISO timestamp via `substr(timestamp, 1, 10)` (the date
 * portion). The from/to columns are extracted from the jsonb `metadata` via
 * the `->>` operator.
 *
 * @param db The Drizzle instance.
 * @param options The time window (since, until) and optional column filters.
 * @returns A map of day (YYYY-MM-DD) → count.
 */
export async function getTaskMovedCountsByDay(
  db: AsyncDataLayer["db"] | DbTransaction,
  options: { since: string; until: string; fromColumn?: string; toColumn?: string },
): Promise<Record<string, number>> {
  const conditions = [
    eq(schema.project.activityLog.type, "task:moved"),
    gte(schema.project.activityLog.timestamp, options.since),
    lte(schema.project.activityLog.timestamp, options.until),
  ];
  if (options.fromColumn) {
    conditions.push(
      sql`${schema.project.activityLog.metadata}->>'from' = ${options.fromColumn}`,
    );
  }
  if (options.toColumn) {
    conditions.push(
      sql`${schema.project.activityLog.metadata}->>'to' = ${options.toColumn}`,
    );
  }

  const rows = await db
    .select({
      day: sql<string>`substr(${schema.project.activityLog.timestamp}, 1, 10)`,
      value: count(),
    })
    .from(schema.project.activityLog)
    .where(and(...conditions))
    .groupBy(sql`substr(${schema.project.activityLog.timestamp}, 1, 10)`);

  const countsByDay: Record<string, number> = {};
  for (const row of rows) {
    countsByDay[row.day] = Number(row.value);
  }
  return countsByDay;
}
