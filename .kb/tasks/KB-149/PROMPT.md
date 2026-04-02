# Task: KB-149 - Fix Mobile Touch Sensitivity on Dashboard Cards

**Created:** 2026-03-30
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** Focused UI fix for mobile touch behavior. Low blast radius - only affects TaskCard touch handling.
**Score:** 3/8 — Blast radius: 1, Pattern novelty: 0, Security: 0, Reversibility: 2

## Mission

Fix the mobile dashboard UX where touching and dragging to scroll accidentally launches the task card detail modal. Currently, `onTouchEnd` fires when a user lifts their finger after scrolling, triggering the modal open. Implement touch gesture detection to distinguish between scrolling/dragging (should NOT open modal) and intentional taps (should open modal).

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/components/TaskCard.tsx` — Card component with problematic touch handling
- `packages/dashboard/app/components/__tests__/TaskCard.test.tsx` — Existing tests for touch behavior patterns
- `packages/dashboard/app/components/TaskCard.test.tsx` — Additional card tests

## File Scope

- `packages/dashboard/app/components/TaskCard.tsx` (modify)
- `packages/dashboard/app/components/__tests__/TaskCard.test.tsx` (add tests)

## Steps

### Step 1: Implement Touch Gesture Detection

Implement tap vs scroll detection in TaskCard using touch start/move/end tracking:

- [ ] Add `touchStartPos` ref to store initial touch coordinates `{x, y, time}`
- [ ] Add `hasTouchMoved` ref to track if finger moved significantly
- [ ] Implement `handleTouchStart` handler that records initial touch position and timestamp
- [ ] Implement `handleTouchMove` handler that sets `hasTouchMoved` if movement exceeds threshold (e.g., 10px)
- [ ] Modify `handleTouchEnd` to only open modal if:
  - Touch duration was short (< 300ms — indicates tap, not long press)
  - Finger didn't move significantly (`hasTouchMoved` is false)
  - Target is not an interactive element (existing `isInteractiveTarget` check)
- [ ] Replace `onTouchEnd` prop with `onTouchStart` + `onTouchMove` + updated `onTouchEnd` handlers

Use these constants for gesture detection:
```typescript
const TOUCH_MOVE_THRESHOLD = 10; // pixels
const TOUCH_TAP_MAX_DURATION = 300; // milliseconds
```

**Artifacts:**
- `packages/dashboard/app/components/TaskCard.tsx` (modified)

### Step 2: Add Tests for Touch Gesture Handling

Add tests in `packages/dashboard/app/components/__tests__/TaskCard.test.tsx`:

- [ ] Test that a quick tap (no movement) opens the modal
- [ ] Test that dragging beyond threshold does NOT open the modal
- [ ] Test that slow touch (long press) does NOT open the modal
- [ ] Test that touch on interactive elements (buttons) still works normally
- [ ] Run new tests and verify they pass

Use `fireEvent.touchStart`, `fireEvent.touchMove`, `fireEvent.touchEnd` from `@testing-library/react`.

**Artifacts:**
- `packages/dashboard/app/components/__tests__/TaskCard.test.tsx` (modified)

### Step 3: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm test --filter @kb/dashboard` to verify all dashboard tests pass
- [ ] Run `pnpm typecheck --filter @kb/dashboard` to verify no TypeScript errors
- [ ] Run `pnpm build --filter @kb/dashboard` to verify build succeeds

### Step 4: Documentation & Delivery

- [ ] Create changeset for the fix: `fix-mobile-card-touch-sensitivity.md` (patch level)
- [ ] Verify all files committed with proper task ID prefix

## Documentation Requirements

**Must Update:**
- None (this is a bug fix with no API changes)

**Check If Affected:**
- None

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Touch scrolling on mobile no longer accidentally opens modals
- [ ] Intentional taps on cards still open the detail modal
- [ ] Changeset file created

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-149): complete Step N — description`
- **Bug fixes:** `fix(KB-149): description`
- **Tests:** `test(KB-149): description`

## Do NOT

- Expand scope to other touch-related issues
- Skip tests
- Modify files outside File Scope without good reason
- Change the desktop/mouse click behavior (preserve existing `onClick` logic)
- Commit without the task ID prefix
