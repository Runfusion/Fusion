# Task: KB-654 - Fix Board Bottom Overflow on Mobile Devices

**Created:** 2026-04-01
**Size:** S

## Review Level: 0 (None)

**Assessment:** Simple CSS-only fix replacing `100vh` with `100dvh` for proper mobile viewport handling. Well-understood pattern already used elsewhere in the codebase.
**Score:** 1/8 — Blast radius: 0, Pattern novelty: 0, Security: 0, Reversibility: 1

## Mission

Fix the dashboard board layout so the bottom of the board is not cut off on mobile devices and devices with dynamic browser chrome (collapsing address bars, toolbars). The current implementation uses `height: calc(100vh - 57px)` which doesn't account for mobile viewport units, causing the board to extend below the visible viewport.

## Dependencies

- **None**

## Context to Read First

1. `packages/dashboard/app/styles.css` — Lines 378-385 (`.board` CSS class)
2. `packages/dashboard/app/styles.css` — Line 2791 (existing `dvh` usage in mobile modal styles — this is the pattern to follow)

## File Scope

- `packages/dashboard/app/styles.css` — Modify `.board` height calculation

## Steps

### Step 1: Update Board Height CSS

- [ ] Change `.board` height from `calc(100vh - 57px)` to `calc(100dvh - 57px)`
- [ ] Add a fallback for older browsers if desired: `height: calc(100vh - 57px)` followed by `height: calc(100dvh - 57px)`
- [ ] Verify the change is applied to the correct selector (`.board` at line ~384)

**Artifacts:**
- `packages/dashboard/app/styles.css` (modified)

### Step 2: Testing & Verification

> CSS-only change. Test visually and run existing tests to ensure no regressions.

- [ ] Run dashboard tests: `cd packages/dashboard && pnpm test`
- [ ] Verify build passes: `pnpm build`
- [ ] Manually verify on mobile device or DevTools mobile emulation that board bottom is visible

### Step 3: Documentation & Delivery

- [ ] Create changeset for the fix (patch bump for `@gsxdsm/fusion` since this affects published CLI/dashboard)
- [ ] No documentation updates needed — this is a bug fix

## Documentation Requirements

**Must Update:**
- None

**Check If Affected:**
- None

## Completion Criteria

- [ ] All steps complete
- [ ] Board height uses `100dvh` instead of `100vh`
- [ ] Tests passing
- [ ] Build passes
- [ ] Changeset created

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-654): complete Step N — description`
- **Bug fixes:** `fix(KB-654): description`
- **Tests:** `test(KB-654): description`

## Do NOT

- Modify JavaScript/TypeScript files — this is purely a CSS fix
- Add JavaScript-based viewport measurement workarounds
- Change the header height calculation (57px) unless testing proves it's wrong
- Affect desktop layouts negatively
