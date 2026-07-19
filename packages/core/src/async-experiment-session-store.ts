/**
 * Async Drizzle ExperimentSessionStore helpers (U6 satellite-db-injected-stores).
 *
 * FNXC:ExperimentSessionStore 2026-06-24-08:05:
 * Async equivalents of the sync SQLite ExperimentSessionStore call sites in
 * experiment-session-store.ts. These helpers target the PostgreSQL
 * `project.experiment_sessions` and `project.experiment_session_records`
 * tables via Drizzle.
 *
 * SQLite → PostgreSQL notes (VAL-SCHEMA-004):
 *   All JSON columns (metric, keptRunIds, tags, metadata, payload) are jsonb
 *   in PostgreSQL, so Drizzle returns them already-parsed as JS values.
 *
 * Transition context (see library/satellite-store-migration-pattern.md):
 *   `getDatabase()` still returns the sync `Database` until the coordinated
 *   flip. These helpers are the async target the PostgreSQL integration tests
 *   consume.
 */
import { and, asc, desc, eq, sql } from "drizzle-orm";
import * as schema from "./postgres/schema/index.js";
import { projectOwnershipPartition, type AsyncDataLayer, type DbTransaction } from "./postgres/data-layer.js";
import type {
  ExperimentSession,
  ExperimentSessionListOptions,
  ExperimentSessionRecord,
  ExperimentSessionStatus,
  ExperimentRecordType,
} from "./experiment-session-types.js";

/** A query-capable handle: either the top-level db or a transaction handle. */
type QueryHandle = AsyncDataLayer["db"] | DbTransaction;

function rowToSession(row: Record<string, unknown>): ExperimentSession {
  const metricRaw = typeof row.metric === "string" ? JSON.parse(row.metric) : row.metric;
  return {
    id: row.id as string,
    name: row.name as string,
    // FNXC:MultiProjectIsolation 2026-07-15-23:40: the domain projectId now maps to owner_project_id; project_id is the trigger/GUC-owned RLS partition (migration 0011).
    projectId: (row.ownerProjectId as string | null) ?? undefined,
    status: row.status as ExperimentSessionStatus,
    metric: (metricRaw as ExperimentSession["metric"]) ?? { name: "unknown", direction: "maximize" },
    currentSegment: Number(row.currentSegment ?? 1),
    maxIterations: (row.maxIterations as number | null) ?? undefined,
    workingDir: (row.workingDir as string | null) ?? undefined,
    baselineRunId: (row.baselineRunId as string | null) ?? undefined,
    bestRunId: (row.bestRunId as string | null) ?? undefined,
    keptRunIds: (row.keptRunIds as string[]) ?? [],
    tags: (row.tags as string[]) ?? [],
    metadata: row.metadata as ExperimentSession["metadata"],
    createdAt: row.createdAt as string,
    updatedAt: row.updatedAt as string,
    finalizedAt: (row.finalizedAt as string | null) ?? undefined,
  };
}

function rowToRecord(row: Record<string, unknown>): ExperimentSessionRecord {
  return {
    id: row.id as string,
    sessionId: row.sessionId as string,
    segment: Number(row.segment),
    seq: Number(row.seq),
    type: row.type as ExperimentSessionRecord["type"],
    payload: (row.payload as ExperimentSessionRecord["payload"]) ?? {},
    createdAt: row.createdAt as string,
  } as ExperimentSessionRecord;
}

/**
 * Create an experiment session.
 */
export async function createExperimentSession(
  handle: QueryHandle,
  session: ExperimentSession,
): Promise<ExperimentSession> {
  await handle.insert(schema.project.experimentSessions).values({
    id: session.id,
    name: session.name,
    // FNXC:MultiProjectIsolation 2026-07-15-23:40: domain project goes to owner_project_id; project_id (the RLS partition) is owned by the fusion_assign_project_id trigger/GUC.
    ownerProjectId: session.projectId ?? null,
    status: session.status,
    metric: JSON.stringify(session.metric),
    currentSegment: session.currentSegment,
    maxIterations: session.maxIterations ?? null,
    workingDir: session.workingDir ?? null,
    baselineRunId: session.baselineRunId ?? null,
    bestRunId: session.bestRunId ?? null,
    keptRunIds: session.keptRunIds,
    tags: session.tags,
    metadata: session.metadata ?? null,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    finalizedAt: session.finalizedAt ?? null,
  });
  return session;
}

/**
 * Get a single experiment session by id.
 */
export async function getExperimentSession(handle: QueryHandle, id: string): Promise<ExperimentSession | undefined> {
  const rows = await handle
    .select()
    .from(schema.project.experimentSessions)
    .where(eq(schema.project.experimentSessions.id, id));
  return rows[0] ? rowToSession(rows[0]) : undefined;
}

/**
 * List experiment sessions with optional filters.
 */
