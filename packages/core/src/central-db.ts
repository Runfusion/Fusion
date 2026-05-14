/**
 * Central SQLite database module for fn's multi-project architecture.
 *
 * Uses Node.js built-in `node:sqlite` (DatabaseSync) for simplified
 * synchronous transaction handling. The database runs in WAL mode
 * for concurrent reader/writer access.
 *
 * This database is stored at `~/.fusion/fusion-central.db` and serves as the
 * coordination hub for all projects, storing the project registry,
 * unified activity feed, global concurrency limits, and project health.
 */

import { DatabaseSync } from "./sqlite-adapter.js";
import { join } from "node:path";
import { mkdirSync, existsSync } from "node:fs";
import type { Statement } from "./db.js";
import { resolveGlobalDir } from "./global-settings.js";

// ── JSON Helpers (reused from db.ts) ─────────────────────────────────────

import {
  toJson,
  toJsonNullable,
  fromJson,
  isSqliteLockError,
  sleepSync,
} from "./db.js";
export { toJson, toJsonNullable, fromJson };

// ── Schema Definition ───────────────────────────────────────────────────

const CENTRAL_SCHEMA_VERSION = 11;

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
  nodeId TEXT,
  settings TEXT  -- JSON ProjectSettings snapshot
);
CREATE INDEX IF NOT EXISTS idxProjectsPath ON projects(path);
CREATE INDEX IF NOT EXISTS idxProjectsStatus ON projects(status);

