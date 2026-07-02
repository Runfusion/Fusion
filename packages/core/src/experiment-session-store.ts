import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { Database } from "./db.js";
import { fromJson, toJson, toJsonNullable } from "./db.js";
import type {
  ExperimentConfigRecordPayload,
  ExperimentRecordType,
  ExperimentSession,
  ExperimentSessionCreateInput,
  ExperimentSessionListOptions,
  ExperimentSessionRecord,
  ExperimentSessionRecordAppendInput,
  ExperimentSessionStatus,
  ExperimentSessionStoreEvents,
  ExperimentSessionUpdateInput,
} from "./experiment-session-types.js";
import type { AsyncDataLayer } from "./postgres/data-layer.js";
import * as asyncExp from "./async-experiment-session-store.js";

function generateId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

/**
 * FNXC:ExperimentSessionStore 2026-06-24-14:30:
 * Backend dual-path: when an `AsyncDataLayer` is provided (PostgreSQL backend
 * active), methods delegate to the async-experiment-session-store helpers.
 * When absent, the legacy sync SQLite path runs byte-identically.
 */
export class ExperimentSessionStore extends EventEmitter<ExperimentSessionStoreEvents> {
  private readonly db: Database | null;
  private readonly asyncLayer: AsyncDataLayer | null;
  private readonly insertSessionStmt;

