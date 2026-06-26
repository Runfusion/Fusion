/**
 * Async Drizzle InsightStore helpers (U6 satellite-db-injected-stores).
 *
 * FNXC:InsightStore 2026-06-24-08:15:
 * Async equivalents of the sync SQLite InsightStore call sites in
 * insight-store.ts. These helpers target the PostgreSQL
 * `project.project_insights`, `project.project_insight_runs`, and
 * `project.project_insight_run_events` tables via Drizzle.
 *
 * SQLite → PostgreSQL notes (VAL-SCHEMA-004):
 *   The JSON columns (provenance, inputMetadata, outputMetadata, lifecycle,
 *   metadata) are jsonb in PostgreSQL, so Drizzle returns them already-parsed.
 *
 * Transition context (see library/satellite-store-migration-pattern.md):
 *   `getDatabase()` still returns the sync `Database` until the coordinated
 *   flip. These helpers are the async target the PostgreSQL integration tests
 *   consume.
 */
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import * as schema from "./postgres/schema/index.js";
import type { AsyncDataLayer, DbTransaction } from "./postgres/data-layer.js";
import type {
  Insight,
  InsightCategory,
  InsightListOptions,
  InsightProvenance,
  InsightRun,
  InsightRunListOptions,
  InsightRunStatus,
  InsightRunTrigger,
  InsightStatus,
} from "./insight-types.js";

/** A query-capable handle: either the top-level db or a transaction handle. */
type QueryHandle = AsyncDataLayer["db"] | DbTransaction;

function rowToInsight(row: Record<string, unknown>): Insight {
  return {
    id: row.id as string,
    projectId: row.projectId as string,
    title: row.title as string,
    content: (row.content as string | null) ?? null,
    category: row.category as InsightCategory,
    status: row.status as InsightStatus,
    fingerprint: row.fingerprint as string,
    provenance: (row.provenance as InsightProvenance) ?? { trigger: "unknown" },
    lastRunId: (row.lastRunId as string | null) ?? null,
    createdAt: row.createdAt as string,
    updatedAt: row.updatedAt as string,
  };
}

function rowToRun(row: Record<string, unknown>): InsightRun {
  return {
    id: row.id as string,
    projectId: row.projectId as string,
    trigger: row.trigger as InsightRunTrigger,
    status: row.status as InsightRunStatus,
    summary: (row.summary as string | null) ?? null,
    error: (row.error as string | null) ?? null,
    insightsCreated: (row.insightsCreated as number) ?? 0,
    insightsUpdated: (row.insightsUpdated as number) ?? 0,
    inputMetadata: (row.inputMetadata as InsightRun["inputMetadata"]) ?? {},
    outputMetadata: (row.outputMetadata as InsightRun["outputMetadata"]) ?? {},
    createdAt: row.createdAt as string,
    startedAt: (row.startedAt as string | null) ?? null,
    completedAt: (row.completedAt as string | null) ?? null,
    cancelledAt: (row.cancelledAt as string | null) ?? null,
    lifecycle: (row.lifecycle as InsightRun["lifecycle"]) ?? {},
  };
}

// ── Insight CRUD ──

/**
 * Create a new insight.
 */
export async function createInsight(
  handle: QueryHandle,
  insight: Insight,
): Promise<void> {
  await handle.insert(schema.project.projectInsights).values({
    id: insight.id,
    projectId: insight.projectId,
    title: insight.title,
    content: insight.content ?? null,
    category: insight.category,
    status: insight.status,
    fingerprint: insight.fingerprint,
    provenance: insight.provenance,
    lastRunId: insight.lastRunId,
    createdAt: insight.createdAt,
    updatedAt: insight.updatedAt,
  });
}

/**
 * Get a single insight by id.
 */
export async function getInsight(handle: QueryHandle, id: string): Promise<Insight | undefined> {
  const rows = await handle
    .select()
    .from(schema.project.projectInsights)
    .where(eq(schema.project.projectInsights.id, id));
  return rows[0] ? rowToInsight(rows[0]) : undefined;
}

/**
 * FNXC:InsightStore 2026-06-24-08:20:
 * List insights with optional filtering. Ordered by createdAt ASC, id ASC.
 */
export async function listInsights(handle: QueryHandle, options: InsightListOptions = {}): Promise<Insight[]> {
  const conditions: ReturnType<typeof eq>[] = [];
  if (options.projectId !== undefined) conditions.push(eq(schema.project.projectInsights.projectId, options.projectId));
  if (options.category !== undefined) conditions.push(eq(schema.project.projectInsights.category, options.category));
  if (options.status !== undefined) conditions.push(eq(schema.project.projectInsights.status, options.status));
  if (options.runId !== undefined) conditions.push(eq(schema.project.projectInsights.lastRunId, options.runId));
  const query = handle
    .select()
    .from(schema.project.projectInsights)
    .orderBy(asc(schema.project.projectInsights.createdAt), asc(schema.project.projectInsights.id));
  const rows = conditions.length > 0 ? await query.where(and(...conditions)) : await query;
  return rows.map(rowToInsight);
}

/**
 * FNXC:InsightStore 2026-06-24-08:25:
 * Upsert an insight by (projectId, fingerprint). When a fingerprint match is
 * found, update mutable fields and preserve the original id/createdAt.
 */
