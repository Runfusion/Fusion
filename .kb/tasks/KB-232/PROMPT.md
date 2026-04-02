# Task: KB-232 - For pace indicators swap the colors and icons for over/under

**Created:** 2025-03-31
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** This is a straightforward UI change with clear requirements. The blast radius is limited to one component and its associated CSS classes. The pattern is a simple icon and color swap with no security implications.
**Score:** 2/8 — Blast radius: 0, Pattern novelty: 0, Security: 0, Reversibility: 2

## Mission

Fix the pace indicator visual semantics in the Usage Indicator modal. Currently:
- "Ahead" (over pace, bad): Uses TrendingUp icon + blue color
- "Behind" (under pace, good): Uses Info icon + red color

Swap these so it correctly conveys:
- "Ahead" (over pace, bad): Warning icon + red/error color
- "Behind" (under pace, good): Positive icon + green/success color

The semantic intent is that being under your usage pace is good, while being over pace is a concern.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/components/UsageIndicator.tsx` — Component rendering pace indicators
- `packages/dashboard/app/components/UsageIndicator.test.tsx` — Existing tests for pace indicators
- `packages/dashboard/app/styles.css` — CSS classes around line 7276 defining pace colors

## File Scope

- `packages/dashboard/app/components/UsageIndicator.tsx` (modified)
- `packages/dashboard/app/components/UsageIndicator.test.tsx` (modified)
- `packages/dashboard/app/styles.css` (modified)

## Steps

### Step 1: Swap Colors in CSS

- [ ] Update `.pace-ahead` class to use `var(--color-error)` (red) — currently blue (#3b82f6)
- [ ] Update `.pace-behind` class to use `var(--color-success)` (green) — currently red
- [ ] Remove or update the outdated CSS comments that incorrectly describe the color logic

**Artifacts:**
- `packages/dashboard/app/styles.css` (modified)

### Step 2: Swap Icons in Component

- [ ] Import `AlertTriangle` from lucide-react (for "ahead/over pace" warning state)
- [ ] Swap the icon usage:
  - `ahead` (over pace): Use `AlertTriangle` icon instead of `TrendingUp`
  - `behind` (under pace): Use `TrendingUp` icon instead of `Info` (positive indicator)
- [ ] Keep `CheckCircle` for `on-track` state (unchanged)

**Artifacts:**
- `packages/dashboard/app/components/UsageIndicator.tsx` (modified)

### Step 3: Update Tests

- [ ] Update test assertions that check for pace icon classes or icon types:
  - "ahead of pace" tests should expect warning/alert icon presence
  - "behind pace" tests should expect positive/trending icon presence
- [ ] Run component tests to verify: `pnpm test -- UsageIndicator.test.tsx`

**Artifacts:**
- `packages/dashboard/app/components/UsageIndicator.test.tsx` (modified)

### Step 4: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full test suite: `pnpm test`
- [ ] Verify all tests pass
- [ ] Build passes: `pnpm build`

### Step 5: Documentation & Delivery

- [ ] No documentation updates required (this is a UX fix, not a feature change)
- [ ] Create changeset if needed (visual change only, no API change — patch level if applicable)

## Completion Criteria

- [ ] "Ahead" (over pace) shows `AlertTriangle` icon in red/error color
- [ ] "Behind" (under pace) shows `TrendingUp` icon in green/success color
- [ ] "On-track" remains unchanged with `CheckCircle` in green
- [ ] All tests passing
- [ ] Build succeeds

## Git Commit Convention

- **Step completion:** `feat(KB-232): complete Step N — swap pace indicator colors/icons`
- **Bug fixes:** `fix(KB-232): adjust pace indicator color mapping`
- **Tests:** `test(KB-232): update pace indicator tests for swapped icons`

## Do NOT

- Change the API shape or the `pace.status` values returned from backend
- Modify the UsagePace type definition in `api.ts`
- Change the logic that determines `isAhead`, `isBehind`, or `isOnTrack` — only the presentation
- Alter the pace marker line styling (covered by separate task KB-233)
- Add new dependencies