  constructor(db: Database | null, options?: { asyncLayer?: AsyncDataLayer | null }) {
    super();
    this.setMaxListeners(50);
    this.db = db;
    this.asyncLayer = options?.asyncLayer ?? null;
    if (this.asyncLayer) {
      // Backend mode: no prepared statements needed.
      this.insertSessionStmt = null;
      return;
    }
    const sqliteDb = db!;
    this.insertSessionStmt = sqliteDb.prepare(`
      INSERT INTO experiment_sessions (
        id, name, projectId, status, metric, currentSegment, maxIterations, workingDir,
        baselineRunId, bestRunId, keptRunIds, tags, metadata, createdAt, updatedAt, finalizedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
  }

  /** True when the store is backed by PostgreSQL (AsyncDataLayer present). */
  isBackendMode(): boolean {
    return this.asyncLayer !== null;
  }

  createSession(input: ExperimentSessionCreateInput): ExperimentSession {
    const now = new Date().toISOString();
    const session: ExperimentSession = {
      id: generateId("EXP"),
      name: input.name,
      projectId: input.projectId,
      status: input.status ?? "active",
      metric: input.metric,
      currentSegment: input.currentSegment ?? 1,
      maxIterations: input.maxIterations,
      workingDir: input.workingDir,
      baselineRunId: input.baselineRunId,
      bestRunId: input.bestRunId,
      keptRunIds: input.keptRunIds ?? [],
      tags: input.tags ?? [],
      metadata: input.metadata,
      createdAt: now,
      updatedAt: now,
      finalizedAt: input.finalizedAt,
    };

    // FNXC:RuntimeSatelliteAsync 2026-06-24-14:35:
    // Backend mode: insert via async helper (fire-and-forget for EventEmitter compat).
    // The callers that need the persisted result await the async write separately.
    if (this.asyncLayer) {
      void asyncExp.createExperimentSession(this.asyncLayer.db, session);
      this.emit("session:created", session);
      return session;
    }

    this.insertSessionStmt!.run(
      session.id,
      session.name,
      session.projectId ?? null,
      session.status,
      toJson(session.metric),
      session.currentSegment,
      session.maxIterations ?? null,
      session.workingDir ?? null,
      session.baselineRunId ?? null,
      session.bestRunId ?? null,
      toJson(session.keptRunIds),
      toJson(session.tags),
      toJsonNullable(session.metadata),
      session.createdAt,
      session.updatedAt,
      session.finalizedAt ?? null,
    );

    this.db!.bumpLastModified();
    this.emit("session:created", session);
    return session;
  }

  async getSession(id: string): Promise<ExperimentSession | undefined> {
    if (this.asyncLayer) {
      return asyncExp.getExperimentSession(this.asyncLayer.db, id);
    }
    const row = this.db!.prepare("SELECT * FROM experiment_sessions WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToSession(row) : undefined;
  }

  async listSessions(options: ExperimentSessionListOptions = {}): Promise<ExperimentSession[]> {
    if (this.asyncLayer) {
      return asyncExp.listExperimentSessions(this.asyncLayer.db, options);
    }
    const where: string[] = [];
    const params: Array<string | number> = [];

    if (options.status) {
      where.push("status = ?");
      params.push(options.status);
    }
    if (options.projectId) {
      where.push("projectId = ?");
      params.push(options.projectId);
    }
    if (options.tag) {
      where.push("tags LIKE ?");
      params.push(`%"${options.tag}"%`);
    }
    if (options.search) {
      where.push("(name LIKE ? OR COALESCE(workingDir, '') LIKE ?)");
      params.push(`%${options.search}%`, `%${options.search}%`);
    }

    const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const limitClause = options.limit !== undefined ? `LIMIT ${options.limit}` : "";
    const offsetClause = options.offset !== undefined ? `OFFSET ${options.offset}` : "";

    const rows = this.db!.prepare(`
      SELECT * FROM experiment_sessions
      ${whereClause}
      ORDER BY createdAt DESC
      ${limitClause}
      ${offsetClause}
    `).all(...params) as Record<string, unknown>[];

    return rows.map((row) => this.rowToSession(row));
  }

  async updateSession(id: string, patch: ExperimentSessionUpdateInput): Promise<ExperimentSession> {
    const existing = await this.getSession(id);
    if (!existing) throw new Error(`Experiment session not found: ${id}`);

    const now = new Date().toISOString();
    const status = patch.status ?? existing.status;
    const finalizedAt = status === "finalized" ? (patch.finalizedAt ?? existing.finalizedAt ?? now) : (patch.finalizedAt ?? existing.finalizedAt);
    const updated: ExperimentSession = {
      ...existing,
      ...patch,
      status,
      finalizedAt,
      updatedAt: now,
    };

    if (this.asyncLayer) {
      await asyncExp.persistExperimentSession(this.asyncLayer.db, updated);
    } else {
      this.persistSession(updated);
      this.db!.bumpLastModified();
    }
    this.emit("session:updated", updated);
    if (updated.status !== existing.status) {
      this.emit("session:status_changed", updated);
      if (updated.status === "finalized") {
        this.emit("session:finalized", updated);
      }
    }
    return updated;
  }

  async deleteSession(id: string): Promise<boolean> {
    if (this.asyncLayer) {
      const deleted = await asyncExp.deleteExperimentSession(this.asyncLayer.db, id);
      if (deleted) this.emit("session:deleted", id);
      return deleted;
    }
    const result = this.db!.prepare("DELETE FROM experiment_sessions WHERE id = ?").run(id) as { changes?: number };
    const deleted = (result.changes ?? 0) > 0;
    if (deleted) {
      this.db!.bumpLastModified();
      this.emit("session:deleted", id);
    }
    return deleted;
  }

  async appendRecord(sessionId: string, input: ExperimentSessionRecordAppendInput): Promise<ExperimentSessionRecord> {
    if (this.asyncLayer) {
      const session = await this.getSession(sessionId);
      if (!session) throw new Error(`Experiment session not found: ${sessionId}`);
      if (session.status === "finalized" || session.status === "archived") {
        throw new Error(`Cannot append record to ${session.status} session: ${sessionId}`);
      }
      const record = await asyncExp.appendExperimentRecord(this.asyncLayer, {
        id: generateId("EXPR"),
        sessionId,
        segment: input.segment ?? session.currentSegment,
        type: input.type,
        payload: input.payload as unknown as Record<string, unknown>,
      });
      this.emit("record:appended", record);
      return record;
    }
    const session = await this.getSession(sessionId);
    if (!session) throw new Error(`Experiment session not found: ${sessionId}`);
    if (session.status === "finalized" || session.status === "archived") {
      throw new Error(`Cannot append record to ${session.status} session: ${sessionId}`);
    }

    const now = new Date().toISOString();
    const record = this.db!.transaction(() => {
      const seqRow = this.db!
        .prepare("SELECT COALESCE(MAX(seq), 0) + 1 as nextSeq FROM experiment_session_records WHERE sessionId = ?")
        .get(sessionId) as { nextSeq: number };
      const nextSeq = seqRow.nextSeq;
      const created: ExperimentSessionRecord = {
        id: generateId("EXPR"),
        sessionId,
        segment: input.segment ?? session.currentSegment,
        seq: nextSeq,
        type: input.type,
        payload: input.payload,
        createdAt: now,
      } as ExperimentSessionRecord;

      this.db!.prepare(`
        INSERT INTO experiment_session_records (id, sessionId, segment, seq, type, payload, createdAt)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(created.id, created.sessionId, created.segment, created.seq, created.type, toJson(created.payload), created.createdAt);

      return created;
    });

