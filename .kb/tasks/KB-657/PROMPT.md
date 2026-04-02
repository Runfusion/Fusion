# Task: KB-657 - Add Expand/Collapse Toggle Button to Quick Add Views

**Created:** 2026-04-01
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** UI behavior change affecting two components with shared patterns. Requires state management changes and CSS adjustments for collapsed state. Reversible via git rollback.
**Score:** 5/8 — Blast radius: 1, Pattern novelty: 1, Security: 0, Reversibility: 2

## Mission

Replace the auto-expand behavior in both quick task creation components (`QuickEntryBox` for list view and `InlineCreateCard` for board view) with a manual toggle button. Users will click a button to show additional options (Deps, Models, Plan, Subtask, Refine), and the view stays expanded until they click the button again or submit/cancel the task.

**Why it matters:** The current auto-expand on focus is intrusive and can surprise users. A manual toggle gives users control over the interface complexity, keeping the UI clean by default while making advanced options easily discoverable.

## Dependencies

- **Task:** KB-656 (Don't auto expand the quick add view in list view) — This task builds on KB-656's foundation of removing auto-expand. KB-656 should be completed first to establish the collapsed-by-default baseline.

## Context to Read First

- `packages/dashboard/app/components/QuickEntryBox.tsx` — List view quick entry component (currently auto-expands on focus)
- `packages/dashboard/app/components/InlineCreateCard.tsx` — Board view inline create card (currently always expanded)
- `packages/dashboard/app/components/__tests__/QuickEntryBox.test.tsx` — Existing tests for QuickEntryBox
- `packages/dashboard/app/components/__tests__/InlineCreateCard.test.tsx` — Existing tests for InlineCreateCard
- `packages/dashboard/app/styles.css` — Component styling (search for `.quick-entry-*` and `.inline-create-*` classes)
- `packages/dashboard/app/App.tsx` — Parent component that renders both views (understand how these components are used)

## File Scope

- `packages/dashboard/app/components/QuickEntryBox.tsx` — Add toggle button, remove auto-expand on focus, update blur behavior
- `packages/dashboard/app/components/InlineCreateCard.tsx` — Add toggle button, implement collapsed state, adjust blur behavior
- `packages/dashboard/app/components/__tests__/QuickEntryBox.test.tsx` — Update tests for toggle behavior
- `packages/dashboard/app/components/__tests__/InlineCreateCard.test.tsx` — Update tests for toggle behavior
- `packages/dashboard/app/styles.css` — Add styles for collapsed state and toggle button

## Steps

### Step 1: Update QuickEntryBox (List View)

- [ ] Add `isExpanded` state that defaults to `false` (no longer auto-set on focus)
- [ ] Add toggle button with ChevronDown/ChevronUp icon next to the textarea or in the controls area
- [ ] Remove `handleFocus` auto-expand behavior (focus should NOT auto-expand)
- [ ] Update `handleBlur` to NOT collapse when blur happens (only collapse on Escape or after successful submission)
- [ ] Remove `blurTimeoutRef` logic since we're no longer auto-collapsing on blur
- [ ] Update `resetForm` to collapse the view (`setIsExpanded(false)`)
- [ ] Ensure toggle button is accessible with `aria-expanded` and `aria-controls` attributes
- [ ] Show toggle button always (not just when expanded)
- [ ] When collapsed, show only: textarea + toggle button (to expand)
- [ ] When expanded, show: textarea + all existing controls (Deps, Models, Plan, Subtask, Refine, Save) + toggle button (to collapse)
- [ ] Run targeted tests for QuickEntryBox

**Artifacts:**
- `packages/dashboard/app/components/QuickEntryBox.tsx` (modified)

### Step 2: Update InlineCreateCard (Board View)

- [ ] Add `isExpanded` state that defaults to `false` (new behavior — currently always expanded)
- [ ] Add toggle button with ChevronDown/ChevronUp icon in the card header or footer
- [ ] When collapsed, show only: textarea + toggle button (hide Deps, Models, Plan, Subtask, Save)
- [ ] When expanded, show all existing controls (current behavior)
- [ ] Update focus-out handler: keep existing logic but add check for `isExpanded` — only allow cancel-on-blur when NOT expanded, or when expanded but empty with no dropdowns open
- [ ] Ensure toggle button is accessible with `aria-expanded` and `aria-controls` attributes
- [ ] Run targeted tests for InlineCreateCard

**Artifacts:**
- `packages/dashboard/app/components/InlineCreateCard.tsx` (modified)

### Step 3: Add CSS Styles

- [ ] Add `.quick-entry-toggle` class for the toggle button in QuickEntryBox
- [ ] Add `.quick-entry--collapsed` modifier class for collapsed state styling (reduced padding, single-line appearance)
- [ ] Add `.inline-create-toggle` class for the toggle button in InlineCreateCard
- [ ] Add `.inline-create--collapsed` modifier class for collapsed state
- [ ] Ensure toggle buttons have consistent styling with other icon buttons in the dashboard (use existing `.btn`, `.btn-sm` classes)
- [ ] Ensure smooth transitions between expanded/collapsed states (use existing CSS transition patterns)
- [ ] Run targeted tests to verify styling doesn't break existing layouts

**Artifacts:**
- `packages/dashboard/app/styles.css` (modified)

### Step 4: Update Tests

- [ ] Update QuickEntryBox tests:
  - Remove/modify "expands on focus" test — should NOT auto-expand
  - Remove/modify "collapses on blur" tests — should NOT auto-collapse
  - Add test: "toggle button expands the view"
  - Add test: "toggle button collapses the view when expanded"
  - Add test: "view stays expanded when textarea loses focus"
  - Add test: "view collapses after successful task creation"
  - Update: "shows dependency button when focused" → "shows dependency button when expanded"
- [ ] Update InlineCreateCard tests:
  - Add test: "toggle button expands the view"
  - Add test: "toggle button collapses the view when expanded"
  - Add test: "does not cancel on blur when expanded and has content"
  - Update existing tests to first expand the view before testing controls
- [ ] All tests must pass

**Artifacts:**
- `packages/dashboard/app/components/__tests__/QuickEntryBox.test.tsx` (modified)
- `packages/dashboard/app/components/__tests__/InlineCreateCard.test.tsx` (modified)

### Step 5: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full test suite: `pnpm test`
- [ ] Fix all failures
- [ ] Build passes: `pnpm build`
- [ ] Manual verification (if dashboard is runnable):
  - List view: Verify toggle button expands/collapses QuickEntryBox
  - Board view: Verify toggle button expands/collapses InlineCreateCard
  - Verify expanded state persists across focus/blur cycles
  - Verify state resets after task creation

### Step 6: Documentation & Delivery

- [ ] Create changeset file for dashboard package (patch bump — UI behavior improvement)
- [ ] Update dashboard README or component docs if they describe the old auto-expand behavior
- [ ] Out-of-scope findings created as new tasks via `task_create` tool

## Documentation Requirements

**Must Update:**
- Create changeset: `.changeset/add-expand-toggle-quick-add.md`

**Check If Affected:**
- Any dashboard documentation describing task creation flow

## Completion Criteria

- [ ] Both QuickEntryBox and InlineCreateCard have manual toggle buttons
- [ ] Neither component auto-expands on focus
- [ ] Expanded state persists until manually toggled or task is submitted/cancelled
- [ ] All existing tests updated and passing
- [ ] New tests cover toggle behavior
- [ ] CSS styles applied for clean collapsed/expanded states
- [ ] Build passes
- [ ] Changeset created

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-657): complete Step N — description`
- **Bug fixes:** `fix(KB-657): description`
- **Tests:** `test(KB-657): description`

## Do NOT

- Expand task scope to redesign the entire task creation UI
- Skip tests or mark them as "todo" — all tests must pass
- Change the core task creation API or data structures
- Modify parent components (App.tsx) unless absolutely necessary for the toggle to work
- Remove existing functionality (Deps, Models, Plan, Subtask buttons) — just hide them when collapsed
