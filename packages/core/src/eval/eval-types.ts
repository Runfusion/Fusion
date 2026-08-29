/**
 * Eval Domain Types
 *
 * Contracts for eval run persistence and per-task evaluation results.
 */

export const EVAL_RUN_STATUSES = [
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
] as const;

export type EvalRunStatus = typeof EVAL_RUN_STATUSES[number];

export const EVAL_RUN_TRIGGERS = ["manual", "schedule", "api", "task_completion"] as const;

export type EvalRunTrigger = typeof EVAL_RUN_TRIGGERS[number];

export const EVAL_SCORE_CATEGORIES = [
  "agentPerformance",
  "taskOutcomeQuality",
  "processCompliance",
] as const;

export type EvalScoreCategory = typeof EVAL_SCORE_CATEGORIES[number];

export const EVAL_SCORE_SCALE_MIN = 0;
export const EVAL_SCORE_SCALE_MAX = 100;

export const EVAL_SCORE_BANDS = [
  { id: "failing", min: 0, max: 39 },
  { id: "weak", min: 40, max: 59 },
  { id: "acceptable", min: 60, max: 74 },
  { id: "strong", min: 75, max: 89 },
  { id: "excellent", min: 90, max: 100 },
] as const;

export type EvalScoreBand = typeof EVAL_SCORE_BANDS[number]["id"];

export interface EvalTaskSnapshot {
  taskId: string;
  title?: string;
  column?: string;
  status?: string;
  priority?: string;
  size?: string;
  reviewLevel?: number;
  createdAt?: string;
  updatedAt?: string;
  executionCompletedAt?: string;
  summary?: string;
  labels?: string[];
  metadata?: Record<string, unknown>;
}

export interface EvalRunWindow {
  since?: string;
  until?: string;
  baselineRunId?: string;
  windowStartExclusive?: string;
  windowEndInclusive?: string;
}

