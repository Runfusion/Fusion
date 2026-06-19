import type { Database } from "./db.js";

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
 * Pure and synchronous: takes a {@link Database} handle and returns plain data.
 * `capturedAt` defaults to `new Date().toISOString()`; pass `now` (epoch ms) to
 * make the timestamp deterministic in tests — no other value reads the clock.
 */
export function composeLiveSnapshot(db: Database, now?: number): LiveSnapshot {
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

  // Current per-column task counts. `column` is a reserved word in the schema,
  // so it is quoted.
  const columnRows = db
    .prepare(
      `SELECT "column" AS column, COUNT(*) AS count
       FROM tasks
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
