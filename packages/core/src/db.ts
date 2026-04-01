/**
 * SQLite database module for kb task board storage.
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

const SCHEMA_VERSION = 3;

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
  modelPresetId TEXT,
  modelProvider TEXT,
  modelId TEXT,
  validatorModelProvider TEXT,
  validatorModelId TEXT,
  mergeRetries INTEGER,
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
  enabledWorkflowSteps TEXT DEFAULT '[]'
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
`;

// ── Database Class ───────────────────────────────────────────────────

export class Database {
  private db: DatabaseSync;
  private readonly dbPath: string;
  /** Tracks transaction nesting depth for savepoint-based nested transactions. */
  private transactionDepth = 0;

  constructor(private kbDir: string) {
    this.dbPath = join(kbDir, "kb.db");

    // Ensure .kb directory exists
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

    // Seed config row idempotently
    const configNow = new Date().toISOString();
    this.db.exec(
      `INSERT OR IGNORE INTO config (id, nextId, nextWorkflowStepId, settings, workflowSteps, updatedAt) VALUES (1, 1, 1, '{}', '[]', '${configNow}')`,
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

    // Future migrations go here:
    // if (version < 3) { this.applyMigration(3, () => { ... }); }
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
 * @param kbDir - Path to the `.kb` directory (e.g., `/path/to/project/.kb`)
 * @returns Database instance (not yet initialized)
 */
export function createDatabase(kbDir: string): Database {
  return new Database(kbDir);
}
