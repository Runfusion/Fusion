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
import { THINKING_LEVELS, type Database, type AsyncDataLayer, type ThinkingLevel } from "@fusion/core";
import {
  upsertAiSession,
  getAiSession,
  listActiveAiSessions,
  listAllAiSessions,
  listRecoverableAiSessions,
  updateAiSessionStatus,
  updateAiSessionTitle,
  markDraftSummarized as markDraftSummarizedAsync,
  updateDraft as updateDraftAsync,
  pingAiSession,
  updateThinkingAsync,
  archiveAiSession,
  unarchiveAiSession,
  acquireAiSessionLock,
  releaseAiSessionLock,
  forceAcquireAiSessionLock,
  getAiSessionLockHolder,
  releaseStaleAiSessionLocks,
  deleteAiSession,
  deleteAiSessionByIdAndType,
  recoverStaleAiSessions,
  cleanupOldAiSessions,
  cleanupStaleAiSessions,
} from "@fusion/core";
import { createSessionDiagnostics } from "./ai-session-diagnostics.js";

// ── Types ───────────────────────────────────────────────────────────────

export type AiSessionType = "planning" | "subtask" | "mission_interview" | "milestone_interview" | "slice_interview";
export type AiSessionStatus = "generating" | "awaiting_input" | "complete" | "error" | "draft";

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
  lockedByTab: string | null;
  lockedAt: string | null;
  /** 1 if archived (hidden from planning sidebar), 0 otherwise. */
  archived?: number;
}

/** Summary returned by listActive (omits large fields) */
export interface AiSessionSummary {
  id: string;
  type: AiSessionType;
  status: AiSessionStatus;
  title: string;
  /**
   * For draft planning sessions only: a short, derived preview of the
   * persisted initialPlan so the sidebar can distinguish multiple drafts
   * before the user has started any of them. Computed at read time from
   * inputPayload — never persisted as the title — so unfinished keystrokes
   * don't end up baked into the row's permanent title.
   */
  preview?: string;
  projectId: string | null;
  lockedByTab: string | null;
  updatedAt: string;
  archived?: boolean;
}

/** Max characters of initialPlan surfaced as a sidebar preview for drafts. */
const DRAFT_PREVIEW_MAX_CHARS = 80;

export interface AiSessionStoreEvents {
  "ai_session:updated": [AiSessionSummary];
  "ai_session:deleted": [string]; // session id
}

// ── Constants ───────────────────────────────────────────────────────────

/** Max stored thinking output (50 KB). Older content trimmed from front. */
const MAX_THINKING_BYTES = 50 * 1024;

/** Debounce interval for thinking-only writes (ms). */
const THINKING_DEBOUNCE_MS = 2000;

/** Default max age before stale AI sessions are eligible for cleanup (7 days). */
export const SESSION_CLEANUP_DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Default scheduled interval for stale session cleanup runs (6 hours). */
export const SESSION_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * FNXC:AiSessionStore 2026-07-13-00:00:
 * FN-7949 — deleting a Planning Mode session while its background generation
 * is still in flight let the session silently reappear. Root cause:
 * `runGenerationWithTimeout` (planning.ts) and the equivalent wrappers in
 * subtask-breakdown.ts/mission-interview.ts/milestone-slice-interview.ts use
 * `Promise.race([operation(...), abortPromise])` to abort generation — that
 * only stops the *caller* from awaiting `operation`, it does NOT cancel the
 * underlying `session.agent.session.prompt()` call. If the session is deleted
 * while that promise is still pending, the abandoned call later resolves and
 * calls `persistSession(...)` -> `upsert()`, which used to unconditionally
 * re-INSERT the row and re-emit `ai_session:updated`, resurrecting a session
 * the user explicitly deleted.
 *
 * Fix: `AiSessionStore` remembers deleted ids in a bounded-TTL tombstone map.
 * `upsert()` drops (no-ops) any write for an id tombstoned within the TTL
 * window, so a straggling write can never resurrect a deleted session. This
 * lives here — the single shared store — rather than being duplicated in each
 * producer, so the invariant holds for every AiSessionType (planning, subtask,
 * mission_interview, milestone_interview, slice_interview) without forking
 * the fix per-producer. 10 minutes is generously longer than any realistic
 * straggling generation write (session ids are UUIDs, never legitimately
 * reused), so id-reuse racing past the TTL is not an expected production path.
 */
export const DELETE_TOMBSTONE_TTL_MS = 10 * 60 * 1000;

export interface AiSessionCleanupSummary {
  terminalDeleted: number;
  orphanedDeleted: number;
  totalDeleted: number;
}

const diagnostics = createSessionDiagnostics("ai-session-store");

// ── Store ───────────────────────────────────────────────────────────────

