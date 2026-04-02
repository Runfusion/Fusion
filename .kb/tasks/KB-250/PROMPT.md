# Task: KB-250 - In list view reduce the space between the id and title and make it all fit on mobile width wise without horizontal scrolling if possible when some columns are hidden

**Created:** 2026-03-31
**Size:** S

## Review Level: 0 (None)

**Assessment:** Pure CSS layout adjustments for spacing and mobile responsiveness. No logic changes, no API changes, minimal blast radius.
**Score:** 1/8 — Blast radius: 0, Pattern novelty: 0, Security: 1, Reversibility: 0

## Mission

Reduce the visual spacing between the ID and Title columns in the dashboard's list view, and improve mobile responsiveness so that when columns are hidden via the column toggle, the table fits within mobile viewport width without requiring horizontal scrolling.

The current layout has excessive padding between the ID column (KB-XXX format) and the Title column. On mobile (<768px), even when columns are hidden, the table enforces `min-width: 800px` which causes unwanted horizontal scrolling. The goal is a more compact layout that adapts to available space.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/components/ListView.tsx` - The list view component that renders the table
- `packages/dashboard/app/components/__tests__/ListView.test.tsx` - Existing tests for the list view
- `packages/dashboard/app/styles.css` - Contains all list view styles (search for `.list-*` selectors starting around line 3417)

Key CSS sections to review:
- `.list-cell` (line ~3750) - cell padding
- `.list-cell-id` (line ~3756) - ID cell styling
- `.list-cell-title` (line ~3764) - title cell styling
- `.list-header-cell` (line ~3680) - header cell padding
- Mobile media query `@media (max-width: 768px)` (line ~3982) - responsive styles including the problematic `min-width: 800px`

## File Scope

- `packages/dashboard/app/styles.css` - modify list view styles only

## Steps

### Step 1: Reduce ID/Title Spacing

- [ ] Reduce padding on `.list-cell-id` to tighten space between ID and title columns
- [ ] Add right margin or adjust padding so ID column has less right-side spacing
- [ ] Ensure `.list-header-cell` for ID column matches the data cell spacing
- [ ] Keep changes scoped to ID column only (don't affect other column spacing)

**Implementation notes:**
- Current `.list-cell { padding: 12px 16px; }` applies to all cells
- Target: reduce right padding on ID cells specifically to `8px` or similar
- The ID column header should visually align with the data cells

**Artifacts:**
- `packages/dashboard/app/styles.css` (modified)

### Step 2: Fix Mobile Horizontal Scrolling

- [ ] Remove or reduce `min-width: 800px` on `.list-table` in mobile media query
- [ ] Ensure table adapts to available width when columns are hidden
- [ ] Test that table no longer causes horizontal scroll on mobile viewport (375-768px)
- [ ] Verify hidden columns actually free up space (table should shrink)

**Implementation notes:**
- Current issue: `.list-table { min-width: 800px; }` in `@media (max-width: 768px)` block
- This forces horizontal scroll regardless of how many columns are visible
- Consider using `min-width: auto` or a much smaller value
- The `overflow-x: auto` on `.list-table-container` may need adjustment

**Artifacts:**
- `packages/dashboard/app/styles.css` (modified)

### Step 3: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full test suite: `pnpm test`
- [ ] Fix all failures
- [ ] Build passes: `pnpm build`
- [ ] Manual verification: Open dashboard in list view, verify ID/title spacing is tighter
- [ ] Mobile verification: Resize to mobile width (<768px), hide some columns via the Columns dropdown, verify no horizontal scroll appears

### Step 4: Documentation & Delivery

- [ ] No documentation updates required (pure visual layout change)
- [ ] Out-of-scope findings created as new tasks via `task_create` tool if any

## Documentation Requirements

**Must Update:**
- None

**Check If Affected:**
- None

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] ID and Title columns have reduced spacing in list view
- [ ] Mobile viewport (<768px) with hidden columns shows no horizontal scrollbar
- [ ] Layout still looks good on desktop (no unintended side effects)

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-250): complete Step N — description`
- **Bug fixes:** `fix(KB-250): description`
- **Tests:** `test(KB-250): description`

## Do NOT

- Expand task scope (e.g., don't redesign the entire list view)
- Skip tests
- Modify files outside the File Scope
- Commit without the task ID prefix
- Change the column toggle functionality itself (only spacing/layout)
