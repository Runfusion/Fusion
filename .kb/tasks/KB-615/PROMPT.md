# Task: KB-615 - Multi-Project Core Infrastructure

**Created:** 2026-03-31
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** Foundational infrastructure for multi-project support. Creates central SQLite database and registry APIs. High pattern alignment with existing `db.ts` and `store.ts`. Security considerations around path validation. Reversible by design (additive only).
**Score:** 5/8 — Blast radius: 1, Pattern novelty: 1, Security: 2, Reversibility: 1

## Mission

Create the central infrastructure for kb's multi-project architecture. Build a system-wide SQLite database at `~/.pi/kb/kb-central.db` that serves as the coordination hub for all projects. Implement the `CentralCore` class as the primary API for project registration, unified activity logging, global concurrency management, and project health tracking across all registered projects.

## Dependencies

- **None** (foundational infrastructure)

## Context to Read First

- `packages/core/src/db.ts` — SQLite patterns (WAL mode, transactions, JSON helpers, schema migrations)
- `packages/core/src/store.ts` — TaskStore patterns (EventEmitter, async init/close lifecycle, rowToTask conversion)
- `packages/core/src/global-settings.ts` — Global settings store patterns (`~/.pi/kb/` directory handling)
- `packages/core/src/types.ts` — ActivityLogEntry, ProjectSettings, and other existing types
- `packages/core/src/index.ts` — Export patterns
- `packages/core/src/db.test.ts` — Test patterns for database classes

## File Scope

### New Files
- `packages/core/src/central-db.ts` — CentralDatabase class (SQLite wrapper for central DB)
- `packages/core/src/central-core.ts` — CentralCore class (main API for central operations)
- `packages/core/test/central-core.test.ts` — Unit tests for CentralCore

### Modified Files
- `packages/core/src/types.ts` — Add `RegisteredProject`, `ActivityFeedEntry`, `ProjectHealth` types
- `packages/core/src/index.ts` — Export new types and classes

## Steps

### Step 1: Extend Types for Central Infrastructure

Add new types to `packages/core/src/types.ts`:

- [ ] Add `ProjectStatus` type union: `'active' | 'paused' | 'errored'`
- [ ] Add `IsolationMode` type union: `'in-process' | 'child-process'`
- [ ] Add `RegisteredProject` interface:
  ```typescript
  export interface RegisteredProject {
    id: string;                    // Unique project ID (e.g., "proj-abc123")
    name: string;                  // Display name
    workingDirectory: string;      // Absolute path to project root
    status: ProjectStatus;
    isolationMode: IsolationMode;
    createdAt: string;             // ISO-8601
    updatedAt: string;             // ISO-8601
    lastActivityAt?: string;       // ISO-8601
  }
  ```
- [ ] Add `ProjectHealth` interface:
  ```typescript
  export interface ProjectHealth {
    projectId: string;
    status: ProjectStatus;
    inFlightTasks: number;         // Tasks currently in-progress
    lastActivity?: string;         // ISO-8601
    cpuUsage?: number;             // Percentage 0-100
    memoryUsage?: number;          // MB
    updatedAt: string;              // ISO-8601
  }
  ```
- [ ] Add `ActivityFeedEntry` interface (central activity feed with project attribution):
  ```typescript
  export interface ActivityFeedEntry {
    id: string;
    timestamp: string;
    type: ActivityEventType;
    projectId: string;             // Which project this event belongs to
    taskId?: string;
    taskTitle?: string;
    message: string;
    metadata?: Record<string, unknown>;
  }
  ```
- [ ] Add `GlobalConfig` interface for system-wide settings:
  ```typescript
  export interface GlobalConfig {
    maxConcurrentAgents: number;   // System-wide limit (default: 4)
    updatedAt: string;
  }
  ```
- [ ] Run targeted build check: `pnpm build packages/core`

**Artifacts:**
- `packages/core/src/types.ts` (modified — new types added)

**Commit:** `feat(KB-615): extend types for multi-project central infrastructure`

### Step 2: Create Central Database Module

Create `packages/core/src/central-db.ts` following patterns from `db.ts`:

- [ ] Create `CentralDatabase` class:
  - Database path: `~/.pi/kb/kb-central.db` (use `defaultGlobalDir()` pattern from `global-settings.ts`)
  - Use `node:sqlite` `DatabaseSync` with WAL mode enabled
  - Enable foreign key enforcement
  - Support nested transactions via savepoints (copy pattern from `db.ts`)
