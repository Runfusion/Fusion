import { sql } from "drizzle-orm";
import type { Database } from "./db.js";
import type { AsyncDataLayer } from "./postgres/data-layer.js";

/**
 * Live Mission-Control snapshot composer (U6a).
 *
 * Builds an instantaneous, point-in-time view of orchestration activity from the
 * existing tables — `agentRuns` / `agentHeartbeats` (active heartbeat runs),
 * `cli_sessions` (live CLI/chat sessions), and `tasks` (current per-column
 * counts). It is a **pure read** over a {@link Database} handle: no clock, no
 * network, no engine dependency, so the engine, CLI, and the dashboard route
 * (U9) can all reuse it. The dashboard's `/api/command-center/live` endpoint is a
 * thin adapter over this function (KTD2).
 *
 * "Live" here means *current state*, not a date range: it counts what is active
 * right now (active runs, live sessions) and the present board distribution. The
 * snapshot carries a `capturedAt` ISO timestamp so callers can label staleness.
 *
 * Active definitions:
 *  - **Active session** — a `cli_sessions` row whose `agentState` is not a
 *    terminal state (`done`/`dead`) and whose `terminationReason` is still null.
 *  - **Active run** — an `agentRuns` row with `status = 'active'` (matching the
 *    {@link import("./types.js").AgentHeartbeatRun} status union).
 *  - **Active node** — a distinct, non-null node id observed across active
 *    sessions (no `nodeId` column exists on `agentRuns`, so nodes are sourced
 *    from `cli_sessions`).
 */

/** A single active CLI/chat session in the live snapshot. */
export interface LiveSession {
  id: string;
  /** Bound task id, or null for an unbound (e.g. chat) session. */
  taskId: string | null;
  purpose: string;
  adapterId: string;
  agentState: string;
  /** Worktree/node path the session runs in, or null. */
  worktreePath: string | null;
  updatedAt: string;
}

/** A single active heartbeat run in the live snapshot. */
export interface LiveRun {
  id: string;
  agentId: string;
  taskId: string | null;
  startedAt: string;
}

/** Current task count for one board column. */
export interface ColumnCount {
  column: string;
  count: number;
}

/** The composed live Mission-Control snapshot. */
export interface LiveSnapshot {
  /** ISO-8601 timestamp this snapshot was composed. */
  capturedAt: string;
  /** Number of active (non-terminal, non-terminated) CLI/chat sessions. */
  activeSessions: number;
  /** Number of active heartbeat runs (`agentRuns.status = 'active'`). */
  activeRuns: number;
  /** Distinct non-null nodes with at least one active session. */
  activeNodes: number;
  /** The active sessions, most-recently-updated first. */
  sessions: LiveSession[];
  /** The active heartbeat runs, most-recently-started first. */
  runs: LiveRun[];
  /** Current per-column task counts (the SDLC funnel's live snapshot). */
  columns: ColumnCount[];
}

/** Terminal CLI agent states — a session in one of these is not "active". */
const TERMINAL_SESSION_STATES = ["done", "dead"] as const;

interface SessionRow {
  id: string;
  taskId: string | null;
  purpose: string;
  adapterId: string;
  agentState: string;
  worktreePath: string | null;
  updatedAt: string;
}

interface ColumnRow {
  column: string;
  count: number;
}

interface CountRow {
  count: number;
}

/**
 * Compose a live Mission-Control snapshot from the current database state.
 *
 * Takes a {@link Database} handle (sync SQLite) or an {@link AsyncDataLayer}
 * (PostgreSQL backend mode) and returns plain data. `capturedAt` defaults to
 * `new Date().toISOString()`; pass `now` (epoch ms) to make the timestamp
 * deterministic in tests — no other value reads the clock.
 *
 * FNXC:PostgresCommandCenterAnalytics 2026-06-28-09:30:
 * Now async and `Database | AsyncDataLayer`. In backend mode it branches on
 * `"ping" in dbOrLayer` and reads schema-qualified `project.*` (cli_sessions,
 * agent_runs, tasks) with snake_case columns; the sync SQLite branch is
 * unchanged. agent_runs.data is jsonb (already parsed) so taskId is read
 * directly rather than via JSON.parse.
 */
