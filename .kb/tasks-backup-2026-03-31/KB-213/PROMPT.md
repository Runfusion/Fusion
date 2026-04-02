# Task: KB-213 - Fix useMultiAgentLogs hook tests

**Created:** 2026-03-30
**Size:** S

## Review Level: 2 (Plan and Code)

**Assessment:** Test-only fix with established pattern from useTasks.test.ts. Low risk but requires careful verification of all 16 test cases.
**Score:** 4/8 — Blast radius: 1, Pattern novelty: 1, Security: 0, Reversibility: 2

## Mission

Fix the failing useMultiAgentLogs hook tests by implementing proper EventSource mock setup and cleanup patterns. The test file has 8 failing tests due to:
1. Missing static `instances` array on MockEventSource class
2. Improper mock cleanup between tests causing instance leakage
3. Tests redefining EventSource class locally instead of using the global mock
4. Race conditions from React Strict Mode double-rendering without proper isolation

Apply the proven pattern from useTasks.test.ts which has working SSE mock setup with static instance tracking and comprehensive cleanup.

## Dependencies

- **None**

## Context to Read First

1. `packages/dashboard/app/hooks/__tests__/useMultiAgentLogs.test.ts` — The failing test file to fix
2. `packages/dashboard/app/hooks/__tests__/useTasks.test.ts` — Reference implementation with working SSE mock pattern
3. `packages/dashboard/app/hooks/useMultiAgentLogs.ts` — The hook being tested (to understand behavior)

## File Scope

- `packages/dashboard/app/hooks/__tests__/useMultiAgentLogs.test.ts` (modified)

## Steps

### Step 1: Update MockEventSource Class

- [ ] Add static `instances: MockEventSource[] = []` array to track all instances
- [ ] Add static `CLOSED = 2` constant for readyState
- [ ] Push `this` to `MockEventSource.instances` in constructor
- [ ] Update `close()` method to set `this.readyState = MockEventSource.CLOSED`
- [ ] Remove the unused `getActiveConnections()` helper function (no longer needed with static tracking)

**Artifacts:**
- `packages/dashboard/app/hooks/__tests__/useMultiAgentLogs.test.ts` (modified)

### Step 2: Fix beforeEach and afterEach Hooks

- [ ] Update `beforeEach` to reset `MockEventSource.instances = []` before each test
- [ ] Add `vi.useRealTimers()` to beforeEach to ensure clean timer state
- [ ] Update `afterEach` to close all lingering EventSource instances:
  ```typescript
  for (const instance of MockEventSource.instances) {
    instance.close();
  }
  MockEventSource.instances = [];
  ```
- [ ] Ensure `vi.useRealTimers()` is called in afterEach as safety fallback

**Artifacts:**
- `packages/dashboard/app/hooks/__tests__/useMultiAgentLogs.test.ts` (modified)

### Step 3: Refactor Tests to Use Static Instance Tracking

Update each test that currently redefines EventSource locally to use `MockEventSource.instances` instead:

- [ ] "opens SSE EventSource for each task ID" — use `MockEventSource.instances` instead of local `instances` array
- [ ] "merges live SSE events with historical entries" — use `MockEventSource.instances`
- [ ] "closes all SSE connections on unmount" — use `MockEventSource.instances`
- [ ] "closes specific connection when task ID removed from array" — use `MockEventSource.instances`, fix assertions for Strict Mode
- [ ] "opens new connection when task ID added to array" — use `MockEventSource.instances`
- [ ] "does not create duplicate connections while historical fetch is still pending" — use `MockEventSource.instances`
- [ ] "closes a task connection when its stream emits an error" — use `MockEventSource.instances`
- [ ] "truncates oversized historical logs per task to the most recent entries" — ensure EventSource mock is set up (may just need to await properly)
- [ ] "preserves streamed entries that arrive before historical fetch resolves" — use `MockEventSource.instances`
- [ ] "truncates live SSE entries per task to the most recent entries" — use `MockEventSource.instances`
- [ ] "handles SSE events for multiple tasks independently" — use `MockEventSource.instances`, fix infinite loop issue

Key refactoring pattern:
```typescript
// Remove this pattern from individual tests:
const instances: MockEventSource[] = [];
(globalThis as unknown as Record<string, unknown>).EventSource = class extends MockEventSource {
  constructor(url: string) {
    super(url);
    instances.push(this);
  }
};

// Use this instead:
const es = MockEventSource.instances.find((e) => e.url.includes("KB-001"));
```

**Artifacts:**
- `packages/dashboard/app/hooks/__tests__/useMultiAgentLogs.test.ts` (modified)

### Step 4: Fix Specific Test Issues

- [ ] "merges live SSE events with historical entries" — handle Strict Mode by finding the correct instance (may need to filter by readyState or get the last instance for a URL)
- [ ] "closes specific connection when task ID removed from array" — account for Strict Mode by expecting es1.close to be called (it may be called on the first render's instance)
- [ ] "handles SSE events for multiple tasks independently" — fix the infinite loop causing "Maximum update depth exceeded" (add missing mockImplementation for second task ID)
- [ ] "does not create duplicate connections while historical fetch is still pending" — use proper async handling with the static instances array

**Artifacts:**
- `packages/dashboard/app/hooks/__tests__/useMultiAgentLogs.test.ts` (modified)

### Step 5: Testing & Verification

> ZERO test failures allowed. All 16 tests must pass.

- [ ] Run the full test suite for useMultiAgentLogs: `npx vitest run app/hooks/__tests__/useMultiAgentLogs.test.ts`
- [ ] Verify all 16 tests pass
- [ ] Run the test suite 3 times to ensure no flaky tests (instance cleanup is working properly)
- [ ] Run the broader dashboard test suite to ensure no regressions: `pnpm test` in packages/dashboard

### Step 6: Documentation & Delivery

- [ ] No documentation updates required (test-only fix)
- [ ] Create changeset for the test fix: `.changeset/fix-multi-agent-logs-tests.md`
- [ ] Commit with `test(KB-213): fix useMultiAgentLogs hook tests — EventSource mock cleanup`

## Documentation Requirements

**Must Update:**
- None (test-only fix)

**Check If Affected:**
- `packages/dashboard/app/hooks/__tests__/useMultiAgentLogs.test.ts` — Add comment at top of file explaining the cleanup pattern (copy from useTasks.test.ts):
  ```typescript
  /**
   * EventSource Mock Cleanup Requirements:
   * 
   * This test file uses a MockEventSource class that tracks all instances in a static
   * `instances` array. To prevent test isolation issues, we must ensure:
   * 
   * 1. `MockEventSource.instances` is reset to empty before each test
   * 2. Any lingering EventSource instances are closed and removed after each test
   * 3. Fake timers are restored to real timers after each test
   * 
   * Without proper cleanup, fake timers from one test can leak to subsequent tests,
   * causing `waitFor()` calls to hang indefinitely.
   */
  ```

## Completion Criteria

- [ ] All 16 tests in useMultiAgentLogs.test.ts pass
- [ ] Test suite runs consistently without flakiness (3 consecutive passes)
- [ ] No regressions in dashboard test suite
- [ ] Changeset created for test fix

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `test(KB-213): complete Step N — description`
- **Bug fixes:** `fix(KB-213): description`
- **Tests:** `test(KB-213): description`

## Do NOT

- Modify the useMultiAgentLogs.ts hook implementation (test-only fix)
- Skip or delete failing tests — fix them properly
- Use fake timers without proper cleanup
- Leave MockEventSource instances accumulating between tests
- Modify useTasks.test.ts (it's the working reference)
