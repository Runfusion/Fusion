/**
 * InsightStore — Project-level insight persistence and run tracking.
 *
 * Manages normalized insight entities and insight-generation run records
 * in SQLite, with deterministic ordering and fingerprint-based upsert dedupe.
 *
 * ## Ordering Contract
 *
 * All list operations return results in **ascending** order by default.
 * When multiple rows share the same primary sort key (e.g., `createdAt`),
 * ties are broken deterministically by `id` ascending (lexicographic).
 *
 * This is enforced both in SQL ORDER BY clauses and in-memory sorts
 * to guarantee stable iteration across repeated reads.
 *
 * ## Deduplication Contract
 *
 * `upsertInsight()` deduplicates by (projectId, fingerprint).
 * When a fingerprint match is found, the existing row's mutable fields are
 * updated and its original `id` / `createdAt` are preserved — no new row
 * is created. Use `createInsight()` to force creation regardless of fingerprint.
 *
 * ## Naming Convention
 *
 * Table names use `project_insights` / `project_insight_runs` (snake_case)
 * to match the established SQLite convention in this codebase.
 */

import { EventEmitter } from "node:events";
import type { Database } from "./db.js";
import { toJson, toJsonNullable, fromJson } from "./db.js";
import { randomUUID } from "node:crypto";
import type {
  Insight,
  InsightCreateInput,
  InsightUpdateInput,
  InsightUpsertInput,
  InsightListOptions,
  InsightCategory,
  InsightStatus,
  InsightProvenance,
  InsightRun,
  InsightRunCreateInput,
  InsightRunUpdateInput,
  InsightRunListOptions,
  InsightRunStatus,
  InsightRunTrigger,
  InsightRunInputMetadata,
  InsightRunOutputMetadata,
} from "./insight-types.js";
import type { InsightStoreEvents } from "./insight-types.js";

// ── ID Generators ────────────────────────────────────────────────────

function generateInsightId(): string {
  const timestamp = Date.now().toString(36).toUpperCase();
  const random = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `INS-${timestamp}-${random}`;
}

function generateRunId(): string {
  const timestamp = Date.now().toString(36).toUpperCase();
  const random = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `INSR-${timestamp}-${random}`;
}

// ── Fingerprint Helper ────────────────────────────────────────────────

/**
 * Compute a canonical fingerprint for an insight.
 *
 * The fingerprint is derived from normalized (lowercased, trimmed) title
 * and category to produce a consistent dedupe key regardless of
 * minor wording variations.
 *
 * @param title - The insight title
 * @param category - The insight category
 * @returns A deterministic fingerprint string
 */
