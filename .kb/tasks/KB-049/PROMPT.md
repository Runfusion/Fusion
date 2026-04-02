# Task: KB-049 - Add ability to hide done tasks in list view

**Created:** 2026-03-30
**Size:** S

## Review Level: 0 (None)

**Assessment:** Small, isolated UI enhancement with limited blast radius. Pattern follows existing column visibility toggle implementation.
**Score:** 2/8 — Blast radius: 0, Pattern novelty: 1, Security: 0, Reversibility: 1

## Mission

Add a toggle control to the List View toolbar that allows users to hide or show tasks in the "done" column. This helps users focus on active work by decluttering the view when many completed tasks accumulate. The preference should persist in localStorage, similar to the existing column visibility feature.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/components/ListView.tsx` — Main list view component with existing column visibility toggle pattern
- `packages/dashboard/app/components/__tests__/ListView.test.tsx` — Existing test patterns for the list view
- `packages/dashboard/app/styles.css` — CSS classes used for list view styling (search for `.list-*` classes)
- `packages/core/src/types.ts` — `Column` type definition and `COLUMNS` array

## File Scope

- `packages/dashboard/app/components/ListView.tsx` — Add toggle UI and filtering logic
- `packages/dashboard/app/components/__tests__/ListView.test.tsx` — Add tests for hide done tasks feature
- `packages/dashboard/app/styles.css` — Add styles for the toggle control (follow existing `.list-toolbar` patterns)

## Steps

### Step 1: Add Hide Done Tasks Toggle UI

- [ ] Add `hideDoneTasks` state to `ListView` component, initialized from `localStorage.getItem("kb-dashboard-hide-done")`
- [ ] Add toggle button in the toolbar next to the "Columns" button (use `EyeOff`/`Eye` icons from lucide-react)
- [ ] Persist `hideDoneTasks` state to `localStorage` when changed
- [ ] Add appropriate CSS classes following existing `.list-*` naming conventions

**Artifacts:**
- `packages/dashboard/app/components/ListView.tsx` (modified)
- `packages/dashboard/app/styles.css` (modified)

### Step 2: Implement Filtering Logic

- [ ] Modify `groupedTasks` useMemo to filter out done tasks when `hideDoneTasks` is true
- [ ] Update task counts in the drop zones to reflect filtered view (show "X of Y" format for done column when hidden)
- [ ] Update the stats text to indicate when done tasks are hidden (e.g., "5 of 12 tasks (3 done hidden)")
- [ ] Ensure done column section header is hidden when `hideDoneTasks` is true

**Artifacts:**
- `packages/dashboard/app/components/ListView.tsx` (modified)

### Step 3: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Add test: "hides done tasks when toggle is activated"
- [ ] Add test: "shows done tasks when toggle is deactivated"
- [ ] Add test: "persists hide done preference to localStorage"
- [ ] Add test: "initializes hide done state from localStorage"
- [ ] Add test: "updates stats text when done tasks are hidden"
- [ ] Run `pnpm test` — all tests must pass
- [ ] Run `pnpm build` — must complete without errors

### Step 4: Documentation & Delivery

- [ ] Create changeset file: `.changeset/hide-done-tasks-list-view.md` (patch bump for `@dustinbyrne/kb`)
- [ ] Verify toggle works correctly in both states
- [ ] Out-of-scope findings created as new tasks via `task_create` tool if any

**Changeset content:**
```md
---
"@dustinbyrne/kb": patch
---

Add ability to hide done tasks in list view. The toggle persists in localStorage and helps declutter the view when many tasks are completed.
```

## Completion Criteria

- [ ] Hide done tasks toggle appears in list view toolbar
- [ ] Toggle state persists in localStorage
- [ ] Done tasks are filtered from view when toggle is active
- [ ] Done column section header is hidden when toggle is active
- [ ] Stats text reflects the hidden tasks
- [ ] All tests pass
- [ ] Build passes
- [ ] Changeset file created

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-049): complete Step N — description`
- **Bug fixes:** `fix(KB-049): description`
- **Tests:** `test(KB-049): description`

## Do NOT

- Modify the board view — this change is list view only
- Change the default behavior — done tasks should be visible by default
- Remove the done drop zone — it should remain visible for drag-and-drop operations
- Skip writing tests — follow existing ListView.test.tsx patterns
- Use any external state management — use local state and localStorage only
