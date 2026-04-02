# Task: KB-310 - Migrate from file-based storage to SQLite (hybrid: DB for metadata, files for blobs)

**Created:** 2026-03-31
**Size:** L

## Review Level: 3 (Full)

**Assessment:** This is a foundational infrastructure change affecting all six data stores (TaskStore, Config, Archive, Activity Log, AgentStore, AutomationStore) with complex migration requirements, WAL mode concurrency, and zero-downtime backward compatibility needs. High blast radius, novel SQLite patterns for the codebase, and requires full verification.

**Score:** 7/8 — Blast radius: 2, Pattern novelty: 2, Security: 1, Reversibility: 2

## Mission

Migrate the kb task board system from its current file-based storage to a hybrid SQLite + filesystem architecture. All structured/queryable metadata moves to a SQLite database at `.fusion/fusion.db` using Node.js built-in `node:sqlite`. Large blob files (`PROMPT.md`, `agent.log`, attachments) remain on the filesystem under `.fusion/tasks/{ID}/`.

This migration must be seamless: on first run, detect legacy file-based data and auto-migrate it to SQLite while preserving old files as backups. The existing `TaskStore`, `AgentStore`, and `AutomationStore` method signatures must be preserved for backward compatibility.

## Dependencies

- **None**

## Context to Read First

1. `packages/core/src/types.ts` — All data type definitions (Task, Agent, Automation, etc.)
2. `packages/core/src/store.ts` — Current TaskStore implementation with file-based storage
3. `packages/core/src/agent-store.ts` — Current AgentStore implementation
4. `packages/core/src/automation-store.ts` — Current AutomationStore implementation
5. `packages/core/src/global-settings.ts` — GlobalSettingsStore (remains file-based in `~/.pi/kb/`)
6. `packages/dashboard/src/sse.ts` — SSE endpoint for real-time updates

## File Scope

### New Files
- `packages/core/src/db.ts` — Database module with SQLite connection, schema, and migration
- `packages/core/src/db-migrate.ts` — Migration logic from file-based to SQLite

### Modified Files
- `packages/core/src/store.ts` — Refactor TaskStore to use SQLite for all metadata
- `packages/core/src/agent-store.ts` — Refactor AgentStore to use SQLite
- `packages/core/src/automation-store.ts` — Refactor AutomationStore to use SQLite
- `packages/core/src/index.ts` — Export Database module
- `packages/dashboard/src/sse.ts` — Update change detection to use polling

### Unchanged (for reference)
- `packages/core/src/global-settings.ts` — Global settings remain in `~/.pi/kb/settings.json`
- `packages/core/src/types.ts` — Types remain unchanged

## Steps

### Step 1: Database Foundation

Create the Database module with SQLite schema and connection management.

- [ ] Create `packages/core/src/db.ts` with Database class
  - Use `node:sqlite` (Node 22.5+ built-in module)
  - Synchronous API for simplified transaction handling
  - WAL mode enabled for concurrent reader/writer access
  - Schema version tracking in `__meta` table
