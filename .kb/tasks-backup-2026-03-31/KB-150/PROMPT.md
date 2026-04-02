# Task: KB-150 - Remove task title from edit and new task dialog

**Created:** 2026-03-30
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** This is a straightforward UI change with minimal blast radius — removing an optional field from two modal components. Well-defined scope with clear test impact.
**Score:** 2/8 — Blast radius: 1, Pattern novelty: 0, Security: 0, Reversibility: 1

## Mission

Remove the task title input field from both the new task creation dialog (`NewTaskModal`) and the planning mode summary edit view (`PlanningModeModal`). The title field is currently optional and redundant since the AI generates meaningful titles from descriptions during triage. This simplifies the UI and reduces cognitive load during task creation.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/components/NewTaskModal.tsx` — The new task dialog with title input field (lines ~419-430)
- `packages/dashboard/app/components/PlanningModeModal.tsx` — Planning mode with summary title edit field in `SummaryView` component (lines ~598-605)
- `packages/dashboard/app/components/__tests__/NewTaskModal.test.tsx` — Tests that reference the title field and need updating
- `packages/dashboard/app/components/__tests__/PlanningModeModal.test.tsx` — Tests for planning mode modal

## File Scope

- `packages/dashboard/app/components/NewTaskModal.tsx` — Remove title input field and related state
- `packages/dashboard/app/components/PlanningModeModal.tsx` — Remove title input from SummaryView
- `packages/dashboard/app/components/__tests__/NewTaskModal.test.tsx` — Update tests to remove title assertions
- `packages/dashboard/app/components/__tests__/PlanningModeModal.test.tsx` — Update tests if title-related

## Steps

### Step 1: Remove Title from NewTaskModal

- [ ] Remove `title` state variable and `setTitle` from component state
- [ ] Remove title `<input>` element from JSX (the entire form-group div containing the title field)
- [ ] Update `hasDirtyState` calculation to remove `title.trim() !== ""` check
- [ ] Update `handleClose` reset logic to remove `setTitle("")`
- [ ] Update `handleSubmit` to remove `title.trim()` assignment (keep sending `title: undefined` or omit entirely)
- [ ] Update `handleSubmit` cleanup logic to remove `setTitle("")`
- [ ] Remove any unused imports if `useState` callback dependencies change

**Artifacts:**
- `packages/dashboard/app/components/NewTaskModal.tsx` (modified)

### Step 2: Remove Title from PlanningModeModal SummaryView

- [ ] Locate the `SummaryView` component's form-group containing the title input (id="summary-title")
- [ ] Remove the entire title form-group div (label + input)
- [ ] Verify `onSummaryChange` is still called correctly for other fields (description, size, dependencies)
- [ ] Verify `onCreateTask` callback still works without requiring title input

**Artifacts:**
- `packages/dashboard/app/components/PlanningModeModal.tsx` (modified)

### Step 3: Update Tests

- [ ] Update `NewTaskModal.test.tsx`:
  - Remove test "renders all form fields when open" assertion for title label
  - Remove test "creates task with all provided data on submit" title input interaction
  - Remove or update test "creates task without title when title is empty" (this becomes default behavior)
  - Update any other tests that reference title input
- [ ] Run `PlanningModeModal.test.tsx` to identify any title-related failures
- [ ] Update `PlanningModeModal.test.tsx` if needed for removed title field

**Artifacts:**
- `packages/dashboard/app/components/__tests__/NewTaskModal.test.tsx` (modified)
- `packages/dashboard/app/components/__tests__/PlanningModeModal.test.tsx` (modified if needed)

### Step 4: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run dashboard package tests: `pnpm test --filter @kb/dashboard`
- [ ] Fix all failures
- [ ] Build passes: `pnpm build`
- [ ] Manual verification: Open new task modal — verify no title field visible
- [ ] Manual verification: Open planning mode modal, complete planning — verify no title field in summary edit

### Step 5: Documentation & Delivery

- [ ] Changeset not required (UI-only change, no published package API changes)
- [ ] No README updates needed
- [ ] Verify no AGENTS.md references to title field patterns that need updating

**Out-of-scope findings:**
- Any `title` display in TaskDetailModal (this is read-only display, not editing)
- Task list/card views that display titles (they show AI-generated titles from triage)
- API/schema changes (title field remains in data model, just not user-editable)

## Completion Criteria

- [ ] Title input removed from NewTaskModal component
- [ ] Title input removed from PlanningModeModal SummaryView component
- [ ] All tests pass
- [ ] Build passes
- [ ] Manual verification confirms dialogs work without title field

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-150): complete Step N — description`
- **Bug fixes:** `fix(KB-150): description`
- **Tests:** `test(KB-150): description`

## Do NOT

- Remove the title field from the Task type or data model — only remove UI inputs
- Change any backend API behavior
- Modify how titles are displayed in task lists or detail views
- Remove title from the generated prompt/specification output
- Skip updating tests — all test assertions must pass