-- Per-project, per-node working directory mappings
CREATE TABLE IF NOT EXISTS projectNodePathMappings (
  projectId TEXT NOT NULL,
  nodeId TEXT NOT NULL,
  path TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  PRIMARY KEY (projectId, nodeId),
  FOREIGN KEY (projectId) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (nodeId) REFERENCES nodes(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idxProjectNodePathMappingsProjectId ON projectNodePathMappings(projectId);
CREATE INDEX IF NOT EXISTS idxProjectNodePathMappingsNodeId ON projectNodePathMappings(nodeId);

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

-- Central settings (single row)
CREATE TABLE IF NOT EXISTS centralSettings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  defaultProjectId TEXT,
  updatedAt TEXT NOT NULL
);
INSERT OR IGNORE INTO centralSettings (id, defaultProjectId, updatedAt)
VALUES (1, NULL, CURRENT_TIMESTAMP);

-- Nodes table (runtime hosts for project execution)
CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK (type IN ('local', 'remote')),
  url TEXT,
  apiKey TEXT,
  status TEXT NOT NULL DEFAULT 'offline',
  capabilities TEXT,
  systemMetrics TEXT,
  knownPeers TEXT,
  versionInfo TEXT,
  pluginVersions TEXT,
  dockerConfig TEXT,
  maxConcurrent INTEGER NOT NULL DEFAULT 2,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idxNodesStatus ON nodes(status);
CREATE INDEX IF NOT EXISTS idxNodesType ON nodes(type);

-- Peer nodes table (mesh awareness graph per node)
CREATE TABLE IF NOT EXISTS peerNodes (
  id TEXT PRIMARY KEY,
  nodeId TEXT NOT NULL,
  peerNodeId TEXT NOT NULL,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unknown',
  lastSeen TEXT NOT NULL,
  connectedAt TEXT NOT NULL,
  UNIQUE(nodeId, peerNodeId),
  FOREIGN KEY (nodeId) REFERENCES nodes(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idxPeerNodesNodeId ON peerNodes(nodeId);

-- Settings sync state tracking
CREATE TABLE IF NOT EXISTS settingsSyncState (
  nodeId TEXT NOT NULL,
  remoteNodeId TEXT NOT NULL,
  lastSyncedAt TEXT,
  localChecksum TEXT,
  remoteChecksum TEXT,
  syncCount INTEGER NOT NULL DEFAULT 0,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  PRIMARY KEY (nodeId, remoteNodeId),
  FOREIGN KEY (nodeId) REFERENCES nodes(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idxSettingsSyncNode ON settingsSyncState(nodeId);

-- Managed Docker nodes table (Docker-provisioned mesh nodes)
CREATE TABLE IF NOT EXISTS managedDockerNodes (
  id TEXT PRIMARY KEY,
  nodeId TEXT,
  name TEXT NOT NULL UNIQUE,
  imageName TEXT NOT NULL,
  imageTag TEXT NOT NULL,
  containerId TEXT,
  status TEXT NOT NULL DEFAULT 'creating',
  hostConfig TEXT NOT NULL DEFAULT '{}',
  envVars TEXT NOT NULL DEFAULT '{}',
  volumeMounts TEXT NOT NULL DEFAULT '[]',
  resourceSizing TEXT NOT NULL DEFAULT '{}',
  extraClis TEXT NOT NULL DEFAULT '[]',
  persistentStorage INTEGER NOT NULL DEFAULT 1,
  reachableUrl TEXT,
  apiKey TEXT,
  errorMessage TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  FOREIGN KEY (nodeId) REFERENCES nodes(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idxManagedDockerNodesStatus ON managedDockerNodes(status);
CREATE INDEX IF NOT EXISTS idxManagedDockerNodesNodeId ON managedDockerNodes(nodeId);

-- Global plugin install registry
CREATE TABLE IF NOT EXISTS plugin_installs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  description TEXT,
  author TEXT,
  homepage TEXT,
  path TEXT NOT NULL,
  settings TEXT DEFAULT '{}',
  settingsSchema TEXT,
  dependencies TEXT DEFAULT '[]',
  aiScanOnLoad INTEGER NOT NULL DEFAULT 0,
  lastSecurityScan TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);

-- Per-project plugin state
CREATE TABLE IF NOT EXISTS project_plugin_states (
  projectPath TEXT NOT NULL,
  pluginId TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'installed',
  error TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  PRIMARY KEY (projectPath, pluginId),
  FOREIGN KEY (pluginId) REFERENCES plugin_installs(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idxProjectPluginStatesProjectPath ON project_plugin_states(projectPath);
CREATE INDEX IF NOT EXISTS idxProjectPluginStatesPluginId ON project_plugin_states(pluginId);

-- Durable mesh shared-state snapshots
CREATE TABLE IF NOT EXISTS meshSharedSnapshots (
  nodeId TEXT NOT NULL,
  projectId TEXT,
  scope TEXT NOT NULL,
  payload TEXT NOT NULL,
  snapshotVersion TEXT NOT NULL,
  capturedAt TEXT NOT NULL,
  sourceNodeId TEXT,
  sourceRunId TEXT,
  staleAfter TEXT,
  updatedAt TEXT NOT NULL,
  PRIMARY KEY (nodeId, projectId, scope)
);
CREATE INDEX IF NOT EXISTS idxMeshSharedSnapshotsLookup ON meshSharedSnapshots(nodeId, projectId, scope);

-- Durable offline write queue + history
CREATE TABLE IF NOT EXISTS meshWriteQueue (
  id TEXT PRIMARY KEY,
  originNodeId TEXT NOT NULL,
  targetNodeId TEXT NOT NULL,
  projectId TEXT,
  scope TEXT NOT NULL,
  entityType TEXT NOT NULL,
  entityId TEXT NOT NULL,
  operation TEXT NOT NULL,
  payload TEXT NOT NULL,
  intentVersion TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'replaying', 'applied', 'failed')),
  attemptCount INTEGER NOT NULL DEFAULT 0,
  lastAttemptAt TEXT,
  lastError TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  appliedAt TEXT
);
CREATE INDEX IF NOT EXISTS idxMeshWriteQueueReplay ON meshWriteQueue(targetNodeId, status, createdAt, id);

-- Schema version tracking
CREATE TABLE IF NOT EXISTS __meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
`;

const CENTRAL_SCHEMA_V2_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK (type IN ('local', 'remote')),
  url TEXT,
  apiKey TEXT,
  status TEXT NOT NULL DEFAULT 'offline',
  capabilities TEXT,
  maxConcurrent INTEGER NOT NULL DEFAULT 2,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idxNodesStatus ON nodes(status);
CREATE INDEX IF NOT EXISTS idxNodesType ON nodes(type);
`;

const CENTRAL_SCHEMA_V3_MIGRATION_SQL = `
ALTER TABLE nodes ADD COLUMN systemMetrics TEXT;
ALTER TABLE nodes ADD COLUMN knownPeers TEXT;
CREATE TABLE IF NOT EXISTS peerNodes (
  id TEXT PRIMARY KEY,
  nodeId TEXT NOT NULL,
  peerNodeId TEXT NOT NULL,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unknown',
  lastSeen TEXT NOT NULL,
  connectedAt TEXT NOT NULL,
  UNIQUE(nodeId, peerNodeId),
  FOREIGN KEY (nodeId) REFERENCES nodes(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idxPeerNodesNodeId ON peerNodes(nodeId);
`;

const CENTRAL_SCHEMA_V3_CREATE_PEERS_SQL = CENTRAL_SCHEMA_V3_MIGRATION_SQL
  .split("\n")
  .filter((line) => !line.trim().startsWith("ALTER TABLE nodes ADD COLUMN"))
  .join("\n");

// V4 migration is applied inline via ALTER TABLE checks (see runMigrations).

const CENTRAL_SCHEMA_V5_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS settingsSyncState (
  nodeId TEXT NOT NULL,
  remoteNodeId TEXT NOT NULL,
  lastSyncedAt TEXT,
  localChecksum TEXT,
  remoteChecksum TEXT,
  syncCount INTEGER NOT NULL DEFAULT 0,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  PRIMARY KEY (nodeId, remoteNodeId),
  FOREIGN KEY (nodeId) REFERENCES nodes(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idxSettingsSyncNode ON settingsSyncState(nodeId);
`;

const CENTRAL_SCHEMA_V6_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS managedDockerNodes (
  id TEXT PRIMARY KEY,
  nodeId TEXT,
  name TEXT NOT NULL UNIQUE,
  imageName TEXT NOT NULL,
  imageTag TEXT NOT NULL,
  containerId TEXT,
  status TEXT NOT NULL DEFAULT 'creating',
  hostConfig TEXT NOT NULL DEFAULT '{}',
  envVars TEXT NOT NULL DEFAULT '{}',
  volumeMounts TEXT NOT NULL DEFAULT '[]',
  resourceSizing TEXT NOT NULL DEFAULT '{}',
  extraClis TEXT NOT NULL DEFAULT '[]',
  persistentStorage INTEGER NOT NULL DEFAULT 1,
  reachableUrl TEXT,
  apiKey TEXT,
  errorMessage TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  FOREIGN KEY (nodeId) REFERENCES nodes(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idxManagedDockerNodesStatus ON managedDockerNodes(status);
CREATE INDEX IF NOT EXISTS idxManagedDockerNodesNodeId ON managedDockerNodes(nodeId);
`;

// V7 migration adds dockerConfig persistence to nodes for Docker-managed runtime config updates.

const CENTRAL_SCHEMA_V8_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS projectNodePathMappings (
  projectId TEXT NOT NULL,
  nodeId TEXT NOT NULL,
  path TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  PRIMARY KEY (projectId, nodeId),
  FOREIGN KEY (projectId) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (nodeId) REFERENCES nodes(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idxProjectNodePathMappingsProjectId ON projectNodePathMappings(projectId);
CREATE INDEX IF NOT EXISTS idxProjectNodePathMappingsNodeId ON projectNodePathMappings(nodeId);
`;

const CENTRAL_SCHEMA_V9_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS plugin_installs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  description TEXT,
  author TEXT,
  homepage TEXT,
  path TEXT NOT NULL,
  settings TEXT DEFAULT '{}',
  settingsSchema TEXT,
  dependencies TEXT DEFAULT '[]',
  aiScanOnLoad INTEGER NOT NULL DEFAULT 0,
  lastSecurityScan TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_plugin_states (
  projectPath TEXT NOT NULL,
  pluginId TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'installed',
  error TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  PRIMARY KEY (projectPath, pluginId),
  FOREIGN KEY (pluginId) REFERENCES plugin_installs(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idxProjectPluginStatesProjectPath ON project_plugin_states(projectPath);
CREATE INDEX IF NOT EXISTS idxProjectPluginStatesPluginId ON project_plugin_states(pluginId);
`;

const CENTRAL_SCHEMA_V10_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS meshSharedSnapshots (
  nodeId TEXT NOT NULL,
  projectId TEXT,
  scope TEXT NOT NULL,
  payload TEXT NOT NULL,
  snapshotVersion TEXT NOT NULL,
  capturedAt TEXT NOT NULL,
  sourceNodeId TEXT,
  sourceRunId TEXT,
  staleAfter TEXT,
  updatedAt TEXT NOT NULL,
  PRIMARY KEY (nodeId, projectId, scope)
);
CREATE INDEX IF NOT EXISTS idxMeshSharedSnapshotsLookup ON meshSharedSnapshots(nodeId, projectId, scope);

CREATE TABLE IF NOT EXISTS meshWriteQueue (
  id TEXT PRIMARY KEY,
  originNodeId TEXT NOT NULL,
  targetNodeId TEXT NOT NULL,
  projectId TEXT,
  scope TEXT NOT NULL,
  entityType TEXT NOT NULL,
  entityId TEXT NOT NULL,
  operation TEXT NOT NULL,
  payload TEXT NOT NULL,
  intentVersion TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'replaying', 'applied', 'failed')),
  attemptCount INTEGER NOT NULL DEFAULT 0,
  lastAttemptAt TEXT,
  lastError TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  appliedAt TEXT
);
CREATE INDEX IF NOT EXISTS idxMeshWriteQueueReplay ON meshWriteQueue(targetNodeId, status, createdAt, id);
`;

const CENTRAL_SCHEMA_V11_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS centralSettings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  defaultProjectId TEXT,
  updatedAt TEXT NOT NULL
);
INSERT OR IGNORE INTO centralSettings (id, defaultProjectId, updatedAt)
VALUES (1, NULL, CURRENT_TIMESTAMP);
`;

// ── Central Database Class ────────────────────────────────────────────────

export class CentralDatabase {
  private db: DatabaseSync;
  private readonly dbPath: string;
  private readonly globalDir: string;
  /** Tracks transaction nesting depth for savepoint-based nested transactions. */
  private transactionDepth = 0;
  private readonly busyTimeoutMs: number;
  private readonly lockRecoveryWindowMs: number;
  private readonly lockRecoveryDelayMs: number;

  constructor(
    globalDir?: string,
    options?: { busyTimeoutMs?: number; lockRecoveryWindowMs?: number; lockRecoveryDelayMs?: number },
  ) {
    this.globalDir = resolveGlobalDir(globalDir);
    this.dbPath = join(this.globalDir, "fusion-central.db");
    this.busyTimeoutMs = Math.max(0, options?.busyTimeoutMs ?? 5_000);
    this.lockRecoveryWindowMs = Math.max(0, options?.lockRecoveryWindowMs ?? 1_000);
    this.lockRecoveryDelayMs = Math.max(1, options?.lockRecoveryDelayMs ?? 50);

    // Ensure directory exists
    if (!existsSync(this.globalDir)) {
      mkdirSync(this.globalDir, { recursive: true });
    }

    try {
      this.db = new DatabaseSync(this.dbPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to open Fusion central database at ${this.dbPath}: ${message}`);
    }

    // Wait up to the configured timeout for locks to clear before returning SQLITE_BUSY.
    // Set this before other PRAGMAs so they also benefit.
    this.db.exec(`PRAGMA busy_timeout = ${this.busyTimeoutMs}`);
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

    const currentVersion = this.getSchemaVersion();
    let migrated = false;

    if (currentVersion < 2) {
      this.db.exec(CENTRAL_SCHEMA_V2_MIGRATION_SQL);
      if (!this.hasColumn("projects", "nodeId")) {
        this.db.exec("ALTER TABLE projects ADD COLUMN nodeId TEXT");
      }
      migrated = true;
    }

    if (currentVersion < 3) {
      if (!this.hasColumn("nodes", "systemMetrics")) {
        this.db.exec("ALTER TABLE nodes ADD COLUMN systemMetrics TEXT");
      }
      if (!this.hasColumn("nodes", "knownPeers")) {
        this.db.exec("ALTER TABLE nodes ADD COLUMN knownPeers TEXT");
      }
      this.db.exec(CENTRAL_SCHEMA_V3_CREATE_PEERS_SQL);
      migrated = true;
    }

    if (currentVersion < 4) {
      if (!this.hasColumn("nodes", "versionInfo")) {
        this.db.exec("ALTER TABLE nodes ADD COLUMN versionInfo TEXT");
      }
      if (!this.hasColumn("nodes", "pluginVersions")) {
        this.db.exec("ALTER TABLE nodes ADD COLUMN pluginVersions TEXT");
      }
      migrated = true;
    }

    if (currentVersion < 5) {
      this.db.exec(CENTRAL_SCHEMA_V5_MIGRATION_SQL);
      migrated = true;
    }

    if (currentVersion < 6) {
      this.db.exec(CENTRAL_SCHEMA_V6_MIGRATION_SQL);
      migrated = true;
    }

    if (currentVersion < 7) {
      if (!this.hasColumn("nodes", "dockerConfig")) {
        this.db.exec("ALTER TABLE nodes ADD COLUMN dockerConfig TEXT");
      }
      migrated = true;
    }

    if (currentVersion < 8) {
      this.db.exec(CENTRAL_SCHEMA_V8_MIGRATION_SQL);

      const localNodeRow = this.db
        .prepare("SELECT id FROM nodes WHERE type = 'local' ORDER BY createdAt ASC LIMIT 1")
        .get() as { id: string } | undefined;

      if (localNodeRow) {
        this.db.prepare(
          `INSERT OR IGNORE INTO projectNodePathMappings (projectId, nodeId, path, createdAt, updatedAt)
           SELECT id, ?, path, createdAt, updatedAt
           FROM projects`
        ).run(localNodeRow.id);

        this.db.prepare(
          `UPDATE projectNodePathMappings
           SET path = (
             SELECT projects.path
             FROM projects
             WHERE projects.id = projectNodePathMappings.projectId
           ),
           updatedAt = (
             SELECT projects.updatedAt
             FROM projects
             WHERE projects.id = projectNodePathMappings.projectId
           )
           WHERE nodeId = ?`
        ).run(localNodeRow.id);
      }

      migrated = true;
    }

    if (currentVersion < 9) {
      this.db.exec(CENTRAL_SCHEMA_V9_MIGRATION_SQL);
      migrated = true;
    }

    if (currentVersion < 10) {
      this.db.exec(CENTRAL_SCHEMA_V10_MIGRATION_SQL);
      migrated = true;
    }

    if (currentVersion < 11) {
      this.db.exec(CENTRAL_SCHEMA_V11_MIGRATION_SQL);
      migrated = true;
    }

    if (migrated) {
      this.db
        .prepare("INSERT INTO __meta (key, value) VALUES ('schemaVersion', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(String(CENTRAL_SCHEMA_VERSION));
    } else {
      this.db.exec(
        `INSERT OR IGNORE INTO __meta (key, value) VALUES ('schemaVersion', '${CENTRAL_SCHEMA_VERSION}')`,
      );
    }

    // Seed lastModified idempotently
    this.db.exec(
      `INSERT OR IGNORE INTO __meta (key, value) VALUES ('lastModified', '${Date.now()}')`,
    );
  }

  private hasColumn(table: string, column: string): boolean {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return rows.some((row) => row.name === column);
  }

  /**
   * Close the database connection.
   */
  close(): void {
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
   */
  transaction<T>(fn: () => T): T {
    const depth = this.transactionDepth++;
    const isOutermost = depth === 0;
    const savepointName = `sp_${depth}`;

    try {
      if (isOutermost) {
        this.runWithLockRecovery("BEGIN IMMEDIATE", () => {
          this.db.exec("BEGIN IMMEDIATE");
        });
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
 * @param globalDir - Path to the global fusion directory (e.g., `~/.fusion/`)
 * @returns CentralDatabase instance (not yet initialized)
 */
export function createCentralDatabase(globalDir?: string): CentralDatabase {
  return new CentralDatabase(globalDir);
}
