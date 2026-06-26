/**
 * Async Drizzle AiSessionStore helpers.
 *
 * FNXC:AiSessionStore 2026-06-24-23:00:
 * Async equivalents of the sync SQLite AiSessionStore call sites in
 * packages/dashboard/src/ai-session-store.ts. These helpers target the
 * PostgreSQL `project.ai_sessions` table via Drizzle, using the schema
 * defined in schema/project.ts.
 *
 * The AiSessionStore persists long-running AI session state (planning, subtask
 * breakdown, mission interview) so users can dismiss modals and return later.
 * In backend mode (PostgreSQL), the store delegates all CRUD to these helpers
 * via the dual-path pattern. The sync SQLite path remains for the gate suite.
 *
 * SQLite -> PostgreSQL notes:
 *   - `db.prepare(sql).get/run/all()` -> awaited Drizzle queries.
 *   - JSON columns (inputPayload, conversationHistory, result) are jsonb in
 *     PostgreSQL, so Drizzle returns them already-parsed.
 *   - `INSERT ... ON CONFLICT(id) DO UPDATE` upsert maps to Drizzle
 *     `insert().onConflictDoUpdate()`.
 *   - SQLite `changes` for detecting row existence -> Drizzle
 *     `.returning({...})` + `.length > 0`.
 *
 * Transition context: these helpers live in @fusion/core (where the schema is
 * defined) and are exported so the dashboard's AiSessionStore can import them.
 */
import { and, desc, eq, inArray, isNotNull, isNull, lte, or } from "drizzle-orm";
import * as schema from "./postgres/schema/index.js";
import type { AsyncDataLayer, DbTransaction } from "./postgres/data-layer.js";

/** A query-capable handle: either the top-level db or a transaction handle. */
type QueryHandle = AsyncDataLayer["db"] | DbTransaction;

// ── Local type aliases (mirror dashboard AiSessionRow/AiSessionStatus/AiSessionType) ──

export type AiSessionStatus = "generating" | "awaiting_input" | "complete" | "error" | "draft";
export type AiSessionType = "planning" | "subtask" | "mission_interview" | "milestone_interview" | "slice_interview";

export interface AiSessionRow {
  id: string;
  type: AiSessionType;
  status: AiSessionStatus;
  title: string;
  inputPayload: string;
  conversationHistory: string;
  currentQuestion: string | null;
  result: string | null;
  thinkingOutput: string;
  error: string | null;
  projectId: string | null;
  createdAt: string;
  updatedAt: string;
  lockedByTab: string | null;
  lockedAt: string | null;
  archived?: number;
}

export interface AiSessionSummary {
  id: string;
  type: AiSessionType;
  status: AiSessionStatus;
  title: string;
  preview?: string;
  projectId: string | null;
  lockedByTab: string | null;
  updatedAt: string;
  archived?: boolean;
}

export interface AiSessionCleanupSummary {
  terminalDeleted: number;
  orphanedDeleted: number;
  totalDeleted: number;
}

/** Max stored thinking output (50 KB). Older content trimmed from front. */
const MAX_THINKING_BYTES = 50 * 1024;

function trimThinking(output: string): string {
  if (output.length <= MAX_THINKING_BYTES) return output;
  return output.slice(output.length - MAX_THINKING_BYTES);
}

// ── Row conversion ──

/**
 * FNXC:AiSessionStore 2026-06-24-23:05:
 * Convert a Drizzle row (camelCase columns) into the AiSessionRow shape.
 * The jsonb columns are already parsed by Drizzle; callers expect string
 * fields (sync interface compatibility), so we JSON.stringify them.
 */
