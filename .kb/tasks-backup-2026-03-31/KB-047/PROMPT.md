# Task: KB-047 - Fix Column Filters on List View

**Created:** 2026-03-30
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** This is a localized UI fix to add click handlers to existing column drop zones. Low blast radius, uses existing patterns in the codebase.
**Score:** 3/8 — Blast radius: 1, Pattern novelty: 1, Security: 0, Reversibility: 1

## Mission

The ListView component displays column drop zones at the top (Triage, Todo, In Progress, In Review, Done) with `cursor: pointer` styling, suggesting they should be clickable to filter tasks by column. Currently, these elements only support drag-and-drop operations and do nothing when clicked, confusing users.

Implement column filtering functionality: clicking a column drop zone should filter the task list to show only tasks from that column. Clicking the same column again or a "Clear" option should remove the filter and show all tasks.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/components/ListView.tsx` — The list view component with drop zones and filtering logic
- `packages/dashboard/app/components/__tests__/ListView.test.tsx` — Existing tests for the ListView component
- `packages/dashboard/app/styles.css` — Styles for the list view, including `.list-drop-zone` classes

## File Scope

- `packages/dashboard/app/components/ListView.tsx` (modify)
- `packages/dashboard/app/components/__tests__/ListView.test.tsx` (modify — add tests)
- `packages/dashboard/app/styles.css` (modify — add active filter state styling)

## Steps

### Step 1: Add Column Filter State and Logic

- [ ] Add `selectedColumn` state to track which column is being filtered (null means no filter)
- [ ] Create `handleColumnFilter` callback to toggle column selection (click same column to clear, click different column to switch)
- [ ] Modify `groupedTasks` useMemo to filter by `selectedColumn` when set
- [ ] When `selectedColumn` is set, only that column's section should render (not all 5 sections)
- [ ] Update the stats text to show filtered count (e.g., "2 of 5 tasks in Triage")

**Artifacts:**
- `packages/dashboard/app/components/ListView.tsx` (modified)

### Step 2: Add Visual Feedback and Clear Filter UI

- [ ] Add `active` class to drop zone when that column is selected as the filter
- [ ] Add CSS style for `.list-drop-zone.active` with distinct visual state (border color, background)
- [ ] Add "Clear filter" button next to the stats when a column filter is active
- [ ] Ensure the clear button is accessible with proper aria-label

**Artifacts:**
- `packages/dashboard/app/styles.css` (modified)
- `packages/dashboard/app/components/ListView.tsx` (modified)

### Step 3: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Add test: "filters tasks by column when drop zone is clicked" — verify only selected column's tasks are shown
- [ ] Add test: "clears column filter when same drop zone is clicked again" — verify all columns shown after second click
- [ ] Add test: "switches column filter when different drop zone is clicked" — verify filter switches to new column
- [ ] Add test: "clears column filter when clear button is clicked" — verify clear button removes filter
- [ ] Add test: "shows correct filtered stats when column filter is active" — verify stats text shows count and column name
- [ ] Add test: "applies text filter within column filter" — verify text filter works in combination with column filter
- [ ] Run full ListView test suite: `pnpm test --run ListView`
- [ ] Fix all failures
- [ ] Run full dashboard test suite: `pnpm test`
- [ ] Build passes: `pnpm build`

**Artifacts:**
- `packages/dashboard/app/components/__tests__/ListView.test.tsx` (modified)

### Step 4: Documentation & Delivery

- [ ] No documentation updates required (self-documenting UI behavior)
- [ ] Out-of-scope findings: If drag-and-drop interactions are affected by the changes, create a follow-up task via `task_create` tool

## Completion Criteria

- [ ] Clicking a column drop zone filters the list to show only that column's tasks
- [ ] Active column filter has visual indication on the drop zone
- [ ] Clear filter button removes the filter
- [ ] Text filter continues to work within the column filter
- [ ] All new tests pass
- [ ] Full test suite passes
- [ ] Build passes

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-047): complete Step N — description`
- **Bug fixes:** `fix(KB-047): description`
- **Tests:** `test(KB-047): description`

## Do NOT

- Modify the Board (kanban) view — this fix is only for ListView
- Change the drag-and-drop behavior or styling (except adding the active state)
- Remove or rename existing state variables or handlers
- Change the default view or default filter behavior
- Add new dependencies
