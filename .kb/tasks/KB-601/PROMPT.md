# Task: KB-601 - Fix ENOENT error when unpausing tasks with missing directories

**Created:** 2026-03-31
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** Simple defensive fix with clear failure mode - adding directory existence check before file writes. Low blast radius, no API changes.
**Score:** 2/8 — Blast radius: 0, Pattern novelty: 0, Security: 1, Reversibility: 1

## Mission

Fix a bug where unpausing tasks fails with `ENOENT: no such file or directory, open '/path/to/.fusion/tasks/KB-XXX/task.json.tmp'`. The root cause is that `atomicWriteTaskJson` attempts to write to a task directory that may not exist on disk, even though the task metadata exists in SQLite. This can occur when task directories are manually deleted, corrupted, or when archive/cleanup operations leave the database in an inconsistent state.

The fix ensures the task directory is created (if missing) before attempting to write files to it, making the file operations resilient to missing directories.

## Dependencies

- **None**

## Context to Read First

- `packages/core/src/store.ts` — Read the `atomicWriteTaskJson` method (around line 391) to understand the current write pattern
- `packages/core/src/store.ts` — Read `pauseTask` method (around line 935) to see the call path that triggers the error
- `packages/core/src/store.test.ts` — Review existing pause/unpause tests for test patterns

## File Scope

- `packages/core/src/store.ts` — Modify `atomicWriteTaskJson` method to ensure directory exists
- `packages/core/src/store.test.ts` — Add test for pause/unpause with missing directory

## Steps

### Step 1: Fix atomicWriteTaskJson to Ensure Directory Exists

- [ ] Add `mkdir(dir, { recursive: true })` before writing `task.json.tmp` in `atomicWriteTaskJson`
- [ ] Import `mkdir` from `node:fs/promises` if not already imported (check existing imports)
- [ ] Place the mkdir call before the `writeFile` call for the tmp file
- [ ] Ensure the change is minimal and doesn't affect the existing SQLite write behavior

**Artifacts:**
- `packages/core/src/store.ts` (modified)

### Step 2: Add Test for Missing Directory Scenario

- [ ] Create test case that:
  1. Creates a task (which creates directory)
  2. Manually deletes the task directory
  3. Calls `pauseTask` with `paused: true`
  4. Verifies the directory is recreated and pause succeeds
  5. Calls `pauseTask` with `paused: false`
  6. Verifies unpause also succeeds
- [ ] Verify test fails before the fix and passes after
- [ ] Run the specific test to ensure it passes

**Artifacts:**
- `packages/core/src/store.test.ts` (modified)

### Step 3: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full test suite: `pnpm test`
- [ ] Fix all failures
- [ ] Run build: `pnpm build`

### Step 4: Documentation & Delivery

- [ ] Create changeset file for the patch fix (bug fix, not user-facing feature)
- [ ] No documentation updates needed (internal bug fix)

## Documentation Requirements

**Must Update:**
- None — internal bug fix

**Check If Affected:**
- None

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Build passes
- [ ] Changeset created

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-601): complete Step N — description`
- **Bug fixes:** `fix(KB-601): description`
- **Tests:** `test(KB-601): description`

## Do NOT

- Expand task scope beyond the directory existence fix
- Skip tests
- Modify other methods unless directly related to this fix
- Change the SQLite storage behavior (only the file backup path needs fixing)
