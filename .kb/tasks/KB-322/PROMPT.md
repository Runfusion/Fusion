# Task: KB-322 - Add Expand Icon to Task Cards

**Created:** 2026-03-31
**Size:** S

## Review Level: 0 (None)

**Assessment:** Small, self-contained UI change to modify card interaction pattern. Changes a single component with clear scope and low risk.
**Score:** 2/8 — Blast radius: 0, Pattern novelty: 0, Security: 0, Reversibility: 2

## Mission

Modify the TaskCard component to use an explicit expand icon for opening the task detail modal, instead of clicking anywhere on the card. This prevents accidental modal opens when users intend to interact with other card elements (dragging, selecting text, etc.).

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/components/TaskCard.tsx` — The main card component to modify
- `packages/dashboard/app/components/__tests__/TaskCard.test.tsx` — Existing tests that will need updates
- `packages/dashboard/app/styles.css` — Card header actions and button styles (around lines 1930-2010)

## File Scope

- `packages/dashboard/app/components/TaskCard.tsx` — Add expand icon button, remove card-wide click handler
- `packages/dashboard/app/styles.css` — Add styles for the expand button (follow existing `.card-edit-btn` pattern)
- `packages/dashboard/app/components/__tests__/TaskCard.test.tsx` — Update tests to use expand button instead of card click

## Steps

### Step 1: Add Expand Button and Modify Click Behavior

- [ ] Import `Maximize2` icon from `lucide-react`
- [ ] Add new `handleExpandClick` callback that calls `handleClick` with `e.stopPropagation()`
- [ ] Add expand button to `.card-header-actions` area (position after the size badge or at the end)
- [ ] Remove `onClick={handleCardClick}` from the main card container (the outer `<div className={cardClass}>`)
- [ ] Remove `onTouchStart`, `onTouchMove`, `onTouchEnd` handlers from the card container (these were for card-opening touch gestures)
- [ ] Keep `onDoubleClick={handleDoubleClick}` for inline editing (editable cards only)
- [ ] Ensure the expand button has proper accessibility: `aria-label="Open task details"`, `title="Open task details"`
- [ ] Add CSS class `.card-expand-btn` following the same pattern as `.card-edit-btn` (in `styles.css`)
- [ ] The expand button should be visible on hover (like edit/archive buttons)

**Artifacts:**
- `packages/dashboard/app/components/TaskCard.tsx` (modified)
- `packages/dashboard/app/styles.css` (modified)

### Step 2: Update Tests

- [ ] Update "opens modal on card click" tests to click the expand button instead
- [ ] Update "calls fetchTaskDetail and onOpenDetail when clicking" tests to target the expand button
- [ ] Update touch gesture tests that expected card click to open modal — these should now test that card touch does NOT open modal, and expand button touch DOES open modal
- [ ] Add new test: "does NOT open modal when clicking card body"
- [ ] Add new test: "expand button is visible on hover in card-header-actions"
- [ ] Ensure all existing tests pass with new interaction pattern
- [ ] Update any tests that relied on `fireEvent.click(card)` to use `fireEvent.click(expandButton)`

**Artifacts:**
- `packages/dashboard/app/components/__tests__/TaskCard.test.tsx` (modified)

### Step 3: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm test` in the dashboard package — all tests must pass
- [ ] Run `pnpm build` — build must succeed without errors
- [ ] Verify expand icon renders correctly in all card states (all columns, all statuses)
- [ ] Verify clicking card body does NOT open modal
- [ ] Verify clicking expand button DOES open modal
- [ ] Verify double-click to edit still works for editable cards (triage/todo columns)
- [ ] Verify drag and drop still works correctly
- [ ] Verify all existing card interactions still work (archive, unarchive, edit, steps toggle, dependency click)

### Step 4: Documentation & Delivery

- [ ] No documentation updates required — this is a UI interaction change, not a feature addition
- [ ] Create changeset file for the dashboard package (patch bump)

## Documentation Requirements

**Must Update:**
- None

**Check If Affected:**
- None

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing (`pnpm test`)
- [ ] Build passes (`pnpm build`)
- [ ] Card click no longer opens modal
- [ ] Expand button click opens modal
- [ ] Double-click to edit still works
- [ ] Drag and drop still works

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-322): complete Step N — description`
- **Bug fixes:** `fix(KB-322): description`
- **Tests:** `test(KB-322): description`

## Do NOT

- Change the card's visual design beyond adding the expand button
- Modify other card types (ScheduleCard, InlineCreateCard)
- Add new dependencies — use existing `lucide-react` icons
- Change the detail modal itself
- Remove or modify the `onOpenDetail` prop interface
- Affect keyboard navigation or accessibility negatively
