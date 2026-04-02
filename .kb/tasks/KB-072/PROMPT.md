# Task: KB-072 - Comprehensive Theme System with Full Layout Customization

**Created:** 2026-03-30
**Size:** L

## Review Level: 3 (Full)

**Assessment:** This is a major architectural expansion of the theming system, transforming it from color-only CSS variables to a comprehensive design token system that controls layout, typography, spacing, and component styling. It introduces a new theme tier ("design themes") while maintaining backward compatibility with existing color themes. The Factory theme demonstrates the new capabilities with industrial sci-fi aesthetics.

**Score:** 7/8 — Blast radius: 2 (touches core types, hooks, CSS, and components), Pattern novelty: 2 (new design token architecture), Security: 1 (CSS injection vectors must be validated), Reversibility: 2 (can revert to color themes)

## Mission

Transform the kb dashboard theming system from a color-only scheme to a comprehensive design token system that can control every aspect of the UI: fonts, spacing, border radius, button styles, shadows, animations, and layout properties.

The current system has "color themes" that only change CSS color variables. This task introduces "design themes" that can override any CSS property through an expanded token system. As proof of concept, implement a "Factory" theme inspired by factorydroid.ai's industrial mission-control aesthetic — featuring monospace fonts, sharp corners, amber warning accents, and industrial status indicators.

Key architectural changes:
1. Expand `ColorTheme` concept to support comprehensive design tokens
2. Add font family variables (`--font-primary`, `--font-mono`)
3. Add spacing/radius tokens (`--radius-sm`, `--radius-md`, `--radius-lg`, `--radius-xl`)
4. Add component-specific tokens (button padding, border widths, shadow styles)
5. Maintain backward compatibility — existing color themes continue to work
6. Add Factory design theme as the first comprehensive theme example

## Dependencies

- **None**

## Context to Read First

1. `packages/core/src/types.ts` — Review `COLOR_THEMES` array and `ColorTheme` type (lines 12-19)
2. `packages/dashboard/app/hooks/useTheme.ts` — Understand theme validation and `validThemes` array
3. `packages/dashboard/app/components/ThemeSelector.tsx` — Review how themes are displayed and selected
4. `packages/dashboard/app/styles.css` — Study CSS variable architecture (lines 1-100 for base tokens, lines 3300-4100 for theme overrides)
5. `packages/dashboard/app/index.html` — Review theme initialization script that prevents flash of wrong theme

## File Scope

- `packages/core/src/types.ts` — Expand theme types to support design tokens
- `packages/dashboard/app/hooks/useTheme.ts` — Update validation and storage keys
- `packages/dashboard/app/hooks/__tests__/useTheme.test.ts` — Update tests for expanded themes
- `packages/dashboard/app/components/ThemeSelector.tsx` — Add Factory theme entry
- `packages/dashboard/app/components/__tests__/ThemeSelector.test.tsx` — Update tests
- `packages/dashboard/app/styles.css` — Add comprehensive design token architecture and Factory theme
- `packages/dashboard/app/index.html` — Update theme init script to handle design themes

## Steps

### Step 1: Expand Core Types for Design Themes

Extend the theme system to support "design themes" that can configure more than just colors.

- [ ] Add `"factory"` to the `COLOR_THEMES` array in `packages/core/src/types.ts` (line 14-21)
- [ ] Run `pnpm build` in `packages/core` to verify types compile
- [ ] Verify `ColorTheme` type automatically includes "factory" via `typeof`

**Artifacts:**
- `packages/dashboard/core/src/types.ts` (modified)

### Step 2: Update Theme Hook for Design Theme Support

Update the useTheme hook to recognize the Factory theme and set up CSS variable structure.

- [ ] Add `"factory"` to the `validThemes` array in `packages/dashboard/app/hooks/useTheme.ts` (line 22)
- [ ] Update `getThemeInitScript()` function to include "factory" in the default theme fallback
- [ ] Verify localStorage keys remain the same (backward compatible)

**Artifacts:**
- `packages/dashboard/app/hooks/useTheme.ts` (modified)

### Step 3: Implement Comprehensive Design Token Architecture

Add a new layer of CSS variables that controls layout, typography, and component styling. This sits on top of the existing color system.

Add to `packages/dashboard/app/styles.css` after the reset section (around line 15, before the `:root` color definitions):

