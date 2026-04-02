# Task: KB-209 - Fix dashboard useMultiAgentLogs hook tests

**Created:** 2026-03-30
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** This task involves fixing test failures in a React hook test suite. The issues are well-defined (EventSource mocking, race conditions, infinite loops) but require changes to both the hook implementation and tests. The blast radius is limited to one test file and its source hook.

**Score:** 4/8 — Blast radius: 1 (single hook+tests), Pattern novelty: 1 (common React testing issue), Security: 0 (test-only), Reversibility: 2 (test changes easily reversible)

## Mission

Fix the failing `useMultiAgentLogs` hook tests in `packages/dashboard`. Seven tests are failing due to:
1. EventSource not being available as a constructor in the jsdom test environment
2. Infinite re-render loops in the hook causing "Maximum update depth exceeded" errors
3. Race conditions between test mock setup and hook execution
4. Duplicate connection issues in tests

The goal is to make all 16 tests in `useMultiAgentLogs.test.ts` pass reliably.

## Dependencies

- **None**

## Context to Read First

1. `packages/dashboard/app/hooks/__tests__/useMultiAgentLogs.test.ts` — The failing test file (read the full file to understand test patterns and MockEventSource implementation)
2. `packages/dashboard/app/hooks/useMultiAgentLogs.ts` — The hook implementation (focus on the useEffect that manages EventSource connections)
3. `packages/dashboard/app/hooks/__tests__/useTasks.test.ts` — Reference implementation showing working EventSource mocking pattern (first 50 lines)
4. `packages/dashboard/vitest.setup.ts` — Test setup file where global mocks should be added

## File Scope

- `packages/dashboard/app/hooks/__tests__/useMultiAgentLogs.test.ts` (modify)
- `packages/dashboard/app/hooks/useMultiAgentLogs.ts` (modify - fix infinite loop)
- `packages/dashboard/vitest.setup.ts` (modify - add EventSource global mock)

## Steps

### Step 1: Add Global EventSource Mock to Test Setup

- [ ] Add a global EventSource mock to `vitest.setup.ts` that provides a working MockEventSource class in the global scope before any tests run
- [ ] Ensure the mock supports: `addEventListener`, `removeEventListener`, `close`, and `readyState` properties
- [ ] Run tests to verify the "EventSource is not a constructor" errors are resolved

**Implementation Notes:**
Use a pattern similar to useTasks.test.ts but in the global setup:
```typescript
class MockEventSource {
  static instances: MockEventSource[] = [];
  static CLOSED = 2;
  url: string;
  listeners: Record<string, ((e: any) => void)[]> = {};
  readyState = 0;
  close = vi.fn(() => { this.readyState = MockEventSource.CLOSED; });
  
  constructor(url: string) {
    this.url = url;
    this.readyState = 1;
    MockEventSource.instances.push(this);
  }
  
  addEventListener(event: string, fn: (e: any) => void) {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(fn);
  }
  
  removeEventListener(event: string, fn: (e: any) => void) {
    this.listeners[event] = (this.listeners[event] || []).filter(l => l !== fn);
  }
  
  _emit(event: string, data?: unknown) {
    for (const fn of this.listeners[event] || []) {
      fn(data === undefined ? {} : { data: JSON.stringify(data) });
    }
  }
}

// Set up before each test
beforeEach(() => {
  MockEventSource.instances = [];
  (globalThis as any).EventSource = MockEventSource;
});
```

### Step 2: Fix Infinite Loop in useMultiAgentLogs Hook

- [ ] Identify and fix the infinite loop in the `useEffect` that causes "Maximum update depth exceeded" errors
- [ ] The issue is likely the unconditional `setStateMap` call at the start of the task initialization loop - it runs on every render and causes a state update which triggers another render
- [ ] Fix by only calling `setStateMap` when state actually needs to change (use functional update with check, or move initialization outside the effect)

**Root Cause Analysis:**
The current code calls `setStateMap` unconditionally inside the effect:
```typescript
for (const taskId of taskIds) {
  setStateMap((prev) => {
    if (prev[taskId]) return prev;  // This prevents update but setStateMap is still called
    return { ...prev, [taskId]: { entries: [], loading: true } };
  });
  // ...
}
```

Even though it returns `prev` unchanged, React 19 in Strict Mode may still process this as a state update. Solution: move the state check outside the setState call, or use a ref to track initialized tasks.

### Step 3: Refactor Test File to Use Global Mock Pattern

- [ ] Remove the local MockEventSource class from `useMultiAgentLogs.test.ts`
- [ ] Update all tests to use the global `MockEventSource` from vitest.setup.ts
- [ ] Replace per-test `instances` arrays with `MockEventSource.instances`
- [ ] Ensure all EventSource overrides happen BEFORE `renderHook()` calls
- [ ] Fix the race condition tests that expect 1 connection but get 2 (handle React Strict Mode double-rendering properly)

**Key Test Fixes Needed:**

1. **"opens SSE EventSource for each task ID"** — Uses local instances array created AFTER renderHook. Fix by using global MockEventSource.instances.

2. **"merges live SSE events with historical entries"** — Gets "Cannot read properties of undefined" because the instance lookup fails. Fix by finding the correct instance from MockEventSource.instances.

3. **"closes specific connection when task ID removed from array"** — `es1.close` was unexpectedly called. This is because the instance tracking picks up the wrong connection (React Strict Mode creates duplicates). Fix by using the last instance for each URL.

4. **"does not create duplicate connections while historical fetch is still pending"** — Expects 1 connection but gets 2. This is React Strict Mode behavior. The test should account for Strict Mode double-invocation or use a pattern that deduplicates.

5. **"closes a task connection when its stream emits an error"** — Gets 22,414 instances (infinite loop). Fix by ensuring the hook's infinite loop is fixed first, then ensure test cleanup works.

6. **"preserves streamed entries that arrive before historical fetch resolves"** — Same as #4, expects 1 gets 2.

7. **"truncates live SSE entries per task to the most recent entries"** — Same as #5, infinite loop creates thousands of instances.

### Step 4: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `cd packages/dashboard && pnpm test -- --run app/hooks/__tests__/useMultiAgentLogs.test.ts`
- [ ] All 16 tests must pass
- [ ] Run full dashboard test suite: `cd packages/dashboard && pnpm test -- --run`
- [ ] Ensure no regressions in `useTasks.test.ts` or other hook tests
- [ ] Build passes: `pnpm build`

### Step 5: Documentation & Delivery

- [ ] Update relevant documentation if testing patterns change
- [ ] Out-of-scope findings created as new tasks via `task_create` tool

## Documentation Requirements

**Must Update:**
- None — this is an internal test fix

**Check If Affected:**
- `AGENTS.md` — If testing patterns change significantly, update the testing section

## Completion Criteria

- [ ] All 16 tests in `useMultiAgentLogs.test.ts` pass
- [ ] No regressions in other dashboard tests
- [ ] Build passes
- [ ] Hook infinite loop issue is fixed (no "Maximum update depth exceeded" errors)

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-209): complete Step N — description`
- **Bug fixes:** `fix(KB-209): description`
- **Tests:** `test(KB-209): description`

## Do NOT

- Expand scope to fix unrelated failing tests (useTasks, Header, TaskCard are separate tasks)
- Skip tests — all tests must pass
- Modify hook behavior beyond fixing the infinite loop (maintain existing API and semantics)
- Add external dependencies
- Change the public API of the hook
