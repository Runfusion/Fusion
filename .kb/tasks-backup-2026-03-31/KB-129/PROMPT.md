# Task: KB-129 - Fix Dashboard Performance Degradation Over Time

**Created:** 2026-03-30
**Size:** L

## Review Level: 2 (Plan and Code)

**Assessment:** Performance issue requiring both architectural analysis and code changes. Involves React rendering optimization, memory leak fixes, and potential data loading changes. Changes span hooks, components, and SSE connection handling.
**Score:** 5/8 — Blast radius: 2, Pattern novelty: 1, Security: 0, Reversibility: 2

## Mission

The dashboard progressively slows down after kb has been running for extended periods. This manifests as UI lag, increased memory usage, and sluggish interactions. The root causes include: (1) React component re-rendering inefficiencies causing the entire board to re-render on every SSE update, (2) potential memory leaks from EventSource connections not being cleaned up properly, (3) unbounded agent log growth in memory, and (4) all tasks being loaded and rendered at once regardless of count. This task implements targeted performance optimizations to keep the dashboard responsive regardless of uptime or task volume.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/hooks/useTasks.ts` — Current task fetching and SSE handling
- `packages/dashboard/app/hooks/useAgentLogs.ts` — Individual task log streaming
- `packages/dashboard/app/hooks/useMultiAgentLogs.ts` — Multi-task log streaming (used in TaskDetailModal)
- `packages/dashboard/app/components/TaskCard.tsx` — Task card component that re-renders frequently
- `packages/dashboard/app/components/Column.tsx` — Column rendering that maps over all tasks
- `packages/dashboard/app/components/Board.tsx` — Board component that passes tasks to columns
- `packages/dashboard/src/sse.ts` — Server-side SSE implementation
- `packages/dashboard/src/server.ts` — Server setup including per-task log SSE endpoint
- `packages/core/src/store.ts` — Task store (understand `listTasks()` and how tasks are loaded)

## File Scope

- `packages/dashboard/app/hooks/useTasks.ts` (optimization)
- `packages/dashboard/app/hooks/useAgentLogs.ts` (memory limit)
- `packages/dashboard/app/hooks/useMultiAgentLogs.ts` (memory limit, cleanup)
- `packages/dashboard/app/components/TaskCard.tsx` (memoization)
- `packages/dashboard/app/components/Column.tsx` (memoization)
- `packages/dashboard/app/components/Board.tsx` (virtualization or optimization)
- `packages/dashboard/app/utils/` (new: create `virtualization.ts` if virtualization implemented)
- `packages/dashboard/app/hooks/__tests__/useTasks.test.ts` (new or modified tests)
- `packages/dashboard/app/hooks/__tests__/useAgentLogs.test.ts` (new tests for memory limit)
- `packages/dashboard/app/components/__tests__/TaskCard.test.tsx` (verify memoization doesn't break tests)

## Steps

### Step 1: Audit and Fix SSE Memory Leaks

- [ ] Add proper cleanup verification in `useTasks.ts` — ensure the `return () => es.close()` cleanup function actually executes and removes all event listeners
- [ ] Fix potential double-listener registration in `useMultiAgentLogs.ts` — the cleanup function is empty ("// The actual closing...is handled above") which may leak in Strict Mode
- [ ] Add `es.close()` call in the `error` handler of `useTasks.ts` to ensure connections don't stay open after errors
- [ ] Verify all `store.on()` calls have matching `store.off()` in cleanup
- [ ] Run targeted tests for hooks

**Artifacts:**
- `packages/dashboard/app/hooks/useTasks.ts` (modified)
- `packages/dashboard/app/hooks/useMultiAgentLogs.ts` (modified)

### Step 2: Implement Agent Log Memory Limits

- [ ] Add `MAX_LOG_ENTRIES` constant (500) to `useAgentLogs.ts`
- [ ] Modify the `agent:log` SSE handler to truncate logs when they exceed the limit (keep most recent)
- [ ] Add the same limit to `useMultiAgentLogs.ts` for each task's log state
- [ ] Add `clear()` function call option when logs exceed limit (or auto-truncate)
- [ ] Write tests verifying log truncation behavior
- [ ] Run targeted tests

**Artifacts:**
- `packages/dashboard/app/hooks/useAgentLogs.ts` (modified)
- `packages/dashboard/app/hooks/useMultiAgentLogs.ts` (modified)
- `packages/dashboard/app/hooks/__tests__/useAgentLogs.test.ts` (new/modified)

### Step 3: Optimize React Rendering with Memoization

- [ ] Wrap `TaskCard` component with `React.memo()` to prevent re-renders when props haven't changed
- [ ] Add custom comparator if needed to handle `task` object reference changes while maintaining shallow comparison for `tasks` array
- [ ] Wrap `Column` component with `React.memo()` — ensure `tasks` prop is properly memoized in `Board.tsx` (it already uses `useMemo` for filtering)
- [ ] Verify `TaskCard`'s event handlers (handleClick, handleDragStart, etc.) are stable with `useCallback` — add where missing
- [ ] Ensure `Board.tsx`'s `filteredTasks` useMemo has correct dependencies
- [ ] Run TaskCard tests to ensure memoization doesn't break existing functionality
- [ ] Run Board/Column tests

**Artifacts:**
- `packages/dashboard/app/components/TaskCard.tsx` (modified — add memo)
- `packages/dashboard/app/components/Column.tsx` (modified — add memo)

### Step 4: Add Task List Virtualization (or Pagination Alternative)

- [ ] Evaluate task count threshold — if task count > 100, implement virtualization; otherwise implement pagination
- [ ] Install `react-window` or `@tanstack/react-virtual` if virtualization chosen (discuss in implementation)
- [ ] Implement virtualized list for `Column` component's task list rendering
- [ ] **Alternative (if virtualization too complex)**: Implement "Load More" pagination with `VISIBLE_TASKS_INITIAL` (50) and `VISIBLE_TASKS_INCREMENT` (25)
- [ ] Ensure drag-and-drop still works with virtualized/paginated lists
- [ ] Write tests for virtualization or pagination
- [ ] Run component tests

**Artifacts:**
- `packages/dashboard/app/components/Column.tsx` (modified — virtualization/pagination)
- `packages/dashboard/app/utils/virtualization.ts` (new — if virtualization implemented)

### Step 5: Optimize Task List Loading (Server-Side)

- [ ] Add pagination support to `packages/core/src/store.ts` `listTasks()` method — add optional `limit` and `offset` parameters
- [ ] Modify `packages/dashboard/src/routes.ts` GET `/api/tasks` to accept `?limit=` and `?offset=` query parameters
- [ ] Ensure backwards compatibility — without params returns all tasks (existing behavior)
- [ ] Write tests for paginated task loading
- [ ] Run routes tests

**Artifacts:**
- `packages/core/src/store.ts` (modified — pagination)
- `packages/dashboard/src/routes.ts` (modified — pagination params)

### Step 6: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full test suite: `pnpm test`
- [ ] Fix all failures
- [ ] Build passes: `pnpm build`
- [ ] Manual verification: Run dashboard for 10+ minutes with active tasks, verify memory usage in DevTools doesn't grow unbounded
- [ ] Verify agent logs truncate after 500 entries
- [ ] Verify React DevTools Profiler shows reduced re-renders

### Step 7: Documentation & Delivery

- [ ] Update `packages/dashboard/README.md` — add Performance section documenting optimizations (memoization, log limits, virtualization)
- [ ] Create changeset file for dashboard improvements
- [ ] Out-of-scope findings: If server-side rendering or WebSocket alternatives would help further, create new tasks via `task_create`

**Artifacts:**
- `.changeset/dashboard-performance-fixes.md` (new)
- `packages/dashboard/README.md` (modified)

## Documentation Requirements

**Must Update:**
- `packages/dashboard/README.md` — Add "Performance Characteristics" section covering:
  - Agent logs are limited to 500 entries per task in UI
  - Task list virtualization for large boards (>100 tasks)
  - React.memo usage on TaskCard for efficient re-rendering

**Check If Affected:**
- `packages/core/README.md` — Check if task store pagination needs documentation

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Documentation updated
- [ ] Memory usage remains stable over 10+ minute dashboard session
- [ ] TaskCard re-renders only when its specific task changes (verified via React DevTools Profiler)
- [ ] Agent logs auto-truncate at 500 entries

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-129): complete Step N — description`
- **Bug fixes:** `fix(KB-129): description`
- **Tests:** `test(KB-129): description`

## Do NOT

- Expand scope to redesign the dashboard UI
- Skip adding tests for the performance changes
- Use `any` types when adding memoization or virtualization
- Break drag-and-drop functionality when implementing virtualization
- Remove existing SSE functionality — only optimize it
- Change the TaskCard visual appearance or behavior (only optimize rendering)
- Implement pagination on the server without client-side support
