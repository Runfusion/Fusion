# Task: KB-051 - Add Duplicate Task Button to Dashboard

**Created:** 2026-03-30
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** Small UI addition with existing backend support. The `duplicateTask` API endpoint and store method already exist. Just needs frontend wiring.
**Score:** 3/8 — Blast radius: 1, Pattern novelty: 1, Security: 0, Reversibility: 1

## Mission

Add a "Duplicate" button to the task detail modal in the dashboard. This allows users to quickly create a copy of an existing task with the same title, description, and prompt. The backend already supports this via the `POST /api/tasks/:id/duplicate` endpoint — this task wires up the UI.

## Dependencies

- **None** — Backend `duplicateTask` endpoint already exists in `packages/core/src/store.ts` and `packages/dashboard/src/routes.ts`

## Context to Read First

1. `packages/dashboard/app/api.ts` — Note the existing `duplicateTask(id: string): Promise<Task>` API function (line ~49)
2. `packages/dashboard/app/components/TaskDetailModal.tsx` — See how action buttons are rendered in the `modal-actions` div (bottom of file)
3. `packages/dashboard/app/hooks/useTasks.ts` — Pattern for adding new task operations
4. `packages/dashboard/app/App.tsx` — How `TaskDetailModal` is rendered and how callbacks are wired
5. `packages/core/src/store.ts` — `duplicateTask` implementation: copies title/description, puts in triage, no dependencies, copies PROMPT.md

## File Scope

- `packages/dashboard/app/hooks/useTasks.ts` — Add `duplicateTask` callback
- `packages/dashboard/app/components/TaskDetailModal.tsx` — Add `onDuplicateTask` prop and "Duplicate" button
- `packages/dashboard/app/App.tsx` — Wire up `duplicateTask` to modal
- `packages/dashboard/app/components/__tests__/TaskDetailModal.test.tsx` — Add tests for duplicate button

## Steps

### Step 1: Add duplicateTask to useTasks Hook

- [ ] Add `duplicateTask` callback in `useTasks.ts` that calls `api.duplicateTask`
- [ ] Handle optimistic updates: the SSE `task:created` event will add the new task automatically
- [ ] Return the duplicated task for chaining

**Artifacts:**
- `packages/dashboard/app/hooks/useTasks.ts` (modified)

### Step 2: Add Duplicate Button to TaskDetailModal

- [ ] Add `onDuplicateTask?: (id: string) => Promise<Task>` to `TaskDetailModalProps` interface
- [ ] Add `handleDuplicate` callback that calls `onDuplicateTask`, closes modal, and shows success toast with new task ID
- [ ] Add "Duplicate" button in `modal-actions` div — place it between "Pause/Unpause" and the flex spacer (or after Delete for visual grouping)
- [ ] Use `btn btn-sm` class (same as other action buttons)
- [ ] Show confirmation dialog before duplicating: "Duplicate {task.id}? This will create a new task in Triage with the same description and prompt."
- [ ] After successful duplicate, show toast: "Duplicated {oldId} → {newId}"

**Artifacts:**
- `packages/dashboard/app/components/TaskDetailModal.tsx` (modified)

### Step 3: Wire Up in App.tsx

- [ ] Destructure `duplicateTask` from `useTasks()` in `AppInner`
- [ ] Pass `onDuplicateTask={duplicateTask}` prop to `TaskDetailModal` component

**Artifacts:**
- `packages/dashboard/app/App.tsx` (modified)

### Step 4: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Add test in `TaskDetailModal.test.tsx`: "renders Duplicate button in modal actions"
- [ ] Add test: "clicking Duplicate shows confirmation dialog"
- [ ] Add test: "confirming duplicate calls onDuplicateTask and closes modal"
- [ ] Add test: "successful duplicate shows success toast with new task ID"
- [ ] Add test: "cancelling confirmation does not call onDuplicateTask"
- [ ] Run `pnpm test` — fix all failures
- [ ] Run `pnpm build` — ensure no TypeScript errors

**Artifacts:**
- `packages/dashboard/app/components/__tests__/TaskDetailModal.test.tsx` (modified)

### Step 5: Documentation & Delivery

- [ ] Create changeset: `fix: add duplicate task button to dashboard`
- [ ] Verify button appears for tasks in all columns (the backend puts duplicate in triage regardless of source column)

**Artifacts:**
- `.changeset/add-duplicate-task-button.md` (new)

## Documentation Requirements

**Must Update:**
- None — UI change is self-documenting via button label

**Check If Affected:**
- `AGENTS.md` — No changes needed

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing (`pnpm test`)
- [ ] Build passes (`pnpm build`)
- [ ] Changeset created
- [ ] Manual verification: open any task, click Duplicate, confirm dialog appears, new task created in Triage with "(Duplicated from X)" in description

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-051): complete Step N — description`
- **Bug fixes:** `fix(KB-051): description`
- **Tests:** `test(KB-051): description`

## Do NOT

- Expand scope to add duplicate button elsewhere (TaskCard, context menus, etc.)
- Skip tests
- Modify files outside the File Scope without good reason
- Commit without the task ID prefix
- Change the backend duplicate behavior — the backend already handles everything correctly
