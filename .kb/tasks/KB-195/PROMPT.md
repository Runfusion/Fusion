# Task: KB-195 - Theme-aware styling for task and board selector toggles

**Created:** 2026-03-30
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** This is a focused CSS theming fix with minimal blast radius. The change standardizes toggle button styling across the dashboard to use theme-aware color variables consistently.
**Score:** 2/8 — Blast radius: 0, Pattern novelty: 1, Security: 0, Reversibility: 1

## Mission

Ensure the view toggle components (board/list selector in Header and used/remaining selector in UsageIndicator) are consistently styled with theme-aware colors across all color themes. Currently, the UsageIndicator toggle uses `var(--bg)` for its active state which provides inconsistent contrast across themes, while the Header toggle correctly uses `var(--todo)`. This task standardizes both to use `var(--todo)` for the active state background for consistency and proper theme integration.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/styles.css` — Lines 180-217 (view-toggle styles), lines 6949-6979 (usage-view-toggle styles)
- `packages/dashboard/app/components/Header.tsx` — View toggle component implementation
- `packages/dashboard/app/components/UsageIndicator.tsx` — Usage view toggle implementation
- `packages/dashboard/app/components/ThemeSelector.tsx` — Reference for available themes to test against

## File Scope

- `packages/dashboard/app/styles.css` — Modify toggle button styles for theme consistency

## Steps

### Step 1: Update Usage Indicator Toggle Styling

- [ ] Change `.usage-view-toggle-btn.active` background from `var(--bg)` to `var(--todo)`
- [ ] Change `.usage-view-toggle-btn.active` color from `var(--text)` to `var(--bg)` (for contrast against `--todo`)
- [ ] Update `.usage-view-toggle-btn.active:hover` to match (add if missing)
- [ ] Verify the box-shadow remains appropriate or update to use theme-aware shadow

**Artifacts:**
- `packages/dashboard/app/styles.css` (modified)

### Step 2: Verify Header Toggle Consistency

- [ ] Confirm Header view-toggle already uses `var(--todo)` for active state (should be unchanged)
- [ ] Confirm active text color is `var(--bg)` for proper contrast
- [ ] Check hover states are consistent between both toggle implementations

**Artifacts:**
- `packages/dashboard/app/styles.css` (verified, no changes expected)

### Step 3: Test Theme Compatibility

- [ ] Manually verify toggle appearance in default dark theme
- [ ] Manually verify toggle appearance in light theme
- [ ] Manually verify toggle appearance in at least 3 color themes (ocean, forest, sunset)
- [ ] Check high-contrast theme for accessibility
- [ ] Ensure active state is clearly distinguishable in all tested themes

**Test approach:** Use dashboard Settings → Appearance to switch themes and verify the Usage indicator toggle (click Usage icon in header) shows consistent styling with proper contrast in all themes.

### Step 4: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm test` to ensure no regressions
- [ ] Confirm Header tests pass: `pnpm test packages/dashboard/app/components/__tests__/Header.test.tsx`
- [ ] Confirm UsageIndicator tests pass: `pnpm test packages/dashboard/app/components/UsageIndicator.test.tsx`
- [ ] Build passes: `pnpm build`

### Step 5: Documentation & Delivery

- [ ] Create changeset file for patch release (affects published @dustinbyrne/kb package UI)
- [ ] Verify no other toggle components need similar fixes via search for `active` states using background colors
- [ ] Out-of-scope findings: If other inconsistent toggle patterns are found, create follow-up task via `task_create`

## Documentation Requirements

**Must Update:**
- None — CSS-only change with no user-facing documentation changes required

**Check If Affected:**
- `AGENTS.md` — Update if theme implementation patterns are documented there

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Toggles display consistently across all themes with proper contrast
- [ ] Changeset file included for patch release

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-195): complete Step N — description`
- **Bug fixes:** `fix(KB-195): description`
- **Tests:** `test(KB-195): description`

## Do NOT

- Expand scope to redesign the toggle components
- Modify JavaScript/TypeScript component logic
- Add new theme variables to the theme system
- Skip visual verification across multiple themes
- Commit without the task ID prefix
