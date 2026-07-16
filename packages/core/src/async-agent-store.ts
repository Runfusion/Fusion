/**
 * Async Drizzle AgentStore helpers (U6 satellite-fusiondir-stores).
 *
 * FNXC:AgentStore 2026-06-24-14:00:
 * Async equivalents of the sync SQLite AgentStore call sites in
 * agent-store.ts. AgentStore is a fusion-dir-owned satellite store: it takes a
 * `rootDir`, constructs its own `new Database(rootDir)` internally (with a
 * process-wide cache keyed by rootDir), and uses `db.prepare(sql).get/run/all()`
 * + `db.transactionImmediate()` + `db.bumpLastModified()`. These helpers target
 * the PostgreSQL project-schema tables via Drizzle and preserve the agent
 * lifecycle, heartbeat, run, task-session, API-key, config-revision, rating,
 * and blocked-state semantics.
 *
 * Tables covered (all under the `project` schema):
 *   - `agents`                 — agent records (data + metadata stored as jsonb)
 *   - `agent_heartbeats`       — heartbeat events (id is generated identity)
 *   - `agent_runs`             — structured heartbeat run records (data jsonb)
 *   - `agent_task_sessions`    — per (agentId, taskId) session data (jsonb)
 *   - `agent_api_keys`         — API key records (data jsonb, revokedAt)
 *   - `agent_config_revisions` — config revision history (data jsonb)
 *   - `agent_blocked_states`   — blocked-task dedup snapshots (data jsonb)
 *   - `agent_ratings`          — agent ratings (score CHECK 1..5)
 *
 * SQLite → PostgreSQL notes (VAL-SCHEMA-004):
 *   - The `data` and `metadata` columns on `agents` (and the `data` columns on
 *     the satellite tables) are `jsonb` in PostgreSQL, so Drizzle returns them
 *     already-parsed as JS values. The sync store used TEXT + JSON.stringify/
 *     parse; the helpers pass/read objects directly.
 *   - `agent_heartbeats.id` is an identity-generated integer primary key
 *     (AUTOINCREMENT equivalent). Inserts omit the `id` column.
 *   - The `agent_ratings.score` column has a CHECK constraint (BETWEEN 1 AND 5)
 *     preserved on PostgreSQL (VAL-SCHEMA-005).
 *   - The SQLite `INSERT ... ON CONFLICT(id) DO UPDATE` upserts map directly to
 *     Drizzle `insert().onConflictDoUpdate()`.
 *
 * Transition context (see library/satellite-store-migration-pattern.md):
 *   `getDatabase()` still returns the sync `Database` until the coordinated
 *   flip. The sync AgentStore keeps its sync path (the gate depends on it).
 *   These helpers are the async target the PostgreSQL integration tests
 *   consume. They program against the stable `AsyncDataLayer` interface (U4).
 *
 * Managed instruction bundle markdown files and run-scoped JSONL logs remain
 * on disk (they are edited as normal project files / append-only logs) and are
 * NOT part of this DB-layer migration.
 */
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import * as schema from "./postgres/schema/index.js";
import { projectOwnershipPartition, type AsyncDataLayer, type DbTransaction } from "./postgres/data-layer.js";
import type {
  Agent,
  AgentState,
  AgentCapability,
  AgentHeartbeatEvent,
  AgentHeartbeatRun,
  AgentTaskSession,
  AgentApiKey,
  AgentConfigRevision,
  AgentConfigSnapshot,
  AgentRating,
  AgentRatingInput,
  BlockedStateSnapshot,
} from "./types.js";

/** A query-capable handle: either the top-level db or a transaction handle. */
type QueryHandle = AsyncDataLayer["db"] | DbTransaction;

// ── Row shapes (camelCase column aliases via Drizzle) ──────────────────

interface AgentRow {
  id: string;
  name: string;
  role: string;
  state: string;
  taskId: string | null;
  createdAt: string;
  updatedAt: string;
  lastHeartbeatAt: string | null;
  metadata: Record<string, unknown> | null;
  data: Record<string, unknown> | null;
}

interface AgentHeartbeatRow {
  agentId: string;
  timestamp: string;
  status: string;
  runId: string;
}

