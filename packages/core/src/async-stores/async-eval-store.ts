/**
 * Async Drizzle EvalStore helpers (U6 satellite-db-injected-stores).
 *
 * FNXC:EvalStore 2026-06-24-07:50:
 * Async equivalents of the sync SQLite EvalStore call sites in eval-store.ts.
 * These helpers target the PostgreSQL `project.eval_runs`,
 * `project.eval_task_results`, and `project.eval_run_events` tables via Drizzle.
 *
 * SQLite → PostgreSQL notes (VAL-SCHEMA-004):
 *   All JSON columns (window, requestedTaskIds, evaluatedTaskIds, counts,
 *   aggregateScores, provenance, metadata, taskSnapshot, categoryScores,
 *   evidence, deterministicSignals, aiSignals, followUps) are jsonb in
 *   PostgreSQL, so Drizzle returns them already-parsed as JS values. On write,
 *   pass the JS value directly (Drizzle serializes it).
 *
 * Transition context (see library/satellite-store-migration-pattern.md):
 *   `getDatabase()` still returns the sync `Database` until the coordinated
 *   flip. These helpers are the async target the PostgreSQL integration tests
 *   consume.
 */
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import * as schema from "../postgres/schema/index.js";
import type { AsyncDataLayer, DbTransaction } from "../postgres/data-layer.js";
import { EvalLifecycleError, applyEvalRunUpdate } from "../eval/eval-store.js";
import type {
  EvalRun,
  EvalRunCreateInput,
  EvalRunListOptions,
  EvalRunStatus,
  EvalRunUpdateInput,
  EvalTaskResult,
  EvalTaskResultCreateInput,
  EvalTaskResultListOptions,
  EvalRunEvent,
} from "../eval/eval-types.js";

const ACTIVE_EVAL_RUN_STATUSES: ReadonlySet<EvalRunStatus> = new Set<EvalRunStatus>(["pending", "running"]);

