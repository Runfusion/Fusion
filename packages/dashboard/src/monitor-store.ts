import { randomUUID } from "node:crypto";
import type { Database } from "@fusion/core";
import type { AsyncDataLayer } from "@fusion/core";
import {
  recordDeploymentAsync,
  resolveIncidentAsync,
  ingestIncidentSignalAsync,
} from "@fusion/core";

/**
 * U13 — Monitor stage storage + storm guard.
 *
 * Persists deployments (from CI/Ship events) and incidents (from U11 signals)
 * into the `deployments` / `incidents` tables (schema + migration 120 in
 * `packages/core/src/db.ts`). MTTR and deploy/incident counts are aggregated in
 * `packages/core/src/activity-analytics.ts` (`aggregateMonitorMetrics`) — this
 * module is the write side + the storm guard that decides when a regression
 * signal opens an auto-fix task.
 *
 * ## Storm guard (closes the loop without flooding the board)
 *
 * Production signals are bursty. The guard groups re-firing signals by the
 * U11 {@link Signal.groupingKey} and applies four gates before (and after) a
 * fix task is opened:
 *
 *  1. **Threshold / sustained-duration gate.** A single, instantly-self-clearing
 *     (flapping) alert does NOT open a task. An incident must accrue at least
 *     {@link StormGuardConfig.threshold} firings OR remain open for at least
 *     {@link StormGuardConfig.sustainedMs} before a fix task is created.
 *  2. **Cooldown / absorption.** While an incident for a groupingKey is open and
 *     already has a fix task, re-firing signals are *attached* to that existing
 *     incident/fix task (occurrence count bumps) rather than opening a new one.
 *     The existing fix task is looked up by its dedupe key, mirroring
 *     `findLatestByDedupeKey` in approval-request-store.ts.
 *  3. **Circuit breaker.** No more than {@link StormGuardConfig.maxTasksPerWindow}
 *     auto-fix tasks are created per {@link StormGuardConfig.windowMs}, capping a
 *     pathological storm that spans many distinct groupingKeys.
 *  4. **Self-loop guard.** A fix task Fusion itself opened never re-triggers the
 *     guard: signals whose grouping key resolves to a Fusion-opened fix task are
 *     absorbed, and the monitor trait skips tasks it already produced (mirrors
 *     U12's no-self-loop rule).
 */

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

interface DeploymentRow {
  id: number;
  deploymentId: string;
  service: string | null;
  environment: string | null;
  version: string | null;
  status: string | null;
  deployedAt: string;
  link: string | null;
  meta: string | null;
  createdAt: string;
}

interface IncidentRow {
  id: number;
  incidentId: string;
  groupingKey: string;
  title: string;
  severity: string | null;
  status: string;
  source: string | null;
  fixTaskId: string | null;
  openedAt: string;
  resolvedAt: string | null;
  link: string | null;
  meta: string | null;
  createdAt: string;
  updatedAt: string;
}

