# Task: KB-078 - Fix Progress Bar Out of Sync with Task List on Dashboard Cards

**Created:** 2026-03-30
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** This is a straightforward UI bug fix with limited blast radius. The fix requires changing a single filter condition and adding a test case. No security implications and fully reversible.
**Score:** 2/8 — Blast radius: 0, Pattern novelty: 0, Security: 0, Reversibility: 2

## Mission

The task card progress bar on the dashboard is not synchronized with the step list display. The progress bar only counts steps with status "done" as complete, but steps can also have a "skipped" status which represents completed work (intentionally bypassed). This causes the progress percentage and counter (e.g., "2/4") to under-report completion when steps are skipped, creating a confusing visual discrepancy between the progress bar and the expanded step list.

Fix the progress calculation in TaskCard to treat both "done" and "skipped" step statuses as completed, ensuring the progress bar accurately reflects the task's true completion state.

## Dependencies

- **None**

## Context to Read First

- `packages/core/src/types.ts` — Review `StepStatus` type definition (`"pending" | "in-progress" | "done" | "skipped"`)
- `packages/dashboard/app/components/TaskCard.tsx` — Current progress calculation logic (lines ~390-400)
- `packages/dashboard/app/styles.css` — Verify CSS classes exist for `card-step-dot--skipped`
- `packages/dashboard/app/components/__tests__/TaskCard.test.tsx` — Existing test patterns for reference

## File Scope

- `packages/dashboard/app/components/TaskCard.tsx` — Modify progress calculation
- `packages/dashboard/app/components/__tests__/TaskCard.test.tsx` — Add test coverage for skipped steps

## Steps

### Step 1: Fix Progress Calculation in TaskCard

- [ ] Update `completedSteps` calculation to include "skipped" status
- [ ] Change: `task.steps.filter(s => s.status === "done")` 
- [ ] To: `task.steps.filter(s => s.status === "done" || s.status === "skipped")`
- [ ] Verify the progress label (`completedSteps/totalSteps`) and progress bar width both update correctly
- [ ] Run dashboard tests to ensure no regressions

**Artifacts:**
- `packages/dashboard/app/components/TaskCard.tsx` (modified)

### Step 2: Add Test Coverage for Skipped Steps

- [ ] Add test case: progress bar counts skipped steps as completed
- [ ] Add test case: step list renders skipped status with correct CSS class
- [ ] Verify tests pass with both "done" and "skipped" steps

**Artifacts:**
- `packages/dashboard/app/components/__tests__/TaskCard.test.tsx` (modified)

### Step 3: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full test suite: `pnpm test`
- [ ] Build passes: `pnpm build`
- [ ] Manual verification: Create a task with mixed "done" and "skipped" steps, verify progress bar shows correct completion count

### Step 4: Documentation & Delivery

- [ ] No documentation updates required (bug fix)
- [ ] Create changeset file for the fix

**Changeset:**
```bash
cat > .changeset/fix-progress-bar-skipped-steps.md << 'EOF'
---
"@dustinbyrne/kb": patch
---

Fix progress bar on dashboard cards to include skipped steps in completion count.
EOF
```

## Completion Criteria

- [ ] Progress bar in TaskCard counts both "done" and "skipped" steps as completed
- [ ] Progress label shows correct fraction (e.g., "3/4" when 2 done + 1 skipped out of 4 total)
- [ ] All tests pass including new test cases for skipped step handling
- [ ] Changeset file included in commit

## Git Commit Convention

- **Step 1:** `feat(KB-078): include skipped steps in TaskCard progress calculation`
- **Step 2:** `test(KB-078): add test coverage for skipped steps in progress bar`
- **Step 3:** `fix(KB-078): create changeset for progress bar fix`

## Do NOT

- Modify step status definitions or allowed values
- Change how "skipped" is displayed in the step list (CSS/styling)
- Affect TaskDetailModal progress display (it already handles all statuses correctly)
- Skip tests or rely on typecheck alone
