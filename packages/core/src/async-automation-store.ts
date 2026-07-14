/**
 * Async Drizzle AutomationStore helpers (U6 satellite-fusiondir-stores).
 *
 * FNXC:AutomationStore 2026-06-24-12:00:
 * Async equivalents of the sync SQLite AutomationStore call sites in
 * automation-store.ts. AutomationStore is a fusion-dir-owned satellite store:
 * it takes a `rootDir`, constructs its own `new Database(rootDir/.fusion)`
 * internally, and uses `db.prepare(sql).get/run/all()` + `db.bumpLastModified()`.
 * These helpers target the PostgreSQL `project.automations` table via Drizzle
 * and preserve the create/read/update/delete, run-tracking, and due-query
 * semantics.
 *
 * SQLite → PostgreSQL notes (VAL-SCHEMA-004):
 *   - The boolean `enabled` column is kept as integer (0/1) in PostgreSQL
 *     (per _shared.ts: "kept as integer to preserve exact behavior"), so
 *     `row.enabled === 1` checks still work.
 *   - The `steps`, `lastRunResult`, and `runHistory` columns are `jsonb` in
 *     PostgreSQL, so Drizzle returns them already-parsed as JS values. On
 *     write, pass the JS value directly (Drizzle serializes it). There are no
 *     text-serialized JSON columns on this table.
 *   - The SQLite `INSERT OR REPLACE` upsert maps to Drizzle
 *     `insert().onConflictDoUpdate()` on the primary key.
 *
 * Transition context (see library/satellite-store-migration-pattern.md):
 *   `getDatabase()` still returns the sync `Database` until the coordinated
 *   `getDatabase()` flip. The sync AutomationStore keeps its sync path (the
 *   gate depends on it). These helpers are the async target the PostgreSQL
 *   integration tests consume. They program against the stable
 *   `AsyncDataLayer` interface (U4), not the underlying driver.
 */
import { and, asc, eq, lte, sql } from "drizzle-orm";
import * as schema from "./postgres/schema/index.js";
import type { AsyncDataLayer } from "./postgres/data-layer.js";
import type {
  ScheduledTask,
  ScheduledTaskCreateInput,
  ScheduledTaskUpdateInput,
  AutomationRunResult,
  ScheduleType,
} from "./automation.js";

/** The bound project context required by every automation query. */
type AutomationDataLayer = Pick<AsyncDataLayer, "db" | "projectId">;

/*
 * FNXC:AutomationIsolation 2026-07-13-22:37:
 * The embedded PostgreSQL cluster stores every project's automations in one physical table. Normalize an undefined binding to the empty legacy partition while ensuring every CRUD and due-run operation filters one and only one project partition. Global automations remain global execution-lane entries owned by their creating project, matching the former per-project SQLite file semantics; they are never cross-project rows.
 */
function automationProjectId(layer: AutomationDataLayer): string {
  return layer.projectId ?? "";
}

function automationProjectScope(layer: AutomationDataLayer) {
  return eq(schema.project.automations.projectId, automationProjectId(layer));
}

/** Row shape for automations (camelCase column aliases via Drizzle). */
interface AutomationRow {
  id: string;
  name: string;
  description: string | null;
  scheduleType: string;
  cronExpression: string;
  command: string;
  enabled: number | null;
  timeoutMs: number | null;
  steps: unknown;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastRunResult: unknown;
  runCount: number | null;
  runHistory: unknown;
  scope: string | null;
  createdAt: string;
  updatedAt: string;
}

const automationColumns = {
  id: schema.project.automations.id,
  name: schema.project.automations.name,
  description: schema.project.automations.description,
  scheduleType: schema.project.automations.scheduleType,
  cronExpression: schema.project.automations.cronExpression,
  command: schema.project.automations.command,
  enabled: schema.project.automations.enabled,
  timeoutMs: schema.project.automations.timeoutMs,
  steps: schema.project.automations.steps,
  nextRunAt: schema.project.automations.nextRunAt,
  lastRunAt: schema.project.automations.lastRunAt,
  lastRunResult: schema.project.automations.lastRunResult,
  runCount: schema.project.automations.runCount,
  runHistory: schema.project.automations.runHistory,
  scope: schema.project.automations.scope,
  createdAt: schema.project.automations.createdAt,
  updatedAt: schema.project.automations.updatedAt,
};

