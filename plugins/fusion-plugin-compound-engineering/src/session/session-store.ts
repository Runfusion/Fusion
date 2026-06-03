import { randomUUID } from "node:crypto";
import type { Database, PlanningQuestion, PluginContext } from "@fusion/core";
import { ensureCeSchema } from "../schema.js";

/**
 * CE session lifecycle states (mirrors the plan's state machine):
 * launching → active → awaiting_input ↔ active → completed | error | interrupted;
 * interrupted/error → active on resume/retry.
 */
export const CE_SESSION_STATUSES = [
  "launching",
  "active",
  "awaiting_input",
  "completed",
  "error",
  "interrupted",
] as const;

export type CeSessionStatus = (typeof CE_SESSION_STATUSES)[number];

/** Narrow an arbitrary string (e.g. a query param) to a valid status, else undefined. */
export function asCeSessionStatus(value: string | undefined): CeSessionStatus | undefined {
  return value && (CE_SESSION_STATUSES as readonly string[]).includes(value)
    ? (value as CeSessionStatus)
    : undefined;
}

/** A single recorded turn in the conversation history (for resume). */
export interface CeConversationTurn {
  role: "user" | "agent";
  /** Free text, or a serialized question/answer marker. */
  text: string;
  at: string;
}

/**
 * One line of live agent activity (mid-turn working output): an accumulated
 * thinking/text block or a discrete tool execution marker.
 */
export interface CeActivityTurn {
  kind: "thinking" | "text" | "tool";
  text: string;
  at: string;
  /** Tool turns: execution finished. */
  done?: boolean;
  /** Tool turns: execution finished with an error. */
  isError?: boolean;
}

export interface CeSession {
  id: string;
  stage: string;
  status: CeSessionStatus;
  currentQuestion: PlanningQuestion | null;
  conversationHistory: CeConversationTurn[];
  /**
   * TRANSIENT: in-flight working output for the current turn, attached by the
   * GET-session route from the orchestrator's in-memory buffer. Never persisted
   * to the row; absent when no turn is running (or in another process).
   */
  liveActivity?: CeActivityTurn[];
  projectId: string | null;
  artifactPath: string | null;
  error: string | null;
  /** Expected per-turn interval (ms); drives interval-relative staleness. */
  turnIntervalMs: number;
  /** Epoch millis of the last produced event (liveness anchor). */
  lastActivityAt: number;
  createdAt: string;
  updatedAt: string;
}

interface CeSessionRow {
  id: string;
  stage: string;
  status: CeSessionStatus;
  currentQuestion: string | null;
  conversationHistory: string;
  projectId: string | null;
  artifactPath: string | null;
  error: string | null;
  turnIntervalMs: number;
  lastActivityAt: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateCeSessionInput {
  stage: string;
  projectId?: string | null;
  artifactPath?: string | null;
  turnIntervalMs?: number;
  id?: string;
}

/**
 * Default multiple of the turn interval beyond which a non-terminal session is
 * considered stale. Mirrors the FN-4172 rubric (`> 3× interval`), interval-
 * relative rather than a raw last-event age.
 */
export const STALE_INTERVAL_MULTIPLE = 3;

const DEFAULT_TURN_INTERVAL_MS = 120000;

/**
 * Parse a JSON column, falling back to `fallback` when it is missing, fails to
 * parse (syntax error), OR parses to the wrong shape. Shape validation matters:
 * a column holding `'null'` or `'{}'` parses fine but would yield a non-array
 * `conversationHistory` that later crashes `appendHistory`'s spread — so a
 * semantically-corrupt value is treated exactly like a syntactically-corrupt one.
 */
function safeParse<T>(raw: string | null, fallback: T, isValid: (value: unknown) => value is T): T {
  if (!raw) return fallback;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isValid(parsed) ? parsed : fallback;
  } catch {
    // A corrupted JSON column must not crash reads of an otherwise-valid row
    // (and must not destroy the rest of the session). Degrade to the fallback;
    // the row's status/error still surface the session's real state.
    return fallback;
  }
}

function isConversationHistory(value: unknown): value is CeConversationTurn[] {
  return (
    Array.isArray(value)
    && value.every((turn) => {
      if (typeof turn !== "object" || turn === null) return false;
      const t = turn as Record<string, unknown>;
      return (t.role === "user" || t.role === "agent") && typeof t.text === "string" && typeof t.at === "string";
    })
  );
}

function isPlanningQuestionOrNull(value: unknown): value is PlanningQuestion | null {
  if (value === null) return true;
  if (typeof value !== "object") return false;
  const q = value as Record<string, unknown>;
  return typeof q.id === "string" && typeof q.type === "string" && typeof q.question === "string";
}

