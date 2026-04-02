# Task: KB-120 - Add Tests for Dashboard Board Search Feature

**Created:** 2026-03-30
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** This is a test-only task for an already-implemented search feature. The Board and Header components have search functionality but lack test coverage. Low blast radius, no new patterns, no security concerns, easily reversible.
**Score:** 2/8 — Blast radius: 0, Pattern novelty: 0, Security: 1, Reversibility: 1

## Mission

Add comprehensive test coverage for the existing search feature on the dashboard card view board. The search feature is already implemented in Board.tsx, Header.tsx, and App.tsx with full styling, but it lacks any automated tests. This task ensures the search functionality is properly tested and guards against regressions.

## Dependencies

- **None** (The search feature is already implemented)

## Context to Read First

1. `packages/dashboard/app/components/Board.tsx` — Review the `searchQuery` prop and `filteredTasks` useMemo logic
2. `packages/dashboard/app/components/Header.tsx` — Review the search input UI and `onSearchChange` prop
3. `packages/dashboard/app/components/Header.test.tsx` — Current tests to understand patterns used
4. `packages/dashboard/app/components/__tests__/Board.test.tsx` — Current tests to understand patterns used

## File Scope

- `packages/dashboard/app/components/__tests__/Board.test.tsx` (modify)
- `packages/dashboard/app/components/Header.test.tsx` (modify)

## Steps

### Step 1: Add Search Tests to Header.test.tsx

- [ ] Add test: "does not render search input when onSearchChange is not provided"
- [ ] Add test: "renders search input when onSearchChange and view='board' are provided"
- [ ] Add test: "does not render search input when view is 'list'"
- [ ] Add test: "calls onSearchChange when typing in search input"
- [ ] Add test: "shows clear button when search query is not empty"
- [ ] Add test: "calls onSearchChange with empty string when clear button is clicked"
- [ ] Add test: "search input has correct placeholder text"
- [ ] Fix the existing "renders the logo and brand" test to expect "Fusion" and "tasks" instead of "kb" and "board"
- [ ] Run Header tests: `pnpm test -- --run app/components/Header.test.tsx`

**Artifacts:**
- `packages/dashboard/app/components/Header.test.tsx` (modified)

### Step 2: Add Search Tests to Board.test.tsx

- [ ] Add test: "filters tasks by ID when search query is provided"
- [ ] Add test: "filters tasks by title when search query is provided"
- [ ] Add test: "filters tasks by description when search query is provided"
- [ ] Add test: "search is case-insensitive"
- [ ] Add test: "shows all tasks when search query is empty"
- [ ] Add test: "shows no tasks when search query matches nothing"
- [ ] Add test: "filtered tasks are sorted correctly (columnMovedAt, createdAt)"
- [ ] Run Board tests: `pnpm test -- --run app/components/__tests__/Board.test.tsx`

**Artifacts:**
- `packages/dashboard/app/components/__tests__/Board.test.tsx` (modified)

### Step 3: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full dashboard test suite: `cd packages/dashboard && pnpm test -- --run`
- [ ] Fix any failures introduced by the new tests
- [ ] Build passes: `pnpm build`

### Step 4: Documentation & Delivery

- [ ] No documentation updates needed (tests are self-documenting)
- [ ] No changeset needed (this is test-only, no user-facing changes)

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing (including new search tests)
- [ ] Build passes
- [ ] Search functionality is fully covered by tests:
  - Header search UI rendering
  - Header search input behavior
  - Header clear button functionality
  - Board task filtering by ID
  - Board task filtering by title
  - Board task filtering by description
  - Case-insensitive search
  - Empty search shows all tasks

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `test(KB-120): complete Step N — description`
- **Bug fixes:** `fix(KB-120): description`

Example commits:
- `test(KB-120): add Header search tests`
- `test(KB-120): add Board search filter tests`
- `fix(KB-120): update logo text in Header test from kb/board to Fusion/tasks`

## Do NOT

- Modify the search implementation itself (it's already working)
- Add new features to the search (debouncing, localStorage, etc.)
- Skip any of the listed test cases
- Modify files outside the File Scope without good reason
- Commit without the task ID prefix
