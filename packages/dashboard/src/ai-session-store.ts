/**
 * AI Session Store
 *
 * Persists long-running AI session state (planning, subtask breakdown,
 * mission interview) to SQLite so users can dismiss modals and return
 * later — even from a different browser.
 *
 * The in-memory session Maps in planning.ts / subtask-breakdown.ts /
 * mission-interview.ts remain the source of truth for live agent state.
 * This store is the persistence shadow, updated at each state transition.
 */

import { EventEmitter } from "node:events";
import type { Database } from "@fusion/core";

// ── Types ───────────────────────────────────────────────────────────────

export type AiSessionType = "planning" | "subtask" | "mission_interview";
export type AiSessionStatus = "generating" | "awaiting_input" | "complete" | "error";

export interface AiSessionRow {
  id: string;
  type: AiSessionType;
  status: AiSessionStatus;
  title: string;
  inputPayload: string;            // JSON string
  conversationHistory: string;     // JSON string: [{question, response}]
  currentQuestion: string | null;  // JSON string or null
  result: string | null;           // JSON string or null
  thinkingOutput: string;
  error: string | null;
  projectId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Summary returned by listActive (omits large fields) */
export interface AiSessionSummary {
  id: string;
  type: AiSessionType;
  status: AiSessionStatus;
  title: string;
  projectId: string | null;
  updatedAt: string;
}

export interface AiSessionStoreEvents {
  "ai_session:updated": [AiSessionSummary];
  "ai_session:deleted": [string]; // session id
}

// ── Constants ───────────────────────────────────────────────────────────

/** Max stored thinking output (50 KB). Older content trimmed from front. */
const MAX_THINKING_BYTES = 50 * 1024;

/** Debounce interval for thinking-only writes (ms). */
const THINKING_DEBOUNCE_MS = 2000;

// ── Store ───────────────────────────────────────────────────────────────

export class AiSessionStore extends EventEmitter<AiSessionStoreEvents> {
  /** Pending debounce timers for thinking-only writes, keyed by session id. */
  private thinkingTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Interval used for periodic stale-session cleanup. */
  private cleanupTimer: ReturnType<typeof setInterval> | undefined;

  constructor(private db: Database) {
    super();
  }

  // ── CRUD ────────────────────────────────────────────────────────────

  /**
   * Insert or update an AI session row.
   * Emits `ai_session:updated` after writing.
   */
  upsert(session: AiSessionRow): void {
    const now = new Date().toISOString();
    const thinking = trimThinking(session.thinkingOutput);

    this.db
      .prepare(
        `INSERT INTO ai_sessions (id, type, status, title, inputPayload, conversationHistory, currentQuestion, result, thinkingOutput, error, projectId, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           status = excluded.status,
           title = excluded.title,
           conversationHistory = excluded.conversationHistory,
           currentQuestion = excluded.currentQuestion,
           result = excluded.result,
           thinkingOutput = excluded.thinkingOutput,
           error = excluded.error,
           updatedAt = excluded.updatedAt`,
      )
      .run(
        session.id,
        session.type,
        session.status,
        session.title,
        session.inputPayload,
        session.conversationHistory,
        session.currentQuestion ?? null,
        session.result ?? null,
        thinking,
        session.error ?? null,
        session.projectId ?? null,
        session.createdAt || now,
        now,
      );

    // Cancel any pending thinking debounce for this session
    this.clearThinkingTimer(session.id);

    this.emit("ai_session:updated", toSummary(session, now));
  }

  /**
   * Update only the thinkingOutput field, debounced to reduce write frequency.
   * Flushes immediately if `flush` is true (e.g. on status transition).
   */
  updateThinking(sessionId: string, thinkingOutput: string, flush = false): void {
    if (flush) {
      this.clearThinkingTimer(sessionId);
      this.writeThinking(sessionId, thinkingOutput);
      return;
    }

    // Debounce: reset timer
    this.clearThinkingTimer(sessionId);
    const timer = setTimeout(() => {
      this.thinkingTimers.delete(sessionId);
      this.writeThinking(sessionId, thinkingOutput);
    }, THINKING_DEBOUNCE_MS);
    this.thinkingTimers.set(sessionId, timer);
  }

