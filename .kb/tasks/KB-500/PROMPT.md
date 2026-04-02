# Task: KB-500 - Core Infrastructure: Central database, project registry, unified activity feed

**Created:** 2026-03-31
**Size:** L

## Review Level: 3 (Full)

**Assessment:** This is foundational infrastructure that creates the central coordination layer for multi-project support. High blast radius as it introduces a new database and API surface. Security implications around project path validation. Pattern novelty in centralizing activity feed and global concurrency across projects.
**Score:** 7/8 — Blast radius: 2, Pattern novelty: 2, Security: 2, Reversibility: 1

## Mission

Create the core central infrastructure for kb's multi-project architecture. Build a system-wide SQLite database at `~/.pi/kb/kb-central.db` that serves as the coordination hub for all projects. This database will store the project registry, a unified activity feed across all projects, global concurrency limits, and project health tracking.

The `CentralCore` class will be the primary API for interacting with this central database, providing project registration, health tracking, unified activity logging, and global concurrency management that spans across all registered projects.

## Dependencies

- **None** (foundational infrastructure task)

## Context to Read First

- `packages/core/src/db.ts` — SQLite database patterns (WAL mode, transactions, JSON helpers)
- `packages/core/src/store.ts` — TaskStore patterns (EventEmitter, init/close lifecycle)
- `packages/core/src/global-settings.ts` — Global settings store patterns (`~/.pi/kb/` directory)
- `packages/core/src/types.ts` — ActivityLogEntry, Settings, and other types
- `packages/core/src/index.ts` — Export patterns for new types
- `packages/engine/src/concurrency.ts` — AgentSemaphore patterns for concurrency control

## File Scope

### New Files
- `packages/core/src/central-db.ts` — CentralDatabase class (SQLite wrapper for central DB)
- `packages/core/src/central-core.ts` — CentralCore class (main API for central operations)
- `packages/core/src/central-core.test.ts` — Comprehensive tests for CentralCore
- `packages/core/src/types.ts` (modify) — Add `RegisteredProject`, `IsolationMode`, `ProjectStatus`, `CentralActivityLogEntry`, `ProjectHealth` types

### Modified Files
- `packages/core/src/index.ts` — Export new types and classes

## Steps

### Step 1: Extend Types for Multi-Project Support

Add new types to `packages/core/src/types.ts` for the multi-project architecture:

- [ ] Add `IsolationMode` type: `'in-process' | 'child-process'`
- [ ] Add `ProjectStatus` type: `'active' | 'paused' | 'errored' | 'initializing'`
- [ ] Add `RegisteredProject` interface:
  ```typescript
  export interface RegisteredProject {
    id: string;                    // Unique project ID (e.g., "proj_abc123")
    name: string;                  // Display name
    path: string;                  // Absolute path to project directory
    status: ProjectStatus;
    isolationMode: IsolationMode;
    createdAt: string;             // ISO-8601
    updatedAt: string;             // ISO-8601
    lastActivityAt?: string;       // ISO-8601
    settings?: ProjectSettings;    // Cached project settings snapshot
  }
  ```
- [ ] Add `ProjectHealth` interface:
  ```typescript
  export interface ProjectHealth {
    projectId: string;
    status: ProjectStatus;
    activeTaskCount: number;
    inFlightAgentCount: number;
    lastActivityAt?: string;
    lastErrorAt?: string;
    lastErrorMessage?: string;
    totalTasksCompleted: number;
    totalTasksFailed: number;
    averageTaskDurationMs?: number;
  }
  ```
- [ ] Add `CentralActivityLogEntry` interface (extends ActivityLogEntry with project attribution):
  ```typescript
  export interface CentralActivityLogEntry {
    id: string;
    timestamp: string;
    type: ActivityEventType;
    projectId: string;             // Which project this event belongs to
    projectName: string;           // Denormalized for display
    taskId?: string;
    taskTitle?: string;
    details: string;
    metadata?: Record<string, unknown>;
  }
  ```
- [ ] Add `GlobalConcurrencyState` interface:
  ```typescript
  export interface GlobalConcurrencyState {
    globalMaxConcurrent: number;   // System-wide limit (default: 4)
    currentlyActive: number;       // Active agents across all projects
    queuedCount: number;           // Tasks waiting for concurrency slots
    projectsActive: Record<string, number>; // Per-project active count
  }
  ```
- [ ] Run targeted tests to ensure types compile: `pnpm build packages/core`

**Artifacts:**
- `packages/core/src/types.ts` (modified)

### Step 2: Create Central Database Module

Create `packages/core/src/central-db.ts` following the patterns in `db.ts`:

