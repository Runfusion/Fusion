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

export interface EvalFollowUpSuggestion {
  title: string;
  description: string;
  priority?: "low" | "normal" | "high" | "urgent";
  tags?: string[];
  metadata?: Record<string, unknown>;
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
