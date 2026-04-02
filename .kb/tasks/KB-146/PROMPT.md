# Task: KB-146 - Enable task editing on mobile

**Created:** 2026-03-30
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** This is a focused CSS-only change to make the card edit button visible on mobile devices where hover doesn't exist. It builds on the existing card editing functionality but doesn't modify any JavaScript logic or backend contracts.
**Score:** 2/8 — Blast radius: 1, Pattern novelty: 0, Security: 0, Reversibility: 1

## Mission

Fix the inability to edit tasks on mobile by making the card edit button always visible on touch devices. Currently, the edit button (`card-edit-btn`) only appears on hover (`card:hover .card-edit-btn`), which is impossible to trigger on mobile touchscreens. This change ensures mobile users can access the inline edit functionality by showing the edit button persistently on mobile breakpoints.

## Dependencies

- **Task:** KB-145 (what must be complete — the edit button exists on cards and the editing flow works; this task only makes it visible on mobile)

## Context to Read First

- `packages/dashboard/app/components/TaskCard.tsx` — inline editing implementation and edit button placement
- `packages/dashboard/app/styles.css` — current card edit button styles with hover-based visibility
- `packages/dashboard/app/components/__tests__/TaskCard.test.tsx` — existing card editing tests

## File Scope

- `packages/dashboard/app/styles.css` (mobile media query additions only)

## Steps

### Step 0: Preflight

- [ ] Required files and paths exist
- [ ] Dependencies satisfied — KB-145 complete with edit button working on desktop

### Step 1: Make card edit button visible on mobile

- [ ] Add CSS media query for mobile breakpoints (`max-width: 768px` or appropriate mobile range) that overrides the hover-based opacity hiding
- [ ] The `.card-edit-btn` should have `opacity: 1` and be fully visible on mobile devices (not hover-dependent)
- [ ] Ensure the button remains touch-friendly with adequate tap target size (maintains or exceeds 44x44px touch target)
- [ ] Verify the button positioning works in the card layout on mobile (doesn't overlap other elements)
- [ ] Run targeted tests: `pnpm --filter @kb/dashboard test -- --run app/components/__tests__/TaskCard.test.tsx`

**Artifacts:**
- `packages/dashboard/app/styles.css` (modified — mobile visibility rules for card-edit-btn)

### Step 2: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full dashboard test suite: `pnpm --filter @kb/dashboard test`
- [ ] Verify no regressions in desktop hover behavior (edit button still hidden by default, visible on hover)
- [ ] Fix all failures
- [ ] Run `pnpm build` and confirm it passes

### Step 3: Documentation & Delivery

- [ ] Update `packages/dashboard/README.md` — add a brief note under Task Management about mobile editing being available
- [ ] Out-of-scope findings created as new tasks via `task_create` tool if any issues discovered

## Documentation Requirements

**Must Update:**
- `packages/dashboard/README.md` — mention that task editing is now available on mobile devices via the visible edit button on task cards

**Check If Affected:**
- None

## Completion Criteria

- [ ] All steps complete
- [ ] Card edit button is visible by default on mobile (≤768px)
- [ ] Desktop hover behavior unchanged (edit button hidden until hover)
- [ ] All tests passing
- [ ] Documentation updated

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-146): complete Step N — description`
- **Bug fixes:** `fix(KB-146): description`
- **Tests:** `test(KB-146): description`

## Do NOT

- Modify JavaScript/TypeScript code — this is a CSS-only fix
- Change the edit button functionality or behavior
- Add new components or features
- Modify the edit button styling beyond visibility on mobile
- Skip tests
- Commit without the task ID prefix
