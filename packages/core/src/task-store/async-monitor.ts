/**
 * Async Drizzle monitor-store helpers (U15).
 *
 * FNXC:Monitor 2026-06-24-13:00:
 * Async equivalents of the sync SQLite monitor-store functions in
 * `packages/dashboard/src/monitor-store.ts`. These helpers target the
 * PostgreSQL `project.deployments` and `project.incidents` tables via Drizzle,
 * and program against the stable `AsyncDataLayer` interface (U4) — not the
 * underlying driver. They preserve the monitor-stage storage and storm-guard
 * semantics:
 *
 *   - Deployments are idempotent upserts keyed by `deploymentId`.
 *   - Incident ingest absorbs re-firing signals into the open incident for a
 *     grouping key (occurrence count + updatedAt bumped), otherwise creates a
 *     fresh `open` incident.
 *   - The atomic incident-level fix-task claim (`claimIncidentForFixTask`) uses
 *     a conditional UPDATE (`WHERE fixTaskId IS NULL`) so exactly one concurrent
 *     caller wins, closing the create-then-link race.
 *   - The circuit-breaker count excludes stranded sentinel placeholders.
 *
 * Transition context (see library/async-data-layer-notes.md):
 *   `getDatabase()` still returns the sync `Database` until the satellite-store
 *   sub-features complete and flip the accessor. The dashboard monitor-store
 *   keeps its sync path (the gate depends on it). These helpers are the async
 *   target the migrating dashboard store and the PostgreSQL integration tests
 *   consume.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, isNull, notLike, sql } from "drizzle-orm";
import * as schema from "../postgres/schema/index.js";
import type { AsyncDataLayer, DbTransaction } from "../postgres/data-layer.js";

/** A recorded deployment row. */
export interface Deployment {
  id: number;
  deploymentId: string;
  service: string | null;
  environment: string | null;
  version: string | null;
  status: string | null;
  deployedAt: string;
  link: string | null;
  meta: Record<string, unknown> | null;
  createdAt: string;
}

/** Input to record a deployment (from a CI/Ship event). */
export interface DeploymentInput {
  /** Stable provider id; used for idempotent upsert. Generated if absent. */
  deploymentId?: string;
  service?: string;
  environment?: string;
  version?: string;
  status?: string;
  /** ISO-8601; defaults to now. */
  deployedAt?: string;
  link?: string;
  meta?: Record<string, unknown>;
}

export type IncidentStatus = "open" | "resolved";

