# Task: KB-062 - Prevent Mobile Zoom When Creating New Issue

**Created:** 2026-03-30
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** Small, focused CSS change to prevent iOS Safari auto-zoom behavior when focusing the inline create textarea. Minimal blast radius, reversible by removing the font-size override.
**Score:** 2/8 — Blast radius: 0, Pattern novelty: 0, Security: 0, Reversibility: 2

## Mission

Prevent mobile browsers (particularly iOS Safari) from zooming in when users tap the "create new issue" textarea in the kanban board. iOS automatically zooms when input font sizes are below 16px. This fix ensures the inline create card maintains a consistent, non-zoomed view that feels like a native mobile app.

## Dependencies

- **Task:** KB-059 (Lock Mobile Viewport to Prevent Zoom) — The global viewport lock in KB-059 provides the primary defense against zoom. This task adds a targeted CSS safeguard specifically for the inline create input.

## Context to Read First

1. `packages/dashboard/app/components/InlineCreateCard.tsx` — The inline create card component with the textarea that triggers zoom
2. `packages/dashboard/app/styles.css` — Contains `.inline-create-input` styles and mobile responsive queries
3. `packages/dashboard/app/index.html` — Viewport meta tag (being modified by KB-059)

## File Scope

- `packages/dashboard/app/styles.css` — Add mobile-specific font-size override for inline create input

## Steps

### Step 0: Preflight

- [ ] Required files exist at `packages/dashboard/app/styles.css`
- [ ] KB-059 is complete (or coordinate implementation)
- [ ] Confirm current `.inline-create-input` uses `font-size: 13px`

### Step 1: Add Mobile Font-Size Override

- [ ] Locate the existing `@media (max-width: 768px)` section in `styles.css`
- [ ] Add CSS rule to set `.inline-create-input` font-size to `16px` on mobile:
  ```css
  @media (max-width: 768px) {
    /* Existing mobile styles... */
    
    .inline-create-input {
      font-size: 16px; /* Prevents iOS auto-zoom on focus */
    }
  }
  ```
- [ ] Verify the rule doesn't conflict with existing mobile styles
- [ ] Ensure the textarea remains usable and visually consistent with the design

**Artifacts:**
- `packages/dashboard/app/styles.css` (modified)

### Step 2: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Create test file `packages/dashboard/app/__tests__/mobile-input-zoom.test.ts` that validates:
  - Mobile media query exists in styles.css
  - `.inline-create-input` has font-size >= 16px within the mobile media query
- [ ] Run full test suite: `pnpm test packages/dashboard`
- [ ] Fix all failures
- [ ] Build passes: `pnpm build`

**Artifacts:**
- `packages/dashboard/app/__tests__/mobile-input-zoom.test.ts` (new)

### Step 3: Documentation & Delivery

- [ ] Check `packages/dashboard/README.md` — add note about mobile input behavior if a mobile section exists
- [ ] If KB-059 found any issues during implementation, ensure this fix addresses the inline create card specifically
- [ ] Out-of-scope findings created as new tasks via `task_create` tool

## Documentation Requirements

**Must Update:**
- None required — the CSS change is self-documenting

**Check If Affected:**
- `packages/dashboard/README.md` — add mobile behavior note if a mobile section exists

## Completion Criteria

- [ ] All steps complete
- [ ] `.inline-create-input` has `font-size: 16px` in the mobile media query (`max-width: 768px`)
- [ ] All tests passing (including new `mobile-input-zoom.test.ts`)
- [ ] Build passes
- [ ] Inline create card on mobile no longer triggers browser auto-zoom when focused

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-062): complete Step N — description`
- **Bug fixes:** `fix(KB-062): description`
- **Tests:** `test(KB-062): description`

## Do NOT

- Add JavaScript-based zoom prevention (unnecessary, CSS is sufficient)
- Change the desktop font-size (only mobile needs the 16px minimum)
- Modify the InlineCreateCard.tsx component (this is a CSS-only fix)
- Skip tests or rely on manual verification only
- Use `user-scalable=no` in this task (that's handled by KB-059)
