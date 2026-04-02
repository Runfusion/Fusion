# Task: KB-019 - Group List View by Columns

**Created:** 2025-03-30
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** UI change affecting task display organization. Requires careful handling of sorting/filtering logic when tasks are grouped. Low blast radius, moderate pattern novelty for grouped list views.
**Score:** 4/8 — Blast radius: 1, Pattern novelty: 1, Security: 1, Reversibility: 1

## Mission

Transform the flat task table in the dashboard's list view into a grouped/sectioned view where tasks are organized by their column (triage, todo, in-progress, in-review, done). Each section should display a header with the column name, color indicator, and task count, similar to how the Board view organizes columns but adapted for the list view table format.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/components/ListView.tsx` — Current list view implementation with flat table
- `packages/dashboard/app/components/Column.tsx` — Board column component for header styling reference
- `packages/core/src/types.ts` — `COLUMNS` array and `COLUMN_LABELS`/`COLUMN_COLOR_MAP` constants
- `packages/dashboard/app/styles.css` — Existing list view and column styling (search for `.list-view`, `.column`, `.dot-` classes)

## File Scope

- `packages/dashboard/app/components/ListView.tsx` — Modify to group tasks by column
- `packages/dashboard/app/styles.css` — Add styles for section headers in list view
- `packages/dashboard/app/components/__tests__/ListView.test.tsx` — Update/add tests for grouped view

## Steps

### Step 1: Analyze Current List View Structure

- [ ] Read and understand current `ListView.tsx` sorting and filtering logic
- [ ] Identify where `filteredAndSortedTasks` is computed and rendered
- [ ] Understand how drag-and-drop currently works with the flat list
- [ ] Document the current table structure (thead, tbody, row rendering)

**Artifacts:**
- Mental model of current implementation (no file changes)

### Step 2: Design Grouped List Layout

- [ ] Design section header component showing: column dot (color), column label, task count
- [ ] Determine table structure: single table with section headers as rows, or multiple tables per section
- [ ] Preserve existing sort behavior: sort within each section, or global sort then group
- [ ] Ensure filter still works across all tasks (show only sections with matching tasks after filter)

**Decision:** Use a single table with section header rows (tr with th colspan) between groups. This preserves column alignment and sticky header behavior.

**Artifacts:**
- Implementation plan (no file changes)

### Step 3: Implement Task Grouping Logic

- [ ] Modify `filteredAndSortedTasks` useMemo to return grouped data structure
- [ ] Create `groupedTasks: Record<Column, Task[]>` after filtering and sorting
- [ ] Maintain existing sort order within each column group
- [ ] Handle empty columns (sections with 0 tasks should still show when no filter, or be hidden when filtered)

**Implementation approach:**
```typescript
const groupedTasks = useMemo(() => {
  const filtered = filter ? tasks.filter(...) : tasks;
  const sorted = [...filtered].sort(...); // existing sort logic
  
  // Group by column while preserving sort order within each group
  const groups: Record<Column, Task[]> = {
    triage: [], todo: [], 'in-progress': [], 'in-review': [], done: []
  };
  sorted.forEach(task => groups[task.column].push(task));
  return groups;
}, [tasks, filter, sortField, sortDirection]);
```

**Artifacts:**
- `packages/dashboard/app/components/ListView.tsx` (modified)

### Step 4: Implement Section Header UI

- [ ] Add section header row component/styling in the table tbody
- [ ] Header should include: colored dot (using `COLUMN_COLOR_MAP`), column label, task count badge
- [ ] Style section header with distinct background (use `--surface` or `--card` background)
- [ ] Add CSS class `.list-section-header` with appropriate styling
- [ ] Ensure section headers don't have hover effects like data rows
- [ ] Section headers should not be clickable (unlike task rows)

**CSS additions needed:**
- `.list-section-header` — distinct row styling, sticky positioning optional
- `.list-section-dot` — column color indicator (reuse pattern from `.column-dot`)
- `.list-section-title` — column label styling
- `.list-section-count` — badge styling (reuse pattern from `.column-count`)

