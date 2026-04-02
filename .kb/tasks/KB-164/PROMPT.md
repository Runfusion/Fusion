# Task: KB-164 - Unify List View Task Creation with Board View

**Created:** 2026-03-30
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** Simple UI alignment task. Removes conditional rendering and switches from inline creation to modal-based creation, matching board view behavior. Low blast radius, well-understood patterns.
**Score:** 3/8 — Blast radius: 1, Pattern novelty: 0, Security: 1, Reversibility: 1

## Mission

Unify the task creation experience between board and list views. The board view already has:
1. An always-visible `QuickEntryBox` for rapid task capture
2. A "New Task" button that opens the full `NewTaskModal` dialog

The list view currently has a different (older) flow:
1. `QuickEntryBox` is conditionally rendered only when `onQuickCreate` is provided
2. "New Task" button triggers an inline `InlineCreateCard` with model/dependency selectors

Align list view with board view:
- `QuickEntryBox` should always be visible in the toolbar (not conditional)
- "New Task" button should open the shared `NewTaskModal` (not inline creation)

## Dependencies

- **None** — uses existing `QuickEntryBox` and `NewTaskModal` components

## Context to Read First

- `packages/dashboard/app/components/ListView.tsx` — List view component with conditional QuickEntryBox and inline creation
- `packages/dashboard/app/components/Board.tsx` — Board view showing the desired pattern (always-visible QuickEntryBox in triage column)
- `packages/dashboard/app/components/Column.tsx` — How board view renders QuickEntryBox and wires the New Task button
- `packages/dashboard/app/components/QuickEntryBox.tsx` — The quick entry component (already exists)
- `packages/dashboard/app/components/NewTaskModal.tsx` — The full task creation modal (already exists)
- `packages/dashboard/app/components/InlineCreateCard.tsx` — Current inline creation card (to be removed from list view flow)
- `packages/dashboard/app/components/App.tsx` — Parent component that wires handlers to both views
- `packages/dashboard/app/components/__tests__/ListView.test.tsx` — Existing tests that will need updates

## File Scope

- `packages/dashboard/app/components/ListView.tsx` — Make QuickEntryBox always visible, remove InlineCreateCard, simplify New Task button
- `packages/dashboard/app/components/App.tsx` — Wire list view's onNewTask to open NewTaskModal instead of inline creation
- `packages/dashboard/app/components/__tests__/ListView.test.tsx` — Update tests for new behavior
- `packages/dashboard/app/components/__tests__/App.test.tsx` — Verify list view uses same modal as board view

## Steps

### Step 1: Update ListView Component

Align list view task creation with board view pattern.

- [ ] Make `QuickEntryBox` always visible by removing the `{onQuickCreate && (...)}` conditional wrapper
- [ ] Remove the entire `InlineCreateCard` section (lines with `isCreating && onCancelCreate && onCreateTask`)
- [ ] Remove `isCreating`, `onCancelCreate`, `onCreateTask` from `ListViewProps` interface
- [ ] Keep `onNewTask` prop — button behavior stays the same, but now it will open the modal instead of inline card
- [ ] Update the conditional New Task button rendering to remove the `isCreating` branch (keep only the `onNewTask` button)
- [ ] Verify no other references to `InlineCreateCard` remain in the file

**Code changes needed:**
1. Remove `isCreating?: boolean`, `onCancelCreate?: () => void`, `onCreateTask?: (input: TaskCreateInput) => Promise<Task>` from `ListViewProps`
2. Remove the conditional `{isCreating && onCancelCreate && onCreateTask && (<InlineCreateCard ... />)}` block
3. Remove the `isCreating ? (<span>Creating...</span>) :` branch from the button rendering
4. Remove the conditional wrapper around QuickEntryBox: change `{onQuickCreate && (...)}` to just the inner `<div className="list-quick-entry">`

**Artifacts:**
- `packages/dashboard/app/components/ListView.tsx` (modified)

### Step 2: Update App Component

Wire list view to use the same modal-based creation flow as board view.

