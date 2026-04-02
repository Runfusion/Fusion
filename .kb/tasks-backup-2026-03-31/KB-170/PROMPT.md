# Task: KB-170 - Clean up worktree/branch on retry when branch already exists

**Created:** 2026-03-30
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** This is a targeted fix for a specific failure mode in worktree creation. The blast radius is limited to the executor's worktree management code. Pattern novelty is low (standard error handling and cleanup retry logic). Security impact is minimal (only affects local git operations). Reversibility is high (changes are additive error handling).
**Score:** 3/8 — Blast radius: 1, Pattern novelty: 0, Security: 1, Reversibility: 1

## Mission

Fix a worktree creation failure that occurs when a failed task is retried. The error "fatal: 'kb/kb-XXX' is already used by worktree at '/path/to/.worktrees/...'" happens because the previous worktree still exists with the same branch. When retrying, if a new worktree path is generated, git refuses to create it because the branch is already checked out in the old worktree.

The fix: detect this specific error, clean up the conflicting worktree/branch, and retry the worktree creation automatically.

## Dependencies

- **None**

## Context to Read First

- `packages/engine/src/executor.ts` — The `createWorktree` method (around line 770) where the fix should be implemented
- `packages/engine/src/executor.test.ts` — Existing test patterns for executor worktree handling
- `packages/engine/src/worktree-pool.ts` — For reference on worktree cleanup patterns

## File Scope

- `packages/engine/src/executor.ts` — Modify `createWorktree` method to handle branch-already-used errors
- `packages/engine/src/executor.test.ts` — Add tests for the retry cleanup scenario

## Steps

### Step 1: Implement Worktree Conflict Detection and Cleanup

- [ ] Modify `createWorktree` method in `packages/engine/src/executor.ts` to catch "already used by worktree" errors
- [ ] Parse the conflicting worktree path from the git error message
- [ ] Attempt to remove the conflicting worktree using `git worktree remove --force`
- [ ] Attempt to delete the branch using `git branch -D`
- [ ] Retry the worktree creation after cleanup
- [ ] If cleanup fails, throw the original error with additional context
- [ ] Run targeted tests for executor worktree creation

**Implementation details:**
The git error message format is:
```
fatal: 'kb/kb-064' is already used by worktree at '/Users/eclipxe/Projects/kb/.worktrees/sharp-stone'
```

Parse this to extract the worktree path, then:
1. `git worktree remove "{path}" --force`
2. `git branch -D "{branch}"`
3. Retry the original `git worktree add` command

**Artifacts:**
- `packages/engine/src/executor.ts` (modified)

### Step 2: Add Tests for Retry Cleanup Scenario

- [ ] Add test case: "retries worktree creation after cleaning up conflicting worktree"
- [ ] Mock `execSync` to simulate the "already used by worktree" error on first call, then succeed on retry
- [ ] Verify that `git worktree remove` and `git branch -D` are called with correct paths
- [ ] Verify the worktree is ultimately created successfully
- [ ] Add test case: "throws original error if cleanup also fails"
- [ ] Run all new tests to verify they pass

**Artifacts:**
- `packages/engine/src/executor.test.ts` (modified)

### Step 3: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full test suite: `pnpm test`
- [ ] Fix all failures
- [ ] Build passes: `pnpm build`

### Step 4: Documentation & Delivery

- [ ] Add changeset file for the fix: `.changeset/fix-worktree-retry-cleanup.md`
- [ ] Out-of-scope findings created as new tasks via `task_create` tool if any

## Documentation Requirements

**Must Update:**
- `.changeset/fix-worktree-retry-cleanup.md` — Describe the fix for worktree cleanup on retry

**Check If Affected:**
- `AGENTS.md` — Check if worktree error handling behavior is documented (update if relevant)

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Documentation updated
- [ ] Changeset created

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-170): complete Step N — description`
- **Bug fixes:** `fix(KB-170): description`
- **Tests:** `test(KB-170): description`
- **Changeset:** Include changeset file in the relevant step commit

## Do NOT

- Expand task scope to general worktree management refactoring
- Skip tests or rely only on manual verification
- Modify behavior of successful worktree creation paths (only add error recovery)
- Change the worktree naming or pooling behavior
- Commit without the task ID prefix