interface AgentRatingRow {
  id: string;
  agentId: string;
  raterType: string;
  raterId: string | null;
  score: number;
  category: string | null;
  comment: string | null;
  runId: string | null;
  taskId: string | null;
  createdAt: string;
}

// ── Column selections ─────────────────────────────────────────────────

const agentColumns = {
  id: schema.project.agents.id,
  name: schema.project.agents.name,
  role: schema.project.agents.role,
  state: schema.project.agents.state,
  taskId: schema.project.agents.taskId,
  createdAt: schema.project.agents.createdAt,
  updatedAt: schema.project.agents.updatedAt,
  lastHeartbeatAt: schema.project.agents.lastHeartbeatAt,
  metadata: schema.project.agents.metadata,
  data: schema.project.agents.data,
};

const heartbeatColumns = {
  agentId: schema.project.agentHeartbeats.agentId,
  timestamp: schema.project.agentHeartbeats.timestamp,
  status: schema.project.agentHeartbeats.status,
  runId: schema.project.agentHeartbeats.runId,
};

const ratingColumns = {
  id: schema.project.agentRatings.id,
  agentId: schema.project.agentRatings.agentId,
  raterType: schema.project.agentRatings.raterType,
  raterId: schema.project.agentRatings.raterId,
  score: schema.project.agentRatings.score,
  category: schema.project.agentRatings.category,
  comment: schema.project.agentRatings.comment,
  runId: schema.project.agentRatings.runId,
  taskId: schema.project.agentRatings.taskId,
  createdAt: schema.project.agentRatings.createdAt,
};

// ── Agents ────────────────────────────────────────────────────────────

/**
 * FNXC:AgentStore 2026-06-24-14:05:
 * The agent's extended fields are persisted in the jsonb `data` column. This
 * helper builds the data payload from an Agent (mirrors sync writeAgent).
 */
export function agentToData(agent: Agent): Record<string, unknown> {
  return {
    id: agent.id,
    name: agent.name,
    role: agent.role,
    state: agent.state,
    taskId: agent.taskId,
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
    lastHeartbeatAt: agent.lastHeartbeatAt,
    metadata: agent.metadata,
    title: agent.title,
    icon: agent.icon,
    imageUrl: agent.imageUrl,
    reportsTo: agent.reportsTo,
    runtimeConfig: agent.runtimeConfig,
    pauseReason: agent.pauseReason,
    permissions: agent.permissions,
    permissionPolicy: agent.permissionPolicy,
    totalInputTokens: agent.totalInputTokens,
    totalOutputTokens: agent.totalOutputTokens,
    lastError: agent.lastError,
    instructionsPath: agent.instructionsPath,
    instructionsText: agent.instructionsText,
    soul: agent.soul,
    memory: agent.memory,
    bundleConfig: agent.bundleConfig,
    heartbeatProcedurePath: agent.heartbeatProcedurePath,
  };
}

/**
 * FNXC:AgentStore 2026-06-24-14:10:
 * Upsert an agent row (INSERT ... ON CONFLICT(id) DO UPDATE). The indexed
 * columns (name, role, state, taskId, createdAt, updatedAt, lastHeartbeatAt,
 * metadata, data) are all written. Non-destructive on the primary key.
 *
 * FNXC:MultiProjectIsolation 2026-07-16-12:15:
 * Bound project ids are written explicitly. Unbound (null/empty) writes leave
 * project_id empty so fusion_assign_project_id / the column DEFAULT can honor
 * the session GUC (`fusion.project_id`). Forcing projectOwnershipPartition's
 * `__legacy_unscoped__` fallback would override a valid GUC and hide the agent
 * from FORCE-RLS project-scoped reads (greptile P1 on PR #2229).
 */
export async function writeAgent(handle: QueryHandle, agent: Agent, projectId?: string | null): Promise<void> {
  const boundProjectId = projectId?.trim() || "";
  const data = agentToData(agent);
  await handle
    .insert(schema.project.agents)
    .values({
      projectId: boundProjectId,
      id: agent.id,
      name: agent.name,
      role: agent.role,
      state: agent.state,
      taskId: agent.taskId ?? null,
      createdAt: agent.createdAt,
      updatedAt: agent.updatedAt,
      lastHeartbeatAt: agent.lastHeartbeatAt ?? null,
      metadata: agent.metadata ?? {},
      data,
    })
    .onConflictDoUpdate({
      target: [schema.project.agents.projectId, schema.project.agents.id],
      set: {
        name: agent.name,
        role: agent.role,
        state: agent.state,
        taskId: agent.taskId ?? null,
        updatedAt: agent.updatedAt,
        lastHeartbeatAt: agent.lastHeartbeatAt ?? null,
        metadata: agent.metadata ?? {},
        data,
      },
    });
}

