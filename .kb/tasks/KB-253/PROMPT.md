# Task: KB-253 - The sizing icon should be in the far right of cards in the done column

**Created:** 2026-03-31
**Size:** S

## Review Level: 0 (None)

**Assessment:** This is a simple UI layout change affecting only the position of the size badge in TaskCard for the done column. Low blast radius, no pattern novelty, no security implications, easily reversible.

**Score:** 1/8 — Blast radius: 0, Pattern novelty: 0, Security: 1, Reversibility: 0

## Mission

In the kanban board's "done" column, the size badge (S/M/L) should appear at the far right of the card header, after the Archive button. Currently, the size badge appears before the Archive button in the `card-header-actions` div. For done column cards specifically, reorder these elements so the size badge is the rightmost element in the header.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/components/TaskCard.tsx` — The card component where size badge and Archive button are rendered
- `packages/dashboard/app/styles.css` — CSS for `.card-header-actions` and `.card-size-badge`

## File Scope

- `packages/dashboard/app/components/TaskCard.tsx` (modify)
- `packages/dashboard/app/components/__tests__/TaskCard.test.tsx` (verify existing tests pass, add test if needed)

## Steps

### Step 1: Reorder Size Badge in Done Column

- [ ] In `TaskCard.tsx`, locate the `card-header-actions` div (around line 520)
- [ ] For done column cards only (`task.column === "done"`), move the size badge (`card-size-badge`) to render AFTER the Archive button
- [ ] The size badge should remain in its current position for all other columns
- [ ] Ensure CSS classes remain unchanged: `card-size-badge size-{s|m|l}`

Current order in header actions (done column):
1. Size badge
2. Archive button

Target order (done column only):
1. Archive button
2. Size badge (far right)

**Artifacts:**
- `packages/dashboard/app/components/TaskCard.tsx` (modified)

### Step 2: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run dashboard component tests: `cd packages/dashboard && pnpm test -- TaskCard`
- [ ] Verify all existing TaskCard tests pass
- [ ] Add a test case verifying the size badge appears after the Archive button in done column cards
- [ ] Run full test suite: `pnpm test`
- [ ] Build passes: `pnpm build`

### Step 3: Documentation & Delivery

- [ ] No documentation updates needed (UI-only change)
- [ ] Create changeset if this affects published package behavior: `pnpm changeset` (patch level)

## Documentation Requirements

**Must Update:**
- None

**Check If Affected:**
- None

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Size badge appears at far right of card header in done column (after Archive button)
- [ ] Size badge position unchanged in other columns

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-253): complete Step 1 — reorder size badge to far right in done column`
- **Bug fixes:** `fix(KB-253): description`
- **Tests:** `test(KB-253): add test for size badge position in done column`

## Do NOT

- Expand task scope (e.g., reordering other columns or other elements)
- Skip tests
- Modify files outside the File Scope without good reason
- Commit without the task ID prefix
