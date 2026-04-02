# Task: KB-155 - Fix TaskDetailModal Dependency Dropdown Search Test

**Created:** 2026-03-30
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** Simple, focused fix for a single failing test. The component doesn't reset search state when the dependency dropdown closes; the fix requires clearing `depSearch` state when toggling the dropdown off or when opening it.
**Score:** 2/8 — Blast radius: 0, Pattern novelty: 0, Security: 1, Reversibility: 1

## Mission

Fix the failing "resets search when dropdown closes and reopens" test in TaskDetailModal.test.tsx. The test expects the search input to be cleared when the dependency dropdown is closed and reopened, but the component currently preserves the search state across toggle operations.

**Note:** The typecheck.test.ts failure mentioned in the task description is being addressed by KB-141 (in-progress: "Fix workspace-wide dashboard typecheck baseline failures"). This task focuses exclusively on the TaskDetailModal dropdown search behavior.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/components/__tests__/TaskDetailModal.test.tsx` — Lines 1357-1375: The failing "resets search when dropdown closes and reopens" test
- `packages/dashboard/app/components/TaskDetailModal.tsx` — Lines 112-113: State declarations for `showDepDropdown` and `depSearch`; Line ~832: Dropdown toggle handler in "Add Dependency" button

## File Scope

- `packages/dashboard/app/components/TaskDetailModal.tsx` — Modify dropdown toggle logic (around line 832) to reset `depSearch` when closing or reopening the dropdown

## Steps

### Step 1: Fix Dropdown Search Reset Behavior

The component maintains `depSearch` state for the dependency dropdown filter, but doesn't reset it when the dropdown is toggled. Update the toggle handler to clear the search when appropriate.

- [ ] Locate the dropdown toggle logic in `TaskDetailModal.tsx` (around line 832 in the "Add Dependency" button onClick)
- [ ] Update the toggle handler to reset `depSearch` to `""` when the dropdown is closed OR when it's reopened
- [ ] Two valid approaches:
  - **Option A:** Reset when closing: `onClick={() => { if (showDepDropdown) setDepSearch(""); setShowDepDropdown(v => !v); }}`
  - **Option B:** Reset when opening: `onClick={() => { setShowDepDropdown(v => !v); if (!showDepDropdown) setDepSearch(""); }}`
- [ ] Either approach works; Option A is slightly cleaner as it clears on close
- [ ] Run the specific failing test to verify the fix

**Artifacts:**
- `packages/dashboard/app/components/TaskDetailModal.tsx` (modified — dropdown toggle handler)

### Step 2: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run the specific test to verify it passes: `cd packages/dashboard && pnpm test -- --run "resets search when dropdown closes and reopens"`
- [ ] Run all TaskDetailModal tests: `cd packages/dashboard && pnpm test -- --run TaskDetailModal.test.tsx`
  - Confirm 95+ tests pass in the TaskDetailModal suite
  - The "resets search when dropdown closes and reopens" test should now pass
- [ ] Run full dashboard test suite: `cd packages/dashboard && pnpm test`
  - Confirm no new failures introduced
  - Expected state: All tests pass except typecheck.test.ts (handled by KB-141)

### Step 3: Documentation & Delivery

- [ ] No documentation updates required (internal bug fix)
- [ ] Create follow-up task if any other dropdown-related issues discovered during fix

## Documentation Requirements

**Must Update:**
- None

**Check If Affected:**
- None

## Completion Criteria

- [ ] All steps complete
- [ ] "resets search when dropdown closes and reopens" test passes
- [ ] All TaskDetailModal tests pass (95+ tests)
- [ ] No regressions in dashboard test suite
- [ ] No changesets required (internal test fix, no user-facing behavior change)

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-155): complete Step N — description`
- **Bug fixes:** `fix(KB-155): description`
- **Tests:** `test(KB-155): description`

## Do NOT

- Expand scope to unrelated TaskDetailModal issues
- Modify the test file (the test expectation is correct; fix the component)
- Skip other failing tests (leave typecheck.test.ts to KB-141)
- Introduce new state variables (use existing `depSearch` state)
- Change dropdown behavior beyond the search reset fix
