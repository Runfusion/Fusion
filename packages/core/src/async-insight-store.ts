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
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, lte, sql } from "drizzle-orm";
import * as schema from "./postgres/schema/index.js";
import type { AsyncDataLayer, DbTransaction } from "./postgres/data-layer.js";
import {
  InsightLifecycleError,
  TERMINAL_RUN_STATUSES,
  VALID_RUN_STATUS_TRANSITIONS,
} from "./insight-store.js";
import type {
  Insight,
  InsightCategory,
  InsightListOptions,
  InsightProvenance,
  InsightRun,
  InsightRunCreateInput,
  InsightRunEvent,
  InsightRunEventType,
  InsightRunFailureClass,
  InsightRunLifecycle,
  InsightRunListOptions,
  InsightRunStatus,
  InsightRunTrigger,
  InsightRunUpdateInput,
  InsightStatus,
  InsightUpdateInput,
  InsightUpsertInput,
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
  input: { id: string; runId: string; type: InsightRunEventType; message: string; status?: InsightRunStatus; classification?: InsightRunFailureClass; metadata?: Record<string, unknown> },
): Promise<InsightRunEvent> {
  let seq = 1;
  const createdAt = new Date().toISOString();
  await layer.transactionImmediate(async (tx) => {
    const seqRows = await tx
      .select({ nextSeq: sql<number>`coalesce(max(${schema.project.projectInsightRunEvents.seq}), 0) + 1` })
      .from(schema.project.projectInsightRunEvents)
      .where(eq(schema.project.projectInsightRunEvents.runId, input.runId));
    seq = Number(seqRows[0]?.nextSeq ?? 1);
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
  return {
    id: input.id,
    runId: input.runId,
    seq,
    type: input.type,
    message: input.message,
    status: input.status,
    classification: input.classification,
    metadata: input.metadata,
    createdAt,
  };
}

/**
 * FNXC:InsightStore 2026-06-27-09:05:
 * List run events ordered by seq ASC — mirrors sync `InsightStore.listRunEvents`.
 */
export async function listInsightRunEvents(handle: QueryHandle, runId: string): Promise<InsightRunEvent[]> {
  const rows = await handle
    .select()
    .from(schema.project.projectInsightRunEvents)
    .where(eq(schema.project.projectInsightRunEvents.runId, runId))
    .orderBy(asc(schema.project.projectInsightRunEvents.seq));
  return rows.map((row) => ({
    id: row.id as string,
    runId: row.runId as string,
    seq: Number(row.seq),
    type: row.type as InsightRunEventType,
    message: row.message as string,
    status: (row.status as InsightRunStatus | null) ?? undefined,
    classification: (row.classification as InsightRunFailureClass | null) ?? undefined,
    metadata: (row.metadata as Record<string, unknown> | null) ?? undefined,
    createdAt: row.createdAt as string,
  }));
}

/**
 * FNXC:InsightStore 2026-06-27-09:05:
 * Update an insight's mutable fields, always bumping updatedAt. Mirrors sync
 * `InsightStore.updateInsight`; returns undefined when the row is absent.
 */
export async function updateInsight(
  handle: QueryHandle,
  id: string,
  input: InsightUpdateInput,
): Promise<Insight | undefined> {
  const existing = await getInsight(handle, id);
  if (!existing) return undefined;
  const now = new Date().toISOString();
  const sets: Record<string, unknown> = { updatedAt: now };
  if (input.title !== undefined) sets.title = input.title;
  if (input.content !== undefined) sets.content = input.content;
  if (input.category !== undefined) sets.category = input.category;
  if (input.status !== undefined) sets.status = input.status;
  if (input.provenance !== undefined) sets.provenance = input.provenance;
  await handle
    .update(schema.project.projectInsights)
    .set(sets as never)
    .where(eq(schema.project.projectInsights.id, id));
  return (await getInsight(handle, id))!;
}

/**
 * FNXC:InsightStore 2026-06-27-09:05:
 * Faithful async replica of sync `InsightStore.updateRun` (insight-store.ts).
 * Terminal runs are immutable (throws terminal_immutable); transitions are
 * validated against VALID_RUN_STATUS_TRANSITIONS (throws invalid_transition);
 * completedAt auto-sets on terminal entry, cancelledAt on cancel; lifecycle
 * jsonb merges; only provided + auto fields are written. Returns the reloaded run.
 */
export async function updateInsightRun(
  handle: QueryHandle,
  id: string,
  input: InsightRunUpdateInput,
): Promise<InsightRun | undefined> {
  const existing = await getInsightRun(handle, id);
  if (!existing) return undefined;

  const mutatingKeys = Object.keys(input);
  if (TERMINAL_RUN_STATUSES.has(existing.status) && mutatingKeys.length > 0) {
    throw new InsightLifecycleError(`Run ${id} is terminal and immutable`, "terminal_immutable");
  }

  if (input.status && input.status !== existing.status) {
    const allowed = VALID_RUN_STATUS_TRANSITIONS[existing.status];
    if (!allowed.includes(input.status)) {
      throw new InsightLifecycleError(
        `Invalid run status transition: ${existing.status} -> ${input.status}`,
        "invalid_transition",
      );
    }
  }

  const now = new Date().toISOString();
  const nextStatus = input.status ?? existing.status;
  const isTerminal = TERMINAL_RUN_STATUSES.has(nextStatus);
  const lifecycle = { ...existing.lifecycle, ...(input.lifecycle ?? {}) };
  const autoCompleteAt = isTerminal && input.completedAt === undefined && existing.completedAt === null ? now : undefined;
  const autoCancelledAt = nextStatus === "cancelled" && input.cancelledAt === undefined && existing.cancelledAt === null ? now : undefined;

  const sets: Record<string, unknown> = {};
  if (input.status !== undefined) sets.status = input.status;
  if (input.summary !== undefined) sets.summary = input.summary;
  if (input.error !== undefined) sets.error = input.error;
  if (input.insightsCreated !== undefined) sets.insightsCreated = input.insightsCreated;
  if (input.insightsUpdated !== undefined) sets.insightsUpdated = input.insightsUpdated;
  if (input.outputMetadata !== undefined) sets.outputMetadata = input.outputMetadata;
  if (input.lifecycle !== undefined) sets.lifecycle = lifecycle;
  if (input.startedAt !== undefined) sets.startedAt = input.startedAt;
  if (input.completedAt !== undefined) sets.completedAt = input.completedAt;
  if (input.cancelledAt !== undefined) sets.cancelledAt = input.cancelledAt;
  if (autoCompleteAt !== undefined) sets.completedAt = autoCompleteAt;
  if (autoCancelledAt !== undefined) sets.cancelledAt = autoCancelledAt;

  if (Object.keys(sets).length === 0) return existing;

  await handle
    .update(schema.project.projectInsightRuns)
    .set(sets as never)
    .where(eq(schema.project.projectInsightRuns.id, id));
  return (await getInsightRun(handle, id))!;
}

function buildInsightCountConditions(options: Pick<InsightListOptions, "projectId" | "category" | "status" | "runId">): ReturnType<typeof eq>[] {
  const conditions: ReturnType<typeof eq>[] = [];
  if (options.projectId !== undefined) conditions.push(eq(schema.project.projectInsights.projectId, options.projectId));
  if (options.category !== undefined) conditions.push(eq(schema.project.projectInsights.category, options.category));
  if (options.status !== undefined) conditions.push(eq(schema.project.projectInsights.status, options.status));
  if (options.runId !== undefined) conditions.push(eq(schema.project.projectInsights.lastRunId, options.runId));
  return conditions;
}

/**
 * FNXC:InsightStore 2026-06-27-09:05:
 * Count insights matching the same filter as listInsights.
 */
export async function countInsights(handle: QueryHandle, options: Omit<InsightListOptions, "limit" | "offset"> = {}): Promise<number> {
  const conditions = buildInsightCountConditions(options);
  const query = handle.select({ count: sql<number>`count(*)` }).from(schema.project.projectInsights);
  const rows = conditions.length > 0 ? await query.where(and(...conditions)) : await query;
  return Number(rows[0]?.count ?? 0);
}

function buildRunCountConditions(options: Pick<InsightRunListOptions, "projectId" | "status" | "trigger">): ReturnType<typeof eq>[] {
  const conditions: ReturnType<typeof eq>[] = [];
  if (options.projectId !== undefined) conditions.push(eq(schema.project.projectInsightRuns.projectId, options.projectId));
  if (options.status !== undefined) conditions.push(eq(schema.project.projectInsightRuns.status, options.status));
  if (options.trigger !== undefined) conditions.push(eq(schema.project.projectInsightRuns.trigger, options.trigger));
  return conditions;
}

/**
 * FNXC:InsightStore 2026-06-27-09:05:
 * Count runs matching the same filter as listInsightRuns.
 */
export async function countInsightRuns(handle: QueryHandle, options: Omit<InsightRunListOptions, "limit" | "offset"> = {}): Promise<number> {
  const conditions = buildRunCountConditions(options);
  const query = handle.select({ count: sql<number>`count(*)` }).from(schema.project.projectInsightRuns);
  const rows = conditions.length > 0 ? await query.where(and(...conditions)) : await query;
  return Number(rows[0]?.count ?? 0);
}

/**
 * FNXC:InsightStore 2026-06-27-09:05:
 * List pending/running runs whose coalesce(startedAt, createdAt) is at or before
 * olderThanIso, ordered createdAt ASC, id ASC. Mirrors sync `listStalePendingRuns`.
 */
export async function listStalePendingRuns(
  handle: QueryHandle,
  olderThanIso: string,
  options: { projectId?: string; limit?: number } = {},
): Promise<InsightRun[]> {
  const limit = Math.max(1, Math.floor(options.limit ?? 100));
  const conditions = [
    inArray(schema.project.projectInsightRuns.status, ["pending", "running"]),
    lte(sql`coalesce(${schema.project.projectInsightRuns.startedAt}, ${schema.project.projectInsightRuns.createdAt})`, olderThanIso),
  ];
  if (options.projectId) conditions.push(eq(schema.project.projectInsightRuns.projectId, options.projectId));
  const rows = await handle
    .select()
    .from(schema.project.projectInsightRuns)
    .where(and(...conditions))
    .orderBy(asc(schema.project.projectInsightRuns.createdAt), asc(schema.project.projectInsightRuns.id))
    .limit(limit);
  return rows.map(rowToRun);
}

/**
 * FNXC:InsightStore 2026-06-27-09:10:
 * PostgreSQL-backed InsightStore — the AsyncDataLayer counterpart of the sync
 * SQLite `InsightStore` (insight-store.ts). It exposes the SAME public method
 * names the dashboard insights routes + CLI insight tools call, so callers can
 * `await` either implementation. `getInsightStoreImpl` returns this in backend
 * mode instead of throwing "InsightStore is not available in PG backend mode".
 * Id/timestamp generation mirrors the sync store (INS-, INSR-, INSEVT- prefixes);
 * the run lifecycle state machine lives in the `updateInsightRun` helper above.
 *
 * Known gap vs the sync store: the sync InsightStore is an EventEmitter
 * (insight:created/run:event/…) for SSE live-refresh; this wrapper performs CRUD
 * only. The sync-coupled insight-run executor + background sweeper are not ported
 * in this unit, so manual run execution/retry remain a sync-mode capability.
 */
export class AsyncInsightStore {
  constructor(private readonly layer: AsyncDataLayer) {}

  private static newId(prefix: "INS" | "INSR"): string {
    const timestamp = Date.now().toString(36).toUpperCase();
    const random = Math.random().toString(36).slice(2, 6).toUpperCase();
    return `${prefix}-${timestamp}-${random}`;
  }

  // ── Insight CRUD ──
  async getInsight(id: string): Promise<Insight | undefined> {
    return getInsight(this.layer.db, id);
  }

  async listInsights(options: InsightListOptions = {}): Promise<Insight[]> {
    return listInsights(this.layer.db, options);
  }

  async upsertInsight(projectId: string, input: InsightUpsertInput): Promise<Insight> {
    return upsertInsight(this.layer.db, projectId, {
      id: AsyncInsightStore.newId("INS"),
      title: input.title,
      content: input.content ?? null,
      category: input.category,
      status: input.status ?? "confirmed",
      fingerprint: input.fingerprint,
      provenance: input.provenance,
    });
  }

  async updateInsight(id: string, input: InsightUpdateInput): Promise<Insight | undefined> {
    return updateInsight(this.layer.db, id, input);
  }

  async deleteInsight(id: string): Promise<boolean> {
    return deleteInsight(this.layer.db, id);
  }

  async countInsights(options: Omit<InsightListOptions, "limit" | "offset"> = {}): Promise<number> {
    return countInsights(this.layer.db, options);
  }

  // ── Insight Run CRUD ──
  async createRun(projectId: string, input: InsightRunCreateInput): Promise<InsightRun> {
    const now = new Date().toISOString();
    const lifecycle: InsightRunLifecycle = {
      attempt: input.lifecycle?.attempt ?? 1,
      maxAttempts: input.lifecycle?.maxAttempts ?? 1,
      rootRunId: input.lifecycle?.rootRunId,
      retryOfRunId: input.lifecycle?.retryOfRunId,
      ...input.lifecycle,
    };
    return createInsightRun(this.layer.db, {
      id: AsyncInsightStore.newId("INSR"),
      projectId,
      trigger: input.trigger,
      inputMetadata: (input.inputMetadata ?? {}) as Record<string, unknown>,
      lifecycle: lifecycle as Record<string, unknown>,
      createdAt: now,
    });
  }

  async getRun(id: string): Promise<InsightRun | undefined> {
    return getInsightRun(this.layer.db, id);
  }

  async listRuns(options: InsightRunListOptions = {}): Promise<InsightRun[]> {
    return listInsightRuns(this.layer.db, options);
  }

  async updateRun(id: string, input: InsightRunUpdateInput): Promise<InsightRun | undefined> {
    return updateInsightRun(this.layer.db, id, input);
  }

  async upsertRun(projectId: string, trigger: InsightRunTrigger, input: InsightRunCreateInput): Promise<InsightRun> {
    const existing = await this.findActiveRun(projectId, trigger);
    if (existing) return existing;
    return this.createRun(projectId, input);
  }

  async findActiveRun(projectId: string, trigger: InsightRunTrigger): Promise<InsightRun | undefined> {
    return findActiveInsightRun(this.layer.db, projectId, trigger);
  }

  async listStalePendingRuns(
    olderThanIso: string,
    options: { projectId?: string; limit?: number } = {},
  ): Promise<InsightRun[]> {
    return listStalePendingRuns(this.layer.db, olderThanIso, options);
  }

  async createRunOrThrowConflict(projectId: string, input: InsightRunCreateInput): Promise<InsightRun> {
    const existing = await this.findActiveRun(projectId, input.trigger);
    if (existing) {
      throw new InsightLifecycleError(
        `Active run already exists for project ${projectId} trigger ${input.trigger}: ${existing.id}`,
        "active_run_conflict",
      );
    }
    return this.createRun(projectId, input);
  }

  async appendRunEvent(
    runId: string,
    event: {
      type: InsightRunEventType;
      message: string;
      status?: InsightRunStatus;
      classification?: InsightRunFailureClass;
      metadata?: Record<string, unknown>;
    },
  ): Promise<InsightRunEvent> {
    const run = await this.getRun(runId);
    if (!run) {
      throw new Error(`Insight run not found: ${runId}`);
    }
    return appendInsightRunEvent(this.layer, {
      id: `INSEVT-${randomUUID()}`,
      runId,
      type: event.type,
      message: event.message,
      status: event.status,
      classification: event.classification,
      metadata: event.metadata,
    });
  }

  async listRunEvents(runId: string): Promise<InsightRunEvent[]> {
    return listInsightRunEvents(this.layer.db, runId);
  }

  async countRuns(options: Omit<InsightRunListOptions, "limit" | "offset"> = {}): Promise<number> {
    return countInsightRuns(this.layer.db, options);
  }
}
