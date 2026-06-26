/**
 * Async Drizzle ResearchStore helpers (U6 satellite-db-injected-stores).
 *
 * FNXC:ResearchStore 2026-06-24-08:40:
 * Async equivalents of the sync SQLite ResearchStore call sites in
 * research-store.ts. These helpers target the PostgreSQL
 * `project.research_runs`, `project.research_run_events`, and
 * `project.research_exports` tables via Drizzle.
 *
 * SQLite → PostgreSQL notes (VAL-SCHEMA-004):
 *   All JSON columns (providerConfig, sources, events, results, tokenUsage,
 *   tags, metadata, lifecycle) are jsonb in PostgreSQL, so Drizzle returns
 *   them already-parsed as JS values.
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
  ResearchEvent,
  ResearchExport,
  ResearchExportFormat,
  ResearchResult,
  ResearchRun,
  ResearchRunStatus,
  ResearchSource,
} from "./research-types.js";

/** A query-capable handle: either the top-level db or a transaction handle. */
type QueryHandle = AsyncDataLayer["db"] | DbTransaction;

function normalizeStatus(status: ResearchRunStatus | "pending"): ResearchRunStatus {
  return status === "pending" ? "queued" : status;
}

function rowToRun(row: Record<string, unknown>): ResearchRun {
  return {
    id: row.id as string,
    query: row.query as string,
    topic: (row.topic as string | null) ?? undefined,
    status: normalizeStatus((row.status as ResearchRunStatus | "pending") ?? "queued"),
    projectId: (row.projectId as string | null) ?? undefined,
    trigger: (row.trigger as string | null) ?? undefined,
    providerConfig: row.providerConfig as ResearchRun["providerConfig"],
    sources: (row.sources as ResearchSource[]) ?? [],
    events: (row.events as ResearchEvent[]) ?? [],
    results: row.results as ResearchResult | undefined,
    error: (row.error as string | null) ?? undefined,
    tokenUsage: row.tokenUsage as ResearchRun["tokenUsage"],
    tags: (row.tags as string[]) ?? [],
    metadata: row.metadata as ResearchRun["metadata"],
    lifecycle: row.lifecycle as ResearchRun["lifecycle"],
    createdAt: row.createdAt as string,
    updatedAt: row.updatedAt as string,
    startedAt: (row.startedAt as string | null) ?? undefined,
    completedAt: (row.completedAt as string | null) ?? undefined,
    cancelledAt: (row.cancelledAt as string | null) ?? undefined,
  };
}

function rowToExport(row: Record<string, unknown>): ResearchExport {
  return {
    id: row.id as string,
    runId: row.runId as string,
    format: row.format as ResearchExportFormat,
    content: row.content as string,
    filePath: (row.filePath as string | null) ?? undefined,
    createdAt: row.createdAt as string,
  };
}

/**
 * Create a research run.
 */
export async function createResearchRun(
  handle: QueryHandle,
  run: ResearchRun,
): Promise<ResearchRun> {
  await handle.insert(schema.project.researchRuns).values({
    id: run.id,
    query: run.query,
    topic: run.topic ?? null,
    status: run.status,
    projectId: run.projectId ?? null,
    trigger: run.trigger ?? null,
    providerConfig: run.providerConfig ?? null,
    sources: run.sources,
    events: run.events,
    results: run.results ?? null,
    error: run.error ?? null,
    tokenUsage: run.tokenUsage ?? null,
    tags: run.tags,
    metadata: run.metadata ?? null,
    lifecycle: run.lifecycle ?? null,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    startedAt: run.startedAt ?? null,
    completedAt: run.completedAt ?? null,
    cancelledAt: run.cancelledAt ?? null,
  });
  return run;
}

/**
 * Get a single research run by id.
 */
export async function getResearchRun(handle: QueryHandle, id: string): Promise<ResearchRun | undefined> {
  const rows = await handle
    .select()
    .from(schema.project.researchRuns)
    .where(eq(schema.project.researchRuns.id, id));
  return rows[0] ? rowToRun(rows[0]) : undefined;
}

/**
 * FNXC:ResearchStore 2026-06-24-08:45:
 * Persist (update) a research run's mutable fields.
 */