```css
/* === Design Tokens (Theme-Agnostic Defaults) === */
:root {
  /* Typography */
  --font-primary: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
  --font-mono: "SF Mono", Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  
  /* Spacing Scale */
  --space-xs: 4px;
  --space-sm: 8px;
  --space-md: 12px;
  --space-lg: 16px;
  --space-xl: 24px;
  --space-2xl: 32px;
  
  /* Border Radius Scale */
  --radius-sm: 4px;
  --radius-md: 8px;
  --radius-lg: 12px;
  --radius-xl: 16px;
  
  /* Component-specific tokens */
  --btn-padding: 8px 16px;
  --btn-border-width: 1px;
  --card-padding: 10px 12px;
  --modal-padding: 16px 20px;
  --header-padding: 12px 24px;
  --column-gap: 12px;
  --board-padding: 16px 24px;
  
  /* Shadow tokens */
  --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.1);
  --shadow-md: 0 4px 6px rgba(0, 0, 0, 0.1);
  --shadow-lg: 0 4px 24px rgba(0, 0, 0, 0.4);
  --shadow-glow: 0 0 8px rgba(88, 166, 255, 0.3);
  
  /* Animation tokens */
  --transition-instant: 0.1s ease;
  --transition-fast: 0.15s ease;
  --transition-normal: 0.2s ease;
  --transition-slow: 0.3s ease;
}
```

Then update existing CSS to use these tokens:
- [ ] Replace hardcoded `8px` border-radius values with `var(--radius-md)` in `.btn`, `.card`, `.modal`, etc.
- [ ] Replace hardcoded `12px` border-radius values with `var(--radius-lg)` in `.column`
- [ ] Replace `font-family` declarations with `var(--font-primary)` or `var(--font-mono)` where appropriate
- [ ] Replace shadow values with token references
- [ ] Replace transition values with token references

**Key files to update in styles.css:**
- Line ~9: `:root` section - keep colors, add tokens above
- Line ~25: `html, body` - use `--font-primary`
- Line ~38: `.header` - use `--header-padding`
- Line ~76: `.btn` - use `--btn-padding`, `--radius-md`
- Line ~95: `.btn-primary` - use `--shadow-glow` for hover
- Line ~142: `.column` - use `--radius-lg`
- Line ~190: `.card` - use `--radius-md`, `--card-padding`
- Line ~270: `.modal` - use `--radius-lg`, `--modal-padding`

**Artifacts:**
- `packages/dashboard/app/styles.css` (modified)

### Step 4: Create Factory Design Theme

Implement the Factory theme with industrial sci-fi aesthetics from factorydroid.ai. This theme overrides design tokens, not just colors.

Add to `packages/dashboard/app/styles.css` in the color themes section (after solarized, around line 4100):