- [ ] Define schema SQL for the central database:
  ```sql
  -- Projects registry table
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    workingDirectory TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'active',
    isolationMode TEXT NOT NULL DEFAULT 'in-process',
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL,
    lastActivityAt TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_projects_workingDirectory ON projects(workingDirectory);
  CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);

  -- Unified activity feed across all projects
  CREATE TABLE IF NOT EXISTS activityFeed (
    id TEXT PRIMARY KEY,
    timestamp TEXT NOT NULL,
    type TEXT NOT NULL,
    projectId TEXT NOT NULL,
    taskId TEXT,
    taskTitle TEXT,
    message TEXT NOT NULL,
    metadata TEXT,  -- JSON
    FOREIGN KEY (projectId) REFERENCES projects(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_activityFeed_timestamp ON activityFeed(timestamp);
  CREATE INDEX IF NOT EXISTS idx_activityFeed_type ON activityFeed(type);
  CREATE INDEX IF NOT EXISTS idx_activityFeed_projectId ON activityFeed(projectId);

  -- Global system configuration (single row)
  CREATE TABLE IF NOT EXISTS globalConfig (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    maxConcurrentAgents INTEGER DEFAULT 4,
    updatedAt TEXT
  );
  INSERT OR IGNORE INTO globalConfig (id, maxConcurrentAgents) VALUES (1, 4);

  -- Project health tracking (updated frequently)
  CREATE TABLE IF NOT EXISTS projectHealth (
    projectId TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    inFlightTasks INTEGER DEFAULT 0,
    lastActivity TEXT,
    cpuUsage INTEGER,  -- 0-100
    memoryUsage INTEGER,  -- MB
    updatedAt TEXT NOT NULL,
    FOREIGN KEY (projectId) REFERENCES projects(id) ON DELETE CASCADE
  );

  -- Schema version tracking
  CREATE TABLE IF NOT EXISTS __meta (
    key TEXT PRIMARY KEY,
    value TEXT
  );
  ```
- [ ] Implement `init()` method:
  - Create tables if not exist
  - Seed `__meta` with `schemaVersion` = 1
  - Seed `globalConfig` with defaults
- [ ] Implement `transaction<T>(fn: () => T): T` with savepoint support (copy from `db.ts`)
- [ ] Implement `prepare(sql: string)` and `exec(sql: string)` methods
- [ ] Implement `close(): void` to close database connection
- [ ] Implement `getSchemaVersion(): number` from `__meta` table
- [ ] Implement `getLastModified(): number` and `bumpLastModified(): void` for change detection
- [ ] Export `createCentralDatabase(globalDir?: string): CentralDatabase` factory function
- [ ] Export `toJson`, `toJsonNullable`, `fromJson` helpers (re-export from `db.ts` or copy)

**Artifacts:**
- `packages/core/src/central-db.ts` (new)

**Commit:** `feat(KB-615): create central database module with multi-project schema`

### Step 3: Implement CentralCore API Class

Create `packages/core/src/central-core.ts` as the main API:

- [ ] Import types: `RegisteredProject`, `ProjectHealth`, `ActivityFeedEntry`, `ActivityEventType`, `ProjectStatus`, `IsolationMode`
- [ ] Import `CentralDatabase`, `createCentralDatabase` from `./central-db.js`
- [ ] Import `defaultGlobalDir` pattern from `./global-settings.js`
- [ ] Import `randomUUID` from `node:crypto` for generating project IDs
- [ ] Import `existsSync` from `node:fs` for path validation
- [ ] Import `resolve` from `node:path` to ensure absolute paths
- [ ] Create `CentralCore` class extending `EventEmitter`:
  ```typescript
  export interface CentralCoreEvents {
    'project:registered': [project: RegisteredProject];
    'project:unregistered': [projectId: string];
    'project:updated': [project: RegisteredProject];
    'project:health:changed': [health: ProjectHealth];
    'activity:recorded': [entry: ActivityFeedEntry];
  }
  ```
- [ ] Constructor accepts optional `globalDir?: string` (defaults to `~/.pi/kb/`)
- [ ] `async init(): Promise<void>` — ensures directory exists, initializes database
- [ ] `async close(): Promise<void>` — closes database connection

