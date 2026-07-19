import { randomUUID } from "node:crypto";
import { type AsyncDataLayer, type Database, type PlanningQuestion, type PluginContext } from "@fusion/core";
import { sql } from "drizzle-orm";
/* FNXC:CompoundEngineeringPostgres 2026-07-13-23:42: Import SQL construction from Drizzle directly because the CLI's bundled-plugin @fusion/core shim does not expose database query builders. */
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

export class PlanHandoffClaimError extends Error {
  constructor(
    readonly artifactPath: string,
    readonly sessionId: string,
  ) {
    super(`Plan session ${sessionId} is already enriching ${artifactPath}`);
    this.name = "PlanHandoffClaimError";
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const candidate = current as { code?: unknown; message?: unknown; cause?: unknown };
    if (candidate.code === "23505") return true;
    if (typeof candidate.message === "string" && /duplicate key|unique constraint/i.test(candidate.message)) return true;
    current = candidate.cause;
  }
  return false;
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
    lastActivityAt: Number(row.lastActivityAt),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Plugin-local persistence for CE interactive sessions. Reaches the DB the same
 * way reports does (via `ctx.taskStore.getAsyncLayer()`), and ensures its schema
 * defensively on construction so a store created before `onSchemaInit` ran (or
 * in a test) still works.
 */
export class CeSessionStore {
  // FNXC:RuntimeSatelliteAsync 2026-06-24-22:45:
  // db is null in backend mode (PostgreSQL). Store methods that use sync
  // SQLite will throw in backend mode until the async path is implemented.
  private readonly db: Database | null;

  constructor(db: Database | null, private readonly asyncLayer: AsyncDataLayer | null = null) {
    this.db = db;
    if (db) ensureCeSchema(db);
  }

  /** Asserts sync db is available (throws in backend mode). */
  private syncDb(): Database {
    if (!this.db) throw new Error("CeSessionStore: sync Database is null (backend mode)");
    return this.db;
  }

  create(input: CreateCeSessionInput): CeSession {
    const session = this.newSession(input);
    this.insert(session);
    return session;
  }

  /*
   * FNXC:CompoundEngineeringPlanning 2026-07-11-00:18:
   * A requirements artifact can have exactly one Plan owner until that session is discarded. Claim it in the same immediate transaction as the Plan row so concurrent dashboard/API requests cannot both enrich the same document; discarding that session intentionally releases the claim for a retry.
   */
  createWithPlanHandoffClaim(input: CreateCeSessionInput, artifactPath: string): CeSession {
    const session = this.newSession({ ...input, artifactPath });
    const db = this.syncDb();
    return db.transactionImmediate(() => {
      const existing = db
        .prepare("SELECT sessionId FROM ce_plan_handoff_claims WHERE artifactPath = ?")
        .get(artifactPath) as { sessionId: string } | undefined;
      if (existing) throw new PlanHandoffClaimError(artifactPath, existing.sessionId);

      this.insert(session);
      db
        .prepare("INSERT INTO ce_plan_handoff_claims (artifactPath, sessionId, projectId, createdAt) VALUES (?, ?, ?, ?)")
        .run(artifactPath, session.id, session.projectId, session.createdAt);
      return session;
    });
  }

