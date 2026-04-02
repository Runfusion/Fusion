# Task: KB-194 - Add Collapsible Sections to List View

**Created:** 2026-03-30
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** This is a focused UI enhancement adding section collapse/expand to the list view. Uses existing patterns (localStorage persistence, ChevronDown icon) and CSS classes already in the codebase. No API changes or security implications.
**Score:** 3/8 — Blast radius: 1, Pattern novelty: 0, Security: 0, Reversibility: 2

## Mission

Add collapsible section headers to the dashboard list view, allowing users to expand/collapse individual column sections (triage, todo, in-progress, in-review, done, archived). Persist collapse state to localStorage so preferences survive page reloads. This improves information density and lets users focus on relevant sections.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/components/ListView.tsx` — The list view component with existing section headers
- `packages/dashboard/app/components/TaskCard.tsx` — Reference for ChevronDown toggle pattern (search for `showSteps`, `ChevronDown`)
- `packages/dashboard/app/components/__tests__/ListView.test.tsx` — Existing test patterns for list view
- `packages/dashboard/app/styles.css` — Pre-built CSS classes for section collapse (search for `list-section-chevron`, `list-section-header--collapsed`)

## File Scope

- `packages/dashboard/app/components/ListView.tsx` (modify)
- `packages/dashboard/app/components/__tests__/ListView.test.tsx` (modify)

## Steps

### Step 1: Add Collapse State Management

- [ ] Add `collapsedSections` state (Set of column names) initialized from localStorage key `kb-dashboard-list-collapsed`
- [ ] Add useEffect to persist `collapsedSections` to localStorage on change
- [ ] Add `toggleSection` callback to add/remove columns from the collapsed set
- [ ] Follow the exact pattern used for `visibleColumns` state and persistence (lines 68-90 in ListView.tsx)

**Artifacts:**
- `packages/dashboard/app/components/ListView.tsx` (modified)

### Step 2: Update Section Header Rendering

- [ ] Import `ChevronRight` from lucide-react (chevron pointing right for collapsed state)
- [ ] Modify section header row (`list-section-header`) to include click handler for toggling collapse
- [ ] Add chevron icon that rotates based on collapsed state (use CSS class `list-section-chevron` and `list-section-chevron--expanded`)
- [ ] Apply `list-section-header--collapsed` class to header when section is collapsed
- [ ] Ensure the click handler doesn't conflict with existing column filter click (use `e.stopPropagation()` if needed)

**Artifacts:**
- `packages/dashboard/app/components/ListView.tsx` (modified)

### Step 3: Conditionally Render Task Rows

- [ ] Modify the task rows and "No tasks" row rendering to be conditional based on collapsed state
- [ ] When a section is collapsed, only render the section header (no task rows, no "No tasks" placeholder)
- [ ] Preserve the animation classes for expanded sections (`list-section-header ~ tr` animation already in CSS)

**Artifacts:**
- `packages/dashboard/app/components/ListView.tsx` (modified)

### Step 4: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Add test: clicking section header toggles collapse and hides task rows
- [ ] Add test: clicking again expands section and shows task rows
- [ ] Add test: collapse state persists to localStorage
- [ ] Add test: collapse state initializes from localStorage on mount
- [ ] Add test: multiple sections can be collapsed independently
- [ ] Add test: sorting and filtering still work with collapsed sections
- [ ] Run existing ListView tests: `pnpm test packages/dashboard/app/components/__tests__/ListView.test.tsx`
- [ ] Run full test suite: `pnpm test`
- [ ] Fix all failures
- [ ] Build passes: `pnpm build`

### Step 5: Documentation & Delivery

- [ ] Verify the feature works in browser (manual check if needed)
- [ ] No documentation updates required (self-discoverable UI feature)
- [ ] No new tasks needed — feature is complete

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] User can click section headers to collapse/expand
- [ ] Collapse state persists across page reloads
- [ ] Multiple sections can be collapsed independently
- [ ] Works with existing column filter and hide done features

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-194): complete Step N — description`
- **Bug fixes:** `fix(KB-194): description`
- **Tests:** `test(KB-194): description`

## Do NOT

- Modify the CSS (styles already exist for this feature)
- Change the column filter behavior (keep existing click functionality)
- Modify any API or backend code
- Add new dependencies
- Skip the Testing & Verification step
- Collapse all sections by default (default should be all expanded)