  /**
   * Fetch a single session by ID. Returns null if not found.
   */
  get(id: string): AiSessionRow | null {
    const row = this.db
      .prepare("SELECT * FROM ai_sessions WHERE id = ?")
      .get(id) as unknown as AiSessionRow | undefined;
    return row ?? null;
  }

  /**
   * Atomically update only status/error for an existing session.
   * Returns false when the session does not exist.
   */
  updateStatus(id: string, status: AiSessionStatus, error?: string): boolean {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE ai_sessions
         SET status = ?, error = ?, updatedAt = ?
         WHERE id = ?`,
      )
      .run(status, error ?? null, now, id) as { changes?: number };

    const changed = Number(result.changes ?? 0) > 0;
    if (!changed) {
      return false;
    }

    const row = this.get(id);
    if (row) {
      this.emit("ai_session:updated", toSummary(row, row.updatedAt));
    }

    return true;
  }

  /**
   * Lightweight heartbeat for active sessions.
   * Updates only `updatedAt` and intentionally does NOT emit
   * `ai_session:updated` to avoid high-frequency SSE broadcasts.
   */
  ping(id: string): boolean {
    const now = new Date().toISOString();
    const result = this.db
      .prepare("UPDATE ai_sessions SET updatedAt = ? WHERE id = ?")
      .run(now, id) as { changes?: number };

    return Number(result.changes ?? 0) > 0;
  }

  /**
   * List active/retryable sessions (generating, awaiting_input, or error).
   * Optionally filtered by projectId.
   */
  listActive(projectId?: string): AiSessionSummary[] {
    if (projectId) {
      return this.db
        .prepare(
          `SELECT id, type, status, title, projectId, updatedAt FROM ai_sessions
           WHERE status IN ('generating', 'awaiting_input', 'error') AND projectId = ?
           ORDER BY updatedAt DESC`,
        )
        .all(projectId) as unknown as AiSessionSummary[];
    }
    return this.db
      .prepare(
        `SELECT id, type, status, title, projectId, updatedAt FROM ai_sessions
         WHERE status IN ('generating', 'awaiting_input', 'error')
         ORDER BY updatedAt DESC`,
      )
      .all() as unknown as AiSessionSummary[];
  }

  /**
   * List recoverable sessions for in-memory rehydration.
   * Returns full rows for sessions still in progress.
   */
  listRecoverable(projectId?: string): AiSessionRow[] {
    if (projectId) {
      return this.db
        .prepare(
          `SELECT * FROM ai_sessions
           WHERE status IN ('generating', 'awaiting_input') AND projectId = ?
           ORDER BY updatedAt DESC`,
        )
        .all(projectId) as unknown as AiSessionRow[];
    }

    return this.db
      .prepare(
        `SELECT * FROM ai_sessions
         WHERE status IN ('generating', 'awaiting_input')
         ORDER BY updatedAt DESC`,
      )
      .all() as unknown as AiSessionRow[];
  }

  /**
   * Delete a session by ID. Emits `ai_session:deleted`.
   */
  delete(id: string): void {
    this.clearThinkingTimer(id);
    this.db.prepare("DELETE FROM ai_sessions WHERE id = ?").run(id);
    this.emit("ai_session:deleted", id);
  }

  /**
   * Recover sessions after server restart.
   * - `generating` sessions with a currentQuestion -> `awaiting_input`
   * - `generating` sessions without -> `error`
   */
  recoverStaleSessions(): number {
    const now = new Date().toISOString();
    let recovered = 0;

    // Sessions that were generating and had a pending question — recoverable
    const withQuestion = this.db
      .prepare(
        `UPDATE ai_sessions SET status = 'awaiting_input', updatedAt = ?
         WHERE status = 'generating' AND currentQuestion IS NOT NULL`,
      )
      .run(now);
    recovered += Number((withQuestion as any).changes ?? 0);

    // Sessions that were generating with no question — unrecoverable
    const withoutQuestion = this.db
      .prepare(
        `UPDATE ai_sessions SET status = 'error', error = 'Session interrupted — please restart', updatedAt = ?
         WHERE status = 'generating' AND currentQuestion IS NULL`,
      )
      .run(now);
    recovered += Number((withoutQuestion as any).changes ?? 0);

    if (recovered > 0) {
      console.log(`[ai-session-store] Recovered ${recovered} stale sessions after restart`);
    }
    return recovered;
  }

  /**
   * Clean up stale sessions older than the given age (ms).
   *
   * For stale in-progress sessions (`generating`, `awaiting_input`), status is first
   * transitioned to `error` with a "Session expired" marker before deletion.
   * Returns the number of deleted sessions.
   */
  cleanupOld(maxAgeMs: number): number {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();

    const stale = this.db
      .prepare(
        `SELECT id FROM ai_sessions
         WHERE updatedAt < ?
           AND status IN ('complete', 'error', 'generating', 'awaiting_input')`,
      )
      .all(cutoff) as Array<{ id: string }>;

    if (stale.length === 0) {
      return 0;
    }

    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE ai_sessions
           SET status = 'error',
               error = CASE
                 WHEN error IS NULL OR error = '' THEN 'Session expired'
                 ELSE error
               END
           WHERE updatedAt < ?
             AND status IN ('generating', 'awaiting_input')`,
        )
        .run(cutoff);

