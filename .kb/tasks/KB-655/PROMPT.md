# Task: KB-655 - Hide done by default on list view

**Created:** 2026-04-01
**Size:** S

## Review Level: 0 (None)

**Assessment:** Simple default value change from `false` to `true` for an existing feature. No new patterns, low blast radius, fully reversible.
**Score:** 0/8 — Blast radius: 0, Pattern novelty: 0, Security: 0, Reversibility: 0

## Mission

Change the default value of the `hideDoneTasks` state in the ListView component so that completed (done and archived) tasks are hidden by default when users view the list view for the first time or have no saved preference. The existing toggle functionality and localStorage persistence remain unchanged.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/components/ListView.tsx` — The list view component containing the `hideDoneTasks` state

## File Scope

- `packages/dashboard/app/components/ListView.tsx` — Modify the `useState` default value
- `packages/dashboard/app/components/__tests__/ListView.test.tsx` — Update/add test for default behavior

## Steps

### Step 1: Change Default Value

- [ ] In `ListView.tsx`, locate the `hideDoneTasks` useState initialization (around line 67-80)
- [ ] Change the default return value from `false` to `true`:
  ```typescript
  // Before:
  return false; // Default: show done tasks
  
  // After:
  return true; // Default: hide done tasks
  ```
- [ ] Run targeted tests for ListView component

**Artifacts:**
- `packages/dashboard/app/components/ListView.tsx` (modified)

### Step 2: Update Tests

- [ ] In `ListView.test.tsx`, locate the "ListView Hide Done Tasks" describe block
- [ ] Update or add a test that verifies done tasks are hidden by default when no localStorage value exists
- [ ] Ensure the test explicitly clears localStorage before rendering to verify default behavior
- [ ] Run the ListView tests to confirm they pass

**Artifacts:**
- `packages/dashboard/app/components/__tests__/ListView.test.tsx` (modified)

### Step 3: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full test suite: `pnpm test`
- [ ] Fix all failures
- [ ] Build passes: `pnpm build`

### Step 4: Documentation & Delivery

- [ ] No documentation updates required (behavioral change only)
- [ ] Verify no out-of-scope findings

## Documentation Requirements

**Must Update:**
- None

**Check If Affected:**
- None

## Completion Criteria

- [ ] Default value changed from `false` to `true`
- [ ] Test updated to verify new default behavior
- [ ] All tests passing
- [ ] Build passes

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-655): complete Step N — description`
- **Bug fixes:** `fix(KB-655): description`
- **Tests:** `test(KB-655): description`

## Do NOT

- Expand task scope beyond changing the default value
- Skip tests
- Modify files outside the File Scope without good reason
- Change the localStorage key or persistence behavior
- Modify the UI toggle button or its behavior
- Change the filtering logic (only the default)
