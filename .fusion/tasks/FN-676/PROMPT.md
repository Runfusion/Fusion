# Task: FN-676 - Fix NewTaskModal Save Button Position to Bottom of Screen

**Created:** 2026-04-01
**Size:** S

## Review Level: 0 (None)

**Assessment:** This is a CSS-only layout fix with minimal blast radius. The change involves adjusting flexbox properties on the modal to ensure actions stick to the bottom.
**Score:** 1/8 — Blast radius: 0, Pattern novelty: 0, Security: 0, Reversibility: 1

## Mission

Fix the layout of the NewTaskModal so that the action buttons (Cancel, Create Task) are always visible at the bottom of the modal viewport, rather than scrolling with the modal content. The modal body should scroll independently when content overflows, keeping the buttons accessible at all times.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/components/NewTaskModal.tsx` — The modal component structure
- `packages/dashboard/app/styles.css` — Current modal and new-task-modal styles (lines 907-980 for base modal, lines 8807-8845 for new-task-modal specific styles)

## File Scope

- `packages/dashboard/app/styles.css` — Modify `.new-task-modal` and related CSS classes
- `packages/dashboard/app/components/__tests__/NewTaskModal.test.tsx` — Verify tests still pass

## Steps

### Step 1: Analyze Current Layout Structure

- [ ] Review current modal DOM structure: `.modal` > (`.modal-header` + `.modal-body` + `.modal-actions`)
- [ ] Identify why buttons aren't sticking to bottom (body has `max-height: calc(80vh - 120px)` instead of flexing)
- [ ] Confirm `.modal` already has `display: flex; flex-direction: column;` from base styles

**Artifacts:**
- Understanding of current CSS issue (mental model, no file changes)

### Step 2: Implement CSS Fix for Sticky Bottom Actions

- [ ] Modify `.new-task-modal` CSS class to add `height: 100%;` or `max-height: inherit;` to ensure it fills the flex container
- [ ] Change `.new-task-modal .modal-body` from `max-height: calc(80vh - 120px)` to `flex: 1; min-height: 0; overflow-y: auto;`
- [ ] Ensure `.modal-actions` remains at natural position (bottom of flex column) with `flex-shrink: 0;`
- [ ] Add `overflow: hidden;` to `.new-task-modal` to prevent double scrollbars
- [ ] Test that the modal displays correctly at various viewport heights

**Artifacts:**
- `packages/dashboard/app/styles.css` (modified) — Updated new-task-modal styles

### Step 3: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run NewTaskModal tests: `pnpm test packages/dashboard/app/components/__tests__/NewTaskModal.test.tsx`
- [ ] Run full dashboard test suite: `pnpm test packages/dashboard`
- [ ] Manually verify the fix by checking that:
  - Buttons stay at bottom when modal has minimal content
  - Body scrolls when content exceeds viewport
  - Buttons are always accessible without scrolling
  - Modal looks correct at various screen sizes (desktop and mobile)
- [ ] Build passes: `pnpm build`

### Step 4: Documentation & Delivery

- [ ] No documentation updates needed (this is a bug fix, not a feature change)
- [ ] Create changeset for the fix if it affects user-facing behavior

## Documentation Requirements

**Check If Affected:**
- `AGENTS.md` — Not affected (no workflow changes)
- `README.md` — Not affected

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Save buttons remain visible at bottom of modal regardless of scroll position
- [ ] Modal body scrolls independently when content overflows
- [ ] Build passes

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(FN-676): complete Step N — description`
- **Bug fixes:** `fix(FN-676): description`
- **Tests:** `test(FN-676): description`

## Do NOT

- Expand task scope beyond the button positioning fix
- Skip visual verification of the modal
- Modify JavaScript/TypeScript component logic (CSS-only fix)
- Break existing modal behavior or styling