function rowToSession(row: Record<string, unknown>): AiSessionRow {
  const inputPayload = row.inputPayload;
  const conversationHistory = row.conversationHistory;
  const result = row.result;
  return {
    id: row.id as string,
    type: row.type as AiSessionType,
    status: row.status as AiSessionStatus,
    title: row.title as string,
    inputPayload: typeof inputPayload === "string" ? inputPayload : JSON.stringify(inputPayload ?? {}),
    conversationHistory: typeof conversationHistory === "string"
      ? conversationHistory
      : JSON.stringify(conversationHistory ?? []),
    currentQuestion: (row.currentQuestion as string | null) ?? null,
    result: result == null ? null : typeof result === "string" ? result : JSON.stringify(result),
    thinkingOutput: (row.thinkingOutput as string) ?? "",
    error: (row.error as string | null) ?? null,
    projectId: (row.projectId as string | null) ?? null,
    createdAt: row.createdAt as string,
    updatedAt: row.updatedAt as string,
    lockedByTab: (row.lockedByTab as string | null) ?? null,
    lockedAt: (row.lockedAt as string | null) ?? null,
    archived: typeof row.archived === "number" ? row.archived : Number(row.archived ?? 0),
  };
}

function safeJsonParse<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

// ── Upsert ──

/**
 * FNXC:AiSessionStore 2026-06-24-23:10:
 * Insert or update an AI session row. lockedByTab/lockedAt are set to null on
 * insert but NOT modified on conflict (locks are managed by lock methods).
 */
export async function upsertAiSession(handle: QueryHandle, session: AiSessionRow): Promise<AiSessionRow> {
  const now = new Date().toISOString();
  const thinking = trimThinking(session.thinkingOutput);

  const inputPayloadValue = typeof session.inputPayload === "string"
    ? safeJsonParse(session.inputPayload, {})
    : session.inputPayload;
  const conversationHistoryValue = typeof session.conversationHistory === "string"
    ? safeJsonParse(session.conversationHistory, [])
    : session.conversationHistory;
  const resultValue = session.result == null
    ? null
    : typeof session.result === "string"
      ? safeJsonParse(session.result, null)
      : session.result;

  await handle
    .insert(schema.project.aiSessions)
    .values({
      id: session.id,
      type: session.type,
      status: session.status,
      title: session.title,
      inputPayload: inputPayloadValue as Record<string, unknown>,
      conversationHistory: conversationHistoryValue as unknown[],
      currentQuestion: session.currentQuestion ?? null,
      result: resultValue,
      thinkingOutput: thinking,
      error: session.error ?? null,
      projectId: session.projectId ?? null,
      createdAt: session.createdAt || now,
      updatedAt: now,
      lockedByTab: null,
      lockedAt: null,
    })
    .onConflictDoUpdate({
      target: schema.project.aiSessions.id,
      set: {
        status: session.status,
        title: session.title,
        conversationHistory: conversationHistoryValue as unknown[],
        currentQuestion: session.currentQuestion ?? null,
        result: resultValue,
        thinkingOutput: thinking,
        error: session.error ?? null,
        updatedAt: now,
      },
    });

  const row = await getAiSession(handle, session.id);
  if (!row) throw new Error(`AiSession upsert for ${session.id} succeeded but row could not be read back`);
  return row;
}

// ── Read ──

export async function getAiSession(handle: QueryHandle, id: string): Promise<AiSessionRow | null> {
  const rows = await handle
    .select()
    .from(schema.project.aiSessions)
    .where(eq(schema.project.aiSessions.id, id))
    .limit(1);
  return rows[0] ? rowToSession(rows[0]) : null;
}

/**
 * FNXC:AiSessionStore 2026-06-24-23:15:
 * List active/retryable sessions (generating, awaiting_input, or error),
 * excluding archived. Returns summary rows (no large fields).
 */
export async function listActiveAiSessions(
  handle: QueryHandle,
  projectId?: string,
): Promise<unknown[]> {
  const conditions = [
    inArray(schema.project.aiSessions.status, ["generating", "awaiting_input", "error"]),
    eq(schema.project.aiSessions.archived, 0),
  ];
  if (projectId) conditions.push(eq(schema.project.aiSessions.projectId, projectId));
  const rows = await handle
    .select({
      id: schema.project.aiSessions.id,
      type: schema.project.aiSessions.type,
      status: schema.project.aiSessions.status,
      title: schema.project.aiSessions.title,
      projectId: schema.project.aiSessions.projectId,
      lockedByTab: schema.project.aiSessions.lockedByTab,
      updatedAt: schema.project.aiSessions.updatedAt,
      archived: schema.project.aiSessions.archived,
    })
    .from(schema.project.aiSessions)
    .where(and(...conditions))
    .orderBy(desc(schema.project.aiSessions.updatedAt));
  return rows;
}