- [ ] Create `CentralDatabase` class:
  - Database path: `~/.pi/kb/kb-central.db` (join with `defaultGlobalDir()` pattern)
  - Use `node:sqlite` `DatabaseSync` with WAL mode
  - Same transaction support as `Database` class
  - Schema version tracking via `__meta` table
- [ ] Define schema SQL:
  ```sql
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
  INSERT OR IGNORE INTO globalConcurrency (id, globalMaxConcurrent, currentlyActive, queuedCount) VALUES (1, 4, 0, 0);

  -- Schema version tracking
  CREATE TABLE IF NOT EXISTS __meta (
    key TEXT PRIMARY KEY,
    value TEXT
  );
  ```
- [ ] Implement `init()` method to create tables and seed defaults
- [ ] Implement `transaction()` with savepoint support (copy from `db.ts`)
- [ ] Implement `prepare()`, `exec()`, `close()` methods
- [ ] Implement `getLastModified()` / `bumpLastModified()` for change detection
- [ ] Write unit tests in `packages/core/src/central-db.test.ts`:
  - Database initialization
  - Table creation
  - Transaction support
  - Schema version tracking
  - lastModified bumping
- [ ] Run targeted tests: `pnpm test packages/core/src/central-db.test.ts`

**Artifacts:**
- `packages/core/src/central-db.ts` (new)
- `packages/core/src/central-db.test.ts` (new)

### Step 3: Create CentralCore API Class

Create `packages/core/src/central-core.ts` as the main API for central operations:

- [ ] Create `CentralCore` class extending `EventEmitter`:
  ```typescript
  export interface CentralCoreEvents {
    'project:registered': [project: RegisteredProject];
    'project:unregistered': [projectId: string];
    'project:updated': [project: RegisteredProject];
    'project:health:changed': [health: ProjectHealth];
    'activity:logged': [entry: CentralActivityLogEntry];
    'concurrency:changed': [state: GlobalConcurrencyState];
  }
  ```
- [ ] Constructor takes optional `globalDir` param (defaults to `~/.pi/kb/`)
- [ ] `async init(): Promise<void>` — ensures directory and database exist
- [ ] `async close(): Promise<void>` — closes database connection

- [ ] Implement Project Registry API:
  - `registerProject(input: { name: string; path: string; isolationMode?: IsolationMode }): Promise<RegisteredProject>`
    - Validate path exists and is absolute
    - Validate path not already registered
    - Generate unique ID (use `crypto.randomUUID()` or similar)
    - Insert into `projects` table
    - Initialize `projectHealth` row with defaults
    - Emit `'project:registered'`
  - `unregisterProject(id: string): Promise<void>`
    - Delete from `projects` (cascade deletes health and activity log entries)
    - Emit `'project:unregistered'`
  - `getProject(id: string): Promise<RegisteredProject | undefined>`
  - `getProjectByPath(path: string): Promise<RegisteredProject | undefined>`
  - `listProjects(): Promise<RegisteredProject[]>`
  - `updateProject(id: string, updates: Partial<Omit<RegisteredProject, 'id' | 'createdAt'>>): Promise<RegisteredProject>`
    - Update `updatedAt` automatically
    - Emit `'project:updated'`

- [ ] Implement Project Health API:
  - `updateProjectHealth(projectId: string, updates: Partial<ProjectHealth>): Promise<ProjectHealth>`
    - Get current health, merge updates, write back
    - Emit `'project:health:changed'` if status or key metrics changed
  - `getProjectHealth(projectId: string): Promise<ProjectHealth | undefined>`
  - `listAllHealth(): Promise<ProjectHealth[]>`
  - `recordTaskCompletion(projectId: string, durationMs: number, success: boolean): Promise<void>`
    - Atomically updates `totalTasksCompleted` or `totalTasksFailed`
    - Updates `averageTaskDurationMs` with rolling average
    - Updates `lastActivityAt`

- [ ] Implement Unified Activity Feed API:
  - `logActivity(entry: Omit<CentralActivityLogEntry, 'id'>): Promise<CentralActivityLogEntry>`
    - Generate UUID for entry.id
    - Insert into `centralActivityLog`
    - Also update project's `lastActivityAt` timestamp
    - Emit `'activity:logged'`
  - `getRecentActivity(options?: { limit?: number; projectId?: string; types?: ActivityEventType[] }): Promise<CentralActivityLogEntry[]>`
    - Default limit: 100
    - Filter by projectId if provided
    - Filter by event types if provided
    - Order by timestamp descending
  - `getActivityCount(projectId?: string): Promise<number>`
  - `cleanupOldActivity(olderThanDays: number): Promise<number>` — returns deleted count