function generateRunId(): string {
  return `ER-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
}

function generateResultId(): string {
  return `ETR-${randomUUID()}`;
}

function generateEventId(): string {
  return `ERE-${randomUUID()}`;
}

/** A query-capable handle: either the top-level db or a transaction handle. */
type QueryHandle = AsyncDataLayer["db"] | DbTransaction;

function rowToRun(row: Record<string, unknown>): EvalRun {
  return {
    id: String(row.id),
    // FNXC:MultiProjectIsolation 2026-07-15-23:40: the domain projectId now maps to owner_project_id; project_id is the trigger/GUC-owned RLS partition (migration 0011).
    projectId: String(row.ownerProjectId ?? ""),
    status: row.status as EvalRunStatus,
    trigger: row.trigger as EvalRun["trigger"],
    scope: String(row.scope),
    window: (row.window as EvalRun["window"]) ?? {},
    requestedTaskIds: (row.requestedTaskIds as string[]) ?? [],
    evaluatedTaskIds: (row.evaluatedTaskIds as string[]) ?? [],
    counts: (row.counts as EvalRun["counts"]) ?? { totalTasks: 0, scoredTasks: 0, skippedTasks: 0, erroredTasks: 0 },
    aggregateScores: row.aggregateScores as EvalRun["aggregateScores"],
    summary: (row.summary as string | null) ?? undefined,
    error: (row.error as string | null) ?? undefined,
    provenance: row.provenance as EvalRun["provenance"],
    metadata: row.metadata as EvalRun["metadata"],
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
    startedAt: (row.startedAt as string | null) ?? undefined,
    completedAt: (row.completedAt as string | null) ?? undefined,
    cancelledAt: (row.cancelledAt as string | null) ?? undefined,
  };
}

function rowToResult(row: Record<string, unknown>): EvalTaskResult {
  return {
    id: String(row.id),
    runId: String(row.runId),
    taskId: String(row.taskId),
    taskSnapshot: (row.taskSnapshot as EvalTaskResult["taskSnapshot"]) ?? { taskId: String(row.taskId) },
    status: row.status as EvalTaskResult["status"],
    overallScore: row.overallScore == null ? undefined : Number(row.overallScore),
    maxScore: row.maxScore == null ? undefined : Number(row.maxScore),
    categoryScores: (row.categoryScores as EvalTaskResult["categoryScores"]) ?? [],
    rationale: (row.rationale as string | null) ?? undefined,
    summary: (row.summary as string | null) ?? undefined,
    evidence: (row.evidence as EvalTaskResult["evidence"]) ?? [],
    evidenceBundle: row.evidenceBundle as EvalTaskResult["evidenceBundle"],
    deterministicSignals: (row.deterministicSignals as EvalTaskResult["deterministicSignals"]) ?? [],
    aiSignals: row.aiSignals as EvalTaskResult["aiSignals"],
    followUps: (row.followUps as EvalTaskResult["followUps"]) ?? [],
    provenance: row.provenance as EvalTaskResult["provenance"],
    metadata: row.metadata as EvalTaskResult["metadata"],
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
  };
}

function rowToEvent(row: Record<string, unknown>): EvalRunEvent {
  return {
    id: String(row.id),
    runId: String(row.runId),
    seq: Number(row.seq),
    type: row.type as EvalRunEvent["type"],
    message: String(row.message),
    status: (row.status as EvalRunStatus | null) ?? undefined,
    taskId: (row.taskId as string | null) ?? undefined,
    metadata: row.metadata as EvalRunEvent["metadata"],
    createdAt: String(row.createdAt),
  };
}

/**
 * Create an eval run.
 */
export async function createEvalRun(
  handle: QueryHandle,
  run: { id: string; projectId: string; trigger: string; scope: string; window: Record<string, unknown>; requestedTaskIds: string[]; counts: Record<string, number>; provenance?: Record<string, unknown>; metadata?: Record<string, unknown>; createdAt: string; updatedAt: string },
): Promise<EvalRun> {
  await handle.insert(schema.project.evalRuns).values({
    id: run.id,
    // FNXC:MultiProjectIsolation 2026-07-15-23:40: write the caller's domain project to owner_project_id and never project_id — domain writes into the partition desynced parent/child partitions and broke composite FKs (23503).
    ownerProjectId: run.projectId,
    status: "pending",
    trigger: run.trigger,
    scope: run.scope,
    window: run.window,
    requestedTaskIds: run.requestedTaskIds,
    evaluatedTaskIds: [],
    counts: run.counts,
    aggregateScores: null,
    summary: null,
    error: null,
    provenance: run.provenance ?? null,
    metadata: run.metadata ?? null,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
  });
  return rowToRun({
    id: run.id,
    ownerProjectId: run.projectId,
    status: "pending",
    trigger: run.trigger,
    scope: run.scope,
    window: run.window,
    requestedTaskIds: run.requestedTaskIds,
    evaluatedTaskIds: [],
    counts: run.counts,
    aggregateScores: null,
    summary: null,
    error: null,
    provenance: run.provenance ?? null,
    metadata: run.metadata ?? null,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
  });
}

/**
 * Get a single eval run by id.
 */
export async function getEvalRun(handle: QueryHandle, id: string): Promise<EvalRun | undefined> {
  const rows = await handle
    .select()
    .from(schema.project.evalRuns)
    .where(eq(schema.project.evalRuns.id, id));
  return rows[0] ? rowToRun(rows[0]) : undefined;
}

/**
 * List eval runs with optional filters.
 */
export async function listEvalRuns(handle: QueryHandle, options: EvalRunListOptions = {}): Promise<EvalRun[]> {
  const conditions: ReturnType<typeof eq>[] = [];
  if (options.projectId) conditions.push(eq(schema.project.evalRuns.ownerProjectId, options.projectId));
  if (options.status) conditions.push(eq(schema.project.evalRuns.status, options.status));
  if (options.trigger) conditions.push(eq(schema.project.evalRuns.trigger, options.trigger));
  let query = handle
    .select()
    .from(schema.project.evalRuns)
    .$dynamic();
  if (conditions.length > 0) query = query.where(and(...conditions));
  query = options.order === "desc"
    ? query.orderBy(desc(schema.project.evalRuns.createdAt), desc(schema.project.evalRuns.id))
    : query.orderBy(asc(schema.project.evalRuns.createdAt), asc(schema.project.evalRuns.id));
  if (options.offset !== undefined) query = query.offset(options.offset);
  if (options.limit !== undefined) query = query.limit(options.limit);
  return (await query).map(rowToRun);
}

/**
 * Persist (update) an eval run's mutable fields.
 */
export async function persistEvalRun(handle: QueryHandle, run: EvalRun): Promise<void> {
  await handle
    .update(schema.project.evalRuns)
    .set({
      status: run.status,
      scope: run.scope,
      window: run.window,
      requestedTaskIds: run.requestedTaskIds,
      evaluatedTaskIds: run.evaluatedTaskIds,
      counts: run.counts,
      aggregateScores: run.aggregateScores ?? null,
      summary: run.summary ?? null,
      error: run.error ?? null,
      provenance: run.provenance ?? null,
      metadata: run.metadata ?? null,
      updatedAt: run.updatedAt,
      startedAt: run.startedAt ?? null,
      completedAt: run.completedAt ?? null,
      cancelledAt: run.cancelledAt ?? null,
    })
    .where(eq(schema.project.evalRuns.id, run.id));
}

/**
 * FNXC:EvalStore 2026-06-24-07:55:
 * Create or upsert an eval task result. Uses ON CONFLICT (runId, taskId)
 * DO UPDATE to match the sync ON CONFLICT(runId, taskId) behavior.
 */
export async function upsertEvalTaskResult(
  handle: QueryHandle,
  result: EvalTaskResult,
): Promise<void> {
  // FNXC:MultiProjectIsolation 2026-07-16-08:05: children inherit the parent run's
  // project_id partition explicitly. The GUC-driven trigger only covers bound sessions;
  // unbound/bypass handles (tests, admin, maintenance) or a GUC naming another partition
  // would otherwise violate the composite (project_id, run_id) FK with SQLSTATE 23503.
  // Inherit the PARTITION column (projectId), never the domain field (ownerProjectId).
  const runRows = await handle
    .select({ projectId: schema.project.evalRuns.projectId })
    .from(schema.project.evalRuns)
    .where(eq(schema.project.evalRuns.id, result.runId))
    .limit(1);
  const parentProjectId = runRows[0]?.projectId;
  if (!parentProjectId) throw new Error(`Eval run not found: ${result.runId}`);
  await handle
    .insert(schema.project.evalTaskResults)
    .values({
      projectId: parentProjectId,
      id: result.id,
      runId: result.runId,
      taskId: result.taskId,
      taskSnapshot: result.taskSnapshot,
      status: result.status,
      overallScore: result.overallScore ?? null,
      maxScore: result.maxScore ?? null,
      categoryScores: result.categoryScores,
      rationale: result.rationale ?? null,
      summary: result.summary ?? null,
      evidence: result.evidence,
      deterministicSignals: result.deterministicSignals,
      aiSignals: result.aiSignals ?? null,
      followUps: result.followUps,
      provenance: result.provenance ?? null,
      metadata: result.metadata ?? null,
      createdAt: result.createdAt,
      updatedAt: result.updatedAt,
    })
    .onConflictDoUpdate({
      target: [
        schema.project.evalTaskResults.projectId,
        schema.project.evalTaskResults.runId,
        schema.project.evalTaskResults.taskId,
      ],
      set: {
        taskSnapshot: result.taskSnapshot,
        status: result.status,
        overallScore: result.overallScore ?? null,
        maxScore: result.maxScore ?? null,
        categoryScores: result.categoryScores,
        rationale: result.rationale ?? null,
        summary: result.summary ?? null,
        evidence: result.evidence,
        deterministicSignals: result.deterministicSignals,
        aiSignals: result.aiSignals ?? null,
        followUps: result.followUps,
        provenance: result.provenance ?? null,
        metadata: result.metadata ?? null,
        updatedAt: result.updatedAt,
      },
    });
}

/**
 * Get a single eval task result by id.
 */
export async function getEvalTaskResult(handle: QueryHandle, id: string): Promise<EvalTaskResult | undefined> {
  const rows = await handle
    .select()
    .from(schema.project.evalTaskResults)
    .where(eq(schema.project.evalTaskResults.id, id));
  return rows[0] ? rowToResult(rows[0]) : undefined;
}

/**
 * Get a single eval task result by (runId, taskId).
 */
export async function getEvalTaskResultByRunTask(
  handle: QueryHandle,
  runId: string,
  taskId: string,
): Promise<EvalTaskResult | undefined> {
  const rows = await handle
    .select()
    .from(schema.project.evalTaskResults)
    .where(
      and(
        eq(schema.project.evalTaskResults.runId, runId),
        eq(schema.project.evalTaskResults.taskId, taskId),
      ),
    );
  return rows[0] ? rowToResult(rows[0]) : undefined;
}

/**
 * List eval task results with optional filters.
 */
export async function listEvalTaskResults(handle: QueryHandle, options: EvalTaskResultListOptions = {}): Promise<EvalTaskResult[]> {
  const conditions: ReturnType<typeof eq>[] = [];
  if (options.runId) conditions.push(eq(schema.project.evalTaskResults.runId, options.runId));
  if (options.taskId) conditions.push(eq(schema.project.evalTaskResults.taskId, options.taskId));
  if (options.status) conditions.push(eq(schema.project.evalTaskResults.status, options.status));
  const query = handle
    .select()
    .from(schema.project.evalTaskResults)
    .orderBy(asc(schema.project.evalTaskResults.createdAt), asc(schema.project.evalTaskResults.id));
  const rows = conditions.length > 0 ? await query.where(and(...conditions)) : await query;
  const limited = options.limit !== undefined ? rows.slice(0, options.limit) : rows;
  const offsetted = options.offset !== undefined ? limited.slice(options.offset) : limited;
  return offsetted.map(rowToResult);
}

/**
 * FNXC:EvalStore 2026-06-24-08:00:
 * Append a run event with an auto-incrementing seq. The seq is computed
 * as MAX(seq) + 1 inside a transaction to avoid gaps from concurrent appends.
 */
export async function appendEvalRunEvent(
  layer: AsyncDataLayer,
  input: { id: string; runId: string; type: string; message: string; status?: EvalRunStatus; taskId?: string; metadata?: Record<string, unknown> },
): Promise<EvalRunEvent> {
  return layer.transactionImmediate(async (tx) => {
    // FNXC:MultiProjectIsolation 2026-07-16-08:05: inherit the parent run's project_id
    // partition explicitly (see upsertEvalTaskResult) — the ambient GUC is not guaranteed
    // to match for unbound/bypass handles, and a mismatch breaks the composite parent FK.
    const runRows = await tx
      .select({ projectId: schema.project.evalRuns.projectId })
      .from(schema.project.evalRuns)
      .where(eq(schema.project.evalRuns.id, input.runId))
      .limit(1);
    const parentProjectId = runRows[0]?.projectId;
    if (!parentProjectId) throw new Error(`Eval run not found: ${input.runId}`);
    const seqRows = await tx
      .select({ maxSeq: sql<number | null>`max(${schema.project.evalRunEvents.seq})` })
      .from(schema.project.evalRunEvents)
      .where(eq(schema.project.evalRunEvents.runId, input.runId));
    const seq = (seqRows[0]?.maxSeq ?? 0) + 1;
    const createdAt = new Date().toISOString();
    await tx.insert(schema.project.evalRunEvents).values({
      projectId: parentProjectId,
      id: input.id,
      runId: input.runId,
      seq,
      type: input.type,
      message: input.message,
      status: input.status ?? null,
      taskId: input.taskId ?? null,
      metadata: input.metadata ?? null,
      createdAt,
    });
    return {
      id: input.id,
      runId: input.runId,
      seq,
      type: input.type as EvalRunEvent["type"],
      message: input.message,
      status: input.status,
      taskId: input.taskId,
      metadata: input.metadata,
      createdAt,
    };
  });
}

/**
 * List run events ordered by seq ASC.
 */
export async function listEvalRunEvents(handle: QueryHandle, runId: string): Promise<EvalRunEvent[]> {
  const rows = await handle
    .select()
    .from(schema.project.evalRunEvents)
    .where(eq(schema.project.evalRunEvents.runId, runId))
    .orderBy(asc(schema.project.evalRunEvents.seq), asc(schema.project.evalRunEvents.id));
  return rows.map(rowToEvent);
}

/**
 * FNXC:EvalStore 2026-06-27-12:25:
 * PostgreSQL-backed EvalStore — the AsyncDataLayer counterpart of the sync
 * SQLite `EvalStore` (eval-store.ts). It exposes the SAME public method names
 * the dashboard evals routes (/api/evals) call (`listRuns`, `getTaskResult`,
 * `listTaskResults`) plus the create/append helpers, so `getEvalStoreImpl`
 * returns this in backend mode instead of constructing the sync store (which
 * dereferences the absent SQLite handle and 500'd `/api/evals`). Id generation
 * mirrors the sync store's `ER-`/`ETR-`/`ERE-` formats and the create paths
 * preserve the active-run-conflict guard (EvalLifecycleError) for schedule/
 * task_completion triggers.
 *
 * Known gap vs the sync store: the sync EvalStore is an EventEmitter that emits
 * run:created/result:created/run:event for live SSE refresh and exposes
 * updateRun/updateTaskResult/deleteRun. This wrapper performs the read +
 * create/append surface the dashboard and integration tests exercise; mutating
 * lifecycle transitions remain on the sync engine path (instanceof-guarded).
 */
export class AsyncEvalStore {
  constructor(private readonly layer: AsyncDataLayer) {}

  async getRun(id: string): Promise<EvalRun | undefined> {
    return getEvalRun(this.layer.db, id);
  }

  async listRuns(options: EvalRunListOptions = {}): Promise<EvalRun[]> {
    return listEvalRuns(this.layer.db, options);
  }

  async createRun(input: EvalRunCreateInput): Promise<EvalRun> {
    const trigger = input.trigger ?? "manual";
    if ((trigger === "schedule" || trigger === "task_completion") && (await this.hasActiveRun(input.projectId, trigger))) {
      throw new EvalLifecycleError(
        `Active eval run already exists for project ${input.projectId} trigger ${trigger}`,
        "active_run_conflict",
      );
    }
    const now = new Date().toISOString();
    const requestedTaskIds = input.requestedTaskIds ?? [];
    const run = await createEvalRun(this.layer.db, {
      id: generateRunId(),
      projectId: input.projectId,
      trigger,
      scope: input.scope,
      window: (input.window ?? {}) as Record<string, unknown>,
      requestedTaskIds,
      counts: { totalTasks: requestedTaskIds.length, scoredTasks: 0, skippedTasks: 0, erroredTasks: 0 },
      provenance: input.provenance as Record<string, unknown> | undefined,
      metadata: input.metadata,
      createdAt: now,
      updatedAt: now,
    });
    return run;
  }

  /*
  FNXC:ScheduledEvalsPostgres 2026-07-14-01:41:
  PostgreSQL scheduled batches require one serialized lifecycle mutation per run. Hold a transaction-scoped run lock across the authoritative read, applyEvalRunUpdate validation, and persistence so concurrent terminal transitions cannot both validate a stale active row and the later writer cannot overwrite the committed terminal state. Preserve terminal immutability, transition validation, nullable clears, and metadata/provenance merge semantics through the shared helper.
  */
  async updateRun(id: string, input: EvalRunUpdateInput): Promise<EvalRun | undefined> {
    return this.layer.transactionImmediate(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`fusion:eval-run-update:${id}`}, 0))`,
      );
      const existing = await getEvalRun(tx, id);
      if (!existing) return undefined;
      const updated = applyEvalRunUpdate(existing, input);
      await persistEvalRun(tx, updated);
      return updated;
    });
  }

  async getTaskResult(id: string): Promise<EvalTaskResult | undefined> {
    return getEvalTaskResult(this.layer.db, id);
  }

  async listTaskResults(options: EvalTaskResultListOptions = {}): Promise<EvalTaskResult[]> {
    return listEvalTaskResults(this.layer.db, options);
  }

  async createTaskResult(runId: string, input: EvalTaskResultCreateInput): Promise<EvalTaskResult> {
    const run = await this.getRun(runId);
    if (!run) throw new Error(`Eval run not found: ${runId}`);
    const now = new Date().toISOString();
    const result: EvalTaskResult = {
      id: generateResultId(),
      runId,
      taskId: input.taskId,
      taskSnapshot: input.taskSnapshot,
      status: input.status,
      overallScore: input.overallScore,
      maxScore: input.maxScore,
      categoryScores: input.categoryScores ?? [],
      rationale: input.rationale,
      summary: input.summary,
      evidence: input.evidence ?? [],
      evidenceBundle: input.evidenceBundle,
      deterministicSignals: input.deterministicSignals ?? [],
      aiSignals: input.aiSignals,
      followUps: input.followUps ?? [],
      provenance: input.provenance,
      metadata: input.metadata,
      createdAt: now,
      updatedAt: now,
    };
    await upsertEvalTaskResult(this.layer.db, result);
    return (await getEvalTaskResultByRunTask(this.layer.db, runId, input.taskId)) ?? result;
  }

  async appendRunEvent(
    runId: string,
    event: Omit<EvalRunEvent, "id" | "runId" | "seq" | "createdAt">,
  ): Promise<EvalRunEvent> {
    const run = await this.getRun(runId);
    if (!run) throw new Error(`Eval run not found: ${runId}`);
    return appendEvalRunEvent(this.layer, {
      id: generateEventId(),
      runId,
      type: event.type,
      message: event.message,
      status: event.status,
      taskId: event.taskId,
      metadata: event.metadata,
    });
  }

  async listRunEvents(runId: string): Promise<EvalRunEvent[]> {
    return listEvalRunEvents(this.layer.db, runId);
  }

  private async hasActiveRun(projectId: string, trigger: string): Promise<boolean> {
    const runs = await listEvalRuns(this.layer.db, { projectId, trigger: trigger as EvalRun["trigger"] });
    return runs.some((run) => ACTIVE_EVAL_RUN_STATUSES.has(run.status));
  }
}
