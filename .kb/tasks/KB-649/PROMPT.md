# Task: KB-649 - Fix Add Command Step and Add AI Prompt Step in Scheduled Task Editor

**Created:** 2026-04-01
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** This is a focused UI bug fix in the scheduled task editor. The issue involves form validation and step state management in the Multi-Step mode. Low blast radius—changes are isolated to ScheduleForm and ScheduleStepsEditor components.
**Score:** 2/8 — Blast radius: 0, Pattern novelty: 0, Security: 1, Reversibility: 1

## Mission

Fix the "Add Command Step" and "Add AI Prompt Step" buttons in the scheduled task editor so users can successfully create multi-step scheduled tasks. The current bug prevents step addition from working correctly—either the steps don't appear, can't be edited, or cause validation errors when the schedule is saved.

The root issue is a mismatch between client-side step creation (which creates steps with empty required fields) and server-side validation (which requires fully populated steps). The fix involves:
1. Improving client-side validation to ensure steps are complete before form submission
2. Ensuring the step editor UI opens correctly when adding new steps
3. Providing clear error messages when steps are incomplete

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/components/ScheduleStepsEditor.tsx` — Component for editing automation steps
- `packages/dashboard/app/components/ScheduleForm.tsx` — Form component that uses ScheduleStepsEditor
- `packages/dashboard/src/routes.ts` — Server-side automation routes with `validateAutomationSteps` function
- `packages/dashboard/app/components/__tests__/ScheduleStepsEditor.test.tsx` — Existing tests for step editor
- `packages/core/src/automation.ts` — TypeScript types for AutomationStep

## File Scope

- `packages/dashboard/app/components/ScheduleStepsEditor.tsx`
- `packages/dashboard/app/components/ScheduleForm.tsx`
- `packages/dashboard/app/components/__tests__/ScheduleForm.test.tsx`

## Steps

### Step 1: Diagnose and Fix Step Addition Flow

- [ ] Verify that `handleAddStep` in ScheduleStepsEditor correctly creates steps and opens the step editor
- [ ] Check that `createEmptyStep` generates valid initial step objects with all required fields present (even if empty)
- [ ] Ensure the `editingStepId` state is properly set when adding a new step
- [ ] Verify the StepEditor component renders correctly for newly added steps
- [ ] Add targeted tests for step addition flow

**Artifacts:**
- `packages/dashboard/app/components/ScheduleStepsEditor.tsx` (modified)

### Step 2: Fix Form Validation for Multi-Step Schedules

- [ ] Update `validate()` in ScheduleForm to check that all steps have required content:
  - For command steps: non-empty `command` field
  - For ai-prompt steps: non-empty `prompt` field
- [ ] Update `validate()` to check that no steps are currently being edited (have unsaved changes)
- [ ] Add specific error messages for incomplete steps (e.g., "Step 1: Command is required")
- [ ] Ensure form validation prevents submission when steps are incomplete

**Artifacts:**
- `packages/dashboard/app/components/ScheduleForm.tsx` (modified)

### Step 3: Add Integration Tests for Multi-Step Flow

- [ ] Add test for switching to Multi-Step mode and adding a command step
- [ ] Add test for adding an AI prompt step
- [ ] Add test that validation prevents submission with incomplete steps
- [ ] Add test for successfully creating a multi-step schedule with valid steps
- [ ] Add test for editing an existing multi-step schedule

**Artifacts:**
- `packages/dashboard/app/components/__tests__/ScheduleForm.test.tsx` (modified)

### Step 4: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run ScheduleStepsEditor tests: `pnpm test --run ScheduleStepsEditor`
- [ ] Run ScheduleForm tests: `pnpm test --run ScheduleForm`
- [ ] Run full dashboard test suite: `cd packages/dashboard && pnpm test --run`
- [ ] Manual verification: Open Scheduled Tasks modal, create new schedule, switch to Multi-Step mode, add command and AI prompt steps, fill them in, save successfully

### Step 5: Documentation & Delivery

- [ ] Verify no documentation updates needed (this is a bug fix)
- [ ] Create changeset file for the fix
- [ ] Ensure all tests pass

## Documentation Requirements

**Must Update:**
- None (bug fix)

**Check If Affected:**
- None

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing (ScheduleStepsEditor, ScheduleForm, and full dashboard suite)
- [ ] Manual verification confirms:
  - Can add command steps in Multi-Step mode
  - Can add AI prompt steps in Multi-Step mode
  - Step editor opens automatically when adding steps
  - Form validation prevents submission with incomplete steps
  - Can successfully create and save multi-step scheduled tasks

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `fix(KB-649): complete Step N — description`
- **Bug fixes:** `fix(KB-649): description`
- **Tests:** `test(KB-649): description`

## Do NOT

- Expand task scope to include other scheduled task improvements
- Skip tests or rely on manual verification only
- Modify server-side validation logic (focus on client-side fixes)
- Change the AutomationStep type definition
- Commit without the task ID prefix
