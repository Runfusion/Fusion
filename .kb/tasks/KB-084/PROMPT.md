# Task: KB-084 - Fix Card Glowing Gradient to Use Theme Colors

**Created:** 2026-03-30
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** This is a focused CSS-only change to make the card glow effect theme-aware. Low blast radius (only affects visual styling), uses established patterns (CSS variables), no security concerns, and fully reversible by reverting the CSS file.
**Score:** 3/8 — Blast radius: 0, Pattern novelty: 1, Security: 0, Reversibility: 2

## Mission

The dashboard card "agent-active" glow effect currently uses hardcoded purple RGBA values (`rgba(188, 140, 255, ...)`) instead of respecting the selected color theme. This causes the glow to remain purple even when using themes like "Ocean" (cyan), "Forest" (green), or "Sunset" (orange). Update the CSS to use CSS custom properties so the glow color dynamically matches the current theme's `--in-progress` color.

## Dependencies

- **None**

## Context to Read First

1. `packages/dashboard/app/styles.css` — The main stylesheet containing the agent-active glow styles (lines ~350-370 for cards, ~2350-2400 for list rows)
2. `packages/dashboard/app/components/ThemeSelector.tsx` — Shows the 8 available color themes
3. `packages/dashboard/app/components/TaskCard.tsx` — Applies the `agent-active` class based on task status

## File Scope

- `packages/dashboard/app/styles.css` — Modify CSS variables and glow animations

## Steps

### Step 1: Add RGB CSS Variables for Glow Support

> CSS box-shadow requires RGBA for transparency. We need RGB versions of theme colors to maintain alpha blending.

- [ ] In the `:root` section (near the top), add `--in-progress-rgb` alongside existing `--in-progress`
- [ ] Set `--in-progress-rgb: 188, 140, 255` (the RGB components of `#bc8cff`) for the default dark theme
- [ ] In `[data-theme="light"]` section, add `--in-progress-rgb: 130, 80, 223` (the RGB components of `#8250df`)
- [ ] For each color theme (`ocean`, `forest`, `sunset`, `berry`, `monochrome`, `high-contrast`, `solarized`), add `--in-progress-rgb` that matches their `--in-progress` color
- [ ] Verify all RGB values are correct by converting the hex colors:
  - ocean dark: `0, 229, 255` (#00e5ff)
  - ocean light: `0, 188, 212` (#00bcd4)
  - forest dark: `16, 185, 129` (#10b981)
  - forest light: `4, 120, 87` (#047857)
  - sunset dark: `255, 109, 0` (#ff6d00)
  - sunset light: `239, 108, 0` (#ef6c00)
  - berry dark: `234, 128, 252` (#ea80fc)
  - berry light: `142, 36, 170` (#8e24aa)
  - monochrome dark: `189, 189, 189` (#bdbdbd)
  - monochrome light: `117, 117, 117` (#757575)
  - high-contrast dark: `255, 0, 255` (#ff00ff)
  - high-contrast light: `204, 0, 204` (#cc00cc)
  - solarized: `42, 161, 152` (#2aa198) (same for light/dark)

**Artifacts:**
- `packages/dashboard/app/styles.css` (modified) — New `--in-progress-rgb` variables added

### Step 2: Update Card Agent-Active Glow to Use CSS Variables

> Replace hardcoded purple RGBA values with the theme-aware `--in-progress-rgb` variable

- [ ] Locate `.card.agent-active` rule (around line 350-370)
- [ ] Replace `rgba(188, 140, 255, 0.4)` with `rgba(var(--in-progress-rgb), 0.4)`
- [ ] Replace `rgba(188, 140, 255, 0.15)` with `rgba(var(--in-progress-rgb), 0.15)`
- [ ] Update the `@keyframes agent-glow` animation (0%, 100%, and 50% keyframes) to use `rgba(var(--in-progress-rgb), ...)`
- [ ] Verify the light theme override section still works correctly (it should now inherit the variable-based glow)
- [ ] Remove or simplify the duplicate `[data-theme="light"] .card.agent-active` override since the base glow now uses variables

**Artifacts:**
- `packages/dashboard/app/styles.css` (modified) — Card glow uses CSS variables

### Step 3: Update List View Agent-Active Glow

> The list view also has agent-active styling that needs the same treatment

- [ ] Locate `.list-row.agent-active` and `@keyframes list-agent-glow` (around line 2350-2400)
- [ ] Replace hardcoded `rgba(188, 140, 255, ...)` values with `rgba(var(--in-progress-rgb), ...)`
- [ ] Ensure the list row glow now matches the theme color

**Artifacts:**
- `packages/dashboard/app/styles.css` (modified) — List row glow uses CSS variables

### Step 4: Testing & Verification

> ZERO test failures allowed. Visual verification required for multiple themes.

- [ ] Run full test suite: `pnpm test`
- [ ] Build passes: `pnpm build`
- [ ] Manually verify the fix by checking the dashboard with different themes:
  - Start the dashboard: `pnpm --filter @kb/dashboard dev` or use `kb dashboard`
  - Switch to "Ocean" theme — cards with active agents should glow cyan, not purple
  - Switch to "Forest" theme — glow should be green
  - Switch to "Sunset" theme — glow should be orange
  - Switch to "Berry" theme — glow should be pink/purple (this theme actually uses purple, so verify it's the theme purple not the old hardcoded)
  - Switch to "High Contrast" — glow should be magenta (#ff00ff)
  - Switch between Light and Dark mode for each theme to verify both work

### Step 5: Documentation & Delivery

- [ ] Create changeset: `cat > .changeset/fix-card-glow-theme.md << 'EOF'
---
"@dustinbyrne/kb": patch
---

Fix card glowing gradient to respect the selected color theme instead of always using purple.
EOF`
- [ ] Commit with task ID: `feat(KB-084): complete Step 4 — make card glow theme-aware`

## Documentation Requirements

**Must Update:**
- None — this is a bug fix with no user-facing documentation changes needed

**Check If Affected:**
- `AGENTS.md` — Check if there's any documentation about theme system that should mention the glow effect

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing (`pnpm test`)
- [ ] Build passes (`pnpm build`)
- [ ] Visual verification completed for all 8 color themes in both light and dark modes
- [ ] Changeset created

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-084): complete Step N — description`
- **Bug fixes:** `fix(KB-084): description`
- **Tests:** `test(KB-084): description`

## Do NOT

- Expand task scope to refactor the entire theme system
- Skip visual verification — the RGB values must be manually checked
- Modify JavaScript/TypeScript files — this is a CSS-only fix
- Add new theme colors (out of scope)
- Change the glow animation timing or intensity (keep existing behavior, only change color)