export interface EvalProvenance {
  evaluatorProvider?: string;
  evaluatorModelId?: string;
  evaluatorVersion?: string;
  promptVersion?: string;
  runConfig?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface EvalSignal {
  signalId: string;
  kind: string;
  name: string;
  passed?: boolean;
  score?: number;
  value?: number | string | boolean | null;
  threshold?: number;
  unit?: string;
  summary?: string;
  details?: Record<string, unknown>;
}

export interface EvalEvidenceReference {
  type: "task_log" | "task_document" | "file" | "command" | "test" | "other";
  ref: string;
  excerpt?: string;
  metadata?: Record<string, unknown>;
}

export const TASK_EVALUATION_EVIDENCE_SOURCE_ORDER = [
  "taskMetadata",
  "commits",
  "workflow",
  "reviews",
  "documents",
  "taskActivity",
  "agentLogs",
  "runAudit",
] as const;

export const EVIDENCE_LIMITS = {
  taskMetadata: 25,
  commits: 20,
  workflow: 25,
  reviews: 25,
  documents: 25,
  taskActivity: 25,
  agentLogs: 25,
  runAudit: 25,
} as const;

export const MAX_EVIDENCE_EXCERPT_LENGTH = 500;
export const EVIDENCE_EXCERPT_TRUNCATION_MARKER = "… [truncated]";

export type TaskEvaluationEvidenceSource = typeof TASK_EVALUATION_EVIDENCE_SOURCE_ORDER[number];

export interface TaskEvidenceEntryBase {
  id: string;
  source: TaskEvaluationEvidenceSource;
  label: string;
  timestamp?: string;
  excerpt?: string;
  truncated?: boolean;
}

export interface TaskMetadataEvidence extends TaskEvidenceEntryBase {
  source: "taskMetadata";
  taskId: string;
  runId: string;
  summary?: string;
  references?: {
    prNumber?: number;
    prUrl?: string;
    mergeCommitSha?: string;
    mergeCompletedAt?: string;
    executionStartedAt?: string;
    executionCompletedAt?: string;
  };
  retryMetrics?: {
    mergeRetries: number;
    workflowStepRetries: number;
    stuckKillCount: number;
    postReviewFixCount: number;
    recoveryRetryCount: number;
    taskDoneRetryCount: number;
    verificationFailureCount: number;
    mergeConflictBounceCount: number;
    mergeAuditBounceCount: number;
    mergeTransientRetryCount: number;
  };
}

export interface CommitEvidence extends TaskEvidenceEntryBase {
  source: "commits";
  sha: string;
  taskId: string;
  runId: string;
  authoredAt?: string;
  authorName?: string;
  subject?: string;
}

export interface WorkflowEvidence extends TaskEvidenceEntryBase {
  source: "workflow";
  taskId: string;
  runId: string;
  workflowStepId?: string;
  stepName?: string;
  status?: string;
  command?: string;
}

export interface ReviewEvidence extends TaskEvidenceEntryBase {
  source: "reviews";
  taskId: string;
  runId: string;
  reviewStep?: number;
  reviewType?: string;
  verdict?: string;
}

export interface DocumentEvidence extends TaskEvidenceEntryBase {
  source: "documents";
  taskId: string;
  runId: string;
  documentKey: string;
  revision?: number;
  author?: string;
}

export interface TaskActivityEvidence extends TaskEvidenceEntryBase {
  source: "taskActivity";
  taskId: string;
  runId: string;
  activityType?: string;
}

export interface AgentLogEvidence extends TaskEvidenceEntryBase {
  source: "agentLogs";
  taskId: string;
  runId: string;
  logType?: string;
  agentId?: string;
}

export interface RunAuditEvidence extends TaskEvidenceEntryBase {
  source: "runAudit";
  taskId: string;
  runId: string;
  eventId: string;
  domain?: string;
  mutationType?: string;
  target?: string;
}

export interface TaskEvaluationEvidenceBundle {
  taskId: string;
  runId: string;
  sourceOrder: readonly TaskEvaluationEvidenceSource[];
  taskMetadata: TaskMetadataEvidence[];
  commits: CommitEvidence[];
  workflow: WorkflowEvidence[];
  reviews: ReviewEvidence[];
  documents: DocumentEvidence[];
  taskActivity: TaskActivityEvidence[];
  agentLogs: AgentLogEvidence[];
  runAudit: RunAuditEvidence[];
}

export interface EvalCategoryScore {
  category: EvalScoreCategory;
  deterministicScore: number;
  aiScore: number;
  finalScore: number;
  weight: number;
  band: EvalScoreBand;
  rationale: string;
  evidence: EvalEvidenceReference[];
}

export const EVAL_FOLLOW_UP_POLICY_MODES = [
  "persist_only",
  "auto_create_qualified",
  "create_all_non_duplicates",
] as const;

export type EvalFollowUpPolicyMode = typeof EVAL_FOLLOW_UP_POLICY_MODES[number];

export const EVAL_FOLLOW_UP_SUGGESTION_STATES = ["suggested", "suppressed", "created"] as const;

export type EvalFollowUpSuggestionState = typeof EVAL_FOLLOW_UP_SUGGESTION_STATES[number];

export const EVAL_FOLLOW_UP_SUPPRESSION_REASONS = [
  "duplicate_open_task",
  "duplicate_prior_suggestion",
  "insufficient_signal",
  "empty_or_generic",
  "policy_filtered",
] as const;

export type EvalFollowUpSuppressionReason = typeof EVAL_FOLLOW_UP_SUPPRESSION_REASONS[number];

export interface EvalFollowUpEvidenceReference {
  evidenceId: string;
  source: TaskEvaluationEvidenceSource | "category" | "signal" | "other";
  note?: string;
}

export interface EvalFollowUpCreationRecommendation {
  shouldCreate: boolean;
  reason: string;
  policyQualified: boolean;
}

export interface EvalFollowUpSuggestion {
  suggestionId: string;
  dedupeKey: string;
  title: string;
  description: string;
  priority: "low" | "normal" | "high" | "urgent";
  severity: EvalScoreBand;
  rationale: string;
  evidenceRefs: EvalFollowUpEvidenceReference[];
  recommendation: EvalFollowUpCreationRecommendation;
  state: EvalFollowUpSuggestionState;
  policyMode: EvalFollowUpPolicyMode;
  suppressedReason?: EvalFollowUpSuppressionReason;
  matchedTaskId?: string;
  matchedSuggestionId?: string;
  createdTaskId?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export function normalizeEvalFollowUpText(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^a-z0-9 ]/g, "")
    .trim();
}

