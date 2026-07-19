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
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { and, asc, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import * as schema from "./postgres/schema/index.js";
import { projectOwnershipPartition, type AsyncDataLayer, type DbTransaction } from "./postgres/data-layer.js";
import {
  ResearchLifecycleError,
  TERMINAL_STATUSES,
  VALID_STATUS_TRANSITIONS,
  defaultErrorCodeForFailureClass,
} from "./research-store.js";
import type {
  ResearchEvent,
  ResearchExport,
  ResearchExportFormat,
  ResearchResult,
  ResearchRun,
  ResearchRunCreateInput,
  ResearchRunEvent,
  ResearchRunFailureClass,
  ResearchRunListOptions,
  ResearchRunStatus,
  ResearchRunUpdateInput,
  ResearchSource,
  ResearchStoreEvents,
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
    // FNXC:MultiProjectIsolation 2026-07-15-23:40: the domain projectId now maps to owner_project_id; project_id is the trigger/GUC-owned RLS partition (migration 0011).
    projectId: (row.ownerProjectId as string | null) ?? undefined,
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
    // FNXC:MultiProjectIsolation 2026-07-15-23:40: write the caller's domain project to owner_project_id and never project_id — writing domain data into the partition put parents and children in different partitions and broke the composite FKs (23503).
    ownerProjectId: run.projectId ?? null,
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
      ownerProjectId: run.projectId ?? null,
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
    const parentRows = await tx
      .select({ projectId: schema.project.researchRuns.projectId })
      .from(schema.project.researchRuns)
      .where(eq(schema.project.researchRuns.id, input.runId))
      .limit(1);
    const ownership = projectOwnershipPartition(parentRows[0]?.projectId ?? layer.projectId);
    const seqRows = await tx
      .select({ nextSeq: sql<number>`coalesce(max(${schema.project.researchRunEvents.seq}), 0) + 1` })
      .from(schema.project.researchRunEvents)
      .where(and(
        eq(schema.project.researchRunEvents.projectId, ownership),
        eq(schema.project.researchRunEvents.runId, input.runId),
      ));
    const seq = seqRows[0]?.nextSeq ?? 1;
    const createdAt = new Date().toISOString();
    await tx.insert(schema.project.researchRunEvents).values({
      projectId: ownership,
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
  const parentRows = await handle
    .select({ projectId: schema.project.researchRuns.projectId })
    .from(schema.project.researchRuns)
    .where(eq(schema.project.researchRuns.id, input.runId))
    .limit(1);
  const ownership = projectOwnershipPartition(parentRows[0]?.projectId);
  await handle.insert(schema.project.researchExports).values({
    projectId: ownership,
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
        eq(schema.project.researchRuns.ownerProjectId, projectId),
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

// ─────────────────────────────────────────────────────────────────────────────
// FNXC:ResearchStore 2026-06-27-12:05:
// U4 lifecycle helpers — faithful async replicas of the sync SQLite ResearchStore
// (research-store.ts) call sites the dashboard research routes use. These reuse
// the SAME TERMINAL_STATUSES / VALID_STATUS_TRANSITIONS / defaultErrorCodeForFailureClass
// exported from research-store.ts so the PG path matches SQLite observably (R4).
// ─────────────────────────────────────────────────────────────────────────────

function generateRunId(): string {
  const timestamp = Date.now().toString(36).toUpperCase();
  const random = Math.random().toString(36).slice(2, 7).toUpperCase();
  return `RR-${timestamp}-${random}`;
}

function generateId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

function mergeRecord(
  currentValue: Record<string, unknown> | undefined,
  patchValue: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!patchValue) return currentValue;
  const merged = { ...(currentValue ?? {}), ...patchValue };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/**
 * FNXC:ResearchStore 2026-06-27-12:05:
 * Async replica of sync `ResearchStore.updateRun`. Terminal runs are immutable for
 * any non-`events`/non-`metadata` field unless every changed key is `status`/`lifecycle`
 * (throws terminal_immutable); transitions validate against VALID_STATUS_TRANSITIONS
 * (throws invalid_transition); `pending`→`queued` normalizes; providerConfig/metadata/
 * lifecycle merge; updatedAt always bumps; null clears startedAt/completedAt/cancelledAt/error.
 */
export async function updateResearchRun(
  handle: QueryHandle,
  id: string,
  input: ResearchRunUpdateInput,
): Promise<ResearchRun | undefined> {
  const existing = await getResearchRun(handle, id);
  if (!existing) return undefined;

  const normalizedExistingStatus = normalizeStatus(existing.status as ResearchRunStatus | "pending");
  const normalizedInputStatus = input.status
    ? normalizeStatus(input.status as ResearchRunStatus | "pending")
    : undefined;

  const nonMutableKeys = Object.keys(input).filter((key) => key !== "events" && key !== "metadata");
  if (TERMINAL_STATUSES.has(normalizedExistingStatus) && nonMutableKeys.length > 0) {
    const allowedTerminalMutation = nonMutableKeys.every((key) => key === "status" || key === "lifecycle");
    if (!allowedTerminalMutation) {
      throw new ResearchLifecycleError(`Run ${id} is terminal and immutable`, "terminal_immutable");
    }
  }

  if (normalizedInputStatus && normalizedInputStatus !== normalizedExistingStatus) {
    const allowed = VALID_STATUS_TRANSITIONS[normalizedExistingStatus];
    if (!allowed.includes(normalizedInputStatus)) {
      throw new ResearchLifecycleError(
        `Invalid run status transition: ${normalizedExistingStatus} -> ${normalizedInputStatus}`,
        "invalid_transition",
      );
    }
  }

  const now = new Date().toISOString();
  const mergedProviderConfig = mergeRecord(existing.providerConfig, input.providerConfig);
  const mergedMetadata = mergeRecord(existing.metadata, input.metadata);
  const mergedLifecycle = { ...(existing.lifecycle ?? {}), ...(input.lifecycle ?? {}) };

  const updated: ResearchRun = {
    ...existing,
    ...input,
    status: normalizedInputStatus ?? normalizedExistingStatus,
    providerConfig: mergedProviderConfig,
    metadata: mergedMetadata,
    lifecycle: Object.keys(mergedLifecycle).length > 0 ? mergedLifecycle : undefined,
    error: input.error === null ? undefined : (input.error ?? existing.error),
    updatedAt: now,
    startedAt: input.startedAt === null ? undefined : (input.startedAt ?? existing.startedAt),
    completedAt: input.completedAt === null ? undefined : (input.completedAt ?? existing.completedAt),
    cancelledAt: input.cancelledAt === null ? undefined : (input.cancelledAt ?? existing.cancelledAt),
  };

  await persistResearchRun(handle, updated);
  return updated;
}

/**
 * FNXC:ResearchStore 2026-06-27-12:05:
 * List runs filtered by status/fromDate/toDate/tag/search, ordered createdAt ASC, id ASC.
 * `tag` uses jsonb containment (`tags @> ["tag"]`); `search` ILIKEs query + topic.
 */
export async function listResearchRuns(handle: QueryHandle, options: ResearchRunListOptions = {}): Promise<ResearchRun[]> {
  const conditions: ReturnType<typeof eq>[] = [];
  if (options.status) conditions.push(eq(schema.project.researchRuns.status, options.status));
  if (options.fromDate) conditions.push(gte(schema.project.researchRuns.createdAt, options.fromDate));
  if (options.toDate) conditions.push(lte(schema.project.researchRuns.createdAt, options.toDate));
  if (options.tag) {
    conditions.push(sql`${schema.project.researchRuns.tags} @> ${JSON.stringify([options.tag])}::jsonb` as ReturnType<typeof eq>);
  }
  if (options.search) {
    const pattern = `%${options.search}%`;
    conditions.push(
      sql`(${schema.project.researchRuns.query} ILIKE ${pattern} OR coalesce(${schema.project.researchRuns.topic}, '') ILIKE ${pattern})` as ReturnType<typeof eq>,
    );
  }
  const ordered = handle
    .select()
    .from(schema.project.researchRuns)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(asc(schema.project.researchRuns.createdAt), asc(schema.project.researchRuns.id));
  const limited = options.limit !== undefined ? ordered.limit(options.limit) : ordered;
  const rows = await (options.offset !== undefined ? limited.offset(options.offset) : limited);
  return rows.map(rowToRun);
}

/**
 * Delete a research run by id. Returns true if a row was removed.
 */
export async function deleteResearchRun(handle: QueryHandle, id: string): Promise<boolean> {
  const result = await handle
    .delete(schema.project.researchRuns)
    .where(eq(schema.project.researchRuns.id, id))
    .returning({ id: schema.project.researchRuns.id });
  return result.length > 0;
}

/**
 * FNXC:ResearchStore 2026-06-27-12:05:
 * Dual-write event append (mirrors sync `addEvent`): inserts into the
 * research_run_events table (auto-seq, run.status snapshot) AND pushes onto the
 * run.events jsonb array via persistResearchRun. Auto-id REVT-*, auto-timestamp.
 */
export async function appendResearchEvent(
  layer: AsyncDataLayer,
  runId: string,
  event: Omit<ResearchEvent, "id" | "timestamp">,
): Promise<ResearchEvent> {
  const run = await getResearchRun(layer.db, runId);
  if (!run) throw new Error(`Research run not found: ${runId}`);
  const created: ResearchEvent = {
    id: generateId("REVT"),
    timestamp: new Date().toISOString(),
    type: event.type,
    message: event.message,
    metadata: event.metadata,
  };
  await appendResearchRunEvent(layer, {
    id: created.id,
    runId,
    type: created.type,
    message: created.message,
    status: run.status,
    classification: null,
    metadata: created.metadata ?? null,
  });
  await persistResearchRun(layer.db, {
    ...run,
    events: [...run.events, created],
    updatedAt: new Date().toISOString(),
  });
  return created;
}

/**
 * Append a lifecycle event (status_changed/cancel_requested/retry_scheduled) to the
 * research_run_events table only — mirrors sync `appendLifecycleEvent`.
 */
async function appendResearchLifecycleEvent(
  layer: AsyncDataLayer,
  runId: string,
  event: {
    type: ResearchEvent["type"];
    message: string;
    status?: ResearchRunStatus;
    classification?: ResearchRunFailureClass;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await appendResearchRunEvent(layer, {
    id: generateId("REVT"),
    runId,
    type: event.type,
    message: event.message,
    status: event.status ?? null,
    classification: event.classification ?? null,
    metadata: event.metadata ?? null,
  });
}

/**
 * List run events typed as ResearchRunEvent[], ordered seq ASC.
 */
export async function listResearchRunEventsTyped(handle: QueryHandle, runId: string): Promise<ResearchRunEvent[]> {
  const rows = await listResearchRunEvents(handle, runId);
  return rows.map((row) => ({
    id: row.id as string,
    runId: row.runId as string,
    seq: Number(row.seq),
    type: row.type as ResearchEvent["type"],
    message: row.message as string,
    status: (row.status as ResearchRunStatus | null) ?? undefined,
    classification: (row.classification as ResearchRunFailureClass | null) ?? undefined,
    metadata: (row.metadata as Record<string, unknown> | null) ?? undefined,
    createdAt: row.createdAt as string,
  }));
}

/**
 * Add a source (auto-id RSRC-*) onto the run.sources jsonb array via updateResearchRun.
 */
export async function addResearchSource(
  handle: QueryHandle,
  runId: string,
  source: Omit<ResearchSource, "id">,
): Promise<ResearchSource> {
  const run = await getResearchRun(handle, runId);
  if (!run) throw new Error(`Research run not found: ${runId}`);
  const created: ResearchSource = { ...source, id: generateId("RSRC") };
  await updateResearchRun(handle, runId, { sources: [...run.sources, created] });
  return created;
}

/**
 * Patch a single source by id within the run.sources array (id is preserved).
 */
export async function updateResearchSource(
  handle: QueryHandle,
  runId: string,
  sourceId: string,
  updates: Partial<ResearchSource>,
): Promise<void> {
  const run = await getResearchRun(handle, runId);
  if (!run) throw new Error(`Research run not found: ${runId}`);
  const next = run.sources.map((source) =>
    source.id !== sourceId ? source : { ...source, ...updates, id: source.id },
  );
  await updateResearchRun(handle, runId, { sources: next });
}

/**
 * Set the run.results jsonb. Throws when the run is missing.
 */
export async function setResearchResults(handle: QueryHandle, runId: string, results: ResearchResult): Promise<void> {
  const updated = await updateResearchRun(handle, runId, { results });
  if (!updated) throw new Error(`Research run not found: ${runId}`);
}

/**
 * FNXC:ResearchStore 2026-06-27-12:05:
 * Async replica of sync `ResearchStore.updateStatus` (research-store.ts ~377-448):
 * per-status auto-lifecycle fields (running→startedAt; terminal→completedAt;
 * completed→terminalReason+retryable=false; failed→retryable=(failureClass===retryable_transient)+errorCode;
 * cancelled→cancelledAt+retryable=false; timed_out→retryable=true+timeoutAt;
 * retry_exhausted→retryable=false+errorCode), then appends a status_changed lifecycle event.
 */
export async function updateResearchStatus(
  layer: AsyncDataLayer,
  runId: string,
  status: ResearchRunStatus,
  extra?: Partial<ResearchRun>,
): Promise<void> {
  const run = await getResearchRun(layer.db, runId);
  if (!run) throw new Error(`Research run not found: ${runId}`);

  const normalizedStatus = normalizeStatus(status as ResearchRunStatus | "pending");
  const now = new Date().toISOString();
  const patch: ResearchRunUpdateInput = {
    ...(extra ?? {}),
    status: normalizedStatus,
    lifecycle: {
      ...(run.lifecycle ?? {}),
      ...(extra?.lifecycle ?? {}),
    },
  };

  if (normalizedStatus === "running" && !run.startedAt) patch.startedAt = now;
  if (TERMINAL_STATUSES.has(normalizedStatus) && !run.completedAt) patch.completedAt = now;
  if (normalizedStatus === "cancelled" && !run.cancelledAt) patch.cancelledAt = now;

  if (normalizedStatus === "completed") {
    patch.lifecycle = { ...(patch.lifecycle ?? {}), terminalReason: "completed", retryable: false, errorCode: undefined };
  } else if (normalizedStatus === "failed") {
    const failureClass = patch.lifecycle?.failureClass;
    patch.lifecycle = {
      ...(patch.lifecycle ?? {}),
      terminalReason: "failed",
      retryable: failureClass === "retryable_transient",
      errorCode: patch.lifecycle?.errorCode ?? defaultErrorCodeForFailureClass(failureClass),
    };
  } else if (normalizedStatus === "cancelled") {
    patch.lifecycle = {
      ...(patch.lifecycle ?? {}),
      terminalReason: "cancelled",
      retryable: false,
      failureClass: "cancelled",
      errorCode: patch.lifecycle?.errorCode ?? "RUN_CANCELLED",
    };
  } else if (normalizedStatus === "timed_out") {
    patch.lifecycle = {
      ...(patch.lifecycle ?? {}),
      terminalReason: "timed_out",
      retryable: true,
      failureClass: "timed_out",
      errorCode: patch.lifecycle?.errorCode ?? "PROVIDER_TIMEOUT",
      timeoutAt: patch.lifecycle?.timeoutAt ?? now,
    };
  } else if (normalizedStatus === "retry_exhausted") {
    patch.lifecycle = {
      ...(patch.lifecycle ?? {}),
      terminalReason: "retry_exhausted",
      retryable: false,
      failureClass: patch.lifecycle?.failureClass ?? "non_retryable",
      errorCode: "RETRY_EXHAUSTED",
    };
  }

  const updated = await updateResearchRun(layer.db, runId, patch);
  if (!updated) return;

  await appendResearchLifecycleEvent(layer, runId, {
    type: "status_changed",
    message: `Status changed to ${normalizedStatus}`,
    status: normalizedStatus,
    classification: updated.lifecycle?.failureClass,
  });
}

/**
 * FNXC:ResearchStore 2026-06-27-12:05:
 * Async replica of sync `requestCancellation`: terminal runs are returned unchanged;
 * otherwise sets status `cancelling` (+lifecycle cancellation fields) and appends a
 * cancel_requested lifecycle event the first time.
 */
export async function requestResearchCancellation(
  layer: AsyncDataLayer,
  runId: string,
  reason = "Cancelled by user",
): Promise<ResearchRun> {
  const run = await getResearchRun(layer.db, runId);
  if (!run) throw new Error(`Research run not found: ${runId}`);
  if (TERMINAL_STATUSES.has(run.status)) {
    return run;
  }

  const now = new Date().toISOString();
  const alreadyCancelling = run.status === "cancelling";
  const updated = await updateResearchRun(layer.db, runId, {
    status: "cancelling",
    lifecycle: {
      ...(run.lifecycle ?? {}),
      cancellationRequestedAt: run.lifecycle?.cancellationRequestedAt ?? now,
      terminalCause: reason,
      errorCode: "RUN_CANCELLED",
      retryable: false,
    },
  });
  if (!updated) throw new Error(`Research run not found: ${runId}`);
  if (!alreadyCancelling) {
    await appendResearchLifecycleEvent(layer, runId, {
      type: "cancel_requested",
      message: reason,
      status: "cancelling",
      classification: "cancelled",
    });
  }
  return updated;
}

/**
 * FNXC:ResearchStore 2026-06-27-12:05:
 * Async replica of sync `createRetryRun` (research-store.ts ~570-625): source must be
 * failed/timed_out; when nextAttempt exceeds the configured cap the source is moved to
 * retry_exhausted and a not_retryable error is thrown; non-retryable sources throw; the
 * new run preserves rootRunId, sets retryOfRunId, increments attempt, and is parked at
 * retry_waiting with a retry_scheduled lifecycle event.
 */
export async function createResearchRetryRun(
  layer: AsyncDataLayer,
  runId: string,
  maxAttempts?: number,
): Promise<ResearchRun> {
  const run = await getResearchRun(layer.db, runId);
  if (!run) throw new Error(`Research run not found: ${runId}`);
  if (run.status !== "failed" && run.status !== "timed_out") {
    throw new ResearchLifecycleError(`Run ${runId} is not retryable from status ${run.status}`, "invalid_transition");
  }
  const currentAttempt = run.lifecycle?.attempt ?? 1;
  const configuredMaxAttempts = maxAttempts ?? run.lifecycle?.maxAttempts ?? 3;
  const nextAttempt = currentAttempt + 1;
  if (nextAttempt > configuredMaxAttempts) {
    await updateResearchRun(layer.db, runId, {
      status: "retry_exhausted",
      lifecycle: {
        ...(run.lifecycle ?? {}),
        terminalReason: "retry_exhausted",
        retryable: false,
        failureClass: run.lifecycle?.failureClass ?? "non_retryable",
        errorCode: "RETRY_EXHAUSTED",
      },
    });
    throw new ResearchLifecycleError(`Run ${runId} exhausted retries`, "not_retryable");
  }

  if (!run.lifecycle?.retryable) {
    throw new ResearchLifecycleError(`Run ${runId} is non-retryable`, "not_retryable");
  }

  const rootRunId = run.lifecycle?.rootRunId ?? run.id;
  const now = new Date().toISOString();
  const retryRun: ResearchRun = {
    id: generateRunId(),
    query: run.query,
    topic: run.topic,
    status: "queued",
    projectId: run.projectId,
    trigger: run.trigger,
    providerConfig: run.providerConfig,
    sources: [],
    events: [],
    results: undefined,
    tags: run.tags ?? [],
    metadata: run.metadata,
    lifecycle: {
      attempt: nextAttempt,
      maxAttempts: configuredMaxAttempts,
      retryOfRunId: run.id,
      rootRunId,
    },
    createdAt: now,
    updatedAt: now,
  };
  await createResearchRun(layer.db, retryRun);

  await updateResearchStatus(layer, retryRun.id, "retry_waiting", {
    lifecycle: {
      ...(retryRun.lifecycle ?? {}),
      retryable: true,
    },
  });
  await appendResearchLifecycleEvent(layer, retryRun.id, {
    type: "retry_scheduled",
    message: `Retry scheduled from ${run.id}`,
    metadata: { retryOfRunId: run.id, rootRunId, attempt: nextAttempt },
  });
  return (await getResearchRun(layer.db, retryRun.id))!;
}

/**
 * FNXC:ResearchStore 2026-06-27-12:05:
 * Search runs by query/topic/results.summary (ILIKE), ordered createdAt ASC, id ASC.
 */
export async function searchResearchRuns(handle: QueryHandle, query: string): Promise<ResearchRun[]> {
  const pattern = `%${query}%`;
  const rows = await handle
    .select()
    .from(schema.project.researchRuns)
    .where(
      sql`(${schema.project.researchRuns.query} ILIKE ${pattern}
        OR coalesce(${schema.project.researchRuns.topic}, '') ILIKE ${pattern}
        OR coalesce(${schema.project.researchRuns.results} ->> 'summary', '') ILIKE ${pattern})`,
    )
    .orderBy(asc(schema.project.researchRuns.createdAt), asc(schema.project.researchRuns.id));
  return rows.map(rowToRun);
}

/**
 * Get a single research export by id.
 */
export async function getResearchExport(handle: QueryHandle, id: string): Promise<ResearchExport | undefined> {
  const rows = await handle
    .select()
    .from(schema.project.researchExports)
    .where(eq(schema.project.researchExports.id, id));
  return rows[0] ? rowToExport(rows[0]) : undefined;
}

/**
 * FNXC:ResearchStore 2026-06-27-12:10:
 * PostgreSQL-backed ResearchStore — the AsyncDataLayer counterpart of the sync SQLite
 * `ResearchStore` (research-store.ts). It exposes the SAME public method names the
 * dashboard research routes call, so callers can `await` either implementation.
 * `getResearchStoreImpl` returns this in backend mode instead of throwing
 * "ResearchStore is not available in PG backend mode". Id/timestamp generation mirrors
 * the sync store (RR-/REVT-/RSRC-/REXP- prefixes); the run lifecycle + retry machines
 * live in the helpers above.
 *
 * FNXC:ResearchStore 2026-06-28-13:00:
 * SSE live-push parity — the async wrapper now extends EventEmitter<ResearchStoreEvents>
 * and emits the SAME events at the SAME mutation points as the sync ResearchStore
 * (research-store.ts) so the dashboard SSE handler live-refreshes in PG backend mode
 * instead of only on manual reload. Emit sites are mirrored method-by-method from the
 * sync store's `this.emit(` call sites: createRun→run:created, updateRun→run:updated,
 * deleteRun→run:deleted, addEvent→event:added, addSource→source:added, updateStatus→
 * run:status_changed (+run:completed/failed/cancelled/timed_out). Each emit fires AFTER
 * the persistence await succeeds, with the same payload (the persisted entity) the sync
 * store emits. The instance is cached on the TaskStore, so SSE subscribes to the same
 * object the routes mutate.
 *
 * Known gap vs the sync store: AI research EXECUTION (orchestrator dispatch) stays
 * degraded in PG mode — the dashboard CRUD/lifecycle surface is in scope. requestCancellation/
 * createRetryRun mirror the sync helpers (which emit only indirectly via the sync
 * updateRun/updateStatus); the async variants call the helpers directly, so their
 * status-change events surface through an explicit updateStatus call by the caller, not
 * from inside requestCancellation/createRetryRun.
 */
export class AsyncResearchStore extends EventEmitter<ResearchStoreEvents> {
  constructor(private readonly layer: AsyncDataLayer) {
    super();
  }

  async createRun(input: ResearchRunCreateInput): Promise<ResearchRun> {
    const now = new Date().toISOString();
    const run: ResearchRun = {
      id: generateRunId(),
      query: input.query,
      topic: input.topic,
      status: "queued",
      projectId: input.projectId,
      trigger: input.trigger,
      providerConfig: input.providerConfig,
      sources: input.sources ?? [],
      events: input.events ?? [],
      results: input.results,
      tags: input.tags ?? [],
      metadata: input.metadata,
      lifecycle: {
        attempt: input.lifecycle?.attempt ?? 1,
        maxAttempts: input.lifecycle?.maxAttempts ?? 3,
        rootRunId: input.lifecycle?.rootRunId,
        retryOfRunId: input.lifecycle?.retryOfRunId,
        ...input.lifecycle,
      },
      createdAt: now,
      updatedAt: now,
    };
    const created = await createResearchRun(this.layer.db, run);
    this.emit("run:created", created);
    return created;
  }

  async getRun(id: string): Promise<ResearchRun | undefined> {
    return getResearchRun(this.layer.db, id);
  }

  async updateRun(id: string, input: ResearchRunUpdateInput): Promise<ResearchRun | undefined> {
    const updated = await updateResearchRun(this.layer.db, id, input);
    if (updated) this.emit("run:updated", updated);
    return updated;
  }

  async listRuns(options: ResearchRunListOptions = {}): Promise<ResearchRun[]> {
    return listResearchRuns(this.layer.db, options);
  }

  async deleteRun(id: string): Promise<boolean> {
    const deleted = await deleteResearchRun(this.layer.db, id);
    if (deleted) this.emit("run:deleted", id);
    return deleted;
  }

  async appendEvent(runId: string, event: Omit<ResearchEvent, "id" | "timestamp">): Promise<ResearchEvent> {
    const created = await appendResearchEvent(this.layer, runId, event);
    this.emit("event:added", { runId, event: created });
    return created;
  }

  async listRunEvents(runId: string): Promise<ResearchRunEvent[]> {
    return listResearchRunEventsTyped(this.layer.db, runId);
  }

  async addSource(runId: string, source: Omit<ResearchSource, "id">): Promise<ResearchSource> {
    const created = await addResearchSource(this.layer.db, runId, source);
    this.emit("source:added", { runId, source: created });
    return created;
  }

  async updateSource(runId: string, sourceId: string, updates: Partial<ResearchSource>): Promise<void> {
    return updateResearchSource(this.layer.db, runId, sourceId, updates);
  }

  async setResults(runId: string, results: ResearchResult): Promise<void> {
    return setResearchResults(this.layer.db, runId, results);
  }

  async updateStatus(runId: string, status: ResearchRunStatus, extra?: Partial<ResearchRun>): Promise<void> {
    await updateResearchStatus(this.layer, runId, status, extra);
    // Mirror sync ResearchStore.updateStatus emit set: run:status_changed always,
    // plus the terminal-specific event keyed off the persisted (normalized) status.
    const updated = await getResearchRun(this.layer.db, runId);
    if (!updated) return;
    this.emit("run:status_changed", updated);
    if (updated.status === "completed") this.emit("run:completed", updated);
    if (updated.status === "failed") this.emit("run:failed", updated);
    if (updated.status === "cancelled") this.emit("run:cancelled", updated);
    if (updated.status === "timed_out") this.emit("run:timed_out", updated);
  }

  async requestCancellation(runId: string, reason?: string): Promise<ResearchRun> {
    return requestResearchCancellation(this.layer, runId, reason);
  }

  async createRetryRun(runId: string, maxAttempts?: number): Promise<ResearchRun> {
    return createResearchRetryRun(this.layer, runId, maxAttempts);
  }

  async createExport(runId: string, format: ResearchExportFormat, content: string): Promise<ResearchExport> {
    return createResearchExport(this.layer.db, {
      id: generateId("REXP"),
      runId,
      format,
      content,
      createdAt: new Date().toISOString(),
    });
  }

  async getExports(runId: string): Promise<ResearchExport[]> {
    return getResearchExports(this.layer.db, runId);
  }

  async getExport(id: string): Promise<ResearchExport | undefined> {
    return getResearchExport(this.layer.db, id);
  }

  async getStats(): Promise<{ total: number; byStatus: Record<ResearchRunStatus, number> }> {
    return getResearchStats(this.layer.db);
  }

  async searchRuns(query: string): Promise<ResearchRun[]> {
    return searchResearchRuns(this.layer.db, query);
  }

  async getActiveRun(projectId: string, trigger: string): Promise<ResearchRun | undefined> {
    return getActiveResearchRun(this.layer.db, projectId, trigger);
  }
}