**Artifacts:**
- `packages/dashboard/app/components/ListView.tsx` (modified)
- `packages/dashboard/app/styles.css` (modified)

### Step 5: Update Table Rendering

- [ ] Replace flat `filteredAndSortedTasks.map()` with iteration over `COLUMNS`
- [ ] For each column, render section header row followed by task rows for that column
- [ ] Handle empty sections: show "No tasks" placeholder row when column has 0 tasks (and no filter active)
- [ ] When filter is active, hide empty sections entirely
- [ ] Preserve all existing row styling: failed, paused, agent-active, dragging states
- [ ] Preserve drag-and-drop handlers on individual rows

**Table structure:**
```
| ID | Title | Status | Column | Created | Updated | Deps | Progress |
--------------------------------------------------------------------
| [section header: ● Triage (2)]                                    |
--------------------------------------------------------------------
| KB-001 | Task 1 | ...                                             |
| KB-002 | Task 2 | ...                                             |
--------------------------------------------------------------------
| [section header: ● Todo (1)]                                        |
--------------------------------------------------------------------
| KB-003 | Task 3 | ...                                             |
```

**Artifacts:**
- `packages/dashboard/app/components/ListView.tsx` (modified)

### Step 6: Preserve and Test Drag-and-Drop

- [ ] Verify drag start still works on task rows
- [ ] Verify drop zones at top of page still work for column-to-column moves
- [ ] Optional: Consider adding drop capability directly on section headers (future enhancement, not required)
- [ ] Ensure dragging task shows correct visual feedback
- [ ] Verify task moves to correct section after successful column change

**Artifacts:**
- Drag-and-drop functionality verified through tests

### Step 7: Update Empty States

- [ ] When no filter and no tasks: show "No tasks yet" (current behavior)
- [ ] When filter matches nothing: show "No tasks match your filter" (current behavior)
- [ ] For empty columns within grouped view: show "No tasks" in that section (new)

**Artifacts:**
- `packages/dashboard/app/components/ListView.tsx` (modified)

### Step 8: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Update existing `ListView.test.tsx` to work with new grouped structure
- [ ] Add tests for grouped view: verify sections render with correct columns
- [ ] Add tests for empty sections within grouped view
- [ ] Verify filter still works and hides empty sections
- [ ] Verify sort still works within each section
- [ ] Run full test suite: `pnpm test`
- [ ] Fix all failures
- [ ] Build passes: `pnpm build`

**Artifacts:**
- `packages/dashboard/app/components/__tests__/ListView.test.tsx` (modified)
- All tests passing

### Step 9: Documentation & Delivery

- [ ] Create changeset file for patch release (UI enhancement)
- [ ] Verify no documentation updates needed (feature is self-explanatory)
- [ ] Out-of-scope findings created as new tasks via `task_create` tool if discovered

**Artifacts:**
- `.changeset/group-list-view-by-columns.md` (new)

## Documentation Requirements

**Must Update:**
- None (UI change is self-explanatory)

**Check If Affected:**
- None

## Completion Criteria

- [ ] List view displays tasks grouped by column with section headers
- [ ] Each section shows column color dot, label, and task count
- [ ] Sorting still works (within each section, or globally then grouped)
- [ ] Filtering still works (hides empty sections when filter applied)
- [ ] Drag-and-drop continues to work for moving tasks between columns
- [ ] Empty sections show "No tasks" placeholder when appropriate
- [ ] All existing tests pass plus new tests for grouped view
- [ ] Build passes without errors
- [ ] Changeset file included

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-019): complete Step N — description`
- **Bug fixes:** `fix(KB-019): description`
- **Tests:** `test(KB-019): description`

## Do NOT

- Remove the existing drop-zone bar at the top (keep it for drag-and-drop UX)
- Change the sortable columns or add new sort fields
- Modify the Board view or Column component
- Change the task data structure or API
- Implement column hiding (that's KB-020, a separate task)
- Add expand/collapse functionality for sections (out of scope)