- [ ] Implement Global Concurrency API:
  - `getGlobalConcurrencyState(): Promise<GlobalConcurrencyState>`
  - `updateGlobalConcurrency(updates: Partial<GlobalConcurrencyState>): Promise<GlobalConcurrencyState>`
    - Only allows updating `globalMaxConcurrent`, `currentlyActive`, `queuedCount`
    - Recalculates `projectsActive` from individual project health records
    - Emit `'concurrency:changed'` if values changed
  - `acquireGlobalSlot(projectId: string): Promise<boolean>`
    - Atomically check if `currentlyActive < globalMaxConcurrent`
    - If yes: increment `currentlyActive`, increment project's active count, return true
    - If no: increment `queuedCount`, return false
  - `releaseGlobalSlot(projectId: string): Promise<void>`
    - Decrement `currentlyActive`
    - Decrement project's active count
    - Emit `'concurrency:changed'`

- [ ] Implement utility methods:
  - `getDatabasePath(): string` — returns path to central DB file
  - `getStats(): Promise<{ projectCount: number; totalTasksCompleted: number; dbSizeBytes: number }>`

**Artifacts:**
- `packages/core/src/central-core.ts` (new)

### Step 4: Write Comprehensive Tests for CentralCore

Create `packages/core/src/central-core.test.ts` with thorough test coverage:

- [ ] Test project registration:
  - Successful registration with valid inputs
  - Reject duplicate paths
  - Reject non-existent paths
  - Reject relative paths (require absolute)
  - Auto-generate ID
  - Default isolationMode is 'in-process'
  - Event emission

- [ ] Test project unregistration:
  - Remove project and cascade to health/activity
  - Event emission
  - Idempotent (no error if already unregistered)

- [ ] Test project queries:
  - Get by ID
  - Get by path
  - List all (empty and populated)
  - Update project fields
  - Event emission on update

- [ ] Test project health:
  - Initialize on project registration
  - Update health metrics
  - Record task completion/failure
  - Rolling average calculation for duration
  - Event emission on health changes

- [ ] Test unified activity feed:
  - Log activity with all fields
  - Auto-generate entry ID
  - Update project lastActivityAt on log
  - Query recent activity (all projects)
  - Query filtered by project
  - Query filtered by event type
  - Event emission
  - Cleanup old entries

- [ ] Test global concurrency:
  - Get initial state (default max 4)
  - Update global max
  - Acquire slot when available
  - Fail to acquire when at limit
  - Release slot
  - Track per-project active counts
  - Event emission on changes

- [ ] Test lifecycle:
  - Init creates directory and database
  - Close closes database
  - Multiple init calls are idempotent

- [ ] Run targeted tests: `pnpm test packages/core/src/central-core.test.ts`
  - Aim for >80% coverage
  - ZERO failures

**Artifacts:**
- `packages/core/src/central-core.test.ts` (new)

### Step 5: Export New Public API

Update `packages/core/src/index.ts` to expose the new infrastructure:

- [ ] Export `CentralCore` class and `CentralCoreEvents` type
- [ ] Export `CentralDatabase` class (for advanced use cases)
- [ ] Export new types:
  - `RegisteredProject`
  - `IsolationMode`
  - `ProjectStatus`
  - `ProjectHealth`
  - `CentralActivityLogEntry`
  - `GlobalConcurrencyState`
- [ ] Ensure build passes: `pnpm build packages/core`

**Artifacts:**
- `packages/core/src/index.ts` (modified)

### Step 6: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full core test suite: `pnpm test packages/core`
- [ ] Verify no TypeScript errors: `pnpm build`
- [ ] Integration test: Create a test script that:
  - Initializes CentralCore
  - Registers 2-3 test projects
  - Logs activity for each project
  - Verifies unified feed contains all entries
  - Updates health for each project
  - Tests global concurrency acquisition/release
  - Unregisters projects
  - Closes cleanly
- [ ] Check test coverage for new files (aim for >80%)

### Step 7: Documentation & Delivery

- [ ] Add JSDoc comments to all public methods in `central-core.ts` and `central-db.ts`
- [ ] Update `AGENTS.md` — Document the central infrastructure:
  - Add section "Multi-Project Architecture / Central Core"
  - Explain the central database location (`~/.pi/kb/kb-central.db`)
  - Describe project registry purpose
  - Describe unified activity feed
  - Explain global concurrency limits
  - List the CentralCore API surface
