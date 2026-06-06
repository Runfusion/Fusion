/**
 * SQLite database module for fn task board storage.
 *
 * Uses Node.js built-in `node:sqlite` (DatabaseSync) for simplified
 * synchronous transaction handling. The database runs in WAL mode
 * for concurrent reader/writer access.
 *
 * Schema version tracking is managed via a `__meta` table.
 */

import { DatabaseSync } from "./sqlite-adapter.js";
import { basename, isAbsolute, join } from "node:path";
import { mkdirSync, existsSync, statSync, renameSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { DEFAULT_PROJECT_SETTINGS } from "./types.js";
import type { PluginOnSchemaInit } from "./plugin-types.js";
import type { SteeringComment, TaskComment } from "./types.js";
import { hasTitleIdDrift, normalizeTitleForTaskId } from "./task-title-id-drift.js";

// ── Types ────────────────────────────────────────────────────────────

/** A prepared SQL statement wrapping the node:sqlite StatementSync type. */
export type Statement = ReturnType<DatabaseSync["prepare"]>;

/** Result payload for explicit database compaction via `VACUUM`. */
export interface VacuumResult {
  beforeBytes: number;
  afterBytes: number;
  durationMs: number;
}

export interface ProjectIdentity {
  id: string;
  createdAt: string;
  firstSeenPath: string;
}

export class ProjectIdentityConflictError extends Error {
  readonly storedId: string;
  readonly storedPath: string;
  readonly incomingId: string;
  readonly incomingPath: string;

  constructor(input: {
    storedId: string;
    storedPath: string;
    incomingId: string;
    incomingPath: string;
  }) {
    super(
      `Project identity conflict: stored id ${input.storedId} (${input.storedPath}) does not match incoming id ${input.incomingId} (${input.incomingPath})`,
    );
    this.name = "ProjectIdentityConflictError";
    this.storedId = input.storedId;
    this.storedPath = input.storedPath;
    this.incomingId = input.incomingId;
    this.incomingPath = input.incomingPath;
  }
}

const DEFAULT_SQLITE_BUSY_TIMEOUT_MS = 5_000;
const DEFAULT_SQLITE_LOCK_RECOVERY_WINDOW_MS = 1_000;
const DEFAULT_SQLITE_LOCK_RECOVERY_DELAY_MS = 50;

type TransactionMode = "deferred" | "immediate";
type TableColumnsCache = Map<string, Set<string>>;

type SchemaCompatibilityOptions = {
  tableColumnsCache?: TableColumnsCache;
  skipColumnReconciliation?: boolean;
};

// ── JSON Helpers ─────────────────────────────────────────────────────

/**
 * Stringify a value for storage in a JSON column.
 * Stringifies arrays/objects. Returns '[]' for empty arrays.
 * For undefined/null, returns '[]' (safe default for array-backed columns).
 * 
 * For nullable object columns (prInfo, issueInfo, etc.), use toJsonNullable() instead.
 */
export function toJson(value: unknown): string {
  if (value === undefined || value === null) return "[]";
  if (Array.isArray(value) && value.length === 0) return "[]";
  return JSON.stringify(value);
}

/**
 * Stringify a value for a nullable JSON column (non-array).
 * Returns null (SQL NULL) for undefined/null.
 * For use with optional object columns like prInfo, issueInfo, lastRunResult.
 */
export function toJsonNullable(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value);
}

/** Parse a JSON column value. Returns undefined for null/empty/invalid. */
export function fromJson<T>(json: string | null | undefined): T | undefined {
  if (json === null || json === undefined || json === "") return undefined;
  try {
    const parsed = JSON.parse(json);
    // Treat JSON null as undefined for consistency
    if (parsed === null) return undefined;
    return parsed as T;
  } catch {
    return undefined;
  }
}

export function isSqliteLockError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /SQLITE_(?:BUSY|LOCKED)|database is locked|database table is locked/i.test(message);
}

export function sleepSync(ms: number): void {
  if (ms <= 0) return;
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, ms);
}

// ── Runtime capability probes ────────────────────────────────────────

/**
 * Probe whether this SQLite build supports the FTS5 extension.
 *
 * Node's built-in `node:sqlite` only exposes FTS5 when the bundled SQLite was
 * compiled with `SQLITE_ENABLE_FTS5`. Newer Node builds (≥ 22.13, 24, 25) have
 * it on; some older 22.x LTS builds do not, and attempting to
 * `CREATE VIRTUAL TABLE … USING fts5(…)` on those throws `no such module: fts5`.
 *
 * The probe creates and drops a disposable virtual table. Set
 * `FUSION_DISABLE_FTS5=1` to force the LIKE fallback path in environments where
 * FTS5 is available at probe time but undesirable at runtime (e.g. tests).
 */
export function probeFts5(db: DatabaseSync): boolean {
  if (process.env.FUSION_DISABLE_FTS5 === "1" || process.env.FUSION_DISABLE_FTS5 === "true") {
    return false;
  }
  try {
    db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS __fusion_fts5_probe USING fts5(x)");
    db.exec("DROP TABLE IF EXISTS __fusion_fts5_probe");
    return true;
  } catch {
    return false;
  }
}

// ── Schema Definition ────────────────────────────────────────────────

const SCHEMA_VERSION = 112;

export { SCHEMA_VERSION };

function normalizeTaskComments(
  steeringComments: SteeringComment[] | undefined,
  comments: TaskComment[] | undefined,
): { steeringComments: SteeringComment[]; comments: TaskComment[] } {
  const normalizedComments: TaskComment[] = [];
  const seenKeys = new Set<string>();

  const pushComment = (comment: TaskComment) => {
    const key = comment.id || `${comment.text}\u0000${comment.author}\u0000${comment.createdAt}`;
    const existingIndex = normalizedComments.findIndex((entry) => {
      if (comment.id && entry.id) {
        return entry.id === comment.id;
      }
      return (
        entry.text === comment.text &&
        entry.author === comment.author &&
        entry.createdAt === comment.createdAt
      );
    });

    if (existingIndex !== -1) {
      const existing = normalizedComments[existingIndex];
      normalizedComments[existingIndex] = {
        ...existing,
        ...comment,
        updatedAt: comment.updatedAt ?? existing.updatedAt,
      };
      seenKeys.add(key);
      return;
    }

    if (!seenKeys.has(key)) {
      normalizedComments.push(comment);
      seenKeys.add(key);
    }
  };

  for (const comment of comments || []) {
    if (!comment || !comment.id || !comment.createdAt) continue;
    pushComment(comment);
  }

  for (const comment of steeringComments || []) {
    if (!comment || !comment.id || !comment.createdAt) continue;
    pushComment({
      id: comment.id,
      text: comment.text,
      author: comment.author,
      createdAt: comment.createdAt,
    });
  }

  return {
    steeringComments: steeringComments || [],
    comments: normalizedComments,
  };
}

