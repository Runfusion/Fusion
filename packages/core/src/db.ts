/**
 * SQLite database module for fn task board storage.
 *
 * Uses Node.js built-in `node:sqlite` (DatabaseSync) for simplified
 * synchronous transaction handling. The database runs in WAL mode
 * for concurrent reader/writer access.
 *
 * Schema version tracking is managed via a `__meta` table.
 */

import { DatabaseSync } from "node:sqlite";
import { isAbsolute, join } from "node:path";
import { mkdirSync, existsSync } from "node:fs";
import { DEFAULT_PROJECT_SETTINGS } from "./types.js";
import type { SteeringComment, TaskComment } from "./types.js";

// ── Types ────────────────────────────────────────────────────────────

/** A prepared SQL statement wrapping the node:sqlite StatementSync type. */
export type Statement = ReturnType<DatabaseSync["prepare"]>;

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

// ── Schema Definition ────────────────────────────────────────────────

const SCHEMA_VERSION = 40;

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
  title TEXT,
  description TEXT NOT NULL,
  "column" TEXT NOT NULL,
  status TEXT,
  size TEXT,
  reviewLevel INTEGER,
  currentStep INTEGER DEFAULT 0,
  worktree TEXT,
  blockedBy TEXT,
  paused INTEGER DEFAULT 0,
  baseBranch TEXT,
  branch TEXT,
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
  recoveryRetryCount INTEGER,
  taskDoneRetryCount INTEGER DEFAULT 0,
  nextRecoveryAt TEXT,
  error TEXT,
  summary TEXT,
  thinkingLevel TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  columnMovedAt TEXT,
  -- JSON columns for nested arrays/objects
  dependencies TEXT DEFAULT '[]',
  steps TEXT DEFAULT '[]',
  log TEXT DEFAULT '[]',
  attachments TEXT DEFAULT '[]',
  steeringComments TEXT DEFAULT '[]',
  comments TEXT DEFAULT '[]',
  workflowStepResults TEXT DEFAULT '[]',
  prInfo TEXT,
  issueInfo TEXT,
  mergeDetails TEXT,
  breakIntoSubtasks INTEGER DEFAULT 0,
  enabledWorkflowSteps TEXT DEFAULT '[]',
  modifiedFiles TEXT DEFAULT '[]',
  missionId TEXT,
  sliceId TEXT,
  assignedAgentId TEXT,
  assigneeUserId TEXT
);

-- Config table (single row with project settings)
CREATE TABLE IF NOT EXISTS config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  nextId INTEGER DEFAULT 1,
  nextWorkflowStepId INTEGER DEFAULT 1,
  settings TEXT DEFAULT '{}',
  workflowSteps TEXT DEFAULT '[]',
  updatedAt TEXT
);