- [ ] Define complete schema in `db.ts` using camelCase column names (matches TypeScript):
  ```sql
  -- Tasks table with JSON columns for nested data
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    title TEXT,
    description TEXT NOT NULL,
    column TEXT NOT NULL,
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
    workflowStepResults TEXT DEFAULT '[]',
    prInfo TEXT,
    issueInfo TEXT,
    breakIntoSubtasks INTEGER DEFAULT 0,
    enabledWorkflowSteps TEXT DEFAULT '[]'
  );

  -- Config table (single row with project settings)
  CREATE TABLE config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    nextId INTEGER DEFAULT 1,
    nextWorkflowStepId INTEGER DEFAULT 1,
    settings TEXT DEFAULT '{}',
    workflowSteps TEXT DEFAULT '[]',
    updatedAt TEXT
  );

  -- Activity log with indexed columns for efficient queries
  CREATE TABLE activityLog (
    id TEXT PRIMARY KEY,
    timestamp TEXT NOT NULL,
    type TEXT NOT NULL,
    taskId TEXT,
    taskTitle TEXT,
    details TEXT NOT NULL,
    metadata TEXT
  );
  CREATE INDEX idxActivityLogTimestamp ON activityLog(timestamp);
  CREATE INDEX idxActivityLogType ON activityLog(type);
  CREATE INDEX idxActivityLogTaskId ON activityLog(taskId);

  -- Archived tasks table (migrated from archive.jsonl)
  CREATE TABLE archivedTasks (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL, -- Full ArchivedTaskEntry as JSON
    archivedAt TEXT NOT NULL
  );
  CREATE INDEX idxArchivedTasksId ON archivedTasks(id);

  -- Automations table
  CREATE TABLE automations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    scheduleType TEXT NOT NULL,
    cronExpression TEXT NOT NULL,
    command TEXT NOT NULL,
    enabled INTEGER DEFAULT 1,
    timeoutMs INTEGER,
    steps TEXT, -- JSON array of AutomationStep
    nextRunAt TEXT,
    lastRunAt TEXT,
    lastRunResult TEXT, -- JSON
    runCount INTEGER DEFAULT 0,
    runHistory TEXT DEFAULT '[]', -- JSON array
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );

  -- Agents table
  CREATE TABLE agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    role TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'idle',
    taskId TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL,
    lastHeartbeatAt TEXT,
    metadata TEXT DEFAULT '{}' -- JSON
  );

  -- Agent heartbeat events
  CREATE TABLE agentHeartbeats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agentId TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    status TEXT NOT NULL,
    runId TEXT NOT NULL,
    FOREIGN KEY (agentId) REFERENCES agents(id) ON DELETE CASCADE
  );
  CREATE INDEX idxAgentHeartbeatsAgentId ON agentHeartbeats(agentId);
  CREATE INDEX idxAgentHeartbeatsRunId ON agentHeartbeats(runId);

  -- Schema version tracking
  CREATE TABLE __meta (
    key TEXT PRIMARY KEY,
    value TEXT
  );
  INSERT INTO __meta (key, value) VALUES ('schemaVersion', '1');
  ```
- [ ] Implement change detection polling mechanism:
  - Store `lastModified` timestamp (epoch ms) in `__meta` table
  - `getLastModified(): number` method returns last change timestamp
  - `bumpLastModified(): void` updates timestamp on every write operation
- [ ] Implement helper methods for JSON serialization/deserialization:
  - `toJson(value: unknown): string` — stringifies arrays/objects, returns `'[]'` for empty arrays
  - `fromJson<T>(json: string | null): T | undefined` — parses safely, returns undefined for null/empty
- [ ] Implement `Database` class with these methods:
  - `constructor(kbDir: string)` — opens database at `.fusion/fusion.db`, enables WAL mode
  - `init(): void` — creates tables if they don't exist
  - `close(): void` — closes database connection
  - `transaction<T>(fn: () => T): T` — executes function inside SQLite transaction
  - `prepare(sql: string): Statement` — returns prepared statement object
  - `getLastModified(): number` — reads `__meta.lastModified`
  - `bumpLastModified(): void` — updates `__meta.lastModified` to current epoch ms
- [ ] Export `createDatabase(kbDir: string): Database` factory function
- [ ] Run `pnpm build` to verify no TypeScript errors
- [ ] Write unit tests in `packages/core/src/db.test.ts`:
  - Schema creation works
  - WAL mode is enabled
  - Change detection timestamps work
  - JSON serialization helpers work
  - Transactions work atomically

**Artifacts:**
- `packages/core/src/db.ts` (new)
- `packages/core/src/db.test.ts` (new)

### Step 2: Migration System

Create auto-migration logic from file-based to SQLite.

- [ ] Create `packages/core/src/db-migrate.ts` with migration functions:
  - `detectLegacyData(kbDir: string): boolean` — returns true if `.fusion/tasks/` exists OR `.fusion/config.json` exists OR `.fusion/agents/` exists OR `.fusion/automations/` exists OR `.fusion/activity-log.jsonl` exists OR `.fusion/archive.jsonl` exists (but `.fusion/fusion.db` does NOT exist)
  - `migrateFromLegacy(kbDir: string, db: Database): Promise<void>` — performs full migration
