# Task: KB-642 - Refinement: Add Missing Expand Icon to Task Cards

**Created:** 2026-04-01
**Size:** S

## Review Level: 0 (None)

**Assessment:** Small UI completion task - adding the expand icon button that was intended in KB-322 but not implemented. Low risk, single component change.
**Score:** 2/8 — Blast radius: 0, Pattern novelty: 0, Security: 0, Reversibility: 2

## Mission

KB-322 was intended to add an expand icon to TaskCard components so that clicking the card body no longer opens the detail modal — only clicking the expand icon does. However, the implementation is incomplete: the expand icon is missing from the UI. This task completes the work by:

1. Adding the `Maximize2` expand icon button to the card header actions
2. Removing the card-wide click handler so only the expand button opens the modal
3. Adding proper CSS styling for the expand button (following the existing `.card-edit-btn` hover pattern)
4. Updating tests to reflect the new interaction pattern

## Dependencies

- **Task:** KB-322 — The original expand icon task (now complete but implementation missing)

## Context to Read First

- `packages/dashboard/app/components/TaskCard.tsx` — The card component (around lines 1-650)
- `packages/dashboard/app/styles.css` — Header actions and button styles (around lines 1930-2010)
- `packages/dashboard/app/components/__tests__/TaskCard.test.tsx` — Tests for card click behavior

## File Scope

- `packages/dashboard/app/components/TaskCard.tsx` — Add expand button, remove card-wide click
- `packages/dashboard/app/styles.css` — Add `.card-expand-btn` styles
- `packages/dashboard/app/components/__tests__/TaskCard.test.tsx` — Update tests for new behavior

## Steps

### Step 1: Add Expand Button and Fix Click Behavior

- [ ] Import `Maximize2` from `lucide-react` (add to existing import on line ~3)
- [ ] Add `handleExpandClick` callback that calls `handleClick` with `e.stopPropagation()`
- [ ] Add expand button to `.card-header-actions` div (place it right after the edit button or at the start of actions)
- [ ] Button props: `className="card-expand-btn"`, `onClick={handleExpandClick}`, `title="Open task details"`, `aria-label="Open task details"`
- [ ] Remove `onClick={handleCardClick}` from the outer card `<div>` (the one with `className={cardClass}`)
- [ ] Remove `onTouchStart`, `onTouchMove`, `onTouchEnd` handlers from the card container (keep only on the expand button if needed, or remove entirely)
- [ ] Keep `onDoubleClick={handleDoubleClick}` on the card for inline editing
- [ ] Keep all drag-related handlers (`onDragStart`, `onDragEnd`, `onDragOver`, `onDragLeave`, `onDrop`)

**Artifacts:**
- `packages/dashboard/app/components/TaskCard.tsx` (modified)

### Step 2: Add CSS Styles for Expand Button

- [ ] Add `.card-expand-btn` styles following the exact pattern of `.card-edit-btn` (around line 1970 in styles.css)
- [ ] Style requirements: 20px × 20px, transparent background, muted color, opacity 0 by default
- [ ] Add `.card:hover .card-expand-btn { opacity: 1; }` rule
- [ ] Add hover state: `background: var(--border); color: var(--text);`
- [ ] Add focus state: `opacity: 1; outline: 1px solid var(--todo); outline-offset: 1px;`
- [ ] Ensure the button is positioned correctly within `.card-header-actions` (uses flex with gap: 6px)

**Artifacts:**
- `packages/dashboard/app/styles.css` (modified)

### Step 3: Update Tests

- [ ] Update "opens modal on card click" tests to click the expand button instead (look for `aria-label="Open task details"`)
- [ ] Update touch gesture tests ("opens modal on quick tap") — these should now test the expand button, not card body
- [ ] Add new test: "does NOT open modal when clicking card body" — verify clicking the card title or body doesn't call `onOpenDetail`
- [ ] Add new test: "expand button is visible on hover in card-header-actions" — verify button renders with correct accessibility attributes
- [ ] Update any tests that use `fireEvent.click(card)` to use `fireEvent.click(expandButton)` instead
- [ ] Ensure double-click to edit tests still work (double-click should remain on card body)

**Artifacts:**
- `packages/dashboard/app/components/__tests__/TaskCard.test.tsx` (modified)

### Step 4: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm test` in the dashboard package — all tests must pass
- [ ] Run `pnpm build` — build must succeed without errors
- [ ] Verify expand icon (Maximize2) renders correctly in all card states (triage, todo, in-progress, in-review, done, archived)
- [ ] Verify clicking card body does NOT open modal
- [ ] Verify clicking expand button DOES open modal
- [ ] Verify double-click to edit still works for editable cards (triage/todo columns)
- [ ] Verify drag and drop still works correctly
- [ ] Verify all existing card interactions still work (archive, unarchive, edit, steps toggle, dependency click)

### Step 5: Documentation & Delivery

- [ ] No documentation updates required — this completes existing UI functionality
- [ ] Create changeset file for the dashboard package (patch bump):
  ```bash
  cat > .changeset/fix-expand-icon-kb642.md << 'EOF'
  ---
  "@fusion/dashboard": patch
  ---

  Add missing expand icon to task cards for explicit modal open action
  EOF
  ```

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
- [ ] Changeset file created

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-642): complete Step N — description`
- **Bug fixes:** `fix(KB-642): description`
- **Tests:** `test(KB-642): description`

## Do NOT

- Change the card's visual design beyond adding the expand button
- Modify other card types (ScheduleCard, InlineCreateCard)
- Add new dependencies — use existing `lucide-react` icons
- Change the detail modal itself
- Remove or modify the `onOpenDetail` prop interface
- Affect keyboard navigation or accessibility negatively
- Keep touch handlers on card body — move to expand button or remove