/**
 * Read a single agent by id, or null if not found.
 *
 * FNXC:AgentStore 2026-06-24-14:15:
 * The jsonb `data` column holds the extended fields; the indexed columns hold
 * the identity/state fields. The two are merged back into an Agent. The caller
 * is responsible for applying ephemeral/permission-policy normalization
 * (parseAgent in the sync store) — this helper returns the raw merged shape.
 */
export async function readAgent(handle: QueryHandle, agentId: string): Promise<Agent | null> {
  const rows = await handle
    .select(agentColumns)
    .from(schema.project.agents)
    .where(eq(schema.project.agents.id, agentId));
  const row = rows[0] as AgentRow | undefined;
  if (!row) return null;
  return mergeAgentRow(row);
}

/** Merge an agent row's indexed columns + jsonb data column into an Agent. */
export function mergeAgentRow(row: AgentRow): Agent {
  const data = (row.data ?? {}) as Partial<Agent>;
  return {
    ...(data as object),
    id: row.id,
    name: row.name,
    role: row.role as AgentCapability,
    state: row.state as AgentState,
    taskId: row.taskId ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastHeartbeatAt: row.lastHeartbeatAt ?? undefined,
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
  } as Agent;
}

/**
 * FNXC:AgentStore 2026-06-24-14:20:
 * List agents, optionally filtered by state/role. Ordered by createdAt DESC.
 * The caller applies ephemeral filtering (the sync listAgents filters out
 * ephemeral agents unless includeEphemeral is set).
 */
export async function listAgentRows(
  handle: QueryHandle,
  filter?: { state?: AgentState; role?: AgentCapability },
): Promise<Agent[]> {
  const conditions = [];
  if (filter?.state) {
    conditions.push(eq(schema.project.agents.state, filter.state));
  }
  if (filter?.role) {
    conditions.push(eq(schema.project.agents.role, filter.role));
  }
  const rows = await handle
    .select(agentColumns)
    .from(schema.project.agents)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(schema.project.agents.createdAt), desc(schema.project.agents.id));
  return rows.map((row) => mergeAgentRow(row as AgentRow));
}

/**
 * FNXC:AgentStore 2026-06-24-14:25:
 * Find the first non-ephemeral agent by exact name (newest first). The caller
 * supplies the ephemeral classifier predicate.
 */
export async function findAgentRowsByName(
  handle: QueryHandle,
  name: string,
): Promise<Agent[]> {
  const rows = await handle
    .select(agentColumns)
    .from(schema.project.agents)
    .where(eq(schema.project.agents.name, name))
    .orderBy(desc(schema.project.agents.createdAt), desc(schema.project.agents.id));
  return rows.map((row) => mergeAgentRow(row as AgentRow));
}

/**
 * Delete an agent by id. Cascading foreign keys remove heartbeats, runs,
 * task sessions, API keys, config revisions, and blocked states.
 */
export async function deleteAgent(handle: QueryHandle, agentId: string): Promise<boolean> {
  const result = await handle
    .delete(schema.project.agents)
    .where(eq(schema.project.agents.id, agentId))
    .returning({ id: schema.project.agents.id });
  return result.length > 0;
}

// ── Heartbeats ────────────────────────────────────────────────────────

/**
 * FNXC:AgentStore 2026-06-24-14:30:
 * Record a heartbeat event. The `id` column is identity-generated, so it is
 * omitted from the insert.
 */
export async function recordHeartbeat(
  handle: QueryHandle,
  event: { agentId: string; timestamp: string; status: AgentHeartbeatEvent["status"]; runId: string },
): Promise<AgentHeartbeatEvent> {
  await handle.insert(schema.project.agentHeartbeats).values({
    agentId: event.agentId,
    timestamp: event.timestamp,
    status: event.status,
    runId: event.runId,
  });
  return {
    timestamp: event.timestamp,
    status: event.status,
    runId: event.runId,
  };
}