/** A recorded incident row. */
export interface Incident {
  id: number;
  incidentId: string;
  groupingKey: string;
  title: string;
  severity: string | null;
  status: IncidentStatus;
  source: string | null;
  fixTaskId: string | null;
  openedAt: string;
  resolvedAt: string | null;
  link: string | null;
  meta: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

/** Input to open / re-fire an incident from a normalized signal. */
export interface IncidentSignalInput {
  groupingKey: string;
  title: string;
  severity?: string;
  source?: string;
  link?: string;
  meta?: Record<string, unknown>;
  /** Event timestamp (ISO-8601); defaults to now. */
  at?: string;
}

/**
 * Occurrence count carried in an incident's `meta.occurrences`. Re-firing
 * signals bump this; the threshold gate reads it.
 */
const OCCURRENCES_META_KEY = "occurrences";
/** First-firing timestamp carried in `meta.firstFiredAt` for the sustained gate. */
const FIRST_FIRED_META_KEY = "firstFiredAt";

/**
 * Sentinel written to `fixTaskId` by {@link claimIncidentForFixTaskAsync} to
 * reserve an open incident BEFORE its fix task exists. Distinguishable from a
 * real task id by its prefix.
 */
export const FIX_TASK_CLAIM_SENTINEL_PREFIX = "claiming:";

/**
 * FNXC:MonitorProjectIsolation 2026-07-14-12:35:
 * Every monitor read and mutation must use the same explicit project partition. Legacy direct helper callers without a bound AsyncDataLayer are quarantined consistently instead of writing an empty project ID that the database trigger rewrites behind their subsequent reads.
 */
function monitorProjectPartition(projectId: string): string {
  return projectId.trim() || "__legacy_unscoped__";
}

// ── Row mappers ──────────────────────────────────────────────────────────────

/**
 * FNXC:Monitor 2026-06-24-13:05:
 * PostgreSQL stores `meta` as jsonb; Drizzle returns it as an already-parsed
 * JS value (object/null), so no JSON.parse is needed (unlike the SQLite text
 * path). Normalize to `Record<string, unknown> | null`.
 */
function normalizeMeta(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function deploymentFromRow(row: typeof schema.project.deployments.$inferSelect): Deployment {
  return {
    id: row.id,
    deploymentId: row.deploymentId,
    service: row.service,
    environment: row.environment,
    version: row.version,
    status: row.status,
    deployedAt: row.deployedAt,
    link: row.link,
    meta: normalizeMeta(row.meta),
    createdAt: row.createdAt,
  };
}

function incidentFromRow(row: typeof schema.project.incidents.$inferSelect): Incident {
  return {
    id: row.id,
    incidentId: row.incidentId,
    groupingKey: row.groupingKey,
    title: row.title,
    severity: row.severity,
    status: row.status === "resolved" ? "resolved" : "open",
    source: row.source,
    fixTaskId: row.fixTaskId,
    openedAt: row.openedAt,
    resolvedAt: row.resolvedAt,
    link: row.link,
    meta: normalizeMeta(row.meta),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ── Deployments ─────────────────────────────────────────────────────────────

/**
 * FNXC:Monitor 2026-06-24-13:10:
 * Record a deployment (idempotent by `deploymentId`). This is the async
 * equivalent of the sync `recordDeployment` in monitor-store.ts. The upsert
 * uses `ON CONFLICT (deployment_id) DO UPDATE` so re-recording the same
 * deployment updates its fields rather than creating a duplicate.
 *
 * @param db The Drizzle instance (or transaction handle) from the AsyncDataLayer.
 * @param input The deployment input.
 * @param projectId The owning project partition; dashboard callers pass the bound AsyncDataLayer project ID.
 *
 * FNXC:MonitorAnalyticsIsolation 2026-07-14-01:04:
 * Monitor writes must persist tenant ownership so bound deployment and incident analytics can filter without inferring ownership from provider identifiers.
 */
export async function recordDeploymentAsync(
  db: AsyncDataLayer["db"] | DbTransaction,
  input: DeploymentInput,
  projectId = "",
): Promise<Deployment> {
  const ownerProjectId = monitorProjectPartition(projectId);
  const deploymentId = input.deploymentId?.trim() || `dep-${randomUUID()}`;
  const now = new Date().toISOString();
  const deployedAt = input.deployedAt ?? now;

  await db
    .insert(schema.project.deployments)
    .values({
      projectId: ownerProjectId,
      deploymentId,
      service: input.service ?? null,
      environment: input.environment ?? null,
      version: input.version ?? null,
      status: input.status ?? null,
      deployedAt,
      link: input.link ?? null,
      meta: input.meta ?? null,
      createdAt: now,
    })
    .onConflictDoUpdate({
      target: [schema.project.deployments.projectId, schema.project.deployments.deploymentId],
      set: {
        service: input.service ?? null,
        environment: input.environment ?? null,
        version: input.version ?? null,
        status: input.status ?? null,
        deployedAt,
        link: input.link ?? null,
        meta: input.meta ?? null,
      },
    });

  const rows = await db
    .select()
    .from(schema.project.deployments)
    .where(and(eq(schema.project.deployments.projectId, ownerProjectId), eq(schema.project.deployments.deploymentId, deploymentId)));
  const row = rows[0];
  if (!row) throw new Error(`deployment ${deploymentId} not found after upsert`);
  return deploymentFromRow(row);
}

// ── Incidents ───────────────────────────────────────────────────────────────

/**
 * Get the currently-open incident for a grouping key, if any.
 *
 * @param db The Drizzle instance (or transaction handle) from the AsyncDataLayer.
 * @param groupingKey The signal grouping key.
 */
export async function getOpenIncidentByGroupingKeyAsync(
  db: AsyncDataLayer["db"] | DbTransaction,
  groupingKey: string,
  projectId = "",
): Promise<Incident | null> {
  const ownerProjectId = monitorProjectPartition(projectId);
  const rows = await db
    .select()
    .from(schema.project.incidents)
    .where(and(eq(schema.project.incidents.projectId, ownerProjectId), eq(schema.project.incidents.groupingKey, groupingKey), eq(schema.project.incidents.status, "open")))
    .orderBy(desc(schema.project.incidents.openedAt), desc(schema.project.incidents.id))
    .limit(1);
  return rows[0] ? incidentFromRow(rows[0]) : null;
}

/**
 * Get a single incident by its incident id.
 *
 * @param db The Drizzle instance (or transaction handle) from the AsyncDataLayer.
 * @param incidentId The incident id.
 */
export async function getIncidentAsync(
  db: AsyncDataLayer["db"] | DbTransaction,
  incidentId: string,
  projectId = "",
): Promise<Incident | null> {
  const ownerProjectId = monitorProjectPartition(projectId);
  const rows = await db
    .select()
    .from(schema.project.incidents)
    .where(and(eq(schema.project.incidents.projectId, ownerProjectId), eq(schema.project.incidents.incidentId, incidentId)))
    .limit(1);
  return rows[0] ? incidentFromRow(rows[0]) : null;
}

/**
 * FNXC:Monitor 2026-06-24-13:15:
 * Ingest an incident signal. If an open incident already exists for the grouping
 * key, the firing is ABSORBED into it (occurrence count + updatedAt bumped) —
 * this is the cooldown/dedup path. Otherwise a fresh `open` incident is created.
 * Returns the incident plus whether it was newly opened.
 *
 * This is the async equivalent of the sync `ingestIncidentSignal`. The two-step
 * read-then-write (absorb-or-create) preserves the storm-guard semantics; the
 * atomic claim step (`claimIncidentForFixTaskAsync`) closes the create-then-link
 * race for concurrent regression ingests that both pass the gate.
 *
 * @param db The Drizzle instance (or transaction handle) from the AsyncDataLayer.
 * @param input The incident signal input.
 */
export async function ingestIncidentSignalAsync(
  db: AsyncDataLayer["db"] | DbTransaction,
  input: IncidentSignalInput,
  projectId = "",
): Promise<{ incident: Incident; created: boolean }> {
  const ownerProjectId = monitorProjectPartition(projectId);
  const now = input.at ?? new Date().toISOString();
  const existing = await getOpenIncidentByGroupingKeyAsync(db, input.groupingKey, ownerProjectId);

  if (existing) {
    // Absorb the re-firing signal into the open incident.
    const meta = existing.meta ?? {};
    const occurrences = Number(meta[OCCURRENCES_META_KEY] ?? 1) + 1;
    const nextMeta: Record<string, unknown> = {
      ...meta,
      ...(input.meta ?? {}),
      [OCCURRENCES_META_KEY]: occurrences,
      [FIRST_FIRED_META_KEY]: meta[FIRST_FIRED_META_KEY] ?? existing.openedAt,
    };
    await db
      .update(schema.project.incidents)
      .set({ updatedAt: now, meta: nextMeta })
      .where(and(eq(schema.project.incidents.projectId, ownerProjectId), eq(schema.project.incidents.incidentId, existing.incidentId)));
    const updated = await getIncidentAsync(db, existing.incidentId, ownerProjectId);
    return { incident: updated ?? existing, created: false };
  }

  const incidentId = `inc-${randomUUID()}`;
  const meta: Record<string, unknown> = {
    ...(input.meta ?? {}),
    [OCCURRENCES_META_KEY]: 1,
    [FIRST_FIRED_META_KEY]: now,
  };
  await db.insert(schema.project.incidents).values({
    projectId: ownerProjectId,
    incidentId,
    groupingKey: input.groupingKey,
    title: input.title,
    severity: input.severity ?? null,
    status: "open",
    source: input.source ?? null,
    fixTaskId: null,
    openedAt: now,
    resolvedAt: null,
    link: input.link ?? null,
    meta,
    createdAt: now,
    updatedAt: now,
  });
  const incident = await getIncidentAsync(db, incidentId, ownerProjectId);
  if (!incident) throw new Error(`incident ${incidentId} not found after insert`);
  return { incident, created: true };
}

/**
 * Resolve an open incident for a grouping key (sets `status = resolved` +
 * `resolvedAt`). Returns the resolved incident, or null if none was open.
 *
 * @param db The Drizzle instance (or transaction handle) from the AsyncDataLayer.
 * @param groupingKey The signal grouping key.
 * @param at Optional resolution timestamp (ISO-8601); defaults to now.
 */
export async function resolveIncidentAsync(
  db: AsyncDataLayer["db"] | DbTransaction,
  groupingKey: string,
  at?: string,
  projectId = "",
): Promise<Incident | null> {
  const ownerProjectId = monitorProjectPartition(projectId);
  const open = await getOpenIncidentByGroupingKeyAsync(db, groupingKey, ownerProjectId);
  if (!open) return null;
  const now = at ?? new Date().toISOString();
  await db
    .update(schema.project.incidents)
    .set({ status: "resolved", resolvedAt: now, updatedAt: now })
    .where(and(eq(schema.project.incidents.projectId, ownerProjectId), eq(schema.project.incidents.incidentId, open.incidentId)));
  return getIncidentAsync(db, open.incidentId, ownerProjectId);
}

/**
 * FNXC:Monitor 2026-06-24-13:20:
 * Atomically claim an open incident for fix-task creation. Performs a single
 * conditional UPDATE that sets `fixTaskId` to a sentinel only WHERE it is still
 * NULL, so exactly one concurrent caller can win the claim for a given incident.
 *
 * Returns true if THIS caller acquired the claim (and must therefore create +
 * {@link attachFixTaskAsync} the real task), false if another caller already
 * claimed or linked it (caller should absorb). This closes the create-then-link
 * race: the only interleaving point in `runMonitorOnRegression` is the `await`
 * on task creation, which now happens strictly AFTER an exclusive claim is held.
 *
 * The PostgreSQL conditional UPDATE (`WHERE fixTaskId IS NULL`) is atomic and
 * row-level-locked under MVCC, so two concurrent callers cannot both win; the
 * `changes` count (rowCount) tells each caller whether it acquired the claim.
 *
 * @param db The Drizzle instance (or transaction handle) from the AsyncDataLayer.
 * @param incidentId The incident to claim.
 */
export async function claimIncidentForFixTaskAsync(
  db: AsyncDataLayer["db"] | DbTransaction,
  incidentId: string,
  projectId = "",
): Promise<boolean> {
  const ownerProjectId = monitorProjectPartition(projectId);
  const now = new Date().toISOString();
  const sentinel = `${FIX_TASK_CLAIM_SENTINEL_PREFIX}${incidentId}`;
  const result = await db
    .update(schema.project.incidents)
    .set({ fixTaskId: sentinel, updatedAt: now })
    .where(and(eq(schema.project.incidents.projectId, ownerProjectId), eq(schema.project.incidents.incidentId, incidentId), isNull(schema.project.incidents.fixTaskId)))
    .returning({ id: schema.project.incidents.id });
  return result.length > 0;
}

/**
 * Attach a fix task id to an incident (records the loop-closure linkage).
 *
 * @param db The Drizzle instance (or transaction handle) from the AsyncDataLayer.
 * @param incidentId The incident to attach the fix task to.
 * @param fixTaskId The fix task id.
 */
export async function attachFixTaskAsync(
  db: AsyncDataLayer["db"] | DbTransaction,
  incidentId: string,
  fixTaskId: string,
  projectId = "",
): Promise<void> {
  const ownerProjectId = monitorProjectPartition(projectId);
  const now = new Date().toISOString();
  await db
    .update(schema.project.incidents)
    .set({ fixTaskId, updatedAt: now })
    .where(and(eq(schema.project.incidents.projectId, ownerProjectId), eq(schema.project.incidents.incidentId, incidentId)));
}

/**
 * FNXC:Monitor 2026-06-24-13:25:
 * Release a stranded fix-task claim. A fix-task claim must be released if task
 * creation fails so a stranded sentinel can't permanently absorb/suppress future
 * regressions. {@link claimIncidentForFixTaskAsync} writes a non-null sentinel to
 * `fixTaskId`; if {@link attachFixTaskAsync} never runs (createTask threw after
 * the claim), the incident would stay pseudo-linked forever. This releases the
 * claim back to NULL, but ONLY when the value is STILL the exact sentinel, so it
 * can never clobber a real attached task id.
 *
 * Returns true if a sentinel was actually cleared.
 *
 * @param db The Drizzle instance (or transaction handle) from the AsyncDataLayer.
 * @param incidentId The incident whose claim should be released.
 */
export async function releaseIncidentFixTaskClaimAsync(
  db: AsyncDataLayer["db"] | DbTransaction,
  incidentId: string,
  projectId = "",
): Promise<boolean> {
  const ownerProjectId = monitorProjectPartition(projectId);
  const now = new Date().toISOString();
  const sentinel = `${FIX_TASK_CLAIM_SENTINEL_PREFIX}${incidentId}`;
  const result = await db
    .update(schema.project.incidents)
    .set({ fixTaskId: null, updatedAt: now })
    .where(and(eq(schema.project.incidents.projectId, ownerProjectId), eq(schema.project.incidents.incidentId, incidentId), eq(schema.project.incidents.fixTaskId, sentinel)))
    .returning({ id: schema.project.incidents.id });
  return result.length > 0;
}

// ── Storm guard ───────────────────────────────────────────────────────────────

export interface StormGuardConfig {
  /** Minimum firings before a fix task is opened (threshold gate). */
  threshold: number;
  /** Minimum open-duration (ms) that alternatively satisfies the gate. */
  sustainedMs: number;
  /** Circuit breaker: max auto-fix tasks created per {@link windowMs}. */
  maxTasksPerWindow: number;
  /** Circuit-breaker window (ms). */
  windowMs: number;
}

export const DEFAULT_STORM_GUARD: StormGuardConfig = {
  threshold: 3,
  sustainedMs: 5 * 60_000,
  maxTasksPerWindow: 10,
  windowMs: 60 * 60_000,
};

export type StormGuardDecision =
  | { action: "open-fix-task"; incident: Incident }
  | { action: "absorb"; incident: Incident; existingFixTaskId: string | null; reason: string }
  | { action: "suppress"; incident: Incident; reason: string };

/**
 * FNXC:Monitor 2026-06-24-13:30:
 * Decide what to do with an ingested incident, per the storm guard. Pure given
 * the incident's current state (occurrences / first-fired / fixTaskId) plus a
 * count of recently-created tasks for the circuit breaker. This is the async
 * equivalent of the sync `decideStormGuard` — identical logic, ported verbatim
 * so the storm-guard semantics are preserved across the backend swap.
 *
 *  - If the incident already has a fix task → ABSORB (cooldown / no self-loop).
 *  - If the threshold/sustained gate is not yet met → SUPPRESS (flapping guard).
 *  - If the circuit breaker is tripped → SUPPRESS.
 *  - Otherwise → OPEN-FIX-TASK.
 */
export function decideStormGuard(
  incident: Incident,
  recentAutoTaskCount: number,
  config: StormGuardConfig = DEFAULT_STORM_GUARD,
  nowMs: number = Date.now(),
): StormGuardDecision {
  // Already linked to a fix task → absorb repeats (cooldown + no self-loop).
  if (incident.fixTaskId) {
    return {
      action: "absorb",
      incident,
      existingFixTaskId: incident.fixTaskId,
      reason: "existing-fix-task",
    };
  }

  const meta = incident.meta ?? {};
  const occurrences = Number(meta[OCCURRENCES_META_KEY] ?? 1);
  const firstFired = String(meta[FIRST_FIRED_META_KEY] ?? incident.openedAt);
  const firstFiredMs = Date.parse(firstFired);
  const openMs = Number.isFinite(firstFiredMs) ? nowMs - firstFiredMs : 0;

  const gatePassed =
    occurrences >= config.threshold || openMs >= config.sustainedMs;
  if (!gatePassed) {
    return {
      action: "suppress",
      incident,
      reason: `gate-not-met (occurrences=${occurrences}, openMs=${openMs})`,
    };
  }

  // Circuit breaker: cap auto-created tasks per window.
  if (recentAutoTaskCount >= config.maxTasksPerWindow) {
    return { action: "suppress", incident, reason: "circuit-breaker" };
  }

  return { action: "open-fix-task", incident };
}

/**
 * FNXC:Monitor 2026-06-24-13:35:
 * Count auto-fix tasks created within the circuit-breaker window. An auto-fix
 * task is one linked to an incident (fixTaskId set) whose incident updatedAt is
 * within the window. The count ignores in-flight and stranded sentinel
 * placeholders (`fixTaskId NOT LIKE 'claiming:%'`) so a stranded claim does not
 * count against the breaker.
 *
 * @param db The Drizzle instance (or transaction handle) from the AsyncDataLayer.
 * @param config The storm-guard config (defaults to DEFAULT_STORM_GUARD).
 * @param nowMs The current time in ms (defaults to Date.now()).
 */
export async function countRecentAutoFixTasksAsync(
  db: AsyncDataLayer["db"] | DbTransaction,
  config: StormGuardConfig = DEFAULT_STORM_GUARD,
  nowMs: number = Date.now(),
  projectId = "",
): Promise<number> {
  const ownerProjectId = monitorProjectPartition(projectId);
  const cutoff = new Date(nowMs - config.windowMs).toISOString();
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.project.incidents)
    .where(
      and(
        eq(schema.project.incidents.projectId, ownerProjectId),
        sql`${schema.project.incidents.fixTaskId} IS NOT NULL`,
        notLike(schema.project.incidents.fixTaskId, `${FIX_TASK_CLAIM_SENTINEL_PREFIX}%`),
        gte(schema.project.incidents.updatedAt, cutoff),
      ),
    );
  return Number(rows[0]?.count ?? 0);
}

/**
 * FNXC:Monitor 2026-06-24-13:40:
 * Count open incidents for the monitor metrics surface (open-incidents count).
 * Kept here so the async monitor helpers are self-contained for metrics reads
 * that the dashboard health/metrics routes need without going through the sync
 * `aggregateMonitorMetrics` path.
 *
 * @param db The Drizzle instance (or transaction handle) from the AsyncDataLayer.
 */
export async function countOpenIncidentsAsync(
  db: AsyncDataLayer["db"] | DbTransaction,
  projectId = "",
): Promise<number> {
  const ownerProjectId = monitorProjectPartition(projectId);
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.project.incidents)
    .where(and(eq(schema.project.incidents.projectId, ownerProjectId), eq(schema.project.incidents.status, "open")));
  return Number(rows[0]?.count ?? 0);
}
