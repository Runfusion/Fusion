/**
 * AI Session Store
 *
 * Persists long-running AI session state (planning, subtask breakdown,
 * mission interview) to PostgreSQL so users can dismiss modals and return
 * later — even from a different browser.
 *
 * The in-memory session Maps in planning.ts / subtask-breakdown.ts /
 * mission-interview.ts remain the source of truth for live agent state.
 * This store is the persistence shadow, updated at each state transition.
 */

import { EventEmitter } from "node:events";
import { THINKING_LEVELS, type AsyncDataLayer, type ThinkingLevel } from "@fusion/core";
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
  /** 1 if archived (hidden from planning sidebar), 0 otherwise. */
  archived?: number;
}

/** Summary returned by listActive (omits large fields) */
export interface AiSessionSummary {
  id: string;
  type: AiSessionType;
  status: AiSessionStatus;
  title: string;
  preview?: string;
  projectId: string | null;
  updatedAt: string;
  archived?: boolean;
}

const DRAFT_PREVIEW_MAX_CHARS = 80;

export interface AiSessionStoreEvents {
  "ai_session:updated": [AiSessionSummary];
  "ai_session:deleted": [string];
}

const THINKING_DEBOUNCE_MS = 2000;

export const SESSION_CLEANUP_DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const SESSION_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * FNXC:AiSessionStore 2026-07-13-00:00:
 * Deleted session ids remain tombstoned long enough to reject writes from an
 * already-abandoned generation promise after the user deletes that session.
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
  private thinkingTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private cleanupTimer: ReturnType<typeof setInterval> | undefined;
  /**
   * FNXC:PostgresAiSessionStore 2026-07-14-19:20:
   * Background AI-session persistence is PostgreSQL-only. Requiring the
   * project AsyncDataLayer prevents deleted or resumed sessions from landing
   * in a disconnected SQLite shadow store.
   */
  private readonly asyncLayer: AsyncDataLayer;
  /**
   * FN-7949 delete tombstones: id -> deletion timestamp (ms since epoch).
   * Consulted by `upsert()` to drop straggling writes for ids deleted within
   * `DELETE_TOMBSTONE_TTL_MS`. See the FNXC:AiSessionStore comment above.
   */
  private deletedIds = new Map<string, number>();
  constructor(asyncLayer: AsyncDataLayer) {
    super();
    this.asyncLayer = asyncLayer;
  }

  private get dbAsync(): AsyncDataLayer["db"] {
    return this.asyncLayer.db;
  }

  // ── CRUD ────────────────────────────────────────────────────────────

  /**
   * Insert or update an AI session row.
   * Emits `ai_session:updated` after writing.
   */
  async upsert(session: AiSessionRow): Promise<void> {
    // FNXC:AiSessionStore 2026-07-13-00:00: FN-7949 tombstone guard — drop any
    // upsert for an id that was deleted within the TTL window,
    // so a straggling post-delete generation write can never resurrect a
    // deleted session.
    if (this.isTombstoned(session.id)) {
      diagnostics.warn("Dropped upsert for tombstoned (deleted) session", {
        sessionId: session.id,
        operation: "upsert-tombstoned",
      });
      return;
    }
    this.clearThinkingTimer(session.id);
    const row = await upsertAiSession(this.dbAsync, session as import("@fusion/core").AsyncAiSessionRow);
    this.emit("ai_session:updated", toSummary(row as AiSessionRow, row.updatedAt));
    return;
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
    return getAiSession(this.dbAsync, id) as Promise<AiSessionRow | null>;
  }

  /**
   * Atomically update only status/error for an existing session.
   * Returns false when the session does not exist.
   */
  async updateStatus(id: string, status: AiSessionStatus, error?: string): Promise<boolean> {
    const changed = await updateAiSessionStatus(this.dbAsync, id, status, error);
    if (changed) {
      const row = await this.get(id);
      if (row) this.emit("ai_session:updated", toSummary(row, row.updatedAt));
    }
    return changed;
  }

  async updateTitle(id: string, title: string): Promise<boolean> {
    const changed = await updateAiSessionTitle(this.dbAsync, id, title);
    if (changed) {
      const row = await this.get(id);
      if (row) this.emit("ai_session:updated", toSummary(row, row.updatedAt));
    }
    return changed;
  }

  /**
   * Atomically replace a draft session's title AND record the `initialPlan`
   * text the title was summarized from. Lets the start path skip a redundant
   * summarize when the persisted `summarizedFor` still matches the user's
   * final text. Existing inputPayload fields (initialPlan, model override)
   * are preserved by merge — this method only touches `summarizedFor`.
   */
  async markDraftSummarized(id: string, title: string, summarizedFor: string): Promise<boolean> {
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

  /**
   * Lightweight heartbeat for active sessions.
   * Updates only `updatedAt` and intentionally does NOT emit
   * `ai_session:updated` to avoid high-frequency SSE broadcasts.
   */
  async ping(id: string): Promise<boolean> {
    return pingAiSession(this.dbAsync, id);
  }

  /**
   * List active/retryable sessions (generating, awaiting_input, or error).
   * Optionally filtered by projectId.
   */
  async listActive(projectId?: string): Promise<AiSessionSummary[]> {
    const rows = await listActiveAiSessions(this.dbAsync, projectId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: row.id as string,
      type: row.type as AiSessionType,
      status: row.status as AiSessionStatus,
      title: row.title as string,
      projectId: (row.projectId as string | null) ?? null,
      updatedAt: row.updatedAt as string,
      archived: Number(row.archived ?? 0) === 1,
    }));
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
  async listAll(projectId?: string, options?: { includeArchived?: boolean; type?: AiSessionType }): Promise<AiSessionSummary[]> {
    const rows = await listAllAiSessions(this.dbAsync, projectId, options) as Array<Record<string, unknown>>;
    return rows.map((row) => toSidebarSummaryAsync(row));
  }

  /**
   * Mark a session as archived (hidden from planning sidebar). Only
   * terminal sessions (`complete` or `error`) are archivable — archiving
   * an in-flight session would orphan the live agent. Returns true when
   * the row was updated. Emits `ai_session:updated` so other tabs sync.
   */
  async archive(id: string): Promise<boolean> {
    const changed = await archiveAiSession(this.dbAsync, id);
    if (changed) {
      const row = await this.get(id);
      if (row) this.emit("ai_session:updated", toSummary(row, row.updatedAt));
    }
    return changed;
  }

  /** Restore an archived session so it reappears in the sidebar. */
  async unarchive(id: string): Promise<boolean> {
    const changed = await unarchiveAiSession(this.dbAsync, id);
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
    return listRecoverableAiSessions(this.dbAsync, projectId) as Promise<AiSessionRow[]>;
  }

  /*
  FNXC:PlanningMultiTab 2026-07-14-00:00:
  acquireLock / releaseLock / forceAcquireLock / getLockHolder / releaseStaleLocks were removed
  here with the rest of the per-tab session lock. AI interview sessions are multi-tab: this
  persisted row is the shared source of truth and every tab may read and interact. See the dead
  `lockedByTab`/`lockedAt` columns in core's project schema for why they still exist in the DB.

  FNXC:PostgresConflictResolution 2026-07-14-19:47:
  Preserve main's lock-free multi-tab contract while keeping AI-session persistence PostgreSQL-only.
  Resolving the storage cutover must not restore the deleted lock API or SQLite summary fields.
  */

  /**
   * Delete a session by ID. Emits `ai_session:deleted`.
   */
  async delete(id: string): Promise<void> {
    this.clearThinkingTimer(id);
    this.deletedIds.set(id, Date.now());
    await deleteAiSession(this.dbAsync, id);
    this.emit("ai_session:deleted", id);
    return;
  }

  async deleteByIdAndType(id: string, type: AiSessionType): Promise<boolean> {
    this.clearThinkingTimer(id);
    this.deletedIds.set(id, Date.now());
    const removed = await deleteAiSessionByIdAndType(this.dbAsync, id, type);
    if (removed) {
      this.emit("ai_session:deleted", id);
    } else {
      this.deletedIds.delete(id);
    }
    return removed;
  }

  /**
   * Recover sessions after server restart.
   * - `generating` sessions with a currentQuestion -> `awaiting_input`
   * - `generating` sessions without -> `error`
   */
  async recoverStaleSessions(): Promise<number> {
    return recoverStaleAiSessions(this.dbAsync);
  }

  /**
   * Clean up stale terminal sessions (`complete`, `error`) older than the given age (ms).
   * Returns the number of deleted sessions.
   */
  async cleanupOld(maxAgeMs: number): Promise<number> {
    const deletedIds = await cleanupOldAiSessions(this.dbAsync, maxAgeMs);
    this.emitDeletedSessions(deletedIds.map((id) => ({ id })));
    return deletedIds.length;
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

  /**
   * Start periodic stale-session cleanup using the provided schedule and TTL.
   */
  startScheduledCleanup(cleanupIntervalMs: number, ttlMs: number): void {
    this.stopScheduledCleanup();

    const runCleanup = () => {
      void this.cleanupStaleSessions(ttlMs).catch((error) => {
        diagnostics.errorFromException("Scheduled cleanup failed", error, {
          ttlMs,
          operation: "scheduled-cleanup",
        });
      });
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
    await updateThinkingAsync(this.dbAsync, sessionId, thinkingOutput);
    return;
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

/**
 * FNXC:AiSessionStore 2026-06-25-00:00:
 * Converts a raw Drizzle row (from the async listAllAiSessions helper) into
 * an AiSessionSummary with the draft preview derived from inputPayload. The
 * async helper returns inputPayload as a parsed jsonb value. This normalizer also
 * accepts serialized fixture values to keep public row mapping tolerant.
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
      archived: typeof row.archived === "number" ? row.archived : 0,
    }),
    projectId: (row.projectId as string | null) ?? null,
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
    updatedAt,
    archived: Number(session.archived ?? 0) === 1,
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