**Project Registry API:**
- [ ] `async registerProject(name: string, workingDir: string, options?: { isolationMode?: IsolationMode }): Promise<RegisteredProject>`:
  - Validate `workingDir` is absolute path using `resolve()`
  - Validate `workingDir` directory exists using `existsSync()`
  - Validate `workingDir` is not already registered (check unique constraint)
  - Validate `workingDir` contains a `.fusion/` subdirectory (valid kb project)
  - Validate `name` is non-empty and unique
  - Generate unique ID using `randomUUID()` (e.g., `proj-${uuid}`)
  - Set defaults: `status: 'active'`, `isolationMode: options?.isolationMode ?? 'in-process'`
  - Insert into `projects` table within transaction
  - Initialize `projectHealth` row with defaults
  - Emit `'project:registered'` event
  - Return the created `RegisteredProject`
- [ ] `async unregisterProject(id: string): Promise<void>`:
  - Delete from `projects` table (cascade deletes health and activity entries)
  - Emit `'project:unregistered'` event
  - Silently succeed if project doesn't exist
- [ ] `async listProjects(): Promise<RegisteredProject[]>`:
  - Query all projects from `projects` table
  - Parse JSON columns, return array ordered by `createdAt` ASC
- [ ] `async getProject(id: string): Promise<RegisteredProject | undefined>`:
  - Query by ID, return undefined if not found
- [ ] `async getProjectByPath(workingDir: string): Promise<RegisteredProject | undefined>`:
  - Query by `workingDirectory`, return undefined if not found
- [ ] `async updateProjectStatus(id: string, status: ProjectStatus): Promise<RegisteredProject>`:
  - Update `status` and `updatedAt` timestamp
  - Emit `'project:updated'` event
  - Throw if project not found

**Project Health API:**
- [ ] `async updateProjectHealth(projectId: string, updates: Partial<Omit<ProjectHealth, 'projectId' | 'updatedAt'>>): Promise<ProjectHealth>`:
  - Get current health, merge updates, write back with new `updatedAt`
  - Insert if not exists (upsert pattern)
  - Emit `'project:health:changed'` if status or inFlightTasks changed
  - Return updated `ProjectHealth`
- [ ] `async getProjectHealth(projectId: string): Promise<ProjectHealth | undefined>`:
  - Query `projectHealth` table by projectId
  - Return undefined if not found
- [ ] `async listAllHealth(): Promise<ProjectHealth[]>`:
  - Query all health records, return array

**Unified Activity Feed API:**
- [ ] `async recordActivity(projectId: string, event: Omit<ActivityFeedEntry, 'id' | 'timestamp' | 'projectId'>): Promise<ActivityFeedEntry>`:
  - Generate unique ID: `${Date.now()}-${randomUUID().slice(0, 8)}`
  - Set `timestamp` to `new Date().toISOString()`
  - Insert into `activityFeed` table
  - Update project's `lastActivityAt` timestamp in `projects` table
  - Emit `'activity:recorded'` event
  - Return full `ActivityFeedEntry`
- [ ] `async getActivityFeed(options?: { limit?: number; projectId?: string; since?: string; type?: ActivityEventType }): Promise<ActivityFeedEntry[]>`:
  - Build SQL query with optional filters
  - Default `limit` to 100 if not specified
  - Order by `timestamp` DESC (newest first)
  - Filter by `projectId` if provided
  - Filter by `since` timestamp if provided
  - Filter by `type` if provided
  - Parse JSON metadata column, return array

**Global Concurrency API:**
- [ ] `async getGlobalConcurrencyLimit(): Promise<number>`:
  - Query `globalConfig` table, return `maxConcurrentAgents` (default 4)
- [ ] `async setGlobalConcurrencyLimit(n: number): Promise<void>`:
  - Validate n is positive integer
  - Update `globalConfig` table with new value and `updatedAt`

**Utility Methods:**
- [ ] `getDatabasePath(): string` — returns full path to `kb-central.db`
- [ ] `async getStats(): Promise<{ projectCount: number; totalActivities: number; dbSizeBytes: number }>`:
  - Query counts from `projects` and `activityFeed` tables
  - Get database file size (use `fs/promises` `stat`)

**Artifacts:**
- `packages/core/src/central-core.ts` (new)

**Commit:** `feat(KB-615): implement CentralCore class with project registry, health, and activity APIs`

### Step 4: Export New Public API

Update `packages/core/src/index.ts`:

