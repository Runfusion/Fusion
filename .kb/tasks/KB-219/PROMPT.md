# Task: KB-219 - In the new task dialog the description field should have text input focus immediately

**Created:** 2026-03-31
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** Simple UI enhancement with minimal blast radius — just adding auto-focus to a single textarea in an existing modal component. No security implications and easily reversible.
**Score:** 2/8 — Blast radius: 0, Pattern novelty: 0, Security: 0, Reversibility: 2

## Mission

When the New Task dialog opens in the dashboard, the description textarea should immediately receive keyboard focus so users can start typing their task description without needing to click into the field. This is a standard UX pattern for modal forms where there's a primary text input.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/components/NewTaskModal.tsx` — The modal component where focus management needs to be added
- `packages/dashboard/app/components/__tests__/NewTaskModal.test.tsx` — Existing tests to understand testing patterns

## File Scope

- `packages/dashboard/app/components/NewTaskModal.tsx` (modified)
- `packages/dashboard/app/components/__tests__/NewTaskModal.test.tsx` (modified — add test for focus behavior)

## Steps

### Step 1: Implement Auto-Focus on Modal Open

- [ ] Add a `useEffect` hook that focuses the description textarea when `isOpen` becomes `true`
- [ ] Use the existing `descTextareaRef` to call `.focus()` on the textarea element
- [ ] Ensure the effect only runs when `isOpen` changes (not on every render)
- [ ] Add a small delay (`setTimeout(..., 0)`) if needed to ensure the modal is fully rendered before focusing

**Artifacts:**
- `packages/dashboard/app/components/NewTaskModal.tsx` (modified)

### Step 2: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Add a test in `NewTaskModal.test.tsx` that verifies the description textarea has focus when the modal opens
- [ ] Use React Testing Library's `expect(element).toHaveFocus()` matcher
- [ ] Run `pnpm test` to verify all existing tests still pass
- [ ] Run `pnpm build` to ensure the dashboard builds without errors

**Artifacts:**
- `packages/dashboard/app/components/__tests__/NewTaskModal.test.tsx` (modified)

### Step 3: Documentation & Delivery

- [ ] No documentation updates required for this UI enhancement
- [ ] Out-of-scope findings created as new tasks via `task_create` tool (if any edge cases discovered)

## Documentation Requirements

**Must Update:**
- None

**Check If Affected:**
- None

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Focus moves to description textarea immediately when New Task dialog opens
- [ ] No regressions in existing modal behavior

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-219): complete Step N — description`
- **Bug fixes:** `fix(KB-219): description`
- **Tests:** `test(KB-219): description`

## Do NOT

- Expand task scope to other modals or inputs
- Skip tests
- Modify files outside the File Scope without good reason
- Commit without the task ID prefix
- Add complex focus management libraries for this simple use case
