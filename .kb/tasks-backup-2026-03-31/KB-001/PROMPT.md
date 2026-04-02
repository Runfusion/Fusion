# Task: KB-001 - Core Infrastructure: Central database, project registry, unified activity feed

**Created:** 2026-03-31
**Size:** L

## Review Level: 3 (Full)

**Assessment:** This is foundational infrastructure for the entire multi-project architecture. Changes affect data persistence patterns, introduce new database schemas, and establish APIs that all subsequent multi-project tasks will build upon. Database migrations and backward compatibility are critical. Full review warranted for schema design and data integrity patterns.

**Score:** 6/8 — Blast radius: 2, Pattern novelty: 1, Security: 2, Reversibility: 1

## Mission

Establish the central infrastructure for kb's multi-project architecture. Create a system-wide SQLite database at `~/.pi/kb/kb-central.db` that serves as the hub for cross-project functionality. This database will house the project registry (tracking all registered projects), unified activity feed (aggregated events across projects), and global configuration (system-wide limits and defaults). This infrastructure enables KB-002 and subsequent tasks to build per-project runtime abstractions while maintaining a centralized coordination point.

Key deliverables:
- **CentralDatabase class**: SQLite database at `~/.pi/kb/kb-central.db` with schema for projects, activityLog, globalConfig
- **Project registry**: Full CRUD for projects with id, name, path, enabled, isolationMode, status, metadata
- **Unified activity feed**: Centralized activityLog that aggregates events from all projects with project attribution
- **Global config**: System-wide settings like maxConcurrentAgents (enforced across all projects)
- **CentralCoreStore**: High-level API combining database operations with event emission

## Dependencies

- **None** (foundational task)

## Context to Read First

1. `/packages/core/src/db.ts` — Database class patterns, WAL mode, JSON column helpers, transaction handling
2. `/packages/core/src/store.ts` — TaskStore patterns, event emitter usage, database operations
3. `/packages/core/src/types.ts` — Existing type definitions (Project type already defined there per KB-002 spec reference)
4. `/packages/core/src/global-settings.ts` — Global settings store patterns, `~/.pi/kb/` directory usage
5. `/packages/core/src/index.ts` — Current exports and public API surface
6. `/packages/core/src/db-migrate.ts` — Migration patterns from legacy storage

## File Scope

### New Files
- `packages/core/src/central-db.ts` — CentralDatabase class (SQLite operations for central DB)
- `packages/core/src/central-core-store.ts` — CentralCoreStore class (high-level API with events)
- `packages/core/src/project-registry.ts` — ProjectRegistry class (project CRUD operations)
- `packages/core/src/central-activity-feed.ts` — CentralActivityFeed class (unified activity log)
- `packages/core/src/central-db.test.ts` — Tests for CentralDatabase
- `packages/core/src/central-core-store.test.ts` — Tests for CentralCoreStore
- `packages/core/src/project-registry.test.ts` — Tests for ProjectRegistry
- `packages/core/src/central-activity-feed.test.ts` — Tests for CentralActivityFeed

### Modified Files
- `packages/core/src/types.ts` — Add CentralConfig, ProjectStatus, ProjectIsolationMode types; verify Project type exists
- `packages/core/src/index.ts` — Export new central core classes and types

## Steps

### Step 0: Preflight

- [ ] Read all Context files listed above
- [ ] Verify existing tests pass: `pnpm --filter @fusion/core test`
- [ ] Verify build passes: `pnpm --filter @fusion/core build`
- [ ] Confirm `~/.pi/kb/` directory pattern from global-settings.ts

### Step 1: Central Database Schema and Core Class

Create the foundational database layer at `~/.pi/kb/kb-central.db`.

