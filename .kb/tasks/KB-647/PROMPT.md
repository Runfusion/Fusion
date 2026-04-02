# Task: KB-647 - Add recovery when worktree is in use

**Created:** 2026-04-01
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** This is a focused bug fix in the worktree creation fallback logic. The issue is well-understood: when `createFromExistingBranch()` fails with "already used by worktree", the error bypasses the conflict recovery logic. The fix is surgical - applying the same conflict handling to the fallback path.
**Score:** 3/8 — Blast radius: 1, Pattern novelty: 1, Security: 0, Reversibility: 1

## Mission

Fix a bug where worktree conflicts from the `createFromExistingBranch()` fallback path are not recovered, causing tasks to fail with "Failed to create worktree after 3 attempts" even when recovery is possible.

The error occurs because:
1. `tryCreateWorktree()` first attempts `createWithBranch()` (with `-b` flag to create a new branch)
2. If that fails for reasons OTHER than "already used" (e.g., branch already exists), it falls through
3. The code then tries `createFromExistingBranch()` (without `-b` flag, using existing branch)
4. If THIS throws "already used by worktree", the error is caught and re-thrown as a generic error WITHOUT going through conflict recovery
5. The conflict recovery logic only handles errors from the initial `createWithBranch()` call

The fix: Extract the "already used by worktree" conflict recovery logic into a reusable method and call it from both the `createWithBranch()` error handler and the `createFromExistingBranch()` error handler.

## Dependencies

- **None**

## Context to Read First

- `packages/engine/src/executor.ts` — Lines 1320-1430, particularly:
  - `tryCreateWorktree()` method (lines ~1327)
  - `createWithBranch()` closure (lines ~1356)
  - `createFromExistingBranch()` closure (lines ~1360)
  - Conflict handling block for "already-used" (lines ~1364-1392)
  - Fallback `createFromExistingBranch()` call (lines ~1419-1425)

## File Scope

- `packages/engine/src/executor.ts` — Add conflict recovery to the `createFromExistingBranch()` fallback path
- `packages/engine/src/executor.test.ts` — Add test case for this specific scenario

## Steps

### Step 1: Extract and Reuse Conflict Recovery Logic

- [ ] Locate the "already used by worktree" conflict handling block in `tryCreateWorktree()` (around lines 1364-1392)
- [ ] Extract this logic into a private helper method `handleWorktreeConflict(conflictPath: string, branch: string, path: string, taskId: string, startPoint?: string, attemptNumber?: number): Promise<string | null>`
  - Returns the worktree path if recovery succeeded (either new path or same path after cleanup)
  - Returns `null` if recovery failed
- [ ] The extracted method should handle both recovery paths:
  - Generate new worktree name when conflicting worktree belongs to active task
  - Clean up conflicting worktree when safe, then retry
- [ ] Update the existing `createWithBranch()` error handler to use the extracted method
- [ ] Update the `createFromExistingBranch()` catch block to ALSO call the extracted method for "already-used" conflicts
- [ ] Ensure proper error propagation when recovery fails

**Artifacts:**
- `packages/engine/src/executor.ts` (modified)

### Step 2: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Add test case: "recovers from 'already used by worktree' error in createFromExistingBranch fallback"
  - Mock `createWithBranch` to fail with "branch already exists" error (not "already used")
  - Mock `createFromExistingBranch` to fail with "already used by worktree at '/path'"
  - Verify conflict recovery is triggered (cleanup or new name generation)
  - Verify worktree is eventually created successfully
- [ ] Run full test suite: `pnpm test`
- [ ] Verify existing worktree tests pass:
  - "recovers from worktree conflict and retries"
  - "generates new worktree name when conflicting worktree belongs to active task"
  - "fails after 3 unsuccessful attempts with detailed error"
- [ ] Build passes: `pnpm build`

### Step 3: Documentation & Delivery

- [ ] Create changeset file documenting the fix
- [ ] No documentation updates needed (internal bug fix)

## Documentation Requirements

**Must Update:**
- `.changeset/fix-worktree-recovery-fallback.md` — Brief description of the fix

**Check If Affected:**
- None

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Changeset created
- [ ] The specific error from the task description no longer occurs:
  ```
  Failed to create worktree after 3 attempts: Failed to create worktree: Command failed: git worktree add "/Users/eclipxe/Projects/kb/.worktrees/happy-ember" "kb/kb-342"
  fatal: 'kb/kb-342' is already used by worktree at '/Users/eclipxe/Projects/kb/.worktrees/pale-shore'
  ```
- [ ] New test case passes demonstrating recovery from the fallback path conflict

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-647): complete Step N — description`
- **Bug fixes:** `fix(KB-647): description`
- **Tests:** `test(KB-647): description`

## Do NOT

- Expand scope beyond the fallback path conflict recovery
- Modify the worktree creation retry logic or MAX_WORKTREE_RETRIES
- Change the worktree naming or pool behavior
- Skip any test failures
- Modify files outside the File Scope