export function buildEvalFollowUpSuggestionId(seed: string): string {
  const normalized = normalizeEvalFollowUpText(seed);
  let hash = 2166136261;
  for (let i = 0; i < normalized.length; i += 1) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `efs-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export interface EvalTaskResult {
  id: string;
  runId: string;
  taskId: string;
  taskSnapshot: EvalTaskSnapshot;
  status: "scored" | "skipped" | "error";
  overallScore?: number;
  maxScore?: number;
  categoryScores: EvalCategoryScore[];
  rationale?: string;
  summary?: string;
  evidence: EvalEvidenceReference[];
  evidenceBundle?: TaskEvaluationEvidenceBundle;
  deterministicSignals: EvalSignal[];
  aiSignals?: EvalSignal[];
  followUps: EvalFollowUpSuggestion[];
  provenance?: EvalProvenance;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface EvalRunCounts {
  totalTasks: number;
  scoredTasks: number;
  skippedTasks: number;
  erroredTasks: number;
}

export interface EvalRun {
  id: string;
  projectId: string;
  status: EvalRunStatus;
  trigger: EvalRunTrigger;
  scope: string;
  window: EvalRunWindow;
  requestedTaskIds: string[];
  evaluatedTaskIds: string[];
  counts: EvalRunCounts;
  aggregateScores?: Record<string, number>;
  summary?: string;
  error?: string;
  provenance?: EvalProvenance;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  cancelledAt?: string;
}

export interface EvalRunEvent {
  id: string;
  runId: string;
  seq: number;
  type: "status_changed" | "task_evaluated" | "info" | "warning" | "error";
  message: string;
  status?: EvalRunStatus;
  taskId?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface EvalRunCreateInput {
  projectId: string;
  trigger?: EvalRunTrigger;
  scope: string;
  window?: EvalRunWindow;
  requestedTaskIds?: string[];
  provenance?: EvalProvenance;
  metadata?: Record<string, unknown>;
}

export interface EvalRunUpdateInput {
  status?: EvalRunStatus;
  evaluatedTaskIds?: string[];
  counts?: EvalRunCounts;
  aggregateScores?: Record<string, number>;
  summary?: string;
  error?: string | null;
  provenance?: EvalProvenance;
  metadata?: Record<string, unknown>;
  startedAt?: string | null;
  completedAt?: string | null;
  cancelledAt?: string | null;
}

export interface EvalRunListOptions {
  projectId?: string;
  status?: EvalRunStatus;
  trigger?: EvalRunTrigger;
  limit?: number;
  offset?: number;
  order?: "asc" | "desc";
}

export interface EvalTaskResultCreateInput {
  taskId: string;
  taskSnapshot: EvalTaskSnapshot;
  status: "scored" | "skipped" | "error";
  overallScore?: number;
  maxScore?: number;
  categoryScores?: EvalCategoryScore[];
  rationale?: string;
  summary?: string;
  evidence?: EvalEvidenceReference[];
  evidenceBundle?: TaskEvaluationEvidenceBundle;
  deterministicSignals?: EvalSignal[];
  aiSignals?: EvalSignal[];
  followUps?: EvalFollowUpSuggestion[];
  provenance?: EvalProvenance;
  metadata?: Record<string, unknown>;
}

export interface EvalTaskResultUpdateInput {
  status?: "scored" | "skipped" | "error";
  overallScore?: number;
  maxScore?: number;
  categoryScores?: EvalCategoryScore[];
  rationale?: string;
  summary?: string;
  evidence?: EvalEvidenceReference[];
  evidenceBundle?: TaskEvaluationEvidenceBundle;
  deterministicSignals?: EvalSignal[];
  aiSignals?: EvalSignal[];
  followUps?: EvalFollowUpSuggestion[];
  provenance?: EvalProvenance;
  metadata?: Record<string, unknown>;
}

export interface EvalTaskResultListOptions {
  runId?: string;
  taskId?: string;
  status?: "scored" | "skipped" | "error";
  limit?: number;
  offset?: number;
}

export interface EvaluationEvidenceRef {
  kind: "task" | "log" | "workflow" | "commit" | "review" | "timing";
  label: string;
  value?: string;
  source?: string;
}

export interface DeterministicSignals {
  taskId: string;
  column: "done" | "archived";
  executionStartedAt?: string;
  executionCompletedAt?: string;
  timedExecutionMs?: number;
  reviewStatus?: string;
  workflowSummary: { total: number; passed: number; failed: number; pending: number };
  commitSummary: { commitCount: number; branch?: string; mergedAt?: string };
  logSummary: { errorCount: number; warningCount: number; timingEntries: number };
  evidence: EvaluationEvidenceRef[];
}

export interface FollowUpDraft {
  title: string;
  description: string;
  reason: string;
  evidenceRefs: string[];
}

export interface TaskEvaluation {
  id: string;
  runId: string;
  taskId: string;
  deterministicSignals: DeterministicSignals;
  overallScore: number;
  categoryScores: EvalCategoryScore[];
  rationale: string;
  evidence: EvaluationEvidenceRef[];
  followUpDrafts: FollowUpDraft[];
  createdAt: string;
  updatedAt: string;
}

export interface EvalStoreEvents {
  "run:created": [EvalRun];
  "run:updated": [EvalRun];
  "run:deleted": [string];
  "run:event": [{ runId: string; event: EvalRunEvent }];
  "result:created": [EvalTaskResult];
  "result:updated": [EvalTaskResult];
}