- [ ] Create `packages/core/src/central-db.ts` with `CentralDatabase` class:
  - Constructor takes optional `centralDir` (default: `~/.pi/kb`)
  - Database file path: `{centralDir}/kb-central.db`
  - Enable WAL mode: `PRAGMA journal_mode = WAL`
  - Enable foreign keys: `PRAGMA foreign_keys = ON`
  - Reuse transaction patterns from `db.ts` (savepoint-based nested transactions)
  - Include `bumpLastModified()` and `getLastModified()` for change detection
  - Include `getSchemaVersion()` for future migrations

- [ ] Schema SQL for `init()` method (SCHEMA_VERSION = 1):
  ```sql
  -- Projects registry table
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    path TEXT NOT NULL UNIQUE,
    enabled INTEGER DEFAULT 1,
    isolationMode TEXT DEFAULT 'in-process',
    status TEXT DEFAULT 'active',
    maxConcurrent INTEGER, -- per-project override (null = use global)
    metadata TEXT DEFAULT '{}', -- JSON for extensibility
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_projects_enabled ON projects(enabled);
  CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);

  -- Unified activity log (aggregated from all projects)
  CREATE TABLE IF NOT EXISTS activityLog (
    id TEXT PRIMARY KEY,
    timestamp TEXT NOT NULL,
    type TEXT NOT NULL,
    projectId TEXT, -- null for global events
    taskId TEXT,
    taskTitle TEXT,
    details TEXT NOT NULL,
    metadata TEXT, -- JSON column
    FOREIGN KEY (projectId) REFERENCES projects(id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS idx_activity_log_timestamp ON activityLog(timestamp);
  CREATE INDEX IF NOT EXISTS idx_activity_log_type ON activityLog(type);
  CREATE INDEX IF NOT EXISTS idx_activity_log_project ON activityLog(projectId);
  CREATE INDEX IF NOT EXISTS idx_activity_log_task ON activityLog(taskId);

  -- Global configuration (single row)
  CREATE TABLE IF NOT EXISTS globalConfig (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    maxConcurrentAgents INTEGER DEFAULT 4, -- system-wide cap
    defaultIsolationMode TEXT DEFAULT 'in-process',
    projectAutoDiscovery INTEGER DEFAULT 1,
    updatedAt TEXT
  );

  -- Schema version tracking
  CREATE TABLE IF NOT EXISTS __meta (
    key TEXT PRIMARY KEY,
    value TEXT
  );
  ```

- [ ] Seed default config row idempotently in `init()`:
  ```sql
  INSERT OR IGNORE INTO globalConfig (id, maxConcurrentAgents, defaultIsolationMode, projectAutoDiscovery, updatedAt) 
  VALUES (1, 4, 'in-process', 1, '{now}')
  ```

- [ ] Export `createCentralDatabase(centralDir?: string): CentralDatabase` factory function

- [ ] Write comprehensive tests in `packages/core/src/central-db.test.ts`:
  - Database initialization creates tables
  - WAL mode is enabled
  - Default config row is seeded
  - Schema version is tracked
  - Transactions work (nested savepoints)
  - lastModified bumping works

**Artifacts:**
- `packages/core/src/central-db.ts` (new)
- `packages/core/src/central-db.test.ts` (new)

### Step 2: Project Registry

Build project CRUD operations on top of CentralDatabase.

- [ ] First, add missing types to `packages/core/src/types.ts`:
  ```typescript
  export type ProjectStatus = "active" | "paused" | "errored" | "disabled";
  export type ProjectIsolationMode = "in-process" | "child-process";
  
  export interface Project {
    id: string;                    // e.g., "proj-001"
    name: string;                  // Display name
    path: string;                  // Absolute path to project root
    enabled: boolean;              // Include in scheduling?
    isolationMode: ProjectIsolationMode;
    status: ProjectStatus;
    maxConcurrent?: number;        // Per-project override
    metadata?: Record<string, unknown>;
    createdAt: string;
    updatedAt: string;
  }
  
  export interface ProjectCreateInput {
    name: string;
    path: string;
    enabled?: boolean;
    isolationMode?: ProjectIsolationMode;
    maxConcurrent?: number;
    metadata?: Record<string, unknown>;
  }
  
  export interface ProjectUpdateInput {
    name?: string;
    enabled?: boolean;
    isolationMode?: ProjectIsolationMode;
    status?: ProjectStatus;
    maxConcurrent?: number;
    metadata?: Record<string, unknown>;
  }
  
  export interface CentralConfig {
    maxConcurrentAgents: number;
    defaultIsolationMode: ProjectIsolationMode;
    projectAutoDiscovery: boolean;
  }
  ```

