# Task: KB-327 - Enable automatic database backups (user configurable retention and interval)

**Created:** 2026-03-31
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** This task introduces backup functionality into the existing SQLite storage system. It integrates with established settings and automation patterns, requiring new project settings and a backup automation that runs on a schedule. The blast radius is limited to backup-related additions, but proper integration with the automation system and retention cleanup requires verification.

**Score:** 5/8 — Blast radius: 1, Pattern novelty: 1, Security: 1, Reversibility: 2

## Mission

Implement automatic database backup functionality for kb's SQLite database (`.fusion/fusion.db`). Users can configure backup intervals, retention policies, and storage location through project settings. Backups run as scheduled automations using the existing cron-runner infrastructure.

This feature protects user data by automatically creating timestamped database backups that can be restored if the primary database becomes corrupted. Users can configure how often backups occur and how many historical backups to retain.

## Dependencies

- **Task:** KB-310 (Migrate from file-based storage to SQLite) — The SQLite database must exist before backups can be created.

## Context to Read First

1. `packages/core/src/types.ts` — ProjectSettings interface and DEFAULT_PROJECT_SETTINGS
2. `packages/core/src/automation.ts` — Automation types (ScheduledTask, ScheduleType, AUTOMATION_PRESETS)
3. `packages/core/src/automation-store.ts` — How schedules are created and managed
4. `packages/core/src/cron-runner.ts` — How scheduled tasks are executed
5. `packages/core/src/store.ts` — TaskStore initialization to see how database path is determined
6. `packages/dashboard/app/routes/settings.ts` — Settings API routes for reference

## File Scope

### New Files
- `packages/core/src/backup.ts` — Backup manager with createBackup() and cleanupOldBackups()

### Modified Files
- `packages/core/src/types.ts` — Add backup settings to ProjectSettings and DEFAULT_PROJECT_SETTINGS
- `packages/core/src/index.ts` — Export backup utilities
- `packages/core/src/automation.ts` — Add built-in "backup" automation preset to AUTOMATION_PRESETS
- `packages/dashboard/app/routes/settings.ts` — Handle backup settings in PUT /api/settings
- `packages/dashboard/app/components/SettingsModal.tsx` — Add backup settings UI section

### Test Files
- `packages/core/src/backup.test.ts` — Unit tests for backup functionality

## Steps

### Step 1: Add Backup Settings

Add user-configurable backup settings to the project settings schema.

- [ ] Update `ProjectSettings` interface in `packages/core/src/types.ts`:
  ```typescript
  export interface ProjectSettings {
    // ... existing fields ...
    
    /** When true, automatic database backups are enabled. Default: false. */
    autoBackupEnabled?: boolean;
    /** Cron expression for backup schedule. Default: "0 2 * * *" (daily at 2 AM). */
    autoBackupSchedule?: string;
    /** Number of backup files to retain (oldest deleted when exceeded). Default: 7. */
    autoBackupRetention?: number;
    /** Directory for backup files, relative to project root. Default: ".fusion/backups". */
    autoBackupDir?: string;
  }
  ```
- [ ] Update `DEFAULT_PROJECT_SETTINGS` in `packages/core/src/types.ts`:
  ```typescript
  export const DEFAULT_PROJECT_SETTINGS: ProjectSettings = {
    // ... existing defaults ...
    autoBackupEnabled: false,
    autoBackupSchedule: "0 2 * * *",
    autoBackupRetention: 7,
    autoBackupDir: ".fusion/backups",
  };
  ```
- [ ] Add new keys to `PROJECT_SETTINGS_KEYS` array in `packages/core/src/types.ts`:
  ```typescript
  export const PROJECT_SETTINGS_KEYS: ReadonlyArray<keyof ProjectSettings> = [
    // ... existing keys ...
    "autoBackupEnabled",
    "autoBackupSchedule",
    "autoBackupRetention",
    "autoBackupDir",
  ] as const;
  ```
- [ ] Run `pnpm build` to verify TypeScript compiles

**Artifacts:**
- `packages/core/src/types.ts` (modified)

### Step 2: Create Backup Manager

Create the backup functionality with create, restore, and cleanup operations.

- [ ] Create `packages/core/src/backup.ts` with the following exports:
  - `BackupManager` class
  - `BackupInfo` interface for backup metadata
  - `createBackupManager(kbDir: string, options?: BackupOptions): BackupManager`

- [ ] Implement `BackupInfo` interface:
  ```typescript
  export interface BackupInfo {
    filename: string;        // e.g., "kb-2026-03-31-020000.db"
    createdAt: string;       // ISO-8601 timestamp
    size: number;           // bytes
    path: string;          // full absolute path
  }
  ```

- [ ] Implement `BackupOptions` interface:
  ```typescript
  export interface BackupOptions {
    backupDir?: string;      // relative path from project root, default ".fusion/backups"
    retention?: number;      // number of backups to keep, default 7
  }
  ```