/**
 * Get heartbeat history for an agent (newest first), capped at `limit`.
 */
export async function getHeartbeatHistory(
  handle: QueryHandle,
  agentId: string,
  limit = 50,
): Promise<AgentHeartbeatEvent[]> {
  const rows = await handle
    .select(heartbeatColumns)
    .from(schema.project.agentHeartbeats)
    .where(eq(schema.project.agentHeartbeats.agentId, agentId))
    .orderBy(desc(schema.project.agentHeartbeats.timestamp))
    .limit(limit);
  return (rows as AgentHeartbeatRow[]).map((row) => ({
    timestamp: row.timestamp,
    status: row.status as AgentHeartbeatEvent["status"],
    runId: row.runId,
  }));
}

// ── Runs ──────────────────────────────────────────────────────────────

/**
 * FNXC:AgentStore 2026-06-24-14:35:
 * Upsert a structured heartbeat run record (INSERT ... ON CONFLICT(id) DO UPDATE).
 */
export async function saveRun(handle: QueryHandle, projectId: string, run: AgentHeartbeatRun): Promise<void> {
  const ownership = projectOwnershipPartition(projectId);
  await handle
    .insert(schema.project.agentRuns)
    .values({
      projectId: ownership,
      id: run.id,
      agentId: run.agentId,
      data: run,
      startedAt: run.startedAt,
      endedAt: run.endedAt ?? null,
      status: run.status,
    })
    .onConflictDoUpdate({
      target: [schema.project.agentRuns.projectId, schema.project.agentRuns.id],
      set: {
        agentId: run.agentId,
        data: run,
        startedAt: run.startedAt,
        endedAt: run.endedAt ?? null,
        status: run.status,
      },
    });
}

/**
 * Get a specific run by id, or null if not found.
 */
export async function getRunDetail(
  handle: QueryHandle,
  projectId: string,
  agentId: string,
  runId: string,
): Promise<AgentHeartbeatRun | null> {
  const ownership = projectOwnershipPartition(projectId);
  const rows = await handle
    .select({ data: schema.project.agentRuns.data })
    .from(schema.project.agentRuns)
    .where(
      and(
        eq(schema.project.agentRuns.projectId, ownership),
        eq(schema.project.agentRuns.agentId, agentId),
        eq(schema.project.agentRuns.id, runId),
      ),
    );
  const row = rows[0];
  return (row?.data as AgentHeartbeatRun | undefined) ?? null;
}

/**
 * Get a run by id (any agent), returning the agentId + data. Used by
 * endHeartbeatRun which only has the runId.
 */
export async function getRunById(
  handle: QueryHandle,
  projectId: string,
  runId: string,
): Promise<{ agentId: string; run: AgentHeartbeatRun | null } | null> {
  const ownership = projectOwnershipPartition(projectId);
  const rows = await handle
    .select({
      agentId: schema.project.agentRuns.agentId,
      data: schema.project.agentRuns.data,
    })
    .from(schema.project.agentRuns)
    .where(and(eq(schema.project.agentRuns.projectId, ownership), eq(schema.project.agentRuns.id, runId)));
  const row = rows[0] as { agentId: string; data: Record<string, unknown> | null } | undefined;
  if (!row) return null;
  return { agentId: row.agentId, run: (row.data as AgentHeartbeatRun | null) ?? null };
}

/**
 * Get recent runs for an agent (newest first), capped at `limit`.
 */
export async function getRecentRuns(
  handle: QueryHandle,
  projectId: string,
  agentId: string,
  limit = 20,
): Promise<AgentHeartbeatRun[]> {
  const ownership = projectOwnershipPartition(projectId);
  const rows = await handle
    .select({ data: schema.project.agentRuns.data })
    .from(schema.project.agentRuns)
    .where(and(eq(schema.project.agentRuns.projectId, ownership), eq(schema.project.agentRuns.agentId, agentId)))
    .orderBy(desc(schema.project.agentRuns.startedAt))
    .limit(limit);
  return rows
    .map((row) => (row.data as AgentHeartbeatRun | null) ?? null)
    .filter((run): run is AgentHeartbeatRun => run !== null);
}

/**
 * FNXC:AgentStore 2026-06-24-14:40:
 * List every run currently in `status = 'active'` across all agents. Used by
 * self-healing to detect orphaned runs from prior process incarnations.
 */