function rowToSchedule(row: AutomationRow): ScheduledTask {
  return {
    id: row.id,
    name: row.name,
    description: row.description || undefined,
    scheduleType: row.scheduleType as ScheduleType,
    cronExpression: row.cronExpression,
    command: row.command,
    enabled: (row.enabled ?? 1) === 1,
    timeoutMs: row.timeoutMs ?? undefined,
    steps: (row.steps as ScheduledTask["steps"]) ?? undefined,
    nextRunAt: row.nextRunAt || undefined,
    lastRunAt: row.lastRunAt || undefined,
    lastRunResult: (row.lastRunResult as AutomationRunResult | null) ?? undefined,
    runCount: row.runCount ?? 0,
    runHistory: (row.runHistory as AutomationRunResult[] | null) ?? [],
    scope: (row.scope as "global" | "project") || "project",
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * FNXC:AutomationStore 2026-06-24-12:05:
 * Upsert (INSERT OR REPLACE equivalent) a schedule row. Used by create and
 * every persistence path (update, recordRun). Non-destructive on the primary
 * key: an existing row is updated in place.
 */
export async function upsertSchedule(layer: AutomationDataLayer, schedule: ScheduledTask): Promise<void> {
  await layer.db
    .insert(schema.project.automations)
    .values({
      projectId: automationProjectId(layer),
      id: schedule.id,
      name: schedule.name,
      description: schedule.description ?? null,
      scheduleType: schedule.scheduleType,
      cronExpression: schedule.cronExpression,
      command: schedule.command,
      enabled: schedule.enabled ? 1 : 0,
      timeoutMs: schedule.timeoutMs ?? null,
      steps: schedule.steps ?? null,
      nextRunAt: schedule.nextRunAt ?? null,
      lastRunAt: schedule.lastRunAt ?? null,
      lastRunResult: schedule.lastRunResult ?? null,
      runCount: schedule.runCount ?? 0,
      runHistory: schedule.runHistory ?? [],
      scope: schedule.scope ?? "project",
      createdAt: schedule.createdAt,
      updatedAt: schedule.updatedAt,
    })
    .onConflictDoUpdate({
      target: [schema.project.automations.projectId, schema.project.automations.id],
      set: {
        name: schedule.name,
        description: schedule.description ?? null,
        scheduleType: schedule.scheduleType,
        cronExpression: schedule.cronExpression,
        command: schedule.command,
        enabled: schedule.enabled ? 1 : 0,
        timeoutMs: schedule.timeoutMs ?? null,
        steps: schedule.steps ?? null,
        nextRunAt: schedule.nextRunAt ?? null,
        lastRunAt: schedule.lastRunAt ?? null,
        lastRunResult: schedule.lastRunResult ?? null,
        runCount: schedule.runCount ?? 0,
        runHistory: schedule.runHistory ?? [],
        scope: schedule.scope ?? "project",
        updatedAt: schedule.updatedAt,
      },
    });
}

/**
 * FNXC:AutomationStore 2026-06-24-12:10:
 * Create a schedule (non-destructive INSERT, VAL-DATA-009). Caller is
 * responsible for computing cronExpression/nextRunAt before calling.
 */
export async function createScheduleRow(
  layer: AutomationDataLayer,
  schedule: ScheduledTask,
): Promise<ScheduledTask> {
  await upsertSchedule(layer, schedule);
  return schedule;
}

/**
 * Get a single schedule by id. Throws ENOENT if not found (matches sync shape).
 */
export async function getSchedule(layer: AutomationDataLayer, id: string): Promise<ScheduledTask> {
  const rows = await layer.db
    .select(automationColumns)
    .from(schema.project.automations)
    .where(and(automationProjectScope(layer), eq(schema.project.automations.id, id)));
  const row = rows[0];
  if (!row) {
    throw Object.assign(new Error(`Schedule '${id}' not found`), { code: "ENOENT" });
  }
  return rowToSchedule(row as AutomationRow);
}

/**
 * Get a single schedule by id, or undefined if not found.
 */
export async function findSchedule(
  layer: AutomationDataLayer,
  id: string,
): Promise<ScheduledTask | undefined> {
  const rows = await layer.db
    .select(automationColumns)
    .from(schema.project.automations)
    .where(and(automationProjectScope(layer), eq(schema.project.automations.id, id)));
  return rows[0] ? rowToSchedule(rows[0] as AutomationRow) : undefined;
}

/**
 * List all schedules ordered by createdAt ASC.
 */
export async function listSchedules(layer: AutomationDataLayer): Promise<ScheduledTask[]> {
  const rows = await layer.db
    .select(automationColumns)
    .from(schema.project.automations)
    .where(automationProjectScope(layer))
    .orderBy(asc(schema.project.automations.createdAt), asc(schema.project.automations.id));
  return rows.map((row) => rowToSchedule(row as AutomationRow));
}

/**
 * FNXC:AutomationStore 2026-06-24-12:15:
 * Delete a schedule by id. Returns true if a row was deleted.
 */
export async function deleteSchedule(layer: AutomationDataLayer, id: string): Promise<boolean> {
  const result = await layer.db
    .delete(schema.project.automations)
    .where(and(automationProjectScope(layer), eq(schema.project.automations.id, id)))
    .returning({ id: schema.project.automations.id });
  return result.length > 0;
}

/**
 * FNXC:AutomationStore 2026-06-24-12:20:
 * Get all schedules that are due to run (nextRunAt <= now and enabled),
 * optionally filtered by scope.
 */
export async function getDueSchedules(
  layer: AutomationDataLayer,
  nowIso: string,
  scope?: "global" | "project",
): Promise<ScheduledTask[]> {
  const conditions = [
    automationProjectScope(layer),
    eq(schema.project.automations.enabled, 1),
    sql`${schema.project.automations.nextRunAt} IS NOT NULL`,
    lte(schema.project.automations.nextRunAt, nowIso),
  ];
  if (scope !== undefined) {
    conditions.push(eq(schema.project.automations.scope, scope));
  }
  const rows = await layer.db
    .select(automationColumns)
    .from(schema.project.automations)
    .where(and(...conditions));
  return rows.map((row) => rowToSchedule(row as AutomationRow));
}

/**
 * Atomically advance one due occurrence inside the caller's project partition.
 */
export async function claimDueSchedule(
  layer: AutomationDataLayer,
  id: string,
  expectedNextRunAt: string,
  nextRunAt: string,
  updatedAt: string,
): Promise<boolean> {
  const rows = await layer.db
    .update(schema.project.automations)
    .set({ nextRunAt, updatedAt })
    .where(and(
      automationProjectScope(layer),
      eq(schema.project.automations.id, id),
      eq(schema.project.automations.enabled, 1),
      eq(schema.project.automations.nextRunAt, expectedNextRunAt),
    ))
    .returning({ id: schema.project.automations.id });
  return rows.length === 1;
}

// Re-export the input types for callers constructing schedules via the helper.
export type { ScheduledTaskCreateInput, ScheduledTaskUpdateInput, AutomationRunResult };