export class AiSessionStore extends EventEmitter<AiSessionStoreEvents> {
  /** Pending debounce timers for thinking-only writes, keyed by session id. */
  private thinkingTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Interval used for periodic stale-session cleanup. */
  private cleanupTimer: ReturnType<typeof setInterval> | undefined;
  /**
   * FNXC:AiSessionStore 2026-06-24-23:50:
   * When non-null, the store is in backend (PostgreSQL) mode and delegates to
   * the async helpers. The sync db is unused in this mode. This is the dual-path
   * pattern for the AI session system.
   */
  private readonly asyncLayer: AsyncDataLayer | null;
  /**
   * FN-7949 delete tombstones: id -> deletion timestamp (ms since epoch).
   * Consulted by `upsert()` to drop straggling writes for ids deleted within
   * `DELETE_TOMBSTONE_TTL_MS`. See the FNXC:AiSessionStore comment above.
   */
  private deletedIds = new Map<string, number>();


  constructor(private db: Database, options?: { asyncLayer?: AsyncDataLayer | null }) {
    super();
    this.asyncLayer = options?.asyncLayer ?? null;
  }

  /** True when the store is backed by PostgreSQL (AsyncDataLayer present). */
  private get backendMode(): boolean {
    return this.asyncLayer !== null;
  }

  /**
   * FNXC:AiSessionStore 2026-06-24-23:50:
   * Returns the async layer db handle for delegation. Throws if not in backend
   * mode (should never be called when backendMode is false).
   */
  private get dbAsync(): AsyncDataLayer["db"] {
    return this.asyncLayer!.db;
  }

  // ── CRUD ────────────────────────────────────────────────────────────

  /**
   * Insert or update an AI session row.
   * Emits `ai_session:updated` after writing.
   */
  async upsert(session: AiSessionRow): Promise<void> {
    // FNXC:AiSessionStore 2026-07-13-00:00: FN-7949 tombstone guard — drop any
    // upsert for an id that was deleted within the TTL window (both backends),
    // so a straggling post-delete generation write can never resurrect a
    // deleted session.
    if (this.isTombstoned(session.id)) {
      diagnostics.warn("Dropped upsert for tombstoned (deleted) session", {
        sessionId: session.id,
        operation: "upsert-tombstoned",
      });
      return;
    }

    if (this.backendMode) {
      this.clearThinkingTimer(session.id);
      const row = await upsertAiSession(this.dbAsync, session as import("@fusion/core").AsyncAiSessionRow);
      this.emit("ai_session:updated", toSummary(row as AiSessionRow, row.updatedAt));
      return;
    }
    const now = new Date().toISOString();
    // FNXC:PlanningMode 2026-07-02-00:00: Planning checkpoints persist pending summaries inside inputPayload, so every session upsert must refresh inputPayload on existing rows instead of treating it as create-only draft metadata.
    const thinking = trimThinking(session.thinkingOutput);

    this.db
      .prepare(
        `INSERT INTO ai_sessions (id, type, status, title, inputPayload, conversationHistory, currentQuestion, result, thinkingOutput, error, projectId, createdAt, updatedAt, lockedByTab, lockedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
         ON CONFLICT(id) DO UPDATE SET
           status = excluded.status,
           title = excluded.title,
           inputPayload = excluded.inputPayload,
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

    const row = await this.get(session.id);
    if (row) {
      this.emit("ai_session:updated", toSummary(row, row.updatedAt));
    }
  }

  /**
   * Update only the thinkingOutput field, debounced to reduce write frequency.
   * Flushes immediately if `flush` is true (e.g. on status transition).
   */
  updateThinking(sessionId: string, thinkingOutput: string, flush = false): void {
    if (flush) {
      this.clearThinkingTimer(sessionId);
      void this.writeThinking(sessionId, thinkingOutput);
      return;
    }

    // Debounce: reset timer
    this.clearThinkingTimer(sessionId);
    const timer = setTimeout(() => {
      this.thinkingTimers.delete(sessionId);
      void this.writeThinking(sessionId, thinkingOutput);
    }, THINKING_DEBOUNCE_MS);
    this.thinkingTimers.set(sessionId, timer);
  }

  /**
   * Fetch a single session by ID. Returns null if not found.
   */
  async get(id: string): Promise<AiSessionRow | null> {
    if (this.backendMode) {
      return getAiSession(this.dbAsync, id) as Promise<AiSessionRow | null>;
    }
    const row = this.db
      .prepare("SELECT * FROM ai_sessions WHERE id = ?")
      .get(id) as unknown as AiSessionRow | undefined;
    return row ?? null;
  }

  /**
   * Atomically update only status/error for an existing session.
   * Returns false when the session does not exist.
   */
  async updateStatus(id: string, status: AiSessionStatus, error?: string): Promise<boolean> {
    if (this.backendMode) {
      const changed = await updateAiSessionStatus(this.dbAsync, id, status, error);
      if (changed) {
        const row = await this.get(id);
        if (row) this.emit("ai_session:updated", toSummary(row, row.updatedAt));
      }
      return changed;
    }
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

    const row = await this.get(id);
    if (row) {
      this.emit("ai_session:updated", toSummary(row, row.updatedAt));
    }

    return true;
  }

  async updateTitle(id: string, title: string): Promise<boolean> {
    if (this.backendMode) {
      const changed = await updateAiSessionTitle(this.dbAsync, id, title);
      if (changed) {
        const row = await this.get(id);
        if (row) this.emit("ai_session:updated", toSummary(row, row.updatedAt));
      }
      return changed;
    }
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE ai_sessions
         SET title = ?, updatedAt = ?
         WHERE id = ?`,
      )
      .run(title, now, id) as { changes?: number };

    const changed = Number(result.changes ?? 0) > 0;
    if (!changed) {
      return false;
    }

    const row = await this.get(id);
    if (row) {
      this.emit("ai_session:updated", toSummary(row, row.updatedAt));
    }

    return true;
  }

