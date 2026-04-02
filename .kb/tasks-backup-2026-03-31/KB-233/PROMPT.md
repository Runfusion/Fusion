# Task: KB-233 - The pace indicator should be a gray line

**Created:** 2025-03-31
**Size:** S

## Review Level: 0 (None)

**Assessment:** This is a single-line CSS change with minimal blast radius. The pace marker line color is purely presentational with no logic dependencies.
**Score:** 1/8 — Blast radius: 0, Pattern novelty: 0, Security: 0, Reversibility: 1

## Mission

Change the pace marker (vertical line indicator) in the Usage Indicator modal from its current color to a neutral gray. The pace marker shows the elapsed time position on the usage progress bar and should be visually subtle rather than attention-grabbing.

Current: Uses `var(--in-progress)` (purple)
Target: Use `var(--text-muted)` (neutral gray #8b949e)

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/components/UsageIndicator.tsx` — Line ~96: The `usage-pace-marker` div element
- `packages/dashboard/app/styles.css` — Lines ~7248-7257: `.usage-pace-marker` CSS class

## File Scope

- `packages/dashboard/app/styles.css` (modified)

## Steps

### Step 1: Change Pace Marker Color

- [ ] In `packages/dashboard/app/styles.css`, locate the `.usage-pace-marker` class (around line 7248)
- [ ] Change `background: var(--in-progress);` to `background: var(--text-muted);`

**Artifacts:**
- `packages/dashboard/app/styles.css` (modified)

### Step 2: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full test suite: `pnpm test`
- [ ] Verify all tests pass
- [ ] Build passes: `pnpm build`

### Step 3: Documentation & Delivery

- [ ] No documentation updates required (visual change only)
- [ ] No changeset required (minor UI tweak, not user-facing feature change)

## Completion Criteria

- [ ] Pace marker line displays in gray color (`var(--text-muted)`)
- [ ] All tests passing
- [ ] Build succeeds

## Git Commit Convention

- **Step completion:** `feat(KB-233): change pace marker to gray line`
- **Build fixes:** `fix(KB-233): adjust CSS variable reference`

## Do NOT

- Change the pace icon colors or icons (handled by KB-232)
- Modify the `.pace-ahead`, `.pace-behind`, or `.pace-ontrack` CSS classes
- Change the UsageIndicator component logic
- Add new CSS variables