- [ ] Change list view's `onNewTask` prop from `handleListInlineCreateOpen` to `handleNewTaskOpen`
- [ ] Remove `isListInlineCreating` state and its `useEffect` cleanup
- [ ] Remove `handleListInlineCreateOpen`, `handleListInlineCreateCancel`, `handleListInlineCreate` callbacks
- [ ] Keep `handleQuickCreate` — this is still used for the QuickEntryBox
- [ ] Remove `InlineCreateCard` import if no longer used anywhere

**Code changes needed:**
1. Remove `const [isListInlineCreating, setIsListInlineCreating] = useState(false);`
2. Remove the `useEffect` that cleans up `isListInlineCreating` when view changes
3. Remove `handleListInlineCreateOpen`, `handleListInlineCreateCancel`, `handleListInlineCreate` functions
4. In the ListView JSX, change `onNewTask={handleListInlineCreateOpen}` to `onNewTask={handleNewTaskOpen}`
5. Remove `isCreating={isListInlineCreating}`, `onCancelCreate={handleListInlineCreateCancel}`, `onCreateTask={handleListInlineCreate}` props from ListView

**Artifacts:**
- `packages/dashboard/app/components/App.tsx` (modified)

### Step 3: Update Tests

Update list view tests to reflect the unified creation flow.

- [ ] Remove tests for `InlineCreateCard` rendering in list view
- [ ] Update QuickEntryBox tests: verify it's always rendered (not conditional on prop)
- [ ] Update New Task button test: verify it calls `onNewTask` (which now opens modal)
- [ ] Remove tests for `isCreating`, `onCancelCreate`, `onCreateTask` props
- [ ] Add test: verify `QuickEntryBox` is rendered even when `onQuickCreate` is the only prop provided
- [ ] Ensure existing functionality tests (filtering, sorting, drag-drop) still pass

**Test updates needed:**
1. Remove `describe("ListView Inline Create Card", () => { ... })` block entirely
2. Update `describe("ListView Quick Entry", () => { ... })` tests — remove the "does not render when onQuickCreate not provided" test
3. Update "calls onNewTask when + New Task button is clicked" test — it should still pass as-is
4. Remove tests that check for "Creating..." indicator state

**Artifacts:**
- `packages/dashboard/app/components/__tests__/ListView.test.tsx` (modified)

### Step 4: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run list view tests: `pnpm test packages/dashboard/app/components/__tests__/ListView.test.tsx`
- [ ] Run app tests: `pnpm test packages/dashboard/app/components/__tests__/App.test.tsx`
- [ ] Run full dashboard test suite: `pnpm test packages/dashboard`
- [ ] Fix any test failures
- [ ] Build passes: `pnpm build`
- [ ] Manual verification: Open list view and verify:
  - Quick entry box is visible without any interaction
  - Typing and pressing Enter creates a task
  - "New Task" button opens the full NewTaskModal (same as board view)

**Artifacts:**
- All tests passing
- Build successful

### Step 5: Documentation & Delivery

- [ ] Update any dashboard documentation mentioning the old inline creation flow in list view
- [ ] Check if `InlineCreateCard` is still used elsewhere; if not, create a cleanup task
- [ ] Out-of-scope: Do NOT delete `InlineCreateCard.tsx` itself — that may be used elsewhere or be a future design option

**Check If Affected:**
- `packages/dashboard/README.md` — if it documents task creation flows

## Documentation Requirements

**Check If Affected:**
- `packages/dashboard/README.md` — update if it describes list view task creation differently from board view

## Completion Criteria

- [ ] QuickEntryBox is always visible in list view toolbar
- [ ] QuickEntryBox creates tasks on Enter (same as board view)
- [ ] "New Task" button opens NewTaskModal (same dialog as board view)
- [ ] InlineCreateCard is no longer used in list view
- [ ] All list view tests updated and passing
- [ ] Full test suite passes
- [ ] Build passes

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-164): complete Step N — description`
- **Bug fixes:** `fix(KB-164): description`
- **Tests:** `test(KB-164): description`

## Do NOT

- Delete the `InlineCreateCard.tsx` file itself — it may be used elsewhere
- Modify `NewTaskModal.tsx` or `QuickEntryBox.tsx` — they already work correctly
- Change board view behavior — only align list view to match
- Add new features — this is a consistency/unification task, not a feature addition
- Skip updating tests — all tests must reflect the new behavior
