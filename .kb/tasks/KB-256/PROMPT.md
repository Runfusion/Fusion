# Task: KB-256 - On list view add a task quick entry right above list heads

**Created:** 2026-03-31
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** Simple UI repositioning task - moving an existing component to a new location within the same view. No new logic or APIs needed.
**Score:** 2/8 — Blast radius: 0, Pattern novelty: 0, Security: 0, Reversibility: 2

## Mission

Reposition the QuickEntryBox component in the ListView to sit directly above the table headers ("list heads"). Currently it appears between the toolbar and column drop zones; it should be moved to appear after the drop zones but immediately before the table headers. This creates a more logical visual flow: toolbar → filters → drop zones → quick entry → table headers → task rows.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/components/ListView.tsx` — The main list view component showing current QuickEntryBox placement at lines ~267-277
- `packages/dashboard/app/components/__tests__/ListView.test.tsx` — Existing tests for QuickEntryBox positioning (lines ~960-1100)
- `packages/dashboard/app/styles.css` — Search for `.list-create-area`, `.list-drop-zones`, and `.list-table-container` classes to understand current layout styling

## File Scope

- `packages/dashboard/app/components/ListView.tsx` (modify)
- `packages/dashboard/app/styles.css` (modify — may need styling adjustments for new position)
- `packages/dashboard/app/components/__tests__/ListView.test.tsx` (modify — update positioning tests)

## Steps

### Step 1: Move QuickEntryBox in ListView Component

- [ ] Remove the `.list-create-area` div and its QuickEntryBox from its current position (after `.list-toolbar`, before `.list-drop-zones`)
- [ ] Add the QuickEntryBox component inside `.list-table-container`, positioned before the `<table>` element
- [ ] Wrap it in a new container div with class `list-quick-entry-above-table` for styling control
- [ ] Ensure all props (`onQuickCreate`, `addToast`, `tasks`, `availableModels`, `onPlanningMode`, `onSubtaskBreakdown`) are preserved when moving the component
- [ ] Run existing ListView tests to ensure component still renders: `cd packages/dashboard && pnpm test -- ListView.test.tsx`

**Artifacts:**
- `packages/dashboard/app/components/ListView.tsx` (modified)

### Step 2: Add/Update CSS for New Positioning

- [ ] Add CSS class `.list-quick-entry-above-table` with appropriate styling:
  - `padding: var(--space-md) var(--space-xl)` for consistent spacing
  - `background: var(--surface)` to match current look
  - `border-bottom: 1px solid var(--border)` to separate from table headers
- [ ] Add `.list-quick-entry-above-table .quick-entry-box { max-width: 800px; margin: 0 auto; }` to center the input
- [ ] Consider removing or deprecating the old `.list-create-area` styles if no longer needed
- [ ] Ensure the sticky table headers (`thead`) still work correctly with the new element above them

**Artifacts:**
- `packages/dashboard/app/styles.css` (modified)

### Step 3: Update Tests for New Positioning

- [ ] Update the test "renders QuickEntryBox in list-create-area, not in toolbar" to reflect new DOM location
- [ ] Update selector in test from `.list-create-area` to `.list-quick-entry-above-table` or similar
- [ ] Ensure the test "renders QuickEntryBox when onQuickCreate is provided" still passes with new DOM structure
- [ ] Verify tests check that QuickEntryBox is positioned within/after `.list-table-container` or after drop zones
- [ ] Run full ListView test suite: `cd packages/dashboard && pnpm test -- ListView.test.tsx`

**Artifacts:**
- `packages/dashboard/app/components/__tests__/ListView.test.tsx` (modified)

### Step 4: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run dashboard tests: `cd packages/dashboard && pnpm test`
- [ ] Build the dashboard: `cd packages/dashboard && pnpm build`
- [ ] Verify visually in browser (if possible) that QuickEntryBox appears directly above the table headers (ID, Title, Status, etc.)
- [ ] Confirm the drop zones still appear before the QuickEntryBox
- [ ] Test quick task creation still works in the new position
- [ ] Test that expanded controls (Deps, Models, Plan, Subtask buttons) appear and function correctly

### Step 5: Documentation & Delivery

- [ ] Create changeset for the change: `fix-list-view-quick-entry-position.md`
- [ ] Out-of-scope findings: None expected for this simple repositioning task

## Documentation Requirements

**Must Update:**
- None — this is a UI-only change that doesn't affect user-facing documentation

**Check If Affected:**
- `AGENTS.md` — Update Dashboard Task Creation section if it describes the visual layout/position of QuickEntryBox

## Completion Criteria

- [ ] QuickEntryBox is positioned directly above the table headers in ListView
- [ ] All ListView tests passing
- [ ] Dashboard builds successfully
- [ ] Quick task creation functionality works in the new position
- [ ] Expanded controls (Deps, Models, Plan, Subtask) work correctly
- [ ] Changeset created

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-256): complete Step N — description`
- **Bug fixes:** `fix(KB-256): description`
- **Tests:** `test(KB-256): description`

## Do NOT

- Change QuickEntryBox internal functionality or props
- Modify the drop zones or table header behavior beyond what's needed for positioning
- Add new features to the quick entry box
- Remove the existing QuickEntryBox.test.tsx tests
- Affect the Board view or other task creation methods (InlineCreateCard, NewTaskModal)