```css
/* FACTORY - Industrial Mission Control Theme
   A comprehensive design theme that overrides fonts, spacing, and 
   component styling for an industrial sci-fi aesthetic.
   Inspired by factorydroid.ai Mission Control interface.
*/

/* Factory Dark Mode */
[data-color-theme="factory"] {
  /* Industrial Backgrounds */
  --bg: #0a0a0a;
  --surface: #111111;
  --card: #1a1a1a;
  --card-hover: #222222;
  --border: #333333;
  
  /* High-contrast Terminal Text */
  --text: #e5e5e5;
  --text-muted: #888888;
  --text-dim: #555555;
  
  /* Amber Warning Light Accents (industrial status) */
  --todo: #f59e0b;          /* Amber - active/warning */
  --in-progress: #06b6d4;   /* Cyan - processing */
  --in-review: #22c55e;     /* Green - OK/clear */
  --triage: #ef4444;        /* Red - alert/error */
  --done: #6b7280;          /* Gray - inactive */
  
  /* Feedback Colors */
  --color-success: #22c55e;
  --color-error: #ef4444;
  --color-muted: #6b7280;
  
  /* Industrial Typography - Monospace for terminal feel */
  --font-primary: "SF Mono", "JetBrains Mono", "Fira Code", Monaco, Consolas, monospace;
  --font-mono: "SF Mono", "JetBrains Mono", "Fira Code", Monaco, Consolas, monospace;
  
  /* Sharp Corners - Industrial aesthetic */
  --radius-sm: 2px;
  --radius-md: 4px;
  --radius-lg: 6px;
  --radius-xl: 8px;
  
  /* Tighter Spacing - Compact mission control layout */
  --space-xs: 2px;
  --space-sm: 4px;
  --space-md: 8px;
  --space-lg: 12px;
  --space-xl: 16px;
  --space-2xl: 24px;
  
  /* Industrial Button Styling */
  --btn-padding: 6px 12px;
  --btn-border-width: 2px;
  --card-padding: 8px 10px;
  --modal-padding: 12px 16px;
  --header-padding: 8px 16px;
  --column-gap: 8px;
  --board-padding: 12px 16px;
  
  /* Sharp Industrial Shadows */
  --shadow-sm: 0 1px 1px rgba(0, 0, 0, 0.5);
  --shadow-md: 0 2px 4px rgba(0, 0, 0, 0.5);
  --shadow-lg: 0 4px 12px rgba(0, 0, 0, 0.6);
  --shadow-glow: 0 0 6px rgba(245, 158, 11, 0.4);
  
  /* Snappy Industrial Animations */
  --transition-instant: 0.05s ease;
  --transition-fast: 0.1s ease;
  --transition-normal: 0.15s ease;
  --transition-slow: 0.2s ease;
}

/* Factory Light Mode (Inverted Industrial) */
[data-color-theme="factory"][data-theme="light"] {
  /* Light Industrial Backgrounds */
  --bg: #f5f5f5;
  --surface: #ffffff;
  --card: #fafafa;
  --card-hover: #f0f0f0;
  --border: #d4d4d4;
  
  /* Dark Text for contrast */
  --text: #1a1a1a;
  --text-muted: #666666;
  --text-dim: #999999;
  
  /* Adjusted Amber for light backgrounds */
  --todo: #d97706;          /* Darker amber */
  --in-progress: #0891b2;   /* Darker cyan */
  --in-review: #16a34a;     /* Darker green */
  --triage: #dc2626;        /* Darker red */
  --done: #4b5563;          /* Darker gray */
  
  /* Feedback Colors */
  --color-success: #16a34a;
  --color-error: #dc2626;
  --color-muted: #6b7280;
  
  /* Lighter shadows for light mode */
  --shadow-sm: 0 1px 1px rgba(0, 0, 0, 0.1);
  --shadow-md: 0 2px 4px rgba(0, 0, 0, 0.1);
  --shadow-lg: 0 4px 12px rgba(0, 0, 0, 0.15);
  --shadow-glow: 0 0 6px rgba(217, 119, 6, 0.3);
}

/* Factory Theme Swatch */
.theme-swatch-factory {
  --bg: #0a0a0a;
  --surface: #111111;
}

[data-theme="light"] .theme-swatch-factory {
  --bg: #f5f5f5;
  --surface: #ffffff;
}

/* Factory-specific agent glow animation */
[data-color-theme="factory"] .card.agent-active {
  border-color: var(--todo);
  box-shadow:
    0 0 6px rgba(245, 158, 11, 0.5),
    0 0 12px rgba(245, 158, 11, 0.2);
  animation: agent-glow-factory 2s ease-in-out infinite;
}

@keyframes agent-glow-factory {
  0%, 100% {
    box-shadow:
      0 0 6px rgba(245, 158, 11, 0.5),
      0 0 12px rgba(245, 158, 11, 0.2);
  }
  50% {
    box-shadow:
      0 0 10px rgba(245, 158, 11, 0.7),
      0 0 20px rgba(245, 158, 11, 0.4);
  }
}

/* Factory light theme agent glow */
[data-color-theme="factory"][data-theme="light"] .card.agent-active {
  box-shadow:
    0 0 6px rgba(217, 119, 6, 0.4),
    0 0 12px rgba(217, 119, 6, 0.15);
  animation: agent-glow-factory-light 2s ease-in-out infinite;
}

@keyframes agent-glow-factory-light {
  0%, 100% {
    box-shadow:
      0 0 6px rgba(217, 119, 6, 0.4),
      0 0 12px rgba(217, 119, 6, 0.15);
  }
  50% {
    box-shadow:
      0 0 10px rgba(217, 119, 6, 0.6),
      0 0 20px rgba(217, 119, 6, 0.3);
  }
}

/* Factory-specific button styling overrides */
[data-color-theme="factory"] .btn {
  text-transform: uppercase;
  letter-spacing: 0.05em;
  font-weight: 600;
  border-width: 2px;
}

[data-color-theme="factory"] .btn-primary {
  background: transparent;
  border-color: var(--todo);
  color: var(--todo);
  box-shadow: none;
}

[data-color-theme="factory"] .btn-primary:hover {
  background: var(--todo);
  color: var(--bg);
  box-shadow: 0 0 8px rgba(245, 158, 11, 0.4);
}

[data-color-theme="factory"][data-theme="light"] .btn-primary:hover {
  box-shadow: 0 0 8px rgba(217, 119, 6, 0.3);
}

/* Factory theme card styling */
[data-color-theme="factory"] .card {
  border-width: 2px;
}

[data-color-theme="factory"] .column {
  border-width: 2px;
}

/* Factory theme column header - industrial label style */
[data-color-theme="factory"] .column-header h2 {
  text-transform: uppercase;
  letter-spacing: 0.1em;
  font-size: 12px;
}

/* Factory theme status badges */
[data-color-theme="factory"] .column-count {
  font-family: var(--font-mono);
  font-weight: 700;
}

[data-color-theme="factory"] .card-id {
  font-weight: 700;
}
```