- [ ] Add exports for new types:
  ```typescript
  export type { 
    RegisteredProject, 
    ProjectHealth, 
    ActivityFeedEntry,
    ProjectStatus,
    IsolationMode,
    GlobalConfig,
  } from "./types.js";
  ```
- [ ] Add exports for new classes:
  ```typescript
  export { CentralCore } from "./central-core.js";
  export type { CentralCoreEvents } from "./central-core.js";
  export { CentralDatabase, createCentralDatabase } from "./central-db.js";
  ```
- [ ] Run build check: `pnpm build packages/core` — must pass with zero errors

**Artifacts:**
- `packages/core/src/index.ts` (modified)

**Commit:** `feat(KB-615): export new central infrastructure types and classes`

### Step 5: Write Unit Tests

Create `packages/core/test/central-core.test.ts`:

- [ ] Test setup:
  - Create temporary directory for each test using `mkdtempSync`
  - Initialize `CentralCore` with temp directory as `globalDir`
  - Close and cleanup after each test
- [ ] Test project registration:
  - Success case: register valid project with `.fusion/` subdirectory
  - Reject non-existent working directory
  - Reject relative paths (must be absolute)
  - Reject duplicate working directory
  - Reject duplicate project name
  - Reject non-kb directory (no `.fusion/` subdirectory)
  - Auto-generate unique project ID
  - Default isolationMode is 'in-process'
  - Event `'project:registered'` fired
- [ ] Test project unregistration:
  - Remove project and cascade delete health/activity
  - Event `'project:unregistered'` fired
  - Idempotent (no error if already unregistered)
- [ ] Test project queries:
  - `getProject` returns undefined for unknown ID
  - `getProject` returns project for valid ID
  - `getProjectByPath` returns project for valid path
  - `listProjects` returns empty array initially
  - `listProjects` returns all registered projects
- [ ] Test project status updates:
  - Update status to 'paused', 'errored', 'active'
  - Event `'project:updated'` fired
  - Updated `updatedAt` timestamp
- [ ] Test project health:
  - Initialize on project registration (zero values)
  - Update health metrics (inFlightTasks, cpuUsage, memoryUsage)
  - Get health for project
  - List all health records
  - Event `'project:health:changed'` fired when status/inFlightTasks change
- [ ] Test unified activity feed:
  - Record activity for project
  - Auto-generate entry ID and timestamp
  - Update project `lastActivityAt` on record
  - Get activity feed (default limit 100)
  - Filter by projectId
  - Filter by since timestamp
  - Filter by type
  - Event `'activity:recorded'` fired
- [ ] Test global concurrency:
  - Default limit is 4
  - Set new limit (valid positive integer)
  - Reject invalid limits (zero, negative, non-integer)
- [ ] Test lifecycle:
  - Init creates directory and database
  - Close closes database connection
  - Database file exists at expected path
- [ ] Run tests: `pnpm test packages/core/test/central-core.test.ts` — all must pass

**Artifacts:**
- `packages/core/test/central-core.test.ts` (new)

**Commit:** `test(KB-615): add unit tests for CentralCore`

### Step 6: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run core package tests: `pnpm test packages/core`
  - All existing tests must pass
  - New CentralCore tests must pass
- [ ] Run full build: `pnpm build`
  - No TypeScript errors in any package
- [ ] Verify exports:
  ```typescript
  // Quick verification in Node REPL or test file
  import { CentralCore, CentralDatabase, RegisteredProject, ProjectHealth, ActivityFeedEntry } from '@fusion/core';
  // All should import without errors
  ```
- [ ] Verify database schema:
  - Create CentralCore instance
  - Register a test project
  - Check `~/.pi/kb/kb-central.db` exists (or temp location in tests)
  - Verify tables: `projects`, `activityFeed`, `globalConfig`, `projectHealth`, `__meta`

**Commit:** `test(KB-615): verification complete — all tests passing`

### Step 7: Documentation & Delivery

- [ ] Add JSDoc comments to all public methods in `central-core.ts` and `central-db.ts` if not already present
- [ ] Update `AGENTS.md` with new section under "Architecture":
  - Add "Multi-Project Central Infrastructure" subsection
  - Document `~/.pi/kb/kb-central.db` location and purpose
  - List tables: `projects`, `activityFeed`, `globalConfig`, `projectHealth`
  - Explain `CentralCore` API at high level
  - Note: This is foundational for upcoming multi-project features (KB-616, KB-618, KB-619, KB-620)