/**
 * List all sessions (including complete), optionally filtered by projectId.
 * By default excludes archived. Returns summary rows with inputPayload.
 */
export async function listAllAiSessions(
  handle: QueryHandle,
  projectId?: string,
  options?: { includeArchived?: boolean },
): Promise<unknown[]> {
  const conditions: ReturnType<typeof eq>[] = [];
  if (!options?.includeArchived) {
    conditions.push(eq(schema.project.aiSessions.archived, 0));
  }
  if (projectId) conditions.push(eq(schema.project.aiSessions.projectId, projectId));
  const query = handle
    .select({
      id: schema.project.aiSessions.id,
      type: schema.project.aiSessions.type,
      status: schema.project.aiSessions.status,
      title: schema.project.aiSessions.title,
      inputPayload: schema.project.aiSessions.inputPayload,
      projectId: schema.project.aiSessions.projectId,
      lockedByTab: schema.project.aiSessions.lockedByTab,
      updatedAt: schema.project.aiSessions.updatedAt,
      archived: schema.project.aiSessions.archived,
    })
    .from(schema.project.aiSessions)
    .orderBy(desc(schema.project.aiSessions.updatedAt));
  const rows = conditions.length > 0 ? await query.where(and(...conditions)) : await query;
  return rows;
}

/**
 * List recoverable sessions (generating or awaiting_input). Returns full rows.
 */
export async function listRecoverableAiSessions(
  handle: QueryHandle,
  projectId?: string,
): Promise<AiSessionRow[]> {
  const conditions = [
    inArray(schema.project.aiSessions.status, ["generating", "awaiting_input"]),
  ];
  if (projectId) conditions.push(eq(schema.project.aiSessions.projectId, projectId));
  const rows = await handle
    .select()
    .from(schema.project.aiSessions)
    .where(and(...conditions))
    .orderBy(desc(schema.project.aiSessions.updatedAt));
  return rows.map(rowToSession);
}

// ── Updates ──

export async function updateAiSessionStatus(
  handle: QueryHandle,
  id: string,
  status: AiSessionStatus,
  error?: string,
): Promise<boolean> {
  const now = new Date().toISOString();
  const result = await handle
    .update(schema.project.aiSessions)
    .set({ status, error: error ?? null, updatedAt: now })
    .where(eq(schema.project.aiSessions.id, id))
    .returning({ id: schema.project.aiSessions.id });
  return result.length > 0;
}

export async function updateAiSessionTitle(
  handle: QueryHandle,
  id: string,
  title: string,
): Promise<boolean> {
  const now = new Date().toISOString();
  const result = await handle
    .update(schema.project.aiSessions)
    .set({ title, updatedAt: now })
    .where(eq(schema.project.aiSessions.id, id))
    .returning({ id: schema.project.aiSessions.id });
  return result.length > 0;
}

export async function markDraftSummarized(
  handle: QueryHandle,
  id: string,
  title: string,
  inputPayload: string,
): Promise<boolean> {
  const payloadValue = typeof inputPayload === "string" ? safeJsonParse(inputPayload, {}) : inputPayload;
  const now = new Date().toISOString();
  const result = await handle
    .update(schema.project.aiSessions)
    .set({ title, inputPayload: payloadValue as Record<string, unknown>, updatedAt: now })
    .where(and(eq(schema.project.aiSessions.id, id), eq(schema.project.aiSessions.type, "planning")))
    .returning({ id: schema.project.aiSessions.id });
  return result.length > 0;
}

