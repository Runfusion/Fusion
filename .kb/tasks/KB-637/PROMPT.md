# Task: KB-637 - Fix Pre-existing Test Failures

**Created:** 2026-04-01
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** Fixes require code changes across multiple packages (engine, dashboard) to resolve test failures. Changes are localized to test mocks and component initialization order, with low blast radius but need verification of fix patterns.
**Score:** 5/8 — Blast radius: 1, Pattern novelty: 1, Security: 1, Reversibility: 2

## Mission

Fix pre-existing test failures on the main branch across two categories:
1. **Engine package**: executor.test.ts hangs on "throws original error if cleanup also fails" test - missing mock for git branch deletion command during retry logic
2. **Dashboard package**: 64+ failing tests across routes.test.ts and component tests due to (a) SettingsModal temporal dead zone issue with `activeSectionScope` variable, and (b) Git endpoint tests failing due to missing git repository context

All fixes must maintain test intent while ensuring the test suite passes reliably.

## Dependencies

- **None**

## Context to Read First

Before making changes, read these files to understand the test structure and failure modes:

1. `packages/engine/src/executor.test.ts` - Lines 873-1000: The "throws original error if cleanup also fails" test case and its beforeEach setup
2. `packages/dashboard/app/components/SettingsModal.tsx` - Lines 250-350: The `activeSectionScope` variable declaration and `handleExport` useCallback that references it
3. `packages/dashboard/src/routes.test.ts` - Search for "Git Management endpoints" section (GET /git/status, GET /git/commits tests)
4. `packages/dashboard/app/components/__tests__/SettingsModal.test.tsx` - To understand test expectations

## File Scope

- `packages/engine/src/executor.test.ts` - Fix mock for "throws original error if cleanup also fails" test
- `packages/dashboard/app/components/SettingsModal.tsx` - Reorder variable declaration to fix temporal dead zone
- `packages/dashboard/src/routes.test.ts` - Fix git endpoint tests (status, commits, commit diff)
- `packages/dashboard/app/components/__tests__/SettingsModal.test.tsx` - Verify and update if needed

## Steps

### Step 1: Fix Engine Test - Missing Mock for Git Branch Delete

The test "throws original error if cleanup also fails" (line ~994) hangs because the mock only handles worktree add and remove commands, but not the `git branch -D` command that the executor calls during retry cleanup.

- [ ] Read the "throws original error if cleanup also fails" test case and understand the expected flow
- [ ] Identify all git commands the executor calls when worktree creation fails with "already used by worktree" error:
  - `git worktree add -b ...` (throws conflict - mocked)
  - `git worktree remove ...` (throws remove failed - mocked)
  - `git branch -D ...` (NOT mocked - returns empty buffer, causing unexpected behavior)
- [ ] Add mock handler for `git branch -D` command in the test's `mockedExecSync.mockImplementation` to throw or return empty buffer explicitly
- [ ] Verify the test expects `store.updateTask` to be called twice with `status: "failed"` and appropriate error messages containing "already used by worktree" and "automatic cleanup failed"
- [ ] Run the specific test: `cd packages/engine && pnpm test -- --run -t "throws original error if cleanup also fails"`
- [ ] Ensure test passes without timeout

**Artifacts:**
- `packages/engine/src/executor.test.ts` (modified - test mock implementation)

### Step 2: Fix SettingsModal - Temporal Dead Zone Issue

The `activeSectionScope` variable is referenced in a `useCallback` hook on line 277 but is only declared on line 342. This causes a ReferenceError during component render in tests.

- [ ] Read lines 250-350 of SettingsModal.tsx to understand the variable usage pattern
- [ ] The issue: `handleExport` useCallback on line 256-277 references `activeSectionScope`, but `activeSectionScope` is computed on line 342 via `SETTINGS_SECTIONS.find((s) => s.id === activeSection)?.scope`
- [ ] Fix by moving the `activeSectionScope` computation BEFORE the `handleExport` useCallback, or restructure so the callback doesn't depend on the computed value
- [ ] Option 1 (preferred): Move `const activeSectionScope = ...` to line ~240, before the `handleExport` callback
- [ ] Option 2: Compute scope inside the callback using `activeSection` state directly
- [ ] Ensure all other uses of `activeSectionScope` (lines 356, 365, 383, 425, 433) still work correctly after the move
- [ ] Run SettingsModal tests: `cd packages/dashboard && pnpm test -- --run app/components/__tests__/SettingsModal.test.tsx`
- [ ] Verify no "Cannot access 'activeSectionScope' before initialization" errors