- [ ] Implement `BackupManager` class with these methods:
  - `constructor(kbDir: string, options?: BackupOptions)` — stores paths and options
  - `async createBackup(): Promise<BackupInfo>` — creates a timestamped backup
    - Source: `join(kbDir, "fusion.db")`
    - Target: `join(kbDir, backupDir, "kb-{YYYY-MM-DD-HHmmss}.db")`
    - Use `cp` from `node:fs/promises` to copy database file
    - Ensure backup directory exists with `mkdir(..., { recursive: true })`
    - Get file size with `stat()` after copy
    - Return BackupInfo object
  - `async listBackups(): Promise<BackupInfo[]>` — returns sorted array (newest first)
    - Read backup directory
    - Filter files matching pattern `kb-*.db`
    - Parse filename timestamps
    - Return sorted by createdAt descending
  - `async cleanupOldBackups(): Promise<number>` — deletes excess backups, returns count deleted
    - List backups, sort by createdAt ascending (oldest first)
    - If count > retention, delete oldest files until count equals retention
    - Use `unlink()` to delete files
    - Return number of files deleted
  - `async restoreBackup(filename: string): Promise<void>` — restores backup to main database
    - Source: `join(kbDir, backupDir, filename)`
    - Target: `join(kbDir, "fusion.db")`
    - Verify source file exists
    - Optional: Create a "pre-restore" backup of current database first
    - Copy backup file to main database location

- [ ] Add helper function `generateBackupFilename(): string`:
  - Format: `kb-{YYYY-MM-DD}-{HHmmss}.db`
  - Use current UTC or local time (consistent with other timestamps in codebase)

- [ ] Add validation for backup settings:
  - `validateBackupSchedule(schedule: string): boolean` — uses `cron-parser` to validate (import from automation.ts if needed)
  - `validateBackupRetention(retention: number): boolean` — must be >= 1 and <= 100

- [ ] Write unit tests in `packages/core/src/backup.test.ts`:
  - Create backup file exists with correct name pattern
  - Create backup copies database content correctly
  - List backups returns sorted newest-first
  - Cleanup removes oldest files exceeding retention
  - Restore backup copies file to correct location
  - Invalid retention values are rejected

**Artifacts:**
- `packages/core/src/backup.ts` (new)
- `packages/core/src/backup.test.ts` (new)

### Step 3: Add Built-in Backup Automation

Add a built-in automation preset that users can enable for automatic backups.

- [ ] Update `packages/core/src/automation.ts` to add a "backup" preset to `AUTOMATION_PRESETS`:
  ```typescript
  export const AUTOMATION_PRESETS: Record<ScheduleType, string> = {
    hourly: "0 * * * *",
    daily: "0 0 * * *",
    weekly: "0 0 * * 0",
    monthly: "0 0 1 * *",
    custom: "", // user-provided
  };
  ```
  (No change needed to presets - we use the custom schedule from settings)

- [ ] Add a `runBackupCommand()` function in `packages/core/src/backup.ts` that can be called by the automation system:
  ```typescript
  export async function runBackupCommand(
    kbDir: string,
    settings: ProjectSettings
  ): Promise<{ success: boolean; output: string; backupPath?: string }>
  ```
  - Check if autoBackupEnabled is true
  - Create BackupManager with settings
  - Call createBackup()
  - Call cleanupOldBackups()
  - Return result with success status, output message, and backup path

- [ ] Create a built-in automation for backups that the system can use. Since the cron-runner executes shell commands or AI prompts, the backup should be exposed as a CLI command.

- [ ] Add CLI command in `packages/cli/src/bin.ts` (or appropriate CLI file):
  ```typescript
  // Add subcommand: kb backup
  // Options: --create, --list, --restore <filename>, --cleanup
  ```
  - `kb backup --create` — creates a backup immediately
  - `kb backup --list` — lists all backups
  - `kb backup --cleanup` — removes old backups exceeding retention
  - `kb backup --restore <filename>` — restores specified backup

**Artifacts:**
- `packages/core/src/backup.ts` (modified - add runBackupCommand)
- CLI backup command added

### Step 4: Integrate Backup with Settings API

Ensure backup settings are properly persisted and applied.

- [ ] Review `packages/dashboard/app/routes/settings.ts` — ensure it accepts backup settings
  - The PUT `/api/settings` endpoint should already pass through all project settings
  - Verify backup settings are filtered correctly (they are project settings, not global)

- [ ] Add validation in settings route:
  - Validate autoBackupSchedule is a valid cron expression when provided
  - Validate autoBackupRetention is between 1 and 100
  - Validate autoBackupDir is a valid relative path (no absolute paths, no parent directory traversal `..`)

- [ ] Add setting migration/initialization in `TaskStore.init()` or settings loading:
  - When backup settings are missing, they should default to DEFAULT_PROJECT_SETTINGS values
  - This happens automatically via the spread operator in `getSettings()`

