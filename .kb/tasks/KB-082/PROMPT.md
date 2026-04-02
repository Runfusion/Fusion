# Task: KB-082 - Enable retry for failed tasks in done column and display failure details

**Created:** 2026-03-30
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** Changes span multiple layers (types, engine, store, UI) but follow established patterns. The UI changes are localized to task card and modal components.
**Score:** 5/8 — Blast radius: 1, Pattern novelty: 1, Security: 1, Reversibility: 2

## Mission

Enable users to retry failed tasks that are in the "done" column, and surface failure details prominently in both the task card and task detail modal. Currently, tasks that fail during execution get status "failed" but may end up in any column depending on when the failure occurred. The retry button logic needs to work regardless of column. Additionally, failure details (error messages) are only visible in the activity log - they should be displayed more prominently.

## Dependencies

- **None**

## Context to Read First

- `/Users/eclipxe/Projects/kb/packages/core/src/types.ts` - Task type definition
- `/Users/eclipxe/Projects/kb/packages/engine/src/executor.ts` - Where tasks are marked as failed (line ~528)
- `/Users/eclipxe/Projects/kb/packages/dashboard/app/components/TaskCard.tsx` - Task card UI
- `/Users/eclipxe/Projects/kb/packages/dashboard/app/components/TaskDetailModal.tsx` - Task detail modal UI
- `/Users/eclipxe/Projects/kb/packages/dashboard/src/routes.ts` - Retry endpoint (line ~663)

## File Scope

### Core types and store
- `/Users/eclipxe/Projects/kb/packages/core/src/types.ts` - Add optional `error?: string` field to Task interface
- `/Users/eclipxe/Projects/kb/packages/core/src/store.ts` - Update methods to handle error field

### Engine (failure recording)
- `/Users/eclipxe/Projects/kb/packages/engine/src/executor.ts` - Set error field when marking task as failed

### Dashboard UI
- `/Users/eclipxe/Projects/kb/packages/dashboard/app/components/TaskCard.tsx` - Display failure indicator with error message
- `/Users/eclipxe/Projects/kb/packages/dashboard/app/components/TaskDetailModal.tsx` - Prominent failure display

### Tests
- `/Users/eclipxe/Projects/kb/packages/engine/src/executor.test.ts` - Update tests to verify error field is set
- `/Users/eclipxe/Projects/kb/packages/dashboard/app/components/__tests__/TaskCard.test.tsx` - Add tests for failure display
- `/Users/eclipxe/Projects/kb/packages/dashboard/app/components/__tests__/TaskDetailModal.test.tsx` - Add tests for failure display

## Steps

### Step 1: Add error field to Task type and store

- [ ] Add optional `error?: string` field to `Task` interface in `types.ts`
- [ ] The field should store the last failure message when a task fails
- [ ] Update store methods if needed to handle the new field (usually automatic via spread)

**Artifacts:**
- `/Users/eclipxe/Projects/kb/packages/core/src/types.ts` (modified)

### Step 2: Record failure error in executor

- [ ] In `executor.ts`, when catching execution errors (around line 527-529), update the task with both status and error:
  - Change `await this.store.updateTask(task.id, { status: "failed" });`
  - To: `await this.store.updateTask(task.id, { status: "failed", error: err.message });`
- [ ] Ensure the error message is captured before any async operations that might lose the error context

**Artifacts:**
- `/Users/eclipxe/Projects/kb/packages/engine/src/executor.ts` (modified)

### Step 3: Clear error on retry

- [ ] In the dashboard routes retry endpoint (`routes.ts` line ~663), clear the error field when retrying:
  - Change `await store.updateTask(req.params.id, { status: undefined });`
  - To: `await store.updateTask(req.params.id, { status: undefined, error: undefined });`

**Artifacts:**
- `/Users/eclipxe/Projects/kb/packages/dashboard/src/routes.ts` (modified)

### Step 4: Display failure in TaskCard

