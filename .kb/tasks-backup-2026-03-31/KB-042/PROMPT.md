# Task: KB-042 - Fix tasks marked done still showing in in-progress column

**Created:** 2026-03-30
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** Bug fix requiring investigation into React state management and SSE event handling in the dashboard. The issue likely involves race conditions between task:moved and task:updated events, or stale state in the useTasks hook.
**Score:** 5/8 — Blast radius: 1, Pattern novelty: 1, Security: 1, Reversibility: 2

## Mission

Fix a bug where tasks that have been moved to the "done" column are still appearing in the "in-progress" column on the dashboard. This is a state synchronization issue between the server-side task store and the client-side React state managed via Server-Sent Events (SSE).

The dashboard uses SSE to receive real-time updates from the server. When a task is moved (e.g., via merge or manual drag-and-drop), the server emits a `task:moved` event. However, there may be race conditions or stale state issues causing the UI to display tasks in the wrong column.

## Dependencies

- **None**

## Context to Read First

1. `packages/dashboard/app/hooks/useTasks.ts` — React hook managing task state and SSE event handlers
2. `packages/dashboard/app/components/Board.tsx` — Board component that filters tasks by column
3. `packages/dashboard/app/components/Column.tsx` — Column component receiving filtered tasks
4. `packages/core/src/store.ts` — TaskStore class that emits events (focus on `moveTask`, `emit` patterns)
5. `packages/engine/src/merger.ts` — How merge completion moves tasks to done (see `completeTask` function)

## File Scope

- `packages/dashboard/app/hooks/useTasks.ts` (modify)
- `packages/dashboard/app/components/Board.tsx` (review, possibly modify)
- `packages/dashboard/app/components/Column.tsx` (review, possibly modify)
- `packages/core/src/store.ts` (review only - understand event emission order)
- `packages/dashboard/app/hooks/__tests__/useTasks.test.ts` (create if missing, or add tests)

## Steps

### Step 1: Reproduction & Root Cause Analysis

- [ ] Read `useTasks.ts` and understand current SSE event handling logic
- [ ] Identify the race condition: `task:moved` and `task:updated` both update state but may arrive out of order
- [ ] Check if the `task:moved` event handler properly updates the column field
- [ ] Verify that `taskCache` in store.ts suppresses watcher events for in-process writes but external processes may trigger events
- [ ] Document findings in a comment before making changes

**Key investigation points:**
- The `task:moved` event carries `{ task, from, to }` but the handler only uses `task`
- The `task:updated` event may carry stale column data if emitted concurrently
- The React state update in `task:moved` replaces the entire task object, which should include the new column

### Step 2: Fix State Synchronization

- [ ] Fix the `task:moved` handler in `useTasks.ts` to ensure it properly merges the moved task with correct column priority
- [ ] Ensure `task:updated` handler doesn't overwrite a newer column value with stale data
- [ ] Consider adding a version/timestamp check or ensuring column changes always win over other updates
- [ ] Add defensive logging (optional) to track when a task's column changes unexpectedly

**Implementation approach:**
```typescript
// In task:moved handler, ensure we properly update:
setTasks((prev) => prev.map((t) => (t.id === task.id ? { ...task, column: to } : t)))

// Or if the task object already has correct column:
setTasks((prev) => prev.map((t) => (t.id === task.id ? task : t)))
```

### Step 3: Add Regression Tests

- [ ] Create or update tests for `useTasks.ts` hook
- [ ] Test scenario: task moved from in-progress to done appears only in done column
- [ ] Test scenario: rapid task:moved + task:updated events don't cause stale state
- [ ] Test that SSE event handlers correctly update React state

**Test location:** `packages/dashboard/app/hooks/__tests__/useTasks.test.ts`

### Step 4: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run dashboard tests: `pnpm test --filter @kb/dashboard`
- [ ] Run core tests: `pnpm test --filter @kb/core`
- [ ] Run full test suite: `pnpm test`
- [ ] Build passes: `pnpm build`
- [ ] Manual verification: Check that moving a task to done removes it from in-progress column

### Step 5: Documentation & Delivery

- [ ] Update relevant code comments explaining the fix
- [ ] If out-of-scope findings (e.g., related caching issues in store.ts), create follow-up tasks via `task_create` tool

## Completion Criteria

- [ ] Tasks moved to "done" no longer appear in "in-progress" column
- [ ] All tests passing (unit + integration)
- [ ] Build passes without errors
- [ ] SSE event handling properly synchronizes column state

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-042): complete Step N — description`
- **Bug fixes:** `fix(KB-042): description`
- **Tests:** `test(KB-042): description`

## Do NOT

- Expand task scope beyond the specific bug fix
- Skip tests - this is a state synchronization bug requiring test coverage
- Modify engine scheduling logic - this is a UI state issue, not a task lifecycle issue
- Change the SSE protocol/event structure - work within existing events
- Add new dependencies for state management (stay with React useState pattern)
