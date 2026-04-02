# Task: KB-207 - Reverse ahead and behind pace colors on usage indicators

**Created:** 2026-03-30
**Size:** S

## Review Level: 0 (None)

**Assessment:** Simple CSS-only change swapping color values between two CSS classes. Existing test coverage for pace indicators present.
**Score:** 2/8 — Blast radius: 0, Pattern novelty: 0, Security: 0, Reversibility: 2

## Mission

Reverse the colors for "ahead" and "behind" pace indicators in the usage modal. Currently:
- `.pace-ahead` (consuming faster than expected pace) uses `--color-error` (red)
- `.pace-behind` (consuming slower than expected pace) uses `#3b82f6` (blue)

After this change:
- `.pace-ahead` will use blue (`#3b82f6` or `--color-info` if available)
- `.pace-behind` will use `--color-error` (red)

This swaps the visual treatment while preserving the underlying pace status logic. The `.pace-ontrack` class (green/success) remains unchanged.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/components/UsageIndicator.tsx` — Usage indicator component; see `UsageWindowRow` function (lines 26-113) which applies `pace-ahead`, `pace-behind`, `pace-ontrack` CSS classes based on `pace.status` values
- `packages/dashboard/app/styles.css` — CSS definitions around lines 7194-7203 for pace indicator styling
- `packages/dashboard/app/components/UsageIndicator.test.tsx` — Existing pace indicator tests (lines 349-451) verify status rendering via text content

## File Scope

- `packages/dashboard/app/styles.css` — Modify `.pace-ahead` and `.pace-behind` color values and update comments

## Steps

### Step 1: Update CSS Color Definitions

- [ ] Swap color values for `.pace-ahead` and `.pace-behind` classes in `styles.css`
- [ ] Update CSS comments to reflect the swapped colors
- [ ] Keep `.pace-ontrack` unchanged (green/success color)

**Changes to make in `packages/dashboard/app/styles.css` around lines 7194-7203:**

```css
/* ahead = consuming faster than expected (now shown in info color) */
.pace-ahead {
  color: #3b82f6; /* blue - was var(--color-error) */
}

/* on-track = good/expected usage (unchanged) */
.pace-ontrack {
  color: var(--color-success);
}

/* behind = consuming slower than expected (now shown in warning color) */
.pace-behind {
  color: var(--color-error); /* red - was #3b82f6 */
}
```

**Artifacts:**
- `packages/dashboard/app/styles.css` (modified)

### Step 2: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm test` to execute full test suite
- [ ] Verify all UsageIndicator tests pass (existing tests verify pace status rendering via text content)
- [ ] Run `pnpm build` to ensure no build errors
- [ ] Verify no TypeScript or lint errors

### Step 3: Documentation & Delivery

- [ ] Verify no documentation updates required (this is a visual/UI change, not a behavior change)
- [ ] Create changeset file for the visual change:

```bash
cat > .changeset/reverse-pace-colors.md << 'EOF'
---
"@dustinbyrne/kb": patch
---

Reverse ahead and behind pace indicator colors in usage modal.
EOF
```

## Documentation Requirements

**Must Update:**
- None — This is a visual color correction with no behavioral or API changes

**Check If Affected:**
- None

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] CSS color values swapped correctly between `.pace-ahead` and `.pace-behind`
- [ ] CSS comments updated to reflect swapped colors
- [ ] `.pace-ontrack` styling unchanged (green)
- [ ] Changeset file created

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-207): complete Step N — description`
- **Bug fixes:** `fix(KB-207): description`
- **Tests:** `test(KB-207): description`

## Do NOT

- Modify the component logic in `UsageIndicator.tsx` — only CSS changes are needed
- Change the semantic meaning of "ahead" vs "behind" status detection — only swap the colors
- Modify `.pace-ontrack` styling — it must remain green/success color
- Expand scope to other color-related issues
- Add new CSS variables unless `--color-info` already exists (use `#3b82f6` if not)
