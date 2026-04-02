# Task: KB-048 - Add Collapsible Column Sections to List View

**Created:** 2026-03-30
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** This is a UI/UX enhancement to the existing ListView component. It involves adding collapsible sections for each column group with state persistence. Low blast radius (single component), but introduces new interaction patterns (expand/collapse).
**Score:** 5/8 — Blast radius: 1, Pattern novelty: 1, Security: 1, Reversibility: 2

## Mission

Enhance the list view to have **collapsible, visually distinct sections** for each column (triage, todo, in-progress, in-review, done). Each section should be independently expandable/collapsible with state persisted to localStorage, making the list view more scannable and board-like while maintaining the compact table format.

## Dependencies

- **None**

## Context to Read First

1. `packages/dashboard/app/components/ListView.tsx` — Current list view implementation with existing (non-collapsible) section headers
2. `packages/dashboard/app/styles.css` — Existing CSS for list view sections (search for `.list-section-*` classes)
3. `packages/dashboard/app/components/__tests__/ListView.test.tsx` — Existing test patterns for the ListView component

## File Scope

- `packages/dashboard/app/components/ListView.tsx` (modify)
- `packages/dashboard/app/styles.css` (modify — add collapsible section styles)
- `packages/dashboard/app/components/__tests__/ListView.test.tsx` (modify — add tests for collapsible behavior)

## Steps

### Step 1: Add Collapsible Section State Management

- [ ] Add state to track which column sections are expanded/collapsed using a `Set<Column>` or record
- [ ] Initialize state from localStorage with key `"kb-dashboard-list-sections"` — default to all sections expanded
- [ ] Persist section expansion state to localStorage when changed
- [ ] Add helper functions `toggleSection(column)`, `expandAll()`, `collapseAll()`
- [ ] Add expand/collapse all button in toolbar

**Artifacts:**
- `packages/dashboard/app/components/ListView.tsx` (modified — new state hooks and helpers)

### Step 2: Update Section Header UI with Toggle Controls

- [ ] Modify `list-section-header` row to include expand/collapse chevron icon
- [ ] Add click handler on section header to toggle expansion
- [ ] Show chevron-down when expanded, chevron-right when collapsed
- [ ] Keep section header visible even when collapsed (so user can re-expand)
- [ ] Update section count badge to show "X tasks" even when collapsed

**Artifacts:**
- `packages/dashboard/app/components/ListView.tsx` (modified — updated section header rendering)

### Step 3: Implement Conditional Task Row Rendering

- [ ] Wrap task rows in conditional rendering based on section expanded state
- [ ] When section is collapsed, only render the section header (no task rows, no "No tasks" placeholder)
- [ ] Maintain proper table structure (tbody can have conditional children)
- [ ] Ensure drag-and-drop still works correctly for tasks in expanded sections
- [ ] Empty sections (no tasks) should still show "No tasks" placeholder when expanded

**Artifacts:**
- `packages/dashboard/app/components/ListView.tsx` (modified — conditional rendering of task rows)

### Step 4: Add CSS Styles for Collapsible Sections

- [ ] Add `.list-section-header--collapsed` modifier class with distinct styling
- [ ] Style the chevron icon with rotation transition
- [ ] Add subtle background color change for collapsed section headers
- [ ] Add transition animation for expand/collapse (opacity/transform)
- [ ] Ensure section headers remain sticky-friendly (no z-index issues)

**Artifacts:**
- `packages/dashboard/app/styles.css` (modified — new collapsible section styles)

### Step 5: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Add test: "collapses and expands section when header is clicked"
- [ ] Add test: "persists section expansion state to localStorage"
- [ ] Add test: "restores section expansion state from localStorage on mount"
- [ ] Add test: "expand all button expands all collapsed sections"
- [ ] Add test: "collapse all button collapses all expanded sections"
- [ ] Add test: "drag and drop still works in expanded sections"
- [ ] Add test: "collapsed sections hide task rows but keep header visible"
- [ ] Run full test suite: `pnpm test`
- [ ] Fix all failures
- [ ] Build passes: `pnpm build`

### Step 6: Documentation & Delivery

- [ ] Update inline comments in ListView.tsx explaining the collapsible section behavior
- [ ] Out-of-scope findings: Create tasks for any related issues discovered (e.g., KB-047 column filters)

## Documentation Requirements

**Must Update:**
- `packages/dashboard/app/components/ListView.tsx` — Add JSDoc comment explaining the section expansion state persistence

**Check If Affected:**
- `packages/dashboard/README.md` — Document list view features if there's a features section

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] User can click section headers to expand/collapse each column group
- [ ] Section expansion state persists across page reloads
- [ ] Expand all / Collapse all buttons work in the toolbar
- [ ] Drag and drop continues to work correctly
- [ ] Visual styling is consistent with the rest of the dashboard

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-048): complete Step N — description`
- **Bug fixes:** `fix(KB-048): description`
- **Tests:** `test(KB-048): description`

## Do NOT

- Remove the existing flat list option entirely (we're enhancing, not replacing)
- Change the column visibility toggle feature
- Break the existing drag-and-drop functionality
- Modify the task data model or API calls
- Change the sort functionality behavior
- Skip tests for the new collapsible behavior
