# Task: KB-658 - Reduce Size of ID Column in List View

**Created:** 2026-04-01
**Size:** S

## Review Level: 0 (None)

**Assessment:** Pure CSS change to adjust column widths in the list view table. No logic changes, no API changes, minimal blast radius.
**Score:** 1/8 — Blast radius: 0, Pattern novelty: 0, Security: 0, Reversibility: 2

## Mission

Reduce the width of the ID column in the dashboard's List View table so that the Title column has more horizontal space to display task titles. This improves readability when viewing tasks in list mode, especially for tasks with longer titles.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/styles.css` — Main stylesheet containing list view table styles
  - Look for `.list-cell-id` class (around line 4113) — styles the ID column data cells
  - Look for `.list-cell-title` class (around line 4122) — styles the Title column data cells
  - Look for `.list-header-cell` class (around line 4032) — styles header cells

- `packages/dashboard/app/components/ListView.tsx` — The ListView component (for context only, no changes needed)
  - Renders a table with columns: ID, Title, Status, Column, Dependencies, Progress
  - Uses `list-cell-id` and `list-cell-title` CSS classes for table cells

## File Scope

- `packages/dashboard/app/styles.css` — modify CSS classes for list view column widths

## Steps

### Step 1: Adjust List View Column Widths

- [ ] Add fixed width of `70px` to `.list-cell-id` class (or `width: auto` with `max-width: 80px`)
- [ ] Keep `white-space: nowrap` on ID column to prevent wrapping
- [ ] Remove the `max-width: 300px` from `.list-cell-title` class
- [ ] Keep `overflow: hidden`, `text-overflow: ellipsis`, `white-space: nowrap` on title column
- [ ] Ensure the ID column header (`th` with `.list-header-cell`) aligns with the data cell width
- [ ] Run dashboard tests to verify no regressions

**Artifacts:**
- `packages/dashboard/app/styles.css` (modified)

### Step 2: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `cd packages/dashboard && pnpm test` — all tests must pass
- [ ] Verify no TypeScript errors: `cd packages/dashboard && pnpm typecheck`
- [ ] Build passes: `cd packages/dashboard && pnpm build`

### Step 3: Documentation & Delivery

- [ ] No documentation updates needed for this UI polish change
- [ ] Create changeset for the dashboard package if applicable (internal package, may not need changeset)

## Completion Criteria

- [ ] ID column in list view has reduced width (~70-80px)
- [ ] Title column expands to fill available horizontal space
- [ ] Long titles still truncate with ellipsis properly
- [ ] All ListView tests passing
- [ ] Build passes

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-658): complete Step N — description`
- **Bug fixes:** `fix(KB-658): description`
- **Tests:** `test(KB-658): description`

## Do NOT

- Modify ListView.tsx or any other component files — this is CSS-only
- Change any other column widths (Status, Column, Dependencies, Progress)
- Modify the column visibility toggle functionality
- Break text wrapping behavior (titles should still truncate with ellipsis)
- Skip tests