**Artifacts:**
- `packages/dashboard/app/styles.css` (modified)

### Step 5: Update Theme Selector Component

Add Factory theme to the UI so users can select it.

- [ ] Add Factory entry to `COLOR_THEMES` array in `packages/dashboard/app/components/ThemeSelector.tsx`:
  ```typescript
  { value: "factory", label: "Factory", className: "theme-swatch-factory" }
  ```
- [ ] Position Factory after "solarized" (alphabetical within themes)

**Artifacts:**
- `packages/dashboard/app/components/ThemeSelector.tsx` (modified)

### Step 6: Update Theme Initialization Script

Update the inline script in index.html to recognize the Factory theme.

- [ ] Update the theme init script in `packages/dashboard/app/index.html` to include "factory" in default fallbacks:
  ```javascript
  var colorTheme = localStorage.getItem('kb-dashboard-color-theme') || 'default';
  // Validate theme to prevent flash of broken theme
  var validThemes = ['default', 'ocean', 'forest', 'sunset', 'berry', 'monochrome', 'high-contrast', 'solarized', 'factory'];
  if (!validThemes.includes(colorTheme)) {
    colorTheme = 'default';
  }
  ```

**Artifacts:**
- `packages/dashboard/app/index.html` (modified)

### Step 7: Update Tests

Update all tests to account for the new theme and expanded token system.

- [ ] Update `packages/dashboard/app/components/__tests__/ThemeSelector.test.tsx`:
  - Change expected theme count from 8 to 9
  - Add assertion for "Factory theme" label
  - Update `each color theme has a swatch` test to expect 9 options

- [ ] Update `packages/dashboard/app/hooks/__tests__/useTheme.test.ts`:
  - Add "factory" to the themes array in `supports all valid color themes` test
  - Ensure test passes with 9 themes total
  - Add test for Factory theme's design token application (verify document attributes)

**Artifacts:**
- `packages/dashboard/app/components/__tests__/ThemeSelector.test.tsx` (modified)
- `packages/dashboard/app/hooks/__tests__/useTheme.test.ts` (modified)

### Step 8: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm test` in `packages/dashboard` to verify all tests pass
- [ ] Run `pnpm test` in `packages/core` to verify type tests pass
- [ ] Run `pnpm build` at project root to ensure full build succeeds
- [ ] Manually verify Factory theme appears in theme selector with correct swatch
- [ ] Verify Factory dark mode renders with:
  - Monospace font family
  - Sharp corners (small border radius)
  - Tighter spacing
  - Amber/cyan/green status colors
  - Uppercase button labels
- [ ] Verify Factory light mode renders correctly with inverted colors
- [ ] Verify existing themes (default, ocean, etc.) still work correctly
- [ ] Test theme persistence (refresh page after selecting Factory theme)
- [ ] Test "Reset to defaults" button works for Factory theme
- [ ] Verify smooth theme transitions work (colors animate when switching)

### Step 9: Documentation & Delivery

- [ ] Create changeset file at `.changeset/add-comprehensive-theme-system.md`:
  ```md
  ---
  "@dustinbyrne/kb": minor
  ---

  Add comprehensive design theme system with Factory theme

  - Expanded theme system to support design tokens beyond colors:
    - Typography (font families)
    - Spacing scale
    - Border radius scale
    - Component-specific styling
    - Shadow and animation tokens
  - Added new "Factory" design theme with industrial sci-fi aesthetic:
    - Monospace fonts for terminal feel
    - Sharp corners and compact spacing
    - Amber/cyan/green status indicators
    - Industrial button styling
  - All existing color themes remain compatible
  ```

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing (`pnpm test` shows 0 failures)
- [ ] Build succeeds (`pnpm build` completes without errors)
- [ ] Factory theme renders correctly in both dark and light modes
- [ ] Factory theme demonstrates comprehensive token overrides (fonts, spacing, radius)
- [ ] Existing color themes continue to work unchanged
- [ ] Theme selection persists across page reloads
- [ ] Reset to defaults works for Factory theme
- [ ] Design tokens (fonts, radius, spacing) work correctly in Factory theme
- [ ] No visual regressions in existing themes

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-072): complete Step N — description`
- **Bug fixes:** `fix(KB-072): description`
- **Tests:** `test(KB-072): description`

## Do NOT

- Remove or modify existing color themes
- Break backward compatibility with existing themes
- Add runtime theme generation or dynamic theming
- Skip tests or test updates
- Skip the changeset file creation (this is a user-facing feature)
- Hardcode Factory-specific values in shared components
- Modify theme implementation patterns without updating all themes
