# Task: KB-125 - Fix "Enable Planning Mode" Checkbox in New Task Dialog

**Created:** 2026-03-30
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** This requires modifying the NewTaskModal to integrate with PlanningModeModal flow when the planning mode checkbox is enabled. Changes touch component state management, event flow between modals, and require new test coverage.
**Score:** 5/8 — Blast radius: 2, Pattern novelty: 1, Security: 0, Reversibility: 2

## Mission

The "Enable planning mode" checkbox in the New Task dialog currently exists as UI-only state that doesn't actually trigger the planning flow. When checked, it should:
1. Skip immediate task creation
2. Close the NewTaskModal 
3. Open PlanningModeModal with the description as the initial plan
4. After planning completes, create the task from the planning session

Currently, the checkbox state (`enablePlanningMode`) is tracked but ignored during submission — there's even a TODO comment in the code acknowledging this gap.

## Dependencies

- **None** — The PlanningModeModal component already exists and is functional

## Context to Read First

- `packages/dashboard/app/components/NewTaskModal.tsx` — The modal with the broken checkbox (see `enablePlanningMode` state around line 141, `handleSubmit` around line 220 with the TODO comment)
- `packages/dashboard/app/components/PlanningModeModal.tsx` — The planning modal that should be triggered (see `onTaskCreated` callback prop)
- `packages/dashboard/app/App.tsx` — How both modals are currently wired (lines 160-175 for PlanningModeModal, lines 137-138 for NewTaskModal)
- `packages/dashboard/app/components/__tests__/NewTaskModal.test.tsx` — Existing test patterns
- `packages/dashboard/app/api.ts` — `createTaskFromPlanning` function (used by PlanningModeModal)

## File Scope

- `packages/dashboard/app/components/NewTaskModal.tsx` — Modify submit logic to support planning mode flow
- `packages/dashboard/app/App.tsx` — Add callback prop to NewTaskModal for planning mode trigger
- `packages/dashboard/app/components/__tests__/NewTaskModal.test.tsx` — Add tests for planning mode flow

## Steps

### Step 0: Preflight

- [ ] Read all Context to Read First files
- [ ] Verify project builds: `pnpm build`
- [ ] Verify tests pass: `pnpm test`

### Step 1: Add Planning Mode Callback Prop to NewTaskModal

Modify NewTaskModal to accept a callback that triggers planning mode instead of direct task creation.

- [ ] Add `onPlanningMode: (initialPlan: string) => void` prop to `NewTaskModalProps` interface
- [ ] When `enablePlanningMode` is true in `handleSubmit`:
  - Call `onClose()` to close the modal
  - Call `onPlanningMode(description.trim())` to pass the description as the initial plan
  - Skip the normal `onCreateTask` flow entirely
  - Clear form state (same as after successful creation)
- [ ] When `enablePlanningMode` is false, keep existing normal task creation flow
- [ ] The checkbox should be disabled during submission to prevent race conditions

**Artifacts:**
- `packages/dashboard/app/components/NewTaskModal.tsx` (modified)

### Step 2: Wire Up Planning Mode Flow in App.tsx

Connect NewTaskModal's planning mode trigger to open PlanningModeModal with the initial plan.

- [ ] Add `planningInitialPlan` state in `AppInner` (string | null)
- [ ] Create `handleNewTaskPlanningMode` callback that:
  - Sets `planningInitialPlan` to the provided initial plan string
  - Opens PlanningModeModal by calling `handlePlanningOpen()`
- [ ] Pass `handleNewTaskPlanningMode` as `onPlanningMode` prop to `NewTaskModal`
- [ ] Modify `PlanningModeModal` to accept optional `initialPlan` prop
- [ ] When `PlanningModeModal` opens with `initialPlan` set, auto-start planning with that text
- [ ] After planning completes (task created or cancelled), clear `planningInitialPlan`

**Artifacts:**
- `packages/dashboard/app/App.tsx` (modified)

### Step 3: Auto-Start Planning in PlanningModeModal

When the modal opens with a pre-populated initial plan, automatically start the planning session.

- [ ] Add optional `initialPlan?: string` prop to `PlanningModeModalProps`
- [ ] In `PlanningModeModal`, when `initialPlan` is provided and modal opens:
  - Set `initialPlan` into the textarea state
  - Automatically call `handleStartPlanning()` to begin the planning flow
  - Clear `initialPlan` from parent after starting (via callback or effect cleanup)
- [ ] Ensure the planning session starts without requiring user to click "Start Planning"

**Artifacts:**
- `packages/dashboard/app/components/PlanningModeModal.tsx` (modified)

### Step 4: Write Tests

Add comprehensive tests for the planning mode checkbox flow.

- [ ] Test: When planning mode is checked and form submitted, `onPlanningMode` is called with description
- [ ] Test: When planning mode is checked, normal `onCreateTask` is NOT called
- [ ] Test: When planning mode is unchecked, normal task creation flow works as before
- [ ] Test: Form state is cleared after planning mode trigger (same as normal creation)
- [ ] Test: Modal closes after triggering planning mode
- [ ] Test: Checkbox is disabled during submission when planning mode is enabled
- [ ] Test: PlanningModeModal auto-starts when given initialPlan prop

**Artifacts:**
- `packages/dashboard/app/components/__tests__/NewTaskModal.test.tsx` (modified)
- `packages/dashboard/app/components/PlanningModeModal.test.tsx` (modified)

### Step 5: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full test suite: `pnpm test`
- [ ] Fix all failures
- [ ] Build passes: `pnpm build`
- [ ] Manually verify:
  - Open New Task dialog
  - Enter a description like "Build a login system"
  - Check "Enable planning mode"
  - Click Create Task
  - PlanningModeModal should open with the description pre-filled
  - Planning session should auto-start (show "Thinking..." then questions)
  - Complete planning flow should create the task with refined title/description

### Step 6: Documentation & Delivery

- [ ] Create changeset file (patch bump for `@dustinbyrne/kb` — bug fix):
  ```bash
  cat > .changeset/fix-planning-mode-checkbox.md << 'EOF'
  ---
  "@dustinbyrne/kb": patch
  ---
  
  Fix "Enable planning mode" checkbox to actually trigger the planning flow before task creation.
  EOF
  ```
- [ ] Out-of-scope findings: Create tasks for any related UI improvements discovered

## Documentation Requirements

**Must Update:**
- None — this is a bug fix making existing UI work as advertised

**Check If Affected:**
- `packages/dashboard/README.md` — Update if it documents the new task flow

## Completion Criteria

- [ ] All steps complete
- [ ] Checking "Enable planning mode" and clicking Create Task opens PlanningModeModal
- [ ] Description is passed to PlanningModeModal as initial plan
- [ ] Planning session auto-starts with the initial plan
- [ ] After planning completes, task is created with refined specification
- [ ] Unchecked planning mode still creates task normally
- [ ] All tests passing
- [ ] Build passes
- [ ] Changeset created

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-125): complete Step N — description`
- **Bug fixes:** `fix(KB-125): description`
- **Tests:** `test(KB-125): description`

## Do NOT

- Remove or change the existing PlanningModeModal standalone flow (Header menu item)
- Add backend changes — the planning APIs already exist and work
- Change the visual design of either modal (out of scope)
- Skip writing tests for the new flow
- Modify the task creation API — planning creates tasks via existing `createTaskFromPlanning` endpoint
