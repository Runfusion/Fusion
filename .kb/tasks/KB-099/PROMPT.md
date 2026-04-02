# Task: KB-099 - Fix pre-existing dashboard test suite failures

**Created:** 2026-03-30
**Size:** L

## Review Level: 2 (Plan and Code)

**Assessment:** Multiple categories of pre-existing test failures requiring both test updates and implementation fixes: API route gaps, hook API mismatches, and branding-related test obsolescence. Changes span multiple files but are well-scoped to test/implementation alignment.
**Score:** 5/8 — Blast radius: 1, Pattern novelty: 1, Security: 1, Reversibility: 2

## Mission

Fix all pre-existing dashboard test failures that are unrelated to the KB-071 branding change. The test suite has accumulated failures due to:
1. Missing `/tasks/:id/refine` route implementation (tests exist, endpoint doesn't)
2. useTerminal hook API surface diverged from its tests (naming/parameter mismatches)
3. Terminal command handling differs from test expectations (clear, cd, error codes)
4. Kill terminal API signature mismatch in test mocks

**This task explicitly excludes:** Header.test.tsx branding changes (handled by KB-100 which depends on this task).

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/src/routes.test.ts` — Lines 267-377: POST /tasks/:id/refine test block showing expected endpoint behavior
- `packages/dashboard/src/routes.ts` — Verify /tasks/:id/refine endpoint does NOT exist (search for "refine" will find no route registration)
- `packages/dashboard/app/hooks/__tests__/useTerminal.test.tsx` — Full test file showing expected hook API: `setInput`, `navigateHistory`, `currentDirectory`, exit code expectations
- `packages/dashboard/app/hooks/useTerminal.ts` — Current hook implementation showing actual API: `setInputValue`, `navigateHistoryUp/Down`, no `currentDirectory` state
- `packages/dashboard/app/api.ts` — Lines 215-225: `killTerminalSession` function signature with optional signal parameter

## File Scope

- `packages/dashboard/src/routes.ts` (new route handler for POST /tasks/:id/refine)
- `packages/dashboard/app/hooks/useTerminal.ts` (API alignment and cd command improvements)
- `packages/dashboard/app/hooks/__tests__/useTerminal.test.tsx` (test updates where implementation is correct)

## Steps

### Step 1: Implement Missing Refine Route

The `/tasks/:id/refine` endpoint is tested but not implemented. Add it to match test expectations.

- [ ] Read the refine test block in routes.test.ts lines 267-377 to understand expected behavior
- [ ] Add `POST /tasks/:id/refine` route handler in routes.ts (after the duplicate endpoint ~line 688)
- [ ] Validate request body has `feedback` string (400 if missing, empty, or >2000 chars)
- [ ] Call `store.refineTask(id, feedback)` to create refinement task
- [ ] Log the action via `store.logEntry(task.id, "Refinement requested", feedback)`
- [ ] Return 201 with the new task on success
- [ ] Return 404 with ENOENT code if task not found
- [ ] Return 400 if task is not in 'done' or 'in-review' column (store will throw, catch and convert)
- [ ] Return 500 for unexpected errors

**Artifacts:**
- `packages/dashboard/src/routes.ts` (new POST /tasks/:id/refine route)

### Step 2: Align useTerminal Hook API with Tests

The hook's API surface has diverged from its tests. Update the hook to match the expected API while preserving SSE functionality.

- [ ] Add `input` getter alias that returns `inputValue` (for test compatibility)
- [ ] Add `setInput` alias that calls `setInputValue` (for test compatibility)
- [ ] Implement `navigateHistory(direction: "up" | "down", currentInput?: string): string | null` method that:
  - Calls `navigateHistoryUp()` when direction is "up"
  - Calls `navigateHistoryDown()` when direction is "down"
  - Returns the command string or null
  - Handles currentInput parameter to restore original input when navigating down past start
- [ ] Add `currentDirectory` state (default "~")
- [ ] Update `executeCommand` to handle `cd` commands locally:
  - Parse `cd /some/path` and update `currentDirectory`
  - Handle `cd` without args as changing to "~" (home)
  - Add history entry with exitCode 0 for successful cd
- [ ] Ensure `clear` command clears history immediately (the hook already handles this, verify it works)
- [ ] Fix exit code on command execution error: should be `1` not `-1`

**Artifacts:**
- `packages/dashboard/app/hooks/useTerminal.ts` (API additions and cd handling)

### Step 3: Fix Terminal Kill API Test Mismatch

The killTerminalSession API now accepts a signal parameter but tests expect the old signature.

- [ ] Read killTerminalSession mock in useTerminal.test.ts
- [ ] Update the test mock expectations to handle the signal parameter (accept `(sessionId, signal)` format)
- [ ] Update the kill test assertions to allow for SIGTERM/SIGKILL signal parameter

**Artifacts:**
- `packages/dashboard/app/hooks/__tests__/useTerminal.test.tsx` (mock expectation updates)

### Step 4: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run route tests: `cd packages/dashboard && pnpm test -- --run routes.test.ts`
  - All refine tests should pass (201 for valid, 400 for wrong column, 404 for missing)
- [ ] Run terminal hook tests: `cd packages/dashboard && pnpm test -- --run useTerminal.test.tsx`
  - setInput, navigateHistory, currentDirectory tests should pass
  - kill command test should pass with signal parameter
  - clear command test should pass
  - cd command test should pass
- [ ] Run full dashboard test suite: `cd packages/dashboard && pnpm test`
  - Expect 1034+ tests passing
  - Only expected failures: Header.test.tsx (handled separately by KB-100)

### Step 5: Documentation & Delivery

- [ ] Add changeset for bug fixes: `fix: resolve dashboard test suite failures`
- [ ] Verify no other documentation updates needed
- [ ] Create follow-up task if any out-of-scope findings

## Documentation Requirements

**Check If Affected:**
- `packages/dashboard/README.md` — Verify if refine endpoint needs documentation

## Completion Criteria

- [ ] All steps complete
- [ ] POST /tasks/:id/refine returns 201 for valid requests from done/in-review tasks
- [ ] useTerminal hook API matches test expectations (setInput, navigateHistory, currentDirectory)
- [ ] Terminal clear/cd/kill tests pass
- [ ] Full test suite passes (except Header.test.tsx which is handled by KB-100)
- [ ] Changeset included

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-099): complete Step N — description`
- **Bug fixes:** `fix(KB-099): description`
- **Tests:** `test(KB-099): description`

## Do NOT

- Modify Header.test.tsx branding assertions (KB-100 handles this)
- Change the GET /models behavior (handled by KB-056)
- Skip any tests without explicit task reference
- Add features beyond what tests expect
- Modify the engine package tests (handled by KB-097)