  /**
   * Atomically replace a draft session's title AND record the `initialPlan`
   * text the title was summarized from. Lets the start path skip a redundant
   * summarize when the persisted `summarizedFor` still matches the user's
   * final text. Existing inputPayload fields (initialPlan, model override)
   * are preserved by merge — this method only touches `summarizedFor`.
   */
  async markDraftSummarized(id: string, title: string, summarizedFor: string): Promise<boolean> {
    if (this.backendMode) {
      const existing = await this.get(id);
      if (!existing || existing.type !== "planning") return false;
      let payload: Record<string, unknown> = {};
      if (existing.inputPayload) {
        try {
          const parsed = JSON.parse(existing.inputPayload);
          if (parsed && typeof parsed === "object") payload = parsed as Record<string, unknown>;
        } catch { /* ignore */ }
      }
      payload.summarizedFor = summarizedFor;
      const changed = await markDraftSummarizedAsync(this.dbAsync, id, title, JSON.stringify(payload));
      if (changed) {
        const row = await this.get(id);
        if (row) this.emit("ai_session:updated", toSummary(row, row.updatedAt));
      }
      return changed;
    }
    const existing = await this.get(id);
    if (!existing || existing.type !== "planning") return false;

    let payload: Record<string, unknown> = {};
    if (existing.inputPayload) {
      try {
        const parsed = JSON.parse(existing.inputPayload);
        if (parsed && typeof parsed === "object") payload = parsed as Record<string, unknown>;
      } catch {
        // Fall through with empty payload — better to lose stale fields than
        // to refuse the update and leave the title out of sync with reality.
      }
    }
    payload.summarizedFor = summarizedFor;
    const inputPayload = JSON.stringify(payload);

    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE ai_sessions
         SET title = ?, inputPayload = ?, updatedAt = ?
         WHERE id = ? AND type = 'planning'`,
      )
      .run(title, inputPayload, now, id) as { changes?: number };

    const changed = Number(result.changes ?? 0) > 0;
    if (!changed) return false;

    const row = await this.get(id);
    if (row) this.emit("ai_session:updated", toSummary(row, row.updatedAt));
    return true;
  }

  /**
   * Update persisted draft metadata for a planning session.
   * Persists the in-progress initialPlan so it survives reload; the sidebar
   * title is intentionally left alone (set once at creation, replaced when
   * the user actually starts the session) to avoid leaking raw keystrokes
   * into the sidebar and to keep the entry stable while editing.
   *
   * Also persists an optional model override paired together (provider+id);
   * passing one without the other clears the persisted override so we never
   * end up with a half-configured selection that the start path would
   * silently reject. The optional thinkingLevel is independent of the model pair
   * and is preserved when omitted so draft syncs do not erase reopen state.
   */
  async updateDraft(
    id: string,
    draft: { initialPlan: string; modelProvider?: string; modelId?: string; thinkingLevel?: ThinkingLevel },
  ): Promise<boolean> {
    if (this.backendMode) {
      const existing = await this.get(id);
      let preservedSummarizedFor: string | undefined;
      let preservedThinkingLevel: ThinkingLevel | undefined;
      if (existing?.inputPayload) {
        try {
          const prev = JSON.parse(existing.inputPayload) as {
            summarizedFor?: unknown;
            modelProvider?: unknown;
            modelId?: unknown;
            thinkingLevel?: unknown;
          };
          if (THINKING_LEVELS.includes(prev.thinkingLevel as ThinkingLevel)) {
            preservedThinkingLevel = prev.thinkingLevel as ThinkingLevel;
          }
          const trimmedPlan = draft.initialPlan.trim();
          const hasModelOverride = Boolean(draft.modelProvider && draft.modelId);
          const prevProvider = typeof prev.modelProvider === "string" ? prev.modelProvider : undefined;
          const prevModelId = typeof prev.modelId === "string" ? prev.modelId : undefined;
          const newProvider = hasModelOverride ? draft.modelProvider : undefined;
          const newModelId = hasModelOverride ? draft.modelId : undefined;
          const modelUnchanged = prevProvider === newProvider && prevModelId === newModelId;
          if (typeof prev.summarizedFor === "string" && prev.summarizedFor === trimmedPlan && modelUnchanged) {
            preservedSummarizedFor = prev.summarizedFor;
          }
        } catch { /* ignore */ }
      }
      const inputPayload = JSON.stringify({
        initialPlan: draft.initialPlan.trim(),
        ...(draft.modelProvider && draft.modelId ? { modelProvider: draft.modelProvider, modelId: draft.modelId } : {}),
        ...(preservedSummarizedFor ? { summarizedFor: preservedSummarizedFor } : {}),
        ...((draft.thinkingLevel ?? preservedThinkingLevel) ? { thinkingLevel: draft.thinkingLevel ?? preservedThinkingLevel } : {}),
      });
      const changed = await updateDraftAsync(this.dbAsync, id, inputPayload);
      if (changed) {
        const row = await this.get(id);
        if (row) this.emit("ai_session:updated", toSummary(row, row.updatedAt));
      }
      return changed;
    }
    const now = new Date().toISOString();
    const trimmedPlan = draft.initialPlan.trim();
    const hasModelOverride = Boolean(draft.modelProvider && draft.modelId);

    // Preserve the prior `summarizedFor` field so summarize results aren't
    // wiped on every draft sync, but only when both the plan text AND the
    // model identity are unchanged. A model switch invalidates the prior
    // summary even with identical text — otherwise startExistingSession
    // would skip re-summarize and run the session with a title produced
    // under a model the user just abandoned.
    const existing = await this.get(id);
    let preservedSummarizedFor: string | undefined;
    let preservedThinkingLevel: ThinkingLevel | undefined;
    if (existing?.inputPayload) {
      try {
        const prev = JSON.parse(existing.inputPayload) as {
          summarizedFor?: unknown;
          modelProvider?: unknown;
          modelId?: unknown;
          thinkingLevel?: unknown;
        };
        const prevProvider = typeof prev.modelProvider === "string" ? prev.modelProvider : undefined;
        const prevModelId = typeof prev.modelId === "string" ? prev.modelId : undefined;
        const newProvider = hasModelOverride ? draft.modelProvider : undefined;
        const newModelId = hasModelOverride ? draft.modelId : undefined;
        const modelUnchanged = prevProvider === newProvider && prevModelId === newModelId;
        if (THINKING_LEVELS.includes(prev.thinkingLevel as ThinkingLevel)) {
          preservedThinkingLevel = prev.thinkingLevel as ThinkingLevel;
        }
        if (
          typeof prev.summarizedFor === "string"
          && prev.summarizedFor === trimmedPlan
          && modelUnchanged
        ) {
          preservedSummarizedFor = prev.summarizedFor;
        }
      } catch {
        // Ignore malformed prior payloads — treat as no summary on file.
      }
    }

    const inputPayload = JSON.stringify({
      initialPlan: trimmedPlan,
      ...(hasModelOverride ? { modelProvider: draft.modelProvider, modelId: draft.modelId } : {}),
      ...((draft.thinkingLevel ?? preservedThinkingLevel) ? { thinkingLevel: draft.thinkingLevel ?? preservedThinkingLevel } : {}),
      ...(preservedSummarizedFor ? { summarizedFor: preservedSummarizedFor } : {}),
    });
    const result = this.db
      .prepare(
        `UPDATE ai_sessions
         SET inputPayload = ?, updatedAt = ?
         WHERE id = ? AND type = 'planning'`,
      )
      .run(inputPayload, now, id) as { changes?: number };

    const changed = Number(result.changes ?? 0) > 0;
    if (!changed) {
      return false;
    }

    const row = await this.get(id);
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
  async ping(id: string): Promise<boolean> {
    if (this.backendMode) {
      return pingAiSession(this.dbAsync, id);
    }
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
  async listActive(projectId?: string): Promise<AiSessionSummary[]> {
    if (this.backendMode) {
      const rows = await listActiveAiSessions(this.dbAsync, projectId) as Array<Record<string, unknown>>;
      return rows.map((row) => ({
        id: row.id as string,
        type: row.type as AiSessionType,
        status: row.status as AiSessionStatus,
        title: row.title as string,
        projectId: (row.projectId as string | null) ?? null,
        lockedByTab: (row.lockedByTab as string | null) ?? null,
        updatedAt: row.updatedAt as string,
        archived: Number(row.archived ?? 0) === 1,
      }));
    }
    if (projectId) {
      return this.db
        .prepare(
          `SELECT id, type, status, title, projectId, lockedByTab, updatedAt, archived FROM ai_sessions
           WHERE status IN ('generating', 'awaiting_input', 'error')
             AND COALESCE(archived, 0) = 0
             AND projectId = ?
           ORDER BY updatedAt DESC`,
        )
        .all(projectId) as unknown as AiSessionSummary[];
    }
    return this.db
      .prepare(
        `SELECT id, type, status, title, projectId, lockedByTab, updatedAt, archived FROM ai_sessions
         WHERE status IN ('generating', 'awaiting_input', 'error')
           AND COALESCE(archived, 0) = 0
         ORDER BY updatedAt DESC`,
      )
      .all() as unknown as AiSessionSummary[];
  }

  /**
   * List sessions regardless of status (including `complete`).
   * Used by the planning sidebar so previously completed sessions remain
   * selectable on refresh — `listActive` filters them out, which would
   * otherwise hide a session that finished while the modal was closed.
   * By default archived sessions are excluded; pass `includeArchived` to
   * surface them too. Completed sessions are pruned by `cleanupOld` after
   * the configured TTL, so this list does not grow unbounded.
   */
  async listAll(projectId?: string, options?: { includeArchived?: boolean }): Promise<AiSessionSummary[]> {
    if (this.backendMode) {
      const rows = await listAllAiSessions(this.dbAsync, projectId, options) as Array<Record<string, unknown>>;
      return rows.map((row) => toSidebarSummaryAsync(row));
    }
    // Pull `inputPayload` alongside the summary columns so we can derive the
    // sidebar preview for draft rows. Non-draft rows ignore the payload —
    // toSidebarSummary only inspects it when status === "draft".
    const archivedClause = options?.includeArchived ? "" : " WHERE COALESCE(archived, 0) = 0";
    if (projectId) {
      const where = options?.includeArchived
        ? "WHERE projectId = ?"
        : "WHERE projectId = ? AND COALESCE(archived, 0) = 0";
      const rows = this.db
        .prepare(
          `SELECT id, type, status, title, inputPayload, projectId, lockedByTab, updatedAt, archived FROM ai_sessions
           ${where}
           ORDER BY updatedAt DESC`,
        )
        .all(projectId) as Array<Partial<AiSessionRow> & Pick<AiSessionRow, "id" | "type" | "status" | "title" | "inputPayload" | "updatedAt">>;
      return rows.map(toSidebarSummary);
    }
    const rows = this.db
      .prepare(
        `SELECT id, type, status, title, inputPayload, projectId, lockedByTab, updatedAt, archived FROM ai_sessions
         ${archivedClause}
         ORDER BY updatedAt DESC`,
      )
      .all() as Array<Partial<AiSessionRow> & Pick<AiSessionRow, "id" | "type" | "status" | "title" | "inputPayload" | "updatedAt">>;
    return rows.map(toSidebarSummary);
  }

  /**
   * Mark a session as archived (hidden from planning sidebar). Only
   * terminal sessions (`complete` or `error`) are archivable — archiving
   * an in-flight session would orphan the live agent. Returns true when
   * the row was updated. Emits `ai_session:updated` so other tabs sync.
   */
  async archive(id: string): Promise<boolean> {
    if (this.backendMode) {
      const changed = await archiveAiSession(this.dbAsync, id);
      if (changed) {
        const row = await this.get(id);
        if (row) this.emit("ai_session:updated", toSummary(row, row.updatedAt));
      }
      return changed;
    }
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE ai_sessions
         SET archived = 1, updatedAt = ?
         WHERE id = ? AND status IN ('complete', 'error')`,
      )
      .run(now, id) as { changes?: number };

