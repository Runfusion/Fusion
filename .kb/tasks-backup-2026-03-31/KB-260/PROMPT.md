# Task: KB-260 - Dropping a card back onto existing column should not send a request

**Created:** 2026-03-31
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** Simple bug fix with clear scope - check current column before calling move API. No complex logic or security implications.
**Score:** 2/8 — Blast radius: 0, Pattern novelty: 0, Security: 1, Reversibility: 1

## Mission

Fix the kanban board drag-and-drop behavior so that dropping a card back onto its current column does not trigger an API request. Currently, when a user drags a card and drops it onto the same column it's already in, the system sends a move request to the server which returns a 400 error ("Invalid transition: 'todo' → 'todo'"), causing an error toast to appear.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/components/Column.tsx` — The Column component handles the drop event and calls `onMoveTask`
- `packages/dashboard/app/components/__tests__/Column.test.tsx` — Existing Column tests to understand testing patterns
- `packages/dashboard/app/api.ts` — The `moveTask` API function that's called via `onMoveTask`

## File Scope

- `packages/dashboard/app/components/Column.tsx` (modified)
- `packages/dashboard/app/components/__tests__/Column.test.tsx` (modified — add test)

## Steps

### Step 1: Add Same-Column Check in Column Drop Handler

- [ ] In `handleDrop` callback, look up the dropped task in the `tasks` prop array by ID
- [ ] If the task's current column matches the target `column`, skip the API call (no-op)
- [ ] Only call `onMoveTask` if the task is actually moving to a different column
- [ ] Remove `dragOver` styling state even on same-column drops (to clean up UI)

**Artifacts:**
- `packages/dashboard/app/components/Column.tsx` (modified)

### Step 2: Add Test Coverage

- [ ] Add test: "does not call onMoveTask when dropping task into its current column"
- [ ] Add test: "removes drag-over styling after drop even on same column"
- [ ] Ensure tests verify `addToast` is NOT called on same-column drops
- [ ] Ensure tests verify `onMoveTask` is NOT called on same-column drops

**Artifacts:**
- `packages/dashboard/app/components/__tests__/Column.test.tsx` (modified)

### Step 3: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm test` in `packages/dashboard`
- [ ] Verify all existing Column tests pass
- [ ] Verify new tests pass
- [ ] Build passes: `pnpm build`

### Step 4: Documentation & Delivery

- [ ] No documentation updates required (internal bug fix, no user-facing behavior change)
- [ ] No out-of-scope findings expected

## Completion Criteria

- [ ] Dropping a card onto its current column produces no API request and no toast
- [ ] All tests passing
- [ ] Build passes

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-260): complete Step N — description`
- **Bug fixes:** `fix(KB-260): description`
- **Tests:** `test(KB-260): description`

## Do NOT

- Modify the server-side move validation (it's correct to reject same-column moves)
- Add visual feedback for same-column drops (silent no-op is the expected UX)
- Change drag-and-drop behavior beyond this specific fix
- Modify `TaskCard.tsx` or other components (the fix belongs in `Column.tsx`)
