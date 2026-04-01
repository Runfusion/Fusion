# Task: FN-670 — Fix List View Title Column Width

**Created:** 2026-04-01
**Size:** S

## Review Level: 0 (None)

**Assessment:** This is a straightforward CSS layout fix with no architectural changes, security implications, or risk of data loss. The change is fully reversible by reverting CSS.
**Score:** 0/8 — Blast radius: 0, Pattern novelty: 0, Security: 0, Reversibility: 0

## Mission

The title column in the dashboard list view is constrained to `max-width: 300px` (150px on mobile), causing it to not utilize the available horizontal space. The column should expand to fill the remaining width of the table row so that task titles/descriptions are more readable and the layout looks balanced.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/styles.css` — Contains the `.list-cell-title` CSS class (around line 4870) that limits the column width
- `packages/dashboard/app/components/ListView.tsx` — The list view component that renders the table with the title column

## File Scope

- `packages/dashboard/app/styles.css` — Modify `.list-cell-title` class to allow full-width expansion

## Steps

### Step 1: Fix Title Column Width

- [ ] Update `.list-cell-title` class in `styles.css` to span full available width
  - Remove or increase `max-width: 300px` constraint
  - Add `width: 100%` to allow the column to expand
  - Keep `overflow: hidden`, `text-overflow: ellipsis`, and `white-space: nowrap` for text truncation
- [ ] Update the mobile breakpoint `.list-cell-title` style (around line 5130) similarly
  - Remove `max-width: 150px` constraint
  - Allow it to take available space on mobile

**Artifacts:**
- `packages/dashboard/app/styles.css` (modified)

### Step 2: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full test suite: `pnpm test`
- [ ] Fix any failures
- [ ] Build passes: `pnpm build`
- [ ] Verify visually that the title column now expands to fill available space in the list view

### Step 3: Documentation & Delivery

- [ ] No documentation updates required (UI fix only)
- [ ] Out-of-scope findings created as new tasks via `task_create` tool if any

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Title column in list view spans full available row width
- [ ] Text truncation (ellipsis) still works when title is longer than available space

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(FN-670): complete Step 1 — fix list view title column width`
- **Bug fixes:** `fix(FN-670): description`
- **Tests:** `test(FN-670): description`

## Do NOT

- Expand task scope beyond the title column width fix
- Skip tests
- Modify files outside the File Scope without good reason
- Commit without the task ID prefix
- Change other column widths or table layout properties