  private newSession(input: CreateCeSessionInput): CeSession {
    const now = new Date().toISOString();
    return {
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
  }

  private insert(session: CeSession): void {
    this.syncDb()
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
  }

  get(id: string): CeSession | undefined {
    const row = this.syncDb().prepare(`SELECT * FROM ce_sessions WHERE id = ?`).get(id) as CeSessionRow | undefined;
    return row ? rowToSession(row) : undefined;
  }

  list(filter: { status?: CeSessionStatus; stage?: string; projectId?: string } = {}): CeSession[] {
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
    if (filter.projectId) {
      clauses.push("projectId = ?");
      params.push(filter.projectId);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.syncDb()
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
    this.syncDb()
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
    const db = this.syncDb();
    return db.transactionImmediate(() => {
      const result = db.prepare(`DELETE FROM ce_sessions WHERE id = ?`).run(id);
      if (Number(result.changes ?? 0) > 0) {
        db.prepare("DELETE FROM ce_plan_handoff_claims WHERE sessionId = ?").run(id);
        return true;
      }
      return false;
    });
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

  /**
   * FNXC:CompoundEngineeringPostgresPersistence 2026-07-13-22:37:
   * Session orchestration uses these async siblings so backend mode persists through the project-bound AsyncDataLayer while SQLite callers retain their established synchronous API. PostgreSQL reads ignore caller-supplied cross-project filters and always enforce the layer's project ID.
   */
  async createAsync(input: CreateCeSessionInput): Promise<CeSession> {
    if (!this.asyncLayer) return this.create(input);
    const projectId = this.requireProjectId();
    const session = this.newSession({ ...input, projectId });
    await this.insertAsync(session);
    return session;
  }

  async createWithPlanHandoffClaimAsync(input: CreateCeSessionInput, artifactPath: string): Promise<CeSession> {
    if (!this.asyncLayer) return this.createWithPlanHandoffClaim(input, artifactPath);
    const projectId = this.requireProjectId();
    const session = this.newSession({ ...input, projectId, artifactPath });
    try {
      await this.asyncLayer.transactionImmediate(async (tx) => {
        await tx.execute(sql`INSERT INTO project.ce_sessions
          (id, stage, status, current_question, conversation_history, project_id, artifact_path, error, turn_interval_ms, last_activity_at, created_at, updated_at)
          VALUES(${session.id}, ${session.stage}, ${session.status}, NULL, '[]', ${projectId}, ${artifactPath}, NULL, ${session.turnIntervalMs}, ${session.lastActivityAt}, ${session.createdAt}, ${session.updatedAt})`);
        await tx.execute(sql`INSERT INTO project.ce_plan_handoff_claims(project_id, artifact_path, session_id, created_at)
          VALUES(${projectId}, ${artifactPath}, ${session.id}, ${session.createdAt})`);
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        const rows = await this.asyncLayer.db.execute(sql`SELECT session_id FROM project.ce_plan_handoff_claims WHERE project_id=${projectId} AND artifact_path=${artifactPath} LIMIT 1`) as unknown as Array<{ session_id: string }>;
        throw new PlanHandoffClaimError(artifactPath, rows[0]?.session_id ?? "unknown");
      }
      throw error;
    }
    return session;
  }

  private requireProjectId(): string {
    const projectId = this.asyncLayer?.projectId;
    if (!projectId) throw new Error("CE PostgreSQL persistence requires a project-bound data layer");
    return projectId;
  }

  private async insertAsync(session: CeSession): Promise<void> {
    await this.asyncLayer!.db.execute(sql`INSERT INTO project.ce_sessions
      (id, stage, status, current_question, conversation_history, project_id, artifact_path, error, turn_interval_ms, last_activity_at, created_at, updated_at)
      VALUES(${session.id}, ${session.stage}, ${session.status}, NULL, ${JSON.stringify(session.conversationHistory)}, ${session.projectId}, ${session.artifactPath}, NULL, ${session.turnIntervalMs}, ${session.lastActivityAt}, ${session.createdAt}, ${session.updatedAt})`);
  }

  async getAsync(id: string): Promise<CeSession | undefined> {
    if (!this.asyncLayer) return this.get(id);
    const rows = await this.asyncLayer.db.execute(sql`SELECT id, stage, status, current_question AS "currentQuestion", conversation_history AS "conversationHistory", project_id AS "projectId", artifact_path AS "artifactPath", error, turn_interval_ms AS "turnIntervalMs", last_activity_at AS "lastActivityAt", created_at AS "createdAt", updated_at AS "updatedAt" FROM project.ce_sessions WHERE project_id=${this.requireProjectId()} AND id=${id} LIMIT 1`) as unknown as CeSessionRow[];
    return rows[0] ? rowToSession(rows[0]) : undefined;
  }

  async listAsync(filter: { status?: CeSessionStatus; stage?: string; projectId?: string } = {}): Promise<CeSession[]> {
    if (!this.asyncLayer) return this.list(filter);
    const projectId = this.requireProjectId();
    const rows = await this.asyncLayer.db.execute(sql`SELECT id, stage, status, current_question AS "currentQuestion", conversation_history AS "conversationHistory", project_id AS "projectId", artifact_path AS "artifactPath", error, turn_interval_ms AS "turnIntervalMs", last_activity_at AS "lastActivityAt", created_at AS "createdAt", updated_at AS "updatedAt" FROM project.ce_sessions WHERE project_id=${projectId} AND (${filter.status ?? null}::text IS NULL OR status=${filter.status ?? null}) AND (${filter.stage ?? null}::text IS NULL OR stage=${filter.stage ?? null}) ORDER BY updated_at DESC, id`) as unknown as CeSessionRow[];
    return rows.map(rowToSession);
  }

  async updateAsync(id: string, patch: Partial<Pick<CeSession, "status" | "currentQuestion" | "conversationHistory" | "artifactPath" | "error" | "lastActivityAt" | "projectId">>): Promise<CeSession | undefined> {
    if (!this.asyncLayer) return this.update(id, patch);
    const projectId = this.requireProjectId();
    const updatedAt = new Date().toISOString();
    const lastActivityAt = patch.lastActivityAt ?? Date.now();
    const has = (key: keyof typeof patch): boolean => Object.prototype.hasOwnProperty.call(patch, key);
    /*
     * FNXC:CompoundEngineeringConcurrency 2026-07-14-00:18:
     * PostgreSQL session patches must update only the fields named by the caller. A prior read-modify-write rewrote the entire row, allowing a delayed heartbeat to restore stale history or a pre-terminal status after a question/completion had committed.
     */
    const rows = await this.asyncLayer.db.execute(sql`
      UPDATE project.ce_sessions SET
        status = CASE WHEN ${has("status")} THEN ${patch.status ?? null}::text ELSE status END,
        current_question = CASE WHEN ${has("currentQuestion")} THEN ${patch.currentQuestion ? JSON.stringify(patch.currentQuestion) : null}::text ELSE current_question END,
        conversation_history = CASE WHEN ${has("conversationHistory")} THEN ${patch.conversationHistory ? JSON.stringify(patch.conversationHistory) : null}::text ELSE conversation_history END,
        artifact_path = CASE WHEN ${has("artifactPath")} THEN ${patch.artifactPath ?? null}::text ELSE artifact_path END,
        error = CASE WHEN ${has("error")} THEN ${patch.error ?? null}::text ELSE error END,
        last_activity_at = ${lastActivityAt},
        updated_at = ${updatedAt}
      WHERE project_id=${projectId} AND id=${id}
      RETURNING id, stage, status, current_question AS "currentQuestion", conversation_history AS "conversationHistory", project_id AS "projectId", artifact_path AS "artifactPath", error, turn_interval_ms AS "turnIntervalMs", last_activity_at AS "lastActivityAt", created_at AS "createdAt", updated_at AS "updatedAt"
    `) as unknown as CeSessionRow[];
    return rows[0] ? rowToSession(rows[0]) : undefined;
  }

  /** Atomically append one history turn so simultaneous progress/terminal writes cannot drop either turn. */
  async appendHistoryAsync(id: string, turn: CeConversationTurn): Promise<CeSession | undefined> {
    if (!this.asyncLayer) return this.appendHistory(id, turn);
    const projectId = this.requireProjectId();
    const now = Date.now();
    const updatedAt = new Date(now).toISOString();
    const rows = await this.asyncLayer.db.execute(sql`
      UPDATE project.ce_sessions SET
        conversation_history = ((conversation_history::jsonb || jsonb_build_array(${JSON.stringify(turn)}::jsonb))::text),
        last_activity_at = ${now},
        updated_at = ${updatedAt}
      WHERE project_id=${projectId} AND id=${id}
      RETURNING id, stage, status, current_question AS "currentQuestion", conversation_history AS "conversationHistory", project_id AS "projectId", artifact_path AS "artifactPath", error, turn_interval_ms AS "turnIntervalMs", last_activity_at AS "lastActivityAt", created_at AS "createdAt", updated_at AS "updatedAt"
    `) as unknown as CeSessionRow[];
    return rows[0] ? rowToSession(rows[0]) : undefined;
  }

  /** Atomically touch only liveness columns; safe to run beside terminal/history mutations. */
  async touchActivityAsync(id: string, at = Date.now()): Promise<boolean> {
    if (!this.asyncLayer) return Boolean(this.update(id, { lastActivityAt: at }));
    const rows = await this.asyncLayer.db.execute(sql`
      UPDATE project.ce_sessions
      SET last_activity_at=${at}, updated_at=${new Date(at).toISOString()}
      WHERE project_id=${this.requireProjectId()} AND id=${id}
      RETURNING id
    `) as unknown as Array<{ id: string }>;
    return rows.length > 0;
  }
  async deleteAsync(id: string): Promise<boolean> { if (!this.asyncLayer) return this.delete(id); const existing = await this.getAsync(id); if (!existing) return false; await this.asyncLayer.db.execute(sql`DELETE FROM project.ce_sessions WHERE project_id=${this.requireProjectId()} AND id=${id}`); return true; }
  async recoverStaleSessionsAsync(now = Date.now(), multiple = STALE_INTERVAL_MULTIPLE): Promise<string[]> {
    if (!this.asyncLayer) return this.recoverStaleSessions(now, multiple);
    const rows = await this.asyncLayer.db.execute(sql`SELECT id, stage, status, current_question AS "currentQuestion", conversation_history AS "conversationHistory", project_id AS "projectId", artifact_path AS "artifactPath", error, turn_interval_ms AS "turnIntervalMs", last_activity_at AS "lastActivityAt", created_at AS "createdAt", updated_at AS "updatedAt" FROM project.ce_sessions WHERE project_id=${this.requireProjectId()} AND status IN ('active', 'launching') AND last_activity_at < (${now}::bigint - (${multiple}::bigint * turn_interval_ms::bigint))`) as unknown as CeSessionRow[];
    const candidates = rows.map(rowToSession);
    await Promise.all(candidates.map((session) => this.updateAsync(
      session.id,
      session.currentQuestion
        ? { status: "awaiting_input" }
        : { status: "interrupted", error: session.error ?? "Session interrupted — progress preserved, resume to continue" },
    )));
    return candidates.map((session) => session.id);
  }
}

const storeCache = new WeakMap<object, CeSessionStore>();

/** WeakMap-cached store keyed by the TaskStore instance (mirrors reports). */
export function getCeSessionStore(ctx: PluginContext): CeSessionStore {
  const key = ctx.taskStore as object;
  const cached = storeCache.get(key);
  if (cached) return cached;
  const layer = ctx.taskStore.getAsyncLayer();
  if (!layer) throw new Error("Compound Engineering session store requires the project PostgreSQL AsyncDataLayer");
  const store = new CeSessionStore(null, layer);
  storeCache.set(key, store);
  return store;
}