const SCHEMA_SQL = `
-- Tasks table with JSON columns for nested data
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  lineageId TEXT,
  title TEXT,
  description TEXT NOT NULL,
  priority TEXT DEFAULT 'normal',
  "column" TEXT NOT NULL,
  status TEXT,
  size TEXT,
  reviewLevel INTEGER,
  currentStep INTEGER DEFAULT 0,
  worktree TEXT,
  blockedBy TEXT,
  overlapBlockedBy TEXT,
  paused INTEGER DEFAULT 0,
  userPaused INTEGER DEFAULT 0,
  pausedReason TEXT,
  baseBranch TEXT,
  branch TEXT,
  autoMerge INTEGER,
  executionStartBranch TEXT,
  baseCommitSha TEXT,
  modelPresetId TEXT,
  modelProvider TEXT,
  modelId TEXT,
  validatorModelProvider TEXT,
  validatorModelId TEXT,
  planningModelProvider TEXT,
  planningModelId TEXT,
  mergeRetries INTEGER,
  workflowStepRetries INTEGER,
  resumeLimboCount INTEGER DEFAULT 0,
  resumeLimboTipSha TEXT,
  resumeLimboStepSignature TEXT,
  recoveryRetryCount INTEGER,
  taskDoneRetryCount INTEGER DEFAULT 0,
  worktreeSessionRetryCount INTEGER DEFAULT 0,
  completionHandoffLimboRecoveryCount INTEGER DEFAULT 0,
  mergeConflictBounceCount INTEGER DEFAULT 0,
  mergeAuditBounceCount INTEGER DEFAULT 0,
  mergeTransientRetryCount INTEGER DEFAULT 0,
  nextRecoveryAt TEXT,
  error TEXT,
  summary TEXT,
  thinkingLevel TEXT,
  executionMode TEXT DEFAULT 'standard',
  tokenUsageInputTokens INTEGER,
  tokenUsageOutputTokens INTEGER,
  tokenUsageCachedTokens INTEGER,
  tokenUsageCacheWriteTokens INTEGER,
  tokenUsageTotalTokens INTEGER,
  tokenUsageFirstUsedAt TEXT,
  tokenUsageLastUsedAt TEXT,
  tokenBudgetSoftAlertedAt TEXT,
  tokenBudgetHardAlertedAt TEXT,
  tokenBudgetOverride TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  columnMovedAt TEXT,
  firstExecutionAt TEXT,
  cumulativeActiveMs INTEGER,
  executionStartedAt TEXT,
  executionCompletedAt TEXT,
  -- JSON columns for nested arrays/objects
  dependencies TEXT DEFAULT '[]',
  steps TEXT DEFAULT '[]',
  log TEXT DEFAULT '[]',
  attachments TEXT DEFAULT '[]',
  steeringComments TEXT DEFAULT '[]',
  comments TEXT DEFAULT '[]',
  review TEXT,
  reviewState TEXT,
  workflowStepResults TEXT DEFAULT '[]',
  prInfo TEXT,
  prInfos TEXT,
  issueInfo TEXT,
  githubTracking TEXT,
  sourceIssueProvider TEXT,
  sourceIssueRepository TEXT,
  sourceIssueExternalIssueId TEXT,
  sourceIssueNumber INTEGER,
  sourceIssueUrl TEXT,
  mergeDetails TEXT,
  breakIntoSubtasks INTEGER DEFAULT 0,
  noCommitsExpected INTEGER DEFAULT 0,
  enabledWorkflowSteps TEXT DEFAULT '[]',
  modifiedFiles TEXT DEFAULT '[]',
  missionId TEXT,
  sliceId TEXT,
  scopeOverride INTEGER,
  scopeOverrideReason TEXT,
  scopeAutoWiden TEXT DEFAULT '[]',
  assignedAgentId TEXT,
  pausedByAgentId TEXT,
  assigneeUserId TEXT,
  sourceType TEXT,
  sourceAgentId TEXT,
  sourceRunId TEXT,
  sourceSessionId TEXT,
  sourceMessageId TEXT,
  sourceParentTaskId TEXT,
  sourceMetadata TEXT,
  checkedOutBy TEXT,
  checkedOutAt TEXT,
  checkoutNodeId TEXT,
  checkoutRunId TEXT,
  checkoutLeaseRenewedAt TEXT,
  checkoutLeaseEpoch INTEGER DEFAULT 0,
  deletedAt TEXT,
  allowResurrection INTEGER DEFAULT 0,
  transitionPending TEXT,
  customFields TEXT DEFAULT '{}'
);

-- Config table (single row with project settings)
-- nextId is a deprecated legacy allocator counter retained read-only for one
-- release so older databases/config consumers can still load it during the
-- distributed_task_id_state transition.
CREATE TABLE IF NOT EXISTS config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  nextId INTEGER DEFAULT 1,
  nextWorkflowStepId INTEGER DEFAULT 1,
  settings TEXT DEFAULT '{}',
  workflowSteps TEXT DEFAULT '[]',
  updatedAt TEXT
);

CREATE TABLE IF NOT EXISTS distributed_task_id_state (
  prefix TEXT PRIMARY KEY,
  nextSequence INTEGER NOT NULL,
  committedClusterTaskCount INTEGER NOT NULL,
  lastCommittedTaskId TEXT,
  updatedAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS distributed_task_id_reservations (
  reservationId TEXT PRIMARY KEY,
  prefix TEXT NOT NULL,
  nodeId TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  taskId TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('reserved', 'committed', 'aborted', 'expired')),
  reason TEXT CHECK (reason IS NULL OR reason IN ('abort', 'expired', 'failed-create')),
  expiresAt TEXT NOT NULL,
  committedAt TEXT,
  abortedAt TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  FOREIGN KEY (prefix) REFERENCES distributed_task_id_state(prefix) ON DELETE CASCADE,
  UNIQUE(prefix, sequence),
  UNIQUE(prefix, taskId)
);

CREATE INDEX IF NOT EXISTS idxDistributedTaskIdReservationsPrefixStatus ON distributed_task_id_reservations(prefix, status);
CREATE INDEX IF NOT EXISTS idxDistributedTaskIdReservationsExpiry ON distributed_task_id_reservations(status, expiresAt);

-- Workflow step definitions
CREATE TABLE IF NOT EXISTS workflow_steps (
  id TEXT PRIMARY KEY,
  templateId TEXT,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'prompt',
  phase TEXT NOT NULL DEFAULT 'pre-merge',
  prompt TEXT NOT NULL DEFAULT '',
  gateMode TEXT NOT NULL DEFAULT 'advisory',
  toolMode TEXT,
  scriptName TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  defaultOn INTEGER DEFAULT 0,
  modelProvider TEXT,
  modelId TEXT,
  -- (workflow-editor-consolidation U1/U2) when this step has been migrated into a
  -- fragment WorkflowDefinition, the fragment's id is stamped here so re-runs of
  -- the lazy migration skip already-migrated rows (marker idempotency).
  migrated_fragment_id TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);

-- Named workflow definitions authored as WorkflowIr graphs (+ editor layout).
-- The ir and layout columns are JSON-encoded TEXT; ir is validated via
-- parseWorkflowIr before persistence at the store layer.
CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  ir TEXT NOT NULL,
  layout TEXT NOT NULL DEFAULT '{}',
  -- (workflow-editor-consolidation U1, KTD-1) discriminates reusable single-node
  -- "fragment" templates from full "workflow" definitions. Fragments never appear
  -- in task workflow pickers, default-workflow selection, or compile/selection
  -- paths. Legacy rows default to 'workflow'.
  kind TEXT NOT NULL DEFAULT 'workflow',
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idxWorkflowsCreatedAt ON workflows(createdAt);

-- Per-task selected workflow. stepIds holds the WorkflowStep ids materialized
-- by compiling the workflow, so re-selection can clean them up (no orphans).
CREATE TABLE IF NOT EXISTS task_workflow_selection (
  taskId TEXT PRIMARY KEY,
  workflowId TEXT NOT NULL,
  stepIds TEXT NOT NULL DEFAULT '[]',
  updatedAt TEXT NOT NULL
);

-- Activity log with indexed columns for efficient queries
CREATE TABLE IF NOT EXISTS activityLog (
  id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL,
  type TEXT NOT NULL,
  taskId TEXT,
  taskTitle TEXT,
  details TEXT NOT NULL,
  metadata TEXT
);
CREATE INDEX IF NOT EXISTS idxActivityLogTimestamp ON activityLog(timestamp);
CREATE INDEX IF NOT EXISTS idxActivityLogType ON activityLog(type);
CREATE INDEX IF NOT EXISTS idxActivityLogTaskId ON activityLog(taskId);

-- Archived tasks table (migrated from archive.jsonl)
CREATE TABLE IF NOT EXISTS archivedTasks (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  archivedAt TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idxArchivedTasksId ON archivedTasks(id);

CREATE TABLE IF NOT EXISTS task_commit_associations (
  id TEXT PRIMARY KEY,
  taskLineageId TEXT NOT NULL,
  taskIdSnapshot TEXT NOT NULL,
  commitSha TEXT NOT NULL,
  commitSubject TEXT NOT NULL,
  authoredAt TEXT NOT NULL,
  matchedBy TEXT NOT NULL CHECK (matchedBy IN ('canonical-lineage-trailer', 'legacy-task-id-trailer', 'legacy-subject', 'manual-reconciliation')),
  confidence TEXT NOT NULL CHECK (confidence IN ('canonical', 'legacy', 'ambiguous')),
  note TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  UNIQUE(taskLineageId, commitSha, matchedBy)
);
CREATE INDEX IF NOT EXISTS idxTaskCommitAssociationsLineage ON task_commit_associations(taskLineageId);
CREATE INDEX IF NOT EXISTS idxTaskCommitAssociationsCommitSha ON task_commit_associations(commitSha);

-- Automations table
CREATE TABLE IF NOT EXISTS automations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  scheduleType TEXT NOT NULL,
  cronExpression TEXT NOT NULL,
  command TEXT NOT NULL,
  enabled INTEGER DEFAULT 1,
  timeoutMs INTEGER,
  steps TEXT,
  nextRunAt TEXT,
  lastRunAt TEXT,
  lastRunResult TEXT,
  runCount INTEGER DEFAULT 0,
  runHistory TEXT DEFAULT '[]',
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);

-- Agents table
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'idle',
  taskId TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  lastHeartbeatAt TEXT,
  metadata TEXT DEFAULT '{}',
  data TEXT DEFAULT '{}'
);

-- Agent heartbeat events
CREATE TABLE IF NOT EXISTS agentHeartbeats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agentId TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  status TEXT NOT NULL,
  runId TEXT NOT NULL,
  FOREIGN KEY (agentId) REFERENCES agents(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idxAgentHeartbeatsAgentId ON agentHeartbeats(agentId);
CREATE INDEX IF NOT EXISTS idxAgentHeartbeatsRunId ON agentHeartbeats(runId);

CREATE TABLE IF NOT EXISTS agentRuns (
  id TEXT PRIMARY KEY,
  agentId TEXT NOT NULL,
  data TEXT NOT NULL,
  startedAt TEXT NOT NULL,
  endedAt TEXT,
  status TEXT NOT NULL,
  FOREIGN KEY (agentId) REFERENCES agents(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idxAgentRunsAgentIdStartedAt ON agentRuns(agentId, startedAt);
CREATE INDEX IF NOT EXISTS idxAgentRunsStatus ON agentRuns(status);

CREATE TABLE IF NOT EXISTS agentTaskSessions (
  agentId TEXT NOT NULL,
  taskId TEXT NOT NULL,
  data TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  PRIMARY KEY (agentId, taskId),
  FOREIGN KEY (agentId) REFERENCES agents(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS agentApiKeys (
  id TEXT PRIMARY KEY,
  agentId TEXT NOT NULL,
  data TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  revokedAt TEXT,
  FOREIGN KEY (agentId) REFERENCES agents(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idxAgentApiKeysAgentId ON agentApiKeys(agentId);

CREATE TABLE IF NOT EXISTS agentConfigRevisions (
  id TEXT PRIMARY KEY,
  agentId TEXT NOT NULL,
  data TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  FOREIGN KEY (agentId) REFERENCES agents(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idxAgentConfigRevisionsAgentIdCreatedAt ON agentConfigRevisions(agentId, createdAt);

CREATE TABLE IF NOT EXISTS agentBlockedStates (
  agentId TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  FOREIGN KEY (agentId) REFERENCES agents(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS mergeQueue (
  taskId TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  enqueuedAt TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal',
  leasedBy TEXT,
  leasedAt TEXT,
  leaseExpiresAt TEXT,
  attemptCount INTEGER NOT NULL DEFAULT 0,
  lastError TEXT
);
CREATE INDEX IF NOT EXISTS idx_mergeQueue_lease_ready ON mergeQueue(leasedBy, priority, enqueuedAt);
CREATE INDEX IF NOT EXISTS idx_mergeQueue_leaseExpiresAt ON mergeQueue(leaseExpiresAt);

CREATE TABLE IF NOT EXISTS merge_requests (
  taskId TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  state TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  attemptCount INTEGER NOT NULL DEFAULT 0,
  lastError TEXT
);
CREATE INDEX IF NOT EXISTS idx_merge_requests_state_updatedAt ON merge_requests(state, updatedAt);

CREATE TABLE IF NOT EXISTS completion_handoff_markers (
  taskId TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  acceptedAt TEXT NOT NULL,
  source TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_completion_handoff_markers_acceptedAt ON completion_handoff_markers(acceptedAt);

-- Per-branch run state for concurrent workflow fan-out/join (U13, KTD-11/R21).
-- Reconstructible per ADR-0001: a crashed parallel run resumes each branch from
-- its persisted node; completed branches are not re-run. Additive-only.
CREATE TABLE IF NOT EXISTS workflow_run_branches (
  taskId TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  runId TEXT NOT NULL,
  branchId TEXT NOT NULL,
  currentNodeId TEXT NOT NULL,
  status TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  PRIMARY KEY (taskId, runId, branchId)
);
CREATE INDEX IF NOT EXISTS idx_workflow_run_branches_task_run ON workflow_run_branches(taskId, runId);

-- Per-step-instance run state for the step-inversion foreach region (step-inversion
-- U4, KTD-6). One row per expanded step instance inside a foreach region; resume
-- reconstructs the instance set from pinnedStepCount + persisted currentNodeId/
-- reworkCount without re-running completed instances. baselineSha/checkpointId
-- persist the RETHINK reset anchors (previously in-memory, lost on restart).
-- branchName/integratedAt and the "awaiting-integration" status serve parallel
-- mode (KTD-11) and are null/unused at concurrency 1. Additive-only, reconstructible.
-- status ∈ "pending" | "in-progress" | "awaiting-integration" | "completed" | "failed".
CREATE TABLE IF NOT EXISTS workflow_run_step_instances (
  taskId TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  runId TEXT NOT NULL,
  foreachNodeId TEXT NOT NULL,
  stepIndex INTEGER NOT NULL,
  pinnedStepCount INTEGER NOT NULL,
  currentNodeId TEXT,
  status TEXT NOT NULL,
  baselineSha TEXT,
  checkpointId TEXT,
  reworkCount INTEGER NOT NULL DEFAULT 0,
  branchName TEXT,
  integratedAt TEXT,
  updatedAt TEXT NOT NULL,
  PRIMARY KEY (taskId, runId, foreachNodeId, stepIndex)
);
CREATE INDEX IF NOT EXISTS idx_workflow_run_step_instances_task_run ON workflow_run_step_instances(taskId, runId);

-- Workflow setting values per (workflowId, projectId). JSON values map; validated
-- against the named workflow's declared settings by the store write authority.
CREATE TABLE IF NOT EXISTS workflow_settings (
  workflowId TEXT NOT NULL,
  projectId TEXT NOT NULL,
  "values" TEXT DEFAULT '{}',
  updatedAt TEXT NOT NULL,
  PRIMARY KEY (workflowId, projectId)
);
CREATE INDEX IF NOT EXISTS idx_workflow_settings_project ON workflow_settings(projectId);

-- Task documents (key-value store per task with revision tracking)
CREATE TABLE IF NOT EXISTS task_documents (
  id TEXT PRIMARY KEY,
  taskId TEXT NOT NULL,
  key TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 1,
  author TEXT NOT NULL DEFAULT 'user',
  metadata TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  FOREIGN KEY (taskId) REFERENCES tasks(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idxTaskDocumentsTaskKey ON task_documents(taskId, key);
CREATE INDEX IF NOT EXISTS idxTaskDocumentsTaskId ON task_documents(taskId);

-- Task document revision history (shadow table for archived snapshots)
CREATE TABLE IF NOT EXISTS task_document_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  taskId TEXT NOT NULL,
  key TEXT NOT NULL,
  content TEXT NOT NULL,
  revision INTEGER NOT NULL,
  author TEXT NOT NULL,
  metadata TEXT,
  createdAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idxTaskDocumentRevisionsTaskKey ON task_document_revisions(taskId, key);

-- Research runs persistence (FN-2991)
CREATE TABLE IF NOT EXISTS research_runs (
  id TEXT PRIMARY KEY,
  query TEXT NOT NULL,
  topic TEXT,
  status TEXT NOT NULL,
  projectId TEXT,
  trigger TEXT,
  providerConfig TEXT,
  sources TEXT NOT NULL DEFAULT '[]',
  events TEXT NOT NULL DEFAULT '[]',
  results TEXT,
  error TEXT,
  tokenUsage TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  metadata TEXT,
  lifecycle TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  startedAt TEXT,
  completedAt TEXT,
  cancelledAt TEXT
);
CREATE INDEX IF NOT EXISTS idxResearchRunsStatus ON research_runs(status);
CREATE INDEX IF NOT EXISTS idxResearchRunsCreatedAt ON research_runs(createdAt);
CREATE INDEX IF NOT EXISTS idxResearchRunsUpdatedAt ON research_runs(updatedAt);

CREATE TABLE IF NOT EXISTS research_exports (
  id TEXT PRIMARY KEY,
  runId TEXT NOT NULL,
  format TEXT NOT NULL,
  content TEXT NOT NULL,
  filePath TEXT,
  createdAt TEXT NOT NULL,
  FOREIGN KEY (runId) REFERENCES research_runs(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idxResearchExportsRunId ON research_exports(runId);

CREATE TABLE IF NOT EXISTS research_run_events (
  id TEXT PRIMARY KEY,
  runId TEXT NOT NULL,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT,
  classification TEXT,
  metadata TEXT,
  createdAt TEXT NOT NULL,
  FOREIGN KEY (runId) REFERENCES research_runs(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idxResearchRunEventsRunIdSeq ON research_run_events(runId, seq);

CREATE TABLE IF NOT EXISTS experiment_sessions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  projectId TEXT,
  status TEXT NOT NULL,
  metric TEXT NOT NULL,
  currentSegment INTEGER NOT NULL DEFAULT 1,
  maxIterations INTEGER,
  workingDir TEXT,
  baselineRunId TEXT,
  bestRunId TEXT,
  keptRunIds TEXT NOT NULL DEFAULT '[]',
  tags TEXT NOT NULL DEFAULT '[]',
  metadata TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  finalizedAt TEXT
);
CREATE INDEX IF NOT EXISTS idxExperimentSessionsStatus ON experiment_sessions(status);
CREATE INDEX IF NOT EXISTS idxExperimentSessionsProject ON experiment_sessions(projectId);
CREATE INDEX IF NOT EXISTS idxExperimentSessionsCreatedAt ON experiment_sessions(createdAt);

CREATE TABLE IF NOT EXISTS experiment_session_records (
  id TEXT PRIMARY KEY,
  sessionId TEXT NOT NULL,
  segment INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  FOREIGN KEY (sessionId) REFERENCES experiment_sessions(id) ON DELETE CASCADE,
  UNIQUE(sessionId, seq)
);
CREATE INDEX IF NOT EXISTS idxExperimentRecordsSessionSegment ON experiment_session_records(sessionId, segment, seq);
CREATE INDEX IF NOT EXISTS idxExperimentRecordsType ON experiment_session_records(sessionId, type);

-- Eval run persistence (FN-3387)
CREATE TABLE IF NOT EXISTS eval_runs (
  id TEXT PRIMARY KEY,
  projectId TEXT NOT NULL,
  status TEXT NOT NULL,
  trigger TEXT NOT NULL,
  scope TEXT NOT NULL,
  window TEXT NOT NULL DEFAULT '{}',
  requestedTaskIds TEXT NOT NULL DEFAULT '[]',
  evaluatedTaskIds TEXT NOT NULL DEFAULT '[]',
  counts TEXT NOT NULL DEFAULT '{"totalTasks":0,"scoredTasks":0,"skippedTasks":0,"erroredTasks":0}',
  aggregateScores TEXT,
  summary TEXT,
  error TEXT,
  provenance TEXT,
  metadata TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  startedAt TEXT,
  completedAt TEXT,
  cancelledAt TEXT
);
CREATE INDEX IF NOT EXISTS idxEvalRunsProjectIdCreatedAt ON eval_runs(projectId, createdAt);
CREATE INDEX IF NOT EXISTS idxEvalRunsProjectTriggerStatus ON eval_runs(projectId, trigger, status);
CREATE INDEX IF NOT EXISTS idxEvalRunsStatusCreatedAt ON eval_runs(status, createdAt);

CREATE TABLE IF NOT EXISTS eval_task_results (
  id TEXT PRIMARY KEY,
  runId TEXT NOT NULL,
  taskId TEXT NOT NULL,
  taskSnapshot TEXT NOT NULL,
  status TEXT NOT NULL,
  overallScore REAL,
  maxScore REAL,
  categoryScores TEXT NOT NULL DEFAULT '[]',
  rationale TEXT,
  summary TEXT,
  evidence TEXT NOT NULL DEFAULT '[]',
  deterministicSignals TEXT NOT NULL DEFAULT '[]',
  aiSignals TEXT,
  followUps TEXT NOT NULL DEFAULT '[]',
  provenance TEXT,
  metadata TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  FOREIGN KEY (runId) REFERENCES eval_runs(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idxEvalTaskResultsRunIdCreatedAt ON eval_task_results(runId, createdAt);
CREATE INDEX IF NOT EXISTS idxEvalTaskResultsTaskIdCreatedAt ON eval_task_results(taskId, createdAt);
CREATE INDEX IF NOT EXISTS idxEvalTaskResultsStatusRunId ON eval_task_results(status, runId);
CREATE UNIQUE INDEX IF NOT EXISTS idxEvalTaskResultsRunTaskUnique ON eval_task_results(runId, taskId);

CREATE TABLE IF NOT EXISTS eval_run_events (
  id TEXT PRIMARY KEY,
  runId TEXT NOT NULL,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT,
  taskId TEXT,
  metadata TEXT,
  createdAt TEXT NOT NULL,
  FOREIGN KEY (runId) REFERENCES eval_runs(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idxEvalRunEventsRunIdSeq ON eval_run_events(runId, seq);

-- FN-4788…FN-4800: pre-allocate secrets storage schema for upcoming secrets subsystem.
CREATE TABLE IF NOT EXISTS secrets (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL,
  value_ciphertext BLOB NOT NULL,
  nonce BLOB NOT NULL,
  description TEXT,
  access_policy TEXT NOT NULL DEFAULT 'auto'
    CHECK (access_policy IN ('auto', 'prompt', 'deny')),
  env_exportable INTEGER NOT NULL DEFAULT 0
    CHECK (env_exportable IN (0, 1)),
  env_export_key TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_read_at TEXT,
  last_read_by TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idxSecretsKey ON secrets(key);

-- Schema version tracking
CREATE TABLE IF NOT EXISTS __meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- Missions table (hierarchical project planning)
CREATE TABLE IF NOT EXISTS missions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL,
  interviewState TEXT NOT NULL,
  baseBranch TEXT,
  branchStrategy TEXT,
  autoAdvance INTEGER DEFAULT 0,
  autoMerge INTEGER,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS branch_groups (
  id TEXT PRIMARY KEY,
  sourceType TEXT NOT NULL CHECK (sourceType IN ('mission','planning','new-task')),
  sourceId TEXT NOT NULL,
  branchName TEXT NOT NULL UNIQUE,
  worktreePath TEXT,
  autoMerge INTEGER NOT NULL DEFAULT 0,
  prState TEXT NOT NULL DEFAULT 'none' CHECK (prState IN ('none','open','merged','closed')),
  prUrl TEXT,
  prNumber INTEGER,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','finalized','abandoned')),
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  closedAt INTEGER
);
CREATE INDEX IF NOT EXISTS idxBranchGroupsSource ON branch_groups(sourceType, sourceId);
CREATE INDEX IF NOT EXISTS idxBranchGroupsBranchName ON branch_groups(branchName);

-- Goals table (strategic intent across mission timelines)
CREATE TABLE IF NOT EXISTS goals (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idxGoalsStatus ON goals(status);

CREATE TABLE IF NOT EXISTS mission_goals (
  missionId TEXT NOT NULL,
  goalId TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  PRIMARY KEY (missionId, goalId),
  FOREIGN KEY (missionId) REFERENCES missions(id) ON DELETE CASCADE,
  FOREIGN KEY (goalId) REFERENCES goals(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idxMissionGoalsGoalId ON mission_goals(goalId);

CREATE TABLE IF NOT EXISTS goal_citations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  goalId TEXT NOT NULL,
  agentId TEXT NOT NULL,
  taskId TEXT,
  surface TEXT NOT NULL,
  sourceRef TEXT NOT NULL,
  snippet TEXT NOT NULL,
  timestamp TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idxGoalCitationsGoalId ON goal_citations(goalId);
CREATE INDEX IF NOT EXISTS idxGoalCitationsAgentId ON goal_citations(agentId);
CREATE INDEX IF NOT EXISTS idxGoalCitationsTimestamp ON goal_citations(timestamp);
CREATE UNIQUE INDEX IF NOT EXISTS uxGoalCitationsDedup
  ON goal_citations(goalId, surface, sourceRef);

-- Milestones table (phases within a mission)
CREATE TABLE IF NOT EXISTS milestones (
  id TEXT PRIMARY KEY,
  missionId TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL,
  orderIndex INTEGER NOT NULL,
  interviewState TEXT NOT NULL,
  dependencies TEXT DEFAULT '[]',
  acceptanceCriteria TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  FOREIGN KEY (missionId) REFERENCES missions(id) ON DELETE CASCADE
);

-- Slices table (work units within a milestone)
CREATE TABLE IF NOT EXISTS slices (
  id TEXT PRIMARY KEY,
  milestoneId TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL,
  orderIndex INTEGER NOT NULL,
  activatedAt TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  FOREIGN KEY (milestoneId) REFERENCES milestones(id) ON DELETE CASCADE
);

-- Mission features table (features within a slice that can link to tasks)
CREATE TABLE IF NOT EXISTS mission_features (
  id TEXT PRIMARY KEY,
  sliceId TEXT NOT NULL,
  taskId TEXT,
  title TEXT NOT NULL,
  description TEXT,
  acceptanceCriteria TEXT,
  status TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  FOREIGN KEY (sliceId) REFERENCES slices(id) ON DELETE CASCADE,
  FOREIGN KEY (taskId) REFERENCES tasks(id) ON DELETE SET NULL
);

-- Mission event log for lifecycle observability
CREATE TABLE IF NOT EXISTS mission_events (
  id TEXT PRIMARY KEY,
  missionId TEXT NOT NULL,
  eventType TEXT NOT NULL,
  description TEXT NOT NULL,
  metadata TEXT,
  timestamp TEXT NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (missionId) REFERENCES missions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idxMissionEventsMissionId ON mission_events(missionId);
CREATE INDEX IF NOT EXISTS idxMissionEventsTimestamp ON mission_events(timestamp);
CREATE INDEX IF NOT EXISTS idxMissionEventsType ON mission_events(eventType);

-- Plugins table for plugin system
CREATE TABLE IF NOT EXISTS plugins (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  description TEXT,
  author TEXT,
  homepage TEXT,
  path TEXT NOT NULL,
  enabled INTEGER DEFAULT 1,
  state TEXT NOT NULL DEFAULT 'installed',
  settings TEXT DEFAULT '{}',
  settingsSchema TEXT,
  error TEXT,
  dependencies TEXT DEFAULT '[]',
  aiScanOnLoad INTEGER NOT NULL DEFAULT 0,
  lastSecurityScan TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);

-- Routines table for recurring task automation
CREATE TABLE IF NOT EXISTS routines (
  id TEXT PRIMARY KEY,
  agentId TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  description TEXT,
  triggerType TEXT NOT NULL,
  triggerConfig TEXT NOT NULL,
  command TEXT,
  steps TEXT,
  timeoutMs INTEGER,
  catchUpPolicy TEXT NOT NULL DEFAULT 'run_one',
  executionPolicy TEXT NOT NULL DEFAULT 'queue',
  catchUpLimit INTEGER DEFAULT 5,
  enabled INTEGER DEFAULT 1,
  lastRunAt TEXT,
  lastRunResult TEXT,
  nextRunAt TEXT,
  runCount INTEGER DEFAULT 0,
  runHistory TEXT DEFAULT '[]',
  scope TEXT DEFAULT 'project',
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);

-- Insight persistence tables (FN-1877)
-- Normalized insight entities and insight-generation run records

-- project_insights: normalized insight entities
CREATE TABLE IF NOT EXISTS project_insights (
  id TEXT PRIMARY KEY,
  projectId TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT,
  category TEXT NOT NULL,
  status TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  provenance TEXT,
  lastRunId TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);

-- project_insight_runs: insight-generation run records
CREATE TABLE IF NOT EXISTS project_insight_runs (
  id TEXT PRIMARY KEY,
  projectId TEXT NOT NULL,
  trigger TEXT NOT NULL,
  status TEXT NOT NULL,
  summary TEXT,
  error TEXT,
  insightsCreated INTEGER NOT NULL DEFAULT 0,
  insightsUpdated INTEGER NOT NULL DEFAULT 0,
  inputMetadata TEXT,
  outputMetadata TEXT,
  lifecycle TEXT,
  createdAt TEXT NOT NULL,
  startedAt TEXT,
  completedAt TEXT,
  cancelledAt TEXT
);

-- Index for filtering insights by projectId
CREATE INDEX IF NOT EXISTS idxProjectInsightsProjectId
  ON project_insights(projectId);

-- Index for fingerprint-based upsert dedupe
CREATE INDEX IF NOT EXISTS idxProjectInsightsFingerprint
  ON project_insights(projectId, fingerprint);

-- Index for filtering insights by category
CREATE INDEX IF NOT EXISTS idxProjectInsightsCategory
  ON project_insights(category);

-- Index for filtering runs by projectId
CREATE INDEX IF NOT EXISTS idxInsightRunsProjectId
  ON project_insight_runs(projectId);
CREATE INDEX IF NOT EXISTS idxInsightRunsProjectTriggerStatus
  ON project_insight_runs(projectId, trigger, status);

CREATE TABLE IF NOT EXISTS project_insight_run_events (
  id TEXT PRIMARY KEY,
  runId TEXT NOT NULL,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT,
  classification TEXT,
  metadata TEXT,
  createdAt TEXT NOT NULL,
  FOREIGN KEY (runId) REFERENCES project_insight_runs(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idxInsightRunEventsRunIdSeq
  ON project_insight_run_events(runId, seq);

-- Todo list persistence tables (FN-2575)
-- Project-scoped todo lists and ordered checklist items

CREATE TABLE IF NOT EXISTS todo_lists (
  id TEXT PRIMARY KEY,
  projectId TEXT NOT NULL,
  title TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS todo_items (
  id TEXT PRIMARY KEY,
  listId TEXT NOT NULL,
  text TEXT NOT NULL,
  completed INTEGER NOT NULL DEFAULT 0,
  completedAt TEXT,
  sortOrder INTEGER NOT NULL DEFAULT 0,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  FOREIGN KEY (listId) REFERENCES todo_lists(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idxTodoListsProjectId ON todo_lists(projectId);
CREATE INDEX IF NOT EXISTS idxTodoItemsListId ON todo_items(listId);
CREATE INDEX IF NOT EXISTS idxTodoItemsSortOrder ON todo_items(listId, sortOrder);
`;

const TABLE_LEVEL_CONSTRAINT_PREFIXES = new Set([
  "PRIMARY",
  "FOREIGN",
  "UNIQUE",
  "CHECK",
  "CONSTRAINT",
]);

function normalizeSqlIdentifier(identifier: string): string {
  const trimmed = identifier.trim();
  if (!trimmed) return trimmed;
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("`") && trimmed.endsWith("`")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseCreateTableSchemasFromSql(sql: string): Map<string, Map<string, string>> {
  const schema = new Map<string, Map<string, string>>();
  const createTableRegex = /CREATE TABLE\s+(?:IF NOT EXISTS\s+)?((?:["`]|\[)?[A-Za-z_][A-Za-z0-9_]*(?:["`]|\])?)\s*\(([\s\S]*?)\)\s*;/g;

  for (const match of sql.matchAll(createTableRegex)) {
    const tableName = normalizeSqlIdentifier(match[1]);
    const body = match[2] ?? "";
    const columns = new Map<string, string>();

    for (const rawLine of body.split("\n")) {
      const noComment = rawLine.replace(/--.*$/, "").trim();
      if (!noComment) continue;
      const line = noComment.endsWith(",") ? noComment.slice(0, -1).trim() : noComment;
      if (!line) continue;

      const firstWord = line.split(/\s+/, 1)[0]?.toUpperCase() ?? "";
      if (TABLE_LEVEL_CONSTRAINT_PREFIXES.has(firstWord)) continue;

      const columnMatch = line.match(/^((?:["`]|\[)?[A-Za-z_][A-Za-z0-9_]*(?:["`]|\])?)\s+(.+)$/);
      if (!columnMatch) continue;
      const columnName = normalizeSqlIdentifier(columnMatch[1]);
      const columnDefinition = columnMatch[2].trim();
      if (!columnDefinition) continue;
      columns.set(columnName, columnDefinition);
    }

    schema.set(tableName, columns);
  }

  return schema;
}

const SCHEMA_TABLE_SCHEMAS = parseCreateTableSchemasFromSql(SCHEMA_SQL);

export function getSchemaSqlTableSchemas(): Map<string, Map<string, string>> {
  return new Map([...SCHEMA_TABLE_SCHEMAS].map(([table, columns]) => [table, new Map(columns)]));
}

export function getSchemaCompatibilityTableSchemas(): Map<string, Map<string, string>> {
  const tables = getSchemaSqlTableSchemas();
  for (const [table, columns] of Object.entries(MIGRATION_ONLY_TABLE_SCHEMAS)) {
    tables.set(table, new Map(Object.entries(columns)));
  }
  return tables;
}

function canonicalizeSchemaTables(tables: Map<string, Map<string, string>>): Record<string, Record<string, string>> {
  return Object.fromEntries(
    [...tables.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([tableName, columns]) => [
        tableName,
        Object.fromEntries(
          [...columns.entries()].sort(([left], [right]) => left.localeCompare(right)),
        ),
      ]),
  );
}

export const MIGRATION_ONLY_TABLE_SCHEMAS: Record<string, Record<string, string>> = {
  ai_sessions: {
    id: "TEXT PRIMARY KEY",
    type: "TEXT NOT NULL",
    status: "TEXT NOT NULL",
    title: "TEXT NOT NULL",
    inputPayload: "TEXT NOT NULL",
    conversationHistory: "TEXT DEFAULT '[]'",
    currentQuestion: "TEXT",
    result: "TEXT",
    thinkingOutput: "TEXT DEFAULT ''",
    error: "TEXT",
    projectId: "TEXT",
    createdAt: "TEXT NOT NULL",
    updatedAt: "TEXT NOT NULL",
    lockedByTab: "TEXT",
    lockedAt: "TEXT",
    archived: "INTEGER DEFAULT 0",
  },
  messages: {
    id: "TEXT PRIMARY KEY",
    fromId: "TEXT NOT NULL",
    fromType: "TEXT NOT NULL",
    toId: "TEXT NOT NULL",
    toType: "TEXT NOT NULL",
    content: "TEXT NOT NULL",
    type: "TEXT NOT NULL",
    read: "INTEGER DEFAULT 0",
    metadata: "TEXT",
    createdAt: "TEXT NOT NULL",
    updatedAt: "TEXT NOT NULL",
  },
  agentRatings: {
    id: "TEXT PRIMARY KEY",
    agentId: "TEXT NOT NULL",
    raterType: "TEXT NOT NULL",
    raterId: "TEXT",
    score: "INTEGER NOT NULL CHECK(score BETWEEN 1 AND 5)",
    category: "TEXT",
    comment: "TEXT",
    runId: "TEXT",
    taskId: "TEXT",
    createdAt: "TEXT NOT NULL",
  },
  chat_sessions: {
    id: "TEXT PRIMARY KEY",
    agentId: "TEXT NOT NULL",
    title: "TEXT",
    status: "TEXT NOT NULL DEFAULT 'active'",
    projectId: "TEXT",
    modelProvider: "TEXT",
    modelId: "TEXT",
    createdAt: "TEXT NOT NULL",
    updatedAt: "TEXT NOT NULL",
    cliSessionFile: "TEXT",
    inFlightGeneration: "TEXT",
    cliExecutorAdapterId: "TEXT",
  },
  cli_sessions: {
    id: "TEXT PRIMARY KEY",
    taskId: "TEXT",
    chatSessionId: "TEXT",
    purpose: "TEXT NOT NULL",
    projectId: "TEXT NOT NULL",
    adapterId: "TEXT NOT NULL",
    agentState: "TEXT NOT NULL DEFAULT 'starting'",
    terminationReason: "TEXT",
    nativeSessionId: "TEXT",
    resumeAttempts: "INTEGER NOT NULL DEFAULT 0",
    autonomyPosture: "TEXT",
    worktreePath: "TEXT",
    createdAt: "TEXT NOT NULL",
    updatedAt: "TEXT NOT NULL",
  },
  chat_messages: {
    id: "TEXT PRIMARY KEY",
    sessionId: "TEXT NOT NULL",
    role: "TEXT NOT NULL",
    content: "TEXT NOT NULL",
    thinkingOutput: "TEXT",
    metadata: "TEXT",
    createdAt: "TEXT NOT NULL",
    attachments: "TEXT",
  },
  runAuditEvents: {
    id: "TEXT PRIMARY KEY",
    timestamp: "TEXT NOT NULL",
    taskId: "TEXT",
    agentId: "TEXT NOT NULL",
    runId: "TEXT NOT NULL",
    domain: "TEXT NOT NULL",
    mutationType: "TEXT NOT NULL",
    target: "TEXT NOT NULL",
    metadata: "TEXT",
  },
  mission_contract_assertions: {
    id: "TEXT PRIMARY KEY",
    milestoneId: "TEXT NOT NULL",
    title: "TEXT NOT NULL",
    assertion: "TEXT NOT NULL",
    status: "TEXT NOT NULL DEFAULT 'pending'",
    orderIndex: "INTEGER NOT NULL DEFAULT 0",
    sourceFeatureId: "TEXT",
    createdAt: "TEXT NOT NULL",
    updatedAt: "TEXT NOT NULL",
  },
  mission_feature_assertions: {
    featureId: "TEXT NOT NULL",
    assertionId: "TEXT NOT NULL",
    createdAt: "TEXT NOT NULL",
  },
  mission_validator_runs: {
    id: "TEXT PRIMARY KEY",
    featureId: "TEXT NOT NULL",
    milestoneId: "TEXT NOT NULL",
    sliceId: "TEXT NOT NULL",
    status: "TEXT NOT NULL DEFAULT 'running'",
    triggerType: "TEXT NOT NULL DEFAULT 'auto'",
    implementationAttempt: "INTEGER NOT NULL DEFAULT 0",
    validatorAttempt: "INTEGER NOT NULL DEFAULT 0",
    summary: "TEXT",
    blockedReason: "TEXT",
    startedAt: "TEXT NOT NULL",
    completedAt: "TEXT",
    createdAt: "TEXT NOT NULL",
    updatedAt: "TEXT NOT NULL",
    taskId: "TEXT",
  },
  mission_validator_failures: {
    id: "TEXT PRIMARY KEY",
    runId: "TEXT NOT NULL",
    featureId: "TEXT NOT NULL",
    assertionId: "TEXT NOT NULL",
    message: "TEXT",
    expected: "TEXT",
    actual: "TEXT",
    createdAt: "TEXT NOT NULL",
  },
  mission_fix_feature_lineage: {
    id: "TEXT PRIMARY KEY",
    sourceFeatureId: "TEXT NOT NULL",
    fixFeatureId: "TEXT NOT NULL",
    runId: "TEXT NOT NULL",
    failedAssertionIds: "TEXT NOT NULL DEFAULT '[]'",
    createdAt: "TEXT NOT NULL",
  },
  verification_cache: {
    treeSha: "TEXT NOT NULL",
    testCommand: "TEXT NOT NULL DEFAULT ''",
    buildCommand: "TEXT NOT NULL DEFAULT ''",
    recordedAt: "TEXT NOT NULL",
    taskId: "TEXT",
  },
  approval_requests: {
    id: "TEXT PRIMARY KEY",
    status: "TEXT NOT NULL",
    requesterActorId: "TEXT NOT NULL",
    requesterActorType: "TEXT NOT NULL",
    requesterActorName: "TEXT NOT NULL",
    targetActionCategory: "TEXT NOT NULL",
    targetActionOperation: "TEXT NOT NULL",
    targetActionSummary: "TEXT NOT NULL",
    targetResourceType: "TEXT NOT NULL",
    targetResourceId: "TEXT NOT NULL",
    targetContext: "TEXT",
    taskId: "TEXT",
    runId: "TEXT",
    requestedAt: "TEXT NOT NULL",
    decidedAt: "TEXT",
    completedAt: "TEXT",
    createdAt: "TEXT NOT NULL",
    updatedAt: "TEXT NOT NULL",
  },
  approval_request_audit_events: {
    id: "TEXT PRIMARY KEY",
    requestId: "TEXT NOT NULL",
    eventType: "TEXT NOT NULL",
    actorId: "TEXT NOT NULL",
    actorType: "TEXT NOT NULL",
    actorName: "TEXT NOT NULL",
    note: "TEXT",
    createdAt: "TEXT NOT NULL",
  },
  chat_rooms: {
    id: "TEXT PRIMARY KEY",
    name: "TEXT NOT NULL",
    slug: "TEXT NOT NULL",
    description: "TEXT",
    projectId: "TEXT",
    createdBy: "TEXT",
    status: "TEXT NOT NULL DEFAULT 'active'",
    createdAt: "TEXT NOT NULL",
    updatedAt: "TEXT NOT NULL",
  },
  chat_room_members: {
    roomId: "TEXT NOT NULL",
    agentId: "TEXT NOT NULL",
    role: "TEXT NOT NULL DEFAULT 'member'",
    addedAt: "TEXT NOT NULL",
  },
  chat_room_messages: {
    id: "TEXT PRIMARY KEY",
    roomId: "TEXT NOT NULL",
    role: "TEXT NOT NULL",
    content: "TEXT NOT NULL",
    thinkingOutput: "TEXT",
    metadata: "TEXT",
    attachments: "TEXT",
    senderAgentId: "TEXT",
    mentions: "TEXT",
    createdAt: "TEXT NOT NULL",
  },
  // agentLogEntries is created by migration 40 for legacy DBs and dropped by
  // migration 102. Included here so the architecture-schema-compat test
  // recognizes it as a covered migration-only table.
  agentLogEntries: {
    id: "INTEGER PRIMARY KEY AUTOINCREMENT",
    taskId: "TEXT NOT NULL",
    timestamp: "TEXT NOT NULL",
    text: "TEXT NOT NULL",
    type: "TEXT NOT NULL",
    detail: "TEXT",
    agent: "TEXT",
  },
};

/**
 * Process-local fingerprint of the additive schema compatibility contract.
 *
 * The hash covers the current schema version plus the canonicalized column
 * declarations from both SCHEMA_SQL and MIGRATION_ONLY_TABLE_SCHEMAS, so any
 * schema edit that changes the compatibility surface automatically invalidates
 * the persisted __meta cache on next init().
 */
export const SCHEMA_COMPAT_FINGERPRINT = createHash("sha1")
  .update(
    JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      schemaSqlTables: canonicalizeSchemaTables(SCHEMA_TABLE_SCHEMAS),
      migrationOnlyTableSchemas: Object.fromEntries(
        Object.entries(MIGRATION_ONLY_TABLE_SCHEMAS)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([tableName, columns]) => [
            tableName,
            Object.fromEntries(
              Object.entries(columns).sort(([left], [right]) => left.localeCompare(right)),
            ),
          ]),
      ),
    }),
  )
  .digest("hex");

