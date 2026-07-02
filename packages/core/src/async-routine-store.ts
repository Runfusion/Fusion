/**
 * Async Drizzle RoutineStore helpers (U6 satellite-fusiondir-stores).
 *
 * FNXC:RoutineStore 2026-06-24-12:30:
 * Async equivalents of the sync SQLite RoutineStore call sites in
 * routine-store.ts. RoutineStore is a fusion-dir-owned satellite store: it
 * takes a `rootDir`, constructs its own `new Database(rootDir/.fusion)`
 * internally, and uses `db.prepare(sql).get/run/all()` + `db.bumpLastModified()`.
 * These helpers target the PostgreSQL `project.routines` table via Drizzle and
 * preserve the create/read/update/delete, run-tracking, and due-query semantics.
 *
 * SQLite → PostgreSQL notes (VAL-SCHEMA-004):
 *   - The boolean `enabled` column is kept as integer (0/1) in PostgreSQL, so
 *     `row.enabled === 1` checks still work.
 *   - The `triggerConfig`, `steps`, `lastRunResult`, and `runHistory` columns
 *     are `jsonb` in PostgreSQL, so Drizzle returns them already-parsed as JS
 *     values. On write, pass the JS value directly. The sync store
 *     JSON.stringified triggerConfig into a TEXT column; the PostgreSQL schema
 *     stores it as jsonb, so the helper passes the object directly.
 *   - The SQLite `INSERT OR REPLACE` upsert maps to Drizzle
 *     `insert().onConflictDoUpdate()` on the primary key.
 *
 * Transition context (see library/satellite-store-migration-pattern.md):
 *   `getDatabase()` still returns the sync `Database` until the coordinated
 *   flip. The sync RoutineStore keeps its sync path (the gate depends on it).
 *   These helpers are the async target the PostgreSQL integration tests
 *   consume.
 */
import { and, asc, eq, lte, sql } from "drizzle-orm";
import * as schema from "./postgres/schema/index.js";
import type { AsyncDataLayer, DbTransaction } from "./postgres/data-layer.js";
import type {
  Routine,
  RoutineExecutionResult,
} from "./routine.js";

/** A query-capable handle: either the top-level db or a transaction handle. */
type QueryHandle = AsyncDataLayer["db"] | DbTransaction;

/** Row shape for routines (camelCase column aliases via Drizzle). */
interface RoutineRow {
  id: string;
  agentId: string;
  name: string;
  description: string | null;
  triggerType: string;
  triggerConfig: unknown;
  command: string | null;
  steps: unknown;
  timeoutMs: number | null;
  catchUpPolicy: string;
  executionPolicy: string;
  enabled: number | null;
  lastRunAt: string | null;
  lastRunResult: unknown;
  nextRunAt: string | null;
  runCount: number | null;
  runHistory: unknown;
  catchUpLimit: number | null;
  scope: string | null;
  createdAt: string;
  updatedAt: string;
}

const routineColumns = {
  id: schema.project.routines.id,
  agentId: schema.project.routines.agentId,
  name: schema.project.routines.name,
  description: schema.project.routines.description,
  triggerType: schema.project.routines.triggerType,
  triggerConfig: schema.project.routines.triggerConfig,
  command: schema.project.routines.command,
  steps: schema.project.routines.steps,
  timeoutMs: schema.project.routines.timeoutMs,
  catchUpPolicy: schema.project.routines.catchUpPolicy,
  executionPolicy: schema.project.routines.executionPolicy,
  enabled: schema.project.routines.enabled,
  lastRunAt: schema.project.routines.lastRunAt,
  lastRunResult: schema.project.routines.lastRunResult,
  nextRunAt: schema.project.routines.nextRunAt,
  runCount: schema.project.routines.runCount,
  runHistory: schema.project.routines.runHistory,
  catchUpLimit: schema.project.routines.catchUpLimit,
  scope: schema.project.routines.scope,
  createdAt: schema.project.routines.createdAt,
  updatedAt: schema.project.routines.updatedAt,
};

