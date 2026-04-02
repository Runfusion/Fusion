# Task: KB-166 - Fix TaskDetailModal dependency dropdown search reset bug

**Created:** 2026-03-30
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** The fix is straightforward - add a useEffect to reset the depSearch state when the dropdown closes. Low blast radius, affects only one component state interaction.
**Score:** 2/8 — Blast radius: 0, Pattern novelty: 0, Security: 0, Reversibility: 2

## Mission

Fix a bug in the TaskDetailModal component where the dependency dropdown search field retains its previous value when the dropdown is closed and reopened. The search field should reset to an empty string every time the dropdown opens.

The failing test is: "resets search when dropdown closes and reopens"
- Expected: search input value = ""
- Received: search input value = "login" (previous search retained)

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/components/TaskDetailModal.tsx` — The component with the bug
- `packages/dashboard/app/components/__tests__/TaskDetailModal.test.tsx` — Contains the failing test (lines 1117-1136)

## File Scope

- `packages/dashboard/app/components/TaskDetailModal.tsx` (modify)

## Steps

### Step 1: Fix the search reset bug

- [ ] Read the current state management for the dependency dropdown:
  - `showDepDropdown` — controls dropdown visibility
  - `depSearch` — stores the search value
- [ ] Add a `useEffect` hook that resets `depSearch` to `""` when `showDepDropdown` changes from `true` to `false`
- [ ] The fix should be minimal - only reset when the dropdown closes (not on every render)

**Implementation approach:**
```typescript
// Add this useEffect near the other state management hooks (around line 50)
useEffect(() => {
  if (!showDepDropdown) {
    setDepSearch("");
  }
}, [showDepDropdown]);
```

**Artifacts:**
- `packages/dashboard/app/components/TaskDetailModal.tsx` (modified)

### Step 2: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run the specific failing test to verify the fix:
  ```bash
  cd /Users/eclipxe/Projects/kb/packages/dashboard && pnpm test -- --testNamePattern="resets search when dropdown closes and reopens"
  ```
- [ ] Run all TaskDetailModal tests:
  ```bash
  cd /Users/eclipxe/Projects/kb/packages/dashboard && pnpm test -- TaskDetailModal
  ```
- [ ] Run the full dashboard test suite:
  ```bash
  cd /Users/eclipxe/Projects/kb/packages/dashboard && pnpm test
  ```
- [ ] Fix all failures
- [ ] Build passes:
  ```bash
  cd /Users/eclipxe/Projects/kb && pnpm build
  ```

### Step 3: Documentation & Delivery

- [ ] No documentation updates required for this bug fix (UI behavior fix only)
- [ ] Verify the fix resolves the user-facing issue
- [ ] If out-of-scope findings are discovered, create new tasks via `task_create` tool

## Documentation Requirements

**Must Update:**
- None (this is a bug fix that restores expected behavior)

**Check If Affected:**
- None

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing, including the previously failing "resets search when dropdown closes and reopens" test
- [ ] Build passes

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-166): complete Step N — description`
- **Bug fixes:** `fix(KB-166): description`
- **Tests:** `test(KB-166): description`

## Do NOT

- Expand task scope beyond fixing the search reset bug
- Skip running the full test suite
- Modify files outside the File Scope without good reason
- Commit without the task ID prefix
- Refactor unrelated code in TaskDetailModal
