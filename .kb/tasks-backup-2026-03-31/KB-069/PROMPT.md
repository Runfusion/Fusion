# Task: KB-069 - Add Archive All Done Button

**Created:** 2026-03-30
**Size:** M

## Review Level: 1 (Plan Only)

**Assessment:** This is a straightforward UI + API addition. The backend already has `archiveTask()` and `unarchiveTask()` methods. We're adding a bulk operation endpoint and UI button. No complex logic or breaking changes.
**Score:** 3/8 — Blast radius: 1, Pattern novelty: 0, Security: 1, Reversibility: 1

## Mission

Add a button to the "Done" column header that archives all tasks currently in the "done" column in a single action. This provides a convenient way to clean up completed tasks without archiving them one by one.

## Dependencies

- **None**

## Context to Read First

1. `packages/core/src/store.ts` — Read the `archiveTask()` method to understand the single-task archive pattern. Note how it validates the task is in "done" column and emits events.

2. `packages/core/src/types.ts` — Review the `Column` type and `VALID_TRANSITIONS` to understand valid column movements.

3. `packages/dashboard/src/routes.ts` — Read the existing `POST /tasks/:id/archive` endpoint to understand the API pattern.

4. `packages/dashboard/app/api.ts` — Review how `archiveTask()` is called from the frontend.

5. `packages/dashboard/app/hooks/useTasks.ts` — See how `archiveTask` and `unarchiveTask` are wrapped in the hook.

6. `packages/dashboard/app/components/Column.tsx` — Understand the column header layout and where to add the new button.

7. `packages/dashboard/app/components/Board.tsx` — See how `onArchiveTask` is passed down to columns.

## File Scope

- `packages/core/src/store.ts` — Add `archiveAllDone()` method
- `packages/dashboard/src/routes.ts` — Add `POST /tasks/archive-all-done` endpoint
- `packages/dashboard/app/api.ts` — Add `archiveAllDone()` API function
- `packages/dashboard/app/hooks/useTasks.ts` — Add `archiveAllDone` callback
- `packages/dashboard/app/components/Column.tsx` — Add "Archive All" button to done column header
- `packages/dashboard/app/components/Board.tsx` — Pass `onArchiveAllDone` prop to Column
- `packages/dashboard/app/App.tsx` — Wire up `archiveAllDone` from useTasks to Board

## Steps

### Step 1: Add archiveAllDone Method to TaskStore

- [ ] Add `archiveAllDone(): Promise<Task[]>` method to `TaskStore` class in `packages/core/src/store.ts`
- [ ] Method should: (a) list all tasks, (b) filter to those in "done" column, (c) archive each using existing `archiveTask()` logic, (d) return array of archived tasks
- [ ] Use `Promise.all()` for concurrent archiving
- [ ] Write unit tests in `packages/core/src/store.test.ts` covering:
  - Successfully archives multiple done tasks
  - Returns empty array when no done tasks exist
  - Emits `task:moved` event for each archived task
  - Does not affect tasks in other columns

**Artifacts:**
- `packages/core/src/store.ts` (modified)
- `packages/core/src/store.test.ts` (modified)

### Step 2: Add Archive All API Endpoint

- [ ] Add `POST /tasks/archive-all-done` route in `packages/dashboard/src/routes.ts`
- [ ] Endpoint should call `store.archiveAllDone()` and return `{ archived: Task[] }`
- [ ] Handle errors with 500 status and proper error message
- [ ] Add test in `packages/dashboard/src/routes.test.ts` covering:
  - Success case returns array of archived tasks
  - Empty array when no done tasks
  - Proper error handling

**Artifacts:**
- `packages/dashboard/src/routes.ts` (modified)
- `packages/dashboard/src/routes.test.ts` (modified)

### Step 3: Add Frontend API Function

- [ ] Add `archiveAllDone(): Promise<Task[]>` function in `packages/dashboard/app/api.ts`
- [ ] Function should POST to `/tasks/archive-all-done` and return the archived tasks array

**Artifacts:**
- `packages/dashboard/app/api.ts` (modified)

### Step 4: Add useTasks Hook Integration

- [ ] Add `archiveAllDone` callback in `packages/dashboard/app/hooks/useTasks.ts`
- [ ] Function should call `api.archiveAllDone()` and update local task state
- [ ] Update local state by mapping over tasks and updating those that were archived
- [ ] Add test in `packages/dashboard/app/hooks/__tests__/useTasks.test.ts`

**Artifacts:**
- `packages/dashboard/app/hooks/useTasks.ts` (modified)
- `packages/dashboard/app/hooks/__tests__/useTasks.test.ts` (modified)

### Step 5: Add Archive All Button to Done Column

- [ ] Add `onArchiveAllDone?: () => Promise<void>` prop to `ColumnProps` interface in `Column.tsx`
- [ ] Add button to "done" column header (next to the count, before archived column toggle if visible)
- [ ] Button should show "Archive All" text with an archive icon (use `Archive` icon from lucide-react)
- [ ] Button should be disabled when there are no done tasks (count === 0)
- [ ] Clicking button should show confirmation dialog: "Archive all N done tasks?"
- [ ] On confirm, call `onArchiveAllDone()` and show success toast: "Archived N tasks"
- [ ] Handle errors with error toast

**Artifacts:**
- `packages/dashboard/app/components/Column.tsx` (modified)

### Step 6: Wire Up Props Through Board and App

- [ ] Add `onArchiveAllDone` prop to `BoardProps` in `Board.tsx`
- [ ] Pass `onArchiveAllDone` to the "done" column's `Column` component in `Board.tsx`
- [ ] In `App.tsx`, extract `archiveAllDone` from `useTasks()` and pass to `Board` component
- [ ] Verify the button only appears in the "done" column header

**Artifacts:**
- `packages/dashboard/app/components/Board.tsx` (modified)
- `packages/dashboard/app/App.tsx` (modified)

### Step 7: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm test` — all tests must pass
- [ ] Run `pnpm build` — must build without errors
- [ ] Verify the button appears only in "done" column
- [ ] Verify button is disabled when no done tasks
- [ ] Verify confirmation dialog appears before archiving
- [ ] Verify all done tasks move to "archived" column after confirm
- [ ] Verify toast notification shows correct count

### Step 8: Documentation & Delivery

- [ ] Create changeset file: `.changeset/archive-all-done.md` with patch bump describing the feature
- [ ] Update dashboard README if it documents column actions
- [ ] Out-of-scope findings created as new tasks via `task_create` tool

## Documentation Requirements

**Must Update:**
- `.changeset/archive-all-done.md` — New changeset describing the "Archive All Done" feature

**Check If Affected:**
- `packages/dashboard/README.md` — Document the new bulk archive action if user guide exists

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing (`pnpm test`)
- [ ] Build passes (`pnpm build`)
- [ ] Changeset created
- [ ] Feature verified working in UI:
  - Button appears in Done column header
  - Button disabled when no done tasks
  - Confirmation dialog shown
  - All done tasks archived on confirm
  - Success toast with count

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-069): complete Step N — description`
- **Bug fixes:** `fix(KB-069): description`
- **Tests:** `test(KB-069): description`

## Do NOT

- Modify the existing single-task `archiveTask` behavior
- Add bulk operations for other columns (keep scope focused)
- Change the archive/unarchive logic in TaskStore
- Skip confirmation dialog (destructive bulk action needs confirmation)
- Show the button on any column other than "done"
- Archive tasks from other columns (only "done" → "archived")
