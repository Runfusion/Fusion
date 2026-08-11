/**
 * FNXC:CodeOrganization 2026-07-21-12:00:
 * Task review and PR-review surface types peeled from types.ts.
 */

export type TaskReviewMode = "pull-request" | "direct";
export type TaskReviewSource = "github-pr" | "reviewer-agent";
export type TaskReviewDecision = "approved" | "changes-requested" | "commented" | "pending";
/*
 * FNXC:PlanReviewNoOp 2026-08-09-01:17:
 * The Review data projection must retain the Plan-Review-only close verdict as audit evidence;
 * consumers render it as a terminal review decision rather than converting it into a revision.
 */
export type TaskReviewVerdict = "APPROVE" | "APPROVE_WITH_NOTES" | "REVISE" | "RETHINK" | "UNAVAILABLE" | "CLOSE_NO_OP";
export type TaskReviewerType = "plan" | "code";
export type TaskReviewItemStatus = "queued" | "in-progress" | "addressed" | "failed";
export type TaskReviewFindingSeverity = "low" | "medium" | "high" | "critical";
export type TaskReviewFindingResolution = "open" | "resolved-in-review" | "superseded";

export interface LegacyTaskReviewItem {
  id: string;
  source: TaskReviewSource;
  status: TaskReviewItemStatus;
  summary: string;
  body?: string;
  filePath?: string;
  line?: number;
  commentUrl?: string;
  reviewer?: string;
  createdAt: string;
  updatedAt: string;
  addressedAt?: string;
  failedReason?: string;
}

export interface TaskReview {
  mode: TaskReviewMode;
  source: TaskReviewSource;
  decision: TaskReviewDecision;
  summary?: string;
  latestRefreshAt?: string;
  selectedItemIds?: string[];
  items: LegacyTaskReviewItem[];
}

export type PrCheckState =
  | "success"
  | "pending"
  | "failure"
  | "cancelled"
  | "timed_out"
  | "action_required"
  | "neutral"
  | "skipped"
  | "stale"
  | "startup_failure";

export interface PrCheckStatus {
  name: string;
  required: boolean;
  state: PrCheckState;
  detailsUrl?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface TaskReviewAuthor {
  login: string;
}

export interface PrTaskReviewSummaryReviewer {
  login: string;
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "PENDING";
  submittedAt?: string;
}

export interface PrTaskReviewSummary {
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  reviewers: PrTaskReviewSummaryReviewer[];
  blockingReasons: string[];
  checks: PrCheckStatus[];
}

export interface TaskReviewStateItem {
  id: string;
  threadId?: string;
  githubCommentId?: number;
  path?: string;
  line?: number;
  diffSide?: string;
  body: string;
  author: TaskReviewAuthor;
  createdAt: string;
  updatedAt?: string;
  state?: string;
  htmlUrl?: string;
  isResolved?: boolean;
  source?: TaskReviewSource;
  reviewType?: TaskReviewerType;
  verdict?: TaskReviewVerdict;
  step?: number;
  summary?: string;
  severity?: TaskReviewFindingSeverity;
  resolution?: TaskReviewFindingResolution;
}

export type ReviewAddressingStatus = "queued" | "in-progress" | "addressed" | "failed";

export interface ReviewAddressingSnapshot {
  itemId: string;
  sourceMode: "pull-request" | "reviewer-agent";
  source: "pr-review" | "reviewer-agent";
  summary: string;
  body: string;
  authorLogin?: string;
  filePath?: string;
  lineNumber?: number;
  severity?: TaskReviewFindingSeverity;
  resolution?: TaskReviewFindingResolution;
  threadId?: string;
  url?: string;
}

export interface ReviewAddressingRecord {
  itemId: string;
  status: ReviewAddressingStatus;
  selectedAt: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  stale?: boolean;
  snapshot?: ReviewAddressingSnapshot;
}

export interface ReviewerTaskReviewSummary {
  verdict?: TaskReviewVerdict;
  reviewType?: TaskReviewerType;
  summary?: string;
}

export type TaskReviewRefreshSource = "manual" | "auto" | "initial-load";
export type TaskReviewRefreshStatus = "idle" | "refreshing" | "ready" | "error";

export interface TaskReviewState {
  source: "pull-request" | "reviewer-agent";
  lastRefreshedAt?: string;
  refreshSource?: TaskReviewRefreshSource;
  refreshStatus?: TaskReviewRefreshStatus;
  refreshError?: string;
  summary?: PrTaskReviewSummary | ReviewerTaskReviewSummary;
  items: TaskReviewStateItem[];
  addressing: ReviewAddressingRecord[];
}

export interface TaskReviewSummary {
  reviewDecision?: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  reviewers?: PrTaskReviewSummaryReviewer[];
  blockingReasons?: string[];
  checks?: PrCheckStatus[];
  verdict?: TaskReviewVerdict;
  reviewType?: TaskReviewerType;
  summary?: string;
}

export interface TaskReviewDataItem {
  itemId: string;
  sourceMode: "pull-request" | "reviewer-agent";
  title: string;
  body: string;
  author: string;
  createdAt: string | null;
  updatedAt: string | null;
  url?: string;
  filePath?: string;
  line?: number;
  severity?: TaskReviewFindingSeverity;
  resolution?: TaskReviewFindingResolution;
  threadId?: string;
  reviewState?: string | null;
  /** Machine-readable reviewer verdict when the source supplied one. */
  verdict?: TaskReviewVerdict;
  /** Review lane that produced the item when known. */
  reviewType?: TaskReviewerType;
  isResolved?: boolean;
  progressStatus?: "queued" | "in-progress" | "addressed" | "failed" | null;
}

export type TaskReviewItem = TaskReviewDataItem;

export interface TaskReviewData {
  mode: "pull-request" | "reviewer-agent";
  refreshable: boolean;
  fetchedAt: string | null;
  summary: TaskReviewSummary | null;
  items: TaskReviewItem[];
}