- [ ] In `TaskCard.tsx`, when `isFailed` is true, show a failure indicator:
  - Add a visual indicator showing the task has failed (red border, icon, etc.)
  - Display the error message (truncated if necessary) below the status badge
  - Use the existing `isFailed` variable already defined at line 168
  - Add tooltip or expandable section to show full error if it's long
- [ ] Ensure the failure indicator is visible regardless of which column the task is in

**Artifacts:**
- `/Users/eclipxe/Projects/kb/packages/dashboard/app/components/TaskCard.tsx` (modified)

### Step 5: Display failure prominently in TaskDetailModal

- [ ] In `TaskDetailModal.tsx`, add a prominent failure section when `task.status === "failed"`:
  - Display near the top of the modal (below title or in header area)
  - Show error message in a styled alert/error box
  - Include the error in the Definition tab as well for visibility
- [ ] Ensure retry button is visible and functional for failed tasks in any column
  - Verify the existing condition `{task.status === "failed" && onRetryTask && (...)}` works correctly

**Artifacts:**
- `/Users/eclipxe/Projects/kb/packages/dashboard/app/components/TaskDetailModal.tsx` (modified)

### Step 6: Add/update tests

- [ ] In `executor.test.ts`, verify that when execution fails, the task is updated with both `status: "failed"` and the error message
- [ ] In `TaskCard.test.tsx`, add test for failed task display:
  - Renders status badge with "failed"
  - Shows error indicator when task has error field
- [ ] In `TaskDetailModal.test.tsx`, add tests for:
  - Retry button shows for failed tasks regardless of column
  - Error message is displayed when task has error field
  - Error is cleared/hidden when retry is clicked

**Artifacts:**
- `/Users/eclipxe/Projects/kb/packages/engine/src/executor.test.ts` (modified)
- `/Users/eclipxe/Projects/kb/packages/dashboard/app/components/__tests__/TaskCard.test.tsx` (modified)
- `/Users/eclipxe/Projects/kb/packages/dashboard/app/components/__tests__/TaskDetailModal.test.tsx` (modified)

### Step 7: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm test` - all tests must pass
- [ ] Run `pnpm build` - build must succeed without type errors
- [ ] Manual verification: Create a task that fails during execution, verify:
  - Error message appears in task card
  - Error message appears in task detail modal
  - Retry button is visible and functional
  - After retry, error is cleared and task moves to todo

### Step 8: Documentation & Delivery

- [ ] Update `/Users/eclipxe/Projects/kb/packages/dashboard/README.md` if it documents task statuses
- [ ] Create changeset file for the change:
  ```bash
  cat > .changeset/failed-task-retry-and-error-display.md << 'EOF'
  ---
  "@dustinbyrne/kb": minor
  ---

  Enable retry for failed tasks in any column and display failure details in task card and detail modal.
  EOF
  ```
- [ ] Out-of-scope findings: If you discover related issues (e.g., merge failures not setting error field), create follow-up tasks via `task_create` tool

## Documentation Requirements

**Must Update:**
- Changeset file as shown above

**Check If Affected:**
- `/Users/eclipxe/Projects/kb/packages/dashboard/README.md` - Add note about error field if task documentation exists

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing (`pnpm test`)
- [ ] Build succeeds (`pnpm build`)
- [ ] Failed tasks display error in TaskCard
- [ ] Failed tasks display error in TaskDetailModal
- [ ] Retry button works for failed tasks in any column
- [ ] Error is cleared when task is retried
- [ ] Changeset file created

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-082): complete Step N — description`
- **Bug fixes:** `fix(KB-082): description`
- **Tests:** `test(KB-082): description`

## Do NOT

- Expand scope to handle merge failures (different code path)
- Add retry functionality to archived tasks (out of scope)
- Skip updating tests for the new error field behavior
- Modify files outside the File Scope without good reason
- Create a new column for failed tasks (status field already handles this)
