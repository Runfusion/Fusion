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
import { join } from "node:path";
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

const SCHEMA_VERSION = 19;

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
  recoveryRetryCount INTEGER,
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
  assignedAgentId TEXT
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
  metadata TEXT DEFAULT '{}'
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
  FOREIGN KEY (missionId) REFERENCES missions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idxMissionEventsMissionId ON mission_events(missionId);
CREATE INDEX IF NOT EXISTS idxMissionEventsTimestamp ON mission_events(timestamp);
CREATE INDEX IF NOT EXISTS idxMissionEventsType ON mission_events(eventType);
`;

// ── Database Class ───────────────────────────────────────────────────

export class Database {
  private db: DatabaseSync;
  private readonly dbPath: string;
  /** Tracks transaction nesting depth for savepoint-based nested transactions. */
  private transactionDepth = 0;

  constructor(kbDir: string) {
    this.dbPath = join(kbDir, "fusion.db");

    // Ensure .fusion directory exists
    if (!existsSync(kbDir)) {
      mkdirSync(kbDir, { recursive: true });
    }

    this.db = new DatabaseSync(this.dbPath);

    // Enable WAL mode for concurrent reader/writer access
    this.db.exec("PRAGMA journal_mode = WAL");
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
    const row = this.db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as any;
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
