# Task: KB-017 - Add Size Indicator to Task Card

**Created:** 2026-03-30
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** Small UI-only change adding a size badge to existing TaskCard component. Uses established badge patterns with no logic changes.
**Score:** 2/8 — Blast radius: 1, Pattern novelty: 0, Security: 0, Reversibility: 1

## Mission

Add a small size indicator (S, M, L) to the top-right corner of task cards in the dashboard. This allows users to quickly gauge the estimated effort of a task at a glance. The indicator should be subtle but visible, positioned in the card header area alongside existing badges.

## Dependencies

- **None**

## Context to Read First

- `packages/core/src/types.ts` — Review the `Task` interface which already includes `size?: "S" | "M" | "L"`
- `packages/dashboard/app/components/TaskCard.tsx` — Current card implementation, understand `card-header` structure and existing badge patterns
- `packages/dashboard/app/styles.css` — Review `.card-header`, `.card-id`, `.card-status-badge` styling patterns
- `packages/dashboard/app/components/__tests__/TaskCard.test.tsx` — Existing test patterns for the component

## File Scope

- `packages/dashboard/app/components/TaskCard.tsx` — Add size badge to card header
- `packages/dashboard/app/styles.css` — Add `.card-size-badge` styles
- `packages/dashboard/app/components/__tests__/TaskCard.test.tsx` — Add tests for size badge rendering

## Steps

### Step 1: Implement Size Badge in TaskCard

- [ ] Add size badge element in the `card-header` section of `TaskCard.tsx`
- [ ] Position it after the status badges (top-right area)
- [ ] Only render when `task.size` is defined
- [ ] Display the size value (S, M, or L) in uppercase
- [ ] Run targeted tests: `pnpm test -- packages/dashboard/app/components/__tests__/TaskCard.test.tsx`

**Artifacts:**
- `packages/dashboard/app/components/TaskCard.tsx` (modified)

### Step 2: Add CSS Styling

- [ ] Add `.card-size-badge` class with appropriate styling
- [ ] Use distinct subtle colors for each size:
  - S: subtle green tint (low effort)
  - M: neutral/default tint (medium effort)
  - L: subtle amber tint (higher effort)
- [ ] Match font size (10px), padding, and border-radius to existing badges
- [ ] Ensure badge fits within card-header without overflow
- [ ] Verify styling with build: `pnpm build`

**Artifacts:**
- `packages/dashboard/app/styles.css` (modified)

### Step 3: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full test suite: `pnpm test`
- [ ] Fix all failures
- [ ] Build passes: `pnpm build`

### Step 4: Documentation & Delivery

- [ ] Update relevant documentation (none required for this UI-only change)
- [ ] Out-of-scope findings created as new tasks via `task_create` tool

## Documentation Requirements

**Must Update:**
- None (UI-only change, self-documenting through visual design)

**Check If Affected:**
- None

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Size badge renders correctly for tasks with S, M, L sizes
- [ ] No badge shown for tasks without a size
- [ ] Badge positioned in top-right of card header
- [ ] Styling consistent with dashboard design system

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-017): complete Step N — description`
- **Bug fixes:** `fix(KB-017): description`
- **Tests:** `test(KB-017): description`

## Do NOT

- Expand task scope to add size editing functionality
- Skip tests
- Modify files outside the File Scope without good reason
- Commit without the task ID prefix
- Change the size values (keep as S, M, L — don't add XL or other sizes)
