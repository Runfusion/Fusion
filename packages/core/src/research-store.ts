import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { Database } from "./db.js";
import { fromJson, toJson, toJsonNullable } from "./db.js";
import type {
  ResearchEvent,
  ResearchExport,
  ResearchExportFormat,
  ResearchResult,
  ResearchRun,
  ResearchRunCreateInput,
  ResearchRunListOptions,
  ResearchRunStatus,
  ResearchRunUpdateInput,
  ResearchSource,
  ResearchStoreEvents,
} from "./research-types.js";

function generateRunId(): string {
  const timestamp = Date.now().toString(36).toUpperCase();
  const random = Math.random().toString(36).slice(2, 7).toUpperCase();
  return `RR-${timestamp}-${random}`;
}

function generateId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

function mergeRecord(
  currentValue: Record<string, unknown> | undefined,
  patchValue: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!patchValue) return currentValue;
  const merged = { ...(currentValue ?? {}), ...patchValue };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

export class ResearchStore extends EventEmitter<ResearchStoreEvents> {
  constructor(private readonly db: Database) {
    super();
    this.setMaxListeners(50);
  }

  createRun(input: ResearchRunCreateInput): ResearchRun {
    const now = new Date().toISOString();
    const run: ResearchRun = {
      id: generateRunId(),
      query: input.query,
      topic: input.topic,
      status: "pending",
      providerConfig: input.providerConfig,
      sources: input.sources ?? [],
      events: input.events ?? [],
      results: input.results,
      tags: input.tags ?? [],
      metadata: input.metadata,
      createdAt: now,
      updatedAt: now,
    };

    this.db.prepare(`
      INSERT INTO research_runs (
        id, query, topic, status, providerConfig, sources, events, results, error,
        tokenUsage, tags, metadata, createdAt, updatedAt, startedAt, completedAt, cancelledAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      run.id,
      run.query,
      run.topic ?? null,
      run.status,
      toJsonNullable(run.providerConfig),
      toJson(run.sources),
      toJson(run.events),
      toJsonNullable(run.results),
      null,
      null,
      toJson(run.tags),
      toJsonNullable(run.metadata),
      run.createdAt,
      run.updatedAt,
      null,
      null,
      null,
    );

    this.db.bumpLastModified();
    this.emit("run:created", run);
    return run;
  }

  getRun(id: string): ResearchRun | undefined {
    const row = this.db.prepare("SELECT * FROM research_runs WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToRun(row) : undefined;
  }

  updateRun(id: string, input: ResearchRunUpdateInput): ResearchRun | undefined {
    const existing = this.getRun(id);
    if (!existing) return undefined;

    const now = new Date().toISOString();
    const mergedProviderConfig = mergeRecord(existing.providerConfig, input.providerConfig);
    const mergedMetadata = mergeRecord(existing.metadata, input.metadata);

    const updated: ResearchRun = {
      ...existing,
      ...input,
      providerConfig: mergedProviderConfig,
      metadata: mergedMetadata,
      error: input.error === null ? undefined : (input.error ?? existing.error),
      updatedAt: now,
      startedAt: input.startedAt === null ? undefined : (input.startedAt ?? existing.startedAt),
      completedAt: input.completedAt === null ? undefined : (input.completedAt ?? existing.completedAt),
      cancelledAt: input.cancelledAt === null ? undefined : (input.cancelledAt ?? existing.cancelledAt),
    };

    this.persistRun(updated);
    this.emit("run:updated", updated);
    return updated;
  }

  listRuns(options: ResearchRunListOptions = {}): ResearchRun[] {
    const conditions: string[] = [];
    const params: Array<string | number> = [];

    if (options.status) {
      conditions.push("status = ?");
      params.push(options.status);
    }
    if (options.fromDate) {
      conditions.push("createdAt >= ?");
      params.push(options.fromDate);
    }
    if (options.toDate) {
      conditions.push("createdAt <= ?");
      params.push(options.toDate);
    }
    if (options.tag) {
      conditions.push("tags LIKE ?");
      params.push(`%"${options.tag}"%`);
    }
    if (options.search) {
      conditions.push("(query LIKE ? OR COALESCE(topic, '') LIKE ?)");
      params.push(`%${options.search}%`, `%${options.search}%`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = options.limit !== undefined ? `LIMIT ${options.limit}` : "";
    const offset = options.offset !== undefined ? `OFFSET ${options.offset}` : "";

    const rows = this.db.prepare(`
      SELECT * FROM research_runs
      ${where}
      ORDER BY createdAt ASC, id ASC
      ${limit}
      ${offset}
    `).all(...params) as Record<string, unknown>[];

    return rows.map((row) => this.rowToRun(row));
  }

  deleteRun(id: string): boolean {
    const result = this.db.prepare("DELETE FROM research_runs WHERE id = ?").run(id) as { changes?: number };
    const deleted = (result?.changes ?? 0) > 0;
    if (deleted) {
      this.db.bumpLastModified();
      this.emit("run:deleted", id);
    }
    return deleted;
  }

  addEvent(runId: string, event: Omit<ResearchEvent, "id" | "timestamp">): ResearchEvent {
    const run = this.getRun(runId);
    if (!run) throw new Error(`Research run not found: ${runId}`);

    const created: ResearchEvent = {
      id: generateId("REVT"),
      timestamp: new Date().toISOString(),
      type: event.type,
      message: event.message,
      metadata: event.metadata,
    };

    this.updateRun(runId, { events: [...run.events, created] });
    this.emit("event:added", { runId, event: created });
    return created;
  }

  appendEvent(runId: string, event: Omit<ResearchEvent, "id" | "timestamp">): ResearchEvent {
    return this.addEvent(runId, event);
  }

  addSource(runId: string, source: Omit<ResearchSource, "id">): ResearchSource {
    const run = this.getRun(runId);
    if (!run) throw new Error(`Research run not found: ${runId}`);

    const created: ResearchSource = { ...source, id: generateId("RSRC") };
    this.updateRun(runId, { sources: [...run.sources, created] });
    this.emit("source:added", { runId, source: created });
    return created;
  }

  updateSource(runId: string, sourceId: string, updates: Partial<ResearchSource>): void {
    const run = this.getRun(runId);
    if (!run) throw new Error(`Research run not found: ${runId}`);

    const next = run.sources.map((source) => {
      if (source.id !== sourceId) return source;
      return {
        ...source,
        ...updates,
        id: source.id,
      };
    });

    this.updateRun(runId, { sources: next });
  }

  setResults(runId: string, results: ResearchResult): void {
    const updated = this.updateRun(runId, { results });
    if (!updated) throw new Error(`Research run not found: ${runId}`);
  }

  updateStatus(runId: string, status: ResearchRunStatus, extra?: Partial<ResearchRun>): void {
    const run = this.getRun(runId);
    if (!run) throw new Error(`Research run not found: ${runId}`);

    const now = new Date().toISOString();
    const patch: ResearchRunUpdateInput = {
      ...(extra ?? {}),
      status,
    };

    if (status === "running" && !run.startedAt) {
      patch.startedAt = now;
    }
    if ((status === "completed" || status === "failed") && !run.completedAt) {
      patch.completedAt = now;
    }
    if (status === "cancelled" && !run.cancelledAt) {
      patch.cancelledAt = now;
    }

    const updated = this.updateRun(runId, patch);
    if (!updated) return;

    this.emit("run:status_changed", updated);
    if (status === "completed") this.emit("run:completed", updated);
    if (status === "failed") this.emit("run:failed", updated);
    if (status === "cancelled") this.emit("run:cancelled", updated);
  }

  createExport(runId: string, format: ResearchExportFormat, content: string): ResearchExport {
    const now = new Date().toISOString();
    const exportRecord: ResearchExport = {
      id: generateId("REXP"),
      runId,
      format,
      content,
      createdAt: now,
    };

    this.db.prepare(`
      INSERT INTO research_exports (id, runId, format, content, filePath, createdAt)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(exportRecord.id, runId, format, content, null, now);

    this.db.bumpLastModified();
    return exportRecord;
  }

  getExports(runId: string): ResearchExport[] {
    const rows = this.db.prepare(`
      SELECT * FROM research_exports
      WHERE runId = ?
      ORDER BY createdAt ASC, id ASC
    `).all(runId) as Record<string, unknown>[];

    return rows.map((row) => this.rowToExport(row));
  }

  getExport(id: string): ResearchExport | undefined {
    const row = this.db.prepare("SELECT * FROM research_exports WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToExport(row) : undefined;
  }

  searchRuns(query: string): ResearchRun[] {
    const q = `%${query}%`;
    const rows = this.db.prepare(`
      SELECT * FROM research_runs
      WHERE query LIKE ?
        OR COALESCE(topic, '') LIKE ?
        OR COALESCE(json_extract(results, '$.summary'), '') LIKE ?
      ORDER BY createdAt ASC, id ASC
    `).all(q, q, q) as Record<string, unknown>[];

    return rows.map((row) => this.rowToRun(row));
  }

  getStats(): { total: number; byStatus: Record<ResearchRunStatus, number> } {
    const rows = this.db.prepare(`
      SELECT status, COUNT(*) as count
      FROM research_runs
      GROUP BY status
    `).all() as Array<{ status: ResearchRunStatus; count: number }>;

    const byStatus: Record<ResearchRunStatus, number> = {
      pending: 0,
      running: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
    };

    for (const row of rows) {
      byStatus[row.status] = row.count;
    }

    const total = Object.values(byStatus).reduce((acc, value) => acc + value, 0);
    return { total, byStatus };
  }

  private persistRun(run: ResearchRun): void {
    this.db.prepare(`
      UPDATE research_runs
      SET query = ?, topic = ?, status = ?, providerConfig = ?, sources = ?, events = ?,
          results = ?, error = ?, tokenUsage = ?, tags = ?, metadata = ?, updatedAt = ?,
          startedAt = ?, completedAt = ?, cancelledAt = ?
      WHERE id = ?
    `).run(
      run.query,
      run.topic ?? null,
      run.status,
      toJsonNullable(run.providerConfig),
      toJson(run.sources),
      toJson(run.events),
      toJsonNullable(run.results),
      run.error ?? null,
      toJsonNullable(run.tokenUsage),
      toJson(run.tags),
      toJsonNullable(run.metadata),
      run.updatedAt,
      run.startedAt ?? null,
      run.completedAt ?? null,
      run.cancelledAt ?? null,
      run.id,
    );

    this.db.bumpLastModified();
  }

  private rowToRun(row: Record<string, unknown>): ResearchRun {
    return {
      id: row.id as string,
      query: row.query as string,
      topic: (row.topic as string | null) ?? undefined,
      status: row.status as ResearchRunStatus,
      providerConfig: fromJson<Record<string, unknown>>(row.providerConfig as string | null),
      sources: fromJson<ResearchSource[]>(row.sources as string | null) ?? [],
      events: fromJson<ResearchEvent[]>(row.events as string | null) ?? [],
      results: fromJson<ResearchResult>(row.results as string | null),
      error: (row.error as string | null) ?? undefined,
      tokenUsage: fromJson<ResearchRun["tokenUsage"]>(row.tokenUsage as string | null),
      tags: fromJson<string[]>(row.tags as string | null) ?? [],
      metadata: fromJson<Record<string, unknown>>(row.metadata as string | null),
      createdAt: row.createdAt as string,
      updatedAt: row.updatedAt as string,
      startedAt: (row.startedAt as string | null) ?? undefined,
      completedAt: (row.completedAt as string | null) ?? undefined,
      cancelledAt: (row.cancelledAt as string | null) ?? undefined,
    };
  }

  private rowToExport(row: Record<string, unknown>): ResearchExport {
    return {
      id: row.id as string,
      runId: row.runId as string,
      format: row.format as ResearchExportFormat,
      content: row.content as string,
      filePath: (row.filePath as string | null) ?? undefined,
      createdAt: row.createdAt as string,
    };
  }
}
