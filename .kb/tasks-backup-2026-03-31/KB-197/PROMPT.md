# Task: KB-197 - Fix sizing indicator positioning on todo and done task cards

**Created:** 2026-03-30
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** This is a straightforward CSS/layout fix. The size badge and action buttons both use `margin-left: auto`, causing inconsistent positioning. The fix involves restructuring the card header layout to use a dedicated right-aligned actions group.
**Score:** 2/8 — Blast radius: 1, Pattern novelty: 0, Security: 0, Reversibility: 1

## Mission

Fix the sizing indicator (S/M/L badge) positioning on task cards in the "todo" and "done" columns. Currently, the size badge appears in inconsistent positions depending on the column and available header elements. The size badge should always appear on the right side of the card header, immediately before any action buttons (edit, archive, unarchive), matching the consistent right-side placement seen in the "in-progress" column.

## Dependencies

- **None**

## Context to Read First

- `/Users/eclipxe/Projects/kb/packages/dashboard/app/components/TaskCard.tsx` — Card component with header layout
- `/Users/eclipxe/Projects/kb/packages/dashboard/app/styles.css` — Card header and badge styling (lines ~350-450 for `.card-header`, `.card-size-badge`, `.card-edit-btn`, `.card-archive-btn`, `.card-unarchive-btn`)
- `/Users/eclipxe/Projects/kb/packages/dashboard/app/components/TaskCard.test.tsx` — Existing tests for card rendering

## File Scope

- `/Users/eclipxe/Projects/kb/packages/dashboard/app/styles.css` — Modify card header layout CSS
- `/Users/eclipxe/Projects/kb/packages/dashboard/app/components/TaskCard.tsx` — Restructure header JSX if needed
- `/Users/eclipxe/Projects/kb/packages/dashboard/app/components/TaskCard.test.tsx` — Add tests for size badge positioning

## Steps

### Step 1: Analyze Current Layout Issue

- [ ] Review the current `.card-header`, `.card-size-badge`, `.card-edit-btn`, `.card-archive-btn`, `.card-unarchive-btn` CSS rules
- [ ] Identify the conflict: multiple elements using `margin-left: auto` in the same flex container
- [ ] Verify the issue appears on cards in "todo" (has edit button) and "done" (has archive button) columns
- [ ] Confirm "in-progress" has consistent right-side placement (usually has status badges that fill space)

**Artifacts:**
- Documented understanding of the layout conflict

### Step 2: Implement Layout Fix

- [ ] Modify CSS to use a dedicated `.card-header-actions` wrapper for right-aligned elements
- [ ] Remove `margin-left: auto` from individual badge/button elements
- [ ] Apply `margin-left: auto` only to the actions wrapper (or use `justify-content: space-between` on header)
- [ ] Ensure size badge is inside the actions wrapper, positioned before buttons
- [ ] Update TaskCard.tsx JSX if needed to wrap actions in the new container

**CSS Changes Required:**
1. Add `.card-header-actions` class with `display: flex; gap: 6px; margin-left: auto;`
2. Remove `margin-left: auto` from `.card-size-badge`, `.card-edit-btn`, `.card-archive-btn`, `.card-unarchive-btn`
3. Keep `margin-left: 8px` on archive/unarchive buttons for spacing within the actions group

**JSX Changes (if needed):**
Wrap the size badge + action buttons in a `.card-header-actions` container that comes after the ID/status badges.

**Artifacts:**
- `/Users/eclipxe/Projects/kb/packages/dashboard/app/styles.css` (modified)
- `/Users/eclipxe/Projects/kb/packages/dashboard/app/components/TaskCard.tsx` (modified)

### Step 3: Add Regression Tests

- [ ] Add test to verify size badge renders in the header for sized tasks
- [ ] Add test to verify size badge comes after status badge but before action buttons in DOM order
- [ ] Test all three size values (S, M, L) render with correct CSS classes
- [ ] Run new tests to confirm they pass with the fix

**Artifacts:**
- `/Users/eclipxe/Projects/kb/packages/dashboard/app/components/TaskCard.test.tsx` (modified)

### Step 4: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full test suite: `pnpm test`
- [ ] Verify all existing TaskCard tests pass
- [ ] Manually verify card headers in all columns (triage, todo, in-progress, in-review, done, archived)
- [ ] Confirm size badge appears on the right side, before action buttons
- [ ] Check that hover states on edit/archive buttons still work correctly
- [ ] Build passes: `pnpm build`

### Step 5: Documentation & Delivery

- [ ] Create changeset file for the dashboard fix
- [ ] Out-of-scope findings created as new tasks via `task_create` tool (if any)

## Documentation Requirements

**Must Update:**
- None (CSS fix, no user-facing docs)

**Check If Affected:**
- `/Users/eclipxe/Projects/kb/README.md` — No update needed for layout fix

## Completion Criteria

- [ ] Size badge (S/M/L) consistently appears on the right side of the card header in ALL columns
- [ ] Size badge appears before action buttons (edit, archive, unarchive) when present
- [ ] All TaskCard tests pass, including new regression tests
- [ ] Full test suite passes
- [ ] Build passes
- [ ] Changeset created (patch level for dashboard UI fix)

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-197): complete Step N — description`
- **Bug fixes:** `fix(KB-197): description`
- **Tests:** `test(KB-197): description`

## Do NOT

- Change the size badge styling (colors, font sizes, padding) — only fix positioning
- Remove or modify the edit/archive button functionality
- Affect the TaskCardBadge (GitHub PR/issue badge) positioning — keep it separate
- Break hover visibility of edit/archive buttons
- Modify the card title, progress bar, or steps display
- Skip tests for this layout fix
