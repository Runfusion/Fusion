# Task: KB-229 - Multi-Step Scheduled Tasks with Command and AI Prompt Steps

**Created:** 2026-03-31
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** This task extends the scheduled task system with multi-step workflows. It involves data model changes, execution engine modifications, API updates, and UI components. The blast radius is moderate (confined to automation system), but pattern novelty is moderate (new step-based execution model).
**Score:** 5/8 — Blast radius: 1, Pattern novelty: 1, Security: 1, Reversibility: 2

## Mission

Extend the scheduled task system to support multi-step workflows. Each step can be either:
- **Command step**: A shell command to execute
- **AI Prompt step**: An AI prompt with configurable model selection

Users can add, remove, and reorder steps. When a scheduled task runs, all steps execute sequentially with failure handling. This enables complex automation workflows like "run tests, then if they pass, create a summary with AI and post to Slack."

## Dependencies

- **None**

## Context to Read First

- `packages/core/src/automation.ts` — Current scheduled task types
- `packages/core/src/automation-store.ts` — Store operations for scheduled tasks
- `packages/engine/src/cron-runner.ts` — Execution engine for scheduled tasks
- `packages/dashboard/src/routes.ts` — API routes for scheduled tasks (search for `/automations`)
- `packages/dashboard/app/components/ScheduleForm.tsx` — Current schedule creation form
- `packages/dashboard/app/components/ScheduleCard.tsx` — Schedule display card
- `packages/dashboard/app/components/ScheduledTasksModal.tsx` — Modal container
- `packages/dashboard/app/api.ts` — API client functions for automations

## File Scope

### Core (Data Model & Store)
- `packages/core/src/automation.ts` — Add step types and update ScheduledTask interface
- `packages/core/src/automation-store.ts` — Update CRUD operations for steps field
- `packages/core/src/index.ts` — Export new types

### Engine (Execution)
- `packages/engine/src/cron-runner.ts` — Refactor to execute steps sequentially
- `packages/engine/src/cron-runner.test.ts` — Update/add tests for step execution

### Dashboard (API)
- `packages/dashboard/src/routes.ts` — Update automation routes for steps

### Dashboard (UI)
- `packages/dashboard/app/components/ScheduleForm.tsx` — Add step editor UI
- `packages/dashboard/app/components/ScheduleStepsEditor.tsx` — New: Step management component
- `packages/dashboard/app/components/ScheduleCard.tsx` — Display step summary
- `packages/dashboard/app/components/StepTypeBadge.tsx` — New: Visual indicator for step type
- `packages/dashboard/app/api.ts` — Update API types and functions
- `packages/dashboard/app/App.css` — Add styles for step editor

### Tests
- `packages/core/src/automation-store.test.ts` — Add tests for steps persistence
- `packages/dashboard/app/components/__tests__/ScheduleForm.test.tsx` — Update for steps
- `packages/dashboard/app/components/__tests__/ScheduleStepsEditor.test.tsx` — New: Step editor tests

## Steps

### Step 1: Core Data Model — Add Step Types

- [ ] Add `AutomationStepType = "command" | "ai-prompt"` type to `automation.ts`
- [ ] Add `AutomationStep` interface with:
  - `id: string` — Unique step identifier (UUID)
  - `type: AutomationStepType`
  - `name: string` — Human-readable step name
  - `command?: string` — For command steps
  - `prompt?: string` — For AI prompt steps
  - `modelProvider?: string` — For AI prompt steps
  - `modelId?: string` — For AI prompt steps
  - `timeoutMs?: number` — Per-step timeout override
  - `continueOnFailure?: boolean` — Whether to continue to next step if this fails
- [ ] Update `ScheduledTask` interface:
  - Add `steps?: AutomationStep[]` — Optional array of steps
  - Keep `command` for backward compatibility (existing single-command schedules)
  - Add `currentStepIndex?: number` — Track which step is running during execution
- [ ] Update `ScheduledTaskCreateInput` and `ScheduledTaskUpdateInput` to include `steps`
- [ ] Export new types from `packages/core/src/index.ts`

