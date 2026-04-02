# Task: KB-070 - Add Ayu and One Dark themes

**Created:** 2026-03-30
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** Adding two new color themes (Ayu and One Dark) following the established pattern in the codebase. Requires coordinated changes across core types, dashboard hooks, theme selector component, and CSS. Low blast radius, purely additive feature.
**Score:** 4/8 — Blast radius: 1, Pattern novelty: 1, Security: 0, Reversibility: 2

## Mission

Add two new popular code editor themes to the kb dashboard theme system: **Ayu** (based on https://github.com/dempfi/ayu) and **One Dark** (based on https://plugins.jetbrains.com/plugin/11938-one-dark-theme / Atom's One Dark). These themes provide users with familiar, high-quality color schemes commonly used in development environments.

The Ayu theme should include variants for both dark and light modes using its signature colors:
- Dark: dark blue-gray background (#0f1419) with cyan accents (#39bae6), orange (#f29718), and green (#b8cc52)
- Light: warm white background (#fafafa) with the same accent colors adjusted for light backgrounds

The One Dark theme is a dark-only theme featuring:
- Deep dark blue-gray background (#282c34) with blue accents (#61afef), green (#98c379), red (#e06c75), and cyan (#56b6c2)

## Dependencies

- **None**

## Context to Read First

1. `packages/core/src/types.ts` — Review `COLOR_THEMES` array and `ColorTheme` type definition
2. `packages/dashboard/app/hooks/useTheme.ts` — Understand how themes are validated and applied
3. `packages/dashboard/app/components/ThemeSelector.tsx` — Review the `COLOR_THEMES` array structure for UI display
4. `packages/dashboard/app/styles.css` — Study the existing theme CSS patterns (lines ~3300-4100), especially how `[data-color-theme="..."]` and `.theme-swatch-...` classes are defined

## File Scope

- `packages/core/src/types.ts` — Add "ayu" and "one-dark" to `COLOR_THEMES` array
- `packages/dashboard/app/hooks/useTheme.ts` — Add new themes to `validThemes` array
- `packages/dashboard/app/components/ThemeSelector.tsx` — Add theme entries to `COLOR_THEMES` UI array
- `packages/dashboard/app/styles.css` — Add CSS color variables and swatch styles for both themes
- `packages/dashboard/app/components/__tests__/ThemeSelector.test.tsx` — Update test to expect 10 themes instead of 8
- `packages/dashboard/app/hooks/__tests__/useTheme.test.ts` — Update test to include new themes

## Steps

### Step 1: Add Theme Types to Core

- [ ] Add "ayu" and "one-dark" to the `COLOR_THEMES` array in `packages/core/src/types.ts`
- [ ] Verify the `ColorTheme` type is automatically updated via `typeof COLOR_THEMES`
- [ ] Run `pnpm build` in `packages/core` to ensure types compile

**Artifacts:**
- `packages/core/src/types.ts` (modified)

### Step 2: Update Theme Hook Validation

- [ ] Add "ayu" and "one-dark" to the `validThemes` array in `packages/dashboard/app/hooks/useTheme.ts`
- [ ] Ensure the order matches the `COLOR_THEMES` array for consistency

**Artifacts:**
- `packages/dashboard/app/hooks/useTheme.ts` (modified)

### Step 3: Add Theme Selector UI Entries

- [ ] Add two new entries to the `COLOR_THEMES` array in `packages/dashboard/app/components/ThemeSelector.tsx`:
  - `{ value: "ayu", label: "Ayu", className: "theme-swatch-ayu" }`
  - `{ value: "one-dark", label: "One Dark", className: "theme-swatch-one-dark" }`
- [ ] Position Ayu between "solarized" and "one-dark" (alphabetical within the new themes)
- [ ] Position One Dark as the last entry

**Artifacts:**
- `packages/dashboard/app/components/ThemeSelector.tsx` (modified)

### Step 4: Implement CSS Theme Variables

- [ ] Add `[data-color-theme="ayu"]` dark mode styles to `packages/dashboard/app/styles.css`:
  - Background: `--bg: #0f1419; --surface: #131d27; --card: #1a2634; --card-hover: #232d3b; --border: #304357;`
  - Text: `--text: #bfbdb6; --text-muted: #565b66; --text-dim: #4d5666;`
  - Accents: `--todo: #39bae6; --in-progress: #ffb454; --in-review: #7ee787; --triage: #f2966b; --done: #6c7986;`
  - Feedback: `--color-success: #7ee787; --color-error: #f07178;`
  - Shadow: `--shadow: 0 4px 24px rgba(0, 0, 0, 0.5);`

- [ ] Add `[data-color-theme="ayu"][data-theme="light"]` light mode styles:
  - Background: `--bg: #fafafa; --surface: #f3f3f3; --card: #ffffff; --card-hover: #f0f0f0; --border: #e0e0e0;`
  - Text: `--text: #5c6166; --text-muted: #8a9199; --text-dim: #a0a0a0;`
  - Accents: `--todo: #007acc; --in-progress: #ff8f40; --in-review: #86b300; --triage: #fa8d3e; --done: #8a9199;`
  - Feedback: `--color-success: #86b300; --color-error: #f07178;`
  - Shadow: `--shadow: 0 4px 24px rgba(0, 0, 0, 0.15);`

- [ ] Add `[data-color-theme="one-dark"]` dark mode styles (One Dark has no light variant):
  - Background: `--bg: #282c34; --surface: #21252b; --card: #2c313a; --card-hover: #353b45; --border: #3e4451;`
  - Text: `--text: #abb2bf; --text-muted: #636d83; --text-dim: #5c6370;`
  - Accents: `--todo: #61afef; --in-progress: #c678dd; --in-review: #98c379; --triage: #e5c07b; --done: #828997;`
  - Feedback: `--color-success: #98c379; --color-error: #e06c75;`
  - Shadow: `--shadow: 0 4px 24px rgba(0, 0, 0, 0.5);`

- [ ] Add `.theme-swatch-ayu` class with swatch colors:
  ```css
  .theme-swatch-ayu {
    --bg: #0f1419;
    --surface: #131d27;
  }
  ```

- [ ] Add `.theme-swatch-one-dark` class with swatch colors:
  ```css
  .theme-swatch-one-dark {
    --bg: #282c34;
    --surface: #21252b;
  }
  ```

- [ ] Add light mode swatch override for Ayu:
  ```css
  [data-theme="light"] .theme-swatch-ayu {
    --bg: #fafafa;
    --surface: #f3f3f3;
  }
  ```

**Artifacts:**
- `packages/dashboard/app/styles.css` (modified)

### Step 5: Add Light Mode Button Overrides (if needed)

- [ ] Check if One Dark needs any light-mode-specific button overrides in the light theme section (copy pattern from existing themes if needed)
- [ ] Ayu light mode should follow the same button color pattern as other light themes

**Artifacts:**
- `packages/dashboard/app/styles.css` (modified, if needed)

### Step 6: Update Tests

- [ ] Update `packages/dashboard/app/components/__tests__/ThemeSelector.test.tsx`:
  - Change expected theme count from 8 to 10
  - Add assertions for "Ayu theme" and "One Dark theme" labels
  - Update `each color theme has a swatch` test to expect 10 options

- [ ] Update `packages/dashboard/app/hooks/__tests__/useTheme.test.ts`:
  - Add "ayu" and "one-dark" to the themes array in `supports all valid color themes` test
  - Ensure test passes with 10 themes total

**Artifacts:**
- `packages/dashboard/app/components/__tests__/ThemeSelector.test.tsx` (modified)
- `packages/dashboard/app/hooks/__tests__/useTheme.test.ts` (modified)

### Step 7: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm test` in `packages/dashboard` to verify all tests pass
- [ ] Run `pnpm test` in `packages/core` to verify type tests pass
- [ ] Run `pnpm build` at project root to ensure full build succeeds
- [ ] Manually verify themes appear in theme selector with correct swatches
- [ ] Verify Ayu dark mode colors render correctly
- [ ] Verify Ayu light mode colors render correctly  
- [ ] Verify One Dark colors render correctly
- [ ] Test theme persistence (refresh page after selecting each new theme)
- [ ] Test "Reset to defaults" button works correctly

### Step 8: Documentation & Delivery

- [ ] Create changeset file at `.changeset/add-ayu-one-dark-themes.md`:
  ```md
  ---
  "@dustinbyrne/kb": minor
  ---

  Add Ayu and One Dark color themes

  - Ayu: Popular code editor theme with dark and light variants
  - One Dark: Atom's iconic dark theme
  ```
- [ ] Verify no documentation files need updates (theme documentation is inline in code)

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing (`pnpm test` shows 0 failures)
- [ ] Build succeeds (`pnpm build` completes without errors)
- [ ] Both new themes render correctly in dark and light modes (Ayu has both, One Dark is dark-only)
- [ ] Theme selection persists across page reloads
- [ ] Reset to defaults works for both new themes

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-070): complete Step N — description`
- **Bug fixes:** `fix(KB-070): description`
- **Tests:** `test(KB-070): description`

## Do NOT

- Expand task scope (e.g., don't add more themes beyond Ayu and One Dark)
- Skip tests or test updates
- Modify theme implementation patterns without good reason
- Add runtime theme generation or dynamic theming
- Remove or modify existing themes
- Skip the changeset file creation (this is a user-facing feature)