export async function listActiveHeartbeatRuns(handle: QueryHandle, projectId: string): Promise<AgentHeartbeatRun[]> {
  const ownership = projectOwnershipPartition(projectId);
  const rows = await handle
    .select({ data: schema.project.agentRuns.data })
    .from(schema.project.agentRuns)
    .where(and(eq(schema.project.agentRuns.projectId, ownership), eq(schema.project.agentRuns.status, "active")))
    .orderBy(asc(schema.project.agentRuns.startedAt));
  return rows
    .map((row) => (row.data as AgentHeartbeatRun | null) ?? null)
    .filter((run): run is AgentHeartbeatRun => run !== null);
}
/**
 * FNXC:PostgresCutover 2026-07-04:
 * List every heartbeat run across all agents for mesh-snapshot capture.
 * Mirrors the SQLite `getAgentRunSnapshot` query: when `limit` is given the
 * rows come back newest-first (caller reverses to chronological); otherwise
 * they come back in ascending startedAt order. The deterministic `id`
 * tiebreaker replaces SQLite's `rowid` (Postgres has no rowid).
 */
export async function listAllAgentRuns(
  handle: QueryHandle,
  projectId: string,
  limit?: number,
): Promise<AgentHeartbeatRun[]> {
  const ownership = projectOwnershipPartition(projectId);
  const normalizedLimit =
    typeof limit === "number" && Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : undefined;
  const rows = normalizedLimit
    ? await handle
        .select({ data: schema.project.agentRuns.data })
        .from(schema.project.agentRuns)
        .where(eq(schema.project.agentRuns.projectId, ownership))
        .orderBy(desc(schema.project.agentRuns.startedAt), desc(schema.project.agentRuns.id))
        .limit(normalizedLimit)
    : await handle
        .select({ data: schema.project.agentRuns.data })
        .from(schema.project.agentRuns)
        .where(eq(schema.project.agentRuns.projectId, ownership))
        .orderBy(asc(schema.project.agentRuns.startedAt), asc(schema.project.agentRuns.id));
  return rows
    .map((row) => (row.data as AgentHeartbeatRun | null) ?? null)
    .filter((run): run is AgentHeartbeatRun => run !== null);
}


/**
 * Get aggregate run-status counts (completed/failed), optionally scoped to a
 * set of agent ids.
 */
export async function getRunStatusCounts(
  handle: QueryHandle,
  projectId: string,
  agentIds?: readonly string[],
): Promise<{ completedRuns: number; failedRuns: number }> {
  const ownership = projectOwnershipPartition(projectId);
  let rows: Array<{ status: string; count: number }>;
  if (agentIds && agentIds.length > 0) {
    rows = await handle
      .select({
        status: schema.project.agentRuns.status,
        count: sql<number>`count(*)::int`,
      })
      .from(schema.project.agentRuns)
      .where(and(eq(schema.project.agentRuns.projectId, ownership), inArray(schema.project.agentRuns.agentId, [...agentIds])))
      .groupBy(schema.project.agentRuns.status);
  } else {
    rows = await handle
      .select({
        status: schema.project.agentRuns.status,
        count: sql<number>`count(*)::int`,
      })
      .from(schema.project.agentRuns)
      .where(eq(schema.project.agentRuns.projectId, ownership))
      .groupBy(schema.project.agentRuns.status);
  }

  let completedRuns = 0;
  let failedRuns = 0;
  for (const row of rows) {
    if (row.status === "completed") completedRuns += row.count;
    else if (row.status === "failed" || row.status === "terminated") failedRuns += row.count;
  }
  return { completedRuns, failedRuns };
}

/**
 * Insert a run only if it does not already exist (INSERT OR IGNORE). Used by
 * legacy-file import. Returns true if a row was inserted.
 */
export async function insertRunIfAbsent(
  handle: QueryHandle,
  projectId: string,
  run: AgentHeartbeatRun,
): Promise<boolean> {
  const ownership = projectOwnershipPartition(projectId);
  const result = await handle
    .insert(schema.project.agentRuns)
    .values({
      projectId: ownership,
      id: run.id,
      agentId: run.agentId,
      data: run,
      startedAt: run.startedAt,
      endedAt: run.endedAt ?? null,
      status: run.status,
    })
    .onConflictDoNothing()
    .returning({ id: schema.project.agentRuns.id });
  return result.length > 0;
}