    const changed = Number(result.changes ?? 0) > 0;
    if (changed) {
      const row = await this.get(id);
      if (row) this.emit("ai_session:updated", toSummary(row, row.updatedAt));
    }
    return changed;
  }

  /** Restore an archived session so it reappears in the sidebar. */
  async unarchive(id: string): Promise<boolean> {
    if (this.backendMode) {
      const changed = await unarchiveAiSession(this.dbAsync, id);
      if (changed) {
        const row = await this.get(id);
        if (row) this.emit("ai_session:updated", toSummary(row, row.updatedAt));
      }
      return changed;
    }
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE ai_sessions
         SET archived = 0, updatedAt = ?
         WHERE id = ?`,
      )
      .run(now, id) as { changes?: number };

    const changed = Number(result.changes ?? 0) > 0;
    if (changed) {
      const row = await this.get(id);
      if (row) this.emit("ai_session:updated", toSummary(row, row.updatedAt));
    }
    return changed;
  }

  /**
   * List recoverable sessions for in-memory rehydration.
   * Returns full rows for sessions still in progress.
   */
  async listRecoverable(projectId?: string): Promise<AiSessionRow[]> {
    if (this.backendMode) {
      return listRecoverableAiSessions(this.dbAsync, projectId) as Promise<AiSessionRow[]>;
    }
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

  async acquireLock(sessionId: string, tabId: string): Promise<{ acquired: boolean; currentHolder: string | null }> {
    if (this.backendMode) {
      const result = await acquireAiSessionLock(this.dbAsync, sessionId, tabId);
      if (result.acquired) {
        const row = await this.get(sessionId);
        if (row) this.emit("ai_session:updated", toSummary(row, row.updatedAt));
      }
      return result;
    }
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE ai_sessions
         SET lockedByTab = ?, lockedAt = ?
         WHERE id = ? AND (lockedByTab IS NULL OR lockedByTab = ?)`,
      )
      .run(tabId, now, sessionId, tabId) as { changes?: number };

    const acquired = Number(result.changes ?? 0) > 0;
    if (acquired) {
      const row = await this.get(sessionId);
      if (row) {
        this.emit("ai_session:updated", toSummary(row, row.updatedAt));
      }
      return { acquired: true, currentHolder: null };
    }

    const holder = this.db
      .prepare("SELECT lockedByTab FROM ai_sessions WHERE id = ?")
      .get(sessionId) as { lockedByTab: string | null } | undefined;

    return {
      acquired: false,
      currentHolder: holder?.lockedByTab ?? null,
    };
  }

  async releaseLock(sessionId: string, tabId: string): Promise<boolean> {
    if (this.backendMode) {
      const released = await releaseAiSessionLock(this.dbAsync, sessionId, tabId);
      if (released) {
        const row = await this.get(sessionId);
        if (row) this.emit("ai_session:updated", toSummary(row, row.updatedAt));
      }
      return released;
    }
    const result = this.db
      .prepare(
        `UPDATE ai_sessions
         SET lockedByTab = NULL, lockedAt = NULL
         WHERE id = ? AND lockedByTab = ?`,
      )
      .run(sessionId, tabId) as { changes?: number };

    const released = Number(result.changes ?? 0) > 0;
    if (!released) {
      return false;
    }

    const row = await this.get(sessionId);
    if (row) {
      this.emit("ai_session:updated", toSummary(row, row.updatedAt));
    }

    return true;
  }

  async forceAcquireLock(sessionId: string, tabId: string): Promise<void> {
    if (this.backendMode) {
      const changed = await forceAcquireAiSessionLock(this.dbAsync, sessionId, tabId);
      if (changed) {
        const row = await this.get(sessionId);
        if (row) this.emit("ai_session:updated", toSummary(row, row.updatedAt));
      }
      return;
    }
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE ai_sessions
         SET lockedByTab = ?, lockedAt = ?
         WHERE id = ?`,
      )
      .run(tabId, now, sessionId) as { changes?: number };

    if (Number(result.changes ?? 0) === 0) {
      return;
    }

    const row = await this.get(sessionId);
    if (row) {
      this.emit("ai_session:updated", toSummary(row, row.updatedAt));
    }
  }

  async getLockHolder(sessionId: string): Promise<{ tabId: string | null; lockedAt: string | null }> {
    if (this.backendMode) {
      return getAiSessionLockHolder(this.dbAsync, sessionId);
    }
    const row = this.db
      .prepare("SELECT lockedByTab, lockedAt FROM ai_sessions WHERE id = ?")
      .get(sessionId) as { lockedByTab: string | null; lockedAt: string | null } | undefined;

    return {
      tabId: row?.lockedByTab ?? null,
      lockedAt: row?.lockedAt ?? null,
    };
  }

  async releaseStaleLocks(maxAgeMs = 30 * 60 * 1000): Promise<number> {
    if (this.backendMode) {
      return releaseStaleAiSessionLocks(this.dbAsync, maxAgeMs);
    }
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    const staleRows = this.db
      .prepare(
        `SELECT id FROM ai_sessions
         WHERE lockedByTab IS NOT NULL
           AND lockedAt < ?`,
      )
      .all(cutoff) as Array<{ id: string }>;

    if (staleRows.length === 0) {
      return 0;
    }

    const result = this.db
      .prepare(
        `UPDATE ai_sessions
         SET lockedByTab = NULL, lockedAt = NULL
         WHERE lockedByTab IS NOT NULL
           AND lockedAt < ?`,
      )
      .run(cutoff) as { changes?: number };

    for (const rowInfo of staleRows) {
      const row = await this.get(rowInfo.id);
      if (row) {
        this.emit("ai_session:updated", toSummary(row, row.updatedAt));
      }
    }

    return Number(result.changes ?? 0);
  }

  /**
   * Delete a session by ID. Emits `ai_session:deleted`.
   */
  async delete(id: string): Promise<void> {
    this.clearThinkingTimer(id);
    if (this.backendMode) {
      await deleteAiSession(this.dbAsync, id);
      this.emit("ai_session:deleted", id);
      return;
    }
    this.db.prepare("DELETE FROM ai_sessions WHERE id = ?").run(id);
    this.deletedIds.set(id, Date.now());
    this.emit("ai_session:deleted", id);
  }

  async deleteByIdAndType(id: string, type: AiSessionType): Promise<boolean> {
    if (this.backendMode) {
      this.clearThinkingTimer(id);
      const removed = await deleteAiSessionByIdAndType(this.dbAsync, id, type);
      if (removed) this.emit("ai_session:deleted", id);
      return removed;
    }
    const existing = this.db
      .prepare("SELECT id FROM ai_sessions WHERE id = ? AND type = ?")
      .get(id, type) as { id: string } | undefined;

    if (!existing) {
      return false;
    }

    this.clearThinkingTimer(id);
    const result = this.db
      .prepare("DELETE FROM ai_sessions WHERE id = ? AND type = ?")
      .run(id, type) as { changes?: number };

    const removed = Number(result.changes ?? 0) > 0;
    if (removed) {
      this.deletedIds.set(id, Date.now());
      this.emit("ai_session:deleted", id);
    }
    return removed;
  }

  /**
   * Recover sessions after server restart.
   * - `generating` sessions with a currentQuestion -> `awaiting_input`
   * - `generating` sessions without -> `error`
   */
  async recoverStaleSessions(): Promise<number> {
    if (this.backendMode) {
      return recoverStaleAiSessions(this.dbAsync);
    }
    const now = new Date().toISOString();
    let recovered = 0;

    // Sessions that were generating and had a pending question — recoverable
    const withQuestion = this.db
      .prepare(
        `UPDATE ai_sessions SET status = 'awaiting_input', updatedAt = ?
         WHERE status = 'generating' AND currentQuestion IS NOT NULL`,
      )
      .run(now) as { changes?: number };
    recovered += Number(withQuestion.changes ?? 0);

    // Sessions that were generating with no question — unrecoverable
    const withoutQuestion = this.db
      .prepare(
        `UPDATE ai_sessions SET status = 'error', error = 'Session interrupted — please restart', updatedAt = ?
         WHERE status = 'generating' AND currentQuestion IS NULL`,
      )
      .run(now) as { changes?: number };
    recovered += Number(withoutQuestion.changes ?? 0);

    if (recovered > 0) {
      diagnostics.info("Recovered stale sessions after restart", {
        recovered,
        operation: "recover-stale-sessions",
      });
    }
    return recovered;
  }

  /**
   * Clean up stale terminal sessions (`complete`, `error`) older than the given age (ms).
   * Returns the number of deleted sessions.
   */
  async cleanupOld(maxAgeMs: number): Promise<number> {
    if (this.backendMode) {
      const deletedIds = await cleanupOldAiSessions(this.dbAsync, maxAgeMs);
      this.emitDeletedSessions(deletedIds.map((id) => ({ id })));
      return deletedIds.length;
    }
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();

    const stale = this.db
      .prepare(
        `SELECT id FROM ai_sessions
         WHERE updatedAt < ?
           AND status IN ('complete', 'error')`,
      )
      .all(cutoff) as Array<{ id: string }>;

    if (stale.length === 0) {
      return 0;
    }

    this.db
      .prepare(
        `DELETE FROM ai_sessions
         WHERE updatedAt < ?
           AND status IN ('complete', 'error')`,
      )
      .run(cutoff);

    this.emitDeletedSessions(stale);
    return stale.length;
  }

  /**
   * Cleans up stale terminal and orphaned active sessions older than `maxAgeMs`.
   *
   * - Terminal sessions (`complete`, `error`) are deleted via `cleanupOld()`.
   * - Orphaned active sessions (`generating`, `awaiting_input`) are deleted directly.
   */
  async cleanupStaleSessions(maxAgeMs = SESSION_CLEANUP_DEFAULT_MAX_AGE_MS): Promise<AiSessionCleanupSummary> {
    // FN-7949: piggyback tombstone-map pruning on the existing cleanup cadence.
    this.pruneExpiredTombstones();

    if (this.backendMode) {
      const result = await cleanupStaleAiSessions(this.dbAsync, maxAgeMs);
      this.emitDeletedSessions([
        ...result.terminalDeletedIds.map((id) => ({ id })),
        ...result.orphanedDeletedIds.map((id) => ({ id })),
      ]);
      diagnostics.info("Cleanup removed stale sessions", {
        terminalDeleted: result.terminalDeletedIds.length,
        orphanedDeleted: result.orphanedDeletedIds.length,
        totalDeleted: result.terminalDeletedIds.length + result.orphanedDeletedIds.length,
        maxAgeMs,
        operation: "cleanup-stale-sessions",
      });
      return {
        terminalDeleted: result.terminalDeletedIds.length,
        orphanedDeleted: result.orphanedDeletedIds.length,
        totalDeleted: result.terminalDeletedIds.length + result.orphanedDeletedIds.length,
      };
    }
    const terminalDeleted = await this.cleanupOld(maxAgeMs);
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();

    const orphaned = this.db
      .prepare(
        `SELECT id FROM ai_sessions
         WHERE updatedAt < ?
           AND status IN ('generating', 'awaiting_input')`,
      )
      .all(cutoff) as Array<{ id: string }>;

    let orphanedDeleted = 0;
    if (orphaned.length > 0) {
      const result = this.db
        .prepare(
          `DELETE FROM ai_sessions
           WHERE updatedAt < ?
             AND status IN ('generating', 'awaiting_input')`,
        )
        .run(cutoff) as { changes?: number };
      orphanedDeleted = Number(result.changes ?? 0);
      this.emitDeletedSessions(orphaned);
    }

    const totalDeleted = terminalDeleted + orphanedDeleted;
    diagnostics.info("Cleanup removed stale sessions", {
      terminalDeleted,
      orphanedDeleted,
      totalDeleted,
      maxAgeMs,
      operation: "cleanup-stale-sessions",
    });

    return {
      terminalDeleted,
      orphanedDeleted,
      totalDeleted,
    };
  }

  /**
   * Start periodic stale-session cleanup using the provided schedule and TTL.
   */
  startScheduledCleanup(cleanupIntervalMs: number, ttlMs: number): void {
    this.stopScheduledCleanup();

    const runCleanup = () => {
      try {
        this.cleanupStaleSessions(ttlMs);
      } catch (error) {
        diagnostics.errorFromException("Scheduled cleanup failed", error, {
          ttlMs,
          operation: "scheduled-cleanup",
        });
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

  private emitDeletedSessions(rows: Array<{ id: string }>): void {
    const now = Date.now();
    for (const { id } of rows) {
      this.clearThinkingTimer(id);
      this.deletedIds.set(id, now);
      this.emit("ai_session:deleted", id);
    }
  }

  /**
   * Returns true when `id` was deleted within the tombstone TTL window.
   * Lazily prunes the specific entry when it has expired so the map does not
   * hold expired entries indefinitely for ids that are never re-upserted.
   */
  private isTombstoned(id: string): boolean {
    const deletedAt = this.deletedIds.get(id);
    if (deletedAt === undefined) return false;
    if (Date.now() - deletedAt < DELETE_TOMBSTONE_TTL_MS) return true;
    this.deletedIds.delete(id);
    return false;
  }

  /**
   * Prune expired tombstone entries. Piggybacks on the existing scheduled
   * cleanup cadence (`startScheduledCleanup`/`cleanupStaleSessions`) so the
   * `deletedIds` map cannot grow unbounded over a long-running server
   * process. Safe to call at any time; also invoked lazily via
   * `isTombstoned` for individually-checked ids.
   */
  private pruneExpiredTombstones(): number {
    const now = Date.now();
    let pruned = 0;
    for (const [id, deletedAt] of this.deletedIds) {
      if (now - deletedAt >= DELETE_TOMBSTONE_TTL_MS) {
        this.deletedIds.delete(id);
        pruned++;
      }
    }
    return pruned;
  }

  private async writeThinking(sessionId: string, thinkingOutput: string): Promise<void> {
    if (this.backendMode) {
      await updateThinkingAsync(this.dbAsync, sessionId, thinkingOutput);
      return;
    }
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

/**
 * FNXC:AiSessionStore 2026-06-25-00:00:
 * Converts a raw Drizzle row (from the async listAllAiSessions helper) into
 * an AiSessionSummary with the draft preview derived from inputPayload. The
 * async helper returns inputPayload as a parsed jsonb value, while the sync
 * path stores it as TEXT-serialized JSON. This normalizer handles both shapes.
 */
function toSidebarSummaryAsync(row: Record<string, unknown>): AiSessionSummary {
  const inputPayload = row.inputPayload;
  const inputPayloadStr = typeof inputPayload === "string" ? inputPayload : JSON.stringify(inputPayload ?? {});
  return {
    id: row.id as string,
    type: row.type as AiSessionType,
    status: row.status as AiSessionStatus,
    title: row.title as string,
    preview: extractDraftPreview({
      id: row.id as string,
      type: row.type as AiSessionType,
      status: row.status as AiSessionStatus,
      title: row.title as string,
      inputPayload: inputPayloadStr,
      conversationHistory: "",
      currentQuestion: null,
      result: null,
      thinkingOutput: "",
      error: null,
      projectId: (row.projectId as string | null) ?? null,
      createdAt: "",
      updatedAt: row.updatedAt as string,
      lockedByTab: (row.lockedByTab as string | null) ?? null,
      lockedAt: null,
      archived: typeof row.archived === "number" ? row.archived : 0,
    }),
    projectId: (row.projectId as string | null) ?? null,
    lockedByTab: (row.lockedByTab as string | null) ?? null,
    updatedAt: row.updatedAt as string,
    archived: Number(row.archived ?? 0) === 1,
  };
}

function toSummary(session: AiSessionRow, updatedAt: string): AiSessionSummary {
  return {
    id: session.id,
    type: session.type,
    status: session.status,
    title: session.title,
    preview: extractDraftPreview(session),
    projectId: session.projectId,
    lockedByTab: session.lockedByTab ?? null,
    updatedAt,
    archived: Number(session.archived ?? 0) === 1,
  };
}

/**
 * Lighter-weight summary builder for `listAll` rows that don't carry every
 * column of `AiSessionRow`. Keeps the same preview-derivation behavior as
 * `toSummary` (drafts only) without forcing the bulk-list query to SELECT
 * conversationHistory / thinkingOutput / etc.
 */
function toSidebarSummary(
  row: Partial<AiSessionRow> & Pick<AiSessionRow, "id" | "type" | "status" | "title" | "inputPayload" | "updatedAt">,
): AiSessionSummary {
  const previewSource: AiSessionRow = {
    id: row.id,
    type: row.type,
    status: row.status,
    title: row.title,
    inputPayload: row.inputPayload,
    conversationHistory: "",
    currentQuestion: null,
    result: null,
    thinkingOutput: "",
    error: null,
    projectId: row.projectId ?? null,
    createdAt: "",
    updatedAt: row.updatedAt,
    lockedByTab: row.lockedByTab ?? null,
    lockedAt: row.lockedAt ?? null,
    archived: row.archived,
  };
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    title: row.title,
    preview: extractDraftPreview(previewSource),
    projectId: row.projectId ?? null,
    lockedByTab: row.lockedByTab ?? null,
    updatedAt: row.updatedAt,
    archived: Number(row.archived ?? 0) === 1,
  };
}

function extractDraftPreview(session: AiSessionRow): string | undefined {
  if (session.type !== "planning" || session.status !== "draft") return undefined;
  if (!session.inputPayload) return undefined;
  try {
    const payload = JSON.parse(session.inputPayload) as { initialPlan?: unknown };
    const plan = typeof payload.initialPlan === "string" ? payload.initialPlan.trim() : "";
    if (!plan) return undefined;
    const collapsed = plan.replace(/\s+/g, " ");
    return collapsed.length > DRAFT_PREVIEW_MAX_CHARS
      ? `${collapsed.slice(0, DRAFT_PREVIEW_MAX_CHARS - 1).trimEnd()}…`
      : collapsed;
  } catch {
    return undefined;
  }
}