export async function updateDraft(
  handle: QueryHandle,
  id: string,
  inputPayload: string,
): Promise<boolean> {
  const payloadValue = typeof inputPayload === "string" ? safeJsonParse(inputPayload, {}) : inputPayload;
  const now = new Date().toISOString();
  const result = await handle
    .update(schema.project.aiSessions)
    .set({ inputPayload: payloadValue as Record<string, unknown>, updatedAt: now })
    .where(and(eq(schema.project.aiSessions.id, id), eq(schema.project.aiSessions.type, "planning")))
    .returning({ id: schema.project.aiSessions.id });
  return result.length > 0;
}

export async function pingAiSession(handle: QueryHandle, id: string): Promise<boolean> {
  const now = new Date().toISOString();
  const result = await handle
    .update(schema.project.aiSessions)
    .set({ updatedAt: now })
    .where(eq(schema.project.aiSessions.id, id))
    .returning({ id: schema.project.aiSessions.id });
  return result.length > 0;
}

export async function updateThinking(
  handle: QueryHandle,
  id: string,
  thinkingOutput: string,
): Promise<boolean> {
  const now = new Date().toISOString();
  const result = await handle
    .update(schema.project.aiSessions)
    .set({ thinkingOutput: trimThinking(thinkingOutput), updatedAt: now })
    .where(eq(schema.project.aiSessions.id, id))
    .returning({ id: schema.project.aiSessions.id });
  return result.length > 0;
}

export async function archiveAiSession(handle: QueryHandle, id: string): Promise<boolean> {
  const now = new Date().toISOString();
  const result = await handle
    .update(schema.project.aiSessions)
    .set({ archived: 1, updatedAt: now })
    .where(
      and(
        eq(schema.project.aiSessions.id, id),
        inArray(schema.project.aiSessions.status, ["complete", "error"]),
      ),
    )
    .returning({ id: schema.project.aiSessions.id });
  return result.length > 0;
}

export async function unarchiveAiSession(handle: QueryHandle, id: string): Promise<boolean> {
  const now = new Date().toISOString();
  const result = await handle
    .update(schema.project.aiSessions)
    .set({ archived: 0, updatedAt: now })
    .where(eq(schema.project.aiSessions.id, id))
    .returning({ id: schema.project.aiSessions.id });
  return result.length > 0;
}

// ── Locks ──

export async function acquireAiSessionLock(
  handle: QueryHandle,
  sessionId: string,
  tabId: string,
): Promise<{ acquired: boolean; currentHolder: string | null }> {
  const now = new Date().toISOString();
  const result = await handle
    .update(schema.project.aiSessions)
    .set({ lockedByTab: tabId, lockedAt: now })
    .where(
      and(
        eq(schema.project.aiSessions.id, sessionId),
        or(isNull(schema.project.aiSessions.lockedByTab), eq(schema.project.aiSessions.lockedByTab, tabId)),
      ),
    )
    .returning({ id: schema.project.aiSessions.id });

  if (result.length > 0) {
    return { acquired: true, currentHolder: null };
  }

  const holderRows = await handle
    .select({ lockedByTab: schema.project.aiSessions.lockedByTab })
    .from(schema.project.aiSessions)
    .where(eq(schema.project.aiSessions.id, sessionId))
    .limit(1);
  return { acquired: false, currentHolder: holderRows[0]?.lockedByTab ?? null };
}

export async function releaseAiSessionLock(
  handle: QueryHandle,
  sessionId: string,
  tabId: string,
): Promise<boolean> {
  const result = await handle
    .update(schema.project.aiSessions)
    .set({ lockedByTab: null, lockedAt: null })
    .where(and(eq(schema.project.aiSessions.id, sessionId), eq(schema.project.aiSessions.lockedByTab, tabId)))
    .returning({ id: schema.project.aiSessions.id });
  return result.length > 0;
}

export async function forceAcquireAiSessionLock(
  handle: QueryHandle,
  sessionId: string,
  tabId: string,
): Promise<boolean> {
  const now = new Date().toISOString();
  const result = await handle
    .update(schema.project.aiSessions)
    .set({ lockedByTab: tabId, lockedAt: now })
    .where(eq(schema.project.aiSessions.id, sessionId))
    .returning({ id: schema.project.aiSessions.id });
  return result.length > 0;
}

