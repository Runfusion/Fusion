# Task: KB-162 - Fix TaskDetailModal Dependency Dropdown Search Reset Test Failure

**Created:** 2026-03-30
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** This is a localized UI state bug fix with minimal blast radius. The fix involves resetting a single state variable when a dropdown closes. Pattern is straightforward state management, no security concerns, and fully reversible.
**Score:** 2/8 — Blast radius: 0, Pattern novelty: 1, Security: 0, Reversibility: 1

## Mission

Fix the failing test "resets search when dropdown closes and reopens" in TaskDetailModal.test.tsx. The dependency dropdown search input is not being reset to an empty string when the dropdown is reopened after closing. This creates a poor UX where users see their previous search term persisting unexpectedly.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/components/TaskDetailModal.tsx` — The component containing the dependency dropdown logic. Focus on the `depSearch` state and `showDepDropdown` toggle handler.
- `packages/dashboard/app/components/__tests__/TaskDetailModal.test.tsx` — The test file containing the failing test around line 867 in the "dependency dropdown search" describe block.

## File Scope

- `packages/dashboard/app/components/TaskDetailModal.tsx` — Modify the dropdown toggle handler to reset `depSearch` when closing

## Steps

### Step 1: Analyze the Issue

- [ ] Read the failing test to understand expected behavior: when "Add Dependency" is clicked to close the dropdown, then clicked again to reopen, the search input value should be empty
- [ ] Locate the current dropdown toggle implementation in TaskDetailModal.tsx
- [ ] Identify that `depSearch` state is not being reset when `showDepDropdown` changes from true to false

### Step 2: Implement the Fix

- [ ] Modify the "Add Dependency" button's `onClick` handler in TaskDetailModal.tsx
- [ ] When toggling the dropdown closed (from true to false), reset `depSearch` to empty string via `setDepSearch("")`
- [ ] Ensure the fix only resets when closing, not when opening (to avoid clearing intentional new searches)
- [ ] Run the specific failing test to verify: `pnpm test packages/dashboard/app/components/__tests__/TaskDetailModal.test.tsx -t "resets search when dropdown closes and reopens"`

**Artifacts:**
- `packages/dashboard/app/components/TaskDetailModal.tsx` (modified)

### Step 3: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run all TaskDetailModal tests: `pnpm test packages/dashboard/app/components/__tests__/TaskDetailModal.test.tsx`
- [ ] Run full dashboard test suite: `cd packages/dashboard && pnpm test`
- [ ] Fix all failures
- [ ] Build passes: `pnpm build`

### Step 4: Documentation & Delivery

- [ ] No documentation updates needed (this is a bug fix matching expected behavior)
- [ ] Out-of-scope findings created as new tasks via `task_create` tool (if any other pre-existing test failures discovered)

## Documentation Requirements

**Must Update:**
- None — this is a bug fix with no user-facing documentation changes

**Check If Affected:**
- None

## Completion Criteria

- [ ] The test "resets search when dropdown closes and reopens" passes
- [ ] All TaskDetailModal tests pass
- [ ] Full dashboard test suite passes
- [ ] Build passes

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-162): complete Step N — description`
- **Bug fixes:** `fix(KB-162): description`
- **Tests:** `test(KB-162): description`

## Do NOT

- Expand task scope beyond fixing this specific test failure
- Skip the full test suite verification
- Modify files outside TaskDetailModal.tsx
- Commit without the task ID prefix
- Use `breakIntoSubtasks` — this is a simple, single-file fix
