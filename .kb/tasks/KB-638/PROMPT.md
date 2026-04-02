# Task: KB-638 - Fix Subtask Breakdown Modal Height

**Created:** 2026-04-01
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** This is a straightforward CSS layout fix for a modal that grows too tall with many subtasks. No complex logic changes or security implications.
**Score:** 2/8 — Blast radius: 0, Pattern novelty: 0, Security: 0, Reversibility: 2

## Mission

Fix the subtask breakdown modal so it remains fully visible within the viewport when many subtasks are generated. The modal currently grows beyond the screen height, causing the bottom action buttons (Cancel/Create Tasks) to be cut off. The fix must ensure the modal respects `max-height: 90vh`, the subtask list becomes scrollable, and action buttons remain accessible.

## Dependencies

- **None**

## Context to Read First

- `/Users/eclipxe/Projects/kb/packages/dashboard/app/components/SubtaskBreakdownModal.tsx` — The modal component that renders subtasks
- `/Users/eclipxe/Projects/kb/packages/dashboard/app/styles.css` — Lines 7107-7680 contain planning modal styles that affect the subtask modal

## File Scope

- `packages/dashboard/app/styles.css` — Modify planning modal CSS classes
- `packages/dashboard/app/components/SubtaskBreakdownModal.tsx` — Minor structure adjustments if needed
- `packages/dashboard/app/components/SubtaskBreakdownModal.test.tsx` — No changes expected (CSS-only fix)

## Steps

### Step 1: Analyze Current Layout Issue

- [ ] Open browser dev tools or review the CSS to understand the current layout hierarchy
- [ ] Identify why `.planning-summary-form` causes the modal to exceed `max-height: 90vh`
- [ ] Document the current flex container chain: `.planning-modal` → `.planning-modal-body` → `.planning-summary` → `.planning-view-scroll`

### Step 2: Implement CSS Fix

- [ ] Add `max-height` constraint to `.planning-summary-form` to ensure it scrolls internally when content overflows
- [ ] Verify `.planning-view-scroll` has proper `flex: 1` and `min-height: 0` to compress correctly
- [ ] Ensure `.planning-summary-actions` remains visible at the bottom (already has `flex-shrink: 0`)
- [ ] Add `overflow-y: auto` to the subtask list container if needed
- [ ] Test with 5+ subtasks to verify the entire modal stays within viewport

**Key CSS changes expected:**
```css
/* Ensure the summary form scrolls properly within its container */
.planning-summary-form {
  overflow-y: auto;
  /* existing properties preserved */
}

/* May need to constrain the subtask item list */
.subtask-item-container {
  max-height: calc(90vh - 250px); /* Account for header, padding, and action area */
  overflow-y: auto;
}
```

### Step 3: Test the Fix

- [ ] Run the existing test suite to ensure no regressions
- [ ] Verify drag-and-drop reordering still works correctly after layout changes
- [ ] Verify keyboard navigation (up/down arrows) works correctly
- [ ] Test with 1 subtask, 3 subtasks, and 8+ subtasks

### Step 4: Documentation & Delivery

- [ ] Create changeset for the fix
- [ ] Run full test suite one more time

## Completion Criteria

- [ ] Subtask breakdown modal never exceeds viewport height (max 90vh)
- [ ] All action buttons (Cancel, Create Tasks) remain visible and clickable
- [ ] Subtask list scrolls independently when content is tall
- [ ] Drag-and-drop reordering works correctly in the scrollable area
- [ ] Keyboard reordering (up/down arrows) works correctly
- [ ] All existing tests pass
- [ ] Changeset created

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-638): complete Step N — description`
- **Bug fixes:** `fix(KB-638): description`
- **Tests:** `test(KB-638): description`

## Do NOT

- Change the modal's overall max-width or responsive behavior
- Modify the subtask data model or API calls
- Add new dependencies
- Change drag-and-drop or keyboard reordering logic (only fix CSS layout)
- Skip visual verification that buttons remain accessible
