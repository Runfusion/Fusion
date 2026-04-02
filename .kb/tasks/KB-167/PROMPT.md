# Task: KB-167 - Fix Mobile Touch Scrolling on Task Cards

**Created:** 2026-03-30
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** Focused UI fix for mobile touch behavior. Low blast radius - only affects TaskCard touch handling. Well-understood pattern from prior analysis.
**Score:** 3/8 — Blast radius: 1, Pattern novelty: 0, Security: 0, Reversibility: 2

## Mission

Fix the mobile dashboard UX where users cannot scroll through the task board without accidentally opening task detail modals. Currently, `onTouchEnd` fires when a user lifts their finger after scrolling, triggering the modal open. The card needs to distinguish between scroll gestures (which should NOT open the modal) and intentional tap gestures (which should open the modal).

## Dependencies

- **Task:** KB-149 — Mobile touch sensitivity fix (if completed first, verify no conflicts)

## Context to Read First

- `packages/dashboard/app/components/TaskCard.tsx` — Card component with touch handling (lines 84, 185-195, 403)
- `packages/dashboard/app/components/__tests__/TaskCard.test.tsx` — Existing card tests
- `packages/dashboard/app/__tests__/mobile-scroll-snap.test.ts` — Mobile scroll behavior tests

## File Scope

- `packages/dashboard/app/components/TaskCard.tsx` (modify touch handlers)
- `packages/dashboard/app/components/__tests__/TaskCard.test.tsx` (add touch gesture tests)

## Steps

### Step 1: Implement Touch Gesture Detection

Add tap vs scroll detection to distinguish scrolling from intentional taps:

- [ ] Add `touchStartPos` ref to store initial touch `{x, y, time}`
- [ ] Add `hasTouchMoved` ref to track if finger moved beyond threshold
- [ ] Implement `handleTouchStart` to record initial position and timestamp
- [ ] Implement `handleTouchMove` to set `hasTouchMoved = true` if movement exceeds 10px
- [ ] Modify `handleTouchEnd` to only call `handleClick()` when ALL conditions are met:
  - `!hasTouchMoved` (finger didn't move significantly — not a scroll)
  - `Date.now() - touchStartPos.time < 300` (quick tap, not long press)
  - `!isInteractiveTarget(e.target)` (not clicking a button/link)
- [ ] Replace single `onTouchEnd` prop with `onTouchStart` + `onTouchMove` + updated `onTouchEnd`
- [ ] Add `touch-action: pan-y` CSS to card if needed to allow vertical scrolling

Constants to use:
```typescript
const TOUCH_MOVE_THRESHOLD = 10; // pixels
const TOUCH_TAP_MAX_DURATION = 300; // milliseconds
```

**Artifacts:**
- `packages/dashboard/app/components/TaskCard.tsx` (modified touch handlers)

### Step 2: Add Tests for Touch Gesture Handling

Add comprehensive tests in `packages/dashboard/app/components/__tests__/TaskCard.test.tsx`:

- [ ] Test that a quick tap without movement opens the modal
- [ ] Test that dragging beyond 10px threshold does NOT open modal
- [ ] Test that slow touch (>300ms) does NOT open modal
- [ ] Test that touch on interactive elements (buttons, links) works normally
- [ ] Test that vertical scrolling (Y movement) prevents modal open
- [ ] Test that horizontal scrolling (X movement) prevents modal open
- [ ] Run new tests: `pnpm test --filter @kb/dashboard -- TaskCard`

Use fireEvent.touchStart, fireEvent.touchMove, fireEvent.touchEnd with touch coordinates.

**Artifacts:**
- `packages/dashboard/app/components/__tests__/TaskCard.test.tsx` (new tests added)

### Step 3: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm test --filter @kb/dashboard` — all tests pass
- [ ] Run `pnpm typecheck --filter @kb/dashboard` — no TypeScript errors
- [ ] Run `pnpm build --filter @kb/dashboard` — build succeeds
- [ ] Manual verification: On mobile device or dev tools mobile emulation, verify:
  - Scrolling the board vertically does NOT open task modals
  - Scrolling horizontally between columns does NOT open task modals
  - Quick intentional tap on a card DOES open the detail modal
  - Tap on buttons within cards (edit, archive) still works

### Step 4: Documentation & Delivery

- [ ] Create changeset file `.changeset/fix-mobile-touch-scroll.md`:
```markdown
---
"@dustinbyrne/kb": patch
---

Fix mobile touch behavior where scrolling accidentally opened task modals. Cards now detect tap vs scroll gestures.
```
- [ ] Commit with task ID prefix: `fix(KB-167): prevent modal open on mobile scroll`

## Documentation Requirements

**Must Update:**
- None (bug fix, no API changes)

**Check If Affected:**
- None

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Touch scrolling on mobile no longer triggers modal
- [ ] Intentional taps still open task details
- [ ] Interactive elements within cards remain functional
- [ ] Changeset file created

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-167): complete Step N — description`
- **Bug fixes:** `fix(KB-167): description`
- **Tests:** `test(KB-167): description`

## Do NOT

- Expand scope to other mobile issues (pinch zoom, swipe actions, etc.)
- Skip tests — touch behavior must be verified automatically
- Modify desktop/mouse behavior (preserve onClick handling)
- Change card styling beyond touch-action if needed
- Commit without the task ID prefix