- [ ] Create `packages/core/src/project-registry.ts` with `ProjectRegistry` class:
  - Constructor: `constructor(private db: CentralDatabase)`
  - Private `rowToProject(row: unknown): Project` helper parsing JSON columns
  - Methods:
    - `listProjects(): Promise<Project[]>` — all projects ordered by name
    - `listEnabledProjects(): Promise<Project[]>` — enabled projects only
    - `getProject(id: string): Promise<Project | undefined>`
    - `getProjectByPath(path: string): Promise<Project | undefined>`
    - `createProject(input: ProjectCreateInput): Promise<Project>` — generates ID like "proj-{nnn}"
    - `updateProject(id: string, input: ProjectUpdateInput): Promise<Project>`
    - `deleteProject(id: string): Promise<boolean>` — returns true if deleted
    - `countProjects(): Promise<number>`
    - `exists(path: string): Promise<boolean>`

- [ ] ID generation: Query max numeric suffix from existing project IDs, increment
  - Pattern: `proj-001`, `proj-002`, etc.
  - Handle case where no projects exist yet

- [ ] Validation in `createProject`:
  - Path must be absolute
  - Path must not already be registered
  - Name must be non-empty

- [ ] Auto-set `updatedAt` on all modifications

- [ ] Write comprehensive tests in `packages/core/src/project-registry.test.ts`:
  - Create project generates ID
  - Duplicate path rejected
  - List returns ordered results
  - Update modifies only specified fields
  - Delete removes project
  - Foreign key constraints (activity log entries set to null on delete)

**Artifacts:**
- `packages/core/src/types.ts` (modified — new types)
- `packages/core/src/project-registry.ts` (new)
- `packages/core/src/project-registry.test.ts` (new)

### Step 3: Unified Activity Feed

Create centralized activity logging that spans all projects.

- [ ] First, extend types in `packages/core/src/types.ts`:
  ```typescript
  export type CentralActivityEventType = 
    | "task:created" 
    | "task:moved" 
    | "task:updated" 
    | "task:deleted" 
    | "task:merged" 
    | "task:failed"
    | "project:registered"
    | "project:updated"
    | "project:deleted"
    | "system:initialized";
  
  export interface CentralActivityLogEntry {
    id: string;
    timestamp: string;
    type: CentralActivityEventType;
    projectId?: string;    // null for global events
    taskId?: string;
    taskTitle?: string;
    details: string;
    metadata?: Record<string, unknown>;
  }
  ```

- [ ] Create `packages/core/src/central-activity-feed.ts` with `CentralActivityFeed` class:
  - Constructor: `constructor(private db: CentralDatabase)`
  - Private ID generation: `uuid` or `act-{timestamp}-{random}` pattern
  - Methods:
    - `addEntry(entry: Omit<CentralActivityLogEntry, "id" | "timestamp">): Promise<CentralActivityLogEntry>` — generates ID and timestamp
    - `getEntries(options?: { limit?: number; before?: string; projectId?: string; type?: CentralActivityEventType }): Promise<CentralActivityLogEntry[]>`
    - `getRecentEntries(limit?: number): Promise<CentralActivityLogEntry[]>` — convenience for last N entries
    - `getEntriesForProject(projectId: string, limit?: number): Promise<CentralActivityLogEntry[]>`
    - `deleteOldEntries(olderThan: Date): Promise<number>` — returns count deleted
    - `countEntries(): Promise<number>`