/** Compact UTC timestamp (YYYY-MM-DD-HHmmss) for recovery artifact filenames. */
function formatDbRecoveryTimestamp(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mm = String(date.getUTCMinutes()).padStart(2, "0");
  const ss = String(date.getUTCSeconds()).padStart(2, "0");
  return `${y}-${m}-${d}-${hh}${mm}${ss}`;
}

/**
 * Run `PRAGMA quick_check` against a SQLite file via the `sqlite3` CLI without
 * opening a live connection (so we never replay/checkpoint a WAL onto it).
 * `verified=false` means the check could not run (sqlite3 unavailable) and the
 * caller should treat the result as non-blocking.
 */
export function quickCheckSqliteFile(dbPath: string): { ok: boolean; verified: boolean; errors?: string[] } {
  if (!existsSync(dbPath)) {
    return { ok: false, verified: true, errors: ["file does not exist"] };
  }
  const result = spawnSync("sqlite3", [dbPath, "PRAGMA quick_check;"], {
    encoding: "utf-8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) {
    return { ok: true, verified: false };
  }
  const stdout = (result.stdout ?? "").trim();
  if (result.status !== 0) {
    return { ok: false, verified: true, errors: [stdout || (result.stderr ?? "").trim() || `sqlite3 exited ${result.status}`] };
  }
  if (stdout.toLowerCase() === "ok") {
    return { ok: true, verified: true };
  }
  return { ok: false, verified: true, errors: stdout.split("\n").slice(0, 5) };
}

// ── Database Class ───────────────────────────────────────────────────

type SharedIntegrityCheckState = {
  timer: ReturnType<typeof setTimeout> | null;
  subscribers: Set<Database>;
  running: boolean;
};

export class Database {
  private static readonly sharedIntegrityChecks = new Map<string, SharedIntegrityCheckState>();

  private db: DatabaseSync;
  private readonly dbPath: string;
  private readonly inMemory: boolean;
  /** Returns the database file path (or ":memory:" for in-memory databases). */
  get path(): string { return this.dbPath; }
  corruptionDetected = false;
  integrityCheckErrors: string[] = [];
  integrityCheckPending = false;
  integrityCheckLastRunAt: string | null = null;
  /** Tracks transaction nesting depth for savepoint-based nested transactions. */
  private transactionDepth = 0;
  private readonly _fts5Available: boolean;
  private integrityCheckScheduled = false;
  private closed = false;
  private readonly busyTimeoutMs: number;
  private readonly lockRecoveryWindowMs: number;
  private readonly lockRecoveryDelayMs: number;

  constructor(
    fusionDir: string,
    options?: { inMemory?: boolean; busyTimeoutMs?: number; lockRecoveryWindowMs?: number; lockRecoveryDelayMs?: number },
  ) {
    // In-memory mode is a test-only fast path that swaps the on-disk
    // SQLite file for SQLite's `:memory:` connection. Schema + data live
    // entirely in process RAM, eliminating per-test disk open/sync cost
    // (~30-50ms × hundreds of tests in store.test.ts). Production code
    // never sets this — it's plumbed through TaskStore for tests that
    // don't need cross-instance persistence.
    const inMemory = options?.inMemory === true;
    this.inMemory = inMemory;
    this.dbPath = inMemory ? ":memory:" : join(fusionDir, "fusion.db");
    this.busyTimeoutMs = Math.max(0, options?.busyTimeoutMs ?? DEFAULT_SQLITE_BUSY_TIMEOUT_MS);
    this.lockRecoveryWindowMs = Math.max(0, options?.lockRecoveryWindowMs ?? DEFAULT_SQLITE_LOCK_RECOVERY_WINDOW_MS);
    this.lockRecoveryDelayMs = Math.max(1, options?.lockRecoveryDelayMs ?? DEFAULT_SQLITE_LOCK_RECOVERY_DELAY_MS);

    if (!inMemory && !isAbsolute(fusionDir)) {
      throw new Error(`[fusion] Database constructor requires an absolute fusionDir path, got: ${fusionDir}`);
    }

    // Defensive: a fusionDir whose last two path segments are both ".fusion"
    // indicates a caller mistakenly passed a `.fusion` directory where a
    // project root was expected (a Store class joined `.fusion` onto a path
    // that already ended in `.fusion`). Failing fast here surfaces the bug
    // at the originating call site rather than silently creating a stray
    // `.fusion/.fusion/` tree under the project.
    if (!inMemory && /\.fusion[\\/]\.fusion(?:[\\/]|$)/.test(fusionDir)) {
      throw new Error(
        `[fusion] Refusing to open Database at nested .fusion/.fusion path: ${fusionDir}\n` +
        "This means a caller passed a .fusion directory where a project root was expected. " +
        "Audit the call site for an extra `join(rootDir, '.fusion')` step.",
      );
    }

    // Ensure .fusion directory exists (only meaningful for disk-backed mode;
    // in-memory mode never touches the filesystem here).
    if (!inMemory && !existsSync(fusionDir)) {
      mkdirSync(fusionDir, { recursive: true });
    }

    try {
      this.db = new DatabaseSync(this.dbPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to open Fusion database at ${this.dbPath}: ${message}`);
    }

    // WAL is meaningless for `:memory:` connections — SQLite ignores it
    // and there's no other writer to coordinate with — so we skip WAL-only
    // tuning there.
    if (!inMemory) {
      // Wait up to the configured timeout for locks to clear before returning
      // SQLITE_BUSY. Set this before other PRAGMAs so they also benefit.
      this.db.exec(`PRAGMA busy_timeout = ${this.busyTimeoutMs}`);
      // Enable WAL mode for concurrent reader/writer access
      this.db.exec("PRAGMA journal_mode = WAL");
      // FULL fsyncs on every commit. Slightly slower than NORMAL, but the only
      // setting that survives a process crash mid-checkpoint without torn pages
      // — repeated node:sqlite SIGSEGVs inside pager_write have corrupted this
      // db before.
      this.db.exec("PRAGMA synchronous = FULL");
      // Default (1000) checkpoint cadence. The previous value of 100 made the
      // db spend most of its life mid-checkpoint, multiplying corruption risk
      // when a writer crashed. journal_size_limit below still caps WAL growth.
      this.db.exec("PRAGMA wal_autocheckpoint = 1000");
      // Bound WAL growth between checkpoints/maintenance cycles.
      this.db.exec("PRAGMA journal_size_limit = 4194304");
    } else {
      // Wait up to the configured timeout for locks to clear before returning SQLITE_BUSY.
      this.db.exec(`PRAGMA busy_timeout = ${this.busyTimeoutMs}`);
    }
    // Enable foreign key enforcement
    this.db.exec("PRAGMA foreign_keys = ON");

    this._fts5Available = probeFts5(this.db);
  }

  /**
   * True when the underlying SQLite build has FTS5 (`CREATE VIRTUAL TABLE … USING fts5`).
   * Node's bundled SQLite only exposes FTS5 when built with `SQLITE_ENABLE_FTS5`;
   * older Node 22.x LTS builds do not. Consumers must fall back to LIKE-based scans
   * when this is false. Override with `FUSION_DISABLE_FTS5=1` to force the fallback path.
   */
  get fts5Available(): boolean {
    return this._fts5Available;
  }

  /**
   * Rebuild the task FTS5 index and maintenance triggers from scratch.
   * Returns false when FTS5 is unavailable in this runtime.
   */
  rebuildFts5Index(): boolean {
    if (!this._fts5Available) {
      return false;
    }

    try {
      this.db.exec("DROP TRIGGER IF EXISTS tasks_fts_ai");
      this.db.exec("DROP TRIGGER IF EXISTS tasks_fts_au");
      this.db.exec("DROP TRIGGER IF EXISTS tasks_fts_ad");
      this.db.exec("DROP TABLE IF EXISTS tasks_fts");

      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS tasks_fts USING fts5(
          id,
          title,
          description,
          comments,
          content='tasks',
          content_rowid='rowid'
        )
      `);

      const hasTaskTitle = this.hasColumn("tasks", "title");
      const hasDeletedAt = this.hasColumn("tasks", "deletedAt");

      this.db.exec(`
        CREATE TRIGGER IF NOT EXISTS tasks_fts_ai AFTER INSERT ON tasks
        ${hasDeletedAt ? "WHEN NEW.deletedAt IS NULL " : ""}BEGIN
          INSERT INTO tasks_fts(rowid, id, title, description, comments)
          VALUES (new.rowid, new.id, COALESCE(new.title, ''), new.description, COALESCE(new.comments, '[]'));
        END
      `);

      const updateColumns = hasTaskTitle
        ? hasDeletedAt ? "id, title, description, comments, deletedAt" : "id, title, description, comments"
        : hasDeletedAt ? "id, description, comments, deletedAt" : "id, description, comments";
      const oldTitle = hasTaskTitle ? "COALESCE(old.title, '')" : "''";
      const newTitle = hasTaskTitle ? "COALESCE(new.title, '')" : "''";

      this.db.exec(`
        CREATE TRIGGER IF NOT EXISTS tasks_fts_au AFTER UPDATE OF ${updateColumns} ON tasks BEGIN
          INSERT INTO tasks_fts(tasks_fts, rowid, id, title, description, comments)
            VALUES('delete', old.rowid, old.id, ${oldTitle}, old.description, COALESCE(old.comments, '[]'));
          INSERT INTO tasks_fts(rowid, id, title, description, comments)
            SELECT new.rowid, new.id, ${newTitle}, new.description, COALESCE(new.comments, '[]')
            WHERE ${hasDeletedAt ? "new.deletedAt IS NULL" : "1 = 1"};
        END
      `);

      this.db.exec(`
        CREATE TRIGGER IF NOT EXISTS tasks_fts_ad AFTER DELETE ON tasks
        ${hasDeletedAt ? "WHEN OLD.deletedAt IS NULL " : ""}BEGIN
          INSERT INTO tasks_fts(tasks_fts, rowid, id, title, description, comments)
            VALUES('delete', old.rowid, old.id, COALESCE(old.title, ''), old.description, COALESCE(old.comments, '[]'));
        END
      `);

      this.db.exec("INSERT INTO tasks_fts(tasks_fts) VALUES('rebuild')");
      return true;
    } catch (error) {
      console.warn("[fusion:db] Failed to rebuild FTS5 index", error);
      throw error;
    }
  }

  /**
   * Run FTS5 integrity check. Returns true when healthy or unavailable.
   */
  checkFts5Integrity(): boolean {
    if (!this._fts5Available) {
      return true;
    }

    try {
      this.db.exec("INSERT INTO tasks_fts(tasks_fts) VALUES('integrity-check')");
      return true;
    } catch {
      return false;
    }
  }

  integrityCheck(): { ok: true } | { ok: false; errors: string[] } {
    if (this.inMemory) {
      return { ok: true };
    }

    const rows = this.db
      .prepare("PRAGMA integrity_check(100)")
      .all() as Array<Record<string, unknown>>;
    const errors = rows
      .map((row) => row.integrity_check)
      .filter((value): value is string => typeof value === "string" && value !== "ok");

    if (errors.length > 0) {
      return { ok: false, errors };
    }

    return { ok: true };
  }

  /**
   * Synchronously re-run `integrityCheck()` and update the cached corruption
   * state (`corruptionDetected`, `integrityCheckErrors`, `integrityCheckLastRunAt`).
   *
   * The background scheduler in `scheduleBackgroundIntegrityCheck()` runs the
   * check exactly once at boot; without this on-demand path the
   * `corruptionDetected` flag is sticky for the life of the process, which
   * leaves the "Refresh health" UI a no-op after the user repairs the DB
   * (e.g. via `REINDEX`).
   */
  refreshIntegrityCheck(): { ok: true } | { ok: false; errors: string[] } {
    const integrity = this.integrityCheck();
    this.integrityCheckPending = false;
    this.integrityCheckLastRunAt = new Date().toISOString();
    this.corruptionDetected = !integrity.ok;
    this.integrityCheckErrors = integrity.ok ? [] : [...integrity.errors];
    return integrity;
  }

  recoverDatabase(outputPath: string): boolean {
    if (this.inMemory) {
      return false;
    }

    const recoveredSql = spawnSync("sqlite3", [this.dbPath, ".recover"], {
      encoding: "utf-8",
      maxBuffer: 256 * 1024 * 1024,
    });
    if (recoveredSql.status !== 0 || !recoveredSql.stdout) {
      return false;
    }

    const rebuilt = spawnSync("sqlite3", [outputPath], {
      input: recoveredSql.stdout,
      encoding: "utf-8",
      maxBuffer: 256 * 1024 * 1024,
    });

    return rebuilt.status === 0;
  }

  /**
   * Startup guard: detect a malformed `fusion.db` and rebuild it via
   * `sqlite3 .recover` BEFORE any connection is opened for normal use.
   *
   * This is the automated form of the manual recovery: a node:sqlite SIGSEGV
   * mid-write can leave the B-tree malformed in a way that still *opens* and
   * answers simple queries (so a sentinel SELECT won't catch it) — only an
   * integrity/quick check does. When corruption is found we:
   *   1. recover the readable data into a fresh file,
   *   2. verify the rebuilt file passes quick_check,
   *   3. preserve the corrupt original as `fusion.db.corrupt-<ts>`,
   *   4. atomically swap the rebuilt file into place and drop stale -wal/-shm.
   *
   * Must run with no open connection to `fusion.db`. Returns a status describing
   * what happened; on `failed` the original file is left untouched for manual
   * inspection. `sqlite3` CLI absence yields `unverified` (non-blocking no-op).
   */
  static recoverIfCorrupt(fusionDir: string): {
    status: "absent" | "healthy" | "unverified" | "recovered" | "failed";
    corruptBackupPath?: string;
    recoveredPath?: string;
    errors?: string[];
  } {
    const dbPath = join(fusionDir, "fusion.db");
    if (!existsSync(dbPath)) {
      return { status: "absent" };
    }

    const check = quickCheckSqliteFile(dbPath);
    if (!check.verified) {
      return { status: "unverified" };
    }
    if (check.ok) {
      return { status: "healthy" };
    }

    // Corruption confirmed — attempt an offline rebuild.
    const ts = formatDbRecoveryTimestamp(new Date());
    const recoveredPath = `${dbPath}.recovered-${ts}`;

    const recoveredSql = spawnSync("sqlite3", [dbPath, ".recover"], {
      encoding: "utf-8",
      maxBuffer: 256 * 1024 * 1024,
    });
    if (recoveredSql.status !== 0 || !recoveredSql.stdout) {
      return { status: "failed", errors: check.errors };
    }
    const rebuilt = spawnSync("sqlite3", [recoveredPath], {
      input: recoveredSql.stdout,
      encoding: "utf-8",
      maxBuffer: 256 * 1024 * 1024,
    });
    if (rebuilt.status !== 0) {
      try { rmSync(recoveredPath, { force: true }); } catch { /* ignore */ }
      return { status: "failed", errors: check.errors };
    }

    // Refuse to swap in a rebuild that is itself not clean.
    const verifyRebuilt = quickCheckSqliteFile(recoveredPath);
    if (verifyRebuilt.verified && !verifyRebuilt.ok) {
      try { rmSync(recoveredPath, { force: true }); } catch { /* ignore */ }
      return { status: "failed", errors: check.errors };
    }

    try {
      const corruptBackupPath = `${dbPath}.corrupt-${ts}`;
      renameSync(dbPath, corruptBackupPath);
      // Stale WAL/SHM belong to the corrupt file; SQLite must not replay them
      // onto the rebuilt database.
      try { rmSync(`${dbPath}-wal`, { force: true }); } catch { /* ignore */ }
      try { rmSync(`${dbPath}-shm`, { force: true }); } catch { /* ignore */ }
      renameSync(recoveredPath, dbPath);
      return { status: "recovered", corruptBackupPath, errors: check.errors };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { status: "failed", errors: [...(check.errors ?? []), message] };
    }
  }

  /**
   * Run WAL truncation + VACUUM and report compaction stats.
   *
   * In-memory databases no-op and return zeroed stats. Disk-backed databases
   * sample file size before/after compaction, run `wal_checkpoint(TRUNCATE)`,
   * and then run `VACUUM` while the connection is in EXCLUSIVE locking mode to
   * prevent concurrent writes from other connections during maintenance.
   */
  vacuum(): VacuumResult {
    if (this.inMemory) {
      return { beforeBytes: 0, afterBytes: 0, durationMs: 0 };
    }

    const beforeBytes = existsSync(this.dbPath) ? statSync(this.dbPath).size : 0;
    const startedAt = Date.now();

    this.db.exec("PRAGMA locking_mode=EXCLUSIVE");

    try {
      try {
        this.walCheckpoint("TRUNCATE");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Database vacuum maintenance failed during WAL checkpoint (dbPath=${this.dbPath}): ${message}`);
      }

      try {
        this.db.exec("VACUUM");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Database vacuum maintenance failed during VACUUM (dbPath=${this.dbPath}): ${message}`);
      }

      const afterBytes = existsSync(this.dbPath) ? statSync(this.dbPath).size : 0;
      return {
        beforeBytes,
        afterBytes,
        durationMs: Date.now() - startedAt,
      };
    } finally {
      this.db.exec("PRAGMA locking_mode=NORMAL");
    }
  }

  /**
   * Drop scratch tables left behind by `sqlite3 .recover`.
   *
   * Recovery emits `lost_and_found` / `lost_and_found_N` tables holding orphaned
   * rows it could not attribute to a real table. They are never part of the
   * Fusion schema, but a recovered db that gets backed up and restored carries
   * them forward indefinitely — on this database they had accumulated ~250K dead
   * rows across prior recoveries, inflating file size and every integrity check.
   * Returns the number of scratch tables dropped.
   */
  dropOrphanRecoveryTables(): number {
    if (this.inMemory) {
      return 0;
    }

    const rows = this.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'lost\\_and\\_found%' ESCAPE '\\'",
      )
      .all() as Array<{ name?: unknown }>;

    let dropped = 0;
    for (const row of rows) {
      const name = typeof row.name === "string" ? row.name : null;
      if (!name) continue;
      try {
        // Table names from sqlite_master are trusted identifiers; quote defensively.
        this.db.exec(`DROP TABLE IF EXISTS "${name.replace(/"/g, '""')}"`);
        dropped++;
      } catch (error) {
        console.warn(`[fusion:db] Failed to drop orphan recovery table ${name}`, error);
      }
    }
    return dropped;
  }

  /**
   * Append-only operational log tables that grow without bound. These are the
   * primary driver of database bloat (activityLog alone accrues tens of
   * thousands of rows per active day) and the bigger the file, the longer every
   * checkpoint/VACUUM spends in the write path where a node:sqlite crash can
   * corrupt it. Each entry has an ISO-8601 `timestamp` column.
   */
  private static readonly OPERATIONAL_LOG_TABLES = [
    "activityLog",
    "runAuditEvents",
    "agentHeartbeats",
  ] as const;

  /**
   * Delete operational-log rows older than `retentionMs`. No-ops (returns an
   * empty result) when `retentionMs <= 0` so callers can treat 0 as "disabled".
   * Each table is pruned independently; a failure on one (e.g. absent in an
   * older schema) is logged and skipped rather than aborting the sweep.
   */
  pruneOperationalLogs(retentionMs: number): { deletedByTable: Record<string, number>; deletedTotal: number } {
    const deletedByTable: Record<string, number> = {};
    if (this.inMemory || !Number.isFinite(retentionMs) || retentionMs <= 0) {
      return { deletedByTable, deletedTotal: 0 };
    }

    const cutoffIso = new Date(Date.now() - retentionMs).toISOString();
    let deletedTotal = 0;
    const recordChanges = (table: string, result: { changes: number | bigint }) => {
      const changes = typeof result.changes === "bigint" ? Number(result.changes) : result.changes;
      deletedByTable[table] = changes;
      deletedTotal += changes;
    };

    for (const table of Database.OPERATIONAL_LOG_TABLES) {
      if (!this.tableExists(table)) continue;
      try {
        recordChanges(
          table,
          this.db.prepare(`DELETE FROM "${table}" WHERE timestamp < ?`).run(cutoffIso),
        );
      } catch (error) {
        console.warn(`[fusion:db] Failed to prune operational log table ${table}`, error);
      }
    }

    if (this.tableExists("agentRuns")) {
      try {
        recordChanges(
          "agentRuns",
          this.db
            .prepare("DELETE FROM agentRuns WHERE endedAt IS NOT NULL AND endedAt < ?")
            .run(cutoffIso),
        );
      } catch (error) {
        console.warn("[fusion:db] Failed to prune operational log table agentRuns", error);
      }
    }

    if (this.tableExists("agentConfigRevisions")) {
      try {
        recordChanges(
          "agentConfigRevisions",
          this.db
            .prepare(
              `DELETE FROM agentConfigRevisions
               WHERE createdAt < ?
                 AND id NOT IN (
                   SELECT id FROM (
                     SELECT id,
                            ROW_NUMBER() OVER (
                              PARTITION BY agentId
                              ORDER BY createdAt DESC, rowid DESC
                            ) AS rn
                     FROM agentConfigRevisions
                   ) ranked
                   WHERE rn = 1
                 )`,
            )
            .run(cutoffIso),
        );
      } catch (error) {
        console.warn("[fusion:db] Failed to prune operational log table agentConfigRevisions", error);
      }
    }

    return { deletedByTable, deletedTotal };
  }

  /**
   * Initialize the database: create tables if they don't exist
   * and seed meta values.
   */
  init(): void {
    this.db.exec(SCHEMA_SQL);

    // Drop scratch tables from any prior `.recover` so they don't accumulate
    // across backup/restore cycles. Idempotent and cheap when none exist.
    this.dropOrphanRecoveryTables();

    this.scheduleBackgroundIntegrityCheck();

    // Seed schemaVersion and lastModified idempotently
    this.db.exec(
      `INSERT OR IGNORE INTO __meta (key, value) VALUES ('schemaVersion', '1')`,
    );
    this.db.exec(
      `INSERT OR IGNORE INTO __meta (key, value) VALUES ('lastModified', '${Date.now()}')`,
    );
    this.db.exec(
      `INSERT OR IGNORE INTO __meta (key, value) VALUES ('bootstrappedAt', '${Date.now()}')`,
    );

    // Run schema migrations
    this.migrate();

    const schemaCompatFingerprint = this.getMetaValue("schemaCompatFingerprint");
    const skipColumnReconciliation = schemaCompatFingerprint === SCHEMA_COMPAT_FINGERPRINT;
    const tableColumnsCache = skipColumnReconciliation ? undefined : new Map<string, Set<string>>();
    const compatibilityOptions: SchemaCompatibilityOptions = {
      tableColumnsCache,
      skipColumnReconciliation,
    };

    // Compatibility backfills that must run even when schemaVersion is current.
    this.ensureSchemaCompatibility(compatibilityOptions);
    this.ensureRoutinesSchemaCompatibility(compatibilityOptions);
    this.ensureInsightRunsSchemaCompatibility(compatibilityOptions);
    this.ensureEvalTaskResultsSchemaCompatibility(compatibilityOptions);

    if (!skipColumnReconciliation) {
      this.setMetaValue("schemaCompatFingerprint", SCHEMA_COMPAT_FINGERPRINT);
    }

    // Seed config row idempotently with default settings
    const configNow = new Date().toISOString();
    this.db.exec(
      `INSERT OR IGNORE INTO config (id, nextId, nextWorkflowStepId, settings, workflowSteps, updatedAt) VALUES (1, 1, 1, '${JSON.stringify(DEFAULT_PROJECT_SETTINGS)}', '[]', '${configNow}')`,
    );
  }

  /**
   * Run incremental schema migrations based on the stored schema version.
   *
   * Each migration block is guarded by a version check and runs inside a
   * transaction so that a failed migration leaves the database unchanged.
   * New migrations should be added as `if (version < N)` blocks before
   * the final version bump, and SCHEMA_VERSION should be incremented to N.
   *
   * Column additions use `hasColumn()` so they are idempotent — safe to
   * re-run even if a previous migration partially applied.
   */
  /**
   * Reconciles additive columns for every known project DB table unless the
   * persisted `schemaCompatFingerprint` already matches SCHEMA_COMPAT_FINGERPRINT.
   *
   * The fingerprint is invalidated automatically by SCHEMA_VERSION changes and by
   * edits to the canonicalized column declarations from SCHEMA_SQL or
   * MIGRATION_ONLY_TABLE_SCHEMAS. When it is absent or stale, this method runs the
   * full FN-3879/FN-3887/FN-3898 safety pass so every declared column exists on
   * every live table after init() returns.
   */
  private ensureSchemaCompatibility(options: SchemaCompatibilityOptions = {}): void {
    if (options.skipColumnReconciliation) {
      return;
    }

    const knownTableSchemas = getSchemaCompatibilityTableSchemas();
    const tableColumnsCache = options.tableColumnsCache;

    for (const [tableName, columns] of knownTableSchemas) {
      if (!this.hasTable(tableName)) continue;
      const cachedColumns = this.getTableColumns(tableName, true, tableColumnsCache);
      for (const [columnName, columnDefinition] of columns) {
        if (cachedColumns.has(columnName)) continue;
        this.addColumnIfMissingCached(tableName, columnName, columnDefinition, tableColumnsCache);
      }
    }
  }

  /**
   * Applies idempotent compatibility fixes for legacy routines table shapes.
   *
   * Some older databases contain `routines` without `agentId`, or with NULL
   * agent IDs from earlier table definitions. `RoutineStore.rowToRoutine()` and
   * backup routine sync expect a safe string value, so normalize to ''.
   */
  private ensureRoutinesSchemaCompatibility(options: SchemaCompatibilityOptions = {}): void {
    if (!this.hasTable("routines")) {
      return;
    }

    if (!options.skipColumnReconciliation) {
      this.addColumnIfMissingCached("routines", "agentId", "TEXT DEFAULT ''", options.tableColumnsCache);
      this.addColumnIfMissingCached("routines", "scope", "TEXT DEFAULT 'project'", options.tableColumnsCache);
    }

    this.db.exec("UPDATE routines SET agentId = '' WHERE agentId IS NULL");
    this.db.exec("UPDATE routines SET scope = 'project' WHERE scope IS NULL OR TRIM(scope) = ''");

    this.db.exec("CREATE INDEX IF NOT EXISTS idxRoutinesNextRunAt ON routines(nextRunAt)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idxRoutinesEnabled ON routines(enabled)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idxRoutinesScope ON routines(scope)");
  }

  /**
   * Applies idempotent post-schema compatibility fixes for project_insight_runs.
   *
   * Column reconciliation is handled by ensureSchemaCompatibility(); this method
   * remains focused on index creation that should run after the generic column
   * backfill pass.
   */
  private ensureInsightRunsSchemaCompatibility(options: SchemaCompatibilityOptions = {}): void {
    if (!this.hasTable("project_insight_runs")) {
      return;
    }

    if (!options.skipColumnReconciliation) {
      this.addColumnIfMissingCached("project_insight_runs", "lifecycle", "TEXT", options.tableColumnsCache);
      this.addColumnIfMissingCached("project_insight_runs", "cancelledAt", "TEXT", options.tableColumnsCache);
    }

    this.db.exec(`CREATE INDEX IF NOT EXISTS idxInsightRunsProjectTriggerStatus ON project_insight_runs(projectId, trigger, status)`);
  }

  private ensureEvalTaskResultsSchemaCompatibility(_options: SchemaCompatibilityOptions = {}): void {
    if (!this.hasTable("eval_task_results")) {
      return;
    }
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idxEvalTaskResultsRunTaskUnique ON eval_task_results(runId, taskId)");
  }

  private migrate(): void {
    const version = this.getSchemaVersion() || 1;

    if (this.hasTable("tasks")) {
      this.addColumnIfMissing("tasks", "executionStartBranch", "TEXT");
      this.addColumnIfMissing("tasks", "review", "TEXT");
      this.addColumnIfMissing("tasks", "userPaused", "INTEGER DEFAULT 0");
      this.addColumnIfMissing("tasks", "pausedReason", "TEXT");
      this.addColumnIfMissing("tasks", "scopeAutoWiden", "TEXT DEFAULT '[]'");
    }

    // Deferred agentLogEntries drop (companion to migration 102): when the
    // legacy table still had rows on the first init pass, the destructive drop
    // was deferred until TaskStore copies the rows to JSONL and writes the
    // __meta guard, then re-runs init(). Migrations 103+ bump the schema
    // version past 102 on that first pass, so the re-run can no longer reach
    // the version-gated 102 block — finish the drop here, version-independent
    // (and before the early return below, which fires once the version is
    // current).
    if (this.hasTable("agentLogEntries")) {
      const agentLogMigrationComplete = this.getMetaValue("agentLogEntriesToFileMigrationVersion") === "1";
      const legacyAgentLogTableIsEmpty =
        (this.db.prepare("SELECT COUNT(*) as count FROM agentLogEntries").get() as { count: number }).count === 0;
      const hasLegacyAgentLogCitations = this.hasTable("goal_citations")
        ? (this.db.prepare(
            "SELECT 1 FROM goal_citations WHERE surface = 'agent_log' AND sourceRef GLOB 'agentLog:[0-9]*' LIMIT 1",
          ).get() ?? undefined) !== undefined
        : false;
      if (agentLogMigrationComplete || (legacyAgentLogTableIsEmpty && !hasLegacyAgentLogCitations)) {
        this.db.exec(`DROP TABLE IF EXISTS agentLogEntries`);
      }
    }

    if (version >= SCHEMA_VERSION) return;

    if (version < 2) {
      this.applyMigration(2, () => {
        this.addColumnIfMissing("tasks", "comments", "TEXT DEFAULT '[]'");
        this.addColumnIfMissing("tasks", "mergeDetails", "TEXT");
      });
    }

    if (version < 3) {
      this.applyMigration(3, () => {
        // Add mission hierarchy columns to tasks for linking tasks to slices
        this.addColumnIfMissing("tasks", "missionId", "TEXT");
        this.addColumnIfMissing("tasks", "sliceId", "TEXT");
      });
    }

    if (version < 4) {
      this.applyMigration(4, () => {
        // Add modifiedFiles column to track files changed during agent execution
        this.addColumnIfMissing("tasks", "modifiedFiles", "TEXT DEFAULT '[]'");
        // Add baseCommitSha column to store the base commit for diff computation
        this.addColumnIfMissing("tasks", "baseCommitSha", "TEXT");
      });
    }

    if (version < 5) {
      this.applyMigration(5, () => {
        this.addColumnIfMissing("missions", "autoAdvance", "INTEGER DEFAULT 0");
        this.migrateLegacyCommentsToUnifiedComments();
      });
    }

    if (version < 6) {
      this.applyMigration(6, () => {
        this.addColumnIfMissing("tasks", "branch", "TEXT");
      });
    }

    if (version < 7) {
      this.applyMigration(7, () => {
        this.addColumnIfMissing("tasks", "recoveryRetryCount", "INTEGER");
        this.addColumnIfMissing("tasks", "nextRecoveryAt", "TEXT");
      });
    }

    if (version < 8) {
      this.applyMigration(8, () => {
        this.addColumnIfMissing("tasks", "stuckKillCount", "INTEGER DEFAULT 0");
      });
    }

    if (version < 9) {
      this.applyMigration(9, () => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS ai_sessions (
            id TEXT PRIMARY KEY,
            type TEXT NOT NULL,
            status TEXT NOT NULL,
            title TEXT NOT NULL,
            inputPayload TEXT NOT NULL,
            conversationHistory TEXT DEFAULT '[]',
            currentQuestion TEXT,
            result TEXT,
            thinkingOutput TEXT DEFAULT '',
            error TEXT,
            projectId TEXT,
            createdAt TEXT NOT NULL,
            updatedAt TEXT NOT NULL
          )
        `);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idxAiSessionsStatus ON ai_sessions(status)`);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idxAiSessionsType ON ai_sessions(type)`);
      });
    }

    if (version < 10) {
      this.applyMigration(10, () => {
        this.addColumnIfMissing("missions", "autopilotEnabled", "INTEGER DEFAULT 0");
        this.addColumnIfMissing("missions", "autopilotState", "TEXT DEFAULT 'inactive'");
        this.addColumnIfMissing("missions", "lastAutopilotActivityAt", "TEXT");
      });
    }

    if (version < 11) {
      this.applyMigration(11, () => {
        this.addColumnIfMissing("tasks", "planningModelProvider", "TEXT");
        this.addColumnIfMissing("tasks", "planningModelId", "TEXT");
      });
    }

    if (version < 12) {
      this.applyMigration(12, () => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY,
            fromId TEXT NOT NULL,
            fromType TEXT NOT NULL,
            toId TEXT NOT NULL,
            toType TEXT NOT NULL,
            content TEXT NOT NULL,
            type TEXT NOT NULL,
            read INTEGER DEFAULT 0,
            metadata TEXT,
            createdAt TEXT NOT NULL,
            updatedAt TEXT NOT NULL
          )
        `);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idxMessagesTo ON messages(toId, toType, read)`);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idxMessagesFrom ON messages(fromId, fromType)`);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idxMessagesCreatedAt ON messages(createdAt)`);
      });
    }

    if (version < 13) {
      this.applyMigration(13, () => {
        this.addColumnIfMissing("tasks", "assignedAgentId", "TEXT");
        this.db.exec(`CREATE INDEX IF NOT EXISTS idxTasksAssignedAgentId ON tasks(assignedAgentId)`);
      });
    }

    if (version < 14) {
      this.applyMigration(14, () => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS agentRatings (
            id TEXT PRIMARY KEY,
            agentId TEXT NOT NULL,
            raterType TEXT NOT NULL,
            raterId TEXT,
            score INTEGER NOT NULL CHECK(score BETWEEN 1 AND 5),
            category TEXT,
            comment TEXT,
            runId TEXT,
            taskId TEXT,
            createdAt TEXT NOT NULL
          )
        `);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idxAgentRatingsAgentId ON agentRatings(agentId)`);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idxAgentRatingsCreatedAt ON agentRatings(createdAt)`);
      });
    }

    if (version < 15) {
      this.applyMigration(15, () => {
        if (this.hasTable("ai_sessions")) {
          this.db.exec(`CREATE INDEX IF NOT EXISTS idxAiSessionsUpdatedAt ON ai_sessions(updatedAt)`);
        }
      });
    }

    if (version < 16) {
      this.applyMigration(16, () => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS workflow_steps (
            id TEXT PRIMARY KEY,
            templateId TEXT,
            name TEXT NOT NULL,
            description TEXT NOT NULL,
            mode TEXT NOT NULL DEFAULT 'prompt',
            phase TEXT NOT NULL DEFAULT 'pre-merge',
            prompt TEXT NOT NULL DEFAULT '',
            gateMode TEXT NOT NULL DEFAULT 'advisory',
            toolMode TEXT,
            scriptName TEXT,
            enabled INTEGER NOT NULL DEFAULT 1,
            defaultOn INTEGER DEFAULT 0,
            modelProvider TEXT,
            modelId TEXT,
            createdAt TEXT NOT NULL,
            updatedAt TEXT NOT NULL
          )
        `);

        const configRow = this.db
          .prepare("SELECT workflowSteps FROM config WHERE id = 1")
          .get() as { workflowSteps?: string | null } | undefined;
        const workflowSteps = fromJson<Array<Record<string, unknown>>>(configRow?.workflowSteps);

        if (!Array.isArray(workflowSteps) || workflowSteps.length === 0) {
          return;
        }

        const insertWorkflowStep = this.db.prepare(`
          INSERT OR IGNORE INTO workflow_steps (
            id,
            templateId,
            name,
            description,
            mode,
            phase,
            prompt,
            gateMode,
            toolMode,
            scriptName,
            enabled,
            defaultOn,
            modelProvider,
            modelId,
            createdAt,
            updatedAt
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        for (const step of workflowSteps) {
          const id = typeof step.id === "string" ? step.id : "";
          const name = typeof step.name === "string" ? step.name : "";
          const description = typeof step.description === "string" ? step.description : "";

          if (!id || !name || !description) {
            continue;
          }

          const mode = step.mode === "script" ? "script" : "prompt";
          const phase = step.phase === "post-merge" ? "post-merge" : "pre-merge";
          const gateMode = step.mode === "script" ? "gate" : "advisory";
          const createdAt =
            typeof step.createdAt === "string" && step.createdAt
              ? step.createdAt
              : new Date().toISOString();
          const updatedAt =
            typeof step.updatedAt === "string" && step.updatedAt
              ? step.updatedAt
              : createdAt;

          insertWorkflowStep.run(
            id,
            typeof step.templateId === "string" ? step.templateId : null,
            name,
            description,
            mode,
            phase,
            gateMode,
            typeof step.prompt === "string" ? step.prompt : "",
            step.gateMode === "gate" || step.gateMode === "advisory"
              ? step.gateMode
              : (mode === "script" ? "gate" : "advisory"),
            step.toolMode === "coding" || step.toolMode === "readonly" ? step.toolMode : null,
            typeof step.scriptName === "string" ? step.scriptName : null,
            step.enabled === false ? 0 : 1,
            step.defaultOn === true ? 1 : 0,
            typeof step.modelProvider === "string" ? step.modelProvider : null,
            typeof step.modelId === "string" ? step.modelId : null,
            createdAt,
            updatedAt,
          );
        }
      });
    }

    if (version < 17) {
      this.applyMigration(17, () => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS mission_events (
            id TEXT PRIMARY KEY,
            missionId TEXT NOT NULL,
            eventType TEXT NOT NULL,
            description TEXT NOT NULL,
            metadata TEXT,
            timestamp TEXT NOT NULL,
            FOREIGN KEY (missionId) REFERENCES missions(id) ON DELETE CASCADE
          )
        `);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idxMissionEventsMissionId ON mission_events(missionId)`);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idxMissionEventsTimestamp ON mission_events(timestamp)`);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idxMissionEventsType ON mission_events(eventType)`);
      });
    }

    if (version < 18) {
      this.applyMigration(18, () => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS task_documents (
            id TEXT PRIMARY KEY,
            taskId TEXT NOT NULL,
            key TEXT NOT NULL,
            content TEXT NOT NULL DEFAULT '',
            revision INTEGER NOT NULL DEFAULT 1,
            author TEXT NOT NULL DEFAULT 'user',
            metadata TEXT,
            createdAt TEXT NOT NULL,
            updatedAt TEXT NOT NULL,
            FOREIGN KEY (taskId) REFERENCES tasks(id) ON DELETE CASCADE
          )
        `);
        this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idxTaskDocumentsTaskKey ON task_documents(taskId, key)`);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idxTaskDocumentsTaskId ON task_documents(taskId)`);
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS task_document_revisions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            taskId TEXT NOT NULL,
            key TEXT NOT NULL,
            content TEXT NOT NULL,
            revision INTEGER NOT NULL,
            author TEXT NOT NULL,
            metadata TEXT,
            createdAt TEXT NOT NULL
          )
        `);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idxTaskDocumentRevisionsTaskKey ON task_document_revisions(taskId, key)`);
      });
    }

    if (version < 19) {
      this.applyMigration(19, () => {
        if (!this.hasTable("ai_sessions")) {
          return;
        }
        this.addColumnIfMissing("ai_sessions", "lockedByTab", "TEXT");
        this.addColumnIfMissing("ai_sessions", "lockedAt", "TEXT");
        this.db.exec("CREATE INDEX IF NOT EXISTS idxAiSessionsLock ON ai_sessions(lockedByTab)");
      });
    }

    if (version < 20) {
      this.applyMigration(20, () => {
        this.addColumnIfMissing("tasks", "checkedOutBy", "TEXT");
        this.addColumnIfMissing("tasks", "checkedOutAt", "TEXT");
        this.addColumnIfMissing("tasks", "checkoutNodeId", "TEXT");
        this.addColumnIfMissing("tasks", "checkoutRunId", "TEXT");
        this.addColumnIfMissing("tasks", "checkoutLeaseRenewedAt", "TEXT");
        this.addColumnIfMissing("tasks", "checkoutLeaseEpoch", "INTEGER DEFAULT 0");
      });
    }

    // FTS5 full-text search index for tasks.
    // All task writes go through upsertTask() (called by atomicWriteTaskJson()),
    // which does INSERT OR REPLACE INTO tasks. The SQLite triggers below fire on
    // INSERT/UPDATE/DELETE and keep the FTS index in sync automatically.
    // The comments column is a JSON array - FTS5 tokenizes the raw JSON which picks
    // up comment text, IDs, timestamps, and author names. This is acceptable for v1.
    if (version < 21) {
      this.applyMigration(21, () => {
        if (!this._fts5Available) {
          // FTS5 unavailable (older node:sqlite build). Bump the migration
          // version so we don't retry forever, and fall back to LIKE-based
          // search in TaskStore.searchTasks / ArchiveDatabase.search.
          return;
        }
        // Create FTS5 virtual table for full-text search
        // Note: Column names must match the tasks table for external content mode to work
        this.db.exec(`
          CREATE VIRTUAL TABLE IF NOT EXISTS tasks_fts USING fts5(
            id,
            title,
            description,
            comments,
            content='tasks',
            content_rowid='rowid'
          )
        `);

        // Populate FTS index from existing tasks
        // Handle both older schemas (without title) and newer schemas (with title)
        if (this.hasColumn("tasks", "title")) {
          this.db.exec(`
            INSERT INTO tasks_fts(rowid, id, title, description, comments)
              SELECT rowid, id, COALESCE(title, ''), description, COALESCE(comments, '[]') FROM tasks
          `);
        } else {
          this.db.exec(`
            INSERT INTO tasks_fts(rowid, id, title, description, comments)
              SELECT rowid, id, '', description, COALESCE(comments, '[]') FROM tasks
          `);
        }

        // AFTER INSERT trigger - index new tasks
        const hasTaskTitle = this.hasColumn("tasks", "title");
        const hasDeletedAt = this.hasColumn("tasks", "deletedAt");
        this.db.exec(`
          CREATE TRIGGER IF NOT EXISTS tasks_fts_ai AFTER INSERT ON tasks
          ${hasDeletedAt ? "WHEN NEW.deletedAt IS NULL " : ""}BEGIN
            INSERT INTO tasks_fts(rowid, id, title, description, comments)
            VALUES (new.rowid, new.id, COALESCE(new.title, ''), new.description, COALESCE(new.comments, '[]'));
          END
        `);

        const updateColumns = hasTaskTitle
          ? hasDeletedAt ? "id, title, description, comments, deletedAt" : "id, title, description, comments"
          : hasDeletedAt ? "id, description, comments, deletedAt" : "id, description, comments";
        const oldTitle = hasTaskTitle ? "COALESCE(old.title, '')" : "''";
        const newTitle = hasTaskTitle ? "COALESCE(new.title, '')" : "''";

        // AFTER UPDATE trigger - reindex updated tasks (delete old + insert new).
        // Restrict this to searchable columns so log/status churn does not bloat
        // the FTS index during long-running executor activity.
        this.db.exec(`
          CREATE TRIGGER IF NOT EXISTS tasks_fts_au AFTER UPDATE OF ${updateColumns} ON tasks BEGIN
            INSERT INTO tasks_fts(tasks_fts, rowid, id, title, description, comments)
              VALUES('delete', old.rowid, old.id, ${oldTitle}, old.description, COALESCE(old.comments, '[]'));
            INSERT INTO tasks_fts(rowid, id, title, description, comments)
              SELECT new.rowid, new.id, ${newTitle}, new.description, COALESCE(new.comments, '[]')
              WHERE ${hasDeletedAt ? "new.deletedAt IS NULL" : "1 = 1"};
          END
        `);

        // AFTER DELETE trigger - remove deleted tasks from index
        this.db.exec(`
          CREATE TRIGGER IF NOT EXISTS tasks_fts_ad AFTER DELETE ON tasks
          ${hasDeletedAt ? "WHEN OLD.deletedAt IS NULL " : ""}BEGIN
            INSERT INTO tasks_fts(tasks_fts, rowid, id, title, description, comments)
              VALUES('delete', old.rowid, old.id, COALESCE(old.title, ''), old.description, COALESCE(old.comments, '[]'));
          END
        `);
      });
    }

    // Chat sessions and messages tables for agent chat system
    if (version < 22) {
      this.applyMigration(22, () => {
        // Chat sessions table
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS chat_sessions (
            id TEXT PRIMARY KEY,
            agentId TEXT NOT NULL,
            title TEXT,
            status TEXT NOT NULL DEFAULT 'active',
            projectId TEXT,
            modelProvider TEXT,
            modelId TEXT,
            createdAt TEXT NOT NULL,
            updatedAt TEXT NOT NULL,
            inFlightGeneration TEXT
          )
        `);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idxChatSessionsAgentId ON chat_sessions(agentId)`);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idxChatSessionsProjectId ON chat_sessions(projectId)`);

        // Chat messages table
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS chat_messages (
            id TEXT PRIMARY KEY,
            sessionId TEXT NOT NULL,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            thinkingOutput TEXT,
            metadata TEXT,
            createdAt TEXT NOT NULL,
            FOREIGN KEY (sessionId) REFERENCES chat_sessions(id) ON DELETE CASCADE
          )
        `);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idxChatMessagesSessionId ON chat_messages(sessionId)`);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idxChatMessagesCreatedAt ON chat_messages(createdAt)`);
      });
    }

    if (version < 23) {
      this.applyMigration(23, () => {
        this.addColumnIfMissing("milestones", "planningNotes", "TEXT");
        this.addColumnIfMissing("milestones", "verification", "TEXT");
        this.addColumnIfMissing("slices", "planningNotes", "TEXT");
        this.addColumnIfMissing("slices", "verification", "TEXT");
        this.addColumnIfMissing("slices", "planState", "TEXT NOT NULL DEFAULT 'not_started'");
        this.addColumnIfMissing("mission_events", "seq", "INTEGER NOT NULL DEFAULT 0");
      });
    }

    if (version < 24) {
      this.applyMigration(24, () => {
        // Legacy project-local plugin table (introduced in v24) is retained for
        // one-shot migration reads by PluginStore.migrateLegacyProjectRows().
        // Post-FN-3722 all new plugin install writes must go to central
        // plugin_installs + project_plugin_states tables; writes here are a bug.
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS plugins (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            version TEXT NOT NULL,
            description TEXT,
            author TEXT,
            homepage TEXT,
            path TEXT NOT NULL,
            enabled INTEGER DEFAULT 1,
            state TEXT NOT NULL DEFAULT 'installed',
            settings TEXT DEFAULT '{}',
            settingsSchema TEXT,
            error TEXT,
            dependencies TEXT DEFAULT '[]',
            aiScanOnLoad INTEGER NOT NULL DEFAULT 0,
            lastSecurityScan TEXT,
            createdAt TEXT NOT NULL,
            updatedAt TEXT NOT NULL
          )
        `);
      });
    }

    if (version < 25) {
      this.applyMigration(25, () => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS runAuditEvents (
            id TEXT PRIMARY KEY,
            timestamp TEXT NOT NULL,
            taskId TEXT,
            agentId TEXT NOT NULL,
            runId TEXT NOT NULL,
            domain TEXT NOT NULL,
            mutationType TEXT NOT NULL,
            target TEXT NOT NULL,
            metadata TEXT
          )
        `);
        this.db.exec(`
          CREATE INDEX IF NOT EXISTS idxRunAuditEventsRunIdTimestamp
            ON runAuditEvents(runId, timestamp)
        `);
        this.db.exec(`
          CREATE INDEX IF NOT EXISTS idxRunAuditEventsTaskIdTimestamp
            ON runAuditEvents(taskId, timestamp)
        `);
        this.db.exec(`
          CREATE INDEX IF NOT EXISTS idxRunAuditEventsTimestamp
            ON runAuditEvents(timestamp)
        `);
      });
    }

    if (version < 26) {
      this.applyMigration(26, () => {
        this.addColumnIfMissing("tasks", "assigneeUserId", "TEXT");
        this.db.exec(`CREATE INDEX IF NOT EXISTS idxTasksAssigneeUserId ON tasks(assigneeUserId)`);
      });
    }

    if (version < 27) {
      this.applyMigration(27, () => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS routines (
            id TEXT PRIMARY KEY,
            agentId TEXT NOT NULL DEFAULT '',
            name TEXT NOT NULL,
            description TEXT,
            triggerType TEXT NOT NULL,
            triggerConfig TEXT NOT NULL,
            command TEXT,
            steps TEXT,
            timeoutMs INTEGER,
            catchUpPolicy TEXT NOT NULL DEFAULT 'run_one',
            executionPolicy TEXT NOT NULL DEFAULT 'queue',
            catchUpLimit INTEGER DEFAULT 5,
            enabled INTEGER DEFAULT 1,
            lastRunAt TEXT,
            lastRunResult TEXT,
            nextRunAt TEXT,
            runCount INTEGER DEFAULT 0,
            runHistory TEXT DEFAULT '[]',
            createdAt TEXT NOT NULL,
            updatedAt TEXT NOT NULL
          )
        `);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idxRoutinesNextRunAt ON routines(nextRunAt)`);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idxRoutinesEnabled ON routines(enabled)`);
      });
    }

    // Dashboard load performance indexes (FN-1532)
    // Added indexes to eliminate full table scans and temp B-tree sorts
    // in boot-critical query paths (listTasks, listActive, activityLog, agents)
    if (version < 28) {
      this.applyMigration(28, () => {
        // Index on tasks.createdAt to avoid temp B-tree sort for ORDER BY createdAt
        this.db.exec(`CREATE INDEX IF NOT EXISTS idxTasksCreatedAt ON tasks(createdAt)`);

        // Composite index on ai_sessions for status filter + updatedAt ordering
        // Covers: WHERE status IN (...) ORDER BY updatedAt DESC
        // Only create if the table exists (it was added in v9)
        if (this.hasTable("ai_sessions")) {
          this.db.exec(`CREATE INDEX IF NOT EXISTS idxAiSessionsStatusUpdatedAt ON ai_sessions(status, updatedAt DESC)`);
        }

        // Composite index on activityLog for taskId filter + timestamp ordering
        // Covers: WHERE taskId = ? ORDER BY timestamp DESC
        if (this.hasTable("activityLog")) {
          this.db.exec(`CREATE INDEX IF NOT EXISTS idxActivityLogTaskIdTimestamp ON activityLog(taskId, timestamp DESC)`);
          this.db.exec(`CREATE INDEX IF NOT EXISTS idxActivityLogTypeTimestamp ON activityLog(type, timestamp DESC)`);
        }

        // Composite index on agentHeartbeats for agentId filter + timestamp ordering
        // Covers: WHERE agentId = ? ORDER BY timestamp DESC
        // Only create if the table exists (it was added in v2)
        if (this.hasTable("agentHeartbeats")) {
          this.db.exec(`CREATE INDEX IF NOT EXISTS idxAgentHeartbeatsAgentIdTimestamp ON agentHeartbeats(agentId, timestamp DESC)`);
        }

        // Index on agents.state for state filtering
        // Covers: WHERE state = ?
        if (this.hasTable("agents")) {
          this.db.exec(`CREATE INDEX IF NOT EXISTS idxAgentsState ON agents(state)`);
        }
      });
    }

    // Mission contract assertions (FN-1567)
    // Adds explicit validation contract model for milestone behavioral assertions
    // with feature linkage tracking and validation state rollup.
    if (version < 29) {
      this.applyMigration(29, () => {
        // Add validationState column to milestones table
        this.addColumnIfMissing("milestones", "validationState", "TEXT NOT NULL DEFAULT 'not_started'");

        // Create mission_contract_assertions table for milestone validation contracts
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS mission_contract_assertions (
            id TEXT PRIMARY KEY,
            milestoneId TEXT NOT NULL,
            title TEXT NOT NULL,
            assertion TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            orderIndex INTEGER NOT NULL DEFAULT 0,
            createdAt TEXT NOT NULL,
            updatedAt TEXT NOT NULL,
            FOREIGN KEY (milestoneId) REFERENCES milestones(id) ON DELETE CASCADE
          )
        `);

        // Create mission_feature_assertions link table for many-to-many relationships
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS mission_feature_assertions (
            featureId TEXT NOT NULL,
            assertionId TEXT NOT NULL,
            createdAt TEXT NOT NULL,
            PRIMARY KEY (featureId, assertionId),
            FOREIGN KEY (featureId) REFERENCES mission_features(id) ON DELETE CASCADE,
            FOREIGN KEY (assertionId) REFERENCES mission_contract_assertions(id) ON DELETE CASCADE
          )
        `);

        // Index for deterministic ordering when listing assertions for a milestone
        // Covers: WHERE milestoneId = ? ORDER BY orderIndex ASC, createdAt ASC, id ASC
        this.db.exec(`CREATE INDEX IF NOT EXISTS idxContractAssertionsMilestoneOrder ON mission_contract_assertions(milestoneId, orderIndex, createdAt, id)`);

        // Index for finding all assertions linked to a feature
        // Covers: WHERE featureId = ? (from mission_feature_assertions)
        this.db.exec(`CREATE INDEX IF NOT EXISTS idxFeatureAssertionsFeatureId ON mission_feature_assertions(featureId)`);

        // Index for finding all features linked to an assertion
        // Covers: WHERE assertionId = ? (from mission_feature_assertions)
        this.db.exec(`CREATE INDEX IF NOT EXISTS idxFeatureAssertionsAssertionId ON mission_feature_assertions(assertionId)`);
      });
    }

    // Workflow step failure retry support (FN-1586)
    // Adds workflowStepRetries column to track retry attempts for workflow step hard failures
    if (version < 30) {
      this.applyMigration(30, () => {
        this.addColumnIfMissing("tasks", "workflowStepRetries", "INTEGER");
      });
    }

    // Loop state and validator run tables (FEAT-001)
    // Adds loop state tracking columns to mission_features for the execution loop:
    // implementationAttemptCount, validatorAttemptCount, lastValidatorRunId, lastValidatorStatus,
    // generatedFromFeatureId, generatedFromRunId, loopState
    if (version < 31) {
      this.applyMigration(31, () => {
        // Add loop state columns to mission_features
        this.addColumnIfMissing("mission_features", "loopState", "TEXT NOT NULL DEFAULT 'idle'");
        this.addColumnIfMissing("mission_features", "implementationAttemptCount", "INTEGER NOT NULL DEFAULT 0");
        this.addColumnIfMissing("mission_features", "validatorAttemptCount", "INTEGER NOT NULL DEFAULT 0");
        this.addColumnIfMissing("mission_features", "lastValidatorRunId", "TEXT");
        this.addColumnIfMissing("mission_features", "lastValidatorStatus", "TEXT");
        this.addColumnIfMissing("mission_features", "generatedFromFeatureId", "TEXT");
        this.addColumnIfMissing("mission_features", "generatedFromRunId", "TEXT");

        // Create mission_validator_runs table for tracking validation runs
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS mission_validator_runs (
            id TEXT PRIMARY KEY,
            featureId TEXT NOT NULL,
            milestoneId TEXT NOT NULL,
            sliceId TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'running',
            triggerType TEXT NOT NULL DEFAULT 'auto',
            implementationAttempt INTEGER NOT NULL DEFAULT 0,
            validatorAttempt INTEGER NOT NULL DEFAULT 0,
            summary TEXT,
            blockedReason TEXT,
            startedAt TEXT NOT NULL,
            completedAt TEXT,
            createdAt TEXT NOT NULL,
            updatedAt TEXT NOT NULL,
            FOREIGN KEY (featureId) REFERENCES mission_features(id) ON DELETE CASCADE,
            FOREIGN KEY (milestoneId) REFERENCES milestones(id) ON DELETE CASCADE,
            FOREIGN KEY (sliceId) REFERENCES slices(id) ON DELETE CASCADE
          )
        `);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idxValidatorRunsFeatureId ON mission_validator_runs(featureId)`);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idxValidatorRunsMilestoneId ON mission_validator_runs(milestoneId)`);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idxValidatorRunsSliceId ON mission_validator_runs(sliceId)`);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idxValidatorRunsStatus ON mission_validator_runs(status)`);

        // Ensure triggerType column has correct definition for existing databases
        // (migration originally created it as nullable TEXT, this adds NOT NULL DEFAULT 'auto')
        this.addColumnIfMissing("mission_validator_runs", "triggerType", "TEXT NOT NULL DEFAULT 'auto'");

        // Create mission_validator_failures table for assertion failure records
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS mission_validator_failures (
            id TEXT PRIMARY KEY,
            runId TEXT NOT NULL,
            featureId TEXT NOT NULL,
            assertionId TEXT NOT NULL,
            message TEXT,
            expected TEXT,
            actual TEXT,
            createdAt TEXT NOT NULL,
            FOREIGN KEY (runId) REFERENCES mission_validator_runs(id) ON DELETE CASCADE,
            FOREIGN KEY (featureId) REFERENCES mission_features(id) ON DELETE CASCADE
          )
        `);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idxValidatorFailuresRunId ON mission_validator_failures(runId)`);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idxValidatorFailuresFeatureId ON mission_validator_failures(featureId)`);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idxValidatorFailuresAssertionId ON mission_validator_failures(assertionId)`);

        // Create mission_fix_feature_lineage table for tracking fix feature relationships
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS mission_fix_feature_lineage (
            id TEXT PRIMARY KEY,
            sourceFeatureId TEXT NOT NULL,
            fixFeatureId TEXT NOT NULL,
            runId TEXT NOT NULL,
            failedAssertionIds TEXT NOT NULL DEFAULT '[]',
            createdAt TEXT NOT NULL,
            FOREIGN KEY (sourceFeatureId) REFERENCES mission_features(id) ON DELETE CASCADE,
            FOREIGN KEY (fixFeatureId) REFERENCES mission_features(id) ON DELETE CASCADE,
            FOREIGN KEY (runId) REFERENCES mission_validator_runs(id) ON DELETE CASCADE
          )
        `);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idxFixLineageSourceFeatureId ON mission_fix_feature_lineage(sourceFeatureId)`);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idxFixLineageFixFeatureId ON mission_fix_feature_lineage(fixFeatureId)`);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idxFixLineageRunId ON mission_fix_feature_lineage(runId)`);
      });
    }

    // Insight persistence tables (FN-1877)
    // Normalized insight entities and insight-generation run records
    if (version < 33) {
      this.applyMigration(33, () => {
        // project_insights: normalized insight entities
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS project_insights (
            id TEXT PRIMARY KEY,
            projectId TEXT NOT NULL,
            title TEXT NOT NULL,
            content TEXT,
            category TEXT NOT NULL,
            status TEXT NOT NULL,
            fingerprint TEXT NOT NULL,
            provenance TEXT,
            lastRunId TEXT,
            createdAt TEXT NOT NULL,
            updatedAt TEXT NOT NULL
          )
        `);

        // project_insight_runs: insight-generation run records
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS project_insight_runs (
            id TEXT PRIMARY KEY,
            projectId TEXT NOT NULL,
            trigger TEXT NOT NULL,
            status TEXT NOT NULL,
            summary TEXT,
            error TEXT,
            insightsCreated INTEGER NOT NULL DEFAULT 0,
            insightsUpdated INTEGER NOT NULL DEFAULT 0,
            inputMetadata TEXT,
            outputMetadata TEXT,
            lifecycle TEXT,
            createdAt TEXT NOT NULL,
            startedAt TEXT,
            completedAt TEXT,
            cancelledAt TEXT
          )
        `);

        // Index for filtering insights by projectId
        this.db.exec(`
          CREATE INDEX IF NOT EXISTS idxProjectInsightsProjectId
            ON project_insights(projectId)
        `);

        // Index for fingerprint-based upsert dedupe
        this.db.exec(`
          CREATE INDEX IF NOT EXISTS idxProjectInsightsFingerprint
            ON project_insights(projectId, fingerprint)
        `);

        // Index for filtering insights by category
        this.db.exec(`
          CREATE INDEX IF NOT EXISTS idxProjectInsightsCategory
            ON project_insights(category)
        `);

        // Index for filtering runs by projectId
        this.db.exec(`
          CREATE INDEX IF NOT EXISTS idxInsightRunsProjectId
            ON project_insight_runs(projectId)
        `);
      });
    }

    // Scope columns for automations and routines (FN-1714)
    // Enables dual-lane execution: global scope (shared) and project scope (isolated)
    if (version < 34) {
      this.applyMigration(34, () => {
        // Add scope column to automations table
        this.addColumnIfMissing("automations", "scope", "TEXT DEFAULT 'project'");
        this.db.exec(`CREATE INDEX IF NOT EXISTS idxAutomationsScope ON automations(scope)`);

        // Add scope column to routines table
        this.addColumnIfMissing("routines", "scope", "TEXT DEFAULT 'project'");
        this.db.exec(`CREATE INDEX IF NOT EXISTS idxRoutinesScope ON routines(scope)`);
      });
    }

    // Restrict task full-text-search maintenance to searchable fields only.
    // Agent/activity logs live in tasks.log and are intentionally not searchable;
    // log-only executor updates should not churn or bloat the FTS index.
    if (version < 35) {
      this.applyMigration(35, () => {
        if (!this._fts5Available) {
          // tasks_fts does not exist when FTS5 is unavailable; nothing to
          // rebuild or re-trigger.
          return;
        }
        const hasTaskTitle = this.hasColumn("tasks", "title");
        const hasDeletedAt = this.hasColumn("tasks", "deletedAt");
        const updateColumns = hasTaskTitle
          ? hasDeletedAt ? "id, title, description, comments, deletedAt" : "id, title, description, comments"
          : hasDeletedAt ? "id, description, comments, deletedAt" : "id, description, comments";
        const oldTitle = hasTaskTitle ? "COALESCE(old.title, '')" : "''";
        const newTitle = hasTaskTitle ? "COALESCE(new.title, '')" : "''";

        this.db.exec(`
          DROP TRIGGER IF EXISTS tasks_fts_au;
          CREATE TRIGGER tasks_fts_au AFTER UPDATE OF ${updateColumns} ON tasks BEGIN
            INSERT INTO tasks_fts(tasks_fts, rowid, id, title, description, comments)
              VALUES('delete', old.rowid, old.id, ${oldTitle}, old.description, COALESCE(old.comments, '[]'));
            INSERT INTO tasks_fts(rowid, id, title, description, comments)
              SELECT new.rowid, new.id, ${newTitle}, new.description, COALESCE(new.comments, '[]')
              WHERE ${hasDeletedAt ? "new.deletedAt IS NULL" : "1 = 1"};
          END;
        `);

        if (hasTaskTitle) {
          this.db.exec("INSERT INTO tasks_fts(tasks_fts) VALUES('rebuild')");
        }
      });
    }

    if (version < 36) {
      this.applyMigration(36, () => {
        this.addColumnIfMissing("routines", "command", "TEXT");
        this.addColumnIfMissing("routines", "steps", "TEXT");
        this.addColumnIfMissing("routines", "timeoutMs", "INTEGER");
      });
    }

    if (version < 37) {
      this.applyMigration(37, () => {
        this.addColumnIfMissing("mission_validator_runs", "taskId", "TEXT");
      });
    }

    if (version < 38) {
      // Tracks self-healing auto-revivals of in-review tasks whose pre-merge
      // workflow steps failed. Bounded by settings.maxPostReviewFixes so a
      // persistently-failing verifier cannot ping-pong a task forever.
      this.applyMigration(38, () => {
        this.addColumnIfMissing("tasks", "postReviewFixCount", "INTEGER DEFAULT 0");
      });
    }

    if (version < 39) {
      this.applyMigration(39, () => {
        this.addColumnIfMissing("agents", "data", "TEXT DEFAULT '{}'");
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS agentRuns (
            id TEXT PRIMARY KEY,
            agentId TEXT NOT NULL,
            data TEXT NOT NULL,
            startedAt TEXT NOT NULL,
            endedAt TEXT,
            status TEXT NOT NULL,
            FOREIGN KEY (agentId) REFERENCES agents(id) ON DELETE CASCADE
          )
        `);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idxAgentRunsAgentIdStartedAt ON agentRuns(agentId, startedAt)`);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idxAgentRunsStatus ON agentRuns(status)`);
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS agentTaskSessions (
            agentId TEXT NOT NULL,
            taskId TEXT NOT NULL,
            data TEXT NOT NULL,
            createdAt TEXT NOT NULL,
            updatedAt TEXT NOT NULL,
            PRIMARY KEY (agentId, taskId),
            FOREIGN KEY (agentId) REFERENCES agents(id) ON DELETE CASCADE
          )
        `);
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS agentApiKeys (
            id TEXT PRIMARY KEY,
            agentId TEXT NOT NULL,
            data TEXT NOT NULL,
            createdAt TEXT NOT NULL,
            revokedAt TEXT,
            FOREIGN KEY (agentId) REFERENCES agents(id) ON DELETE CASCADE
          )
        `);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idxAgentApiKeysAgentId ON agentApiKeys(agentId)`);
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS agentConfigRevisions (
            id TEXT PRIMARY KEY,
            agentId TEXT NOT NULL,
            data TEXT NOT NULL,
            createdAt TEXT NOT NULL,
            FOREIGN KEY (agentId) REFERENCES agents(id) ON DELETE CASCADE
          )
        `);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idxAgentConfigRevisionsAgentIdCreatedAt ON agentConfigRevisions(agentId, createdAt)`);
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS agentBlockedStates (
            agentId TEXT PRIMARY KEY,
            data TEXT NOT NULL,
            updatedAt TEXT NOT NULL,
            FOREIGN KEY (agentId) REFERENCES agents(id) ON DELETE CASCADE
          )
        `);
      });
    }

    if (version < 40) {
      this.applyMigration(40, () => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS agentLogEntries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            taskId TEXT NOT NULL,
            timestamp TEXT NOT NULL,
            text TEXT NOT NULL,
            type TEXT NOT NULL,
            detail TEXT,
            agent TEXT,
            FOREIGN KEY (taskId) REFERENCES tasks(id) ON DELETE CASCADE
          )
        `);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idxAgentLogEntriesTaskIdTimestamp ON agentLogEntries(taskId, timestamp)`);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idxAgentLogEntriesTaskIdType ON agentLogEntries(taskId, type)`);
      });
    }

    if (version < 41) {
      // Tracks self-healing auto-requeues of tasks that failed because the agent
      // exited without calling task_done with partial step progress. Bounded so
      // a persistently-broken task cannot loop forever.
      this.applyMigration(41, () => {
        this.addColumnIfMissing("tasks", "taskDoneRetryCount", "INTEGER DEFAULT 0");
      });
    }

    // Task execution mode contract (FN-2246)
    // Adds executionMode column to tasks table with default 'standard'.
    // Normalizes null/empty legacy values to 'standard'.
    if (version < 42) {
      this.applyMigration(42, () => {
        this.addColumnIfMissing("tasks", "executionMode", "TEXT DEFAULT 'standard'");
        // Normalize any existing null/empty executionMode values to 'standard'
        this.db.exec(`
          UPDATE tasks
          SET executionMode = 'standard'
          WHERE executionMode IS NULL OR executionMode = '' OR executionMode NOT IN ('standard', 'fast')
        `);
      });
    }

    // Task priority contract (FN-2383)
    // Adds priority column and normalizes legacy/missing values to 'normal'.
    if (version < 43) {
      this.applyMigration(43, () => {
        this.addColumnIfMissing("tasks", "priority", "TEXT DEFAULT 'normal'");
        this.db.exec(`
          UPDATE tasks
          SET priority = 'normal'
          WHERE priority IS NULL OR priority = '' OR priority NOT IN ('low', 'normal', 'high', 'urgent')
        `);
      });
    }

    // Task-level token usage aggregate contract (FN-2456)
    // Persists durable token totals and first/last usage timestamps on each task row.
    // Existing rows are left null-compatible so legacy tasks deserialize without
    // synthesizing usage data.
    if (version < 44) {
      this.applyMigration(44, () => {
        this.addColumnIfMissing("tasks", "tokenUsageInputTokens", "INTEGER");
        this.addColumnIfMissing("tasks", "tokenUsageOutputTokens", "INTEGER");
        this.addColumnIfMissing("tasks", "tokenUsageCachedTokens", "INTEGER");
        this.addColumnIfMissing("tasks", "tokenUsageTotalTokens", "INTEGER");
        this.addColumnIfMissing("tasks", "tokenUsageFirstUsedAt", "TEXT");
        this.addColumnIfMissing("tasks", "tokenUsageLastUsedAt", "TEXT");
      });
    }

    // Source issue provenance contract (FN-2471)
    // Persists durable source identity for imported issues separately from
    // transient/live issueInfo status snapshots.
    if (version < 45) {
      this.applyMigration(45, () => {
        this.addColumnIfMissing("tasks", "sourceIssueProvider", "TEXT");
        this.addColumnIfMissing("tasks", "sourceIssueRepository", "TEXT");
        this.addColumnIfMissing("tasks", "sourceIssueExternalIssueId", "TEXT");
        this.addColumnIfMissing("tasks", "sourceIssueNumber", "INTEGER");
        this.addColumnIfMissing("tasks", "sourceIssueUrl", "TEXT");
      });
    }

    if (version < 46) {
      this.applyMigration(46, () => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS todo_lists (
            id TEXT PRIMARY KEY,
            projectId TEXT NOT NULL,
            title TEXT NOT NULL,
            createdAt TEXT NOT NULL,
            updatedAt TEXT NOT NULL
          )
        `);

        this.db.exec(`
          CREATE TABLE IF NOT EXISTS todo_items (
            id TEXT PRIMARY KEY,
            listId TEXT NOT NULL,
            text TEXT NOT NULL,
            completed INTEGER NOT NULL DEFAULT 0,
            completedAt TEXT,
            sortOrder INTEGER NOT NULL DEFAULT 0,
            createdAt TEXT NOT NULL,
            updatedAt TEXT NOT NULL,
            FOREIGN KEY (listId) REFERENCES todo_lists(id) ON DELETE CASCADE
          )
        `);

        this.db.exec("CREATE INDEX IF NOT EXISTS idxTodoListsProjectId ON todo_lists(projectId)");
        this.db.exec("CREATE INDEX IF NOT EXISTS idxTodoItemsListId ON todo_items(listId)");
        this.db.exec("CREATE INDEX IF NOT EXISTS idxTodoItemsSortOrder ON todo_items(listId, sortOrder)");
      });
    }

    // Status value rename (FN-2602)
    // Rename stored status strings: specifying→planning, needs-respecify→needs-replan
    if (version < 47) {
      this.applyMigration(47, () => {
        if (this.hasTable("tasks") && this.hasColumn("tasks", "status")) {
          this.db.exec("UPDATE tasks SET status = 'planning' WHERE status = 'specifying'");
          this.db.exec("UPDATE tasks SET status = 'needs-replan' WHERE status = 'needs-respecify'");
        }
      });
    }

    // Outer verification-failure bounce counter — counts in-review→in-progress
    // returns triggered by VerificationError. Capped to prevent infinite
    // re-merge loops on flaky tests (see project-engine.ts auto-merge handler).
    if (version < 48) {
      this.applyMigration(48, () => {
        this.addColumnIfMissing("tasks", "verificationFailureCount", "INTEGER DEFAULT 0");
      });
    }

    // Per-task node override for remote/local execution routing selection.
    if (version < 49) {
      this.applyMigration(49, () => {
        this.addColumnIfMissing("tasks", "nodeId", "TEXT");
      });
    }

    // Resolved effective node fields for task routing (FN-2854).
    // effectiveNodeId is the scheduler-resolved target; effectiveNodeSource explains how it was chosen.
    if (version < 50) {
      this.applyMigration(50, () => {
        this.addColumnIfMissing("tasks", "effectiveNodeId", "TEXT");
        this.addColumnIfMissing("tasks", "effectiveNodeSource", "TEXT");
      });
    }

    if (version < 51) {
      this.applyMigration(51, () => {
        if (this.hasTable("chat_messages")) {
          this.addColumnIfMissing("chat_messages", "attachments", "TEXT");
        }
      });
    }

    // Outer auto-merge bounce counter so the cooldown sweep can't loop forever
    // on a task whose conflicts can't be auto-resolved. Capped by
    // MAX_MERGE_CONFLICT_BOUNCES in project-engine.ts; once reached, the task
    // is parked in in-review with status="failed" and a follow-up is created.
    if (version < 52) {
      this.applyMigration(52, () => {
        this.addColumnIfMissing("tasks", "mergeConflictBounceCount", "INTEGER DEFAULT 0");
      });
    }


    // Task provenance/source tracking columns (FN-2917).
    if (version < 53) {
      this.applyMigration(53, () => {
        this.addColumnIfMissing("tasks", "sourceType", "TEXT");
        this.addColumnIfMissing("tasks", "sourceAgentId", "TEXT");
        this.addColumnIfMissing("tasks", "sourceRunId", "TEXT");
        this.addColumnIfMissing("tasks", "sourceSessionId", "TEXT");
        this.addColumnIfMissing("tasks", "sourceMessageId", "TEXT");
        this.addColumnIfMissing("tasks", "sourceParentTaskId", "TEXT");
        this.addColumnIfMissing("tasks", "sourceMetadata", "TEXT");
        this.db.prepare(
          `UPDATE tasks SET sourceType = 'unknown' WHERE sourceType IS NULL`
        ).run();
      });
    }

    // Wall-clock end-to-end execution timestamps for card runtime display.
    // Set on first in-progress / done transitions, cleared only on retry.
    if (version < 54) {
      this.applyMigration(54, () => {
        this.addColumnIfMissing("tasks", "executionStartedAt", "TEXT");
        this.addColumnIfMissing("tasks", "executionCompletedAt", "TEXT");
      });
    }

    // Research runs + exports persistence tables (FN-2991).
    if (version < 55) {
      this.applyMigration(55, () => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS research_runs (
            id TEXT PRIMARY KEY,
            query TEXT NOT NULL,
            topic TEXT,
            status TEXT NOT NULL,
            projectId TEXT,
            trigger TEXT,
            providerConfig TEXT,
            sources TEXT NOT NULL DEFAULT '[]',
            events TEXT NOT NULL DEFAULT '[]',
            results TEXT,
            error TEXT,
            tokenUsage TEXT,
            tags TEXT NOT NULL DEFAULT '[]',
            metadata TEXT,
            lifecycle TEXT,
            createdAt TEXT NOT NULL,
            updatedAt TEXT NOT NULL,
            startedAt TEXT,
            completedAt TEXT,
            cancelledAt TEXT
          )
        `);

        this.db.exec(`CREATE INDEX IF NOT EXISTS idxResearchRunsStatus ON research_runs(status)`);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idxResearchRunsCreatedAt ON research_runs(createdAt)`);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idxResearchRunsUpdatedAt ON research_runs(updatedAt)`);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idxResearchRunsProjectTriggerStatus ON research_runs(projectId, trigger, status)`);

        this.db.exec(`
          CREATE TABLE IF NOT EXISTS research_exports (
            id TEXT PRIMARY KEY,
            runId TEXT NOT NULL,
            format TEXT NOT NULL,
            content TEXT NOT NULL,
            filePath TEXT,
            createdAt TEXT NOT NULL,
            FOREIGN KEY (runId) REFERENCES research_runs(id) ON DELETE CASCADE
          )
        `);

        this.db.exec(`CREATE INDEX IF NOT EXISTS idxResearchExportsRunId ON research_exports(runId)`);
      });
    }

    // Persist the pi/Claude CLI session file path per chat so quick-chat
    // turns reuse the same on-disk session instead of starting fresh each
    // user message.
    if (version < 56) {
      this.applyMigration(56, () => {
        if (this.hasTable("chat_sessions")) {
          this.addColumnIfMissing("chat_sessions", "cliSessionFile", "TEXT");
        }
      });
    }

    // Allow users to archive completed/errored AI sessions out of the
    // planning sidebar without deleting them. Cleanup still removes them
    // after the configured TTL; archive is purely for hiding.
    if (version < 57) {
      this.applyMigration(57, () => {
        if (this.hasTable("ai_sessions")) {
          this.addColumnIfMissing("ai_sessions", "archived", "INTEGER DEFAULT 0");
          this.db.exec(
            "CREATE INDEX IF NOT EXISTS idxAiSessionsArchived ON ai_sessions(archived)",
          );
        }
      });
    }

    // Rewrite legacy backup automation/routine commands that bake in a
    // bare `fn` or `kb` binary. Those fail with "command not found" on
    // hosts where the global bin was never linked. The canonical form
    // (kept in sync with backup.ts) uses npx so it works zero-install.
    if (version < 58) {
      this.applyMigration(58, () => {
        const newCommand = "npx runfusion.ai backup --create";
        if (this.hasTable("automations") && this.hasColumn("automations", "command")) {
          this.db
            .prepare(
              `UPDATE automations
                  SET command = ?, updatedAt = ?
                WHERE name = 'Database Backup'
                  AND (command LIKE 'fn backup%' OR command LIKE 'kb backup%' OR command LIKE 'fusion backup%')`,
            )
            .run(newCommand, new Date().toISOString());
        }
        if (this.hasTable("routines") && this.hasColumn("routines", "command")) {
          this.db
            .prepare(
              `UPDATE routines
                  SET command = ?, updatedAt = ?
                WHERE name = 'Database Backup'
                  AND (command LIKE 'fn backup%' OR command LIKE 'kb backup%' OR command LIKE 'fusion backup%')`,
            )
            .run(newCommand, new Date().toISOString());
        }
      });
    }

    // Dashboard load performance for projects with 100+ tasks.
    // listTasks() filters by "column" and the SSE/refresh paths sort by
    // updatedAt; neither column had an index, so each board load did a
    // full table scan + temp B-tree sort.
    if (version < 59) {
      this.applyMigration(59, () => {
        this.db.exec(`CREATE INDEX IF NOT EXISTS idxTasksColumn ON tasks("column")`);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idxTasksUpdatedAt ON tasks(updatedAt DESC)`);

        if (this.hasTable("research_runs")) {
          this.addColumnIfMissing("research_runs", "projectId", "TEXT");
          this.addColumnIfMissing("research_runs", "trigger", "TEXT");
          this.addColumnIfMissing("research_runs", "lifecycle", "TEXT");
          this.db.exec(`CREATE INDEX IF NOT EXISTS idxResearchRunsProjectTriggerStatus ON research_runs(projectId, trigger, status)`);
        }

        this.db.exec(`
          CREATE TABLE IF NOT EXISTS research_run_events (
            id TEXT PRIMARY KEY,
            runId TEXT NOT NULL,
            seq INTEGER NOT NULL,
            type TEXT NOT NULL,
            message TEXT NOT NULL,
            status TEXT,
            classification TEXT,
            metadata TEXT,
            createdAt TEXT NOT NULL,
            FOREIGN KEY (runId) REFERENCES research_runs(id) ON DELETE CASCADE
          )
        `);
        if (this.hasTable("research_run_events")) {
          this.addColumnIfMissing("research_run_events", "seq", "INTEGER NOT NULL DEFAULT 0");
        }
        this.db.exec(`CREATE INDEX IF NOT EXISTS idxResearchRunEventsRunIdSeq ON research_run_events(runId, seq)`);

        if (this.hasTable("project_insight_runs")) {
          this.addColumnIfMissing("project_insight_runs", "lifecycle", "TEXT");
          this.addColumnIfMissing("project_insight_runs", "cancelledAt", "TEXT");
          this.db.exec(`CREATE INDEX IF NOT EXISTS idxInsightRunsProjectTriggerStatus ON project_insight_runs(projectId, trigger, status)`);
        }

        this.db.exec(`
          CREATE TABLE IF NOT EXISTS project_insight_run_events (
            id TEXT PRIMARY KEY,
            runId TEXT NOT NULL,
            seq INTEGER NOT NULL,
            type TEXT NOT NULL,
            message TEXT NOT NULL,
            status TEXT,
            classification TEXT,
            metadata TEXT,
            createdAt TEXT NOT NULL,
            FOREIGN KEY (runId) REFERENCES project_insight_runs(id) ON DELETE CASCADE
          )
        `);
        if (this.hasTable("project_insight_run_events")) {
          this.addColumnIfMissing("project_insight_run_events", "seq", "INTEGER NOT NULL DEFAULT 0");
        }
        this.db.exec(`CREATE INDEX IF NOT EXISTS idxInsightRunEventsRunIdSeq ON project_insight_run_events(runId, seq)`);
      });
    }

    if (version < 60) {
      this.applyMigration(60, () => {
        this.addColumnIfMissing("tasks", "pausedByAgentId", "TEXT");
        this.db.exec(`CREATE INDEX IF NOT EXISTS idxTasksPausedByAgentId ON tasks(pausedByAgentId)`);
      });
    }

    if (version < 61) {
      this.applyMigration(61, () => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS verification_cache (
            treeSha TEXT NOT NULL,
            testCommand TEXT NOT NULL DEFAULT '',
            buildCommand TEXT NOT NULL DEFAULT '',
            recordedAt TEXT NOT NULL,
            taskId TEXT,
            PRIMARY KEY (treeSha, testCommand, buildCommand)
          )
        `);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idxVerificationCacheRecordedAt ON verification_cache(recordedAt)`);
      });
    }

    if (version < 62) {
      this.applyMigration(62, () => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS eval_runs (
            id TEXT PRIMARY KEY,
            projectId TEXT NOT NULL,
            status TEXT NOT NULL,
            trigger TEXT NOT NULL,
            scope TEXT NOT NULL,
            window TEXT NOT NULL DEFAULT '{}',
            requestedTaskIds TEXT NOT NULL DEFAULT '[]',
            evaluatedTaskIds TEXT NOT NULL DEFAULT '[]',
            counts TEXT NOT NULL DEFAULT '{"totalTasks":0,"scoredTasks":0,"skippedTasks":0,"erroredTasks":0}',
            aggregateScores TEXT,
            summary TEXT,
            error TEXT,
            provenance TEXT,
            metadata TEXT,
            createdAt TEXT NOT NULL,
            updatedAt TEXT NOT NULL,
            startedAt TEXT,
            completedAt TEXT,
            cancelledAt TEXT
          )
        `);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idxEvalRunsProjectIdCreatedAt ON eval_runs(projectId, createdAt)`);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idxEvalRunsProjectTriggerStatus ON eval_runs(projectId, trigger, status)`);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idxEvalRunsStatusCreatedAt ON eval_runs(status, createdAt)`);

        this.db.exec(`
          CREATE TABLE IF NOT EXISTS eval_task_results (
            id TEXT PRIMARY KEY,
            runId TEXT NOT NULL,
            taskId TEXT NOT NULL,
            taskSnapshot TEXT NOT NULL,
            status TEXT NOT NULL,
            overallScore REAL,
            maxScore REAL,
            categoryScores TEXT NOT NULL DEFAULT '[]',
            rationale TEXT,
            summary TEXT,
            evidence TEXT NOT NULL DEFAULT '[]',
            deterministicSignals TEXT NOT NULL DEFAULT '[]',
            aiSignals TEXT,
            followUps TEXT NOT NULL DEFAULT '[]',
            provenance TEXT,
            metadata TEXT,
            createdAt TEXT NOT NULL,
            updatedAt TEXT NOT NULL,
            FOREIGN KEY (runId) REFERENCES eval_runs(id) ON DELETE CASCADE
          )
        `);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idxEvalTaskResultsRunIdCreatedAt ON eval_task_results(runId, createdAt)`);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idxEvalTaskResultsTaskIdCreatedAt ON eval_task_results(taskId, createdAt)`);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idxEvalTaskResultsStatusRunId ON eval_task_results(status, runId)`);
        this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idxEvalTaskResultsRunTaskUnique ON eval_task_results(runId, taskId)`);

        this.db.exec(`
          CREATE TABLE IF NOT EXISTS eval_run_events (
            id TEXT PRIMARY KEY,
            runId TEXT NOT NULL,
            seq INTEGER NOT NULL,
            type TEXT NOT NULL,
            message TEXT NOT NULL,
            status TEXT,
            taskId TEXT,
            metadata TEXT,
            createdAt TEXT NOT NULL,
            FOREIGN KEY (runId) REFERENCES eval_runs(id) ON DELETE CASCADE
          )
        `);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idxEvalRunEventsRunIdSeq ON eval_run_events(runId, seq)`);
      });
    }

    if (version < 64) {
      this.applyMigration(64, () => {
        this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idxEvalTaskResultsRunTaskUnique ON eval_task_results(runId, taskId)`);
      });
    }

    if (version < 65) {
      this.applyMigration(65, () => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS distributed_task_id_state (
            prefix TEXT PRIMARY KEY,
            nextSequence INTEGER NOT NULL,
            committedClusterTaskCount INTEGER NOT NULL,
            lastCommittedTaskId TEXT,
            updatedAt TEXT NOT NULL
          )
        `);
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS distributed_task_id_reservations (
            reservationId TEXT PRIMARY KEY,
            prefix TEXT NOT NULL,
            nodeId TEXT NOT NULL,
            sequence INTEGER NOT NULL,
            taskId TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('reserved', 'committed', 'aborted', 'expired')),
            reason TEXT CHECK (reason IS NULL OR reason IN ('abort', 'expired', 'failed-create')),
            expiresAt TEXT NOT NULL,
            committedAt TEXT,
            abortedAt TEXT,
            createdAt TEXT NOT NULL,
            updatedAt TEXT NOT NULL,
            FOREIGN KEY (prefix) REFERENCES distributed_task_id_state(prefix) ON DELETE CASCADE,
            UNIQUE(prefix, sequence),
            UNIQUE(prefix, taskId)
          )
        `);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idxDistributedTaskIdReservationsPrefixStatus ON distributed_task_id_reservations(prefix, status)`);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idxDistributedTaskIdReservationsExpiry ON distributed_task_id_reservations(status, expiresAt)`);
      });
    }

    if (version < 66) {
      this.applyMigration(66, () => {
        this.addColumnIfMissing("plugins", "aiScanOnLoad", "INTEGER NOT NULL DEFAULT 0");
        this.addColumnIfMissing("plugins", "lastSecurityScan", "TEXT");
      });
    }

    if (version < 67) {
      // Drop the project_auth_* tables introduced by the old migration 63
      // (FN-3544). The pluggable project-auth feature was removed before any
      // production usage; these tables are orphaned on DBs that ran the old
      // migration. Drop sessions/providers/memberships before users so the
      // foreign-key cascade order is honored.
      this.applyMigration(67, () => {
        this.db.exec(`DROP TABLE IF EXISTS project_auth_sessions`);
        this.db.exec(`DROP TABLE IF EXISTS project_auth_providers`);
        this.db.exec(`DROP TABLE IF EXISTS project_auth_memberships`);
        this.db.exec(`DROP TABLE IF EXISTS project_auth_users`);
      });
    }

    if (version < 68) {
      this.applyMigration(68, () => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS approval_requests (
            id TEXT PRIMARY KEY,
            status TEXT NOT NULL,
            requesterActorId TEXT NOT NULL,
            requesterActorType TEXT NOT NULL,
            requesterActorName TEXT NOT NULL,
            targetActionCategory TEXT NOT NULL,
            targetActionOperation TEXT NOT NULL,
            targetActionSummary TEXT NOT NULL,
            targetResourceType TEXT NOT NULL,
            targetResourceId TEXT NOT NULL,
            targetContext TEXT,
            taskId TEXT,
            runId TEXT,
            requestedAt TEXT NOT NULL,
            decidedAt TEXT,
            completedAt TEXT,
            createdAt TEXT NOT NULL,
            updatedAt TEXT NOT NULL
          )
        `);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idxApprovalRequestsStatusCreatedAt ON approval_requests(status, createdAt)`);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idxApprovalRequestsRequesterCreatedAt ON approval_requests(requesterActorId, createdAt)`);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idxApprovalRequestsTaskCreatedAt ON approval_requests(taskId, createdAt)`);

        this.db.exec(`
          CREATE TABLE IF NOT EXISTS approval_request_audit_events (
            id TEXT PRIMARY KEY,
            requestId TEXT NOT NULL,
            eventType TEXT NOT NULL,
            actorId TEXT NOT NULL,
            actorType TEXT NOT NULL,
            actorName TEXT NOT NULL,
            note TEXT,
            createdAt TEXT NOT NULL,
            FOREIGN KEY (requestId) REFERENCES approval_requests(id) ON DELETE CASCADE
          )
        `);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idxApprovalRequestAuditRequestCreatedAt ON approval_request_audit_events(requestId, createdAt, id)`);
      });
    }

    if (version < 69) {
      this.applyMigration(69, () => {
        this.addColumnIfMissing("tasks", "reviewState", "TEXT");
      });
    }

    if (version < 70) {
      this.applyMigration(70, () => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS chat_rooms (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            slug TEXT NOT NULL,
            description TEXT,
            projectId TEXT,
            createdBy TEXT,
            status TEXT NOT NULL DEFAULT 'active',
            createdAt TEXT NOT NULL,
            updatedAt TEXT NOT NULL
          )
        `);
        this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idxChatRoomsSlug ON chat_rooms(projectId, slug)`);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idxChatRoomsProjectId ON chat_rooms(projectId)`);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idxChatRoomsStatus ON chat_rooms(status)`);

        this.db.exec(`
          CREATE TABLE IF NOT EXISTS chat_room_members (
            roomId TEXT NOT NULL,
            agentId TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'member',
            addedAt TEXT NOT NULL,
            PRIMARY KEY (roomId, agentId),
            FOREIGN KEY (roomId) REFERENCES chat_rooms(id) ON DELETE CASCADE
          )
        `);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idxChatRoomMembersAgentId ON chat_room_members(agentId)`);

        this.db.exec(`
          CREATE TABLE IF NOT EXISTS chat_room_messages (
            id TEXT PRIMARY KEY,
            roomId TEXT NOT NULL,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            thinkingOutput TEXT,
            metadata TEXT,
            attachments TEXT,
            senderAgentId TEXT,
            mentions TEXT,
            createdAt TEXT NOT NULL,
            FOREIGN KEY (roomId) REFERENCES chat_rooms(id) ON DELETE CASCADE
          )
        `);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idxChatRoomMessagesRoomCreatedAt ON chat_room_messages(roomId, createdAt)`);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idxChatRoomMessagesRoomId ON chat_room_messages(roomId)`);
      });
    }

    if (version < 71) {
      this.applyMigration(71, () => {
        this.addColumnIfMissing("tasks", "githubTracking", "TEXT");
      });
    }

    if (version < 72) {
      this.applyMigration(72, () => {
        this.addColumnIfMissing("tasks", "lineageId", "TEXT");
        this.db.exec(`CREATE INDEX IF NOT EXISTS idxTasksLineageId ON tasks(lineageId)`);
        const missing = this.db.prepare("SELECT id FROM tasks WHERE lineageId IS NULL OR trim(lineageId) = ''").all() as Array<{ id: string }>;
        const updateLineage = this.db.prepare("UPDATE tasks SET lineageId = ? WHERE id = ?");
        for (const row of missing) {
          updateLineage.run(randomUUID(), row.id);
        }

        this.db.exec(`
          CREATE TABLE IF NOT EXISTS task_commit_associations (
            id TEXT PRIMARY KEY,
            taskLineageId TEXT NOT NULL,
            taskIdSnapshot TEXT NOT NULL,
            commitSha TEXT NOT NULL,
            commitSubject TEXT NOT NULL,
            authoredAt TEXT NOT NULL,
            matchedBy TEXT NOT NULL CHECK (matchedBy IN ('canonical-lineage-trailer', 'legacy-task-id-trailer', 'legacy-subject', 'manual-reconciliation')),
            confidence TEXT NOT NULL CHECK (confidence IN ('canonical', 'legacy', 'ambiguous')),
            note TEXT,
            createdAt TEXT NOT NULL,
            updatedAt TEXT NOT NULL,
            UNIQUE(taskLineageId, commitSha, matchedBy)
          )
        `);
        this.db.exec("CREATE INDEX IF NOT EXISTS idxTaskCommitAssociationsLineage ON task_commit_associations(taskLineageId)");
        this.db.exec("CREATE INDEX IF NOT EXISTS idxTaskCommitAssociationsCommitSha ON task_commit_associations(commitSha)");
      });
    }

    if (version < 73) {
      this.applyMigration(73, () => {
        this.addColumnIfMissing("tasks", "mergeAuditBounceCount", "INTEGER DEFAULT 0");
      });
    }

    if (version < 74) {
      this.applyMigration(74, () => {
        this.addColumnIfMissing("tasks", "tokenUsageCacheWriteTokens", "INTEGER");
      });
    }

    if (version < 75) {
      this.applyMigration(75, () => {
        this.addColumnIfMissing("tasks", "mergeTransientRetryCount", "INTEGER DEFAULT 0");
      });
    }

    if (version < 76) {
      this.applyMigration(76, () => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS experiment_sessions (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            projectId TEXT,
            status TEXT NOT NULL,
            metric TEXT NOT NULL,
            currentSegment INTEGER NOT NULL DEFAULT 1,
            maxIterations INTEGER,
            workingDir TEXT,
            baselineRunId TEXT,
            bestRunId TEXT,
            keptRunIds TEXT NOT NULL DEFAULT '[]',
            tags TEXT NOT NULL DEFAULT '[]',
            metadata TEXT,
            createdAt TEXT NOT NULL,
            updatedAt TEXT NOT NULL,
            finalizedAt TEXT
          )
        `);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idxExperimentSessionsStatus ON experiment_sessions(status)`);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idxExperimentSessionsProject ON experiment_sessions(projectId)`);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idxExperimentSessionsCreatedAt ON experiment_sessions(createdAt)`);

        this.db.exec(`
          CREATE TABLE IF NOT EXISTS experiment_session_records (
            id TEXT PRIMARY KEY,
            sessionId TEXT NOT NULL,
            segment INTEGER NOT NULL,
            seq INTEGER NOT NULL,
            type TEXT NOT NULL,
            payload TEXT NOT NULL,
            createdAt TEXT NOT NULL,
            FOREIGN KEY (sessionId) REFERENCES experiment_sessions(id) ON DELETE CASCADE,
            UNIQUE(sessionId, seq)
          )
        `);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idxExperimentRecordsSessionSegment ON experiment_session_records(sessionId, segment, seq)`);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idxExperimentRecordsType ON experiment_session_records(sessionId, type)`);
      });
    }

    if (version < 77) {
      this.applyMigration(77, () => {
        this.addColumnIfMissing("workflow_steps", "gateMode", "TEXT NOT NULL DEFAULT 'advisory'");
        // FN-4368: advisory-by-default for all legacy workflow_steps rows; users opt in to 'gate' via UI.
        this.db.exec("UPDATE workflow_steps SET gateMode = 'advisory'");
      });
    }

    if (version < 78) {
      this.applyMigration(78, () => {
        this.addColumnIfMissing("tasks", "tokenBudgetSoftAlertedAt", "TEXT");
        this.addColumnIfMissing("tasks", "tokenBudgetHardAlertedAt", "TEXT");
        this.addColumnIfMissing("tasks", "tokenBudgetOverride", "TEXT");
      });
    }

    if (version < 79) {
      this.applyMigration(79, () => {
        this.addColumnIfMissing("tasks", "branchConflictRecoveryCount", "INTEGER DEFAULT 0");
        this.addColumnIfMissing("tasks", "reviewerContextRetryCount", "INTEGER DEFAULT 0");
        this.addColumnIfMissing("tasks", "reviewerFallbackRetryCount", "INTEGER DEFAULT 0");
      });
    }

    if (version < 80) {
      this.applyMigration(80, () => {
        this.addColumnIfMissing("tasks", "overlapBlockedBy", "TEXT");
      });
    }

    if (version < 81) {
      this.applyMigration(81, () => {
        this.addColumnIfMissing("milestones", "acceptanceCriteria", "TEXT");
      });
    }

    if (version < 82) {
      this.applyMigration(82, () => {
        this.addColumnIfMissing("tasks", "firstExecutionAt", "TEXT");
        this.addColumnIfMissing("tasks", "cumulativeActiveMs", "INTEGER");
        if (this.hasColumn("tasks", "executionStartedAt")) {
          this.db
            .prepare(
              `UPDATE tasks
               SET firstExecutionAt = executionStartedAt
               WHERE firstExecutionAt IS NULL
                 AND executionStartedAt IS NOT NULL`
            )
            .run();
        }
      });
    }

    if (version < 83) {
      this.applyMigration(83, () => {
        this.addColumnIfMissing("tasks", "worktreeSessionRetryCount", "INTEGER DEFAULT 0");
      });
    }

    if (version < 84) {
      this.applyMigration(84, () => {
        if (!this.hasTable("secrets")) {
          this.db.exec(`
            CREATE TABLE secrets (
              id TEXT PRIMARY KEY,
              key TEXT NOT NULL,
              value_ciphertext BLOB NOT NULL,
              nonce BLOB NOT NULL,
              description TEXT,
              access_policy TEXT NOT NULL DEFAULT 'auto'
                CHECK (access_policy IN ('auto', 'prompt', 'deny')),
              env_exportable INTEGER NOT NULL DEFAULT 0
                CHECK (env_exportable IN (0, 1)),
              env_export_key TEXT,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              last_read_at TEXT,
              last_read_by TEXT
            )
          `);
          this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idxSecretsKey ON secrets(key)");
        }
      });
    }

    if (version < 85) {
      this.applyMigration(85, () => {
        if (!this.hasColumn("tasks", "title")) {
          console.log("[title-id-drift] db.ts migration normalized 0 active titles");
          return;
        }

        const rows = this.db.prepare("SELECT id, title FROM tasks WHERE title IS NOT NULL").all() as Array<{
          id: string;
          title: string;
        }>;
        const updateStmt = this.db.prepare("UPDATE tasks SET title = ? WHERE id = ?");
        let normalizedCount = 0;

        for (const row of rows) {
          if (!hasTitleIdDrift(row.title, row.id)) {
            continue;
          }
          const normalized = normalizeTitleForTaskId(row.title, row.id);
          if (!normalized.changed) {
            continue;
          }
          updateStmt.run(normalized.title, row.id);
          normalizedCount += 1;
        }

        console.log(`[title-id-drift] db.ts migration normalized ${normalizedCount} active titles`);
      });
    }

    if (version < 86) {
      this.applyMigration(86, () => {
        this.addColumnIfMissing("tasks", "completionHandoffLimboRecoveryCount", "INTEGER DEFAULT 0");
      });
    }

    if (version < 87) {
      this.applyMigration(87, () => {
        this.addColumnIfMissing("tasks", "prInfos", "TEXT");
      });
    }

    if (version < 88) {
      this.applyMigration(88, () => {
        this.addColumnIfMissing("tasks", "deletedAt", "TEXT");
        this.db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_deletedAt ON tasks(deletedAt)");
      });
    }

    if (version < 89) {
      this.applyMigration(89, () => {
        this.addColumnIfMissing("tasks", "allowResurrection", "INTEGER DEFAULT 0");
        try {
          const taskColumns = this.getTableColumns("tasks");
          const requiredColumns = ["paused", "userPaused", "pausedByAgentId", "pausedReason"];
          if (!requiredColumns.every((column) => taskColumns.has(column))) {
            console.log("[done-paused-backfill] db.ts migration skipped (missing paused columns on legacy schema)");
            return;
          }

          const result = this.db
            .prepare(`UPDATE tasks
                SET paused = 0,
                    userPaused = 0,
                    pausedByAgentId = NULL,
                    pausedReason = NULL
              WHERE column = 'done'
                AND (paused = 1
                  OR userPaused = 1
                  OR pausedByAgentId IS NOT NULL
                  OR pausedReason IS NOT NULL)`)
            .run();
          console.log(`[done-paused-backfill] db.ts migration repaired ${result.changes} done task rows`);
        } catch (error) {
          console.warn("[done-paused-backfill] db.ts migration failed", error);
        }
      });
    }

    if (version < 90) {
      this.applyMigration(90, () => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS mergeQueue (
            taskId TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
            enqueuedAt TEXT NOT NULL,
            priority TEXT NOT NULL DEFAULT 'normal',
            leasedBy TEXT,
            leasedAt TEXT,
            leaseExpiresAt TEXT,
            attemptCount INTEGER NOT NULL DEFAULT 0,
            lastError TEXT
          )
        `);
        this.db.exec(`
          CREATE INDEX IF NOT EXISTS idx_mergeQueue_lease_ready
            ON mergeQueue(leasedBy, priority, enqueuedAt)
        `);
        this.db.exec(`
          CREATE INDEX IF NOT EXISTS idx_mergeQueue_leaseExpiresAt
            ON mergeQueue(leaseExpiresAt)
        `);
      });
    }

    if (version < 91) {
      this.applyMigration(91, () => {
        this.addColumnIfMissing("tasks", "scopeAutoWiden", "TEXT DEFAULT '[]'");
      });
    }

    if (version < 92) {
      this.applyMigration(92, () => {
        this.addColumnIfMissing("missions", "baseBranch", "TEXT");
      });
    }

    if (version < 93) {
      this.applyMigration(93, () => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS goals (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            description TEXT,
            status TEXT NOT NULL,
            createdAt TEXT NOT NULL,
            updatedAt TEXT NOT NULL
          )
        `);
        this.db.exec(`
          CREATE INDEX IF NOT EXISTS idxGoalsStatus
            ON goals(status)
        `);
      });
    }

    if (version < 94) {
      this.applyMigration(94, () => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS goal_citations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            goalId TEXT NOT NULL,
            agentId TEXT NOT NULL,
            taskId TEXT,
            surface TEXT NOT NULL,
            sourceRef TEXT NOT NULL,
            snippet TEXT NOT NULL,
            timestamp TEXT NOT NULL
          )
        `);
        this.db.exec(`
          CREATE INDEX IF NOT EXISTS idxGoalCitationsGoalId
            ON goal_citations(goalId)
        `);
        this.db.exec(`
          CREATE INDEX IF NOT EXISTS idxGoalCitationsAgentId
            ON goal_citations(agentId)
        `);
        this.db.exec(`
          CREATE INDEX IF NOT EXISTS idxGoalCitationsTimestamp
            ON goal_citations(timestamp)
        `);
        this.db.exec(`
          CREATE UNIQUE INDEX IF NOT EXISTS uxGoalCitationsDedup
            ON goal_citations(goalId, surface, sourceRef)
        `);
      });
    }

    if (version < 96) {
      this.applyMigration(96, () => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS branch_groups (
            id TEXT PRIMARY KEY,
            sourceType TEXT NOT NULL CHECK (sourceType IN ('mission','planning','new-task')),
            sourceId TEXT NOT NULL,
            branchName TEXT NOT NULL UNIQUE,
            worktreePath TEXT,
            autoMerge INTEGER NOT NULL DEFAULT 0,
            prState TEXT NOT NULL DEFAULT 'none' CHECK (prState IN ('none','open','merged','closed')),
            prUrl TEXT,
            prNumber INTEGER,
            status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','finalized','abandoned')),
            createdAt INTEGER NOT NULL,
            updatedAt INTEGER NOT NULL,
            closedAt INTEGER
          )
        `);
        this.db.exec(`
          CREATE INDEX IF NOT EXISTS idxBranchGroupsSource
            ON branch_groups(sourceType, sourceId)
        `);
        this.db.exec(`
          CREATE INDEX IF NOT EXISTS idxBranchGroupsBranchName
            ON branch_groups(branchName)
        `);
        this.addColumnIfMissing("tasks", "autoMerge", "INTEGER");
        this.addColumnIfMissing("missions", "autoMerge", "INTEGER");
      });
    }

    if (version < 97) {
      this.applyMigration(97, () => {
        if (this.hasTable("mission_contract_assertions")) {
          this.addColumnIfMissing("mission_contract_assertions", "sourceFeatureId", "TEXT");
        }
      });
    }

    if (version < 98) {
      this.applyMigration(98, () => {
        this.addColumnIfMissing("missions", "branchStrategy", "TEXT");
      });
    }

    if (version < 99) {
      this.applyMigration(99, () => {
        this.addColumnIfMissing("tasks", "resumeLimboCount", "INTEGER DEFAULT 0");
        this.addColumnIfMissing("tasks", "resumeLimboTipSha", "TEXT");
        this.addColumnIfMissing("tasks", "resumeLimboStepSignature", "TEXT");
      });
    }

    if (version < 100) {
      this.applyMigration(100, () => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS merge_requests (
            taskId TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
            state TEXT NOT NULL,
            createdAt TEXT NOT NULL,
            updatedAt TEXT NOT NULL,
            attemptCount INTEGER NOT NULL DEFAULT 0,
            lastError TEXT
          )
        `);
        this.db.exec(`
          CREATE INDEX IF NOT EXISTS idx_merge_requests_state_updatedAt
            ON merge_requests(state, updatedAt)
        `);
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS completion_handoff_markers (
            taskId TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
            acceptedAt TEXT NOT NULL,
            source TEXT NOT NULL
          )
        `);
        this.db.exec(`
          CREATE INDEX IF NOT EXISTS idx_completion_handoff_markers_acceptedAt
            ON completion_handoff_markers(acceptedAt)
        `);
      });
    }

    if (version < 101) {
      this.applyMigration(101, () => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS mission_goals (
            missionId TEXT NOT NULL,
            goalId TEXT NOT NULL,
            createdAt TEXT NOT NULL,
            PRIMARY KEY (missionId, goalId),
            FOREIGN KEY (missionId) REFERENCES missions(id) ON DELETE CASCADE,
            FOREIGN KEY (goalId) REFERENCES goals(id) ON DELETE CASCADE
          )
        `);
        this.db.exec(`
          CREATE INDEX IF NOT EXISTS idxMissionGoalsGoalId
            ON mission_goals(goalId)
        `);
      });
    }

    // Migration 102: Drop agentLogEntries after store-level migration has
    // copied legacy rows into per-task JSONL files. Database.init() runs before
    // TaskStore.init(), so we must defer the destructive drop until the store
    // writes the migration guard into __meta and re-runs init().
    if (version < 102) {
      const agentLogMigrationComplete = this.getMetaValue("agentLogEntriesToFileMigrationVersion") === "1";
      const hasLegacyAgentLogTable = this.hasTable("agentLogEntries");
      const legacyAgentLogTableIsEmpty = hasLegacyAgentLogTable
        ? ((this.db.prepare("SELECT COUNT(*) as count FROM agentLogEntries").get() as { count: number }).count === 0)
        : true;
      const hasLegacyAgentLogCitations =
        (this.db.prepare(
          "SELECT 1 FROM goal_citations WHERE surface = 'agent_log' AND sourceRef GLOB 'agentLog:[0-9]*' LIMIT 1",
        ).get() ?? undefined) !== undefined;
      if (!hasLegacyAgentLogTable || agentLogMigrationComplete || (legacyAgentLogTableIsEmpty && !hasLegacyAgentLogCitations)) {
        this.applyMigration(102, () => {
          this.db.exec(`DROP TABLE IF EXISTS agentLogEntries`);
        });
      }
    }

    // Migration 103: Named workflow definitions (WorkflowIr graphs + layout).
    if (version < 103) {
      this.applyMigration(103, () => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS workflows (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            ir TEXT NOT NULL,
            layout TEXT NOT NULL DEFAULT '{}',
            createdAt TEXT NOT NULL,
            updatedAt TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idxWorkflowsCreatedAt ON workflows(createdAt);
        `);
      });
    }

    // Migration 104: Per-task selected workflow (resolves to enabledWorkflowSteps).
    if (version < 104) {
      this.applyMigration(104, () => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS task_workflow_selection (
            taskId TEXT PRIMARY KEY,
            workflowId TEXT NOT NULL,
            stepIds TEXT NOT NULL DEFAULT '[]',
            updatedAt TEXT NOT NULL
          )
        `);
      });
    }

    // Migration 105: task_workflow_selection has no FK to tasks(id) (SQLite can't
    // add one to an existing table without a rebuild), so physical task deletes
    // before this version could leave orphaned selection rows and unreclaimable
    // compiled workflow_steps. Drop any already-orphaned rows and their steps.
    if (version < 105) {
      this.applyMigration(105, () => {
        // Delete the compiled steps referenced by orphaned selections first, then
        // the orphaned selection rows themselves. json_each expands the stepIds
        // JSON array; the WHERE guards against malformed (non-array) stepIds.
        this.db.exec(`
          DELETE FROM workflow_steps WHERE id IN (
            SELECT je.value
            FROM task_workflow_selection sel
            JOIN json_each(sel.stepIds) je
            WHERE json_valid(sel.stepIds)
              AND json_type(sel.stepIds) = 'array'
              AND sel.taskId NOT IN (SELECT id FROM tasks)
          );
          DELETE FROM task_workflow_selection
          WHERE taskId NOT IN (SELECT id FROM tasks);
        `);
      });
    }

    // Migration 106: Crash-safe transition marker (workflow-columns U3). Stores
    // JSON {toColumn, hooksRemaining, startedAt} written in the same txn as a
    // column change; recovery re-runs the remaining idempotent post-commit hooks
    // and clears it. Additive-only, nullable, no backfill — existing rows have
    // no in-flight transition.
    if (version < 106) {
      this.applyMigration(106, () => {
        this.addColumnIfMissing("tasks", "transitionPending", "TEXT");
      });
    }

    // Migration 107: Per-branch run state for concurrent workflow fan-out/join
    // (workflow-columns U13, KTD-11/R21). Stores {taskId, runId, branchId,
    // currentNodeId, status} so a crashed parallel run resumes each branch from
    // its persisted node without re-running completed branches. Additive-only,
    // idempotent (table-exists guard); no backfill.
    if (version < 107) {
      this.applyMigration(107, () => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS workflow_run_branches (
            taskId TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
            runId TEXT NOT NULL,
            branchId TEXT NOT NULL,
            currentNodeId TEXT NOT NULL,
            status TEXT NOT NULL,
            updatedAt TEXT NOT NULL,
            PRIMARY KEY (taskId, runId, branchId)
          );
          CREATE INDEX IF NOT EXISTS idx_workflow_run_branches_task_run ON workflow_run_branches(taskId, runId);
        `);
      });
    }

    // Migration 108: Step-inversion persistence (step-inversion U4, KTD-6/KTD-13).
    // Adds workflow_run_step_instances — one row per expanded step instance inside a
    // foreach region — so a crashed/restarted run reconstructs the instance set from
    // pinnedStepCount + persisted currentNodeId/reworkCount, and the RETHINK reset
    // anchors (baselineSha/checkpointId) survive restart (previously in-memory Maps).
    // branchName/integratedAt + "awaiting-integration" status serve parallel mode
    // (KTD-11; null/unused at concurrency 1). Also adds tasks.customFields (KTD-13),
    // the JSON store for workflow-defined custom task field values. Additive-only,
    // idempotent (table-exists / addColumnIfMissing guards); no backfill.
    // status ∈ "pending" | "in-progress" | "awaiting-integration" | "completed" | "failed".
    if (version < 108) {
      this.applyMigration(108, () => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS workflow_run_step_instances (
            taskId TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
            runId TEXT NOT NULL,
            foreachNodeId TEXT NOT NULL,
            stepIndex INTEGER NOT NULL,
            pinnedStepCount INTEGER NOT NULL,
            currentNodeId TEXT,
            status TEXT NOT NULL,
            baselineSha TEXT,
            checkpointId TEXT,
            reworkCount INTEGER NOT NULL DEFAULT 0,
            branchName TEXT,
            integratedAt TEXT,
            updatedAt TEXT NOT NULL,
            PRIMARY KEY (taskId, runId, foreachNodeId, stepIndex)
          );
          CREATE INDEX IF NOT EXISTS idx_workflow_run_step_instances_task_run ON workflow_run_step_instances(taskId, runId);
        `);
        this.addColumnIfMissing("tasks", "customFields", "TEXT DEFAULT '{}'");
      });
    }

    // Migration 109: Workflow editor consolidation. Adds workflows.kind
    // (fragment vs workflow discriminator; existing rows default 'workflow')
    // and workflow_steps.migrated_fragment_id (idempotent lazy step migration).
    // Additive-only, idempotent (addColumnIfMissing guards); no backfill.
    if (version < 109) {
      this.applyMigration(109, () => {
        this.addColumnIfMissing("workflows", "kind", "TEXT NOT NULL DEFAULT 'workflow'");
        this.addColumnIfMissing("workflow_steps", "migrated_fragment_id", "TEXT");
      });
    }

    // Migration 110: Durable CLI agent session records (CLI Agent Executor U1).
    // cli_sessions — one row per long-lived CLI agent session. agentState ∈
    // starting|ready|busy|waitingOnInput|done|dead|needsAttention; terminationReason
    // ∈ completed|userExited|killed|crashed|authFailed|engineDeath; purpose ∈
    // execute|planning|validator|ce|chat. Additive-only, idempotent.
    if (version < 110) {
      this.applyMigration(110, () => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS cli_sessions (
            id TEXT PRIMARY KEY,
            taskId TEXT,
            chatSessionId TEXT,
            purpose TEXT NOT NULL,
            projectId TEXT NOT NULL,
            adapterId TEXT NOT NULL,
            agentState TEXT NOT NULL DEFAULT 'starting',
            terminationReason TEXT,
            nativeSessionId TEXT,
            resumeAttempts INTEGER NOT NULL DEFAULT 0,
            autonomyPosture TEXT,
            worktreePath TEXT,
            createdAt TEXT NOT NULL,
            updatedAt TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_cli_sessions_taskId ON cli_sessions(taskId);
          CREATE INDEX IF NOT EXISTS idx_cli_sessions_chatSessionId ON cli_sessions(chatSessionId);
          CREATE INDEX IF NOT EXISTS idx_cli_sessions_project_state ON cli_sessions(projectId, agentState);
        `);
      });
    }

    // Migration 111: per-chat-session cli-agent adapter selection (U12).
    if (version < 111) {
      this.applyMigration(111, () => {
        if (this.hasTable("chat_sessions")) {
          this.addColumnIfMissing("chat_sessions", "cliExecutorAdapterId", "TEXT");
        }
      });
    }

    // Migration 112: Workflow setting values (workflow-settings U2, KTD-2).
    // Adds workflow_settings — one row per (workflowId, projectId) carrying a JSON
    // map of setting values declared by the workflow's IR. Values are validated by
    // the store write authority against the named workflow's declarations; built-in
    // workflow ids are accepted for value writes even though their declarations are
    // non-editable. Additive-only, idempotent (table-exists guard); no backfill.
    // (Authored as 109 on the feature branch; renumbered as mainline migrations
    // land first — currently 112.)
    if (version < 112) {
      this.applyMigration(112, () => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS workflow_settings (
            workflowId TEXT NOT NULL,
            projectId TEXT NOT NULL,
            "values" TEXT DEFAULT '{}',
            updatedAt TEXT NOT NULL,
            PRIMARY KEY (workflowId, projectId)
          );
          CREATE INDEX IF NOT EXISTS idx_workflow_settings_project ON workflow_settings(projectId);
        `);
      });
    }

  }

  /**
   * Run a single migration step inside a transaction and bump the version.
   */
  private applyMigration(targetVersion: number, fn: () => void): void {
    // SQLite ALTER TABLE cannot run inside a transaction, so we run the
    // migration function directly and only bump the version on success.
    fn();
    this.db
      .prepare("UPDATE __meta SET value = ? WHERE key = 'schemaVersion'")
      .run(String(targetVersion));
  }

  /**
   * Check whether a table exists.
   */
  private hasTable(table: string): boolean {
    const row = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table) as { name: string } | undefined;
    return Boolean(row);
  }

  /**
   * Check whether an error appears to be an FTS5 corruption/integrity failure.
   */
  isFts5CorruptionError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error ?? "");
    const lower = message.toLowerCase();
    return (
      lower.includes("corruption found reading blob") ||
      lower.includes("database disk image is malformed") ||
      (lower.includes("fts5") && lower.includes("corrupt"))
    );
  }

  /**
   * Read the declared columns for a table.
   */
  private getTableColumns(table: string, useCache = false, cache?: TableColumnsCache): Set<string> {
    if (useCache && cache?.has(table)) {
      return cache.get(table) ?? new Set<string>();
    }

    const columns = new Set(
      (this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name),
    );

    if (useCache && cache) {
      cache.set(table, columns);
    }

    return columns;
  }

  /**
   * Check whether a table has a given column.
   */
  private hasColumn(table: string, column: string): boolean {
    return this.getTableColumns(table).has(column);
  }

  /** Check whether a table exists in the current schema. */
  private tableExists(table: string): boolean {
    const row = this.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
      .get(table);
    return row !== undefined && row !== null;
  }

  /**
   * Add a column to a table if it does not already exist.
   */
  private addColumnIfMissing(table: string, column: string, definition: string): void {
    if (!this.hasColumn(table, column)) {
      // Quote the column identifier so reserved words (e.g. `values`) are legal.
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN "${column}" ${definition}`);
    }
  }

  /**
   * Add a column using a per-init table-info cache when available.
   */
  private addColumnIfMissingCached(
    table: string,
    column: string,
    definition: string,
    cache?: TableColumnsCache,
  ): void {
    const columns = this.getTableColumns(table, Boolean(cache), cache);
    if (columns.has(column)) {
      return;
    }

    // Quote the column identifier so reserved words (e.g. `values`) are legal.
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN "${column}" ${definition}`);
    columns.add(column);
    if (cache) {
      cache.set(table, columns);
    }
  }

  /**
   * Normalize legacy steering comments into the unified comments field exactly once.
   *
   * This migration is idempotent: rows already normalized remain unchanged on rerun.
   * The legacy steeringComments column is preserved for backward compatibility, but
   * migrated comments are represented canonically in the comments column.
   */
  private migrateLegacyCommentsToUnifiedComments(): void {
    if (!this.hasColumn("tasks", "comments") || !this.hasColumn("tasks", "steeringComments")) {
      return;
    }

    const rows = this.db.prepare("SELECT id, steeringComments, comments FROM tasks").all() as Array<{
      id: string;
      steeringComments: string | null;
      comments: string | null;
    }>;

    const updateStmt = this.db.prepare(
      "UPDATE tasks SET comments = ? WHERE id = ?",
    );

    for (const row of rows) {
      const steeringComments = fromJson<SteeringComment[]>(row.steeringComments) || [];
      const comments = fromJson<TaskComment[]>(row.comments) || [];
      const normalized = normalizeTaskComments(steeringComments, comments);
      const nextCommentsJson = toJson(normalized.comments);
      if ((row.comments || "[]") !== nextCommentsJson) {
        updateStmt.run(nextCommentsJson, row.id);
      }
    }
  }

  /**
   * Run a WAL checkpoint and return checkpoint stats.
   *
   * TRUNCATE remains the default so explicit maintenance/compaction calls keep
   * reclaiming disk space as before. Live engine maintenance should opt into
   * PASSIVE to avoid forcing a blocking truncate on the shared event loop
   * while tasks are actively writing logs.
   */
  walCheckpoint(mode: "PASSIVE" | "TRUNCATE" = "TRUNCATE"): { busy: number; log: number; checkpointed: number } {
    const row = this.db.prepare(`PRAGMA wal_checkpoint(${mode})`).get() as
      | { busy?: number; log?: number; checkpointed?: number }
      | undefined;
    return { busy: row?.busy ?? 0, log: row?.log ?? 0, checkpointed: row?.checkpointed ?? 0 };
  }

  private scheduleBackgroundIntegrityCheck(): void {
    if (this.inMemory || this.integrityCheckScheduled || this.closed) {
      return;
    }

    this.integrityCheckScheduled = true;
    this.integrityCheckPending = true;

    const existing = Database.sharedIntegrityChecks.get(this.dbPath);
    if (existing) {
      existing.subscribers.add(this);
      return;
    }

    const shared: SharedIntegrityCheckState = {
      timer: null,
      subscribers: new Set([this]),
      running: false,
    };

    // PRAGMA integrity_check walks every page of the database file and
    // blocks the event loop for several seconds per DB. Delay it well past
    // cold start so the dashboard is interactive before the check lands.
    shared.timer = setTimeout(() => {
      shared.timer = null;
      shared.running = true;

      const participants = [...shared.subscribers].filter((instance) => !instance.closed);
      const primary = participants[0];
      const startedAt = new Date().toISOString();

      let integrity: ReturnType<Database["integrityCheck"]> = { ok: true };
      if (primary) {
        integrity = primary.integrityCheck();
      }

      for (const participant of participants) {
        participant.integrityCheckPending = false;
        participant.integrityCheckLastRunAt = startedAt;
        participant.corruptionDetected = !integrity.ok;
        participant.integrityCheckErrors = integrity.ok ? [] : [...integrity.errors];
      }

      if (!integrity.ok) {
        const errorSummary = integrity.errors.slice(0, 3).join(" | ");
        console.error(
          `[fusion:db] Background integrity check detected corruption for ${this.dbPath}: ${errorSummary}`,
        );
      }

      Database.sharedIntegrityChecks.delete(this.dbPath);
    }, 60_000);

    Database.sharedIntegrityChecks.set(this.dbPath, shared);
  }

  /**
   * Close the database connection.
   */
  close(): void {
    if (this.closed) {
      return;
    }

    this.closed = true;

    const shared = Database.sharedIntegrityChecks.get(this.dbPath);
    if (shared) {
      shared.subscribers.delete(this);
      if (!shared.running && shared.subscribers.size === 0) {
        if (shared.timer) {
          clearTimeout(shared.timer);
          shared.timer = null;
        }
        Database.sharedIntegrityChecks.delete(this.dbPath);
      }
    }

    this.integrityCheckPending = false;
    this.db.close();
  }

  private runWithLockRecovery(action: string, fn: () => void): void {
    const deadline = Date.now() + this.lockRecoveryWindowMs;
    let attempt = 0;

    while (true) {
      try {
        fn();
        return;
      } catch (error) {
        if (!isSqliteLockError(error)) {
          throw error;
        }
        if (Date.now() >= deadline) {
          throw new Error(
            `SQLite ${action} failed after ${attempt + 1} attempt${attempt === 0 ? "" : "s"}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        const remainingMs = Math.max(0, deadline - Date.now());
        const delayMs = Math.min(this.lockRecoveryDelayMs * Math.max(1, attempt + 1), remainingMs);
        sleepSync(delayMs);
        attempt += 1;
      }
    }
  }

  /**
   * Execute a function inside a SQLite transaction.
   * Supports nested calls via SAVEPOINTs.
   * If the function throws, the transaction/savepoint is rolled back.
   * If the function returns normally, the transaction/savepoint is committed.
   *
   * Outermost transactions default to `BEGIN` (DEFERRED) so read-only callers
   * avoid taking a writer lock until they actually mutate state.
   * Use `transactionImmediate()` for write-heavy paths that should acquire the
   * RESERVED lock before user code runs and fail/retry before the callback executes.
   */
  transaction<T>(fn: () => T, options?: { mode?: TransactionMode }): T {
    const depth = this.transactionDepth++;
    const isOutermost = depth === 0;
    const savepointName = `sp_${depth}`;
    const mode: TransactionMode = options?.mode ?? "deferred";

    try {
      if (isOutermost) {
        if (mode === "immediate") {
          this.runWithLockRecovery("BEGIN IMMEDIATE", () => {
            this.db.exec("BEGIN IMMEDIATE");
          });
        } else {
          this.db.exec("BEGIN");
        }
      } else {
        this.db.exec(`SAVEPOINT ${savepointName}`);
      }
    } catch (error) {
      this.transactionDepth--;
      throw error;
    }

    try {
      const result = fn();
      if (isOutermost) {
        this.runWithLockRecovery("COMMIT", () => {
          this.db.exec("COMMIT");
        });
      } else {
        this.db.exec(`RELEASE ${savepointName}`);
      }
      return result;
    } catch (err) {
      if (isOutermost) {
        this.db.exec("ROLLBACK");
      } else {
        this.db.exec(`ROLLBACK TO ${savepointName}`);
        this.db.exec(`RELEASE ${savepointName}`);
      }
      throw err;
    } finally {
      this.transactionDepth--;
    }
  }

  transactionImmediate<T>(fn: () => T): T {
    return this.transaction(fn, { mode: "immediate" });
  }

  /**
   * Execute plugin-provided schema initialization hooks.
   *
   * Hooks run sequentially to preserve deterministic ordering based on plugin
   * dependency resolution. Failures are isolated and logged so one plugin's
   * schema initialization does not prevent later hooks from running.
   */
  async runPluginSchemaInits(
    hooks: Array<{ pluginId: string; hook: PluginOnSchemaInit }>,
  ): Promise<void> {
    let errorCount = 0;

    for (const { pluginId, hook } of hooks) {
      try {
        await hook(this);
        console.log(`[fusion:db] Plugin schema init completed for ${pluginId}`);
      } catch (error) {
        errorCount += 1;
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[fusion:db] Plugin schema init failed for ${pluginId}: ${message}`);
      }
    }

    console.log(
      `[fusion:db] Plugin schema initialization complete (${hooks.length} hooks executed, ${errorCount} errors)`,
    );
  }

  /**
   * Prepare a SQL statement. Returns a Statement object.
   */
  prepare(sql: string): Statement {
    return this.db.prepare(sql);
  }

  /**
   * Execute a raw SQL string (no parameters).
   */
  exec(sql: string): void {
    this.db.exec(sql);
  }

  private getMetaValue(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM __meta WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  /**
   * Persist a __meta value idempotently.
   */
  private setMetaValue(key: string, value: string): void {
    this.db.prepare("INSERT OR REPLACE INTO __meta (key, value) VALUES (?, ?)").run(key, value);
  }

  // IDENTITY KEY: Per-project durable identity used to recover central project rows.
  private static readonly PROJECT_IDENTITY_META_KEY = "projectIdentity";

  getProjectIdentity(): ProjectIdentity | undefined {
    const value = this.getMetaValue(Database.PROJECT_IDENTITY_META_KEY);
    return fromJson<ProjectIdentity>(value);
  }

  setProjectIdentity(identity: ProjectIdentity, options?: { force?: boolean }): void {
    const stored = this.getProjectIdentity();
    const force = options?.force === true;

    if (stored) {
      if (stored.id === identity.id) {
        return;
      }
      if (!force) {
        throw new ProjectIdentityConflictError({
          storedId: stored.id,
          storedPath: stored.firstSeenPath,
          incomingId: identity.id,
          incomingPath: identity.firstSeenPath,
        });
      }
    }

    this.setMetaValue(Database.PROJECT_IDENTITY_META_KEY, JSON.stringify(identity));
  }

  clearProjectIdentity(): void {
    this.db
      .prepare("DELETE FROM __meta WHERE key = ?")
      .run(Database.PROJECT_IDENTITY_META_KEY);
  }

  /**
   * Get the last modification timestamp (epoch ms).
   * Returns 0 if the value is not set.
   */
  getLastModified(): number {
    const value = this.getMetaValue("lastModified");
    if (!value) return 0;
    return parseInt(value, 10) || 0;
  }

  /**
   * Update the last modification timestamp to the current time.
   * Guarantees monotonicity: the new value is always strictly greater than
   * the previous value, even if called multiple times within the same millisecond.
   * Call this after every write operation to enable change detection polling.
   */
  bumpLastModified(): void {
    const current = this.getLastModified();
    const next = Math.max(Date.now(), current + 1);
    this.db.prepare("UPDATE __meta SET value = ? WHERE key = 'lastModified'").run(
      String(next),
    );
  }

  getBootstrappedAt(): number | null {
    const value = this.getMetaValue("bootstrappedAt");
    if (!value) {
      return null;
    }
    const parsed = parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }

  /**
   * Get the schema version number.
   */
  getSchemaVersion(): number {
    const value = this.getMetaValue("schemaVersion");
    if (!value) return 0;
    return parseInt(value, 10) || 0;
  }

  /**
   * Get the database file path.
   */
  getPath(): string {
    return this.dbPath;
  }
}

// ── Factory Function ─────────────────────────────────────────────────

/**
 * Create a new Database instance (does NOT initialize schema).
 * Callers must call `db.init()` separately.
 * @param fusionDir - Path to the `.fusion` directory (e.g., `/path/to/project/.fusion`)
 * @returns Database instance (not yet initialized)
 */
export function createDatabase(fusionDir: string, options?: { inMemory?: boolean }): Database {
  return new Database(fusionDir, options);
}

function resolveFusionDirForProject(projectPath: string): string {
  return basename(projectPath) === ".fusion" ? projectPath : join(projectPath, ".fusion");
}

export function readProjectIdentity(projectPath: string): ProjectIdentity | undefined {
  const fusionDir = resolveFusionDirForProject(projectPath);
  const dbPath = join(fusionDir, "fusion.db");
  if (!existsSync(dbPath)) {
    return undefined;
  }

  const db = new Database(fusionDir);
  try {
    db.init();
    return db.getProjectIdentity();
  } finally {
    db.close();
  }
}

export function writeProjectIdentity(
  projectPath: string,
  identity: ProjectIdentity,
  options?: { force?: boolean },
): void {
  const fusionDir = resolveFusionDirForProject(projectPath);
  if (!existsSync(fusionDir)) {
    mkdirSync(fusionDir, { recursive: true });
  }
  const db = new Database(fusionDir);
  try {
    db.init();
    db.setProjectIdentity(identity, options);
  } finally {
    db.close();
  }
}

export { normalizeTaskComments };
