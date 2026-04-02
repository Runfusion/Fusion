# Task: KB-010 - Automatically resolve merge conflicts when using auto-merge

**Created:** 2026-03-30
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** This task involves changes to the core merge algorithm in `merger.ts` and auto-merge orchestration in `dashboard.ts`. The changes affect conflict resolution behavior and error handling during automated merges. Pattern is extending existing AI agent capabilities with retry logic and smarter conflict detection.
**Score:** 5/8 — Blast radius: 1, Pattern novelty: 1, Security: 1, Reversibility: 2

## Mission

Improve the auto-merge system to automatically resolve merge conflicts more reliably. When the AI agent fails to resolve conflicts on the first attempt, implement intelligent retry logic with escalating strategies. Add support for automatic resolution of common conflict patterns (lock files, generated files, trivial conflicts) without requiring AI intervention. This reduces manual intervention when auto-merge encounters conflicts.

## Dependencies

- **None**

## Context to Read First

- `packages/engine/src/merger.ts` — Core AI-powered merge logic with conflict resolution
- `packages/cli/src/commands/dashboard.ts` — Auto-merge queue and orchestration
- `packages/core/src/types.ts` — `MergeResult` type and settings definitions
- `packages/engine/src/merger.test.ts` — Existing merge tests for reference

## File Scope

- `packages/engine/src/merger.ts` (modify)
- `packages/engine/src/merger.test.ts` (modify)
- `packages/cli/src/commands/dashboard.ts` (modify)
- `packages/core/src/types.ts` (modify — add new setting)

## Steps

### Step 1: Add Auto-Conflict-Resolution Setting

- [ ] Add `autoResolveConflicts?: boolean` to `Settings` interface in `packages/core/src/types.ts`
- [ ] Add `autoResolveConflicts: true` to `DEFAULT_SETTINGS`
- [ ] Add test in `packages/core/src/store.test.ts` verifying the setting persists

**Artifacts:**
- `packages/core/src/types.ts` (modified)
- `packages/core/src/store.test.ts` (modified)

### Step 2: Implement Smart Conflict Detection & Auto-Resolution

- [ ] Create `detectResolvableConflicts()` function in `merger.ts` that categorizes conflicts:
  - Lock files (`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `Gemfile.lock`) → auto-resolve using "ours"
  - Generated files (`*.gen.ts`, `dist/*`, `coverage/*`) → auto-resolve using "ours" 
  - Trivial conflicts (whitespace-only, comment-only changes) → auto-resolve
  - Complex conflicts (overlapping code changes) → requires AI
- [ ] Implement `autoResolveFile(filePath: string, resolution: 'ours' | 'theirs')` helper using git checkout --ours/--theirs
- [ ] Add unit tests for conflict detection logic

**Artifacts:**
- `packages/engine/src/merger.ts` (modified — new functions)
- `packages/engine/src/merger.test.ts` (new tests for conflict detection)

### Step 3: Add Retry Logic with Escalating Strategies

- [ ] Modify `aiMergeTask` to implement 3-attempt retry logic when `autoResolveConflicts` is enabled:
  - **Attempt 1**: Try standard merge; if conflicts → use AI agent with full context
  - **Attempt 2** (if Attempt 1 fails): Auto-resolve lock/generated files, then retry AI with simplified context
  - **Attempt 3** (if Attempt 2 fails): Reset merge, apply `git merge -X theirs` strategy for remaining conflicts, commit with fallback message
- [ ] Track which strategy succeeded in the `MergeResult` (add `resolutionStrategy?: 'ai' | 'auto' | 'theirs'` field)
- [ ] Ensure all attempts properly clean up on failure (git reset --merge)

**Artifacts:**
- `packages/engine/src/merger.ts` (modified — retry logic in `aiMergeTask`)
- `packages/core/src/types.ts` (modified — add `resolutionStrategy` to `MergeResult`)

### Step 4: Update Auto-Merge Queue for Conflict Retry

- [ ] Modify `drainMergeQueue()` in `dashboard.ts` to handle conflict failures differently:
  - On merge conflict error: Check if `autoResolveConflicts` is enabled
  - If enabled and task hasn't exceeded max retries (3): Re-enqueue with delay, increment retry counter
  - If disabled or max retries exceeded: Log error and keep task in in-review (current behavior)
- [ ] Add `mergeRetries` field to track per-task retry count
- [ ] Update console logging to show retry attempts

**Artifacts:**
- `packages/cli/src/commands/dashboard.ts` (modified)

### Step 5: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm test` — all tests pass
- [ ] Add integration-style tests in `merger.test.ts`:
  - Mock conflict in lock file → verify auto-resolution with "ours"
  - Mock conflict in generated file → verify auto-resolution
  - Mock AI agent failure → verify retry with escalating strategies
  - Mock all strategies failing → verify proper error and cleanup
- [ ] Add test for retry counter in dashboard merge queue
- [ ] Run `pnpm build` — builds pass

### Step 6: Documentation & Delivery

- [ ] Update `AGENTS.md` — document new `autoResolveConflicts` setting behavior
- [ ] Add changeset file for the feature:
  ```bash
  cat > .changeset/auto-resolve-merge-conflicts.md << 'EOF'
  ---
  "@dustinbyrne/kb": minor
  ---
  
  Add automatic merge conflict resolution for auto-merge. When enabled, the system will intelligently auto-resolve lock files and generated files, and retry failed merges with escalating strategies (AI → auto-resolve → merge -X theirs).
  EOF
  ```
- [ ] Create follow-up task for dashboard UI to expose the `autoResolveConflicts` setting toggle

## Documentation Requirements

**Must Update:**
- `AGENTS.md` — Add section under "Settings" documenting `autoResolveConflicts`

**Check If Affected:**
- `packages/dashboard/` — Verify no API changes needed (setting is already read from store)

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing (`pnpm test`)
- [ ] Build passes (`pnpm build`)
- [ ] New setting documented in `AGENTS.md`
- [ ] Changeset file included
- [ ] Tasks with lock file conflicts auto-merge without manual intervention
- [ ] Tasks with AI agent failures retry with escalating strategies
- [ ] After 3 failed attempts, merge gives up and stays in in-review for manual resolution

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-010): complete Step N — description`
- **Bug fixes:** `fix(KB-010): description`
- **Tests:** `test(KB-010): description`

## Do NOT

- Change the manual merge behavior in `store.ts:mergeTask()` — keep it as simple squash merge
- Remove or modify the AI agent conflict resolution entirely — enhance it with retries
- Add UI changes in this task — defer dashboard UI to a follow-up task
- Change the default merge commit message format
- Skip cleanup of failed merge attempts (always run `git reset --merge` on failure)