function parseMeta(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function deploymentFromRow(row: DeploymentRow): Deployment {
  return { ...row, meta: parseMeta(row.meta) };
}

function incidentFromRow(row: IncidentRow): Incident {
  return {
    ...row,
    status: row.status === "resolved" ? "resolved" : "open",
    meta: parseMeta(row.meta),
  };
}

/**
 * Occurrence count carried in an incident's `meta.occurrences`. Re-firing
 * signals bump this; the threshold gate reads it.
 */
const OCCURRENCES_META_KEY = "occurrences";
/** First-firing timestamp carried in `meta.firstFiredAt` for the sustained gate. */
const FIRST_FIRED_META_KEY = "firstFiredAt";

// ── Deployments ─────────────────────────────────────────────────────────────

/** Record a deployment (idempotent by `deploymentId`). */
export async function recordDeployment(db: Database | AsyncDataLayer, input: DeploymentInput): Promise<Deployment> {
  // FNXC:RuntimeSatelliteAsync 2026-06-24-13:20:
  // Backend mode: delegate to the async Drizzle helper (recordDeploymentAsync).
  // FNXC:MonitorStoreDiscriminator 2026-06-26-10:30:
  // P1 fix (review #17): the previous discriminator `"transactionImmediate" in db`
  // was broken because the SQLite `Database` class ALSO exposes
  // `transactionImmediate` (db.ts), so every SQLite instance routed to the
  // async path with a `DatabaseSync` as the Drizzle arg. The AsyncDataLayer
  // uniquely exposes `ping()` (the connectivity probe); SQLite `Database` does
  // not, so `"ping" in db` correctly distinguishes the two backends.
  if ("ping" in db) {
    return recordDeploymentAsync((db as AsyncDataLayer).db, input);
  }
  const sqliteDb = db as Database;
  const deploymentId = input.deploymentId?.trim() || `dep-${randomUUID()}`;
  const now = new Date().toISOString();
  const deployedAt = input.deployedAt ?? now;
  const meta = input.meta ? JSON.stringify(input.meta) : null;

  sqliteDb.prepare(
    `INSERT INTO deployments
       (deploymentId, service, environment, version, status, deployedAt, link, meta, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(deploymentId) DO UPDATE SET
       service = excluded.service,
       environment = excluded.environment,
       version = excluded.version,
       status = excluded.status,
       deployedAt = excluded.deployedAt,
       link = excluded.link,
       meta = excluded.meta`,
  ).run(
    deploymentId,
    input.service ?? null,
    input.environment ?? null,
    input.version ?? null,
    input.status ?? null,
    deployedAt,
    input.link ?? null,
    meta,
    now,
  );
  sqliteDb.bumpLastModified();

  const row = sqliteDb
    .prepare(`SELECT * FROM deployments WHERE deploymentId = ?`)
    .get(deploymentId) as DeploymentRow;
  return deploymentFromRow(row);
}

// ── Incidents ───────────────────────────────────────────────────────────────

/** Get the currently-open incident for a grouping key, if any. */
export function getOpenIncidentByGroupingKey(
  db: Database,
  groupingKey: string,
): Incident | null {
  const row = db
    .prepare(
      `SELECT * FROM incidents WHERE groupingKey = ? AND status = 'open'
       ORDER BY openedAt DESC, id DESC LIMIT 1`,
    )
    .get(groupingKey) as IncidentRow | undefined;
  return row ? incidentFromRow(row) : null;
}

export function getIncident(db: Database, incidentId: string): Incident | null {
  const row = db
    .prepare(`SELECT * FROM incidents WHERE incidentId = ?`)
    .get(incidentId) as IncidentRow | undefined;
  return row ? incidentFromRow(row) : null;
}

/**
 * Ingest an incident signal. If an open incident already exists for the grouping
 * key, the firing is ABSORBED into it (occurrence count + updatedAt bumped) —
 * this is the cooldown/dedup path. Otherwise a fresh `open` incident is created.
 * Returns the incident plus whether it was newly opened.
 *
 * FNXC:PostgresCutover 2026-06-28-09:00:
 * Backend dual-path (FN-6706 PG cutover): mirrors {@link resolveIncident}. In
 * backend mode the dashboard passes the AsyncDataLayer (`getAsyncLayer()`), which
 * uniquely exposes `ping()`; we delegate to `ingestIncidentSignalAsync`, writing
 * the schema-qualified `project.incidents` table (snake_case columns) via Drizzle.
 * The async path preserves the exact upsert/dedup semantics of the sync SQLite
 * path below: absorb a re-firing signal into the open incident for a grouping key
 * (bump `meta.occurrences` + `updatedAt`, preserve first `meta.firstFiredAt`), or
 * otherwise open a fresh `open` incident. Made async so callers must await.
 */
export async function ingestIncidentSignal(
  db: Database | AsyncDataLayer,
  input: IncidentSignalInput,
): Promise<{ incident: Incident; created: boolean }> {
  // FNXC:MonitorStoreDiscriminator 2026-06-28-09:00:
  // `"ping" in db` is unique to AsyncDataLayer (SQLite `Database` also exposes
  // `transactionImmediate`, so that earlier discriminator was broken). The async
  // helper returns the core `Incident` shape, structurally identical to this
  // module's `Incident`.
  if ("ping" in db) {
    return ingestIncidentSignalAsync((db as AsyncDataLayer).db, input) as Promise<{
      incident: Incident;
      created: boolean;
    }>;
  }
  const sqliteDb = db as Database;
  const now = input.at ?? new Date().toISOString();
  const existing = getOpenIncidentByGroupingKey(sqliteDb, input.groupingKey);

  if (existing) {
    // Absorb the re-firing signal into the open incident.
    const meta = existing.meta ?? {};
    const occurrences = Number(meta[OCCURRENCES_META_KEY] ?? 1) + 1;
    const nextMeta = {
      ...meta,
      ...(input.meta ?? {}),
      [OCCURRENCES_META_KEY]: occurrences,
      [FIRST_FIRED_META_KEY]: meta[FIRST_FIRED_META_KEY] ?? existing.openedAt,
    };
    sqliteDb.prepare(
      `UPDATE incidents SET updatedAt = ?, meta = ? WHERE incidentId = ?`,
    ).run(now, JSON.stringify(nextMeta), existing.incidentId);
    sqliteDb.bumpLastModified();
    const updated = getIncident(sqliteDb, existing.incidentId);
    return { incident: updated ?? existing, created: false };
  }

  const incidentId = `inc-${randomUUID()}`;
  const meta = {
    ...(input.meta ?? {}),
    [OCCURRENCES_META_KEY]: 1,
    [FIRST_FIRED_META_KEY]: now,
  };
  sqliteDb.prepare(
    `INSERT INTO incidents
       (incidentId, groupingKey, title, severity, status, source, fixTaskId, openedAt, resolvedAt, link, meta, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, 'open', ?, NULL, ?, NULL, ?, ?, ?, ?)`,
  ).run(
    incidentId,
    input.groupingKey,
    input.title,
    input.severity ?? null,
    input.source ?? null,
    now,
    input.link ?? null,
    JSON.stringify(meta),
    now,
    now,
  );
  sqliteDb.bumpLastModified();
  const incident = getIncident(sqliteDb, incidentId);
  if (!incident) throw new Error(`incident ${incidentId} not found after insert`);
  return { incident, created: true };
}

/**
 * Resolve an open incident for a grouping key (sets `status = resolved` +
 * `resolvedAt`). Returns the resolved incident, or null if none was open. The
 * resolution feeds MTTR via {@link aggregateMonitorMetrics}.
 *
 * FNXC:RuntimeSatelliteAsync 2026-06-24-13:25:
 * Backend dual-path: delegates to resolveIncidentAsync when AsyncDataLayer.
 */
export async function resolveIncident(
  db: Database | AsyncDataLayer,
  groupingKey: string,
  at?: string,
): Promise<Incident | null> {
  // FNXC:MonitorStoreDiscriminator 2026-06-26-10:30:
  // P1 fix (review #17): use `"ping" in db` (unique to AsyncDataLayer) instead
  // of the broken `"transactionImmediate" in db` (SQLite Database also has it).
  if ("ping" in db) {
    return resolveIncidentAsync((db as AsyncDataLayer).db, groupingKey, at);
  }
  const sqliteDb = db as Database;
  const open = getOpenIncidentByGroupingKey(sqliteDb, groupingKey);
  if (!open) return null;
  const now = at ?? new Date().toISOString();
  sqliteDb.prepare(
    `UPDATE incidents SET status = 'resolved', resolvedAt = ?, updatedAt = ? WHERE incidentId = ?`,
  ).run(now, now, open.incidentId);
  sqliteDb.bumpLastModified();
  return getIncident(sqliteDb, open.incidentId);
}

/**
 * Sentinel written to `fixTaskId` by {@link claimIncidentForFixTask} to reserve
 * an open incident BEFORE its fix task exists. It is overwritten with the real
 * task id by {@link attachFixTask} once the task is created. A claimed-but-not-
 * yet-attached incident is treated as already-linked by the storm guard
 * (`fixTaskId` is non-null), so a concurrent caller absorbs rather than creating
 * a duplicate. Distinguishable from a real task id by its prefix.
 */
export const FIX_TASK_CLAIM_SENTINEL_PREFIX = "claiming:";

/**
 * Atomically claim an open incident for fix-task creation. Performs a single
 * conditional UPDATE that sets `fixTaskId` to a sentinel only WHERE it is still
 * NULL, so exactly one concurrent caller can win the claim for a given incident.
 *
 * Returns true if THIS caller acquired the claim (and must therefore create +
 * {@link attachFixTask} the real task), false if another caller already claimed
 * or linked it (caller should absorb). This closes the create-then-link race:
 * the only interleaving point in `runMonitorOnRegression` is the `await` on task
 * creation, which now happens strictly AFTER an exclusive claim is held.
 */
export function claimIncidentForFixTask(db: Database, incidentId: string): boolean {
  const now = new Date().toISOString();
  const sentinel = `${FIX_TASK_CLAIM_SENTINEL_PREFIX}${incidentId}`;
  const result = db
    .prepare(
      `UPDATE incidents SET fixTaskId = ?, updatedAt = ?
       WHERE incidentId = ? AND fixTaskId IS NULL`,
    )
    .run(sentinel, now, incidentId) as { changes?: number | bigint };
  const claimed = Number(result.changes ?? 0) > 0;
  if (claimed) db.bumpLastModified();
  return claimed;
}

/** Attach a fix task id to an incident (records the loop-closure linkage). */
export function attachFixTask(db: Database, incidentId: string, fixTaskId: string): void {
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE incidents SET fixTaskId = ?, updatedAt = ? WHERE incidentId = ?`,
  ).run(fixTaskId, now, incidentId);
  db.bumpLastModified();
}

/**
 * FNXC:Monitor 2026-06-16-15:40: a fix-task claim must be released if task
 * creation fails so a stranded sentinel can't permanently absorb/suppress
 * future regressions. {@link claimIncidentForFixTask} writes a non-null sentinel
 * to `fixTaskId`; if {@link attachFixTask} never runs (createTask threw after the
 * claim), the incident would stay pseudo-linked forever — every later regression
 * would absorb against the sentinel and the circuit-breaker count would include
 * it. This releases the claim back to NULL, but ONLY when the value is STILL the
 * exact sentinel, so it can never clobber a real attached task id (the
 * `WHERE fixTaskId = <sentinel>` guard rejects any already-attached row).
 *
 * Returns true if a sentinel was actually cleared.
 */
export function releaseIncidentFixTaskClaim(db: Database, incidentId: string): boolean {
  const now = new Date().toISOString();
  const sentinel = `${FIX_TASK_CLAIM_SENTINEL_PREFIX}${incidentId}`;
  const result = db
    .prepare(
      `UPDATE incidents SET fixTaskId = NULL, updatedAt = ?
       WHERE incidentId = ? AND fixTaskId = ?`,
    )
    .run(now, incidentId, sentinel) as { changes?: number | bigint };
  const released = Number(result.changes ?? 0) > 0;
  if (released) db.bumpLastModified();
  return released;
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
 * Decide what to do with an ingested incident, per the storm guard. Pure given
 * the incident's current state (occurrences / first-fired / fixTaskId) plus a
 * count of recently-created tasks for the circuit breaker.
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
 * Count auto-fix tasks created within the circuit-breaker window. An auto-fix
 * task is one linked to an incident (fixTaskId set) whose incident updatedAt is
 * within the window. This is a deliberately coarse proxy that does not require a
 * separate audit table.
 *
 * FNXC:Monitor 2026-06-16-15:40: the circuit-breaker count must ignore in-flight
 * and stranded sentinel placeholders. {@link claimIncidentForFixTask} writes a
 * `${FIX_TASK_CLAIM_SENTINEL_PREFIX}…` sentinel into `fixTaskId` BEFORE the real
 * task exists; the real id overwrites it synchronously right after createTask, so
 * excluding sentinels here only discounts the brief in-flight window and the
 * stranded-claim case (creation failed) — exactly the rows that should not count
 * against the breaker. Loser-absorption is unaffected: a loser absorbs because
 * {@link decideStormGuard} sees the SPECIFIC incident's non-null `fixTaskId`, or
 * because its claim attempt lost — never because of this window count.
 */
export function countRecentAutoFixTasks(
  db: Database,
  config: StormGuardConfig = DEFAULT_STORM_GUARD,
  nowMs: number = Date.now(),
): number {
  const cutoff = new Date(nowMs - config.windowMs).toISOString();
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count FROM incidents
       WHERE fixTaskId IS NOT NULL AND fixTaskId NOT LIKE ? AND updatedAt >= ?`,
    )
    .get(`${FIX_TASK_CLAIM_SENTINEL_PREFIX}%`, cutoff) as { count: number };
  return row.count;
}
