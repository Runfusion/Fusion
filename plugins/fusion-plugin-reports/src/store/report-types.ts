import type { ApprovalDecision, ApprovalState } from "../approval.js";
import type { CombinedReview } from "../review-types.js";

export type ReportCadence = "daily" | "weekly" | "monthly" | "quarterly" | "manual";

export type ReportStatus =
  | "generating"
  | "review_pending"
  | "review_in_progress"
  | "review_complete"
  | "approved"
  | "published"
  | "archived"
  | "failed";

export interface Report {
  id: string;
  cadence: ReportCadence;
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
  approvalState: ApprovalState;
  approvalHistory: ApprovalDecision[];
  draftMarkdown: string | null;
  renderedHtmlPath: string | null;
  renderedHtml: string | null;
  renderedHtmlGeneratedAt: string | null;
  metadata: Record<string, unknown>;
  combinedReview: CombinedReview | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReportCreateInput {
  cadence: ReportCadence;
  periodStart: string;
  periodEnd: string;
  title: string;
  metadata?: Record<string, unknown>;
  draftMarkdown?: string;
}

export type ReportUpdateInput = Partial<Pick<Report, "title" | "draftMarkdown" | "renderedHtmlPath" | "renderedHtml" | "renderedHtmlGeneratedAt" | "metadata" | "failureReason" | "approvalState" | "approvalHistory" | "status" | "approvedAt" | "approvedBy" | "publishedAt" | "reviewCompletedAt">>;

export interface ReportListFilter {
  cadence?: ReportCadence;
  status?: ReportStatus;
  statusIn?: ReportStatus[];
  periodStartFrom?: string;
  periodStartTo?: string;
  limit?: number;
  offset?: number;
  orderBy?: "createdAt" | "periodStart";
  orderDir?: "asc" | "desc";
}

const TERMINAL_STATUSES = new Set<ReportStatus>(["published", "archived", "failed"]);
const LINEAR_TRANSITIONS: Record<Exclude<ReportStatus, "published" | "archived" | "failed">, ReportStatus> = {
  generating: "review_pending",
  review_pending: "review_in_progress",
  review_in_progress: "review_complete",
  review_complete: "approved",
  approved: "published",
};

export function isValidReportStatusTransition(from: ReportStatus, to: ReportStatus): boolean {
  if (from === to) return true;
  if (TERMINAL_STATUSES.has(from)) return false;
  /*
  DELIBERATE-LITERAL — reviewed 2026-07-30-22:10 (batch-cli-plugins).
  Same foreign vocabulary as the store: `to` is a `ReportStatus`. `failed`/`archived` are this
  enum's own terminal states — declared in `TERMINAL_STATUSES` directly above — and any report may
  jump to either from any non-terminal state. Nothing here is board-shaped.
  */
  if (to === "failed" || to === "archived") return true;
  if (!(from in LINEAR_TRANSITIONS)) return false;
  return LINEAR_TRANSITIONS[from as keyof typeof LINEAR_TRANSITIONS] === to;
}
