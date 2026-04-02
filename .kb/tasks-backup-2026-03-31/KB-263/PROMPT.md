# Task: KB-263 - Fix text not being passed into Planning Mode from quick entry

**Created:** 2026-03-31
**Size:** S

## Review Level: 0 (None)

**Assessment:** This is a straightforward React hook dependency bug in a single component. The fix involves correcting useEffect dependencies and callback references to ensure the initial plan text is properly captured and passed to the planning session.
**Score:** 2/8 — Blast radius: 0, Pattern novelty: 0, Security: 0, Reversibility: 2

## Mission

Fix a bug where text entered in the QuickEntryBox or InlineCreateCard "Add task" area is not being passed into the Planning Mode modal when the "Plan" button is clicked. The planning modal should auto-start with the entered text pre-filled.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/components/PlanningModeModal.tsx` — The component with the bug. Focus on the auto-start useEffect (lines ~95-110) and the `handleStartPlanningWithPlan` callback.
- `packages/dashboard/app/components/QuickEntryBox.tsx` — How the Plan button triggers planning mode via `handlePlanClick`.
- `packages/dashboard/app/components/__tests__/PlanningModeModal.test.tsx` — Existing test that verifies auto-start behavior (`"auto-starts planning when initialPlan prop is provided"`).

## File Scope

- `packages/dashboard/app/components/PlanningModeModal.tsx`

## Steps

### Step 1: Analyze the Bug

- [ ] Read the auto-start useEffect in PlanningModeModal (around lines 95-110)
- [ ] Identify the stale closure: `handleStartPlanningWithPlan` is used but not in the effect's dependency array
- [ ] Note that `handleStartPlanningWithPlan` has an empty dependency array `}, [])` and captures no dependencies
- [ ] Confirm the effect's dependency array is `[isOpen, initialPlanProp, view.type]` but missing the callback

### Step 2: Implement the Fix

- [ ] Remove the separate `handleStartPlanningWithPlan` callback (it's redundant with `handleStartPlanning`)
- [ ] Modify `handleStartPlanning` to accept an optional `planOverride?: string` parameter
- [ ] Update `handleStartPlanning` to use the override if provided, otherwise fall back to `initialPlan` state
- [ ] Update the auto-start useEffect to call `handleStartPlanning(initialPlanProp)` directly (with proper dependency handling)
- [ ] Ensure the effect dependency array includes all referenced values to prevent future stale closures

**Key changes needed:**
1. Change `handleStartPlanning` signature to: `const handleStartPlanning = useCallback(async (planOverride?: string) => { ... }, [...])`
2. Inside `handleStartPlanning`, use `const plan = planOverride ?? initialPlan;` 
3. Remove `handleStartPlanningWithPlan` entirely
4. Update the auto-start effect to call `handleStartPlanning(initialPlanProp)` within a setTimeout (to allow state batching)
5. Add `handleStartPlanning` to the effect's dependency array

### Step 3: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run dashboard tests: `cd packages/dashboard && pnpm test`
- [ ] Verify the existing test `"auto-starts planning when initialPlan prop is provided"` still passes
- [ ] Verify the existing test `"sets initial plan text in textarea when initialPlan prop is provided"` still passes
- [ ] If tests fail, fix the underlying issue (not the test)

### Step 4: Documentation & Delivery

- [ ] Create changeset file for the bug fix (patch bump): `.changeset/fix-planning-mode-text-passing.md`
- [ ] Verify no other files need updates

## Documentation Requirements

**Must Update:**
- None (this is a bug fix with no user-facing documentation changes)

**Check If Affected:**
- None

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Changeset file created

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-263): complete Step N — description`
- **Bug fixes:** `fix(KB-263): description`
- **Tests:** `test(KB-263): description`

## Do NOT

- Expand task scope beyond fixing this specific bug
- Skip tests
- Modify files outside the File Scope without good reason
- Commit without the task ID prefix
