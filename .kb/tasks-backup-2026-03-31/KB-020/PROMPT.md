# Task: KB-020 - Add ability to hide columns in list view

**Created:** 2026-03-30
**Size:** M

## Review Level: 1 (Plan Only)

**Assessment:** This is a contained UI enhancement with clear boundaries. The pattern of persisting preferences to localStorage is already established in the codebase. No architectural changes or external dependencies required.
**Score:** 3/8 — Blast radius: 1, Pattern novelty: 0, Security: 1, Reversibility: 1

## Mission

Add a column visibility toggle to the list view toolbar that allows users to show or hide individual table columns. Preferences persist to localStorage using the existing `kb-dashboard-*` key pattern. The default state shows all columns. This improves usability by letting users focus on the data that matters to them.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/components/ListView.tsx` — The list view component with table structure
- `packages/dashboard/app/components/__tests__/ListView.test.tsx` — Existing tests for ListView
- `packages/dashboard/app/App.tsx` — See how localStorage persistence is implemented for view preference
- `packages/dashboard/app/styles.css` — List view styles (search for `.list-*` classes)
- `packages/core/src/types.ts` — Core types (COLUMNS array)

## File Scope

- `packages/dashboard/app/components/ListView.tsx` — Add column visibility state, toggle UI, and conditional column rendering
- `packages/dashboard/app/components/__tests__/ListView.test.tsx` — Add tests for column visibility toggle
- `packages/dashboard/app/styles.css` — Add styles for column toggle dropdown

## Steps

### Step 1: Column Visibility State Management

- [ ] Define a type for list columns: `type ListColumn = "id" | "title" | "status" | "column" | "createdAt" | "updatedAt" | "dependencies" | "progress"`
- [ ] Create a constant array of all list columns: `ALL_LIST_COLUMNS`
- [ ] Add state for visible columns using `useState`, initialized from `localStorage.getItem("kb-dashboard-list-columns")`
- [ ] Add `useEffect` to persist visibility changes to `localStorage.setItem("kb-dashboard-list-columns", JSON.stringify(visibleColumns))`
- [ ] Handle missing/invalid localStorage data by defaulting to all columns

**Artifacts:**
- `packages/dashboard/app/components/ListView.tsx` (modified) — State management for column visibility

### Step 2: Column Toggle UI

- [ ] Add "Columns" button with `Columns3` icon from `lucide-react` to the list toolbar (next to the filter)
- [ ] Create a dropdown menu that appears when clicking the Columns button
- [ ] Render a checkbox for each column showing its visibility state
- [ ] Toggle column visibility when clicking a checkbox item
- [ ] Prevent at least one column from being hidden (disable last visible checkbox or show warning)
- [ ] Close dropdown when clicking outside or pressing Escape
- [ ] Use existing CSS patterns (var colors, radius, transitions) for styling

**Artifacts:**
- `packages/dashboard/app/components/ListView.tsx` (modified) — Column toggle UI
- `packages/dashboard/app/styles.css` (modified) — `.list-column-toggle`, `.list-column-dropdown` styles

### Step 3: Conditional Column Rendering

- [ ] Update table header (`<thead>`) to conditionally render `<th>` elements based on `visibleColumns` set
- [ ] Update table body (`<tbody>` rows) to conditionally render `<td>` elements matching visible columns
- [ ] Ensure row drag-and-drop still works with hidden columns
- [ ] Ensure sorting still works on hidden columns (they just don't render, sort state preserved)

**Artifacts:**
- `packages/dashboard/app/components/ListView.tsx` (modified) — Conditional rendering logic

### Step 4: Testing

- [ ] Add test: "renders column toggle button"
- [ ] Add test: "opens column dropdown when toggle clicked"
- [ ] Add test: "hides column when unchecked in dropdown"
- [ ] Add test: "shows column when checked in dropdown"
- [ ] Add test: "persists column visibility to localStorage"
- [ ] Add test: "initializes column visibility from localStorage"
- [ ] Add test: "prevents hiding all columns (at least one stays visible)"
- [ ] Add test: "sorting still works when some columns are hidden"
- [ ] Add test: "all columns visible by default when no localStorage"

**Artifacts:**
- `packages/dashboard/app/components/__tests__/ListView.test.tsx` (modified)

### Step 5: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm test` — all tests must pass
- [ ] Run `pnpm build` — build must pass
- [ ] Verify column visibility persists across page reloads
- [ ] Verify at least one column always remains visible
- [ ] Verify all existing list view features still work (sorting, filtering, drag-drop)

### Step 6: Documentation & Delivery

- [ ] Update `packages/dashboard/README.md` if it documents list view features — add note about column visibility toggle
- [ ] Create changeset: `cat > .changeset/add-list-column-toggle.md << 'EOF'` with patch bump for `@dustinbyrne/kb`
- [ ] Commit all changes with task ID prefix

**Commit message:** `feat(KB-020): add column visibility toggle to list view`

## Documentation Requirements

**Must Update:**
- None (this is a self-discoverable UI feature)

**Check If Affected:**
- `packages/dashboard/README.md` — Add brief mention of column toggle if list view is documented

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing (`pnpm test`)
- [ ] Build passes (`pnpm build`)
- [ ] Changeset created for `@dustinbyrne/kb`

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-020): complete Step N — description`
- **Bug fixes:** `fix(KB-020): description`
- **Tests:** `test(KB-020): description`

## Do NOT

- Add a "reset to defaults" button (out of scope)
- Implement column reordering (out of scope — KB-019)
- Change the board view column visibility (different component)
- Use any external UI libraries (use existing patterns)
- Modify the API or core types
- Skip tests for the localStorage persistence logic