**Artifacts:**
- `packages/core/src/automation.ts` (modified)
- `packages/core/src/index.ts` (modified)

### Step 2: Core Store — Update CRUD for Steps

- [ ] Update `AutomationStore.createSchedule()` to accept and persist `steps` field
- [ ] Update `AutomationStore.updateSchedule()` to handle `steps` field updates
- [ ] Ensure steps are serialized/deserialized correctly in JSON
- [ ] Add helper method `reorderSteps(scheduleId: string, stepIds: string[]): Promise<ScheduledTask>` to reorder steps by ID array
- [ ] Run `automation-store.test.ts` and ensure all existing tests pass
- [ ] Add tests for steps persistence in `automation-store.test.ts`

**Artifacts:**
- `packages/core/src/automation-store.ts` (modified)
- `packages/core/src/automation-store.test.ts` (modified)

### Step 3: Engine — Refactor CronRunner for Step Execution

- [ ] Refactor `executeSchedule()` method to support two modes:
  - **Legacy mode**: When `steps` is undefined/empty, execute `command` directly (current behavior)
  - **Step mode**: When `steps` is present, execute steps sequentially
- [ ] Implement `executeStep(schedule: ScheduledTask, step: AutomationStep, stepIndex: number): Promise<StepResult>` method:
  - For `command` steps: Execute shell command (reuse existing exec logic)
  - For `ai-prompt` steps: Create temporary agent session, run prompt, capture output
- [ ] Add per-step timeout support (falls back to schedule-level timeout)
- [ ] Add `continueOnFailure` handling: If a step fails and `continueOnFailure` is false, stop execution. If true, continue to next step but mark overall result as failure.
- [ ] Track `currentStepIndex` during execution for real-time status
- [ ] Aggregate step results into overall `AutomationRunResult`:
  - `success`: true only if all required steps succeeded
  - `output`: Concatenated output from all steps with step headers
  - `error`: Summary of which step(s) failed
- [ ] Add step execution events/metrics for observability
- [ ] Update `cron-runner.test.ts` with tests for:
  - Legacy single-command mode still works
  - Multi-step command execution
  - Step failure handling with/without `continueOnFailure`
  - Per-step timeouts
  - AI prompt step execution (mocked)

**Artifacts:**
- `packages/engine/src/cron-runner.ts` (modified)
- `packages/engine/src/cron-runner.test.ts` (modified)

### Step 4: Dashboard API — Update Routes for Steps

- [ ] Update `POST /api/automations` to accept and validate `steps` array
- [ ] Update `PATCH /api/automations/:id` to accept and validate `steps` array
- [ ] Add validation rules:
  - Each step must have `id`, `type`, and `name`
  - Command steps require `command` field
  - AI prompt steps require `prompt` field
  - Model fields must be both present or both absent
- [ ] Add `POST /api/automations/:id/steps/reorder` endpoint for reordering steps
- [ ] Ensure `GET /api/automations/:id` returns steps field

**Artifacts:**
- `packages/dashboard/src/routes.ts` (modified)

### Step 5: Dashboard UI — Create Step Editor Components

- [ ] Create new `ScheduleStepsEditor.tsx` component:
  - Display steps as a draggable/ordered list
  - Each step shows: type badge, name, and action buttons
  - Support add, edit, delete, reorder operations
  - Use drag handles or up/down buttons for reordering
- [ ] Create `StepEditorModal.tsx` or inline editor for step details:
  - **For command steps**: Textarea for command, timeout override, continueOnFailure checkbox
  - **For AI prompt steps**: Textarea for prompt, model selector dropdown (reuse existing model selector pattern), timeout override, continueOnFailure checkbox
- [ ] Create `StepTypeBadge.tsx` component for visual type indicator (command = terminal icon, AI = sparkles icon)
- [ ] Update `ScheduleForm.tsx`:
  - Add tab or section switcher between "Simple" (legacy command) and "Advanced" (multi-step)
  - When in "Advanced" mode, show `ScheduleStepsEditor` instead of command field
  - At least one step required when in advanced mode
  - Validate steps before submission