export async function getAiSessionLockHolder(
  handle: QueryHandle,
  sessionId: string,
): Promise<{ tabId: string | null; lockedAt: string | null }> {
  const rows = await handle
    .select({ lockedByTab: schema.project.aiSessions.lockedByTab, lockedAt: schema.project.aiSessions.lockedAt })
    .from(schema.project.aiSessions)
    .where(eq(schema.project.aiSessions.id, sessionId))
    .limit(1);
  return {
    tabId: rows[0]?.lockedByTab ?? null,
    lockedAt: rows[0]?.lockedAt ?? null,
  };
}

export async function releaseStaleAiSessionLocks(
  handle: QueryHandle,
  maxAgeMs = 30 * 60 * 1000,
): Promise<number> {
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
  const result = await handle
    .update(schema.project.aiSessions)
    .set({ lockedByTab: null, lockedAt: null })
    .where(
      and(
        isNotNull(schema.project.aiSessions.lockedByTab),
        lte(schema.project.aiSessions.lockedAt, cutoff),
      ),
    )
    .returning({ id: schema.project.aiSessions.id });
  return result.length;
}

// ── Delete ──

export async function deleteAiSession(handle: QueryHandle, id: string): Promise<void> {
  await handle.delete(schema.project.aiSessions).where(eq(schema.project.aiSessions.id, id));
}

export async function deleteAiSessionByIdAndType(
  handle: QueryHandle,
  id: string,
  type: AiSessionType,
): Promise<boolean> {
  const result = await handle
    .delete(schema.project.aiSessions)
    .where(and(eq(schema.project.aiSessions.id, id), eq(schema.project.aiSessions.type, type)))
    .returning({ id: schema.project.aiSessions.id });
  return result.length > 0;
}

// ── Recovery / Cleanup ──

export async function recoverStaleAiSessions(handle: QueryHandle): Promise<number> {
  const now = new Date().toISOString();
  let recovered = 0;

  const withQuestion = await handle
    .update(schema.project.aiSessions)
    .set({ status: "awaiting_input", updatedAt: now })
    .where(
      and(
        eq(schema.project.aiSessions.status, "generating"),
        isNotNull(schema.project.aiSessions.currentQuestion),
      ),
    )
    .returning({ id: schema.project.aiSessions.id });
  recovered += withQuestion.length;

  const withoutQuestion = await handle
    .update(schema.project.aiSessions)
    .set({ status: "error", error: "Session interrupted — please restart", updatedAt: now })
    .where(
      and(
        eq(schema.project.aiSessions.status, "generating"),
        isNull(schema.project.aiSessions.currentQuestion),
      ),
    )
    .returning({ id: schema.project.aiSessions.id });
  recovered += withoutQuestion.length;

  return recovered;
}

export async function cleanupOldAiSessions(handle: QueryHandle, maxAgeMs: number): Promise<string[]> {
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
  const result = await handle
    .delete(schema.project.aiSessions)
    .where(
      and(
        lte(schema.project.aiSessions.updatedAt, cutoff),
        inArray(schema.project.aiSessions.status, ["complete", "error"]),
      ),
    )
    .returning({ id: schema.project.aiSessions.id });
  return result.map((r) => r.id);
}

export async function cleanupStaleAiSessions(
  handle: QueryHandle,
  maxAgeMs: number,
): Promise<{ terminalDeletedIds: string[]; orphanedDeletedIds: string[] }> {
  const terminalDeletedIds = await cleanupOldAiSessions(handle, maxAgeMs);
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();

  const orphanedResult = await handle
    .delete(schema.project.aiSessions)
    .where(
      and(
        lte(schema.project.aiSessions.updatedAt, cutoff),
        inArray(schema.project.aiSessions.status, ["generating", "awaiting_input"]),
      ),
    )
    .returning({ id: schema.project.aiSessions.id });
  const orphanedDeletedIds = orphanedResult.map((r) => r.id);

  return { terminalDeletedIds, orphanedDeletedIds };
}
