# Task: FN-672 - Fix mobile layout for project selector and all projects links

**Created:** 2026-04-01
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** This is a straightforward UI layout fix. The ProjectSelector component exists but needs to be integrated into the Header and styled for mobile. Low blast radius, no security concerns, easily reversible.
**Score:** 2/8 — Blast radius: 0, Pattern novelty: 1, Security: 0, Reversibility: 1

## Mission

The dashboard's project selector and "View All Projects" link currently don't render well on mobile devices because:
1. The ProjectSelector component lacks CSS styles entirely
2. When integrated, it crowds the header actions on narrow screens
3. The "View All Projects" button in the ProjectSelector dropdown adds to the layout problem

Fix this by:
1. Adding proper CSS styles for the ProjectSelector component
2. Integrating ProjectSelector into the Header component
3. On mobile (≤768px), placing the project selector on a new row below the main header actions

This ensures the header remains usable on mobile while providing clear project context and navigation.

## Dependencies

- **Task:** KB-502 (Dashboard Multi-Project UX: Overview page, drill-down, and setup wizard) — provides the ProjectSelector component and multi-project hooks

## Context to Read First

- `packages/dashboard/app/components/Header.tsx` — understand current header structure and mobile handling
- `packages/dashboard/app/components/ProjectSelector.tsx` — the component to integrate (already exists, uses BEM class names)
- `packages/dashboard/app/styles.css` — find mobile breakpoint styles (line ~2708 for @media (max-width: 768px))
- `packages/dashboard/app/hooks/useProjects.ts` — hook to fetch projects list
- `packages/dashboard/app/hooks/useCurrentProject.ts` — hook to manage current project selection
- `packages/dashboard/app/App.tsx` — see how Header is currently used and where project data flows

## File Scope

- `packages/dashboard/app/components/Header.tsx` — add ProjectSelector integration and mobile row layout
- `packages/dashboard/app/styles.css` — add project-selector CSS styles and mobile header-row styles
- `packages/dashboard/app/App.tsx` — pass project data to Header component

## Steps

### Step 1: Add ProjectSelector CSS Styles

- [ ] Add comprehensive CSS for `.project-selector` and child elements in `styles.css`
- [ ] Include styles for: trigger button, dropdown, search input, project items, status icons, "View All" footer
- [ ] Match existing dashboard design tokens (colors, spacing, border-radius)
- [ ] Add mobile-specific styles for the selector when on header-row-mobile

**Artifacts:**
- `packages/dashboard/app/styles.css` (modified) — new project-selector CSS section

### Step 2: Integrate ProjectSelector into Header

- [ ] Import `ProjectSelector` into Header.tsx
- [ ] Import `useProjects` and `useCurrentProject` hooks (or accept as props)
- [ ] Add `projects`, `currentProject`, `onSelectProject`, `onViewAllProjects` props to Header
- [ ] Place ProjectSelector in the header layout between `header-left` and `header-actions`
- [ ] Conditionally render ProjectSelector only when `projects.length > 1`
- [ ] Connect `onViewAll` to navigate to projects overview

**Artifacts:**
- `packages/dashboard/app/components/Header.tsx` (modified)

### Step 3: Implement Mobile Two-Row Header Layout

- [ ] Modify header structure: wrap existing content in `.header-row--top`
- [ ] Add `.header-row--bottom` for mobile that contains ProjectSelector
- [ ] Use `useIsMobile()` hook to conditionally render the two-row layout
- [ ] On mobile: show ProjectSelector in bottom row, hide from top row
- [ ] On desktop: keep single-row layout with ProjectSelector inline
- [ ] Update CSS to support `.header--multi-row` variant with flex-direction: column

**Artifacts:**
- `packages/dashboard/app/components/Header.tsx` (modified)
- `packages/dashboard/app/styles.css` (modified) — header row modifiers

### Step 4: Update App.tsx to Pass Project Data

- [ ] Import `useProjects` and `useCurrentProject` in App.tsx
- [ ] Call hooks to get projects list and current project state
- [ ] Pass `projects`, `currentProject`, `setCurrentProject`, and navigation handler to Header
- [ ] Handle "View All Projects" navigation (can set a view state or open ProjectOverview modal)

**Artifacts:**
- `packages/dashboard/app/App.tsx` (modified)

### Step 5: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full test suite: `pnpm test`
- [ ] Verify existing Header tests pass
- [ ] Manually test on mobile viewport (≤768px width):
  - [ ] Project selector appears on second row
  - [ ] Header actions remain accessible
  - [ ] Dropdown opens/closes properly
  - [ ] "View All Projects" link works
- [ ] Manually test on desktop viewport (>768px):
  - [ ] Single-row layout maintained
  - [ ] Project selector inline with header actions
  - [ ] No layout regressions
- [ ] Build passes: `pnpm build`

### Step 6: Documentation & Delivery

- [ ] Update relevant component docs if any exist for Header
- [ ] Out-of-scope findings created as new tasks via `task_create` tool:
  - Any additional mobile header improvements beyond this scope
  - ProjectOverview modal integration if not yet complete

## Documentation Requirements

**Must Update:**
- None (code changes are self-documenting via component structure)

**Check If Affected:**
- `AGENTS.md` — check if dashboard component patterns section needs mobile layout guidance

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Project selector renders correctly on both mobile and desktop
- [ ] Mobile header has two rows: top with actions, bottom with project selector
- [ ] "View All Projects" link accessible from selector dropdown
- [ ] Build passes

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(FN-672): complete Step N — description`
- **Bug fixes:** `fix(FN-672): description`
- **Tests:** `test(FN-672): description`

## Do NOT

- Expand task scope beyond mobile layout fix for project selector
- Modify ProjectSelector component internal logic (it's already functional)
- Skip visual testing on actual mobile viewport sizes
- Add new dependencies or packages
- Change the existing desktop header layout beyond adding the selector inline