**Artifacts:**
- `packages/dashboard/app/routes/settings.ts` (validated/modified)

### Step 5: Dashboard UI for Backup Settings

Add UI controls in the Settings modal for configuring automatic backups.

- [ ] Update `packages/dashboard/app/components/SettingsModal.tsx`:
  - Add a new "Backups" section in the sidebar
  - Add toggle for `autoBackupEnabled` (switch/checkbox)
  - Add text input for `autoBackupSchedule` with:
    - Help text explaining cron format (e.g., "0 2 * * * = daily at 2 AM")
    - Validation indicator (green checkmark if valid, red X if invalid)
    - Preset buttons: "Hourly", "Daily", "Weekly", "Monthly"
  - Add number input for `autoBackupRetention` (1-100)
  - Add text input for `autoBackupDir` (default ".fusion/backups")

- [ ] Add visual feedback:
  - When backup settings are changed, show a preview of "Next backup: [calculated time]"
  - Show current backup count: "X backups stored (X MB total)"
  - Add "Backup Now" button to trigger immediate backup
  - Add "View Backups" button/link (could open file explorer or show list)

- [ ] Ensure settings are saved with correct scope (project settings)

**Artifacts:**
- `packages/dashboard/app/components/SettingsModal.tsx` (modified)

### Step 6: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full test suite: `pnpm test`
- [ ] Verify backup unit tests pass:
  - `packages/core/src/backup.test.ts` all green
- [ ] Test backup creation manually:
  1. Enable autoBackup in settings
  2. Set schedule to run in 1 minute (`* * * * *`)
  3. Wait for automation to trigger
  4. Verify backup file created in `.fusion/backups/`
  5. Verify file is valid SQLite (can be opened)
- [ ] Test retention cleanup:
  1. Set retention to 3
  2. Create 5 manual backups
  3. Trigger cleanup
  4. Verify only 3 newest remain
- [ ] Test restore:
  1. Create a task
  2. Create backup
  3. Delete the task
  4. Restore from backup
  5. Verify task reappears
- [ ] Test settings validation:
  - Invalid cron expression rejected
  - Retention > 100 rejected
  - Path with ".." rejected

**Artifacts:**
- All tests passing
- Manual verification complete

### Step 7: Documentation & Delivery

- [ ] Update `AGENTS.md` with backup settings documentation:
  - Add section under Settings explaining the four backup options
  - Document default values and behavior
  - Explain backup file naming and location
  - Document restore process
- [ ] Create changeset file:
  ```bash
  cat > .changeset/auto-database-backup.md << 'EOF'
  ---
  "@dustinbyrne/kb": minor
  ---

  Add automatic database backup feature
  - Configurable backup schedule (cron expression)
  - Configurable retention policy (number of backups to keep)
  - Manual backup and restore via CLI
  - Dashboard settings UI for configuration
  EOF
  ```
- [ ] Verify exports in `packages/core/src/index.ts` include backup utilities:
  - `BackupManager`
  - `BackupInfo`
  - `BackupOptions`
  - `createBackupManager`
  - `runBackupCommand`

**Artifacts:**
- `AGENTS.md` (modified)
- `.changeset/auto-database-backup.md` (new)
- `packages/core/src/index.ts` (modified exports)

## Documentation Requirements

**Must Update:**
- `AGENTS.md` — Add section under "Settings" documenting:
  - `autoBackupEnabled` — enables automatic scheduled backups
  - `autoBackupSchedule` — cron expression for backup timing
  - `autoBackupRetention` — how many backups to keep
  - `autoBackupDir` — where backups are stored
  - Default values and example configurations

**Check If Affected:**
- `packages/core/README.md` — Update if it lists available settings
- `packages/dashboard/README.md` — Update if it documents UI features

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing (`pnpm test` exits 0)
- [ ] Build passes (`pnpm build` exits 0)
- [ ] Backup settings appear in dashboard Settings modal
- [ ] Manual backup creation works via CLI (`kb backup --create`)
- [ ] Automatic backup automation runs on schedule
- [ ] Retention cleanup removes old backups correctly
- [ ] Restore function works correctly
- [ ] Settings validation rejects invalid inputs
- [ ] Documentation updated
- [ ] Changeset file created

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-327): complete Step N — description`
- **Bug fixes:** `fix(KB-327): description`
- **Tests:** `test(KB-327): description`
- **Documentation:** `docs(KB-327): description`

## Do NOT

- Store backups outside the project directory (security/privacy risk)
- Allow absolute paths for backup directory (should be relative to project root)
- Allow parent directory traversal (`..`) in backup paths
- Modify existing automation presets (create new ones if needed)
- Remove the ability to disable backups (autoBackupEnabled must work)
- Skip validation of cron expressions (invalid schedules will crash the runner)
- Use compression initially (start with simple file copies, compression can be added later)
- Backup blob files (PROMPT.md, agent.log, attachments) — backup only the SQLite database