export async function upsertInsight(
  handle: QueryHandle,
  projectId: string,
  input: { id: string; title: string; content?: string | null; category: InsightCategory; status: InsightStatus; fingerprint: string; provenance?: InsightProvenance },
): Promise<Insight> {
  const existingRows = await handle
    .select()
    .from(schema.project.projectInsights)
    .where(
      and(
        eq(schema.project.projectInsights.projectId, projectId),
        eq(schema.project.projectInsights.fingerprint, input.fingerprint),
      ),
    );
  const now = new Date().toISOString();
  if (existingRows.length > 0) {
    const existing = rowToInsight(existingRows[0]!);
    await handle
      .update(schema.project.projectInsights)
      .set({
        title: input.title,
        content: input.content ?? null,
        category: input.category,
        status: input.status,
        provenance: input.provenance,
        updatedAt: now,
      })
      .where(eq(schema.project.projectInsights.id, existing.id));
    return (await getInsight(handle, existing.id))!;
  }
  const insight: Insight = {
    id: input.id,
    projectId,
    title: input.title,
    content: input.content ?? null,
    category: input.category,
    status: input.status,
    fingerprint: input.fingerprint,
    provenance: input.provenance ?? { trigger: "unknown" },
    lastRunId: null,
    createdAt: now,
    updatedAt: now,
  };
  await createInsight(handle, insight);
  return insight;
}

/**
 * Delete an insight by id. Returns true if deleted.
 */
export async function deleteInsight(handle: QueryHandle, id: string): Promise<boolean> {
  const result = await handle
    .delete(schema.project.projectInsights)
    .where(eq(schema.project.projectInsights.id, id))
    .returning({ id: schema.project.projectInsights.id });
  return result.length > 0;
}

// ── Insight Run CRUD ──

/**
 * Create a new insight run.
 */
export async function createInsightRun(
  handle: QueryHandle,
  run: { id: string; projectId: string; trigger: InsightRunTrigger; inputMetadata?: Record<string, unknown>; lifecycle?: Record<string, unknown>; createdAt: string },
): Promise<InsightRun> {
  await handle.insert(schema.project.projectInsightRuns).values({
    id: run.id,
    projectId: run.projectId,
    trigger: run.trigger,
    status: "pending",
    summary: null,
    error: null,
    insightsCreated: 0,
    insightsUpdated: 0,
    inputMetadata: run.inputMetadata ?? null,
    outputMetadata: null,
    lifecycle: run.lifecycle ?? null,
    createdAt: run.createdAt,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
  });
  return {
    id: run.id,
    projectId: run.projectId,
    trigger: run.trigger,
    status: "pending",
    summary: null,
    error: null,
    insightsCreated: 0,
    insightsUpdated: 0,
    inputMetadata: run.inputMetadata ?? {},
    outputMetadata: {},
    createdAt: run.createdAt,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    lifecycle: run.lifecycle ?? {},
  };
}

/**
 * Get a single insight run by id.
 */
export async function getInsightRun(handle: QueryHandle, id: string): Promise<InsightRun | undefined> {
  const rows = await handle
    .select()
    .from(schema.project.projectInsightRuns)
    .where(eq(schema.project.projectInsightRuns.id, id));
  return rows[0] ? rowToRun(rows[0]) : undefined;
}

/**
 * FNXC:InsightStore 2026-06-24-08:30:
 * List insight runs ordered by createdAt DESC, id DESC (newest first).
 */
export async function listInsightRuns(handle: QueryHandle, options: InsightRunListOptions = {}): Promise<InsightRun[]> {
  const conditions: ReturnType<typeof eq>[] = [];
  if (options.projectId !== undefined) conditions.push(eq(schema.project.projectInsightRuns.projectId, options.projectId));
  if (options.status !== undefined) conditions.push(eq(schema.project.projectInsightRuns.status, options.status));
  if (options.trigger !== undefined) conditions.push(eq(schema.project.projectInsightRuns.trigger, options.trigger));
  const query = handle
    .select()
    .from(schema.project.projectInsightRuns)
    .orderBy(desc(schema.project.projectInsightRuns.createdAt), desc(schema.project.projectInsightRuns.id));
  const rows = conditions.length > 0 ? await query.where(and(...conditions)) : await query;
  return rows.map(rowToRun);
}

/**
 * FNXC:InsightStore 2026-06-24-08:35:
 * Find the latest active (pending/running) run for a project + trigger.
 */
export async function findActiveInsightRun(
  handle: QueryHandle,
  projectId: string,
  trigger: InsightRunTrigger,
): Promise<InsightRun | undefined> {
  const rows = await handle
    .select()
    .from(schema.project.projectInsightRuns)
    .where(
      and(
        eq(schema.project.projectInsightRuns.projectId, projectId),
        eq(schema.project.projectInsightRuns.trigger, trigger),
        inArray(schema.project.projectInsightRuns.status, ["pending", "running"]),
      ),
    )
    .orderBy(desc(schema.project.projectInsightRuns.createdAt), desc(schema.project.projectInsightRuns.id))
    .limit(1);
  return rows[0] ? rowToRun(rows[0]) : undefined;
}

/**
 * Append a run event with auto-incrementing seq inside a transaction.
 */
export async function appendInsightRunEvent(
  layer: AsyncDataLayer,
  input: { id: string; runId: string; type: string; message: string; status?: InsightRunStatus; classification?: string; metadata?: Record<string, unknown> },
): Promise<void> {
  await layer.transactionImmediate(async (tx) => {
    const seqRows = await tx
      .select({ nextSeq: sql<number>`coalesce(max(${schema.project.projectInsightRunEvents.seq}), 0) + 1` })
      .from(schema.project.projectInsightRunEvents)
      .where(eq(schema.project.projectInsightRunEvents.runId, input.runId));
    const seq = seqRows[0]?.nextSeq ?? 1;
    const createdAt = new Date().toISOString();
    await tx.insert(schema.project.projectInsightRunEvents).values({
      id: input.id,
      runId: input.runId,
      seq,
      type: input.type,
      message: input.message,
      status: input.status ?? null,
      classification: input.classification ?? null,
      metadata: input.metadata ?? null,
      createdAt,
    });
  });
}