      this.db
        .prepare(
          `DELETE FROM ai_sessions
           WHERE updatedAt < ?
             AND status IN ('complete', 'error', 'generating', 'awaiting_input')`,
        )
        .run(cutoff);
    });

    for (const { id } of stale) {
      this.clearThinkingTimer(id);
      this.emit("ai_session:deleted", id);
    }

    return stale.length;
  }

  /**
   * Start periodic stale-session cleanup using the provided schedule and TTL.
   */
  startScheduledCleanup(cleanupIntervalMs: number, ttlMs: number): void {
    this.stopScheduledCleanup();

    const runCleanup = () => {
      try {
        const deleted = this.cleanupOld(ttlMs);
        if (deleted > 0) {
          console.log(`[ai-session-store] Cleaned up ${deleted} stale sessions`);
        }
      } catch (err) {
        console.error("[ai-session-store] Scheduled cleanup failed:", err);
      }
    };

    this.cleanupTimer = setInterval(runCleanup, cleanupIntervalMs);
    this.cleanupTimer.unref?.();
  }

  /**
   * Stop periodic stale-session cleanup if currently running.
   */
  stopScheduledCleanup(): void {
    if (!this.cleanupTimer) {
      return;
    }
    clearInterval(this.cleanupTimer);
    this.cleanupTimer = undefined;
  }

  // ── Internal ────────────────────────────────────────────────────────

  private writeThinking(sessionId: string, thinkingOutput: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare("UPDATE ai_sessions SET thinkingOutput = ?, updatedAt = ? WHERE id = ?")
      .run(trimThinking(thinkingOutput), now, sessionId);
  }

  private clearThinkingTimer(id: string): void {
    const timer = this.thinkingTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.thinkingTimers.delete(id);
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

function trimThinking(output: string): string {
  if (output.length <= MAX_THINKING_BYTES) return output;
  return output.slice(output.length - MAX_THINKING_BYTES);
}

function toSummary(session: AiSessionRow, updatedAt: string): AiSessionSummary {
  return {
    id: session.id,
    type: session.type,
    status: session.status,
    title: session.title,
    projectId: session.projectId,
    updatedAt,
  };
}