// ── Task Sessions ─────────────────────────────────────────────────────

/**
 * Get a task session for an agent, or null if not found.
 */
export async function getTaskSession(
  handle: QueryHandle,
  agentId: string,
  taskId: string,
): Promise<AgentTaskSession | null> {
  const rows = await handle
    .select({ data: schema.project.agentTaskSessions.data })
    .from(schema.project.agentTaskSessions)
    .where(
      and(
        eq(schema.project.agentTaskSessions.agentId, agentId),
        eq(schema.project.agentTaskSessions.taskId, taskId),
      ),
    );
  return (rows[0]?.data as AgentTaskSession | undefined) ?? null;
}

/**
 * FNXC:AgentStore 2026-06-24-14:45:
 * Upsert a task session (composite key agentId + taskId).
 */
export async function upsertTaskSession(
  handle: QueryHandle,
  session: AgentTaskSession,
): Promise<AgentTaskSession> {
  const now = new Date().toISOString();
  const existing = await getTaskSession(handle, session.agentId, session.taskId);
  const saved: AgentTaskSession = {
    ...session,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  await handle
    .insert(schema.project.agentTaskSessions)
    .values({
      agentId: session.agentId,
      taskId: session.taskId,
      data: saved,
      createdAt: saved.createdAt,
      updatedAt: saved.updatedAt,
    })
    .onConflictDoUpdate({
      target: [
        schema.project.agentTaskSessions.projectId,
        schema.project.agentTaskSessions.agentId,
        schema.project.agentTaskSessions.taskId,
      ],
      set: {
        data: saved,
        updatedAt: saved.updatedAt,
      },
    });
  return saved;
}

/**
 * Delete a task session by (agentId, taskId).
 */
export async function deleteTaskSession(
  handle: QueryHandle,
  agentId: string,
  taskId: string,
): Promise<void> {
  await handle
    .delete(schema.project.agentTaskSessions)
    .where(
      and(
        eq(schema.project.agentTaskSessions.agentId, agentId),
        eq(schema.project.agentTaskSessions.taskId, taskId),
      ),
    );
}

// ── API Keys ──────────────────────────────────────────────────────────

/**
 * List all API keys for an agent (oldest first), including revoked keys.
 */
export async function readApiKeys(
  handle: QueryHandle,
  agentId: string,
): Promise<AgentApiKey[]> {
  const rows = await handle
    .select({ data: schema.project.agentApiKeys.data })
    .from(schema.project.agentApiKeys)
    .where(eq(schema.project.agentApiKeys.agentId, agentId))
    .orderBy(asc(schema.project.agentApiKeys.createdAt));
  return rows
    .map((row) => (row.data as AgentApiKey | null) ?? null)
    .filter((key): key is AgentApiKey => key !== null);
}

/**
 * FNXC:AgentStore 2026-06-24-14:50:
 * Insert an API key row. The plaintext token is returned once by the caller;
 * only the hash is persisted in the jsonb data column.
 */
export async function insertApiKey(
  handle: QueryHandle,
  key: AgentApiKey,
): Promise<void> {
  await handle.insert(schema.project.agentApiKeys).values({
    id: key.id,
    agentId: key.agentId,
    data: key,
    createdAt: key.createdAt,
    revokedAt: key.revokedAt ?? null,
  });
}

/**
 * Update an API key's data + revokedAt timestamp (by id + agentId).
 */
export async function revokeApiKeyRow(
  handle: QueryHandle,
  keyId: string,
  agentId: string,
  revoked: AgentApiKey,
): Promise<void> {
  await handle
    .update(schema.project.agentApiKeys)
    .set({ data: revoked, revokedAt: revoked.revokedAt ?? null })
    .where(
      and(
        eq(schema.project.agentApiKeys.id, keyId),
        eq(schema.project.agentApiKeys.agentId, agentId),
      ),
    );
}

// ── Config Revisions ──────────────────────────────────────────────────

/**
 * Append a config revision row.
 */
export async function appendConfigRevision(
  handle: QueryHandle,
  revision: AgentConfigRevision,
): Promise<void> {
  await handle.insert(schema.project.agentConfigRevisions).values({
    id: revision.id,
    agentId: revision.agentId,
    data: revision,
    createdAt: revision.createdAt,
  });
}

/**
 * Read config revisions for an agent (oldest first).
 */
export async function readConfigRevisions(
  handle: QueryHandle,
  agentId: string,
): Promise<AgentConfigRevision[]> {
  const rows = await handle
    .select({ data: schema.project.agentConfigRevisions.data })
    .from(schema.project.agentConfigRevisions)
    .where(eq(schema.project.agentConfigRevisions.agentId, agentId))
    .orderBy(asc(schema.project.agentConfigRevisions.createdAt));
  return rows
    .map((row) => (row.data as AgentConfigRevision | null) ?? null)
    .filter((revision): revision is AgentConfigRevision => revision !== null);
}

/**
 * Find a config revision by id across all agents (for ownership checks).
 */
export async function findConfigRevisionById(
  handle: QueryHandle,
  revisionId: string,
): Promise<AgentConfigRevision | null> {
  const rows = await handle
    .select({ data: schema.project.agentConfigRevisions.data })
    .from(schema.project.agentConfigRevisions)
    .where(eq(schema.project.agentConfigRevisions.id, revisionId));
  return (rows[0]?.data as AgentConfigRevision | undefined) ?? null;
}

// ── Ratings ───────────────────────────────────────────────────────────

/**
 * FNXC:AgentStore 2026-06-24-14:55:
 * Add a rating. The `score` CHECK constraint (BETWEEN 1 AND 5) is enforced by
 * PostgreSQL (VAL-SCHEMA-005); a violation rejects the insert.
 */
export async function addRating(
  handle: QueryHandle,
  rating: AgentRating,
): Promise<AgentRating> {
  await handle.insert(schema.project.agentRatings).values({
    id: rating.id,
    agentId: rating.agentId,
    raterType: rating.raterType,
    raterId: rating.raterId ?? null,
    score: rating.score,
    category: rating.category ?? null,
    comment: rating.comment ?? null,
    runId: rating.runId ?? null,
    taskId: rating.taskId ?? null,
    createdAt: rating.createdAt,
  });
  return rating;
}

function mapRatingRow(row: AgentRatingRow): AgentRating {
  return {
    id: row.id,
    agentId: row.agentId,
    raterType: row.raterType as AgentRating["raterType"],
    raterId: row.raterId ?? undefined,
    score: row.score,
    category: row.category ?? undefined,
    comment: row.comment ?? undefined,
    runId: row.runId ?? undefined,
    taskId: row.taskId ?? undefined,
    createdAt: row.createdAt,
  };
}

/**
 * Get ratings for an agent (newest first), optionally filtered by category
 * and capped at `limit`.
 */
export async function getRatings(
  handle: QueryHandle,
  agentId: string,
  options?: { limit?: number; category?: string },
): Promise<AgentRating[]> {
  const conditions = [eq(schema.project.agentRatings.agentId, agentId)];
  if (options?.category !== undefined) {
    conditions.push(eq(schema.project.agentRatings.category, options.category));
  }
  const baseQuery = handle
    .select(ratingColumns)
    .from(schema.project.agentRatings)
    .where(and(...conditions))
    .orderBy(desc(schema.project.agentRatings.createdAt), desc(schema.project.agentRatings.id));
  const rows = options?.limit !== undefined
    ? await baseQuery.limit(options.limit)
    : await baseQuery;
  return (rows as AgentRatingRow[]).map(mapRatingRow);
}

/**
 * Delete a rating by id.
 */
export async function deleteRating(handle: QueryHandle, ratingId: string): Promise<boolean> {
  const result = await handle
    .delete(schema.project.agentRatings)
    .where(eq(schema.project.agentRatings.id, ratingId))
    .returning({ id: schema.project.agentRatings.id });
  return result.length > 0;
}

// ── Blocked States ────────────────────────────────────────────────────

/**
 * Get the most recently persisted blocked-task dedup state for an agent.
 */
export async function getLastBlockedState(
  handle: QueryHandle,
  agentId: string,
): Promise<BlockedStateSnapshot | null> {
  const rows = await handle
    .select({ data: schema.project.agentBlockedStates.data })
    .from(schema.project.agentBlockedStates)
    .where(eq(schema.project.agentBlockedStates.agentId, agentId));
  return (rows[0]?.data as BlockedStateSnapshot | undefined) ?? null;
}

/**
 * FNXC:AgentStore 2026-06-24-15:00:
 * Persist the latest blocked-task dedup state for an agent (upsert by agentId).
 */
export async function setLastBlockedState(
  handle: QueryHandle,
  agentId: string,
  state: BlockedStateSnapshot,
): Promise<void> {
  const updatedAt = new Date().toISOString();
  await handle
    .insert(schema.project.agentBlockedStates)
    .values({
      agentId,
      data: state,
      updatedAt,
    })
    .onConflictDoUpdate({
      target: [schema.project.agentBlockedStates.projectId, schema.project.agentBlockedStates.agentId],
      set: {
        data: state,
        updatedAt,
      },
    });
}

/**
 * Clear any persisted blocked-task dedup state for an agent.
 */
export async function clearLastBlockedState(
  handle: QueryHandle,
  agentId: string,
): Promise<void> {
  await handle
    .delete(schema.project.agentBlockedStates)
    .where(eq(schema.project.agentBlockedStates.agentId, agentId));
}

/**
 * Get all blocked states (agentId + state) ordered by updatedAt ASC, for
 * snapshot capture.
 */
export async function getAllBlockedStates(
  handle: QueryHandle,
): Promise<Array<{ agentId: string; state: BlockedStateSnapshot }>> {
  const rows = await handle
    .select({
      agentId: schema.project.agentBlockedStates.agentId,
      data: schema.project.agentBlockedStates.data,
      updatedAt: schema.project.agentBlockedStates.updatedAt,
    })
    .from(schema.project.agentBlockedStates)
    .orderBy(asc(schema.project.agentBlockedStates.updatedAt), asc(schema.project.agentBlockedStates.agentId));
  return rows
    .map((row) => {
      const state = (row.data as BlockedStateSnapshot | null) ?? null;
      return state ? { agentId: row.agentId, state } : null;
    })
    .filter((row): row is { agentId: string; state: BlockedStateSnapshot } => row !== null);
}

// ── __meta (migration markers) ────────────────────────────────────────

/**
 * FNXC:AgentStore 2026-06-24-15:05:
 * Read a __meta key value, or undefined if not present. Used by one-shot
 * migration guards (legacy file import, terminated-state migration,
 * heartbeat-procedure-path migration).
 */
export async function getMetaValue(
  handle: QueryHandle,
  key: string,
  projectId = "",
): Promise<string | undefined> {
  const ownership = projectOwnershipPartition(projectId);
  const rows = await handle
    .select({ value: schema.project.projectMeta.value })
    .from(schema.project.projectMeta)
    .where(and(
      eq(schema.project.projectMeta.projectId, ownership),
      eq(schema.project.projectMeta.key, key),
    ));
  return rows[0]?.value ?? undefined;
}

/**
 * Upsert a __meta key/value pair (migration completion marker).
 */
export async function upsertMetaValue(
  handle: QueryHandle,
  key: string,
  value: string,
  projectId = "",
): Promise<void> {
  /*
  FNXC:PostgresMultiProjectCutover 2026-07-14-11:18:
  Agent-store migration markers share the project schema but not project ownership. Include the bound project in their composite key; the empty binding remains the explicit project-agnostic compatibility partition.

  FNXC:ProjectDataIsolation 2026-07-14-18:30:
  Empty binding is the __legacy_unscoped__ quarantine (not literal ''), matching fusion_assign_project_id so subsequent getMetaValue finds the marker.
  */
  const ownership = projectOwnershipPartition(projectId);
  await handle
    .insert(schema.project.projectMeta)
    .values({ projectId: ownership, key, value })
    .onConflictDoUpdate({
      target: [schema.project.projectMeta.projectId, schema.project.projectMeta.key],
      set: { value },
    });
}

// Re-export commonly used types for callers constructing data via the helper.
export type {
  Agent,
  AgentHeartbeatEvent,
  AgentHeartbeatRun,
  AgentTaskSession,
  AgentApiKey,
  AgentConfigRevision,
  AgentConfigSnapshot,
  AgentRating,
  AgentRatingInput,
  BlockedStateSnapshot,
};
