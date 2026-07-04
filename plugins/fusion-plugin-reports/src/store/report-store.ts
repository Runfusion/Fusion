import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { and, asc, desc, eq, gte, inArray, lte, type SQL } from "drizzle-orm";
import type { AsyncDataLayer, Database } from "@fusion/core";
import { postgresSchema as schema } from "@fusion/core";
import type { ApprovalDecision, ApprovalState } from "../approval.js";
import type { CombinedReview } from "../review-types.js";
import {
  type Report,
  type ReportCreateInput,
  type ReportListFilter,
  type ReportStatus,
  type ReportUpdateInput,
  isValidReportStatusTransition,
} from "./report-types.js";

interface ReportRow {
  id: string;
  cadence: Report["cadence"];
  periodStart: string;
  periodEnd: string;
  title: string;
  status: ReportStatus;
  generationStartedAt: string;
  generationCompletedAt: string | null;
  reviewStartedAt: string | null;
  reviewCompletedAt: string | null;
  approvedAt: string | null;
  approvedBy: string | null;
  publishedAt: string | null;
  archivedAt: string | null;
  failureReason: string | null;
  approval_state: ApprovalState;
  approval_history: string;
  draftMarkdown: string | null;
  renderedHtmlPath: string | null;
  rendered_html: string | null;
  rendered_html_generated_at: string | null;
  metadataJson: string;
  combinedReviewJson: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Drizzle row shape for project.reports (PostgreSQL). PG column names are
 * snake_case; the Drizzle shape (postgres/schema/plugin.ts) maps them to the
 * camelCase JS keys below. JSON-stringified fields (approvalHistory,
 * metadataJson, combinedReviewJson) are parsed by drizzleRowToReport.
 */
interface DrizzleReportRow {
  id: string;
  cadence: string;
  periodStart: string;
  periodEnd: string;
  title: string;
  status: string;
  generationStartedAt: string;
  generationCompletedAt: string | null;
  reviewStartedAt: string | null;
  reviewCompletedAt: string | null;
  approvedAt: string | null;
  approvedBy: string | null;
  publishedAt: string | null;
  archivedAt: string | null;
  failureReason: string | null;
  approvalState: string;
  approvalHistory: string;
  draftMarkdown: string | null;
  renderedHtmlPath: string | null;
  renderedHtml: string | null;
  renderedHtmlGeneratedAt: string | null;
  metadataJson: string;
  combinedReviewJson: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReportStoreEvents {
  "report:created": [Report];
  "report:updated": [Report];
  "report:status-changed": [Report];
  "report:review-attached": [Report];
  "report:deleted": [string];
}

export class ReportStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReportStoreError";
  }
}

export class ReportStore extends EventEmitter<ReportStoreEvents> {
  private readonly asyncLayer: AsyncDataLayer | null;

  constructor(
    private readonly db: Database | null,
    options?: { asyncLayer?: AsyncDataLayer | null },
  ) {
    super();
    this.setMaxListeners(50);
    this.asyncLayer = options?.asyncLayer ?? null;
  }

  /** True when the store is backed by PostgreSQL (AsyncDataLayer present). */
  private get backendMode(): boolean {
    return this.asyncLayer !== null;
  }

  /** Asserts sync db is available (throws in backend mode). */
  private syncDb(): Database {
    if (!this.db) throw new Error("ReportStore: sync Database is null (backend mode)");
    return this.db;
  }

