import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { Database } from "../db/db.js";
import { fromJson, toJson, toJsonNullable } from "../db/db.js";
import type {
  ResearchEvent,
  ResearchExport,
  ResearchExportFormat,
  ResearchResult,
  ResearchRun,
  ResearchRunCreateInput,
  ResearchRunEvent,
  ResearchErrorCode,
  ResearchRunFailureClass,
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

export class ResearchLifecycleError extends Error {
  constructor(
    message: string,
    readonly code: "invalid_transition" | "terminal_immutable" | "active_run_conflict" | "not_retryable",
  ) {
    super(message);
    this.name = "ResearchLifecycleError";
  }
}

function mergeRecord(
  currentValue: Record<string, unknown> | undefined,
  patchValue: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!patchValue) return currentValue;
  const merged = { ...(currentValue ?? {}), ...patchValue };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

// FNXC:ResearchStore 2026-06-27-12:00:
// Exported so the AsyncDataLayer port (async-research-store.ts AsyncResearchStore)
// replicates the SAME terminal set + transition machine, preventing PG/SQLite drift (R4).
export const TERMINAL_STATUSES = new Set<ResearchRunStatus>([
  "completed",
  "failed",
  "cancelled",
  "timed_out",
  "retry_exhausted",
]);
export const VALID_STATUS_TRANSITIONS: Record<ResearchRunStatus, ResearchRunStatus[]> = {
  queued: ["running", "cancelling", "cancelled", "failed", "retry_waiting", "timed_out"],
  running: ["completed", "failed", "cancelling", "cancelled", "retry_waiting", "timed_out"],
  cancelling: ["cancelled", "failed", "timed_out"],
  retry_waiting: ["queued", "running", "cancelled", "retry_exhausted", "failed"],
  completed: [],
  failed: ["retry_exhausted"],
  cancelled: [],
  timed_out: ["retry_exhausted"],
  retry_exhausted: [],
};

function normalizeStatus(status: ResearchRunStatus | "pending"): ResearchRunStatus {
  return status === "pending" ? "queued" : status;
}

export function defaultErrorCodeForFailureClass(failureClass?: ResearchRunFailureClass): ResearchErrorCode {
  if (failureClass === "timed_out") return "PROVIDER_TIMEOUT";
  if (failureClass === "cancelled") return "RUN_CANCELLED";
  if (failureClass === "non_retryable") return "NON_RETRYABLE_PROVIDER_ERROR";
  return "INTERNAL_ERROR";
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
      status: "queued",
      projectId: input.projectId,
      trigger: input.trigger,
      providerConfig: input.providerConfig,
      sources: input.sources ?? [],
      events: input.events ?? [],
      results: input.results,
      tags: input.tags ?? [],
      metadata: input.metadata,
      lifecycle: {
        attempt: input.lifecycle?.attempt ?? 1,
        maxAttempts: input.lifecycle?.maxAttempts ?? 3,
        rootRunId: input.lifecycle?.rootRunId,
        retryOfRunId: input.lifecycle?.retryOfRunId,
        ...input.lifecycle,
      },
      createdAt: now,
      updatedAt: now,
    };

    this.db.prepare(`
      INSERT INTO research_runs (
        id, query, topic, status, projectId, trigger, providerConfig, sources, events, results, error,
        tokenUsage, tags, metadata, lifecycle, createdAt, updatedAt, startedAt, completedAt, cancelledAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      run.id,
      run.query,
      run.topic ?? null,
      run.status,
      run.projectId ?? null,
      run.trigger ?? null,
      toJsonNullable(run.providerConfig),
      toJson(run.sources),
      toJson(run.events),
      toJsonNullable(run.results),
      null,
      null,
      toJson(run.tags),
      toJsonNullable(run.metadata),
      toJsonNullable(run.lifecycle),
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

    const normalizedExistingStatus = normalizeStatus(existing.status as ResearchRunStatus | "pending");
    const normalizedInputStatus = input.status
      ? normalizeStatus(input.status as ResearchRunStatus | "pending")
      : undefined;

    const nonMutableKeys = Object.keys(input).filter((key) => key !== "events" && key !== "metadata");
    if (TERMINAL_STATUSES.has(normalizedExistingStatus) && nonMutableKeys.length > 0) {
      const allowedTerminalMutation = nonMutableKeys.every((key) => key === "status" || key === "lifecycle");
      if (!allowedTerminalMutation) {
        throw new ResearchLifecycleError(`Run ${id} is terminal and immutable`, "terminal_immutable");
      }
    }

    if (normalizedInputStatus && normalizedInputStatus !== normalizedExistingStatus) {
      const allowed = VALID_STATUS_TRANSITIONS[normalizedExistingStatus];
      if (!allowed.includes(normalizedInputStatus)) {
        throw new ResearchLifecycleError(
          `Invalid run status transition: ${normalizedExistingStatus} -> ${normalizedInputStatus}`,
          "invalid_transition",
        );
      }
    }

    const now = new Date().toISOString();
    const mergedProviderConfig = mergeRecord(existing.providerConfig, input.providerConfig);
    const mergedMetadata = mergeRecord(existing.metadata, input.metadata);
    const mergedLifecycle = { ...(existing.lifecycle ?? {}), ...(input.lifecycle ?? {}) };

    const updated: ResearchRun = {
      ...existing,
      ...input,
      status: normalizedInputStatus ?? normalizedExistingStatus,
      providerConfig: mergedProviderConfig,
      metadata: mergedMetadata,
      lifecycle: Object.keys(mergedLifecycle).length > 0 ? mergedLifecycle : undefined,
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

    const seq = this.getNextEventSeq(runId);
    this.db.prepare(`
      INSERT INTO research_run_events (id, runId, seq, type, message, status, classification, metadata, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      created.id,
      runId,
      seq,
      created.type,
      created.message,
      run.status,
      null,
      toJsonNullable(created.metadata),
      created.timestamp,
    );

    this.persistRun({ ...run, events: [...run.events, created], updatedAt: new Date().toISOString() });
    this.db.bumpLastModified();
    this.emit("event:added", { runId, event: created });
    return created;
  }

  appendEvent(runId: string, event: Omit<ResearchEvent, "id" | "timestamp">): ResearchEvent {
    return this.addEvent(runId, event);
  }

  appendLifecycleEvent(
    runId: string,
    event: { type: ResearchEvent["type"]; message: string; status?: ResearchRunStatus; classification?: ResearchRunFailureClass; metadata?: Record<string, unknown> },
  ): ResearchRunEvent {
    const run = this.getRun(runId);
    if (!run) throw new Error(`Research run not found: ${runId}`);
    const createdAt = new Date().toISOString();
    const lifecycleEvent: ResearchRunEvent = {
      id: generateId("REVT"),
      runId,
      seq: this.getNextEventSeq(runId),
      type: event.type,
      message: event.message,
      status: event.status,
      classification: event.classification,
      metadata: event.metadata,
      createdAt,
    };
    this.db.prepare(`
      INSERT INTO research_run_events (id, runId, seq, type, message, status, classification, metadata, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      lifecycleEvent.id,
      lifecycleEvent.runId,
      lifecycleEvent.seq,
      lifecycleEvent.type,
      lifecycleEvent.message,
      lifecycleEvent.status ?? null,
      lifecycleEvent.classification ?? null,
      toJsonNullable(lifecycleEvent.metadata),
      lifecycleEvent.createdAt,
    );
    this.db.bumpLastModified();
    return lifecycleEvent;
  }

  listRunEvents(runId: string): ResearchRunEvent[] {
    const rows = this.db.prepare(`
      SELECT * FROM research_run_events
      WHERE runId = ?
      ORDER BY seq ASC
    `).all(runId) as Record<string, unknown>[];

    return rows.map((row) => ({
      id: row.id as string,
      runId: row.runId as string,
      seq: Number(row.seq),
      type: row.type as ResearchEvent["type"],
      message: row.message as string,
      status: (row.status as ResearchRunStatus | null) ?? undefined,
      classification: (row.classification as ResearchRunFailureClass | null) ?? undefined,
      metadata: fromJson<Record<string, unknown>>(row.metadata as string | null),
      createdAt: row.createdAt as string,
    }));
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

    const normalizedStatus = normalizeStatus(status as ResearchRunStatus | "pending");
    const now = new Date().toISOString();
    const patch: ResearchRunUpdateInput = {
      ...(extra ?? {}),
      status: normalizedStatus,
      lifecycle: {
        ...(run.lifecycle ?? {}),
        ...(extra?.lifecycle ?? {}),
      },
    };

    if (normalizedStatus === "running" && !run.startedAt) patch.startedAt = now;
    if (TERMINAL_STATUSES.has(normalizedStatus) && !run.completedAt) patch.completedAt = now;
    if (normalizedStatus === "cancelled" && !run.cancelledAt) patch.cancelledAt = now;

    if (normalizedStatus === "completed") {
      patch.lifecycle = { ...(patch.lifecycle ?? {}), terminalReason: "completed", retryable: false, errorCode: undefined };
    } else if (normalizedStatus === "failed") {
      const failureClass = patch.lifecycle?.failureClass;
      patch.lifecycle = {
        ...(patch.lifecycle ?? {}),
        terminalReason: "failed",
        retryable: failureClass === "retryable_transient",
        errorCode: patch.lifecycle?.errorCode ?? defaultErrorCodeForFailureClass(failureClass),
      };
    } else if (normalizedStatus === "cancelled") {
      patch.lifecycle = {
        ...(patch.lifecycle ?? {}),
        terminalReason: "cancelled",
        retryable: false,
        failureClass: "cancelled",
        errorCode: patch.lifecycle?.errorCode ?? "RUN_CANCELLED",
      };
    } else if (normalizedStatus === "timed_out") {
      patch.lifecycle = {
        ...(patch.lifecycle ?? {}),
        terminalReason: "timed_out",
        retryable: true,
        failureClass: "timed_out",
        errorCode: patch.lifecycle?.errorCode ?? "PROVIDER_TIMEOUT",
        timeoutAt: patch.lifecycle?.timeoutAt ?? now,
      };
    } else if (normalizedStatus === "retry_exhausted") {
      patch.lifecycle = {
        ...(patch.lifecycle ?? {}),
        terminalReason: "retry_exhausted",
        retryable: false,
        failureClass: patch.lifecycle?.failureClass ?? "non_retryable",
        errorCode: "RETRY_EXHAUSTED",
      };
    }

    const updated = this.updateRun(runId, patch);
    if (!updated) return;

    this.appendLifecycleEvent(runId, {
      type: "status_changed",
      message: `Status changed to ${normalizedStatus}`,
      status: normalizedStatus,
      classification: updated.lifecycle?.failureClass,
    });

    this.emit("run:status_changed", updated);
    if (normalizedStatus === "completed") this.emit("run:completed", updated);
    if (normalizedStatus === "failed") this.emit("run:failed", updated);
    if (normalizedStatus === "cancelled") this.emit("run:cancelled", updated);
    if (normalizedStatus === "timed_out") this.emit("run:timed_out", updated);
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
      queued: 0,
      running: 0,
      cancelling: 0,
      retry_waiting: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      timed_out: 0,
      retry_exhausted: 0,
    };

    for (const row of rows) {
      byStatus[row.status] = row.count;
    }

    const total = Object.values(byStatus).reduce((acc, value) => acc + value, 0);
    return { total, byStatus };
  }

  getActiveRun(projectId: string, trigger: string): ResearchRun | undefined {
    const row = this.db.prepare(`
      SELECT * FROM research_runs
      WHERE projectId = ? AND trigger = ? AND status IN ('queued', 'running', 'cancelling', 'retry_waiting')
      ORDER BY createdAt DESC
      LIMIT 1
    `).get(projectId, trigger) as Record<string, unknown> | undefined;
    return row ? this.rowToRun(row) : undefined;
  }

  assertNoActiveRun(projectId: string, trigger: string): void {
    const active = this.getActiveRun(projectId, trigger);
    if (active) {
      throw new ResearchLifecycleError(
        `Active run already exists for projectId=${projectId} trigger=${trigger}: ${active.id}`,
        "active_run_conflict",
      );
    }
  }

  requestCancellation(runId: string, reason = "Cancelled by user"): ResearchRun {
    const run = this.getRun(runId);
    if (!run) throw new Error(`Research run not found: ${runId}`);
    if (TERMINAL_STATUSES.has(run.status)) {
      return run;
    }

    const now = new Date().toISOString();
    const alreadyCancelling = run.status === "cancelling";
    const updated = this.updateRun(runId, {
      status: "cancelling",
      lifecycle: {
        ...(run.lifecycle ?? {}),
        cancellationRequestedAt: run.lifecycle?.cancellationRequestedAt ?? now,
        terminalCause: reason,
        errorCode: "RUN_CANCELLED",
        retryable: false,
      },
    });
    if (!updated) throw new Error(`Research run not found: ${runId}`);
    if (!alreadyCancelling) {
      this.appendLifecycleEvent(runId, { type: "cancel_requested", message: reason, status: "cancelling", classification: "cancelled" });
    }
    return updated;
  }

  createRetryRun(runId: string, maxAttempts?: number): ResearchRun {
    const run = this.getRun(runId);
    if (!run) throw new Error(`Research run not found: ${runId}`);
    if (run.status !== "failed" && run.status !== "timed_out") {
      throw new ResearchLifecycleError(`Run ${runId} is not retryable from status ${run.status}`, "invalid_transition");
    }
    const currentAttempt = run.lifecycle?.attempt ?? 1;
    const configuredMaxAttempts = maxAttempts ?? run.lifecycle?.maxAttempts ?? 3;
    const nextAttempt = currentAttempt + 1;
    if (nextAttempt > configuredMaxAttempts) {
      this.updateRun(runId, {
        status: "retry_exhausted",
        lifecycle: {
          ...(run.lifecycle ?? {}),
          terminalReason: "retry_exhausted",
          retryable: false,
          failureClass: run.lifecycle?.failureClass ?? "non_retryable",
          errorCode: "RETRY_EXHAUSTED",
        },
      });
      throw new ResearchLifecycleError(`Run ${runId} exhausted retries`, "not_retryable");
    }

    if (!run.lifecycle?.retryable) {
      throw new ResearchLifecycleError(`Run ${runId} is non-retryable`, "not_retryable");
    }

    const rootRunId = run.lifecycle?.rootRunId ?? run.id;
    const retryRun = this.createRun({
      query: run.query,
      topic: run.topic,
      projectId: run.projectId,
      trigger: run.trigger,
      providerConfig: run.providerConfig,
      tags: run.tags,
      metadata: run.metadata,
      lifecycle: {
        attempt: nextAttempt,
        maxAttempts: configuredMaxAttempts,
        retryOfRunId: run.id,
        rootRunId,
      },
    });
    this.updateStatus(retryRun.id, "retry_waiting", {
      lifecycle: {
        ...(retryRun.lifecycle ?? {}),
        retryable: true,
      },
    });
    this.appendLifecycleEvent(retryRun.id, {
      type: "retry_scheduled",
      message: `Retry scheduled from ${run.id}`,
      metadata: { retryOfRunId: run.id, rootRunId, attempt: nextAttempt },
    });
    return retryRun;
  }

  private getNextEventSeq(runId: string): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM research_run_events WHERE runId = ?").get(runId) as { seq?: number };
    return Number(row?.seq ?? 0) + 1;
  }

  private persistRun(run: ResearchRun): void {
    this.db.prepare(`
      UPDATE research_runs
      SET query = ?, topic = ?, status = ?, projectId = ?, trigger = ?, providerConfig = ?, sources = ?, events = ?,
          results = ?, error = ?, tokenUsage = ?, tags = ?, metadata = ?, lifecycle = ?, updatedAt = ?,
          startedAt = ?, completedAt = ?, cancelledAt = ?
      WHERE id = ?
    `).run(
      run.query,
      run.topic ?? null,
      run.status,
      run.projectId ?? null,
      run.trigger ?? null,
      toJsonNullable(run.providerConfig),
      toJson(run.sources),
      toJson(run.events),
      toJsonNullable(run.results),
      run.error ?? null,
      toJsonNullable(run.tokenUsage),
      toJson(run.tags),
      toJsonNullable(run.metadata),
      toJsonNullable(run.lifecycle),
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
      status: normalizeStatus((row.status as ResearchRunStatus | "pending") ?? "queued"),
      projectId: (row.projectId as string | null) ?? undefined,
      trigger: (row.trigger as string | null) ?? undefined,
      providerConfig: fromJson<Record<string, unknown>>(row.providerConfig as string | null),
      sources: fromJson<ResearchSource[]>(row.sources as string | null) ?? [],
      events: fromJson<ResearchEvent[]>(row.events as string | null) ?? [],
      results: fromJson<ResearchResult>(row.results as string | null),
      error: (row.error as string | null) ?? undefined,
      tokenUsage: fromJson<ResearchRun["tokenUsage"]>(row.tokenUsage as string | null),
      tags: fromJson<string[]>(row.tags as string | null) ?? [],
      metadata: fromJson<Record<string, unknown>>(row.metadata as string | null),
      lifecycle: fromJson<ResearchRun["lifecycle"]>(row.lifecycle as string | null),
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
