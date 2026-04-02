# Task: KB-050 - Move Progress Bar to Top of Task Card

**Created:** 2026-03-30
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** This is a straightforward UI layout change — moving an existing progress bar component to a different position within the TaskCard component. Minimal blast radius, well-defined scope.
**Score:** 3/8 — Blast radius: 1, Pattern novelty: 0, Security: 1, Reversibility: 1

## Mission

Move the progress bar in the TaskCard component so it appears at the top of the card details, positioned immediately after the card header and before the task title. This improves visual hierarchy by showing task progress as a prominent first-glance indicator.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/components/TaskCard.tsx` — The main component to modify; understand current card structure and progress bar placement
- `packages/dashboard/app/styles.css` — Card styling including `.card-progress`, `.card-progress-bar`, and `.card-progress-fill` classes
- `packages/dashboard/app/components/__tests__/TaskCard.test.tsx` — Existing tests to ensure no regressions

## File Scope

- `packages/dashboard/app/components/TaskCard.tsx` — Move progress bar JSX in the non-editing card view
- `packages/dashboard/app/styles.css` — May need minor margin/padding adjustments
- `packages/dashboard/app/components/__tests__/TaskCard.test.tsx` — Update or add test to verify progress bar placement

## Steps

### Step 1: Analysis & Planning

- [ ] Read and understand current TaskCard.tsx structure — locate the `card-progress` div and its surrounding context
- [ ] Identify the exact insertion point: after `card-header`, before `card-title`
- [ ] Review existing CSS for margin/spacing implications of the new position

**Artifacts:**
- Notes on current JSX structure and intended new structure

### Step 2: Implement Layout Change

- [ ] Move the progress bar block (the entire conditional block that renders `card-progress`, `card-steps-toggle`, and `card-steps-list`) to immediately after `card-header` and before `card-title`
- [ ] Ensure the progress bar still only renders when `task.steps.length > 0`
- [ ] Preserve all existing functionality: step counting, toggle expand/collapse, step list rendering

**Current structure to find:**
```tsx
<div className="card-header">...</div>
<div className="card-title">...</div>
{task.steps.length > 0 && (
  <>
    <div className="card-progress">...</div>
    <button className="card-steps-toggle">...</button>
    {showSteps && <div className="card-steps-list">...</div>}
  </>
)}
```

**New structure:**
```tsx
<div className="card-header">...</div>
{task.steps.length > 0 && (
  <>
    <div className="card-progress">...</div>
    <button className="card-steps-toggle">...</button>
    {showSteps && <div className="card-steps-list">...</div>}
  </>
)}
<div className="card-title">...</div>
```

**Artifacts:**
- `packages/dashboard/app/components/TaskCard.tsx` (modified)

### Step 3: Style Adjustments

- [ ] Review and adjust CSS if needed — the progress bar currently has `margin-top: 8px` in `.card-progress` which may need adjustment when positioned after header
- [ ] Ensure visual spacing is consistent and the progress bar feels connected to the header area
- [ ] Verify no visual regressions in card hover states or drag states

**Artifacts:**
- `packages/dashboard/app/styles.css` (modified if needed)

### Step 4: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run existing TaskCard tests: `pnpm test packages/dashboard/app/components/__tests__/TaskCard.test.tsx`
- [ ] Verify all existing tests pass
- [ ] Build passes: `pnpm build`

**Artifacts:**
- Test output showing all tests pass

### Step 5: Documentation & Delivery

- [ ] Create changeset file for this UI improvement: `.changeset/move-progress-bar-top.md`
- [ ] Verify no documentation updates needed (this is a visual change, not a feature change)

**Artifacts:**
- `.changeset/move-progress-bar-top.md` (new)

## Documentation Requirements

**Must Update:**
- None — this is a visual layout improvement, no user-facing documentation changes required

**Check If Affected:**
- None

## Completion Criteria

- [ ] All steps complete
- [ ] Progress bar renders at the top of card details (after header, before title)
- [ ] Step toggle and collapsible step list still function correctly
- [ ] All existing TaskCard tests passing
- [ ] Build passes without errors
- [ ] Changeset file created

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-050): complete Step N — description`
- **Bug fixes:** `fix(KB-050): description`
- **Tests:** `test(KB-050): description`

Example commits:
- `feat(KB-050): complete Step 2 — move progress bar to top of card details`
- `feat(KB-050): complete Step 5 — add changeset for UI improvement`

## Do NOT

- Expand task scope beyond moving the progress bar position
- Modify the TaskDetailModal progress bar (that stays in the modal)
- Change the progress bar's internal logic or styling beyond positioning adjustments
- Skip running tests after making changes
- Create new visual designs or animations