function rowToSession(row: CeSessionRow): CeSession {
  return {
    id: row.id,
    stage: row.stage,
    status: row.status,
    currentQuestion: safeParse<PlanningQuestion | null>(row.currentQuestion, null, isPlanningQuestionOrNull),
    conversationHistory: safeParse<CeConversationTurn[]>(row.conversationHistory, [], isConversationHistory),
    projectId: row.projectId,
    artifactPath: row.artifactPath,
    error: row.error,
    turnIntervalMs: row.turnIntervalMs,
    lastActivityAt: row.lastActivityAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Plugin-local persistence for CE interactive sessions. Reaches the DB the same
 * way reports does (via `ctx.taskStore.getDatabase()`), and ensures its schema
 * defensively on construction so a store created before `onSchemaInit` ran (or
 * in a test) still works.
 */
export class CeSessionStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
    ensureCeSchema(db);
  }

  create(input: CreateCeSessionInput): CeSession {
    const now = new Date().toISOString();
    const session: CeSession = {
      id: input.id ?? randomUUID(),
      stage: input.stage,
      status: "launching",
      currentQuestion: null,
      conversationHistory: [],
      projectId: input.projectId ?? null,
      artifactPath: input.artifactPath ?? null,
      error: null,
      turnIntervalMs: input.turnIntervalMs ?? DEFAULT_TURN_INTERVAL_MS,
      lastActivityAt: Date.now(),
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO ce_sessions
          (id, stage, status, currentQuestion, conversationHistory, projectId, artifactPath, error, turnIntervalMs, lastActivityAt, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        session.id,
        session.stage,
        session.status,
        null,
        JSON.stringify(session.conversationHistory),
        session.projectId,
        session.artifactPath,
        null,
        session.turnIntervalMs,
        session.lastActivityAt,
        session.createdAt,
        session.updatedAt,
      );
    return session;
  }

  get(id: string): CeSession | undefined {
    const row = this.db.prepare(`SELECT * FROM ce_sessions WHERE id = ?`).get(id) as CeSessionRow | undefined;
    return row ? rowToSession(row) : undefined;
  }

  list(filter: { status?: CeSessionStatus; stage?: string } = {}): CeSession[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.status) {
      clauses.push("status = ?");
      params.push(filter.status);
    }
    if (filter.stage) {
      clauses.push("stage = ?");
      params.push(filter.stage);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM ce_sessions ${where} ORDER BY updatedAt DESC, id`)
      .all(...params) as CeSessionRow[];
    return rows.map(rowToSession);
  }

  /**
   * Patch a session. Always bumps `updatedAt`; bumps `lastActivityAt` unless the
   * caller explicitly overrides it (used by liveness tests to simulate age).
   */
  update(
    id: string,
    patch: Partial<
      Pick<
        CeSession,
        "status" | "currentQuestion" | "conversationHistory" | "artifactPath" | "error" | "lastActivityAt" | "projectId"
      >
    >,
  ): CeSession | undefined {
    const existing = this.get(id);
    if (!existing) return undefined;
    const next: CeSession = {
      ...existing,
      ...patch,
      lastActivityAt: patch.lastActivityAt ?? Date.now(),
      updatedAt: new Date().toISOString(),
    };
    this.db
      .prepare(
        `UPDATE ce_sessions SET
           status = ?, currentQuestion = ?, conversationHistory = ?, projectId = ?,
           artifactPath = ?, error = ?, lastActivityAt = ?, updatedAt = ?
         WHERE id = ?`,
      )
      .run(
        next.status,
        next.currentQuestion ? JSON.stringify(next.currentQuestion) : null,
        JSON.stringify(next.conversationHistory),
        next.projectId,
        next.artifactPath,
        next.error,
        next.lastActivityAt,
        next.updatedAt,
        id,
      );
    return next;
  }

  /** Delete a session row. Returns true when a row was removed. */
  delete(id: string): boolean {
    const result = this.db.prepare(`DELETE FROM ce_sessions WHERE id = ?`).run(id);
    return Number(result.changes ?? 0) > 0;
  }

  /** Append a turn to the conversation history (no other field touched). */
  appendHistory(id: string, turn: CeConversationTurn): CeSession | undefined {
    const existing = this.get(id);
    if (!existing) return undefined;
    return this.update(id, { conversationHistory: [...existing.conversationHistory, turn] });
  }

  /**
   * Interval-relative staleness: a non-terminal session is stale only when its
   * last activity is older than `multiple × turnIntervalMs`. A healthy-but-slow
   * session (within the interval band) is NOT stale. Terminal sessions
   * (completed/error/interrupted) are never "stale" — they are already settled.
   */
  isStale(session: CeSession, now = Date.now(), multiple = STALE_INTERVAL_MULTIPLE): boolean {
    if (session.status === "completed" || session.status === "error" || session.status === "interrupted") {
      return false;
    }
    return now - session.lastActivityAt > multiple * session.turnIntervalMs;
  }

  /**
   * Recover sessions left non-terminal by a crash/restart. A session with a
   * persisted `currentQuestion` is restored to `awaiting_input` (resumable);
   * one without is marked `interrupted` with its progress preserved — never
   * silently dropped. Returns the ids transitioned.
   */
  recoverStaleSessions(now = Date.now(), multiple = STALE_INTERVAL_MULTIPLE): string[] {
    // Only IN-FLIGHT agent turns are subject to the interval-staleness rubric:
    // `active`/`launching` mean an agent turn should be progressing, so exceeding
    // the interval band signals a crashed/abandoned turn worth recovering.
    //
    // `awaiting_input` is DELIBERATELY excluded: a session waiting on human input
    // is not a crashed turn — human response time is unbounded, and the interval
    // rubric measures agent turns, not human waits. Flagging it stale would
    // misclassify a legitimately-paused session. It is already in its resumable
    // state, so no recovery action is needed.
    const candidates = this.list().filter(
      (s) => (s.status === "active" || s.status === "launching") && this.isStale(s, now, multiple),
    );
    const recovered: string[] = [];
    for (const s of candidates) {
      if (s.currentQuestion) {
        this.update(s.id, { status: "awaiting_input" });
      } else {
        this.update(s.id, { status: "interrupted", error: s.error ?? "Session interrupted — progress preserved, resume to continue" });
      }
      recovered.push(s.id);
    }
    return recovered;
  }
}

const storeCache = new WeakMap<object, CeSessionStore>();

/** WeakMap-cached store keyed by the TaskStore instance (mirrors reports). */
export function getCeSessionStore(ctx: PluginContext): CeSessionStore {
  const key = ctx.taskStore as object;
  const cached = storeCache.get(key);
  if (cached) return cached;
  const store = new CeSessionStore(ctx.taskStore.getDatabase());
  storeCache.set(key, store);
  return store;
}