- [ ] Write comprehensive tests in `packages/core/src/central-activity-feed.test.ts`:
  - Add entry generates ID and timestamp
  - Get entries with limit
  - Get entries with project filter
  - Get entries with type filter
  - Pagination with `before` cursor
  - Delete old entries returns count

**Artifacts:**
- `packages/core/src/types.ts` (modified — CentralActivityLogEntry type)
- `packages/core/src/central-activity-feed.ts` (new)
- `packages/core/src/central-activity-feed.test.ts` (new)

### Step 4: Central Core Store (High-Level API)

Combine all components into a unified store with event emission.

- [ ] Create `packages/core/src/central-core-store.ts` with `CentralCoreStore` class:
  - Extends `EventEmitter` (same pattern as TaskStore)
  - Constructor: `constructor(centralDir?: string)` — default `~/.pi/kb`
  - Properties:
    - `private db: CentralDatabase`
    - `private projects: ProjectRegistry`
    - `private activity: CentralActivityFeed`
    - `private globalSettingsStore: GlobalSettingsStore` — reuse existing
  
  - Public methods (delegation):
    - `init(): Promise<void>` — initializes DB, registries, settings
    - `getDatabase(): CentralDatabase`
    - `getGlobalConfig(): Promise<CentralConfig>` — from globalConfig table
    - `updateGlobalConfig(patch: Partial<CentralConfig>): Promise<CentralConfig>`
  
  - Project methods (wrap ProjectRegistry with activity logging):
    - `listProjects(): Promise<Project[]>`
    - `getProject(id: string): Promise<Project | undefined>`
    - `registerProject(input: ProjectCreateInput): Promise<Project>` — logs "project:registered"
    - `updateProject(id: string, input: ProjectUpdateInput): Promise<Project>` — logs "project:updated"
    - `unregisterProject(id: string): Promise<boolean>` — logs "project:deleted"
  
  - Activity methods:
    - `getActivityFeed(options?): Promise<CentralActivityLogEntry[]>`
    - `logActivity(entry): Promise<CentralActivityLogEntry>`
  
  - Global settings delegation:
    - `getGlobalSettings(): Promise<GlobalSettings>`
    - `updateGlobalSettings(patch): Promise<GlobalSettings>`

- [ ] Event emitter interface:
  ```typescript
  export interface CentralCoreStoreEvents {
    "project:registered": [project: Project];
    "project:updated": [project: Project];
    "project:deleted": [projectId: string];
    "activity:added": [entry: CentralActivityLogEntry];
    "config:updated": [config: CentralConfig];
  }
  ```

- [ ] Write comprehensive tests in `packages/core/src/central-core-store.test.ts`:
  - Init creates database and tables
  - Register project emits event and logs activity
  - Update project emits event
  - Unregister project emits event
  - Global config can be read and updated
  - Global settings integration works
  - Activity feed tracks project lifecycle

**Artifacts:**
- `packages/core/src/central-core-store.ts` (new)
- `packages/core/src/central-core-store.test.ts` (new)

### Step 5: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run all new tests: `pnpm --filter @fusion/core test -- central-db.test.ts central-core-store.test.ts project-registry.test.ts central-activity-feed.test.ts`
- [ ] Run all existing core tests: `pnpm --filter @fusion/core test` — all must pass
- [ ] Verify build: `pnpm --filter @fusion/core build` — no TypeScript errors
- [ ] Verify no breaking changes to existing exports
- [ ] Manual verification:
  1. Create test script that instantiates CentralCoreStore
  2. Register a project
  3. Verify database file created at `~/.pi/kb/kb-central.db`
  4. Verify project appears in list
  5. Verify activity logged
  6. Update project, verify updatedAt changes
  7. Unregister project, verify cleanup

**Artifacts:**
- All tests passing
- Build clean

### Step 6: Documentation & Delivery

