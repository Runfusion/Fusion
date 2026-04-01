# Task: FN-675 - Fix Task Card Files Changed Display Misalignment

**Created:** 2026-04-01
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** This is a focused bug fix affecting two API endpoints. The fix is straightforward: align the file counting logic between the session-files and diff endpoints. Low blast radius, no security implications, fully reversible.
**Score:** 2/8 — Blast radius: 0, Pattern novelty: 1, Security: 0, Reversibility: 1

## Mission

Fix the misalignment between the "files changed" count shown on task cards and the actual file list displayed inside the task card's Changes tab. Currently, the card may show "3 files changed" but the Changes tab inside only shows 1 file (or vice versa). This inconsistency occurs because two different endpoints use different git diff strategies and base references.

The fix requires aligning the `/api/tasks/:id/session-files` endpoint to use the same logic as the `/api/tasks/:id/diff` endpoint: prefer `task.baseCommitSha` with double-dot syntax (`..`) over `task.baseBranch` with triple-dot syntax (`...`).

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/src/routes.ts` — Lines 1795-1855 (session-files endpoint) and 1849-1900 (diff endpoint)
- `packages/dashboard/app/components/TaskCard.tsx` — Lines 320-330 (files changed display using useSessionFiles)
- `packages/dashboard/app/components/TaskChangesTab.tsx` — Lines 24-50 (diff display using fetchTaskDiff)
- `packages/dashboard/app/api.ts` — Lines 705-708 (fetchSessionFiles) and 1896-1899 (fetchTaskDiff type)
- `packages/engine/src/executor.ts` — Lines 1098-1140 (captureModifiedFiles showing correct pattern)

## File Scope

- `packages/dashboard/src/routes.ts` — Modify session-files endpoint logic
- `packages/dashboard/src/__tests__/routes-session-files.test.ts` — New test file (create if doesn't exist)

## Steps

### Step 1: Align session-files Endpoint with diff Endpoint

- [ ] Modify `/api/tasks/:id/session-files` endpoint in `packages/dashboard/src/routes.ts` around line 1795
- [ ] Change the endpoint to use `task.baseCommitSha` instead of `task.baseBranch ?? "main"` when available
- [ ] Use double-dot syntax (`..`) instead of triple-dot syntax (`...`) for consistency with `captureModifiedFiles` and the diff endpoint
- [ ] Keep the fallback behavior: when `baseCommitSha` is not available, fall back to the merge-base approach or `HEAD~1` to match `captureModifiedFiles` logic
- [ ] The git diff command should be: `git diff --name-only ${baseRef}..HEAD` where baseRef is `task.baseCommitSha` or computed fallback
- [ ] Maintain the 10-second cache behavior (sessionFilesCache)
- [ ] Preserve the existing error handling patterns

**Key changes in session-files endpoint:**
1. Remove: `const baseBranch = task.baseBranch ?? "main";`
2. Remove: `git diff --name-only ${baseBranch}...HEAD` (triple-dot)
3. Add: Use `task.baseCommitSha` as primary base reference
4. Add: `git diff --name-only ${baseRef}..HEAD` (double-dot) matching `captureModifiedFiles`
5. Add fallback logic matching executor.ts line 1102-1118: try merge-base with main, then fall back to `HEAD~1`

**Artifacts:**
- `packages/dashboard/src/routes.ts` (modified)

### Step 2: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Create/update tests in `packages/dashboard/src/__tests__/routes-session-files.test.ts`
- [ ] Test case 1: Task with `baseCommitSha` set - should use `baseCommitSha..HEAD` syntax
- [ ] Test case 2: Task without `baseCommitSha` but with worktree - should compute fallback base ref
- [ ] Test case 3: Task without worktree - should return empty array
- [ ] Test case 4: Verify returned file list matches what `captureModifiedFiles` would return
- [ ] Test case 5: Cache behavior - verify 10-second cache works correctly
- [ ] Run full test suite: `pnpm test`
- [ ] Run dashboard-specific tests: `pnpm --filter @fusion/dashboard test`
- [ ] Fix all failures

**Test approach:**
Use the same mocking pattern as `server-webhook.test.ts`:
- Create a `MockStore` that extends EventEmitter
- Mock `existsSync` from `node:fs` for worktree detection
- Mock `execSync` from `node:child_process` for git commands
- Verify the correct git command is executed with correct arguments

**Artifacts:**
- `packages/dashboard/src/__tests__/routes-session-files.test.ts` (new)

### Step 3: Documentation & Delivery

- [ ] Update relevant documentation if any API docs mention the session-files endpoint
- [ ] Add changeset for the fix: `cat > .changeset/fix-session-files-alignment.md << 'EOF'`
- [ ] Run build to verify: `pnpm build`

**Changeset content:**
```
---
"@fusion/dashboard": patch
---

Fix alignment between task card "files changed" count and Changes tab file list. Both now consistently use baseCommitSha with double-dot git diff syntax.
```

**Artifacts:**
- `.changeset/fix-session-files-alignment.md` (new)

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Task card "files changed" count now matches the Changes tab file list
- [ ] Changeset included in commit

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(FN-675): align session-files endpoint with diff endpoint`
- **Tests:** `test(FN-675): add session-files endpoint tests`
- **Changeset:** `chore(FN-675): add changeset for file count alignment fix`

## Do NOT

- Expand scope to refactor other parts of the dashboard
- Skip tests
- Modify the diff endpoint behavior (it's already correct)
- Change the TaskChangesTab or TaskCard components (the fix is in the API)
- Remove the caching behavior in session-files endpoint
- Change the endpoint URL or response format (maintain backward compatibility)