export function computeInsightFingerprint(title: string, category: InsightCategory): string {
  // Normalize: lowercase, trim, collapse internal whitespace
  const normalizedTitle = title.toLowerCase().trim().replace(/\s+/g, " ");
  const normalizedCategory = category.toLowerCase().trim();
  const raw = `${normalizedCategory}:${normalizedTitle}`;
  // Use a simple hash for the fingerprint — deterministic and short
  let hash = 0;
  for (let i = 0; i < raw.length; i++) {
    const char = raw.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  // Return as unsigned hex string
  return Math.abs(hash).toString(16).padStart(8, "0");
}

// ── InsightStore Class ───────────────────────────────────────────────

export class InsightStore extends EventEmitter<InsightStoreEvents> {
  constructor(private db: Database) {
    super();
    this.setMaxListeners(50);
  }

  /** Expose the database for testing purposes. */
  getDatabase(): Database {
    return this.db;
  }

  // ── Insight CRUD ────────────────────────────────────────────────────

  /**
   * Create a new insight.
   *
   * Does NOT check for fingerprint duplicates — use `upsertInsight()`
   * when dedupe-by-fingerprint is desired.
   *
   * @param projectId - Project this insight belongs to
   * @param input - Insight creation input
   * @returns The newly created insight
   */
  createInsight(projectId: string, input: InsightCreateInput): Insight {
    const now = new Date().toISOString();
    const id = generateInsightId();
    const fingerprint = input.fingerprint ?? computeInsightFingerprint(input.title, input.category);
    const status = input.status ?? "generated";

    this.db.prepare(`
      INSERT INTO project_insights (
        id, projectId, title, content, category, status,
        fingerprint, provenance, lastRunId, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      projectId,
      input.title,
      input.content ?? null,
      input.category,
      status,
      fingerprint,
      toJsonNullable(input.provenance) ?? null,
      null,
      now,
      now,
    );

    this.db.bumpLastModified();

    const insight: Insight = {
      id,
      projectId,
      title: input.title,
      content: input.content ?? null,
      category: input.category,
      status,
      fingerprint,
      provenance: input.provenance,
      lastRunId: null,
      createdAt: now,
      updatedAt: now,
    };

    this.emit("insight:created", insight);
    return insight;
  }

  /**
   * Get a single insight by ID.
   *
   * @param id - The insight ID
   * @returns The insight, or undefined if not found
   */
  getInsight(id: string): Insight | undefined {
    const row = this.db.prepare("SELECT * FROM project_insights WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.rowToInsight(row) : undefined;
  }

  /**
   * List insights with optional filtering and pagination.
   *
   * Results are ordered ascending by (createdAt, id) for deterministic iteration.
   *
   * @param options - Filter and pagination options
   * @returns Matching insights, ordered ascending by createdAt then id
   */
  listInsights(options: InsightListOptions = {}): Insight[] {
    const { whereClause, params } = this.buildInsightFilter(options);
    const limitClause = options.limit !== undefined ? `LIMIT ${options.limit}` : "";
    const offsetClause = options.offset !== undefined ? `OFFSET ${options.offset}` : "";

    // Deterministic ordering: createdAt ASC, id ASC (lexicographic tie-breaker)
    const rows = this.db.prepare(`
      SELECT * FROM project_insights
      ${whereClause}
      ORDER BY createdAt ASC, id ASC
      ${limitClause}
      ${offsetClause}
    `).all(...params) as Record<string, unknown>[];

    return rows.map((row) => this.rowToInsight(row));
  }

  /**
   * Update an existing insight.
   *
   * @param id - The insight ID to update
   * @param input - Fields to update
   * @returns The updated insight, or undefined if not found
   */
  updateInsight(id: string, input: InsightUpdateInput): Insight | undefined {
    const existing = this.getInsight(id);
    if (!existing) return undefined;

    const now = new Date().toISOString();

    const sets: string[] = ["updatedAt = ?"];
    const params: (string | null)[] = [now];

    if (input.title !== undefined) {
      sets.push("title = ?");
      params.push(input.title);
    }
    if (input.content !== undefined) {
      sets.push("content = ?");
      params.push(input.content);
    }
    if (input.category !== undefined) {
      sets.push("category = ?");
      params.push(input.category);
    }
    if (input.status !== undefined) {
      sets.push("status = ?");
      params.push(input.status);
    }
    if (input.provenance !== undefined) {
      sets.push("provenance = ?");
      params.push(toJsonNullable(input.provenance));
    }

    params.push(id);
    this.db.prepare(`UPDATE project_insights SET ${sets.join(", ")} WHERE id = ?`).run(...params);
    this.db.bumpLastModified();

    // Re-read to get the full updated record
    const updated = this.getInsight(id)!;
    this.emit("insight:updated", updated);
    return updated;
  }

  /**
   * Delete an insight by ID.
   *
   * @param id - The insight ID to delete
   * @returns true if deleted, false if not found
   */
  deleteInsight(id: string): boolean {
    const existing = this.getInsight(id);
    if (!existing) return false;

    this.db.prepare("DELETE FROM project_insights WHERE id = ?").run(id);
    this.db.bumpLastModified();
    this.emit("insight:deleted", id);
    return true;
  }

  /**
   * Upsert an insight by (projectId, fingerprint).
   *
   * - If an insight with the same projectId + fingerprint exists, update its
   *   mutable fields (title, content, provenance, lastRunId, updatedAt) and
   *   preserve the original `id` and `createdAt`.
   * - If no match exists, create a new insight.
   *
   * This enables idempotent insight generation where re-running the same
   * analysis updates the existing insight rather than creating duplicates.
   *
   * @param projectId - Project scope
   * @param input - Upsert input (fingerprint required for dedupe)
   * @returns The created or updated insight
   */
  upsertInsight(projectId: string, input: InsightUpsertInput): Insight {
    const now = new Date().toISOString();
    const fingerprint = input.fingerprint;

    // Check for existing insight with same projectId + fingerprint
    const existingRow = this.db.prepare(`
      SELECT * FROM project_insights WHERE projectId = ? AND fingerprint = ?
    `).get(projectId, fingerprint) as Record<string, unknown> | undefined;

    if (existingRow) {
      // Update existing row in place — preserve id and createdAt
      const sets: string[] = [
        "title = ?",
        "content = ?",
        "category = ?",
        "status = ?",
        "provenance = ?",
        "lastRunId = ?",
        "updatedAt = ?",
      ];
      const params: (string | null)[] = [
        input.title,
        input.content ?? null,
        input.category,
        input.status ?? "confirmed",
        toJsonNullable(input.provenance),
        input.provenance.metadata?.runId as string | null ?? null,
        now,
      ];

      const id = existingRow.id as string;
      this.db.prepare(`UPDATE project_insights SET ${sets.join(", ")} WHERE id = ?`).run(...params, id);
      this.db.bumpLastModified();

      const updated = this.getInsight(id)!;
      this.emit("insight:updated", updated);
      return updated;
    } else {
      // Create new insight
      return this.createInsight(projectId, {
        ...input,
        status: input.status ?? "confirmed",
      });
    }
  }

  /**
   * Get the count of insights matching the given filter.
   */
  countInsights(options: Omit<InsightListOptions, "limit" | "offset"> = {}): number {
    const { whereClause, params } = this.buildInsightFilter(options);
    const row = this.db.prepare(`
      SELECT COUNT(*) as count FROM project_insights ${whereClause}
    `).get(...params) as { count: number } | undefined;

    return row?.count ?? 0;
  }

  private buildInsightFilter(
    options: Pick<InsightListOptions, "projectId" | "category" | "status" | "runId">,
  ): { whereClause: string; params: (string | number)[] } {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (options.projectId !== undefined) {
      conditions.push("projectId = ?");
      params.push(options.projectId);
    }
    if (options.category !== undefined) {
      conditions.push("category = ?");
      params.push(options.category);
    }
    if (options.status !== undefined) {
      conditions.push("status = ?");
      params.push(options.status);
    }
    if (options.runId !== undefined) {
      conditions.push("lastRunId = ?");
      params.push(options.runId);
    }

    return {
      whereClause: conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "",
      params,
    };
  }

  private buildRunFilter(
    options: Pick<InsightRunListOptions, "projectId" | "status" | "trigger">,
  ): { whereClause: string; params: (string | number)[] } {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (options.projectId !== undefined) {
      conditions.push("projectId = ?");
      params.push(options.projectId);
    }
    if (options.status !== undefined) {
      conditions.push("status = ?");
      params.push(options.status);
    }
    if (options.trigger !== undefined) {
      conditions.push("trigger = ?");
      params.push(options.trigger);
    }

    return {
      whereClause: conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "",
      params,
    };
  }

  // ── Insight Run CRUD ────────────────────────────────────────────────

  /**
   * Create a new insight generation run.
   *
   * @param projectId - Project this run belongs to
   * @param input - Run creation input
   * @returns The newly created run
   */
  createRun(projectId: string, input: InsightRunCreateInput): InsightRun {
    const now = new Date().toISOString();
    const id = generateRunId();
    const inputMetadata = input.inputMetadata ?? {};

    this.db.prepare(`
      INSERT INTO project_insight_runs (
        id, projectId, trigger, status, summary, error,
        insightsCreated, insightsUpdated,
        inputMetadata, outputMetadata,
        createdAt, startedAt, completedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      projectId,
      input.trigger,
      "pending",
      null,
      null,
      0,
      0,
      toJsonNullable(inputMetadata) ?? null,
      null,
      now,
      null,
      null,
    );

    this.db.bumpLastModified();

    const run: InsightRun = {
      id,
      projectId,
      trigger: input.trigger,
      status: "pending",
      summary: null,
      error: null,
      insightsCreated: 0,
      insightsUpdated: 0,
      inputMetadata,
      outputMetadata: {},
      createdAt: now,
      startedAt: null,
      completedAt: null,
    };

    this.emit("run:created", run);
    return run;
  }

  /**
   * Get a single run by ID.
   */
  getRun(id: string): InsightRun | undefined {
    const row = this.db.prepare("SELECT * FROM project_insight_runs WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.rowToRun(row) : undefined;
  }

  /**
   * List runs with optional filtering and pagination.
   *
   * Results are ordered ascending by (createdAt DESC, id DESC) for newest-first
   * default ordering. Use options with explicit ordering to override.
   *
   * @param options - Filter and pagination options
   * @returns Matching runs
   */
  listRuns(options: InsightRunListOptions = {}): InsightRun[] {
    const { whereClause, params } = this.buildRunFilter(options);
    const limitClause = options.limit !== undefined ? `LIMIT ${options.limit}` : "";
    const offsetClause = options.offset !== undefined ? `OFFSET ${options.offset}` : "";

    // Deterministic ordering: newest first by default (createdAt DESC, id DESC)
    const rows = this.db.prepare(`
      SELECT * FROM project_insight_runs
      ${whereClause}
      ORDER BY createdAt DESC, id DESC
      ${limitClause}
      ${offsetClause}
    `).all(...params) as Record<string, unknown>[];

    return rows.map((row) => this.rowToRun(row));
  }

  /**
   * Update an existing run.
   *
   * When `status` transitions to a terminal state (`completed`, `failed`,
   * `cancelled`), `completedAt` is set automatically if not already provided.
   *
   * @param id - The run ID to update
   * @param input - Fields to update
   * @returns The updated run, or undefined if not found
   */
  updateRun(id: string, input: InsightRunUpdateInput): InsightRun | undefined {
    const existing = this.getRun(id);
    if (!existing) return undefined;

    const now = new Date().toISOString();
    const isTerminal = input.status !== undefined && ["completed", "failed", "cancelled"].includes(input.status);
    const autoComplete = isTerminal && input.completedAt === undefined && existing.completedAt === null;

    const sets: string[] = [];
    const params: (string | number | null)[] = [];

    if (input.status !== undefined) {
      sets.push("status = ?");
      params.push(input.status);
    }
    if (input.summary !== undefined) {
      sets.push("summary = ?");
      params.push(input.summary);
    }
    if (input.error !== undefined) {
      sets.push("error = ?");
      params.push(input.error);
    }
    if (input.insightsCreated !== undefined) {
      sets.push("insightsCreated = ?");
      params.push(input.insightsCreated);
    }
    if (input.insightsUpdated !== undefined) {
      sets.push("insightsUpdated = ?");
      params.push(input.insightsUpdated);
    }
    if (input.outputMetadata !== undefined) {
      sets.push("outputMetadata = ?");
      params.push(toJsonNullable(input.outputMetadata));
    }
    if (input.startedAt !== undefined) {
      sets.push("startedAt = ?");
      params.push(input.startedAt);
    }
    if (input.completedAt !== undefined) {
      sets.push("completedAt = ?");
      params.push(input.completedAt);
    }

    if (sets.length === 0) return existing;

    // Auto-set completedAt for terminal transitions
    if (autoComplete) {
      sets.push("completedAt = ?");
      params.push(now);
    }

    params.push(id);
    this.db.prepare(`UPDATE project_insight_runs SET ${sets.join(", ")} WHERE id = ?`).run(...params);
    this.db.bumpLastModified();

    const updated = this.getRun(id)!;

    if (isTerminal) {
      this.emit("run:completed", updated);
    }
    this.emit("run:updated", updated);
    return updated;
  }

  /**
   * Upsert a run by (projectId, trigger, createdAt) — used when a pipeline
   * needs to resume or update a specific run by fingerprint-like key.
   *
   * For most cases, `createRun()` + `updateRun()` is sufficient.
   * This method exists for pipelines that need idempotent run creation.
   *
   * @param projectId - Project scope
   * @param trigger - Trigger type to match
   * @param input - Run data
   * @returns The created or existing run
   */
  upsertRun(projectId: string, trigger: InsightRunTrigger, input: InsightRunCreateInput): InsightRun {
    // Find most recent pending/running run for this project + trigger
    const existingRow = this.db.prepare(`
      SELECT * FROM project_insight_runs
      WHERE projectId = ? AND trigger = ? AND status IN ('pending', 'running')
      ORDER BY createdAt DESC, id DESC
      LIMIT 1
    `).get(projectId, trigger) as Record<string, unknown> | undefined;

    if (existingRow) {
      return this.getRun(existingRow.id as string)!;
    }

    return this.createRun(projectId, input);
  }

  /**
   * Get the count of runs matching the given filter.
   */
  countRuns(options: Omit<InsightRunListOptions, "limit" | "offset"> = {}): number {
    const { whereClause, params } = this.buildRunFilter(options);
    const row = this.db.prepare(`
      SELECT COUNT(*) as count FROM project_insight_runs ${whereClause}
    `).get(...params) as { count: number } | undefined;

    return row?.count ?? 0;
  }

  // ── Row → Entity Converters ─────────────────────────────────────────

  private rowToInsight(row: Record<string, unknown>): Insight {
    return {
      id: row.id as string,
      projectId: row.projectId as string,
      title: row.title as string,
      content: row.content as string | null,
      category: row.category as InsightCategory,
      status: row.status as InsightStatus,
      fingerprint: row.fingerprint as string,
      provenance: (() => {
        const p = fromJson<InsightProvenance>(row.provenance as string | null);
        return p ?? { trigger: "unknown" };
      })(),
      lastRunId: row.lastRunId as string | null,
      createdAt: row.createdAt as string,
      updatedAt: row.updatedAt as string,
    };
  }

  private rowToRun(row: Record<string, unknown>): InsightRun {
    return {
      id: row.id as string,
      projectId: row.projectId as string,
      trigger: row.trigger as InsightRunTrigger,
      status: row.status as InsightRunStatus,
      summary: row.summary as string | null,
      error: row.error as string | null,
      insightsCreated: row.insightsCreated as number,
      insightsUpdated: row.insightsUpdated as number,
      inputMetadata: (() => {
        const m = fromJson<InsightRunInputMetadata>(row.inputMetadata as string | null);
        return m ?? {};
      })(),
      outputMetadata: (() => {
        const m = fromJson<InsightRunOutputMetadata>(row.outputMetadata as string | null);
        return m ?? {};
      })(),
      createdAt: row.createdAt as string,
      startedAt: row.startedAt as string | null,
      completedAt: row.completedAt as string | null,
    };
  }
}
