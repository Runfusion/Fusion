# Task: KB-173 - Add a super clean theme that is mostly mono with slight color accent, but really tones down glows and extra bits - it should be super clean and minimal

**Created:** 2026-03-30
**Size:** M

## Review Level: 1 (Plan Only)

**Assessment:** This is a straightforward theme addition that follows well-established patterns. The theme system is already in place with clear conventions for adding new themes. Low blast radius - only affects dashboard styling.
**Score:** 2/8 — Blast radius: 0, Pattern novelty: 0, Security: 0, Reversibility: 2

## Mission

Create a new "zen" color theme for the dashboard that provides a super clean, minimal aesthetic. The theme should be predominantly monochrome with subtle, desaturated accent colors, significantly reduced glow effects, and a focus on clarity and calm. This theme targets users who want a distraction-free, professional interface without visual noise.

## Dependencies

- **None**

## Context to Read First

- `packages/core/src/types.ts` — Contains `COLOR_THEMES` array and `ColorTheme` type definition
- `packages/dashboard/app/styles.css` — Contains all theme CSS definitions (search for existing themes like `monochrome` and `factory` for patterns)
- `packages/dashboard/app/components/ThemeSelector.tsx` — Theme selector UI component
- `packages/dashboard/app/components/__tests__/ThemeSelector.test.tsx` — Test patterns for theme selector

## File Scope

- `packages/core/src/types.ts` — Add new theme to COLOR_THEMES array
- `packages/dashboard/app/styles.css` — Add CSS theme block and swatch styles
- `packages/dashboard/app/components/ThemeSelector.tsx` — Add theme option to COLOR_THEMES array
- `packages/dashboard/app/components/__tests__/ThemeSelector.test.tsx` — Add test assertions for new theme

## Steps

### Step 1: Update Core Types

- [ ] Add `"zen"` to the `COLOR_THEMES` array in `packages/core/src/types.ts` (maintain alphabetical order after "sunset")
- [ ] Verify `ColorTheme` type automatically includes the new theme via `typeof COLOR_THEMES`
- [ ] Run `pnpm build` in packages/core to regenerate types

**Artifacts:**
- `packages/core/src/types.ts` (modified)

### Step 2: Add Zen Theme CSS Styles

- [ ] Add CSS block `[data-color-theme="zen"]` in `packages/dashboard/app/styles.css` after the existing monochrome theme block (around line 5044)
- [ ] Define minimal, clean color palette:
  - Background: near-black `#0c0c0c` or very dark gray `#111111`
  - Surface: subtle lift `#1a1a1a`
  - Card: `#222222`
  - Card hover: `#2a2a2a`
  - Border: `#333333` (very subtle)
  - Text: `#e0e0e0` (soft white, not harsh)
  - Text muted: `#808080` (true gray)
  - Text dim: `#555555`
  - Todo accent: desaturated blue-gray `#6b7b8c`
  - In-progress accent: desaturated slate `#7a8590`
  - In-review: soft green-gray `#6b8c7a`
  - Triage: warm gray `#8c7b6b`
  - Done: `#666666`
- [ ] Override glow tokens to be minimal or disabled:
  - `--shadow-glow: none` or very subtle
  - `--glow-success: none`
  - `--glow-warning: none`
  - `--glow-danger: none`
  - `--focus-ring: 0 0 0 1px var(--border)` (thin, no glow)
- [ ] Add `[data-color-theme="zen"][data-theme="light"]` variant with:
  - Background: `#fafafa` or `#f5f5f5`
  - Surface: `#ffffff`
  - Card: `#f0f0f0`
  - Muted desaturated accents appropriate for light mode
- [ ] Add `.theme-swatch-zen` swatch styles in the theme selector section (around line 5570)

**Artifacts:**
- `packages/dashboard/app/styles.css` (modified)

### Step 3: Update ThemeSelector Component

- [ ] Add new entry to `COLOR_THEMES` array in `ThemeSelector.tsx`:
  - `{ value: "zen", label: "Zen", className: "theme-swatch-zen" }`
  - Place after "sunset" to maintain rough alphabetical ordering

**Artifacts:**
- `packages/dashboard/app/components/ThemeSelector.tsx` (modified)

### Step 4: Add Tests for New Theme

- [ ] Add test assertion in `ThemeSelector.test.tsx` to verify "Zen theme" is rendered:
  - `expect(screen.getByLabelText("Zen theme")).toBeDefined();`
- [ ] Add test to verify selecting Zen theme calls handler correctly
- [ ] Run ThemeSelector tests: `pnpm test -- packages/dashboard/app/components/__tests__/ThemeSelector.test.tsx`

**Artifacts:**
- `packages/dashboard/app/components/__tests__/ThemeSelector.test.tsx` (modified)

### Step 5: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run dashboard package tests: `cd packages/dashboard && pnpm test`
- [ ] Verify all existing tests pass
- [ ] Run full test suite: `pnpm test`
- [ ] Build passes: `pnpm build`

### Step 6: Documentation & Delivery

- [ ] Create changeset file for the new theme:
  ```bash
  cat > .changeset/add-zen-theme.md << 'EOF'
  ---
  "@dustinbyrne/kb": minor
  ---

  Add new "Zen" color theme - a minimal, monochrome theme with subtle accents and reduced visual noise
  EOF
  ```
- [ ] Verify theme appears in settings modal theme selector
- [ ] Test both dark and light variants manually

## Documentation Requirements

**Must Update:**
- None required — theme is self-documenting in the UI

**Check If Affected:**
- `README.md` — Update if there's a features/themes section

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Theme appears in dropdown and applies correctly
- [ ] Both dark and light variants render properly
- [ ] Changeset file created

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-173): complete Step N — description`
- **Bug fixes:** `fix(KB-173): description`
- **Tests:** `test(KB-173): description`

## Do NOT

- Modify the default theme
- Change existing theme behavior
- Add animations or complex effects (keep it zen/minimal)
- Use saturated colors - keep accents desaturated and subtle
- Skip the light variant
- Forget to update the theme selector swatch styles