- [ ] Create changeset for the feature:
  ```bash
  cat > .changeset/central-core-infrastructure.md << 'EOF'
  ---
  "@fusion/core": minor
  ---

  Add central core infrastructure for multi-project support

  - New CentralCore class for system-wide coordination
  - Central SQLite database at ~/.pi/kb/kb-central.db
  - Project registry with CRUD operations
  - Unified activity feed across all projects
  - Global concurrency limits management
  - Project health tracking
  EOF
  ```
- [ ] Include changeset in commit
- [ ] Out-of-scope findings: Create tasks via `task_create` for any discovered issues not in scope

**Commit:** `docs(KB-615): update AGENTS.md and add changeset`

## Documentation Requirements

**Must Update:**
- `packages/core/src/types.ts` — Add new type definitions
- `packages/core/src/index.ts` — Export new public API
- `AGENTS.md` — Add section documenting:
  - Central database purpose and location (`~/.pi/kb/kb-central.db`)
  - Project registry schema
  - Unified activity feed vs per-project activity log
  - Global concurrency management
  - Integration with upcoming multi-project runtime (KB-616)

**Check If Affected:**
- `packages/core/package.json` — No changes expected
- Other packages — No changes expected (additive only)

## Completion Criteria

- [ ] All types defined and exported (`RegisteredProject`, `ProjectHealth`, `ActivityFeedEntry`, `ProjectStatus`, `IsolationMode`, `GlobalConfig`)
- [ ] `CentralDatabase` class implemented with full schema and WAL mode
- [ ] `CentralCore` class implemented with all API methods
- [ ] Project registry functional (register, unregister, get, list, update status)
- [ ] Project health tracking functional (update, query, list all)
- [ ] Unified activity feed functional (record, query with filters)
- [ ] Global concurrency API functional (get/set limits)
- [ ] All unit tests passing for CentralCore
- [ ] All existing tests still passing
- [ ] Build passes with no TypeScript errors
- [ ] Documentation updated in AGENTS.md
- [ ] Changeset created

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-615): complete Step N — description`
  - Example: `feat(KB-615): complete Step 1 — extend types for multi-project`
- **Bug fixes:** `fix(KB-615): description`
- **Tests:** `test(KB-615): description`
- **Docs:** `docs(KB-615): description`

## Do NOT

- Modify existing TaskStore behavior — should remain unchanged
- Break single-project mode — existing code works as-is
- Skip path validation in project registration — must validate absolute paths and `.fusion/` subdirectory
- Allow duplicate project names or working directories
- Skip event emission — consumers depend on events for reactivity
- Use central database for per-project task storage — projects keep their own `.fusion/fusion.db`
- Remove or deprecate existing exports without migration path
- Store sensitive credentials in the central database
- Skip cleanup of test databases — always close and remove temp directories in tests

## Security Considerations

- Validate project paths exist and are absolute before registration
- Validate path contains `.fusion/` subdirectory (valid kb project)
- Use parameterized queries throughout (SQL injection prevention)
- Validate `isolationMode` is only 'in-process' or 'child-process'
- Don't store credentials in central database
- Cascade delete project data on unregister to prevent orphaned data

## Performance Considerations

- Central database uses WAL mode for concurrent reader/writer access
- Activity feed queries are indexed by timestamp, type, and projectId
- Health updates are lightweight (small row updates)
- Lazy initialization — CentralCore doesn't connect until `init()` called

## API Reference for Dependent Tasks

**KB-616 expects these CentralCore APIs:**

```typescript
// Project registry
getProject(id: string): Promise<RegisteredProject | undefined>
listProjects(): Promise<RegisteredProject[]>
updateProjectStatus(id: string, status: ProjectStatus): Promise<RegisteredProject>

// Health tracking
updateProjectHealth(projectId: string, updates: Partial<ProjectHealth>): Promise<ProjectHealth>
getProjectHealth(projectId: string): Promise<ProjectHealth | undefined>

// Events
on('project:updated', handler)
on('project:health:changed', handler)
```

**Type definitions needed by KB-616:**

```typescript
type IsolationMode = 'in-process' | 'child-process'
type ProjectStatus = 'active' | 'paused' | 'errored'
interface RegisteredProject {
  id: string
  name: string
  workingDirectory: string
  status: ProjectStatus
  isolationMode: IsolationMode
  // ... other fields
}
```