export async function listExperimentSessions(handle: QueryHandle, options: ExperimentSessionListOptions = {}): Promise<ExperimentSession[]> {
  const conditions: ReturnType<typeof eq>[] = [];
  if (options.status) conditions.push(eq(schema.project.experimentSessions.status, options.status));
  if (options.projectId) conditions.push(eq(schema.project.experimentSessions.ownerProjectId, options.projectId));
  const query = handle
    .select()
    .from(schema.project.experimentSessions)
    .orderBy(desc(schema.project.experimentSessions.createdAt));
  const rows = conditions.length > 0 ? await query.where(and(...conditions)) : await query;
  return rows.map(rowToSession);
}

/**
 * Persist (update) an experiment session's mutable fields.
 */
export async function persistExperimentSession(handle: QueryHandle, session: ExperimentSession): Promise<void> {
  await handle
    .update(schema.project.experimentSessions)
    .set({
      name: session.name,
      ownerProjectId: session.projectId ?? null,
      status: session.status,
      metric: JSON.stringify(session.metric),
      currentSegment: session.currentSegment,
      maxIterations: session.maxIterations ?? null,
      workingDir: session.workingDir ?? null,
      baselineRunId: session.baselineRunId ?? null,
      bestRunId: session.bestRunId ?? null,
      keptRunIds: session.keptRunIds,
      tags: session.tags,
      metadata: session.metadata ?? null,
      updatedAt: session.updatedAt,
      finalizedAt: session.finalizedAt ?? null,
    })
    .where(eq(schema.project.experimentSessions.id, session.id));
}

/**
 * Delete an experiment session by id. Returns true if a row was deleted.
 */
export async function deleteExperimentSession(handle: QueryHandle, id: string): Promise<boolean> {
  const result = await handle
    .delete(schema.project.experimentSessions)
    .where(eq(schema.project.experimentSessions.id, id))
    .returning({ id: schema.project.experimentSessions.id });
  return result.length > 0;
}

/**
 * FNXC:ExperimentSessionStore 2026-06-24-08:10:
 * Append a record to a session with an auto-incrementing seq inside a
 * transaction.
 */
export async function appendExperimentRecord(
  layer: AsyncDataLayer,
  input: { id: string; sessionId: string; segment: number; type: ExperimentRecordType; payload: Record<string, unknown> },
): Promise<ExperimentSessionRecord> {
  return layer.transactionImmediate(async (tx) => {
    const parentRows = await tx
      .select({ projectId: schema.project.experimentSessions.projectId })
      .from(schema.project.experimentSessions)
      .where(eq(schema.project.experimentSessions.id, input.sessionId))
      .limit(1);
    const ownership = projectOwnershipPartition(parentRows[0]?.projectId ?? layer.projectId);
    const seqRows = await tx
      .select({ nextSeq: sql<number>`coalesce(max(${schema.project.experimentSessionRecords.seq}), 0) + 1` })
      .from(schema.project.experimentSessionRecords)
      .where(and(
        eq(schema.project.experimentSessionRecords.projectId, ownership),
        eq(schema.project.experimentSessionRecords.sessionId, input.sessionId),
      ));
    const seq = seqRows[0]?.nextSeq ?? 1;
    const createdAt = new Date().toISOString();
    await tx.insert(schema.project.experimentSessionRecords).values({
      projectId: ownership,
      id: input.id,
      sessionId: input.sessionId,
      segment: input.segment,
      seq,
      type: input.type,
      payload: input.payload,
      createdAt,
    });
    return {
      id: input.id,
      sessionId: input.sessionId,
      segment: input.segment,
      seq,
      type: input.type,
      payload: input.payload,
      createdAt,
    } as unknown as ExperimentSessionRecord;
  });
}

/**
 * Get a single experiment record by id.
 */
export async function getExperimentRecord(handle: QueryHandle, id: string): Promise<ExperimentSessionRecord | undefined> {
  const rows = await handle
    .select()
    .from(schema.project.experimentSessionRecords)
    .where(eq(schema.project.experimentSessionRecords.id, id));
  return rows[0] ? rowToRecord(rows[0]) : undefined;
}

/**
 * List experiment records for a session.
 */
export async function listExperimentRecords(
  handle: QueryHandle,
  sessionId: string,
  opts: { segment?: number; type?: ExperimentRecordType } = {},
): Promise<ExperimentSessionRecord[]> {
  const conditions = [eq(schema.project.experimentSessionRecords.sessionId, sessionId)];
  if (opts.segment !== undefined) conditions.push(eq(schema.project.experimentSessionRecords.segment, opts.segment));
  if (opts.type) conditions.push(eq(schema.project.experimentSessionRecords.type, opts.type));
  const rows = await handle
    .select()
    .from(schema.project.experimentSessionRecords)
    .where(and(...conditions))
    .orderBy(asc(schema.project.experimentSessionRecords.seq));
  return rows.map(rowToRecord);
}