- [ ] Implement migration steps in order:
  1. Migrate config.json → `config` table (preserve nextId as nextId, workflowSteps array, settings object)
  2. Iterate `.fusion/tasks/*/task.json` → `tasks` table (map each JSON field to column, serialize arrays to JSON strings)
  3. Migrate `.fusion/activity-log.jsonl` → `activityLog` table (parse each line, map fields)
  4. Migrate `.fusion/archive.jsonl` → `archivedTasks` table (parse each line, store full entry as `data` JSON)
  5. Migrate `.fusion/automations/*.json` → `automations` table (read each file, map fields)
  6. Migrate `.fusion/agents/*.json` → `agents` table (read agent files, map fields)
  7. Migrate `.fusion/agents/*-heartbeats.jsonl` → `agentHeartbeats` table (parse each heartbeat line)
- [ ] Create backup of old files after successful migration:
  - Rename `.fusion/tasks/` → `.fusion/tasks.bak/` (if exists)
  - Rename `.fusion/config.json` → `.fusion/config.json.bak` (if exists)
  - Rename `.fusion/activity-log.jsonl` → `.fusion/activity-log.jsonl.bak` (if exists)
  - Rename `.fusion/archive.jsonl` → `.fusion/archive.jsonl.bak` (if exists)
  - Rename `.fusion/automations/` → `.fusion/automations.bak/` (if exists)
  - Rename `.fusion/agents/` → `.fusion/agents.bak/` (if exists)