- [ ] Update `packages/core/src/index.ts` exports:
  ```typescript
  // New central core exports
  export { CentralDatabase, createCentralDatabase } from "./central-db.js";
  export { CentralCoreStore } from "./central-core-store.js";
  export { ProjectRegistry } from "./project-registry.js";
  export { CentralActivityFeed } from "./central-activity-feed.js";
  export type { 
    CentralConfig, 
    CentralActivityEventType, 
    CentralActivityLogEntry,
    ProjectStatus,
    ProjectIsolationMode,
    ProjectCreateInput,
    ProjectUpdateInput,
    CentralCoreStoreEvents
  } from "./types.js";
  ```

- [ ] Update `packages/core/README.md` with Central Core section:
  - Explain the multi-project architecture
  - Document CentralCoreStore usage
  - Document project registry operations
  - Document unified activity feed

- [ ] Create changeset:
  ```bash
  cat > .changeset/central-core-infrastructure.md << 'EOF'
  ---
  "@dustinbyrne/kb": minor
  ---
  
  Add central core infrastructure for multi-project support. New `CentralCoreStore` provides project registry, unified activity feed, and global configuration management via SQLite at `~/.pi/kb/kb-central.db`.
  EOF
  ```

- [ ] Out-of-scope findings: If you identify any needed work beyond this task's scope (e.g., dashboard API routes for projects, CLI commands), create follow-up tasks using the `task_create` tool with appropriate descriptions and mark them as depending on this task.

**Artifacts:**
- `packages/core/src/index.ts` (modified — new exports)
- `packages/core/README.md` (modified — central core docs)
- `.changeset/central-core-infrastructure.md` (new)

## Documentation Requirements

**Must Update:**
- `packages/core/src/index.ts` — Export all new public APIs
- `packages/core/README.md` — Add "Central Core" section explaining:
  - The `~/.pi/kb/kb-central.db` database location and purpose
  - How to use `CentralCoreStore` for project management
  - Activity feed patterns for cross-project event tracking
  - Global configuration for system-wide limits

**Check If Affected:**
- `AGENTS.md` — If there's a multi-project architecture section, add pointer to central core
- `packages/dashboard/README.md` — May need to reference new core APIs

## Completion Criteria

- [ ] All steps complete (0-6)
- [ ] All tests passing (new + existing)
- [ ] Build passes with no TypeScript errors
- [ ] `CentralCoreStore` can:
  - Register, update, unregister projects
  - Log and retrieve cross-project activity
  - Read and update global config
  - Integrate with existing GlobalSettingsStore
- [ ] Database schema at `~/.pi/kb/kb-central.db` includes:
  - `projects` table with all required columns
  - `activityLog` table with foreign key to projects
  - `globalConfig` table with single row
  - Proper indexes for query performance
- [ ] Documentation updated
- [ ] Changeset created

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-001): complete Step N — description`
- **Bug fixes:** `fix(KB-001): description`
- **Tests:** `test(KB-001): description`
- **Docs:** `docs(KB-001): description`

Example commits:
```
feat(KB-001): complete Step 1 — add CentralDatabase with schema
feat(KB-001): complete Step 2 — implement ProjectRegistry with CRUD
test(KB-001): add comprehensive activity feed tests
docs(KB-001): document central core APIs
```

## Do NOT

- **Do NOT** modify the existing per-project `.fusion/fusion.db` schema — this is the central database only
- **Do NOT** change existing TaskStore behavior — maintain backward compatibility
- **Do NOT** implement dashboard UI or CLI commands — that's in dependent tasks KB-003 and KB-346
- **Do NOT** implement the per-project runtime abstraction — that's KB-002
- **Do NOT** skip tests for database operations — data integrity is critical
- **Do NOT** use synchronous file operations for the central database — follow async patterns from existing code
- **Do NOT** break existing exports or type definitions
- **Do NOT** commit without running the full test suite
