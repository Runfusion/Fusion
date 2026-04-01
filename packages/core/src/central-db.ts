/**
 * Central SQLite database module for kb's multi-project architecture.
 *
 * Uses Node.js built-in `node:sqlite` (DatabaseSync) for simplified
 * synchronous transaction handling. The database runs in WAL mode
 * for concurrent reader/writer access.
 *
 * This database is stored at `~/.pi/kb/kb-central.db` and serves as the
 * coordination hub for all projects, storing the project registry,
 * unified activity feed, global concurrency limits, and project health.
 */

import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import type { Statement } from "./db.js";

// ── JSON Helpers (reused from db.ts) ─────────────────────────────────────

import { toJson, toJsonNullable, fromJson } from "./db.js";
export { toJson, toJsonNullable, fromJson };

// ── Schema Definition ───────────────────────────────────────────────────

const CENTRAL_SCHEMA_VERSION = 1;

const CENTRAL_SCHEMA_SQL = `
-- Projects table (project registry)
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active',
  isolationMode TEXT NOT NULL DEFAULT 'in-process',
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  lastActivityAt TEXT,
  settings TEXT  -- JSON ProjectSettings snapshot
);
CREATE INDEX IF NOT EXISTS idxProjectsPath ON projects(path);
CREATE INDEX IF NOT EXISTS idxProjectsStatus ON projects(status);

-- Project health table (mutable state, updated frequently)
CREATE TABLE IF NOT EXISTS projectHealth (
  projectId TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  activeTaskCount INTEGER DEFAULT 0,
  inFlightAgentCount INTEGER DEFAULT 0,
  lastActivityAt TEXT,
  lastErrorAt TEXT,
  lastErrorMessage TEXT,
  totalTasksCompleted INTEGER DEFAULT 0,
  totalTasksFailed INTEGER DEFAULT 0,
  averageTaskDurationMs INTEGER,
  updatedAt TEXT NOT NULL,
  FOREIGN KEY (projectId) REFERENCES projects(id) ON DELETE CASCADE
);

-- Central activity log (unified feed across all projects)
CREATE TABLE IF NOT EXISTS centralActivityLog (
  id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL,
  type TEXT NOT NULL,
  projectId TEXT NOT NULL,
  projectName TEXT NOT NULL,
  taskId TEXT,
  taskTitle TEXT,
  details TEXT NOT NULL,
  metadata TEXT,  -- JSON
  FOREIGN KEY (projectId) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idxActivityLogTimestamp ON centralActivityLog(timestamp);
CREATE INDEX IF NOT EXISTS idxActivityLogType ON centralActivityLog(type);
CREATE INDEX IF NOT EXISTS idxActivityLogProjectId ON centralActivityLog(projectId);

-- Global concurrency state (single row)
CREATE TABLE IF NOT EXISTS globalConcurrency (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  globalMaxConcurrent INTEGER DEFAULT 4,
  currentlyActive INTEGER DEFAULT 0,
  queuedCount INTEGER DEFAULT 0,
  updatedAt TEXT
);
-- Seed default row
INSERT OR IGNORE INTO globalConcurrency (id, globalMaxConcurrent, currentlyActive, queuedCount) 
VALUES (1, 4, 0, 0);

-- Schema version tracking
CREATE TABLE IF NOT EXISTS __meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
`;

// ── Central Database Class ────────────────────────────────────────────────

/**
 * Default directory for central kb data: `~/.pi/kb/`
 */
function defaultGlobalDir(): string {
  return join(homedir(), ".pi", "kb");
}

export class CentralDatabase {
  private db: DatabaseSync;
  private readonly dbPath: string;
  private readonly globalDir: string;
  /** Tracks transaction nesting depth for savepoint-based nested transactions. */
  private transactionDepth = 0;

  constructor(globalDir?: string) {
    this.globalDir = globalDir ?? defaultGlobalDir();
    this.dbPath = join(this.globalDir, "kb-central.db");

    // Ensure directory exists
    if (!existsSync(this.globalDir)) {
      mkdirSync(this.globalDir, { recursive: true });
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
    this.db.exec(CENTRAL_SCHEMA_SQL);

    // Seed schemaVersion and lastModified idempotently
    this.db.exec(
      `INSERT OR IGNORE INTO __meta (key, value) VALUES ('schemaVersion', '${CENTRAL_SCHEMA_VERSION}')`,
    );
    this.db.exec(
      `INSERT OR IGNORE INTO __meta (key, value) VALUES ('lastModified', '${Date.now()}')`,
    );
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
    this.db.prepare("UPDATE __meta SET value = ? WHERE key = 'lastModified'").run(String(next));
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

  /**
   * Get the global directory path.
   */
  getGlobalDir(): string {
    return this.globalDir;
  }
}

// ── Factory Function ──────────────────────────────────────────────────────

/**
 * Create a new CentralDatabase instance (does NOT initialize schema).
 * Callers must call `db.init()` separately.
 * @param globalDir - Path to the global kb directory (e.g., `~/.pi/kb/`)
 * @returns CentralDatabase instance (not yet initialized)
 */
export function createCentralDatabase(globalDir?: string): CentralDatabase {
  return new CentralDatabase(globalDir);
}
