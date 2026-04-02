# Task: KB-089 - Add Search Feature on Dashboard Card View Board

**Created:** 2026-03-30
**Size:** M

## Review Level: 1 (Plan Only)

**Assessment:** This is a UI-only feature adding search functionality to the existing Board component. It's a well-scoped enhancement that follows established patterns from ListView.tsx. Low blast radius as it only affects filtering logic, no backend changes needed.
**Score:** 3/8 — Blast radius: 1, Pattern novelty: 0, Security: 1, Reversibility: 1

## Mission

Add a real-time search/filter feature to the dashboard's card view (Board component) that allows users to quickly find tasks by ID, title, or description. The search should filter cards across all columns while maintaining the existing board layout and drag-and-drop functionality. This feature mirrors the existing search in ListView.tsx but adapts it for the kanban-style card board interface.

## Dependencies

- **None**

## Context to Read First

1. `packages/dashboard/app/components/Board.tsx` — The main board component that renders columns and cards
2. `packages/dashboard/app/components/ListView.tsx` — Reference implementation showing search/filter patterns (lines 70-130)
3. `packages/dashboard/app/components/Header.tsx` — Shows where to add the search input in the header
4. `packages/dashboard/app/styles.css` — Search input styling patterns (`.list-filter` class around line 1050)
5. `packages/core/src/types.ts` — Task type definition with id, title, description fields

## File Scope

- `packages/dashboard/app/components/Board.tsx` (modify)
- `packages/dashboard/app/components/Header.tsx` (modify)
- `packages/dashboard/app/App.tsx` (modify)
- `packages/dashboard/app/styles.css` (modify)
- `packages/dashboard/app/components/__tests__/Board.test.tsx` (modify)
- `packages/dashboard/app/components/__tests__/Header.test.tsx` (modify)

## Steps

### Step 1: Add Search State and Filter Logic to Board Component

- [ ] Add `searchQuery` state to Board component using `useState("")`
- [ ] Create filtered tasks computation that filters by ID, title, or description (case-insensitive)
- [ ] Pass filtered tasks to Column components instead of raw tasks
- [ ] Add search result count display (e.g., "Showing 5 of 23 tasks")
- [ ] Run Board component tests to ensure no regressions

**Artifacts:**
- `packages/dashboard/app/components/Board.tsx` (modified)

### Step 2: Add Search Input to Header Component

- [ ] Add optional `searchQuery` and `onSearchChange` props to Header component
- [ ] Add search input field in header actions area (between view toggle and GitHub import)
- [ ] Use Search icon from lucide-react (import from "lucide-react")
- [ ] Follow `.list-filter` CSS pattern from styles.css for consistent styling
- [ ] Include clear button (×) that appears when search has content
- [ ] Add placeholder text: "Search tasks..."
- [ ] Run Header component tests

**Artifacts:**
- `packages/dashboard/app/components/Header.tsx` (modified)

### Step 3: Wire Search State Through App Component

- [ ] Add `searchQuery` state to AppInner component
- [ ] Pass `searchQuery` and `setSearchQuery` to Header component props
- [ ] Pass `searchQuery` to Board component for filtering
- [ ] Ensure ListView is NOT affected by the search (search only applies to board view)
- [ ] Verify the integration works end-to-end

**Artifacts:**
- `packages/dashboard/app/App.tsx` (modified)

### Step 4: Add CSS Styles for Board Search

- [ ] Add `.board-search` class for the search container (similar to `.list-filter`)
- [ ] Add responsive styles for mobile (header actions should wrap on small screens)
- [ ] Ensure search input matches existing dark/light theme patterns
- [ ] Add styles for search result count badge in column headers
- [ ] Verify visual consistency with existing filter in ListView

**Artifacts:**
- `packages/dashboard/app/styles.css` (modified)

### Step 5: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Update `Board.test.tsx` to test search filtering logic:
  - Test that search filters tasks by ID
  - Test that search filters tasks by title
  - Test that search filters tasks by description
  - Test that search is case-insensitive
  - Test that empty search shows all tasks
- [ ] Update `Header.test.tsx` to test search input:
  - Test that search input renders
  - Test that typing calls onSearchChange
  - Test that clear button clears search
- [ ] Run full test suite: `pnpm test`
- [ ] Fix all failures
- [ ] Build passes: `pnpm build`

**Test Pattern to Follow:**
```tsx
// Example test pattern from ListView.test.tsx
it('filters tasks by search query', () => {
  const tasks = [
    { id: 'KB-001', title: 'Fix bug', description: 'Fix login bug', ... },
    { id: 'KB-002', title: 'Add feature', description: 'Add search', ... },
  ];
  // Test filtering logic
});
```

### Step 6: Documentation & Delivery

- [ ] Update `packages/dashboard/README.md` if it documents UI features (add search feature description)
- [ ] Create changeset file for the new feature:
  ```bash
  cat > .changeset/add-board-search.md << 'EOF'
  ---
  "@dustinbyrne/kb": minor
  ---
  
  Add search feature to dashboard card view board. Users can now filter tasks by ID, title, or description in real-time.
  EOF
  ```
- [ ] Verify all files are properly formatted and committed

## Documentation Requirements

**Must Update:**
- None (this is a self-discoverable UI feature)

**Check If Affected:**
- `packages/dashboard/README.md` — Add mention of search feature if UI features are documented

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Documentation updated (changeset created)
- [ ] Search works across all columns (triage, todo, in-progress, in-review, done, archived)
- [ ] Search filters by ID, title, and description (case-insensitive)
- [ ] Clear button appears when search has content and clears the search
- [ ] Search is only active in board view (ListView unaffected)
- [ ] Mobile responsive (search input wraps properly on small screens)

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-089): complete Step N — description`
- **Bug fixes:** `fix(KB-089): description`
- **Tests:** `test(KB-089): description`

Example commits:
- `feat(KB-089): complete Step 1 — add search state and filter logic to Board`
- `feat(KB-089): complete Step 2 — add search input to Header component`
- `feat(KB-089): complete Step 3 — wire search state through App`
- `feat(KB-089): complete Step 4 — add CSS styles for board search`
- `test(KB-089): add tests for board search feature`
- `feat(KB-089): complete Step 6 — add changeset and finalize`

## Do NOT

- Expand task scope to include server-side search or backend changes
- Skip tests for the search functionality
- Modify the ListView search behavior
- Change the task data structure or API contracts
- Add debouncing (keep it simple with immediate filtering)
- Store search state in localStorage (keep it session-only)
- Modify files outside the File Scope without good reason
- Commit without the task ID prefix