  createReport(input: ReportCreateInput): Report {
    const now = new Date().toISOString();
    const report: Report = {
      id: `rep_${randomUUID().replaceAll("-", "")}`,
      cadence: input.cadence,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      title: input.title,
      status: "generating",
      generationStartedAt: now,
      generationCompletedAt: null,
      reviewStartedAt: null,
      reviewCompletedAt: null,
      approvedAt: null,
      approvedBy: null,
      publishedAt: null,
      archivedAt: null,
      failureReason: null,
      approvalState: "not_required",
      approvalHistory: [],
      draftMarkdown: input.draftMarkdown ?? null,
      renderedHtmlPath: null,
      renderedHtml: null,
      renderedHtmlGeneratedAt: null,
      metadata: input.metadata ?? {},
      combinedReview: null,
      createdAt: now,
      updatedAt: now,
    };

    this.syncDb().transaction(() => {
      this.syncDb().prepare(`
        INSERT INTO reports (
          id, cadence, periodStart, periodEnd, title, status,
          generationStartedAt, generationCompletedAt, reviewStartedAt, reviewCompletedAt,
          approvedAt, approvedBy, publishedAt, archivedAt, failureReason,
          approval_state, approval_history,
          draftMarkdown, renderedHtmlPath, rendered_html, rendered_html_generated_at, metadataJson, combinedReviewJson, createdAt, updatedAt
        ) VALUES (
          @id, @cadence, @periodStart, @periodEnd, @title, @status,
          @generationStartedAt, @generationCompletedAt, @reviewStartedAt, @reviewCompletedAt,
          @approvedAt, @approvedBy, @publishedAt, @archivedAt, @failureReason,
          @approvalState, @approvalHistory,
          @draftMarkdown, @renderedHtmlPath, @renderedHtml, @renderedHtmlGeneratedAt, @metadataJson, @combinedReviewJson, @createdAt, @updatedAt
        )
      `).run(this.toDbParams(report, true));
    });

    this.syncDb().bumpLastModified();
    this.emit("report:created", report);
    return report;
  }

  getReport(id: string): Report | null {
    const row = this.syncDb().prepare("SELECT * FROM reports WHERE id = ?").get(id) as ReportRow | undefined;
    return row ? this.rowToReport(row) : null;
  }

  listReports(filter: ReportListFilter = {}): Report[] {
    const params: unknown[] = [];
    const where: string[] = [];

    if (filter.cadence) {
      where.push("cadence = ?");
      params.push(filter.cadence);
    }
    if (filter.statusIn && filter.statusIn.length > 0) {
      where.push(`status IN (${filter.statusIn.map(() => "?").join(",")})`);
      params.push(...filter.statusIn);
    } else if (filter.status) {
      where.push("status = ?");
      params.push(filter.status);
    }
    if (filter.periodStartFrom) {
      where.push("periodStart >= ?");
      params.push(filter.periodStartFrom);
    }
    if (filter.periodStartTo) {
      where.push("periodStart <= ?");
      params.push(filter.periodStartTo);
    }

    const orderBy = filter.orderBy === "periodStart" ? "periodStart" : "createdAt";
    const orderDir = filter.orderDir === "asc" ? "ASC" : "DESC";
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 500);
    const offset = Math.max(filter.offset ?? 0, 0);

    const sql = `
      SELECT * FROM reports
      ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY ${orderBy} ${orderDir}, id ${orderDir}
      LIMIT ? OFFSET ?
    `;
    params.push(limit, offset);