- [ ] Create changeset for the feature:
    ```bash
    cat > .changeset/central-core-infrastructure.md << 'EOF'
    ---
    "@kb/core": minor
    ---
    
    Add central core infrastructure for multi-project support
    
    - New CentralCore class for system-wide coordination
    - Central SQLite database at ~/.pi/kb/kb-central.db
    - Project registry for managing multiple projects
    - Unified activity feed across all projects
    - Global concurrency limits spanning all projects
    - Project health tracking and monitoring
    EOF
    ```
- [ ] Include changeset in commit
- [ ] Out-of-scope findings created as new tasks via `task_create` tool:
  - Dashboard UI for central overview (KB-502)
  - CLI project commands (KB-503)
  - Migration from single-project (KB-504)
  - Runtime abstraction (KB-501 — depends on this task)

## Documentation Requirements

**Must Update:**
- `packages/core/src/index.ts` — Export new public API
- `AGENTS.md` — Add section documenting:
  - CentralCore purpose and location
  - Project registry schema and API
  - Unified activity feed vs per-project activity log
  - Global concurrency management
  - Project health tracking

**Check If Affected:**
- `packages/core/package.json` — No changes expected

## Completion Criteria

- [ ] All types defined and exported (`RegisteredProject`, `IsolationMode`, `ProjectStatus`, `ProjectHealth`, `CentralActivityLogEntry`, `GlobalConcurrencyState`)
- [ ] `CentralDatabase` class implemented with full schema
- [ ] `CentralCore` class implemented with all API methods
- [ ] Project registry functional (register, unregister, get, list, update)
- [ ] Project health tracking functional (update, query, record completion)
- [ ] Unified activity feed functional (log, query with filters, cleanup)
- [ ] Global concurrency API functional (acquire/release slots, track per-project)
- [ ] All tests passing (>80% coverage for new files)
- [ ] Build passes with no TypeScript errors
- [ ] Integration test script passes
- [ ] Documentation updated in AGENTS.md
- [ ] Changeset created
- [ ] New types and classes exported from index.ts

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-500): complete Step N — description`
  - Example: `feat(KB-500): complete Step 1 — extend types for multi-project support`
- **Bug fixes:** `fix(KB-500): description`
- **Tests:** `test(KB-500): description`
- **Docs:** `docs(KB-500): description`

## Do NOT

- Modify existing TaskStore behavior (should remain unchanged)
- Break single-project mode (existing code should work as-is)
- Skip path validation in project registration (security-critical)
- Allow relative paths for project registration (must be absolute)
- Skip event emission (consumers depend on events for reactivity)
- Use the central database for per-project task storage (projects keep their own `.fusion/fusion.db`)
- Remove or deprecate existing exports without migration path
- Store sensitive credentials (tokens, keys) in the central database
- Allow circular project references
- Skip cleanup of activity log entries (implement retention policy)

## Security Considerations

- Validate project paths exist and are absolute before registration
- Prevent path traversal attacks in project path handling
- Use parameterized queries throughout (SQL injection prevention)
- Validate isolationMode is only 'in-process' or 'child-process'
- Don't store credentials in central database (projects keep their own config)
- Cascade delete project data on unregister to prevent orphaned data

## Performance Considerations

- Central database uses WAL mode for concurrent reader/writer access
- Activity log queries are indexed by timestamp, type, and projectId
- Health updates are lightweight (small row updates)
- Concurrency operations use atomic increments/decrements
- Consider activity log retention policy (cleanupOldActivity) to prevent unbounded growth
- Lazy initialization — CentralCore doesn't connect until `init()` called

## API Reference (for dependent tasks)

**KB-501 expects these CentralCore APIs:**

```typescript
// Project registry
centralCore.getProject(id: string): Promise<RegisteredProject | undefined>
centralCore.listProjects(): Promise<RegisteredProject[]>
centralCore.updateProject(id, { status, isolationMode }): Promise<RegisteredProject>

// Health tracking
centralCore.updateProjectHealth(projectId, updates): Promise<ProjectHealth>
centralCore.getProjectHealth(projectId): Promise<ProjectHealth | undefined>

// Global concurrency
centralCore.acquireGlobalSlot(projectId): Promise<boolean>
centralCore.releaseGlobalSlot(projectId): Promise<void>
centralCore.getGlobalConcurrencyState(): Promise<GlobalConcurrencyState>

// Events
centralCore.on('project:updated', handler)
centralCore.on('concurrency:changed', handler)
```

**Type definitions needed by KB-501:**

```typescript
type IsolationMode = 'in-process' | 'child-process'
type ProjectStatus = 'active' | 'paused' | 'errored' | 'initializing'
interface RegisteredProject {
  id: string
  name: string
  path: string
  status: ProjectStatus
  isolationMode: IsolationMode
  // ... other fields
}
```
