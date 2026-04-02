# Task: KB-177 - Reposition List View Quick Entry with Model/Dependency Buttons

**Created:** 2026-03-30
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** UI restructuring that moves the quick entry component from the toolbar to a dedicated creation area below column toggles. Requires coordination with QuickEntryBox enhancements and updates to parent component props and tests.
**Score:** 5/8 — Blast radius: 1, Pattern novelty: 1, Security: 1, Reversibility: 2

## Mission

Restructure the ListView layout so the quick task creation area appears in its own dedicated section—positioned below the column toggles and above the column drop zones (list header). This area should use the enhanced QuickEntryBox with model selection and dependency selection buttons.

The new layout flow will be:
1. **Toolbar** (filter, column toggle, hide done, stats, new task button)
2. **Quick Create Area** (quick entry box + model/dependency selectors)
3. **Column Drop Zones** (list header with column counts)
4. **Task Table** (grouped by column)

## Dependencies

- **Task:** KB-171 (Add Model and Dependency Buttons to Quick Entry Box) — provides the QuickEntryBox component with `tasks` and `availableModels` props for model/dependency selection

## Context to Read First

1. `packages/dashboard/app/components/ListView.tsx` — Current layout with QuickEntryBox in `list-toolbar`
2. `packages/dashboard/app/components/QuickEntryBox.tsx` — Reference for current props interface (will be extended by KB-171)
3. `packages/dashboard/app/components/InlineCreateCard.tsx` — Reference implementation for model/dependency dropdown patterns
4. `packages/dashboard/app/components/__tests__/ListView.test.tsx` — Tests that verify QuickEntryBox rendering and behavior
5. `packages/dashboard/app/styles.css` — List view styling, particularly `.list-toolbar`, `.list-drop-zones`, `.list-table-container`
6. `packages/dashboard/app/App.tsx` — How `handleQuickCreate` and model data are currently passed to ListView

## File Scope

- `packages/dashboard/app/components/ListView.tsx` — Restructure layout, update QuickEntryBox props
- `packages/dashboard/app/components/__tests__/ListView.test.tsx` — Update tests for new layout and props
- `packages/dashboard/app/styles.css` — Add styles for new quick create area

## Steps

### Step 1: Restructure ListView Layout

Move QuickEntryBox from `list-toolbar` to a new dedicated creation area between the toolbar and drop zones.

- [ ] Create new `list-create-area` div between `list-toolbar` and `list-drop-zones`
- [ ] Move `<QuickEntryBox />` from `list-toolbar` to the new `list-create-area`
- [ ] Update QuickEntryBox props to pass through from ListView:
  - `tasks` — available tasks for dependency selection
  - `availableModels` — AI models for model selection
  - Keep existing `onQuickCreate` callback (signature updated by KB-171)
- [ ] Remove QuickEntryBox from `list-toolbar` div (but keep the filter, column toggle, hide done, stats, and new task button)
- [ ] Ensure the new area spans full width and has appropriate visual separation
- [ ] Verify layout on mobile (stacking behavior)

**Artifacts:**
- `packages/dashboard/app/components/ListView.tsx` (modified)

### Step 2: Update ListView Props Interface

Extend ListViewProps to thread through the data needed by the enhanced QuickEntryBox.

- [ ] Add `tasks` prop to `ListViewProps` (if not already present)
- [ ] Add `availableModels?: ModelInfo[]` prop to `ListViewProps`
- [ ] Import `ModelInfo` type from `../api`
- [ ] Update QuickEntryBox render to pass `tasks` and `availableModels` props

**Artifacts:**
- `packages/dashboard/app/components/ListView.tsx` (modified)

### Step 3: Add CSS for New Quick Create Area

Style the new dedicated creation area to visually sit between toolbar and drop zones.

- [ ] Add `.list-create-area` class:
  - Full width, padding for visual breathing room
  - Border or background to separate from toolbar above and drop zones below
  - Consistent with existing design tokens (`--space-md`, `--border`, `--surface`, etc.)
- [ ] Ensure QuickEntryBox expands properly within the new container
- [ ] Add responsive styles for mobile (maintain usability on narrow screens)
- [ ] Verify dark/light theme compatibility

**Artifacts:**
- `packages/dashboard/app/styles.css` (modified)

### Step 4: Update ListView Tests

Update test suite to account for new layout and props.

- [ ] Update Quick Entry test section in `ListView.test.tsx`:
  - Verify QuickEntryBox renders in the new location (not inside `list-toolbar`)
  - Update mock props to include `tasks` and `availableModels`
  - Ensure tests still verify Enter key submission works
- [ ] Add test: model selector button is present when QuickEntryBox is expanded
- [ ] Add test: dependency selector button is present when QuickEntryBox is expanded
- [ ] Verify existing filter, sort, and column toggle tests still pass (unaffected by layout change)

**Artifacts:**
- `packages/dashboard/app/components/__tests__/ListView.test.tsx` (modified)

### Step 5: Update Parent Component (App.tsx)

Ensure ListView receives the data it needs for the enhanced QuickEntryBox.

- [ ] Verify `App.tsx` passes `tasks` prop to ListView (should already exist)
- [ ] Add `availableModels` prop to ListView (may need to thread through from App's model fetching)
- [ ] Import `ModelInfo` type in `App.tsx` if needed

**Artifacts:**
- `packages/dashboard/app/App.tsx` (modified)

### Step 6: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run targeted tests:
  - `pnpm test -- packages/dashboard/app/components/__tests__/ListView.test.tsx`
  - `pnpm test -- packages/dashboard/app/components/__tests__/QuickEntryBox.test.tsx`
- [ ] Run full test suite: `pnpm test`
- [ ] Build passes: `pnpm build`
- [ ] Manual verification checklist:
  - [ ] List view shows quick entry area below column toggle button
  - [ ] Quick entry area is above column drop zones
  - [ ] Focusing the quick entry box shows model and dependency buttons
  - [ ] Clicking model button opens model selector dropdown
  - [ ] Clicking dependency button opens dependency selector dropdown
  - [ ] Creating a task with selected options works correctly
  - [ ] Layout is responsive and usable on mobile
  - [ ] No visual regressions in toolbar, drop zones, or table

### Step 7: Documentation & Delivery

- [ ] No README changes needed (internal dashboard change)
- [ ] Out-of-scope findings: If the layout could benefit from future enhancements (collapsible create area, etc.), note for future tasks

**Artifacts:**
- None (or new task file if out-of-scope findings)

## Documentation Requirements

**Must Update:**
- None (dashboard UI change is self-documenting)

**Check If Affected:**
- `AGENTS.md` — Update if dashboard layout patterns section exists

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Quick entry area appears below column toggles in ListView
- [ ] Quick entry area appears above column drop zones
- [ ] Model selector button visible when QuickEntryBox is focused/has content
- [ ] Dependency selector button visible when QuickEntryBox is focused/has content
- [ ] Creating tasks from the quick entry area respects selected models and dependencies
- [ ] No layout regressions on mobile or desktop

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-177): complete Step N — description`
- **Bug fixes:** `fix(KB-177): description`
- **Tests:** `test(KB-177): description`
- **Styles:** `style(KB-177): description`

## Do NOT

- Expand task scope (don't add additional features to the quick entry area beyond layout repositioning and the buttons from KB-171)
- Skip tests for the new layout
- Break the existing board view quick entry (Column.tsx uses QuickEntryBox separately)
- Remove QuickEntryBox from `list-toolbar` without creating the new dedicated area
- Commit without the task ID prefix
