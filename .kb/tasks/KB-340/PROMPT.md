# Task: KB-340 - Automatic Recovery for Worktree Creation Failures

**Created:** 2026-03-31
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** This involves modifying core executor error handling with git worktree operations. The fix requires understanding git worktree conflict patterns and implementing robust cleanup with retry logic.
**Score:** 5/8 — Blast radius: 2, Pattern novelty: 1, Security: 1, Reversibility: 1

## Mission

Implement automatic recovery for worktree creation failures. When `git worktree add` fails because a branch is already used by another worktree, the system should detect the conflict, clean up the stale worktree/branch, and retry automatically instead of failing the task.

The error pattern to handle:
```
fatal: 'kb/kb-328' is already used by worktree at '/Users/eclipxe/Projects/kb/.worktrees/green-sage'
```

Currently this error causes the task to fail with status "failed". The goal is to detect this specific error pattern, automatically remove the conflicting worktree, delete the branch if needed, and retry worktree creation — all transparently without user intervention.

## Dependencies

- **None**

## Context to Read First

1. `packages/engine/src/executor.ts` — The `createWorktree()` method (lines ~1134-1200) and `extractWorktreeConflictPath()` helper contain current worktree creation logic and conflict detection
2. `packages/engine/src/executor.test.ts` — Existing tests for the executor to understand testing patterns
3. `packages/engine/src/merger.ts` — Contains `findWorktreeUser()` used to check if worktrees are still needed
4. `packages/core/src/types.ts` — `Task` interface with `status`, `error`, and `worktree` fields

## File Scope

- `packages/engine/src/executor.ts` — Modify `createWorktree()`, add retry logic
- `packages/engine/src/executor.test.ts` — Add tests for worktree recovery scenarios

## Steps

### Step 1: Analyze Current Worktree Creation Flow

- [ ] Read `createWorktree()` method in executor.ts thoroughly
- [ ] Understand current conflict detection in `extractWorktreeConflictPath()`
- [ ] Identify why current cleanup can fail (race conditions, locked worktrees, etc.)
- [ ] Document the failure modes that escape current handling

**Key code sections to study:**
- `createWorktree()` — worktree creation with fallback to `createFromExistingBranch()`
- `extractWorktreeConflictPath()` — regex pattern matching for conflict detection
- Current error handling that throws `Failed to create worktree`

### Step 2: Implement Robust Worktree Recovery

- [ ] Add `MAX_WORKTREE_RETRIES = 3` constant for retry attempts
- [ ] Modify `createWorktree()` to implement retry loop with exponential backoff
- [ ] Improve `extractWorktreeConflictPath()` to handle additional git error formats
- [ ] Add `cleanupConflictingWorktree()` helper method that:
  - Removes conflicting worktree with `--force`
  - Deletes the branch if it exists
  - Handles case where worktree is locked (git worktree unlock + remove)
  - Returns success/failure status
- [ ] Add detection for other worktree error patterns:
  - "fatal: invalid reference" (stale branch reference)
  - "fatal: could not create leading directories" (permission/path issues)
  - "fatal: working tree already exists" (directory exists but not registered)
- [ ] Ensure recovery logs are written to task log via `store.logEntry()`

**Artifacts:**
- Modified `executor.ts` with retry logic and improved error handling

### Step 3: Handle Edge Cases in Recovery

- [ ] Handle case where conflicting worktree belongs to another active task (don't delete, use different worktree name)
- [ ] Handle case where worktree directory exists but git doesn't track it (use `git worktree repair` or remove directory)
- [ ] Handle case where branch exists but has no worktree (delete branch and retry)
- [ ] Handle case where retry fails after 3 attempts — then fail the task with detailed error
- [ ] Add delay between retries (100ms, 500ms, 1000ms) to allow filesystem cleanup

**Edge case logic:**
- Check if conflicting worktree path is in `activeWorktrees` Map — if so, generate new worktree name instead of cleaning up
- If conflicting worktree is not in active set but exists in filesystem, safe to remove
- Always verify worktree removal succeeded before retry

### Step 4: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Add unit test: worktree creation succeeds on first attempt
- [ ] Add unit test: worktree creation fails with conflict, recovers on retry
- [ ] Add unit test: worktree creation fails 3 times, task fails with detailed error
- [ ] Add unit test: conflicting worktree belongs to active task — generates new name instead
- [ ] Add unit test: stale branch exists without worktree — branch is deleted and retry succeeds
- [ ] Add unit test: worktree directory exists but not registered — directory removed and retry succeeds
- [ ] Run full test suite: `pnpm test`
- [ ] Fix all failures
- [ ] Build passes: `pnpm build`

**Test patterns to follow from existing executor.test.ts:**
- Mock `execSync` to simulate git command responses
- Mock `existsSync` for filesystem checks
- Use `vi.mocked()` for type-safe mocks
- Test both success path and each failure recovery path

### Step 5: Documentation & Delivery

- [ ] Update inline comments in `createWorktree()` explaining the recovery flow
- [ ] Add entry to engine package CHANGELOG.md (if exists) or note in task summary
- [ ] Verify recovery logs appear in dashboard task log
- [ ] Out-of-scope findings created as new tasks via `task_create` tool:
  - If other failure patterns are discovered that need handling
  - If worktree pool integration needs similar recovery improvements

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Worktree creation automatically recovers from "already used" conflicts
- [ ] Tasks no longer fail spuriously due to stale worktree/branch conflicts
- [ ] Recovery activity is logged to task log for observability

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-340): complete Step N — description`
- **Bug fixes:** `fix(KB-340): description`
- **Tests:** `test(KB-340): description`

## Do NOT

- Change task status values or column definitions
- Modify the worktree pool logic (focus on fresh worktree creation only)
- Add new database columns or task fields
- Change the git branch naming convention (`kb/{task-id}`)
- Skip tests or rely on manual verification
- Remove existing error handling — only add recovery before final failure
