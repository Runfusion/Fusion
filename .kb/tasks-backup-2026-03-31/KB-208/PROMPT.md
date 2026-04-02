# Task: KB-208 - Fix dashboard useTasks hook tests

**Created:** 2026-03-30
**Size:** M

## Review Level: 1 (Plan Only)

**Assessment:** This is a focused test fix with localized changes to test setup/cleanup patterns. The fix involves proper cleanup of EventSource mocks, timers, and React state between tests.
**Score:** 3/8 — Blast radius: 1, Pattern novelty: 1, Security: 0, Reversibility: 1

## Mission

Fix 13 timing-out tests in `useTasks.test.ts` that are failing due to SSE event handling issues. The tests hang at 5000ms because fake timers from the "closes the broken SSE connection and reconnects after an error" test are affecting subsequent tests, and EventSource mock cleanup between tests is incomplete. The solution requires: (1) ensuring proper cleanup of `MockEventSource.instances` and reconnect timers between tests, (2) flushing promises after fake timer tests, and (3) ensuring all `waitFor` calls complete properly.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/hooks/__tests__/useTasks.test.ts` — the failing test file
- `packages/dashboard/app/hooks/useTasks.ts` — the hook implementation
- `packages/dashboard/vitest.setup.ts` — test setup file

## File Scope

- `packages/dashboard/app/hooks/__tests__/useTasks.test.ts` — modify test file only
- `packages/dashboard/vitest.setup.ts` — optionally add global cleanup

## Steps

### Step 1: Analyze Root Cause

- [ ] Run tests individually to confirm isolation: `pnpm test app/hooks/__tests__/useTasks.test.ts --reporter=verbose`
- [ ] Identify which specific test first causes subsequent tests to fail (likely the fake timer test)
- [ ] Confirm that `MockEventSource.instances` array grows between tests instead of being reset
- [ ] Confirm that the `reconnectTimer` (3s timeout) from useTasks hook is not being cleaned up between tests

**Artifacts:**
- Document the specific failure mechanism (comment in test file or brief note)

### Step 2: Fix Test Setup and Cleanup

- [ ] In `beforeEach`, ensure `MockEventSource.instances` is reset to empty array
- [ ] In `afterEach`, close any remaining EventSource instances and clear any pending reconnect timers
- [ ] Add `vi.useRealTimers()` to `afterEach` as safety guard (in case a test failed before restoring)
- [ ] Ensure `mockFetchTasks` mock is reset and resolves to an empty array in beforeEach

**Artifacts:**
- `packages/dashboard/app/hooks/__tests__/useTasks.test.ts` (modified — test setup/cleanup)

### Step 3: Fix Fake Timer Test

- [ ] In the "closes the broken SSE connection and reconnects after an error" test:
  - Ensure `vi.useFakeTimers()` is called after EventSource is created
  - Add `await vi.advanceTimersByTimeAsync(0)` or `await vi.runAllTimersAsync()` to flush pending promises
  - Ensure proper cleanup in try/finally block including `vi.useRealTimers()`
- [ ] Add flush of pending promises before test ends to prevent async operations leaking to next test

**Artifacts:**
- `packages/dashboard/app/hooks/__tests__/useTasks.test.ts` (modified — fake timer test)

### Step 4: Fix Test Wait Patterns

- [ ] For tests that emit SSE events and then check state:
  - Ensure `waitFor` has a reasonable timeout (not relying on default 5s which matches reconnect timeout)
  - Add small delay or state flush after SSE event emission to allow React to process state update
  - Use `waitFor(() => expect(...))` pattern with explicit timeout of 100-500ms
- [ ] Verify tests like "updates task optimistically" properly await the `act()` wrapper around async operations

**Artifacts:**
- `packages/dashboard/app/hooks/__tests__/useTasks.test.ts` (modified — test assertions)

### Step 5: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm test app/hooks/__tests__/useTasks.test.ts` — all 18 tests pass
- [ ] Run test file 3 times in succession to verify no flaky behavior: `for i in 1 2 3; do pnpm test app/hooks/__tests__/useTasks.test.ts || exit 1; done`
- [ ] Run full dashboard test suite: `cd packages/dashboard && pnpm test`
- [ ] Fix any failures

### Step 6: Documentation & Delivery

- [ ] Add comment in test file explaining the cleanup requirements for EventSource mocks
- [ ] Out-of-scope findings created as new tasks via `task_create` tool if other test files have similar patterns

## Documentation Requirements

**Must Update:**
- `packages/dashboard/app/hooks/__tests__/useTasks.test.ts` — Add brief comment at top of file explaining EventSource mock cleanup requirements

**Check If Affected:**
- `packages/dashboard/vitest.setup.ts` — If adding global EventSource cleanup makes sense

## Completion Criteria

- [ ] All 18 useTasks tests pass consistently (no flakes)
- [ ] All 13 previously failing tests now pass
- [ ] No test timeouts at 5000ms
- [ ] Full dashboard test suite passes
- [ ] Documentation/comments added

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-208): complete Step N — description`
- **Bug fixes:** `fix(KB-208): description`
- **Tests:** `test(KB-208): description`

## Do NOT

- Modify the useTasks.ts implementation (the hook is correct; tests need fixing)
- Add dependencies or test utilities without checking if existing patterns suffice
- Skip or remove tests — fix the underlying issue
- Increase global test timeout as a workaround — fix the cleanup issue instead