    const rows = this.syncDb().prepare(sql).all(...params) as ReportRow[];
    return rows.map((row) => this.rowToReport(row));
  }

  updateReport(id: string, patch: ReportUpdateInput): Report {
    const current = this.requireReport(id);
    const next: Report = {
      ...current,
      title: patch.title ?? current.title,
      draftMarkdown: patch.draftMarkdown ?? current.draftMarkdown,
      renderedHtmlPath: patch.renderedHtmlPath ?? current.renderedHtmlPath,
      metadata: patch.metadata ?? current.metadata,
      renderedHtml: patch.renderedHtml ?? current.renderedHtml,
      renderedHtmlGeneratedAt: patch.renderedHtmlGeneratedAt ?? current.renderedHtmlGeneratedAt,
      failureReason: patch.failureReason ?? current.failureReason,
      approvalState: patch.approvalState ?? current.approvalState,
      approvalHistory: patch.approvalHistory ?? current.approvalHistory,
      status: patch.status ?? current.status,
      approvedAt: patch.approvedAt ?? current.approvedAt,
      approvedBy: patch.approvedBy ?? current.approvedBy,
      publishedAt: patch.publishedAt ?? current.publishedAt,
      reviewCompletedAt: patch.reviewCompletedAt ?? current.reviewCompletedAt,
      updatedAt: new Date().toISOString(),
    };

    this.syncDb().transaction(() => this.persistExisting(next));
    this.syncDb().bumpLastModified();
    this.emit("report:updated", next);
    return next;
  }

  setStatus(id: string, next: ReportStatus, opts: { failureReason?: string; approvedBy?: string } = {}): Report {
    const current = this.requireReport(id);
    if (current.status === next) return current;
    if (!isValidReportStatusTransition(current.status, next)) {
      throw new ReportStoreError(`Invalid status transition: ${current.status} -> ${next}`);
    }

    const now = new Date().toISOString();
    const updated: Report = {
      ...current,
      status: next,
      updatedAt: now,
      failureReason: next === "failed" ? (opts.failureReason ?? current.failureReason) : current.failureReason,
    };

    if (next === "review_pending") updated.generationCompletedAt = now;
    if (next === "review_in_progress") updated.reviewStartedAt = now;
    if (next === "review_complete") updated.reviewCompletedAt = now;
    if (next === "approved") {
      updated.approvedAt = now;
      updated.approvedBy = opts.approvedBy ?? current.approvedBy;
    }
    if (next === "published") updated.publishedAt = now;
    if (next === "archived") updated.archivedAt = now;

    this.syncDb().transaction(() => this.persistExisting(updated));
    this.syncDb().bumpLastModified();
    this.emit("report:status-changed", updated);
    return updated;
  }

  attachReview(id: string, combined: CombinedReview): Report {
    const current = this.requireReport(id);
    if (current.status !== "review_in_progress") {
      throw new ReportStoreError(`attachReview requires review_in_progress status; got ${current.status}`);
    }

    const now = new Date().toISOString();
    const updated: Report = {
      ...current,
      combinedReview: combined,
      status: "review_complete",
      reviewCompletedAt: now,
      updatedAt: now,
    };

    this.syncDb().transaction(() => this.persistExisting(updated));
    this.syncDb().bumpLastModified();
    this.emit("report:review-attached", updated);
    this.emit("report:status-changed", updated);
    return updated;
  }

  attachRenderedHtml(id: string, htmlPath: string): Report {
    return this.updateReport(id, { renderedHtmlPath: htmlPath });
  }

  setRenderedHtml(id: string, html: string): Report {
    return this.updateReport(id, {
      renderedHtml: html,
      renderedHtmlGeneratedAt: new Date().toISOString(),
    });
  }

  deleteReport(id: string): void {
    this.requireReport(id);
    this.syncDb().transaction(() => {
      this.syncDb().prepare("DELETE FROM reports WHERE id = ?").run(id);
    });
    this.syncDb().bumpLastModified();
    this.emit("report:deleted", id);
  }

  private requireReport(id: string): Report {
    const report = this.getReport(id);
    if (!report) throw new ReportStoreError(`Report ${id} not found`);
    return report;
  }

  private rowToReport(row: ReportRow): Report {
    return {
      id: row.id,
      cadence: row.cadence,
      periodStart: row.periodStart,
      periodEnd: row.periodEnd,
      title: row.title,
      status: row.status,
      generationStartedAt: row.generationStartedAt,
      generationCompletedAt: row.generationCompletedAt,
      reviewStartedAt: row.reviewStartedAt,
      reviewCompletedAt: row.reviewCompletedAt,
      approvedAt: row.approvedAt,
      approvedBy: row.approvedBy,
      publishedAt: row.publishedAt,
      archivedAt: row.archivedAt,
      failureReason: row.failureReason,
      approvalState: row.approval_state,
      approvalHistory: this.parseApprovalHistory(row.approval_history),
      draftMarkdown: row.draftMarkdown,
      renderedHtmlPath: row.renderedHtmlPath,
      renderedHtml: row.rendered_html,
      renderedHtmlGeneratedAt: row.rendered_html_generated_at,
      metadata: this.parseMetadata(row.metadataJson),
      combinedReview: this.parseCombinedReview(row.combinedReviewJson),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private persistExisting(report: Report): void {
    const result = this.syncDb().prepare(`
      UPDATE reports
      SET cadence = @cadence,
          periodStart = @periodStart,
          periodEnd = @periodEnd,
          title = @title,
          status = @status,
          generationStartedAt = @generationStartedAt,
          generationCompletedAt = @generationCompletedAt,
          reviewStartedAt = @reviewStartedAt,
          reviewCompletedAt = @reviewCompletedAt,
          approvedAt = @approvedAt,
          approvedBy = @approvedBy,
          publishedAt = @publishedAt,
          archivedAt = @archivedAt,
          failureReason = @failureReason,
          approval_state = @approvalState,
          approval_history = @approvalHistory,
          draftMarkdown = @draftMarkdown,
          renderedHtmlPath = @renderedHtmlPath,
          rendered_html = @renderedHtml,
          rendered_html_generated_at = @renderedHtmlGeneratedAt,
          metadataJson = @metadataJson,
          combinedReviewJson = @combinedReviewJson,
          updatedAt = @updatedAt
      WHERE id = @id
    `).run(this.toDbParams(report, false));

    if (result.changes === 0) {
      throw new ReportStoreError(`Report ${report.id} not found`);
    }
  }

  private toDbParams(report: Report, includeCreatedAt: boolean): Record<string, unknown> {
    return {
      id: report.id,
      cadence: report.cadence,
      periodStart: report.periodStart,
      periodEnd: report.periodEnd,
      title: report.title,
      status: report.status,
      generationStartedAt: report.generationStartedAt,
      generationCompletedAt: report.generationCompletedAt,
      reviewStartedAt: report.reviewStartedAt,
      reviewCompletedAt: report.reviewCompletedAt,
      approvedAt: report.approvedAt,
      approvedBy: report.approvedBy,
      publishedAt: report.publishedAt,
      archivedAt: report.archivedAt,
      failureReason: report.failureReason,
      approvalState: report.approvalState,
      approvalHistory: JSON.stringify(report.approvalHistory ?? []),
      draftMarkdown: report.draftMarkdown,
      renderedHtmlPath: report.renderedHtmlPath,
      renderedHtml: report.renderedHtml,
      renderedHtmlGeneratedAt: report.renderedHtmlGeneratedAt,
      metadataJson: JSON.stringify(report.metadata ?? {}),
      combinedReviewJson: report.combinedReview ? JSON.stringify(report.combinedReview) : null,
      ...(includeCreatedAt ? { createdAt: report.createdAt } : {}),
      updatedAt: report.updatedAt,
    };
  }

  private parseMetadata(json: string): Record<string, unknown> {
    try {
      const parsed = JSON.parse(json);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }

  private parseCombinedReview(json: string | null): CombinedReview | null {
    if (!json) return null;
    try {
      return JSON.parse(json) as CombinedReview;
    } catch {
      return null;
    }
  }

  private parseApprovalHistory(json: string | null): ApprovalDecision[] {
    if (!json) return [];
    try {
      const parsed = JSON.parse(json);
      return Array.isArray(parsed) ? parsed as ApprovalDecision[] : [];
    } catch {
      return [];
    }
  }

  // ── Async siblings (PostgreSQL / backend mode) ────────────────────
  // Each method delegates to the sync path when not in backend mode (SQLite
  // fallback). In backend mode, queries go through asyncLayer.db (Drizzle)
  // against project.reports. PG column names are snake_case; the Drizzle
  // shape in postgres/schema/plugin.ts maps them to the camelCase JS keys.

  /** Async create. Delegates to sync createReport in SQLite mode. */
  async createReportAsync(input: ReportCreateInput): Promise<Report> {
    if (!this.backendMode) return this.createReport(input);
    const layer = this.asyncLayer!;
    const now = new Date().toISOString();
    const report: Report = {
      id: `rep_${randomUUID().replaceAll("-", "")}`,
      cadence: input.cadence,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      title: input.title,
      status: "generating",
      generationStartedAt: now,
      generationCompletedAt: null,
      reviewStartedAt: null,
      reviewCompletedAt: null,
      approvedAt: null,
      approvedBy: null,
      publishedAt: null,
      archivedAt: null,
      failureReason: null,
      approvalState: "not_required",
      approvalHistory: [],
      draftMarkdown: input.draftMarkdown ?? null,
      renderedHtmlPath: null,
      renderedHtml: null,
      renderedHtmlGeneratedAt: null,
      metadata: input.metadata ?? {},
      combinedReview: null,
      createdAt: now,
      updatedAt: now,
    };
    await layer.db.insert(schema.plugin.reports).values(this.reportToInsertValues(report));
    this.emit("report:created", report);
    return report;
  }

  /** Async get by id. Returns null when not found. */
  async getReportAsync(id: string): Promise<Report | null> {
    if (!this.backendMode) return this.getReport(id);
    const rows = await this.asyncLayer!.db
      .select()
      .from(schema.plugin.reports)
      .where(eq(schema.plugin.reports.id, id));
    return rows[0] ? this.drizzleRowToReport(rows[0] as DrizzleReportRow) : null;
  }

  /** Async list with filters, ordering, and pagination. */
  async listReportsAsync(filter: ReportListFilter = {}): Promise<Report[]> {
    if (!this.backendMode) return this.listReports(filter);
    const table = schema.plugin.reports;
    const conditions: SQL[] = [];
    if (filter.cadence) conditions.push(eq(table.cadence, filter.cadence));
    if (filter.statusIn && filter.statusIn.length > 0) {
      conditions.push(inArray(table.status, filter.statusIn));
    } else if (filter.status) {
      conditions.push(eq(table.status, filter.status));
    }
    if (filter.periodStartFrom) conditions.push(gte(table.periodStart, filter.periodStartFrom));
    if (filter.periodStartTo) conditions.push(lte(table.periodStart, filter.periodStartTo));
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 500);
    const offset = Math.max(filter.offset ?? 0, 0);
    const orderCol = filter.orderBy === "periodStart" ? table.periodStart : table.createdAt;
    const orderFn = filter.orderDir === "asc" ? asc : desc;
    const query = this.asyncLayer!.db
      .select()
      .from(table)
      .orderBy(orderFn(orderCol), orderFn(table.id))
      .limit(limit)
      .offset(offset);
    const rows = conditions.length > 0 ? await query.where(and(...conditions)) : await query;
    return rows.map((row) => this.drizzleRowToReport(row as DrizzleReportRow));
  }

  /** Async update by id with a partial patch. Throws if not found. */
  async updateReportAsync(id: string, patch: ReportUpdateInput): Promise<Report> {
    if (!this.backendMode) return this.updateReport(id, patch);
    const current = await this.requireReportAsync(id);
    const next: Report = {
      ...current,
      title: patch.title ?? current.title,
      draftMarkdown: patch.draftMarkdown ?? current.draftMarkdown,
      renderedHtmlPath: patch.renderedHtmlPath ?? current.renderedHtmlPath,
      metadata: patch.metadata ?? current.metadata,
      renderedHtml: patch.renderedHtml ?? current.renderedHtml,
      renderedHtmlGeneratedAt: patch.renderedHtmlGeneratedAt ?? current.renderedHtmlGeneratedAt,
      failureReason: patch.failureReason ?? current.failureReason,
      approvalState: patch.approvalState ?? current.approvalState,
      approvalHistory: patch.approvalHistory ?? current.approvalHistory,
      status: patch.status ?? current.status,
      approvedAt: patch.approvedAt ?? current.approvedAt,
      approvedBy: patch.approvedBy ?? current.approvedBy,
      publishedAt: patch.publishedAt ?? current.publishedAt,
      reviewCompletedAt: patch.reviewCompletedAt ?? current.reviewCompletedAt,
      updatedAt: new Date().toISOString(),
    };
    await this.persistExistingAsync(next);
    this.emit("report:updated", next);
    return next;
  }

  /** Async status transition with validation. */
  async setStatusAsync(
    id: string,
    next: ReportStatus,
    opts: { failureReason?: string; approvedBy?: string } = {},
  ): Promise<Report> {
    if (!this.backendMode) return this.setStatus(id, next, opts);
    const current = await this.requireReportAsync(id);
    if (current.status === next) return current;
    if (!isValidReportStatusTransition(current.status, next)) {
      throw new ReportStoreError(`Invalid status transition: ${current.status} -> ${next}`);
    }
    const now = new Date().toISOString();
    const updated: Report = {
      ...current,
      status: next,
      updatedAt: now,
      failureReason: next === "failed" ? (opts.failureReason ?? current.failureReason) : current.failureReason,
    };
    if (next === "review_pending") updated.generationCompletedAt = now;
    if (next === "review_in_progress") updated.reviewStartedAt = now;
    if (next === "review_complete") updated.reviewCompletedAt = now;
    if (next === "approved") {
      updated.approvedAt = now;
      updated.approvedBy = opts.approvedBy ?? current.approvedBy;
    }
    if (next === "published") updated.publishedAt = now;
    if (next === "archived") updated.archivedAt = now;
    await this.persistExistingAsync(updated);
    this.emit("report:status-changed", updated);
    return updated;
  }

  /** Async attach review. Requires review_in_progress status. */
  async attachReviewAsync(id: string, combined: CombinedReview): Promise<Report> {
    if (!this.backendMode) return this.attachReview(id, combined);
    const current = await this.requireReportAsync(id);
    if (current.status !== "review_in_progress") {
      throw new ReportStoreError(`attachReview requires review_in_progress status; got ${current.status}`);
    }
    const now = new Date().toISOString();
    const updated: Report = {
      ...current,
      combinedReview: combined,
      status: "review_complete",
      reviewCompletedAt: now,
      updatedAt: now,
    };
    await this.persistExistingAsync(updated);
    this.emit("report:review-attached", updated);
    this.emit("report:status-changed", updated);
    return updated;
  }

  /** Async attach rendered-html file path. */
  attachRenderedHtmlAsync(id: string, htmlPath: string): Promise<Report> {
    return this.updateReportAsync(id, { renderedHtmlPath: htmlPath });
  }

  /** Async set rendered-html content + generation timestamp. */
  setRenderedHtmlAsync(id: string, html: string): Promise<Report> {
    return this.updateReportAsync(id, {
      renderedHtml: html,
      renderedHtmlGeneratedAt: new Date().toISOString(),
    });
  }

  /** Async delete by id. Throws if not found. */
  async deleteReportAsync(id: string): Promise<void> {
    if (!this.backendMode) {
      this.deleteReport(id);
      return;
    }
    await this.requireReportAsync(id);
    await this.asyncLayer!.db
      .delete(schema.plugin.reports)
      .where(eq(schema.plugin.reports.id, id));
    this.emit("report:deleted", id);
  }

  /** Async require — throws ReportStoreError if not found. */
  private async requireReportAsync(id: string): Promise<Report> {
    const report = await this.getReportAsync(id);
    if (!report) throw new ReportStoreError(`Report ${id} not found`);
    return report;
  }

  /** Async UPDATE of an existing report row. Throws if the row vanished. */
  private async persistExistingAsync(report: Report): Promise<void> {
    const result = await this.asyncLayer!.db
      .update(schema.plugin.reports)
      .set(this.reportToUpdateSet(report))
      .where(eq(schema.plugin.reports.id, report.id))
      .returning();
    if (result.length === 0) {
      throw new ReportStoreError(`Report ${report.id} not found`);
    }
  }

  /** Map a Report to a Drizzle insert-values object. */
  private reportToInsertValues(report: Report): typeof schema.plugin.reports.$inferInsert {
    return {
      id: report.id,
      cadence: report.cadence,
      periodStart: report.periodStart,
      periodEnd: report.periodEnd,
      title: report.title,
      status: report.status,
      generationStartedAt: report.generationStartedAt,
      generationCompletedAt: report.generationCompletedAt,
      reviewStartedAt: report.reviewStartedAt,
      reviewCompletedAt: report.reviewCompletedAt,
      approvedAt: report.approvedAt,
      approvedBy: report.approvedBy,
      publishedAt: report.publishedAt,
      archivedAt: report.archivedAt,
      failureReason: report.failureReason,
      approvalState: report.approvalState,
      approvalHistory: JSON.stringify(report.approvalHistory ?? []),
      draftMarkdown: report.draftMarkdown,
      renderedHtmlPath: report.renderedHtmlPath,
      renderedHtml: report.renderedHtml,
      renderedHtmlGeneratedAt: report.renderedHtmlGeneratedAt,
      metadataJson: JSON.stringify(report.metadata ?? {}),
      combinedReviewJson: report.combinedReview ? JSON.stringify(report.combinedReview) : null,
      createdAt: report.createdAt,
      updatedAt: report.updatedAt,
    };
  }

  /** Map a Report to a Drizzle update-set object (no createdAt/id). */
  private reportToUpdateSet(report: Report): Partial<typeof schema.plugin.reports.$inferInsert> {
    return {
      cadence: report.cadence,
      periodStart: report.periodStart,
      periodEnd: report.periodEnd,
      title: report.title,
      status: report.status,
      generationStartedAt: report.generationStartedAt,
      generationCompletedAt: report.generationCompletedAt,
      reviewStartedAt: report.reviewStartedAt,
      reviewCompletedAt: report.reviewCompletedAt,
      approvedAt: report.approvedAt,
      approvedBy: report.approvedBy,
      publishedAt: report.publishedAt,
      archivedAt: report.archivedAt,
      failureReason: report.failureReason,
      approvalState: report.approvalState,
      approvalHistory: JSON.stringify(report.approvalHistory ?? []),
      draftMarkdown: report.draftMarkdown,
      renderedHtmlPath: report.renderedHtmlPath,
      renderedHtml: report.renderedHtml,
      renderedHtmlGeneratedAt: report.renderedHtmlGeneratedAt,
      metadataJson: JSON.stringify(report.metadata ?? {}),
      combinedReviewJson: report.combinedReview ? JSON.stringify(report.combinedReview) : null,
      updatedAt: report.updatedAt,
    };
  }

  /** Map a Drizzle row (camelCase JS keys) to a Report domain object. */
  private drizzleRowToReport(row: DrizzleReportRow): Report {
    return {
      id: row.id,
      cadence: row.cadence as Report["cadence"],
      periodStart: row.periodStart,
      periodEnd: row.periodEnd,
      title: row.title,
      status: row.status as ReportStatus,
      generationStartedAt: row.generationStartedAt,
      generationCompletedAt: row.generationCompletedAt,
      reviewStartedAt: row.reviewStartedAt,
      reviewCompletedAt: row.reviewCompletedAt,
      approvedAt: row.approvedAt,
      approvedBy: row.approvedBy,
      publishedAt: row.publishedAt,
      archivedAt: row.archivedAt,
      failureReason: row.failureReason,
      approvalState: row.approvalState as ApprovalState,
      approvalHistory: this.parseApprovalHistory(row.approvalHistory),
      draftMarkdown: row.draftMarkdown,
      renderedHtmlPath: row.renderedHtmlPath,
      renderedHtml: row.renderedHtml,
      renderedHtmlGeneratedAt: row.renderedHtmlGeneratedAt,
      metadata: this.parseMetadata(row.metadataJson),
      combinedReview: this.parseCombinedReview(row.combinedReviewJson),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
