# Task: KB-156 - Cleanup Archived Tasks from Filesystem

**Created:** 2026-03-30
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** This task modifies core data storage patterns in TaskStore, affecting archive/unarchive operations and introducing a new archive log format. The blast radius is limited to the core package, but the pattern for serializing task data without agent output is novel.
**Score:** 5/8 — Blast radius: 1, Pattern novelty: 2, Security: 1, Reversibility: 1

## Mission

Implement a filesystem cleanup mechanism for archived tasks that reduces storage overhead while preserving the ability to restore tasks later. When tasks are archived, their full task directories (including potentially large agent.log files) should be condensed into a compact archive log entry, and the original task files removed. The system must support restoring archived tasks back to their original state when unarchived.

## Dependencies

- **None**

## Context to Read First

- `packages/core/src/store.ts` — TaskStore class with `archiveTask()` and `unarchiveTask()` methods
- `packages/core/src/types.ts` — Task type definitions and interfaces
- `packages/core/src/store.test.ts` — Existing test patterns for TaskStore operations
- `.fusion/tasks/KB-057/task.json` — Example archived task structure (task in "archived" column)
- `.fusion/tasks/KB-057/` — Example task directory showing files: task.json, PROMPT.md, agent.log

## File Scope

- `packages/core/src/store.ts` — Modify archiveTask(), unarchiveTask(), add cleanupArchive(), restoreFromArchive()
- `packages/core/src/types.ts` — Add ArchivedTaskEntry interface
- `packages/core/src/store.test.ts` — Add tests for archive cleanup and restore
- `.fusion/archive.jsonl` — New archive log file (JSON Lines format, created as needed)

## Steps

### Step 1: Archive Data Model and Types

- [ ] Add `ArchivedTaskEntry` interface in `types.ts` containing: id, title, description, column, dependencies, steps, currentStep, size, reviewLevel, prInfo, issueInfo, attachments metadata (without file content), log entries, createdAt, updatedAt, columnMovedAt, archivedAt timestamp — explicitly EXCLUDE agent log content
- [ ] Export the new interface from `packages/core/src/index.ts` if needed for tests
- [ ] Add `archiveLogPath` getter in TaskStore pointing to `.fusion/archive.jsonl`

**Artifacts:**
- `packages/core/src/types.ts` (modified)

### Step 2: Archive Cleanup Implementation

- [ ] Add `cleanupArchivedTasks()` method to TaskStore that:
  - Reads all tasks in "archived" column
  - For each archived task with existing directory, creates compact archive entry
  - Appends entry to `.fusion/archive.jsonl` as JSON line (atomic append)
  - Removes entire task directory recursively after successful archive
  - Skips tasks already cleaned up (directory already gone)
- [ ] Add `readArchiveLog(): Promise<ArchivedTaskEntry[]>` method to parse archive.jsonl
- [ ] Add `findInArchive(id: string): Promise<ArchivedTaskEntry | undefined>` method
- [ ] Handle edge case: archive.jsonl may not exist yet (return empty array)

**Artifacts:**
- `packages/core/src/store.ts` (modified)

### Step 3: Restore from Archive

- [ ] Modify `unarchiveTask()` to check if task directory exists:
  - If directory exists: use existing behavior (update task.json column)
  - If directory missing: restore from archive.jsonl entry first
- [ ] Add `restoreFromArchive(entry: ArchivedTaskEntry): Promise<Task>` method that:
  - Recreates task directory
  - Writes task.json from archive entry (column set to "done")
  - Writes PROMPT.md with basic structure (mission + description)
  - Restores attachment directory structure (files remain gone, just directory)
  - Does NOT recreate agent.log (expected to be missing after restore)
- [ ] After restore, emit `task:updated` event

**Artifacts:**
- `packages/core/src/store.ts` (modified)

### Step 4: Archive Task Integration

- [ ] Modify `archiveTask()` to accept optional `cleanup: boolean` parameter (default: false for backward compatibility)
  - When cleanup=true, call `cleanupArchivedTasks()` after archiving
- [ ] Add public `archiveTaskAndCleanup(id: string)` convenience method
- [ ] Ensure atomicity: archive entry written before directory deletion

**Artifacts:**
- `packages/core/src/store.ts` (modified)

### Step 5: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Add test: `cleanupArchivedTasks()` writes compact entry to archive.jsonl without agent log
- [ ] Add test: `cleanupArchivedTasks()` removes task directory after archiving
- [ ] Add test: `cleanupArchivedTasks()` skips already-cleaned-up tasks (idempotent)
- [ ] Add test: `unarchiveTask()` restores missing task from archive.jsonl
- [ ] Add test: `unarchiveTask()` works normally when task directory exists
- [ ] Add test: Restored task has correct column ("done") and preserved metadata
- [ ] Add test: Archive log survives TaskStore reinitialization
- [ ] Run full test suite: `pnpm test`
- [ ] Fix all failures
- [ ] Build passes: `pnpm build`

**Artifacts:**
- `packages/core/src/store.test.ts` (modified)

### Step 6: Documentation & Delivery

- [ ] Create changeset file for patch release
- [ ] Update AGENTS.md if there are storage pattern changes worth noting

**Artifacts:**
- `.changeset/cleanup-archived-tasks.md` (new)

## Documentation Requirements

**Must Update:**
- `AGENTS.md` — Add note about archive cleanup feature and `.fusion/archive.jsonl` file format

**Check If Affected:**
- `README.md` — Check if task storage documentation exists and update if relevant

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Archive cleanup successfully serializes archived tasks without agent output
- [ ] Unarchive correctly restores tasks from archive log when directory missing
- [ ] Changeset created for patch release

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-156): complete Step N — description`
- **Bug fixes:** `fix(KB-156): description`
- **Tests:** `test(KB-156): description`

## Do NOT

- Delete archived tasks permanently without archive log entry
- Include agent.log content in archive entries (bloats archive file)
- Modify the archive.jsonl file format after initial write (append-only)
- Change existing archiveTask() behavior when cleanup=false
- Remove attachment file content (just metadata in archive, files will be gone)
- Create restore functionality that regenerates agent logs (they're intentionally lost)
- Modify task IDs or creation timestamps during restore
