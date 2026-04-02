# Task: KB-046 - Fix New Task Button in List View

**Created:** 2026-03-30
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** This is a localized UI bug fix in a single component. The fix is straightforward — add the missing inline creation card to ListView that already exists in Board/Column view. No API changes or cross-component refactoring needed.
**Score:** 3/8 — Blast radius: 1, Pattern novelty: 0, Security: 1, Reversibility: 1

## Mission

Fix the bug where clicking the "+ New Task" button in List view does not show an inline task creation form. The Board view correctly shows the `InlineCreateCard` when creating a task, but the List view accepts the same props (`isCreating`, `onCancelCreate`, `onCreateTask`) but never renders the creation UI. This creates a confusing user experience where the button appears to do nothing in List view.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/components/ListView.tsx` — The list view component that needs to render the inline creation card
- `packages/dashboard/app/components/Column.tsx` — Reference implementation showing how `InlineCreateCard` is used in the board view (lines 98-104)
- `packages/dashboard/app/components/InlineCreateCard.tsx` — The inline creation component props interface
- `packages/dashboard/app/components/__tests__/ListView.test.tsx` — Existing tests for ListView
- `packages/dashboard/app/App.tsx` — Shows how `isCreating`, `onCancelCreate`, `onCreateTask`, `onNewTask` props are passed to both Board and ListView

## File Scope

- `packages/dashboard/app/components/ListView.tsx` (modify)
- `packages/dashboard/app/components/__tests__/ListView.test.tsx` (add tests)

## Steps

### Step 1: Add Inline Creation Card to List View

- [ ] Import `InlineCreateCard` component in ListView.tsx
- [ ] Add the inline creation UI at the top of the Triage section when `isCreating` is true
- [ ] Render before the first task row (or as the first row if triage section is empty)
- [ ] Pass correct props: `tasks`, `onSubmit` (wrapped to call `onCreateTask` with column: "triage"), `onCancel` (wrapped to call `onCancelCreate`), `addToast`
- [ ] Ensure the inline card spans all visible columns using `colSpan={visibleColumns.size}`
- [ ] Run targeted tests: `pnpm test -- packages/dashboard/app/components/__tests__/ListView.test.tsx`

**Artifacts:**
- `packages/dashboard/app/components/ListView.tsx` (modified)

### Step 2: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Add test: "shows InlineCreateCard when isCreating is true" — verify the card appears in the triage section
- [ ] Add test: "calls onCreateTask with triage column when task is submitted from inline card" — verify correct column is passed
- [ ] Add test: "calls onCancelCreate when inline card is cancelled" — verify cancellation works
- [ ] Add test: "does not show InlineCreateCard when isCreating is false" — verify card is hidden when not creating
- [ ] Run full test suite: `pnpm test`
- [ ] Fix all failures
- [ ] Build passes: `pnpm build`

**Artifacts:**
- `packages/dashboard/app/components/__tests__/ListView.test.tsx` (modified)

### Step 3: Documentation & Delivery

- [ ] Update any relevant inline comments if the rendering logic is complex
- [ ] Out-of-scope findings created as new tasks via `task_create` tool

## Documentation Requirements

**Must Update:**
- None — this is a bug fix with no user-facing documentation changes required

**Check If Affected:**
- `AGENTS.md` — check if component patterns are documented (no update expected)

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing (`pnpm test`)
- [ ] Build passes (`pnpm build`)
- [ ] Clicking "+ New Task" in List view shows the inline creation form
- [ ] Creating a task from List view works and shows the new task in the list
- [ ] Cancelling inline creation properly hides the form

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-046): complete Step N — description`
- **Bug fixes:** `fix(KB-046): description`
- **Tests:** `test(KB-046): description`

## Do NOT

- Modify `InlineCreateCard.tsx` — the component works correctly in Board view
- Modify `App.tsx` — props are already correctly passed
- Modify `Column.tsx` — the board view already works correctly
- Skip adding tests — this is a user-facing feature that needs regression coverage
- Add complex state management — use the existing `isCreating` prop pattern from Board view
