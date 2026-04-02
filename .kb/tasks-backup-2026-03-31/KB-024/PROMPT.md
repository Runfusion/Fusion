# Task: KB-024 - Light Mode Toggle and Theme Selector

**Created:** 2026-03-30
**Size:** L

## Review Level: 2 (Plan and Code)

**Assessment:** This task touches multiple UI components, requires extending the Settings type in core, updating API endpoints, and creating a comprehensive theming system. The pattern of adding settings sections is well-established.
**Score:** 5/8 — Blast radius: 1, Pattern novelty: 1, Security: 2, Reversibility: 1

## Mission

Add a complete theming system to the kb dashboard with light/dark mode toggle and multiple attractive color themes. Users should be able to switch between light and dark modes and choose from at least 8 distinct color themes (default dark, light, ocean, forest, sunset, berry, monochrome, high-contrast). Theme preferences persist to localStorage and can optionally be synced to server settings. The implementation must maintain full backward compatibility with the existing dark theme as the default.

## Dependencies

- **None**

## Context to Read First

- `packages/core/src/types.ts` — Settings type definition, must extend with theme fields
- `packages/dashboard/app/styles.css` — All CSS variables are defined in `:root`
- `packages/dashboard/app/components/SettingsModal.tsx` — Pattern for adding new settings sections
- `packages/dashboard/app/App.tsx` — Shows how localStorage preferences are loaded/persisted
- `packages/dashboard/app/components/Header.tsx` — Header component where theme toggle will live
- `packages/dashboard/app/api.ts` — API functions for settings

## File Scope

- `packages/core/src/types.ts` — Extend Settings type with theme preferences
- `packages/dashboard/app/styles.css` — Refactor to support theme variants, add new theme color palettes
- `packages/dashboard/app/components/Header.tsx` — Add theme toggle button to header actions
- `packages/dashboard/app/components/SettingsModal.tsx` — Add "Appearance" section with theme selector
- `packages/dashboard/app/App.tsx` — Add theme state management and localStorage persistence
- `packages/dashboard/app/hooks/useTheme.ts` — New hook for theme management (create this file)
- `packages/dashboard/app/components/ThemeSelector.tsx` — New component for theme selection UI (create this file)
- `packages/dashboard/app/components/__tests__/ThemeSelector.test.tsx` — Tests for theme selector
- `packages/dashboard/app/hooks/__tests__/useTheme.test.ts` — Tests for theme hook

## Steps

### Step 1: Core Types Extension

Extend the Settings type to include theme preferences.

- [ ] Add `ThemeMode` type: `"dark" | "light" | "system"`
- [ ] Add `ColorTheme` type with at least 8 theme options: `"default" | "ocean" | "forest" | "sunset" | "berry" | "monochrome" | "high-contrast" | "solarized"`
- [ ] Extend `Settings` interface with `themeMode?: ThemeMode` and `colorTheme?: ColorTheme`
- [ ] Update `DEFAULT_SETTINGS` to include `themeMode: "dark"` and `colorTheme: "default"`
- [ ] Export new types from `packages/core/src/index.ts`
- [ ] Run typecheck to verify no TypeScript errors

**Artifacts:**
- `packages/core/src/types.ts` (modified)
- `packages/core/src/index.ts` (modified)

### Step 2: Theme System Hook

Create a custom hook for theme management that handles localStorage persistence and theme application.

- [ ] Create `useTheme.ts` hook with:
  - State for `themeMode` and `colorTheme`
  - localStorage persistence (keys: `kb-dashboard-theme-mode`, `kb-dashboard-color-theme`)
  - System preference detection for "system" mode using `prefers-color-scheme`
  - `applyTheme()` function that sets `data-theme` and `data-color-theme` attributes on document.documentElement
  - `setThemeMode()` and `setColorTheme()` setter functions
- [ ] Handle "system" mode by listening to `prefers-color-scheme` changes
- [ ] Initialize from localStorage on mount, fallback to "dark"/"default"
- [ ] Write unit tests for `useTheme` hook covering:
  - Initial state from localStorage
  - Theme mode changes
  - Color theme changes
  - System preference detection

**Artifacts:**
- `packages/dashboard/app/hooks/useTheme.ts` (new)
- `packages/dashboard/app/hooks/__tests__/useTheme.test.ts` (new)

### Step 3: CSS Theme Architecture

Refactor styles.css to support multiple themes using CSS custom properties and data attributes.

- [ ] Keep existing `:root` as the dark default theme base
- [ ] Create `[data-theme="light"]` override section with light mode color palette
- [ ] Create `[data-color-theme="ocean"]` through `[data-color-theme="solarized"]` sections with unique color palettes for each theme
- [ ] Each color theme must define:
  - `--bg`: background color
  - `--surface`: surface/card background
  - `--card`: card background
  - `--card-hover`: hover state
  - `--border`: border color
  - `--text`: primary text
  - `--text-muted`: secondary text
  - `--text-dim`: tertiary text
  - `--triage`, `--todo`, `--in-progress`, `--in-review`, `--done`: status colors
  - `--color-success`, `--color-error`: feedback colors
- [ ] Ensure light mode inverts appropriately (dark text on light backgrounds)
- [ ] Add smooth transitions for theme changes: `transition: background-color 0.2s ease, color 0.2s ease`
- [ ] Verify all existing components render correctly with each theme

