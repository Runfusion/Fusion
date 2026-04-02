# Task: KB-304 - Investigate and Fix Lost Tasks Issue

**Created:** 2026-03-31
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** This is a data integrity bug investigation. Tasks are being "lost" where the directory exists but task.json is missing (observed with KB-091). The fix needs to handle recovery, add diagnostics, and prevent future occurrences without breaking existing functionality.

**Score:** 5/8 — Blast radius: 2, Pattern novelty: 1, Security: 1, Reversibility: 1

## Mission

Investigate and fix the "lost tasks" issue where task directories exist but their `task.json` files are missing or corrupted. Implement diagnostics to detect orphaned task directories, add recovery mechanisms where possible, and ensure data integrity during task lifecycle operations. The root cause appears to be interrupted file operations or race conditions during task archive/cleanup or write operations.

## Dependencies

- **None**

## Context to Read First

1. `packages/core/src/store.ts` — TaskStore implementation, especially `listTasks()`, `readTaskJson()`, `archiveTask()`, `cleanupArchivedTasks()`, and `atomicWriteTaskJson()` methods
2. `packages/core/src/store.test.ts` — Existing tests for task persistence and archive operations
3. `.fusion/tasks/KB-091/` — Example of a "lost" task directory (exists but has no task.json)

## File Scope

- `packages/core/src/store.ts` (modify)
- `packages/core/src/store.test.ts` (modify)
- `packages/dashboard/src/routes.ts` (modify — add diagnostic endpoint)
- `packages/cli/src/commands/task.ts` (modify — add diagnostic CLI command)

## Steps

### Step 1: Diagnostics — Detect Orphaned Task Directories

Implement functionality to detect and report "lost" tasks — directories in `.fusion/tasks/` that have invalid or missing `task.json` files.

- [ ] Add `detectOrphanedTasks()` method to TaskStore that:
  - Scans all directories in `.fusion/tasks/`
  - Validates each has a readable, parseable `task.json`
  - Returns list of orphaned directories with details (path, error type, any recoverable data)
- [ ] Add `getOrphanedTaskInfo(dir: string)` helper to analyze what's recoverable from orphaned directory (PROMPT.md content, attachments, agent.log)
- [ ] Add `GET /api/tasks/diagnostics/orphaned` endpoint in dashboard routes that returns orphaned task report
- [ ] Add `kb task doctor` CLI command that prints orphaned task report with recommendations
- [ ] Write tests for `detectOrphanedTasks()` covering:
  - Directory with missing task.json
  - Directory with corrupted/invalid JSON
  - Directory with valid task.json (should not be flagged)
  - Empty tasks directory

**Artifacts:**
- `packages/core/src/store.ts` — `detectOrphanedTasks()`, `getOrphanedTaskInfo()` methods (modified)
- `packages/dashboard/src/routes.ts` — `GET /api/tasks/diagnostics/orphaned` endpoint (modified)
- `packages/cli/src/commands/task.ts` — `kb task doctor` command (modified)
- `packages/core/src/store.test.ts` — Tests for orphaned task detection (modified)

### Step 2: Recovery — Restore Lost Tasks from Available Data

Implement recovery mechanisms to reconstruct lost tasks from whatever data remains in their directories.

- [ ] Add `recoverTask(dir: string)` method to TaskStore that:
  - Attempts to parse PROMPT.md to extract task title and description
  - Creates minimal viable task.json with "recovered" status
  - Preserves any attachments in the recovered task
  - Logs recovery action to task log
  - Returns recovered Task or throws if unrecoverable
- [ ] Add `parsePromptForRecovery(content: string)` helper to extract:
  - Title from heading (e.g., "# KB-091: Title" → "Title")
  - Description from Mission section or first paragraph
  - Original creation date if available
- [ ] Add `POST /api/tasks/:id/recover` endpoint for dashboard recovery
- [ ] Add `kb task recover <id>` CLI command
- [ ] Write tests for `recoverTask()` covering:
  - Recovery from valid PROMPT.md
  - Recovery with attachments preserved
  - Failure case when no recoverable data exists
  - Task gets "recovered" status and appropriate log entry

**Artifacts:**
- `packages/core/src/store.ts` — `recoverTask()`, `parsePromptForRecovery()` methods (modified)
- `packages/dashboard/src/routes.ts` — `POST /api/tasks/:id/recover` endpoint (modified)
- `packages/cli/src/commands/task.ts` — `kb task recover` command (modified)
- `packages/core/src/store.test.ts` — Tests for task recovery (modified)

### Step 3: Hardening — Improve Write Resilience

Enhance atomic write operations to reduce the chance of orphaned tasks due to interrupted writes.

- [ ] Review `atomicWriteTaskJson()` implementation — verify temp file is always cleaned up on failure
- [ ] Add write verification step: after rename, read back and validate JSON before considering write successful
- [ ] Add `fsync` or equivalent to ensure data reaches disk before rename (Node.js `fs.promises.open` with `O_SYNC` flag or manual sync)
- [ ] Ensure cleanup of `.tmp` files on process exit/startup to prevent accumulation
- [ ] Add defensive check in `listTasks()` to log (but not crash on) orphaned directories in non-test environments
- [ ] Write tests for:
  - Temp file cleanup on write failure
  - Recovery from partial write (corrupted JSON detected and handled)

**Artifacts:**
- `packages/core/src/store.ts` — Enhanced `atomicWriteTaskJson()` with verification and cleanup (modified)
- `packages/core/src/store.test.ts` — Tests for write resilience (modified)

### Step 4: Verification — Validate Against Real Data

Run diagnostics against the actual project to identify and fix any real orphaned tasks.

- [ ] Run `detectOrphanedTasks()` against `.fusion/tasks/` in the kb project
- [ ] Document findings for KB-091 and any other orphaned tasks
- [ ] Attempt recovery of orphaned tasks using `recoverTask()`
- [ ] Verify recovered tasks are valid and appear in dashboard
- [ ] For unrecoverable tasks, create archive entries and clean up directories
- [ ] Ensure all 286 task directories are accounted for (valid, recovered, or intentionally archived)

**Artifacts:**
- Recovery report (can be committed as `.fusion/orphaned-tasks-report.json` or kept as local artifact)

### Step 5: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full test suite: `pnpm test`
- [ ] Fix all failures
- [ ] Build passes: `pnpm build`
- [ ] Manual test of `kb task doctor` command
- [ ] Manual test of dashboard diagnostics endpoint via API client

### Step 6: Documentation & Delivery

- [ ] Update `AGENTS.md` if new CLI commands or recovery procedures are added
- [ ] Add changeset for the fix: `.changeset/fix-lost-tasks.md`
- [ ] Create follow-up task via `task_create` for implementing proactive orphaned task monitoring (periodic background check)

## Documentation Requirements

**Must Update:**
- `AGENTS.md` — Document the new `kb task doctor` and `kb task recover` commands
- `.changeset/fix-lost-tasks.md` — Changeset describing the fix

**Check If Affected:**
- `packages/cli/README.md` — Update if CLI commands section exists
- `packages/dashboard/README.md` — Document new API endpoint if applicable

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Documentation updated
- [ ] At least one real orphaned task (KB-091) is either recovered or properly archived
- [ ] `kb task doctor` successfully reports task health status

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-304): complete Step N — description`
- **Bug fixes:** `fix(KB-304): description`
- **Tests:** `test(KB-304): description`

## Do NOT

- Delete orphaned task directories without attempting recovery first
- Change the task ID format or directory structure
- Skip the verification step in atomic writes (performance concern is secondary to data integrity)
- Ignore existing tests — all must pass
