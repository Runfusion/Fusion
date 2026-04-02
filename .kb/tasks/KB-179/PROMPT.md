# Task: KB-179 - Move Search Bar Left of Board/List Toggle

**Created:** 2026-03-30
**Size:** S

## Review Level: 0 (None)

**Assessment:** Simple UI reordering with no logic changes. Moving existing component placement in the header from right-of-toggle to left-of-toggle.
**Score:** 2/8 — Blast radius: 0, Pattern novelty: 0, Security: 0, Reversibility: 2

## Mission

Rearrange the dashboard header so the search bar appears to the left of the board/list view toggle instead of to the right. This improves the visual hierarchy by placing the search (primary action for finding tasks) before the view switcher (secondary display preference).

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/components/Header.tsx` — The header component with the current element order
- `packages/dashboard/app/components/Header.test.tsx` — Existing tests for header functionality
- `packages/dashboard/app/styles.css` — Header and search styling (lines 93-117 for header layout, 180-217 for view-toggle, 220-256 for header-search)

## File Scope

- `packages/dashboard/app/components/Header.tsx` — Reorder elements in header-actions
- `packages/dashboard/app/styles.css` — Verify/adjust any layout spacing if needed

## Steps

### Step 1: Reorder Header Elements

- [ ] Move the Desktop Search block (`header-search` div for desktop) to appear BEFORE the View Toggle block (`view-toggle` div) in the JSX
- [ ] Move the Mobile Search block (mobile search trigger and expanded search) to appear BEFORE the View Toggle block
- [ ] Ensure the search conditional rendering (`onSearchChange && view === "board"`) remains intact
- [ ] Keep all existing props, event handlers, and accessibility attributes unchanged

**Current order in `header-actions`:**
1. View Toggle
2. Desktop Search
3. Mobile Search
4. Other action buttons

**New order in `header-actions`:**
1. Desktop Search (if `onSearchChange && view === "board" && !isMobile`)
2. Mobile Search (if `onSearchChange && view === "board" && isMobile`)
3. View Toggle (if `onChangeView`)
4. Other action buttons (unchanged)

**Artifacts:**
- `packages/dashboard/app/components/Header.tsx` (modified)

### Step 2: Visual Polish

- [ ] Verify the flex gap between search and toggle looks correct (should use existing `--space-sm` gap from `.header-actions`)
- [ ] Ensure mobile layout still works correctly with the reordered elements
- [ ] Test that mobile search expanded state doesn't overlap or interfere with the toggle

**Artifacts:**
- `packages/dashboard/app/styles.css` (modified if needed)

### Step 3: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run header-specific tests: `pnpm test -- packages/dashboard/app/components/Header.test.tsx`
- [ ] Run full dashboard test suite: `pnpm test -- packages/dashboard`
- [ ] Verify all existing search tests still pass (search rendering, onSearchChange calls, clear button behavior)
- [ ] Verify all view toggle tests still pass (active state, onChangeView calls, aria attributes)
- [ ] Build passes: `pnpm build`

### Step 4: Documentation & Delivery

- [ ] No documentation updates required (pure UI reordering)
- [ ] Create changeset: `fix-search-toggle-position.md` describing the visual improvement

## Documentation Requirements

**Must Update:**
- None

**Check If Affected:**
- `AGENTS.md` — Update if header layout patterns are documented (unlikely)

## Completion Criteria

- [ ] Search bar appears to the left of the board/list toggle in the header
- [ ] Desktop search only shows in board view (unchanged behavior)
- [ ] Mobile search trigger and expanded state work correctly
- [ ] All Header tests pass
- [ ] Full test suite passes
- [ ] Build passes
- [ ] Changeset created

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-179): complete Step N — description`
- **Bug fixes:** `fix(KB-179): description`
- **Tests:** `test(KB-179): description`

## Do NOT

- Change any search functionality or behavior
- Modify view toggle logic or styling
- Affect mobile overflow menu behavior
- Alter planning mode, terminal, or pause button functionality
- Skip tests or rely on manual verification alone