export async function composeLiveSnapshot(
  dbOrLayer: Database | AsyncDataLayer,
  now?: number,
): Promise<LiveSnapshot> {
  if ("ping" in dbOrLayer) {
    return composeLiveSnapshotAsync(dbOrLayer, now);
  }
  const db = dbOrLayer as Database;
  const capturedAt = new Date(now ?? Date.now()).toISOString();

  const terminalPlaceholders = TERMINAL_SESSION_STATES.map(() => "?").join(", ");

  // Active sessions: not in a terminal state and not terminated.
  const sessionRows = db
    .prepare(
      `SELECT id, taskId, purpose, adapterId, agentState, worktreePath, updatedAt
       FROM cli_sessions
       WHERE agentState NOT IN (${terminalPlaceholders})
         AND terminationReason IS NULL
       ORDER BY updatedAt DESC`,
    )
    .all(...TERMINAL_SESSION_STATES) as SessionRow[];
  const sessions: LiveSession[] = sessionRows.map((r) => ({
    id: r.id,
    taskId: r.taskId ?? null,
    purpose: r.purpose,
    adapterId: r.adapterId,
    agentState: r.agentState,
    worktreePath: r.worktreePath ?? null,
    updatedAt: r.updatedAt,
  }));

  // Active nodes: distinct non-null worktree paths across active sessions.
  // (cli_sessions has no nodeId column; worktreePath is the per-node locator.)
  const activeNodes = new Set(
    sessions
      .map((s) => s.worktreePath)
      .filter((p): p is string => typeof p === "string" && p.length > 0),
  ).size;

  // Active heartbeat runs.
  const runRows = db
    .prepare(
      `SELECT id, agentId, startedAt, data
       FROM agentRuns
       WHERE status = 'active'
       ORDER BY startedAt DESC`,
    )
    .all() as Array<{ id: string; agentId: string; startedAt: string; data: string }>;
  const runs: LiveRun[] = runRows.map((r) => {
    let taskId: string | null = null;
    try {
      const data = JSON.parse(r.data) as { taskId?: string };
      if (typeof data.taskId === "string") taskId = data.taskId;
    } catch {
      // Malformed run data → leave taskId null rather than throw.
    }
    return { id: r.id, agentId: r.agentId, taskId, startedAt: r.startedAt };
  });

  const activeRuns = (
    db
      .prepare(`SELECT COUNT(*) AS count FROM agentRuns WHERE status = 'active'`)
      .get() as CountRow
  ).count;

  /*
  FNXC:LiveActivity 2026-08-03-00:00:
  FN-8429 requires current board metrics to exclude soft-deleted tasks. Live
  readers obey VAL-DATA-005, so archived/deleted rows cannot inflate the
  Overview or Mission Control stage counts after their board lifecycle ends.
  */
  // Current per-column task counts. `column` is a reserved word in the schema,
  // so it is quoted.
  const columnRows = db
    .prepare(
      `SELECT "column" AS column, COUNT(*) AS count
       FROM tasks
       WHERE deletedAt IS NULL
       GROUP BY "column"
       ORDER BY count DESC`,
    )
    .all() as ColumnRow[];
  const columns: ColumnCount[] = columnRows.map((r) => ({
    column: r.column,
    count: r.count,
  }));

  return {
    capturedAt,
    activeSessions: sessions.length,
    activeRuns,
    activeNodes,
    sessions,
    runs,
    columns,
  };
}

/**
 * FNXC:PostgresCommandCenterAnalytics 2026-06-28-09:30:
 * PostgreSQL fetch path for {@link composeLiveSnapshot}. Mirrors the sync branch
 * one-for-one: active (non-terminal, non-terminated) cli_sessions, active
 * agent_runs (data is jsonb — taskId read directly), distinct active worktree
 * nodes, and the present per-column task distribution. Both storage backends
 * filter soft-deleted tasks under VAL-DATA-005 so deleted rows cannot become
 * live funnel work.
 */
async function composeLiveSnapshotAsync(layer: AsyncDataLayer, now?: number): Promise<LiveSnapshot> {
  const capturedAt = new Date(now ?? Date.now()).toISOString();
  /*
  FNXC:PostgresCommandCenterAnalytics 2026-07-14-00:49:
  An unbound live Command Center layer is deliberately project-agnostic. Sessions, heartbeat runs, and board-column counts must all omit the project predicate together, while an explicitly bound layer remains isolated to its project.
  */
  const projectScope = layer.projectId !== undefined
    ? sql`AND project_id = ${layer.projectId}`
    : sql``;

  const sessionRows = (await layer.db.execute(
    sql`SELECT id,
               task_id        AS "taskId",
               purpose,
               adapter_id     AS "adapterId",
               agent_state    AS "agentState",
               worktree_path  AS "worktreePath",
               updated_at     AS "updatedAt"
        FROM project.cli_sessions
        WHERE agent_state NOT IN ('done', 'dead')
          ${projectScope}
          AND termination_reason IS NULL
        ORDER BY updated_at DESC`,
  )) as Array<Record<string, unknown>>;
  const sessions: LiveSession[] = sessionRows.map((r) => ({
    id: String(r.id),
    taskId: (r.taskId as string | null) ?? null,
    purpose: String(r.purpose),
    adapterId: String(r.adapterId),
    agentState: String(r.agentState),
    worktreePath: (r.worktreePath as string | null) ?? null,
    updatedAt: String(r.updatedAt),
  }));

  const activeNodes = new Set(
    sessions
      .map((s) => s.worktreePath)
      .filter((p): p is string => typeof p === "string" && p.length > 0),
  ).size;

  const runRows = (await layer.db.execute(
    sql`SELECT id, agent_id AS "agentId", started_at AS "startedAt", data
        FROM project.agent_runs
        WHERE status = 'active' ${projectScope}
        ORDER BY started_at DESC`,
  )) as Array<{ id: string; agentId: string; startedAt: string; data: unknown }>;
  const runs: LiveRun[] = runRows.map((r) => {
    let taskId: string | null = null;
    // agent_runs.data is jsonb (already parsed); read taskId without JSON.parse.
    const data = r.data as { taskId?: unknown } | null;
    if (data && typeof data.taskId === "string") taskId = data.taskId;
    return { id: String(r.id), agentId: String(r.agentId), taskId, startedAt: String(r.startedAt) };
  });
  const activeRuns = runs.length;

  const columnRows = (await layer.db.execute(
    sql`SELECT "column" AS column, count(*)::int AS count
        FROM project.tasks
        WHERE deleted_at IS NULL ${projectScope}
        GROUP BY "column"
        ORDER BY count DESC`,
  )) as Array<{ column: string; count: number }>;
  const columns: ColumnCount[] = columnRows.map((r) => ({
    column: String(r.column),
    count: Number(r.count),
  }));

  return {
    capturedAt,
    activeSessions: sessions.length,
    activeRuns,
    activeNodes,
    sessions,
    runs,
    columns,
  };
}