- [ ] Handle partial/corrupt legacy data gracefully:
  - Skip invalid task.json files with console warning (don't fail entire migration)
  - Skip malformed archive.jsonl lines (continue to next line)
  - Skip malformed activity log lines
  - Wrap each migration step in try/catch, log errors but continue
- [ ] Implement `getMigrationStatus(kbDir: string): { hasLegacy: boolean; hasDatabase: boolean; needsMigration: boolean }`
- [ ] Write tests for migration logic:
  - Happy path: all legacy data migrates correctly, data integrity preserved
  - Partial corruption: valid data migrates, corrupt data is skipped with warnings
  - Idempotent: re-running migration with existing SQLite does nothing (detects already migrated)
  - Empty project: fresh project with no legacy data creates empty database correctly
- [ ] Run `pnpm build` and verify tests pass

**Artifacts:**
- `packages/core/src/db-migrate.ts` (new)
- `packages/core/src/db-migrate.test.ts` (new)

### Step 3: TaskStore SQLite Migration

Refactor TaskStore to use SQLite for all structured metadata.

- [ ] Update TaskStore constructor to accept Database instance and store rootDir only (not kb paths):
  ```typescript
  constructor(
    private rootDir: string,
    private db: Database,
    globalSettingsDir?: string
  )
  ```
- [ ] Remove `kbDir`, `tasksDir`, `configPath`, `archiveLogPath`, `activityLogPath` — these move to Database
- [ ] Remove `withTaskLock` and `withConfigLock` promise chains — use `db.transaction()` instead
- [ ] Remove `recentlyWritten`, `debounceTimers` — change detection will use polling
- [ ] Replace file-based config operations:
  - `readConfig()` → `SELECT * FROM config WHERE id = 1`, parse settings/workflowSteps JSON
  - `writeConfig()` → `INSERT OR REPLACE INTO config ...`
- [ ] Replace task CRUD operations with SQLite:
  - `readTaskJson(dir)` → `SELECT * FROM tasks WHERE id = ?`, parse JSON columns
  - `atomicWriteTaskJson(dir, task)` → `INSERT OR REPLACE INTO tasks ...` with JSON stringification
  - `listTasks()` → `SELECT * FROM tasks ORDER BY createdAt`, parse JSON for each row
  - `getTask()` → `SELECT * FROM tasks WHERE id = ?` + read PROMPT.md from disk via `taskDir()`
- [ ] Update `allocateId()` to use transaction:
  ```typescript
  return this.db.transaction(() => {
    const row = this.db.prepare('SELECT nextId, settings FROM config WHERE id = 1').get() as { nextId: number; settings: string };
    const settings = JSON.parse(row.settings || '{}');
    const prefix = settings.taskPrefix || 'KB';
    const id = `${prefix}-${String(row.nextId).padStart(3, '0')}`;
    this.db.prepare('UPDATE config SET nextId = ?').run(row.nextId + 1);
    this.db.bumpLastModified();
    return id;
  });
  ```
- [ ] Update `createTask()`:
  - Insert row into `tasks` table with JSON-serialized arrays
  - Write PROMPT.md to disk (unchanged)
  - Call `db.bumpLastModified()`
  - Emit `task:created` event
- [ ] Update `updateTask()`:
  - Use `db.prepare().run()` to update columns
  - JSON-serialize dependencies, steps, etc.
  - Call `db.bumpLastModified()`
  - Write PROMPT.md if updates.prompt provided
- [ ] Update `moveTask()`, `pauseTask()`, `updateStep()`, `logEntry()`, `addSteeringComment()`:
  - All use `db.transaction()` for atomicity
  - Update relevant columns
  - Call `db.bumpLastModified()` after write
  - Emit appropriate events
- [ ] Update `updatePrInfo()` and `updateIssueInfo()`:
  - Use `db.transaction()` 
  - Read current task with `SELECT * FROM tasks WHERE id = ?`
  - Compare previous prInfo/issueInfo to detect badgeChanged
  - Update prInfo/issueInfo JSON columns
  - Append to log JSON array
  - Call `db.bumpLastModified()`
  - Emit `task:updated` if badgeChanged
- [ ] Keep `appendAgentLog()` file-based (agent.log remains JSONL file):
  - Use same implementation but ensure `taskDir()` still works
  - `taskDir(id)` returns `join(rootDir, '.fusion', 'tasks', id)` (computed, not stored)
- [ ] Keep `getAgentLogs()` file-based:
  - Same implementation, just ensure paths work
- [ ] Update file-based operations for blob data:
  - `taskDir(id)` — compute path: `join(this.rootDir, '.fusion', 'tasks', id)`
  - `addAttachment()` — write file to disk, store metadata in SQLite attachments JSON column
  - `getAttachment()` — read metadata from SQLite, return disk path
  - `deleteAttachment()` — delete from disk, update SQLite attachments JSON column
- [ ] Replace activity log operations:
  - `recordActivity()` → `INSERT INTO activityLog ...`, call `db.bumpLastModified()`
  - `getActivityLog()` → `SELECT * FROM activityLog ORDER BY timestamp DESC`, parse metadata JSON
  - `clearActivityLog()` → `DELETE FROM activityLog`
- [ ] Replace archive operations:
  - `readArchiveLog()` → `SELECT id, archivedAt, data FROM archivedTasks ORDER BY archivedAt DESC`
  - `findInArchive()` → `SELECT * FROM archivedTasks WHERE id = ?`
  - `archiveTask()` → within transaction: insert to archivedTasks, delete from tasks if cleanup
  - `cleanupArchivedTasks()` → for each archived task with directory: insert compact entry to archivedTasks, delete directory
  - `restoreFromArchive()` → insert back to tasks from archivedTasks.data, regenerate PROMPT.md
  - `unarchiveTask()` → check if dir exists (if not restore first), then update column in SQLite
- [ ] Replace workflow step operations:
  - `createWorkflowStep()` → within transaction: read config.workflowSteps, append new step, update config
  - `listWorkflowSteps()` → read config.workflowSteps, parse JSON array
  - `getWorkflowStep()` → find in parsed workflowSteps array
  - `updateWorkflowStep()` → find in array, update, write back to config
  - `deleteWorkflowStep()` → filter array, write back, then update tasks' enabledWorkflowSteps
- [ ] Update `duplicateTask()`, `refineTask()`:
  - Use SQLite for task creation
  - Copy attachments via disk operations
- [ ] Update `mergeTask()`:
  - Use transaction to read/update task
  - Git operations unchanged
  - Call `db.bumpLastModified()`
- [ ] Update `deleteTask()`:
  - SQLite: `DELETE FROM tasks WHERE id = ?`
  - Disk: delete directory recursively (attachments, PROMPT.md, agent.log)
  - Call `db.bumpLastModified()`
- [ ] Update `parseStepsFromPrompt()`, `parseDependenciesFromPrompt()`, `parseFileScopeFromPrompt()`:
  - Ensure they can read PROMPT.md from disk (these read files, unchanged)
- [ ] Update change detection (`watch()`, `stopWatching()`):
  - Remove `fs.watch()` based implementation
  - Implement polling: setInterval that checks `db.getLastModified()` every 1 second
  - When timestamp changes, query for changes and emit events
  - Maintain `taskCache` Map for diffing to determine event type
  - Preserve event emission: `task:created`, `task:moved`, `task:updated`, `task:deleted`, `task:merged`
- [ ] Update `init()`:
  - Ensure task directories exist for blobs (`.fusion/tasks/`)
  - `db.init()` should already be called by caller
- [ ] Preserve `getRootDir()` method (used by dashboard terminal service)
- [ ] Run targeted tests: `pnpm test packages/core/src/store.test.ts`
- [ ] Fix any failing tests

**Artifacts:**
- `packages/core/src/store.ts` (modified - large refactor)

### Step 4: AgentStore SQLite Migration

Refactor AgentStore to use SQLite.

- [ ] Update AgentStore constructor:
  ```typescript
  constructor(
    options: AgentStoreOptions & { db: Database }
  )
  ```
- [ ] Remove `rootDir`, `agentsDir` — these move to Database
- [ ] Remove `locks` Map — use `db.transaction()` instead
- [ ] Replace agent file operations:
  - `readAgentFile()` → `SELECT * FROM agents WHERE id = ?`, parse metadata JSON
  - `writeAgent()` → `INSERT OR REPLACE INTO agents ...`
  - `getAgent()` → query SQLite, parse metadata, return Agent
  - `listAgents()` → `SELECT * FROM agents ORDER BY createdAt DESC`, apply filters in code
- [ ] Replace heartbeat file operations:
  - `recordHeartbeat()` → within transaction: `INSERT INTO agentHeartbeats ...`, update agent.lastHeartbeatAt if status === 'ok'
  - `getHeartbeatHistory()` → `SELECT * FROM agentHeartbeats WHERE agentId = ? ORDER BY timestamp DESC LIMIT ?`
- [ ] Implement heartbeat run reconstruction from SQLite data:
  - `getActiveHeartbeatRun(agentId)` → query heartbeats for agent, group by runId, find run without terminal status ('missed')
  - `getCompletedHeartbeatRuns(agentId)` → query heartbeats, group by runId, filter completed/terminated
  - `startHeartbeatRun(agentId)` → record heartbeat with new runId via `recordHeartbeat()`
  - `endHeartbeatRun(runId, status)` → find agent for runId, record terminal heartbeat
- [ ] Update `createAgent()`, `updateAgent()`, `updateAgentState()`, `assignTask()`:
  - Use `db.transaction()` for atomicity
  - Update agents table
  - Call `db.bumpLastModified()`
  - Emit events (unchanged)
- [ ] Update `deleteAgent()`:
  - SQLite handles cascade delete via foreign key
  - `DELETE FROM agents WHERE id = ?`
  - Call `db.bumpLastModified()`
- [ ] Update `listAgents(filter?)`:
  - Query all, parse metadata, apply filter in code
- [ ] Remove `withLock()` promise chaining — SQLite transactions handle serialization
- [ ] Update `init()` — no longer needs to create agents directory
- [ ] Preserve all method signatures and EventEmitter behavior exactly
- [ ] Run targeted tests for AgentStore (create `packages/core/src/agent-store.test.ts` if it doesn't exist)
- [ ] Verify agent:created, agent:updated, agent:deleted, agent:heartbeat, agent:stateChanged events still fire

**Artifacts:**
- `packages/core/src/agent-store.ts` (modified)
- `packages/core/src/agent-store.test.ts` (new or modified)

### Step 5: AutomationStore SQLite Migration

Refactor AutomationStore to use SQLite.

- [ ] Update AutomationStore constructor:
  ```typescript
  constructor(
    private rootDir: string,
    private db: Database
  )
  ```
- [ ] Remove `automationsDir` — automations now in SQLite
- [ ] Remove `scheduleLocks` Map — use `db.transaction()` instead
- [ ] Replace schedule file operations:
  - `readScheduleJson()` → `SELECT * FROM automations WHERE id = ?`, parse steps/runHistory JSON
  - `atomicWriteScheduleJson()` → `INSERT OR REPLACE INTO automations ...`
  - `listSchedules()` → `SELECT * FROM automations ORDER BY createdAt`
- [ ] Update `createSchedule()`:
  - Generate UUID using `randomUUID()` (same as current)
  - Serialize `steps` and `runHistory` to JSON
  - Insert row with `db.prepare().run()`
  - Call `db.bumpLastModified()`
  - Emit `schedule:created`
- [ ] Update `updateSchedule()`:
  - Use `db.transaction()`
  - Update columns, recompute nextRunAt if scheduleType/cronExpression changed
  - Call `db.bumpLastModified()`
  - Emit `schedule:updated`
- [ ] Update `reorderSteps()`:
  - Read schedule, parse steps JSON, reorder, serialize, update
  - Call `db.bumpLastModified()`
- [ ] Update `recordRun()`:
  - Within transaction: read schedule, parse runHistory, unshift new result, cap at MAX_RUN_HISTORY, serialize, update
  - Update lastRunAt, lastRunResult, runCount, recompute nextRunAt
  - Call `db.bumpLastModified()`
  - Emit `schedule:run`
- [ ] Update `getDueSchedules()`:
  - `SELECT * FROM automations WHERE enabled = 1 AND nextRunAt <= ?`
  - Pass current ISO timestamp as parameter
- [ ] Update `deleteSchedule()`:
  - `DELETE FROM automations WHERE id = ?`
  - Call `db.bumpLastModified()`
  - Emit `schedule:deleted`
- [ ] Update `computeNextRun()` — implementation unchanged (uses cron-parser)
- [ ] Remove `withScheduleLock()` promise chaining — use `db.transaction()`
- [ ] Update `init()` — no longer needs to create automations directory
- [ ] Preserve all method signatures and EventEmitter events exactly
- [ ] Run targeted tests: `pnpm test packages/core/src/automation-store.test.ts`
- [ ] Fix any failing tests

**Artifacts:**
- `packages/core/src/automation-store.ts` (modified)

### Step 6: Dashboard SSE Update

Update the change detection mechanism to use SQLite polling.

- [ ] Read `packages/dashboard/src/sse.ts` to understand current implementation
- [ ] The current implementation listens to store events (`task:created`, `task:moved`, `task:updated`, `task:deleted`, `task:merged`)
- [ ] Verify that Store continues to emit these events (implemented in Step 3 and 4)
- [ ] No changes needed to `sse.ts` if stores continue to emit events correctly
- [ ] Update any dashboard API routes that create stores to pass Database instance:
  - Check `packages/dashboard/app/routes/` for any route files that instantiate TaskStore, AgentStore, or AutomationStore
  - Update to create `Database` instance first, pass to store constructors
- [ ] Verify dashboard can still:
  - Create tasks (through QuickEntryBox, InlineCreateCard)
  - Move tasks between columns
  - Update task details
  - Archive/unarchive tasks
  - Show real-time updates via SSE
- [ ] Run dashboard tests if available

**Artifacts:**
- `packages/dashboard/src/sse.ts` (verify no changes needed, or update if required)
- Any affected API routes in `packages/dashboard/app/routes/`

### Step 7: Store Initialization & Entry Points

Update initialization sequence to resolve Database creation before stores.

- [ ] Update `packages/core/src/index.ts`:
  - Export `Database` class from `db.ts`
  - Export `createDatabase(kbDir: string): Database` factory function
  - Export `detectLegacyData`, `migrateFromLegacy`, `getMigrationStatus` from `db-migrate.ts`
- [ ] Update CLI initialization (check `packages/cli/src/` for store creation):
  - Find where `TaskStore`, `AgentStore`, `AutomationStore` are instantiated
  - Update to create `Database` first:
    ```typescript
    import { createDatabase, detectLegacyData, migrateFromLegacy } from '@kb/core';
    
    const kbDir = join(rootDir, '.fusion');
    const db = createDatabase(kbDir);
    db.init();
    
    if (detectLegacyData(kbDir)) {
      await migrateFromLegacy(kbDir, db);
    }
    
    const store = new TaskStore(rootDir, db, globalSettingsDir);
    const agentStore = new AgentStore({ db, rootDir });
    const automationStore = new AutomationStore(rootDir, db);
    ```
- [ ] Update dashboard server initialization (check `packages/dashboard/`):
  - Same pattern: create Database, detect legacy, migrate, then create stores
- [ ] Verify `GlobalSettingsStore` remains unchanged (still file-based in `~/.pi/kb/`)
- [ ] Ensure stores handle the case where they're initialized with fresh database (no data)

**Artifacts:**
- `packages/core/src/index.ts` (modified)
- Any CLI initialization code that creates stores
- Any dashboard server initialization code

### Step 8: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full test suite: `pnpm test`
- [ ] Verify all tests pass in `packages/core/`:
  - `store.test.ts` passes
  - `agent-store.test.ts` passes (or create if missing)
  - `automation-store.test.ts` passes
  - `db.test.ts` passes
  - `db-migrate.test.ts` passes
- [ ] Run `pnpm build` to ensure no TypeScript errors across all packages
- [ ] Manual verification steps (perform these manually or document for QA):
  1. Create a fresh project: `mkdir test-project && cd test-project && git init`
  2. Run kb init (through CLI or dashboard)
  3. Verify `.fusion/fusion.db` is created
  4. Create a task → verify it appears in database and on dashboard
  5. Move task through columns → verify state updates in both DB and UI
  6. Add steering comment → verify persisted
  7. Update PR info → verify badge appears
  8. Archive a task → verify moved to `archivedTasks` table
  9. Unarchive → verify restored to `tasks` table
  10. Create an automation → verify in `automations` table
  11. Create an agent → verify in `agents` table
  12. Record heartbeat → verify in `agentHeartbeats` table
  13. View agent logs → verify agent.log file still readable
- [ ] Test backward compatibility:
  1. Create project with old file-based version (checkout old commit or manually create file structure)
  2. Create some tasks, agents, automations
  3. Run new version → verify auto-migration triggers
  4. Verify `.fusion/tasks.bak/` exists with old data
  5. Verify all data correctly migrated (IDs, columns, timestamps, JSON arrays)
  6. Verify tasks work correctly after migration
  7. Restart app → verify doesn't re-migrate (detects already migrated)

### Step 9: Documentation & Delivery

- [ ] Update `AGENTS.md` with new section:
  - "SQLite Storage Architecture" — explain hybrid approach (DB for metadata, files for blobs)
  - "Migration Notes" — explain auto-migration, backup files, recovery
  - Schema documentation — list tables and their purposes
- [ ] Create changeset file:
  ```bash
  cat > .changeset/sqlite-migration.md << 'EOF'
  ---
  "@dustinbyrne/kb": minor
  ---

  Migrate storage from file-based JSON to SQLite (hybrid with files for blobs)
  - Improved performance for large task counts
  - Better concurrent access support (WAL mode)
  - Seamless auto-migration from legacy data
  - Zero breaking changes to store APIs
  EOF
  ```
- [ ] Create follow-up tasks via `task_create` for any out-of-scope findings:
  - Performance optimization: Add additional indexes if slow queries identified
  - Schema versioning: Upgrade system for future schema changes
  - Global settings: Consider if `~/.pi/kb/settings.json` should also migrate

## Documentation Requirements

**Must Update:**
- `AGENTS.md` — Add "SQLite Storage Architecture" section explaining:
  - Database location at `.fusion/fusion.db`
  - Hybrid architecture (SQLite for metadata, files for blobs)
  - Auto-migration behavior and backup files
  - WAL mode for concurrency

**Check If Affected:**
- `packages/core/README.md` — Update if it describes storage mechanisms
- `packages/dashboard/README.md` — Update if it mentions file watching or storage

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing (`pnpm test` exits 0)
- [ ] Build passes (`pnpm build` exits 0)
- [ ] Auto-migration works seamlessly from file-based storage
- [ ] File blobs (PROMPT.md, agent.log, attachments) still work correctly
- [ ] Dashboard real-time updates work via store events (SSE unchanged)
- [ ] Steering comments, PR info, Issue info all persist correctly
- [ ] getRootDir() method preserved on TaskStore
- [ ] Documentation updated
- [ ] Changeset file created

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-310): complete Step N — description`
- **Bug fixes:** `fix(KB-310): description`
- **Tests:** `test(KB-310): description`
- **Documentation:** `docs(KB-310): description`

## Do NOT

- Modify `GlobalSettingsStore` — global settings stay in `~/.pi/kb/settings.json`
- Change any public method signatures on stores — preserve backward compatibility
- Use external SQLite dependencies — use only Node.js built-in `node:sqlite`
- Remove legacy file-based code until migration is verified working
- Delete `.fusion/*.bak` files — they are user data backups
- Skip WAL mode — concurrent access requires it
- Skip transaction handling — data integrity is critical
- Use snake_case column names — use camelCase to match TypeScript
- Remove or rename `getRootDir()` method — dashboard depends on it
