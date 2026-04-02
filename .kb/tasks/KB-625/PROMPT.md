# Task: KB-625 - Add Industrial Theme

**Created:** 2026-03-31
**Size:** S

## Review Level: 0 (None)

**Assessment:** Self-contained theme addition with no external dependencies. Pure CSS and type updates with zero blast radius to existing functionality.
**Score:** 1/8 — Blast radius: 0, Pattern novelty: 0, Security: 1, Reversibility: 0

## Mission

Add a new "Industrial" color theme inspired by technical engineering spec sheets and industrial manufacturing aesthetics. The theme features bold orange/copper accents on dark charcoal backgrounds with cyan technical highlights, creating a factory-floor blueprint feel.

## Dependencies

- **None**

## Context to Read First

1. `packages/core/src/types.ts` — See `COLOR_THEMES` array and `ColorTheme` type definition (line ~35)
2. `packages/dashboard/app/styles.css` — Review existing color theme definitions starting at line 5466 (search for `[data-color-theme="..."]`)
3. `packages/dashboard/app/components/ThemeSelector.tsx` — See how themes are registered in `COLOR_THEMES` array and swatch classNames

## File Scope

- `packages/core/src/types.ts` — Add "industrial" to `COLOR_THEMES` array
- `packages/dashboard/app/styles.css` — Add `[data-color-theme="industrial"]` CSS rules
- `packages/dashboard/app/components/ThemeSelector.tsx` — Add theme option to selector

## Steps

### Step 1: Update Theme Types

- [ ] Add "industrial" to the `COLOR_THEMES` array in `packages/core/src/types.ts`
- [ ] Ensure alphabetical ordering is maintained (insert between "high-contrast" and "monochrome")

**Artifacts:**
- `packages/core/src/types.ts` (modified)

### Step 2: Add CSS Theme Definition

- [ ] Add `[data-color-theme="industrial"]` dark mode CSS block with:
  - `--bg`: #0c0c0c (deep industrial black)
  - `--surface`: #141414 (slightly lighter for surfaces)
  - `--card`: #1a1a1a (card backgrounds)
  - `--card-hover`: #222222 (hover state)
  - `--border`: #333333 (subtle borders)
  - `--text`: #e8e8e8 (off-white for readability)
  - `--text-muted`: #888888 (secondary text)
  - `--text-dim`: #555555 (tertiary text)
  - `--todo`: #ff6b00 (bright industrial orange - primary accent)
  - `--in-progress`: #ff8c00 (slightly lighter orange)
  - `--in-progress-rgb`: 255, 140, 0 (for glow effects)
  - `--in-review`: #00bcd4 (cyan - technical blueprint accent)
  - `--triage`: #ff5722 (copper/deep orange)
  - `--done`: #666666 (industrial grey)
  - `--color-success`: #00bcd4 (cyan for success)
  - `--color-error`: #ff3d00 (deep orange-red for errors)
- [ ] Add `[data-color-theme="industrial"][data-theme="light"]` block with light variants:
  - `--bg`: #f0f0f0
  - `--surface`: #fafafa
  - `--card`: #ffffff
  - `--card-hover`: #f5f5f5
  - `--border`: #d0d0d0
  - `--text`: #1a1a1a
  - `--text-muted`: #666666
  - `--text-dim`: #999999
  - `--todo`: #e65100 (darker orange for light mode)
  - `--in-progress`: #ef6c00
  - `--in-progress-rgb`: 239, 108, 0
  - `--in-review`: #0097a7 (darker cyan)
  - `--triage`: #d84315
  - `--done`: #555555
  - `--color-success`: #0097a7
  - `--color-error`: #d84315
- [ ] Place the CSS after the "high-contrast" theme and before "monochrome" to maintain alphabetical order

**Artifacts:**
- `packages/dashboard/app/styles.css` (modified)

### Step 3: Add Theme Selector Entry

- [ ] Add `{ value: "industrial", label: "Industrial", className: "theme-swatch-industrial" }` to `COLOR_THEMES` array in `ThemeSelector.tsx`
- [ ] Maintain alphabetical ordering (place between "high-contrast" and "monochrome")

**Artifacts:**
- `packages/dashboard/app/components/ThemeSelector.tsx` (modified)

### Step 4: Add Theme Swatch Styles

- [ ] Add `.theme-swatch-industrial` CSS class to `styles.css` in the theme swatches section (search for `.theme-swatch-default`)
- [ ] Use a gradient or solid orange/copper color that represents the industrial aesthetic
- [ ] Example: `background: linear-gradient(135deg, #ff6b00 0%, #ff8c00 50%, #00bcd4 100%);` or solid `#ff6b00`

**Artifacts:**
- `packages/dashboard/app/styles.css` (modified)

### Step 5: Testing & Verification

> ZERO test failures allowed.

- [ ] Run `pnpm build` to verify TypeScript compiles without errors
- [ ] Verify the new theme appears in the ThemeSelector dropdown
- [ ] Test switching to the "Industrial" theme and verify colors apply correctly
- [ ] Test both dark and light modes for the industrial theme
- [ ] Run `pnpm test` to ensure no regressions

### Step 6: Documentation & Delivery

- [ ] Verify the theme works end-to-end by checking:
  - Column headers show orange accents
  - In-progress cards show the orange glow
  - Todo column shows orange
  - In-review shows cyan technical accent
- [ ] No documentation updates needed (theme is self-discoverable in UI)

## Completion Criteria

- [ ] All steps complete
- [ ] Build passes (`pnpm build` succeeds)
- [ ] All tests passing (`pnpm test`)
- [ ] Industrial theme appears in ThemeSelector with correct label
- [ ] Theme applies correct colors in both dark and light modes
- [ ] Orange/copper industrial aesthetic visible on cards and UI elements

## Git Commit Convention

- **Step completion:** `feat(KB-625): complete Step N — description`
- **Bug fixes:** `fix(KB-625): description`

## Do NOT

- Modify any existing theme definitions
- Change default theme behavior
- Add new dependencies
- Modify any other components beyond ThemeSelector
- Skip build verification
