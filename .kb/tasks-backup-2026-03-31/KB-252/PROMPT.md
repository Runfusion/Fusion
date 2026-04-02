# Task: KB-252 - Don't expand the add a task input until it's focused on both card and list view

**Created:** 2026-03-31
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** This is a focused UI behavior change to QuickEntryBox component. The change is straightforward - modify when the input expands and shows controls. Blast radius is limited to one component and its tests. No security implications, fully reversible.
**Score:** 2/8 — Blast radius: 0, Pattern novelty: 0, Security: 2, Reversibility: 0

## Mission

Modify the QuickEntryBox component so that it remains in a compact, collapsed state until the textarea receives focus. Currently, the input expands both on focus AND when text is entered. The desired behavior is to only expand when focused - if the user clicks away (blur) while there's text, the input should collapse back to its compact state.

This applies to both the List View (at the top via `list-create-area`) and the Board View (in the triage column).

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/components/QuickEntryBox.tsx` - The component to modify
- `packages/dashboard/app/components/__tests__/QuickEntryBox.test.tsx` - Tests that need updating
- `packages/dashboard/app/styles.css` - Lines 8115-8230 contain relevant quick-entry styles
- `packages/dashboard/app/components/ListView.tsx` - Shows how QuickEntryBox is used in list view
- `packages/dashboard/app/components/Column.tsx` - Shows how QuickEntryBox is used in board view (triage column)

## File Scope

- `packages/dashboard/app/components/QuickEntryBox.tsx` (modify)
- `packages/dashboard/app/components/__tests__/QuickEntryBox.test.tsx` (modify)
- `packages/dashboard/app/styles.css` (review - may need adjustment for collapsed state styling)

## Steps

### Step 1: Analyze Current Behavior

- [ ] Review the `showExpandedControls` logic in QuickEntryBox.tsx line ~156
- [ ] Understand the current condition: `isExpanded || description.trim().length > 0`
- [ ] Note the CSS classes: `quick-entry-input--expanded` sets min-height: 80px
- [ ] Understand that `isExpanded` is set on focus and cleared on blur (when empty)

### Step 2: Implement Collapse-on-Blur Behavior

- [ ] Modify `QuickEntryBox.tsx`:
  - Change `showExpandedControls` to only depend on `isExpanded` (not on description content)
  - Update the `handleBlur` function to collapse even when there's text content
  - Remove the check for `!currentValue.trim()` in handleBlur - collapse on blur regardless of content
  - Keep the check for open dropdowns (`showDeps`, `showModels`) to prevent collapse while interacting with dropdowns
- [ ] Update CSS if needed:
  - Ensure `.quick-entry-input` (without --expanded) has appropriate single-line height
  - Verify collapsed state styling is visually clean

**Artifacts:**
- `packages/dashboard/app/components/QuickEntryBox.tsx` (modified)
- `packages/dashboard/app/styles.css` (potentially modified)

### Step 3: Update Tests

- [ ] Modify the test "stays expanded on blur when has content" - this test should now expect the OPPOSITE behavior (should collapse even with content)
  - Change assertion to expect `quick-entry-input--expanded` class to be removed on blur
- [ ] Add a new test to verify the new behavior explicitly:
  - "collapses on blur even when has content"
- [ ] Verify all other QuickEntryBox tests still pass with the new behavior
- [ ] Fix any tests that were relying on the old "stay expanded with content" behavior

**Artifacts:**
- `packages/dashboard/app/components/__tests__/QuickEntryBox.test.tsx` (modified)

### Step 4: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run dashboard tests: `pnpm test --filter @kb/dashboard`
- [ ] Fix all test failures
- [ ] Run full test suite: `pnpm test`
- [ ] Build passes: `pnpm build`

### Step 5: Documentation & Delivery

- [ ] Verify the change works in both contexts:
  - List View (top of task list)
  - Board View (triage column)
- [ ] No documentation updates required (this is a behavioral UX improvement, not a feature change)
- [ ] Out-of-scope findings created as new tasks via `task_create` tool if any

## Completion Criteria

- [ ] QuickEntryBox remains collapsed (single-line height) until focused
- [ ] QuickEntryBox collapses on blur even if text content exists (unless dropdowns are open)
- [ ] QuickEntryBox stays expanded while dropdowns (Deps, Models) are open
- [ ] All QuickEntryBox tests pass with updated expectations
- [ ] Full test suite passes
- [ ] Build passes

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-252): complete Step N — description`
- **Bug fixes:** `fix(KB-252): description`
- **Tests:** `test(KB-252): description`

## Do NOT

- Modify InlineCreateCard - it's not currently used in the application (only QuickEntryBox is used)
- Change the behavior of the "New Task" modal
- Modify the escape key behavior (should still clear content)
- Change how task creation submission works
- Add new features or options - keep the scope focused on the expand/collapse behavior