function rowToRoutine(row: RoutineRow, trigger: Routine["trigger"]): Routine {
  return {
    id: row.id,
    agentId: row.agentId || "",
    name: row.name,
    description: row.description || undefined,
    trigger,
    command: row.command || undefined,
    steps: (row.steps as Routine["steps"]) ?? undefined,
    timeoutMs: row.timeoutMs ?? undefined,
    catchUpPolicy: (row.catchUpPolicy as Routine["catchUpPolicy"]) || "run_one",
    executionPolicy: (row.executionPolicy as Routine["executionPolicy"]) || "queue",
    enabled: (row.enabled ?? 1) === 1,
    lastRunAt: row.lastRunAt || undefined,
    lastRunResult: (row.lastRunResult as RoutineExecutionResult | null) ?? undefined,
    nextRunAt: row.nextRunAt || undefined,
    runCount: row.runCount ?? 0,
    runHistory: (row.runHistory as RoutineExecutionResult[] | null) ?? [],
    catchUpLimit: row.catchUpLimit ?? 5,
    cronExpression: trigger.type === "cron" ? trigger.cronExpression : undefined,
    scope: (row.scope as "global" | "project") || "project",
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Reconstruct a Routine trigger from the stored triggerType + triggerConfig.
 * Mirrors the sync RoutineStore.rowToRoutine logic.
 */
export function triggerFromRow(triggerType: string, triggerConfig: unknown): Routine["trigger"] {
  const cfg = (triggerConfig ?? {}) as {
    cronExpression?: string;
    timezone?: string;
    webhookPath?: string;
    secret?: string;
    endpoint?: string;
  };
  switch (triggerType as Routine["trigger"]["type"]) {
    case "cron":
      return {
        type: "cron",
        cronExpression: cfg.cronExpression ?? "0 * * * *",
        timezone: cfg.timezone,
      } as Routine["trigger"] & { type: "cron" };
    case "webhook":
      return {
        type: "webhook",
        webhookPath: cfg.webhookPath ?? "",
        secret: cfg.secret,
      } as Routine["trigger"] & { type: "webhook" };
    case "api":
      return {
        type: "api",
        endpoint: cfg.endpoint ?? "",
      } as Routine["trigger"] & { type: "api" };
    case "manual":
    default:
      return { type: "manual" } as Routine["trigger"] & { type: "manual" };
  }
}

/**
 * Serialize a Routine trigger into the triggerConfig object stored in jsonb.
 */
export function triggerToConfig(trigger: Routine["trigger"]): Record<string, unknown> {
  if (trigger.type === "cron") {
    return { cronExpression: trigger.cronExpression, timezone: trigger.timezone };
  }
  if (trigger.type === "webhook") {
    return { webhookPath: trigger.webhookPath, secret: trigger.secret };
  }
  if (trigger.type === "api") {
    return { endpoint: trigger.endpoint };
  }
  return {};
}

/**
 * FNXC:RoutineStore 2026-06-24-12:35:
 * Upsert (INSERT OR REPLACE equivalent) a routine row. Used by create and
 * every persistence path (update, recordRun, execution bookkeeping).
 */
export async function upsertRoutine(handle: QueryHandle, routine: Routine): Promise<void> {
  const triggerConfig = triggerToConfig(routine.trigger);
  await handle
    .insert(schema.project.routines)
    .values({
      id: routine.id,
      agentId: routine.agentId,
      name: routine.name,
      description: routine.description ?? null,
      triggerType: routine.trigger.type,
      triggerConfig,
      command: routine.command ?? null,
      steps: routine.steps ?? null,
      timeoutMs: routine.timeoutMs ?? null,
      catchUpPolicy: routine.catchUpPolicy,
      executionPolicy: routine.executionPolicy,
      catchUpLimit: routine.catchUpLimit ?? 5,
      enabled: routine.enabled ? 1 : 0,
      lastRunAt: routine.lastRunAt ?? null,
      lastRunResult: routine.lastRunResult ?? null,
      nextRunAt: routine.nextRunAt ?? null,
      runCount: routine.runCount ?? 0,
      runHistory: routine.runHistory ?? [],
      scope: routine.scope ?? "project",
      createdAt: routine.createdAt,
      updatedAt: routine.updatedAt,
    })
    .onConflictDoUpdate({
      target: schema.project.routines.id,
      set: {
        agentId: routine.agentId,
        name: routine.name,
        description: routine.description ?? null,
        triggerType: routine.trigger.type,
        triggerConfig,
        command: routine.command ?? null,
        steps: routine.steps ?? null,
        timeoutMs: routine.timeoutMs ?? null,
        catchUpPolicy: routine.catchUpPolicy,
        executionPolicy: routine.executionPolicy,
        catchUpLimit: routine.catchUpLimit ?? 5,
        enabled: routine.enabled ? 1 : 0,
        lastRunAt: routine.lastRunAt ?? null,
        lastRunResult: routine.lastRunResult ?? null,
        nextRunAt: routine.nextRunAt ?? null,
        runCount: routine.runCount ?? 0,
        runHistory: routine.runHistory ?? [],
        scope: routine.scope ?? "project",
        updatedAt: routine.updatedAt,
      },
    });
}

/**
 * FNXC:RoutineStore 2026-06-24-12:40:
 * Create a routine row (non-destructive INSERT, VAL-DATA-009). Caller is
 * responsible for validation/cron computation before calling.
 */
export async function createRoutineRow(
  handle: QueryHandle,
  routine: Routine,
): Promise<Routine> {
  await upsertRoutine(handle, routine);
  return routine;
}

/**
 * Get a single routine by id. Throws ENOENT if not found (matches sync shape).
 */
export async function getRoutine(handle: QueryHandle, id: string): Promise<Routine> {
  const rows = await handle
    .select(routineColumns)
    .from(schema.project.routines)
    .where(eq(schema.project.routines.id, id));
  const row = rows[0];
  if (!row) {
    throw Object.assign(new Error(`Routine '${id}' not found`), { code: "ENOENT" });
  }
  const typed = row as RoutineRow;
  return rowToRoutine(typed, triggerFromRow(typed.triggerType, typed.triggerConfig));
}

/**
 * Get a single routine by id, or undefined if not found.
 */
export async function findRoutine(
  handle: QueryHandle,
  id: string,
): Promise<Routine | undefined> {
  const rows = await handle
    .select(routineColumns)
    .from(schema.project.routines)
    .where(eq(schema.project.routines.id, id));
  const row = rows[0] as RoutineRow | undefined;
  if (!row) return undefined;
  return rowToRoutine(row, triggerFromRow(row.triggerType, row.triggerConfig));
}

/**
 * List all routines ordered by createdAt ASC.
 */
export async function listRoutines(handle: QueryHandle): Promise<Routine[]> {
  const rows = await handle
    .select(routineColumns)
    .from(schema.project.routines)
    .orderBy(asc(schema.project.routines.createdAt), asc(schema.project.routines.id));
  return rows.map((row) => {
    const typed = row as RoutineRow;
    return rowToRoutine(typed, triggerFromRow(typed.triggerType, typed.triggerConfig));
  });
}

/**
 * FNXC:RoutineStore 2026-06-24-12:45:
 * Delete a routine by id. Returns true if a row was deleted.
 */
export async function deleteRoutine(handle: QueryHandle, id: string): Promise<boolean> {
  const result = await handle
    .delete(schema.project.routines)
    .where(eq(schema.project.routines.id, id))
    .returning({ id: schema.project.routines.id });
  return result.length > 0;
}

/**
 * FNXC:RoutineStore 2026-06-24-12:50:
 * Get all routines that are due to run (nextRunAt <= now and enabled),
 * optionally filtered by scope.
 */
export async function getDueRoutines(
  handle: QueryHandle,
  nowIso: string,
  scope?: "global" | "project",
): Promise<Routine[]> {
  const conditions = [
    eq(schema.project.routines.enabled, 1),
    sql`${schema.project.routines.nextRunAt} IS NOT NULL`,
    lte(schema.project.routines.nextRunAt, nowIso),
  ];
  if (scope !== undefined) {
    conditions.push(eq(schema.project.routines.scope, scope));
  }
  const rows = await handle
    .select(routineColumns)
    .from(schema.project.routines)
    .where(and(...conditions));
  return rows.map((row) => {
    const typed = row as RoutineRow;
    return rowToRoutine(typed, triggerFromRow(typed.triggerType, typed.triggerConfig));
  });
}