    this.db!.bumpLastModified();
    this.emit("record:appended", record);
    return record;
  }

  async listRecords(sessionId: string, opts: { segment?: number; type?: ExperimentRecordType; limit?: number; offset?: number } = {}): Promise<ExperimentSessionRecord[]> {
    if (this.asyncLayer) {
      return asyncExp.listExperimentRecords(this.asyncLayer.db, sessionId, { segment: opts.segment, type: opts.type });
    }
    const where = ["sessionId = ?"];
    const params: Array<string | number> = [sessionId];

    if (opts.segment !== undefined) {
      where.push("segment = ?");
      params.push(opts.segment);
    }
    if (opts.type) {
      where.push("type = ?");
      params.push(opts.type);
    }

    const limitClause = opts.limit !== undefined ? `LIMIT ${opts.limit}` : "";
    const offsetClause = opts.offset !== undefined ? `OFFSET ${opts.offset}` : "";

    const rows = this.db!.prepare(`
      SELECT * FROM experiment_session_records
      WHERE ${where.join(" AND ")}
      ORDER BY seq ASC
      ${limitClause}
      ${offsetClause}
    `).all(...params) as Record<string, unknown>[];

    return rows.map((row) => this.rowToRecord(row));
  }

  async getRecord(id: string): Promise<ExperimentSessionRecord | undefined> {
    if (this.asyncLayer) {
      return asyncExp.getExperimentRecord(this.asyncLayer.db, id);
    }
    const row = this.db!.prepare("SELECT * FROM experiment_session_records WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToRecord(row) : undefined;
  }

  async startNewSegment(sessionId: string, configPayload: ExperimentConfigRecordPayload): Promise<{ session: ExperimentSession; record: ExperimentSessionRecord }> {
    if (this.asyncLayer) {
      const session = await this.getSession(sessionId);
      if (!session) throw new Error(`Experiment session not found: ${sessionId}`);
      const nextSegment = session.currentSegment + 1;
      const updated: ExperimentSession = { ...session, currentSegment: nextSegment, updatedAt: new Date().toISOString() };
      await asyncExp.persistExperimentSession(this.asyncLayer.db, updated);
      const record = await asyncExp.appendExperimentRecord(this.asyncLayer, {
        id: generateId("EXPR"),
        sessionId,
        segment: nextSegment,
        type: "config",
        payload: configPayload as unknown as Record<string, unknown>,
      });
      this.emit("segment:reset", { sessionId, segment: updated.currentSegment });
      this.emit("record:appended", record);
      return { session: updated, record };
    }
    const result = this.db!.transaction(() => {
      const row = this.db!.prepare("SELECT * FROM experiment_sessions WHERE id = ?").get(sessionId) as Record<string, unknown> | undefined;
      const session = row ? this.rowToSession(row) : undefined;
      if (!session) throw new Error(`Experiment session not found: ${sessionId}`);
      const nextSegment = session.currentSegment + 1;
      const updated: ExperimentSession = { ...session, currentSegment: nextSegment, updatedAt: new Date().toISOString() };
      this.persistSession(updated);

      const seqRow = this.db!
        .prepare("SELECT COALESCE(MAX(seq), 0) + 1 as nextSeq FROM experiment_session_records WHERE sessionId = ?")
        .get(sessionId) as { nextSeq: number };

      const record: ExperimentSessionRecord = {
        id: generateId("EXPR"),
        sessionId,
        segment: nextSegment,
        seq: seqRow.nextSeq,
        type: "config",
        payload: configPayload,
        createdAt: new Date().toISOString(),
      };

      this.db!.prepare(`
        INSERT INTO experiment_session_records (id, sessionId, segment, seq, type, payload, createdAt)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(record.id, record.sessionId, record.segment, record.seq, record.type, toJson(record.payload), record.createdAt);

      return { session: updated, record };
    });

    this.db!.bumpLastModified();
    this.emit("segment:reset", { sessionId, segment: result.session.currentSegment });
    this.emit("record:appended", result.record);
    return result;
  }

  async setBaselineRun(sessionId: string, runRecordId: string): Promise<ExperimentSession> {
    const session = await this.assertRunRecordOwnership(sessionId, runRecordId);
    return this.updateSession(session.id, { baselineRunId: runRecordId });
  }

  async setBestRun(sessionId: string, runRecordId: string): Promise<ExperimentSession> {
    const session = await this.assertRunRecordOwnership(sessionId, runRecordId);
    return this.updateSession(session.id, { bestRunId: runRecordId });
  }

  async updateRecordPayload(recordId: string, patch: Partial<ExperimentSessionRecord["payload"]>): Promise<ExperimentSessionRecord> {
    const record = await this.getRecord(recordId);
    if (!record) throw new Error(`Experiment record not found: ${recordId}`);

    const updated = {
      ...record,
      payload: {
        ...record.payload,
        ...patch,
      },
    } as ExperimentSessionRecord;

    if (this.asyncLayer) {
      // No dedicated async helper for payload-only update; use a raw Drizzle update.
      // FNXC:PostgresBackend 2026-06-27-00:40:
      // Raw async SQL must schema-qualify (project.experiment_session_records);
      // the connection does not put `project` on search_path. `payload` is a
      // jsonb column, so the bound JSON text needs a `::jsonb` cast (matches the
      // async-settings.ts convention) or Postgres rejects the text→jsonb assign.
      const { sql } = await import("drizzle-orm");
      await this.asyncLayer.db.execute(sql`UPDATE project.experiment_session_records SET payload = ${JSON.stringify(updated.payload)}::jsonb WHERE id = ${recordId}`);
    } else {
      this.db!.prepare(`
        UPDATE experiment_session_records
        SET payload = ?
        WHERE id = ?
      `).run(toJson(updated.payload), recordId);
      this.db!.bumpLastModified();
    }
    return updated;
  }

  async recordKept(sessionId: string, runRecordId: string): Promise<ExperimentSession> {
    const session = await this.assertRunRecordOwnership(sessionId, runRecordId);
    const keptRunIds = session.keptRunIds.includes(runRecordId)
      ? session.keptRunIds
      : [...session.keptRunIds, runRecordId];
    return this.updateSession(sessionId, { keptRunIds });
  }

  private async assertRunRecordOwnership(sessionId: string, runRecordId: string): Promise<ExperimentSession> {
    const session = await this.getSession(sessionId);
    if (!session) throw new Error(`Experiment session not found: ${sessionId}`);
    const record = await this.getRecord(runRecordId);
    if (!record) throw new Error(`Experiment record not found: ${runRecordId}`);
    if (record.type !== "run") throw new Error(`Experiment record is not a run: ${runRecordId}`);
    if (record.sessionId !== sessionId) throw new Error(`Experiment record ${runRecordId} does not belong to session ${sessionId}`);
    return session;
  }

  private persistSession(session: ExperimentSession): void {
    this.db!.prepare(`
      UPDATE experiment_sessions
      SET name = ?, projectId = ?, status = ?, metric = ?, currentSegment = ?, maxIterations = ?,
          workingDir = ?, baselineRunId = ?, bestRunId = ?, keptRunIds = ?, tags = ?, metadata = ?,
          updatedAt = ?, finalizedAt = ?
      WHERE id = ?
    `).run(
      session.name,
      session.projectId ?? null,
      session.status,
      toJson(session.metric),
      session.currentSegment,
      session.maxIterations ?? null,
      session.workingDir ?? null,
      session.baselineRunId ?? null,
      session.bestRunId ?? null,
      toJson(session.keptRunIds),
      toJson(session.tags),
      toJsonNullable(session.metadata),
      session.updatedAt,
      session.finalizedAt ?? null,
      session.id,
    );
  }

  private rowToSession(row: Record<string, unknown>): ExperimentSession {
    return {
      id: row.id as string,
      name: row.name as string,
      projectId: (row.projectId as string | null) ?? undefined,
      status: row.status as ExperimentSessionStatus,
      metric: fromJson<ExperimentSession["metric"]>(row.metric as string | null) ?? { name: "unknown", direction: "maximize" },
      currentSegment: Number(row.currentSegment ?? 1),
      maxIterations: (row.maxIterations as number | null) ?? undefined,
      workingDir: (row.workingDir as string | null) ?? undefined,
      baselineRunId: (row.baselineRunId as string | null) ?? undefined,
      bestRunId: (row.bestRunId as string | null) ?? undefined,
      keptRunIds: fromJson<string[]>(row.keptRunIds as string | null) ?? [],
      tags: fromJson<string[]>(row.tags as string | null) ?? [],
      metadata: fromJson<Record<string, unknown>>(row.metadata as string | null),
      createdAt: row.createdAt as string,
      updatedAt: row.updatedAt as string,
      finalizedAt: (row.finalizedAt as string | null) ?? undefined,
    };
  }

  private rowToRecord(row: Record<string, unknown>): ExperimentSessionRecord {
    return {
      id: row.id as string,
      sessionId: row.sessionId as string,
      segment: Number(row.segment),
      seq: Number(row.seq),
      type: row.type as ExperimentSessionRecord["type"],
      payload: fromJson<ExperimentSessionRecord["payload"]>(row.payload as string | null) ?? {},
      createdAt: row.createdAt as string,
    } as ExperimentSessionRecord;
  }
}