-- Workflow step definitions
CREATE TABLE IF NOT EXISTS workflow_steps (
  id TEXT PRIMARY KEY,
  templateId TEXT,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'prompt',
  phase TEXT NOT NULL DEFAULT 'pre-merge',
  prompt TEXT NOT NULL DEFAULT '',
  toolMode TEXT,
  scriptName TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  defaultOn INTEGER DEFAULT 0,
  modelProvider TEXT,
  modelId TEXT,
  createdAt TEXT NOT NULL,
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

CREATE TABLE IF NOT EXISTS agentLogEntries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  taskId TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  text TEXT NOT NULL,
  type TEXT NOT NULL,
  detail TEXT,
  agent TEXT,
  FOREIGN KEY (taskId) REFERENCES tasks(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idxAgentLogEntriesTaskIdTimestamp ON agentLogEntries(taskId, timestamp);
CREATE INDEX IF NOT EXISTS idxAgentLogEntriesTaskIdType ON agentLogEntries(taskId, type);

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
  autoAdvance INTEGER DEFAULT 0,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);

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
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idxRoutinesNextRunAt ON routines(nextRunAt);
CREATE INDEX IF NOT EXISTS idxRoutinesEnabled ON routines(enabled);

-- Roadmap persistence tables (FN-1690)
-- Standalone roadmap: Roadmap → RoadmapMilestone → RoadmapFeature
-- with deterministic ordering indexes and FK cascade integrity

-- Roadmaps table
CREATE TABLE IF NOT EXISTS roadmaps (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);

-- Roadmap milestones table
CREATE TABLE IF NOT EXISTS roadmap_milestones (
  id TEXT PRIMARY KEY,
  roadmapId TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  orderIndex INTEGER NOT NULL,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  FOREIGN KEY (roadmapId) REFERENCES roadmaps(id) ON DELETE CASCADE
);

-- Roadmap features table
CREATE TABLE IF NOT EXISTS roadmap_features (
  id TEXT PRIMARY KEY,
  milestoneId TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  orderIndex INTEGER NOT NULL,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  FOREIGN KEY (milestoneId) REFERENCES roadmap_milestones(id) ON DELETE CASCADE
);

-- Covering index for deterministic milestone ordering within a roadmap
CREATE INDEX IF NOT EXISTS idxRoadmapMilestonesRoadmapOrder
  ON roadmap_milestones(roadmapId, orderIndex, createdAt, id);

-- Covering index for deterministic feature ordering within a milestone
CREATE INDEX IF NOT EXISTS idxRoadmapFeaturesMilestoneOrder
  ON roadmap_features(milestoneId, orderIndex, createdAt, id);

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
  createdAt TEXT NOT NULL,
  startedAt TEXT,
  completedAt TEXT
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
`;

// ── Database Class ───────────────────────────────────────────────────

export class Database {
  private db: DatabaseSync;
  private readonly dbPath: string;
  /** Tracks transaction nesting depth for savepoint-based nested transactions. */
  private transactionDepth = 0;

  constructor(kbDir: string) {
    this.dbPath = join(kbDir, "fusion.db");

    if (!isAbsolute(kbDir)) {
      throw new Error(`[fusion] Database constructor requires an absolute kbDir path, got: ${kbDir}`);
    }

    // Ensure .fusion directory exists
    if (!existsSync(kbDir)) {
      mkdirSync(kbDir, { recursive: true });
    }

    this.db = new DatabaseSync(this.dbPath);

    // Enable WAL mode for concurrent reader/writer access
    this.db.exec("PRAGMA journal_mode = WAL");
    // Wait up to 5s for locks to clear before returning SQLITE_BUSY
    this.db.exec("PRAGMA busy_timeout = 5000");
    // Enable foreign key enforcement
    this.db.exec("PRAGMA foreign_keys = ON");
  }

  /**
   * Initialize the database: create tables if they don't exist
   * and seed meta values.
   */
  init(): void {
    this.db.exec(SCHEMA_SQL);

    // Seed schemaVersion and lastModified idempotently
    this.db.exec(
      `INSERT OR IGNORE INTO __meta (key, value) VALUES ('schemaVersion', '1')`,
    );
    this.db.exec(
      `INSERT OR IGNORE INTO __meta (key, value) VALUES ('lastModified', '${Date.now()}')`,
    );

    // Run schema migrations
    this.migrate();

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
  private migrate(): void {
    const version = this.getSchemaVersion() || 1;

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
            toolMode,
            scriptName,
            enabled,
            defaultOn,
            modelProvider,
            modelId,
            createdAt,
            updatedAt
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
            typeof step.prompt === "string" ? step.prompt : "",
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
        this.db.exec(`
          CREATE TRIGGER IF NOT EXISTS tasks_fts_ai AFTER INSERT ON tasks BEGIN
            INSERT INTO tasks_fts(rowid, id, title, description, comments)
            VALUES (new.rowid, new.id, COALESCE(new.title, ''), new.description, COALESCE(new.comments, '[]'));
          END
        `);

        const hasTaskTitle = this.hasColumn("tasks", "title");
        const updateColumns = hasTaskTitle
          ? "id, title, description, comments"
          : "id, description, comments";
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
              VALUES (new.rowid, new.id, ${newTitle}, new.description, COALESCE(new.comments, '[]'));
          END
        `);

        // AFTER DELETE trigger - remove deleted tasks from index
        this.db.exec(`
          CREATE TRIGGER IF NOT EXISTS tasks_fts_ad AFTER DELETE ON tasks BEGIN
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
            updatedAt TEXT NOT NULL
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

    // Roadmap persistence tables (FN-1690)
    // Standalone roadmap: Roadmap → RoadmapMilestone → RoadmapFeature
    // with deterministic ordering indexes and FK cascade integrity
    if (version < 32) {
      this.applyMigration(32, () => {
        // Roadmaps table
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS roadmaps (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            description TEXT,
            createdAt TEXT NOT NULL,
            updatedAt TEXT NOT NULL
          )
        `);

        // Roadmap milestones table
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS roadmap_milestones (
            id TEXT PRIMARY KEY,
            roadmapId TEXT NOT NULL,
            title TEXT NOT NULL,
            description TEXT,
            orderIndex INTEGER NOT NULL,
            createdAt TEXT NOT NULL,
            updatedAt TEXT NOT NULL,
            FOREIGN KEY (roadmapId) REFERENCES roadmaps(id) ON DELETE CASCADE
          )
        `);

        // Roadmap features table
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS roadmap_features (
            id TEXT PRIMARY KEY,
            milestoneId TEXT NOT NULL,
            title TEXT NOT NULL,
            description TEXT,
            orderIndex INTEGER NOT NULL,
            createdAt TEXT NOT NULL,
            updatedAt TEXT NOT NULL,
            FOREIGN KEY (milestoneId) REFERENCES roadmap_milestones(id) ON DELETE CASCADE
          )
        `);

        // Covering index for deterministic milestone ordering within a roadmap
        // Covers: WHERE roadmapId = ? ORDER BY orderIndex ASC, createdAt ASC, id ASC
        this.db.exec(`
          CREATE INDEX IF NOT EXISTS idxRoadmapMilestonesRoadmapOrder
            ON roadmap_milestones(roadmapId, orderIndex, createdAt, id)
        `);

        // Covering index for deterministic feature ordering within a milestone
        // Covers: WHERE milestoneId = ? ORDER BY orderIndex ASC, createdAt ASC, id ASC
        this.db.exec(`
          CREATE INDEX IF NOT EXISTS idxRoadmapFeaturesMilestoneOrder
            ON roadmap_features(milestoneId, orderIndex, createdAt, id)
        `);
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
            createdAt TEXT NOT NULL,
            startedAt TEXT,
            completedAt TEXT
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
        const hasTaskTitle = this.hasColumn("tasks", "title");
        const updateColumns = hasTaskTitle
          ? "id, title, description, comments"
          : "id, description, comments";
        const oldTitle = hasTaskTitle ? "COALESCE(old.title, '')" : "''";
        const newTitle = hasTaskTitle ? "COALESCE(new.title, '')" : "''";

        this.db.exec(`
          DROP TRIGGER IF EXISTS tasks_fts_au;
          CREATE TRIGGER tasks_fts_au AFTER UPDATE OF ${updateColumns} ON tasks BEGIN
            INSERT INTO tasks_fts(tasks_fts, rowid, id, title, description, comments)
              VALUES('delete', old.rowid, old.id, ${oldTitle}, old.description, COALESCE(old.comments, '[]'));
            INSERT INTO tasks_fts(rowid, id, title, description, comments)
              VALUES (new.rowid, new.id, ${newTitle}, new.description, COALESCE(new.comments, '[]'));
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
   * Check whether a table has a given column.
   */
  private hasColumn(table: string, column: string): boolean {
    const cols = this.db
      .prepare(`PRAGMA table_info(${table})`)
      .all() as Array<{ name: string }>;
    return cols.some((c) => c.name === column);
  }

  /**
   * Add a column to a table if it does not already exist.
   */
  private addColumnIfMissing(table: string, column: string, definition: string): void {
    if (!this.hasColumn(table, column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
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
   * Run a WAL checkpoint to truncate the WAL file and reclaim disk space.
   * Safe to call periodically. Returns checkpoint stats.
   */
  walCheckpoint(): { busy: number; log: number; checkpointed: number } {
    const row = this.db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as
      | { busy?: number; log?: number; checkpointed?: number }
      | undefined;
    return { busy: row?.busy ?? 0, log: row?.log ?? 0, checkpointed: row?.checkpointed ?? 0 };
  }

  /**
   * Close the database connection.
   */
  close(): void {
    this.db.close();
  }

  /**
   * Execute a function inside a SQLite transaction.
   * Supports nested calls via SAVEPOINTs.
   * If the function throws, the transaction/savepoint is rolled back.
   * If the function returns normally, the transaction/savepoint is committed.
   */
  transaction<T>(fn: () => T): T {
    const depth = this.transactionDepth++;
    const isOutermost = depth === 0;
    const savepointName = `sp_${depth}`;

    if (isOutermost) {
      this.db.exec("BEGIN");
    } else {
      this.db.exec(`SAVEPOINT ${savepointName}`);
    }

    try {
      const result = fn();
      if (isOutermost) {
        this.db.exec("COMMIT");
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

  /**
   * Get the last modification timestamp (epoch ms).
   * Returns 0 if the value is not set.
   */
  getLastModified(): number {
    const row = this.db.prepare("SELECT value FROM __meta WHERE key = 'lastModified'").get() as
      | { value: string }
      | undefined;
    if (!row) return 0;
    return parseInt(row.value, 10) || 0;
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

  /**
   * Get the schema version number.
   */
  getSchemaVersion(): number {
    const row = this.db.prepare("SELECT value FROM __meta WHERE key = 'schemaVersion'").get() as
      | { value: string }
      | undefined;
    if (!row) return 0;
    return parseInt(row.value, 10) || 0;
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
 * @param kbDir - Path to the `.fusion` directory (e.g., `/path/to/project/.fusion`)
 * @returns Database instance (not yet initialized)
 */
export function createDatabase(kbDir: string): Database {
  return new Database(kbDir);
}

export { normalizeTaskComments };