**Artifacts:**
- `packages/dashboard/app/components/ScheduleStepsEditor.tsx` (new)
- `packages/dashboard/app/components/StepEditorModal.tsx` (new)
- `packages/dashboard/app/components/StepTypeBadge.tsx` (new)
- `packages/dashboard/app/components/ScheduleForm.tsx` (modified)

### Step 6: Dashboard UI — Update Schedule Display

- [ ] Update `ScheduleCard.tsx`:
  - Add step count indicator when schedule has steps
  - Show step execution progress in run history (which step failed/succeeded)
  - For multi-step schedules, show "X steps" badge instead of command preview
- [ ] Update run history display to show per-step results when expanded
- [ ] Ensure backward compatibility for legacy single-command schedules

**Artifacts:**
- `packages/dashboard/app/components/ScheduleCard.tsx` (modified)

### Step 7: Dashboard API Client — Update Types and Functions

- [ ] Update `api.ts` types:
  - Add `AutomationStep` type import from `@kb/core`
  - Update `ScheduledTaskCreateInput` and `ScheduledTaskUpdateInput` to include steps
- [ ] Add `reorderAutomationSteps(id: string, stepIds: string[]): Promise<ScheduledTask>` function
- [ ] Ensure all existing API functions handle steps field correctly

**Artifacts:**
- `packages/dashboard/app/api.ts` (modified)

### Step 8: Styling

- [ ] Add CSS styles to `App.css` for:
  - Step list container with drag-and-drop visual feedback
  - Step card styling (type badge, name, actions)
  - Step editor modal/layout
  - Step type badges (command = blue, AI = purple)
  - Execution progress indicator

**Artifacts:**
- `packages/dashboard/app/App.css` (modified)

### Step 9: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm test` — all existing tests must pass
- [ ] Run `pnpm build` — must complete without errors
- [ ] Run `packages/core/src/automation-store.test.ts` — verify new step tests pass
- [ ] Run `packages/engine/src/cron-runner.test.ts` — verify step execution tests pass
- [ ] Run `packages/dashboard/app/components/__tests__/ScheduleForm.test.tsx` — verify updated
- [ ] Create `packages/dashboard/app/components/__tests__/ScheduleStepsEditor.test.tsx`:
  - Test step addition
  - Test step deletion
  - Test step reordering
  - Test form validation (step name, command/prompt required)

**Artifacts:**
- `packages/dashboard/app/components/__tests__/ScheduleStepsEditor.test.tsx` (new)
- Test coverage for all modified components

### Step 10: Documentation & Delivery

- [ ] Add changeset file for `@dustinbyrne/kb` package (new feature)
- [ ] Update any relevant documentation about scheduled tasks
- [ ] Test the full flow end-to-end:
  1. Create a multi-step schedule with 2 command steps
  2. Run it manually and verify both execute
  3. Create an AI prompt step schedule
  4. Verify model selection works
  5. Test reordering steps
  6. Test step deletion

**Artifacts:**
- `.changeset/multi-step-scheduled-tasks.md` (new)

## Documentation Requirements

**Must Update:**
- AGENTS.md — Document the new multi-step scheduled task capability (if there's a section on scheduled tasks)

**Check If Affected:**
- README.md — Check if scheduled tasks are documented, update if so

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing (`pnpm test`)
- [ ] Build passes (`pnpm build`)
- [ ] Can create scheduled task with multiple command steps
- [ ] Can create scheduled task with AI prompt steps (with model selection)
- [ ] Steps can be reordered via UI
- [ ] Steps can be deleted via UI
- [ ] All steps execute sequentially when schedule runs
- [ ] Failure handling works correctly (respects `continueOnFailure`)
- [ ] Legacy single-command schedules still work
- [ ] Changeset file included

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-229): complete Step N — description`
- **Bug fixes:** `fix(KB-229): description`
- **Tests:** `test(KB-229): description`

## Do NOT

- Remove or break the existing single-command schedule functionality
- Skip test coverage for the new step execution engine
- Allow step execution to continue without proper error handling
- Break backward compatibility with existing scheduled task data
- Skip validation of AI model selection fields
- Use any external state management beyond what's already in the codebase