export async function persistResearchRun(handle: QueryHandle, run: ResearchRun): Promise<void> {
  await handle
    .update(schema.project.researchRuns)
    .set({
      query: run.query,
      topic: run.topic ?? null,
      status: run.status,
      projectId: run.projectId ?? null,
      trigger: run.trigger ?? null,
      providerConfig: run.providerConfig ?? null,
      sources: run.sources,
      events: run.events,
      results: run.results ?? null,
      error: run.error ?? null,
      tokenUsage: run.tokenUsage ?? null,
      tags: run.tags,
      metadata: run.metadata ?? null,
      lifecycle: run.lifecycle ?? null,
      updatedAt: run.updatedAt,
      startedAt: run.startedAt ?? null,
      completedAt: run.completedAt ?? null,
      cancelledAt: run.cancelledAt ?? null,
    })
    .where(eq(schema.project.researchRuns.id, run.id));
}

/**
 * FNXC:ResearchStore 2026-06-24-08:50:
 * Append a run event with auto-incrementing seq inside a transaction.
 */
export async function appendResearchRunEvent(
  layer: AsyncDataLayer,
  input: { id: string; runId: string; type: string; message: string; status?: ResearchRunStatus | null; classification?: string | null; metadata?: Record<string, unknown> | null },
): Promise<void> {
  await layer.transactionImmediate(async (tx) => {
    const seqRows = await tx
      .select({ nextSeq: sql<number>`coalesce(max(${schema.project.researchRunEvents.seq}), 0) + 1` })
      .from(schema.project.researchRunEvents)
      .where(eq(schema.project.researchRunEvents.runId, input.runId));
    const seq = seqRows[0]?.nextSeq ?? 1;
    const createdAt = new Date().toISOString();
    await tx.insert(schema.project.researchRunEvents).values({
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

/**
 * List research run events ordered by seq ASC.
 */
export async function listResearchRunEvents(handle: QueryHandle, runId: string): Promise<Record<string, unknown>[]> {
  return handle
    .select()
    .from(schema.project.researchRunEvents)
    .where(eq(schema.project.researchRunEvents.runId, runId))
    .orderBy(asc(schema.project.researchRunEvents.seq));
}

/**
 * Create a research export.
 */
export async function createResearchExport(
  handle: QueryHandle,
  input: { id: string; runId: string; format: ResearchExportFormat; content: string; createdAt: string },
): Promise<ResearchExport> {
  await handle.insert(schema.project.researchExports).values({
    id: input.id,
    runId: input.runId,
    format: input.format,
    content: input.content,
    filePath: null,
    createdAt: input.createdAt,
  });
  return {
    id: input.id,
    runId: input.runId,
    format: input.format,
    content: input.content,
    filePath: undefined,
    createdAt: input.createdAt,
  };
}

/**
 * Get research exports for a run.
 */
export async function getResearchExports(handle: QueryHandle, runId: string): Promise<ResearchExport[]> {
  const rows = await handle
    .select()
    .from(schema.project.researchExports)
    .where(eq(schema.project.researchExports.runId, runId))
    .orderBy(asc(schema.project.researchExports.createdAt), asc(schema.project.researchExports.id));
  return rows.map(rowToExport);
}

/**
 * FNXC:ResearchStore 2026-06-24-08:55:
 * Get the active run for a project + trigger (status in queued/running/etc).
 */
export async function getActiveResearchRun(
  handle: QueryHandle,
  projectId: string,
  trigger: string,
): Promise<ResearchRun | undefined> {
  const rows = await handle
    .select()
    .from(schema.project.researchRuns)
    .where(
      and(
        eq(schema.project.researchRuns.projectId, projectId),
        eq(schema.project.researchRuns.trigger, trigger),
        inArray(schema.project.researchRuns.status, ["queued", "running", "cancelling", "retry_waiting"]),
      ),
    )
    .orderBy(desc(schema.project.researchRuns.createdAt))
    .limit(1);
  return rows[0] ? rowToRun(rows[0]) : undefined;
}

/**
 * Get research run stats (total + byStatus).
 */
export async function getResearchStats(
  handle: QueryHandle,
): Promise<{ total: number; byStatus: Record<ResearchRunStatus, number> }> {
  const rows = await handle
    .select({
      status: schema.project.researchRuns.status,
      count: sql<number>`count(*)::int`,
    })
    .from(schema.project.researchRuns)
    .groupBy(schema.project.researchRuns.status);
  const byStatus: Record<ResearchRunStatus, number> = {
    queued: 0, running: 0, cancelling: 0, retry_waiting: 0,
    completed: 0, failed: 0, cancelled: 0, timed_out: 0, retry_exhausted: 0,
  };
  for (const row of rows) {
    byStatus[row.status as ResearchRunStatus] = row.count;
  }
  const total = Object.values(byStatus).reduce((acc, v) => acc + v, 0);
  return { total, byStatus };
}