**Theme Specifications:**
- **default** (dark): Current dark theme, GitHub-inspired
- **light**: Light backgrounds (#ffffff, #f6f8fa), dark text (#1f2328, #656d76), blue accents
- **ocean**: Deep blues (#0a1929, #132f4c), cyan accents (#00b8d4), teal status colors
- **forest**: Deep greens (#0d2818, #1a472a), emerald accents (#34d399), natural status colors
- **sunset**: Warm oranges/reds (#2d1f1f, #4a2c2c), amber accents (#ffab00), warm status colors
- **berry**: Purple/pink tones (#1a0b2e, #2d1b4e), magenta accents (#e040fb), berry status colors
- **monochrome**: Pure grays (#0d0d0d, #1a1a1a), white accents, grayscale status colors
- **high-contrast**: Extreme contrast (#000000, #ffffff), vivid accent colors for accessibility
- **solarized**: Classic solarized palette (base03 #002b36, base0 #839496, accent colors)

**Artifacts:**
- `packages/dashboard/app/styles.css` (modified)

### Step 4: Theme Selector Component

Create a reusable theme selector component.

- [ ] Create `ThemeSelector.tsx` with:
  - Theme mode toggle (Light / Dark / System)
  - Color theme grid/picker showing all 8+ themes
  - Visual previews for each theme (mini color swatches)
  - Active state highlighting for selected theme
- [ ] Use Lucide icons: `Sun`, `Moon`, `Monitor` for mode toggle
- [ ] Implement accessible controls with proper ARIA labels
- [ ] Write unit tests for component rendering and interaction

**Artifacts:**
- `packages/dashboard/app/components/ThemeSelector.tsx` (new)
- `packages/dashboard/app/components/__tests__/ThemeSelector.test.tsx` (new)

### Step 5: Header Toggle Integration

Add a quick-access theme toggle to the header.

- [ ] Add theme toggle button to `Header.tsx` in `header-actions` section
- [ ] Button should cycle through: Dark → Light → System → Dark
- [ ] Show appropriate icon: `Moon` for dark, `Sun` for light, `Monitor` for system
- [ ] Add tooltip: "Toggle theme (Dark/Light/System)"
- [ ] Update `Header.test.tsx` to include theme toggle tests
- [ ] Ensure toggle updates theme immediately via `useTheme` hook

**Artifacts:**
- `packages/dashboard/app/components/Header.tsx` (modified)
- `packages/dashboard/app/components/__tests__/Header.test.tsx` (modified)

### Step 6: Settings Modal Integration

Add a comprehensive Appearance section to SettingsModal.

- [ ] Add "appearance" to `SETTINGS_SECTIONS` array
- [ ] Implement `renderSectionFields()` case for "appearance" section
- [ ] Include `ThemeSelector` component in the appearance section
- [ ] Show current theme preview in the settings panel
- [ ] Add "Reset to defaults" button in appearance section
- [ ] Settings should auto-save (no "Save" button required for theme) or integrate with existing save flow
- [ ] Update `SettingsModal.test.tsx` if needed for new section

**Artifacts:**
- `packages/dashboard/app/components/SettingsModal.tsx` (modified)

### Step 7: App Integration

Integrate theme system into the main App component.

- [ ] Import and use `useTheme` hook in `AppInner`
- [ ] Call `applyTheme()` on mount and when theme changes
- [ ] Pass theme state/setters down to child components that need them (or use the hook directly in children)
- [ ] Ensure theme is applied before first render to prevent flash of wrong theme
  - Consider adding a small inline script in `index.html` or using `useLayoutEffect`
- [ ] Verify theme persists across page reloads

**Artifacts:**
- `packages/dashboard/app/App.tsx` (modified)

### Step 8: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm test` in `packages/dashboard` - all tests must pass
- [ ] Run `pnpm test` in `packages/core` - all tests must pass
- [ ] Run `pnpm build` - build must succeed without errors
- [ ] Manual verification checklist:
  - [ ] Theme toggle in header works (cycles Dark → Light → System)
  - [ ] All 8+ color themes render correctly
  - [ ] Light mode text is readable on all backgrounds
  - [ ] Dark mode maintains original appearance
  - [ ] System mode respects OS preference
  - [ ] Settings modal appearance section works
  - [ ] Theme persists after page reload
  - [ ] No visual glitches during theme transitions
  - [ ] Modal, cards, and all UI components work in all themes

### Step 9: Documentation & Delivery

- [ ] Update `packages/dashboard/README.md` with theming documentation
  - List available themes
  - Explain theme persistence
  - Document how to add new themes
- [ ] Create changeset for the new feature (minor bump):
  ```bash
  cat > .changeset/theme-system.md << 'EOF'
  ---
  "@dustinbyrne/kb": minor
  ---
  
  Add light mode toggle and theme selector with 8+ attractive color themes
  EOF
  ```
- [ ] Commit with message: `feat(KB-024): complete Step 9 — add theming documentation and changeset`

## Documentation Requirements

**Must Update:**
- `packages/dashboard/README.md` — Add "Theming" section documenting available themes and how to use them

**Check If Affected:**
- `AGENTS.md` — Update if this affects dashboard development guidelines

## Completion Criteria

- [ ] All 9 steps complete
- [ ] All tests passing (`pnpm test` in dashboard and core)
- [ ] Build passes (`pnpm build`)
- [ ] 8+ attractive color themes implemented and working
- [ ] Light/dark/system mode toggle working in header
- [ ] Appearance section in settings modal
- [ ] Theme preferences persist to localStorage
- [ ] No visual regressions in existing dark default theme
- [ ] Documentation updated

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-024): complete Step N — description`
- **Bug fixes:** `fix(KB-024): description`
- **Tests:** `test(KB-024): description`

## Do NOT

- Use Tailwind CSS or other CSS frameworks — the project uses vanilla CSS
- Modify the core scheduling or task execution logic
- Break existing dark theme as the default experience
- Add external theme libraries — implement custom solution
- Skip accessibility considerations (proper ARIA labels, keyboard navigation)
- Forget to test all themes with all UI components (modals, cards, dropdowns)
- Use `!important` in CSS unless absolutely necessary for overrides