**Artifacts:**
- `packages/dashboard/app/components/SettingsModal.tsx` (modified - variable declaration order)

### Step 3: Fix Dashboard Routes Tests - Git Endpoints

Multiple Git Management endpoint tests fail with 400 errors when they expect 200. The tests likely need proper git repository mocking.

- [ ] Read the Git Management endpoints tests in `packages/dashboard/src/routes.test.ts`
- [ ] Identify failing tests: GET /git/status, GET /git/commits, GET /git/commits/:hash/diff (invalid hash format test)
- [ ] The endpoints likely check for git repository context which isn't available in test environment
- [ ] Add mocks for `execSync` to return valid git data for these endpoints:
  - `git status --porcelain` → return empty or sample status
  - `git log --oneline -n X` → return sample commit list
  - `git show` → return sample diff for hash validation test
- [ ] For "invalid hash format" test: Ensure the endpoint returns 400 with "Invalid commit hash format" message
- [ ] For "non-existent commit" test: Ensure endpoint returns 404 when git show fails
- [ ] Run routes tests: `cd packages/dashboard && pnpm test -- --run src/routes.test.ts -t "Git Management"`
- [ ] Verify all git endpoint tests pass

**Artifacts:**
- `packages/dashboard/src/routes.test.ts` (modified - git command mocks)

### Step 4: Fix Dashboard Batch Import Retry Test

The test "returns error after max retries exceeded on 429" fails with "expected spy to be called 4 times, but got 5 times".

- [ ] Locate this test in routes.test.ts (around the batch-import section)
- [ ] The test expects the underlying function to be called 4 times (initial + 3 retries), but it's being called 5 times
- [ ] Adjust the test expectation or the retry logic configuration in the test
- [ ] Run the specific test and verify it passes

**Artifacts:**
- `packages/dashboard/src/routes.test.ts` (modified - retry count expectation)

### Step 5: Testing & Verification

Run full test suite to verify all fixes work together.

- [ ] Run engine tests: `cd packages/engine && pnpm test -- --run`
- [ ] Verify all engine tests pass (including the previously hanging test)
- [ ] Run dashboard tests: `cd packages/dashboard && pnpm test -- --run`
- [ ] Verify no more than 5 test failures (acceptable tolerance for pre-existing flaky tests)
- [ ] Run typecheck: `cd packages/dashboard && pnpm typecheck`
- [ ] Run build: `pnpm build`

### Step 6: Documentation & Delivery

- [ ] Create changeset: `fix-test-failures-kb-637.md` (patch level - internal test fixes)
- [ ] Document any patterns learned about mock setup for future tests

## Documentation Requirements

**Must Update:**
- None - test fixes don't require user-facing documentation

**Check If Affected:**
- `AGENTS.md` - Add note about test mock patterns if significant new patterns are introduced

## Completion Criteria

- [ ] Engine "throws original error if cleanup also fails" test passes without hanging
- [ ] SettingsModal renders without ReferenceError in tests
- [ ] Dashboard git endpoint tests pass (status, commits, diff)
- [ ] Dashboard batch import retry test passes
- [ ] Total dashboard test failures reduced from 64+ to < 10
- [ ] All typechecks pass
- [ ] Build passes

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-637): complete Step N — description`
- **Bug fixes:** `fix(KB-637): description`
- **Tests:** `test(KB-637): description`

## Do NOT

- Skip tests by marking as `.skip()` or `.todo()` - actually fix the underlying issues
- Modify production source code behavior unless the test reveals a real bug
- Change test assertions to match broken behavior - fix the behavior or mocks instead
- Refactor unrelated code - keep changes focused on test fixes
- Add new test frameworks or change testing infrastructure - work with existing vitest setup
