# Task: KB-272 - Add Model Selector for Plan Mode

**Created:** 2026-03-31
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** This task modifies the planning mode UI and backend API. Changes affect both frontend state management and backend session storage. Medium blast radius with established patterns to follow.
**Score:** 5/8 — Blast radius: 1, Pattern novelty: 1, Security: 1, Reversibility: 2

## Mission

Add model selection capabilities to the Planning Mode workflow. Users should be able to select the planning model at the start of the session, and then choose executor and validator models at the end before creating the task. This provides more control over which AI models are used throughout the task lifecycle.

## Dependencies

- **None**

## Context to Read First

1. `packages/dashboard/app/components/PlanningModeModal.tsx` - Current planning mode implementation
2. `packages/dashboard/app/components/PlanningModeModal.test.tsx` - Existing test patterns
3. `packages/dashboard/app/components/NewTaskModal.tsx` - Reference for model selection UI (lines 313-531)
4. `packages/dashboard/app/components/CustomModelDropdown.tsx` - Reusable model dropdown component
5. `packages/dashboard/app/api.ts` - Frontend API functions (lines 960-1020 for planning, lines 80-110 for createTask)
6. `packages/dashboard/src/routes.ts` - Backend `/planning/create-task` endpoint (lines 4036-4080)
7. `packages/dashboard/src/planning.ts` - Backend planning session management
8. `packages/core/src/types.ts` - `PlanningSummary`, `TaskCreateInput`, `PlanningSession` interfaces

## File Scope

### Frontend
- `packages/dashboard/app/components/PlanningModeModal.tsx` (modify)
- `packages/dashboard/app/components/PlanningModeModal.test.tsx` (modify)
- `packages/dashboard/app/api.ts` (modify `createTaskFromPlanning` function)

### Backend
- `packages/dashboard/src/routes.ts` (modify `/planning/create-task` endpoint)
- `packages/dashboard/src/planning.ts` (modify session type and `getSummary`)

## Steps

### Step 1: Backend Session Storage Updates

- [ ] Add `planningModel` field to the `Session` interface in `planning.ts` to store the selected planning model
- [ ] Add `executorModel` and `validatorModel` fields to the `PlanningSummary` type (or store separately in session)
- [ ] Update `createSession` function to accept optional `planningModel` parameter
- [ ] Export a `setSessionModels` function to store executor/validator selections
- [ ] Run backend tests: `pnpm test packages/dashboard/src/planning.test.ts`

**Artifacts:**
- `packages/dashboard/src/planning.ts` (modified)

### Step 2: Backend API Updates

- [ ] Update `/planning/start-streaming` endpoint in `routes.ts` to accept optional `planningModel` body parameter and pass it to `createSession`
- [ ] Update `/planning/create-task` endpoint to:
  - Accept optional `executorModel` and `validatorModel` in request body
  - Pass these to `store.createTask()` when creating the task
  - Fall back to session-stored models if not provided in request
- [ ] Add validation for model fields using existing `assertConsistentOptionalPair` helper
- [ ] Run backend tests: `pnpm test packages/dashboard/src/routes.test.ts`

**Artifacts:**
- `packages/dashboard/src/routes.ts` (modified)

### Step 3: Frontend API Updates

- [ ] Update `startPlanningStreaming` function in `api.ts` to accept optional `planningModel` parameter
- [ ] Update `createTaskFromPlanning` function to accept optional `executorModel` and `validatorModel` parameters
- [ ] Ensure proper type definitions for the new parameters (provider/modelId pairs)

**Artifacts:**
- `packages/dashboard/app/api.ts` (modified)

### Step 4: Planning Mode Initial View - Model Selector

- [ ] Add state for `planningModel` selection in `PlanningModeModal` component
- [ ] Fetch available models using `fetchModels()` on mount (reuse pattern from `NewTaskModal`)
- [ ] Add model selector UI to the initial view (before clicking "Start Planning"):
  - Use `CustomModelDropdown` component for consistency
  - Position below the textarea, above the example chips
  - Label: "Planning Model (optional)"
  - Default to "Use default" (empty string)
- [ ] Update `handleStartPlanning` to pass selected planning model to API
- [ ] Add loading state for models similar to `NewTaskModal`

**Artifacts:**
- `packages/dashboard/app/components/PlanningModeModal.tsx` (modified)

### Step 5: Planning Mode Summary View - Executor/Validator Selectors

- [ ] Add state for `executorModel` and `validatorModel` selections in the summary view
- [ ] Add model selection section to `SummaryView` component:
  - Position after "Suggested Dependencies" section, before "Key Deliverables"
  - Two dropdowns: "Executor Model" and "Validator Model"
  - Use `CustomModelDropdown` component
  - Default both to "Use default" (empty string)
  - Add helper text explaining each model's purpose (reuse from `ModelSelectorTab`)
- [ ] Pass selected models to `handleCreateTask` function
- [ ] Update `handleCreateTask` to pass executor/validator models to `createTaskFromPlanning` API call

**Artifacts:**
- `packages/dashboard/app/components/PlanningModeModal.tsx` (modified)

### Step 6: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Update `PlanningModeModal.test.tsx` with new test cases:
  - Test that planning model selector appears in initial view
  - Test that executor/validator selectors appear in summary view
  - Test that selected models are passed to API calls
  - Test "Use default" behavior (empty selection)
- [ ] Run component tests: `pnpm test packages/dashboard/app/components/PlanningModeModal.test.tsx`
- [ ] Run full test suite: `pnpm test`
- [ ] Fix all failures
- [ ] Build passes: `pnpm build`

### Step 7: Documentation & Delivery

- [ ] Update `AGENTS.md` if planning mode behavior is documented there
- [ ] Create changeset file for the change (patch level - new feature for planning mode)
- [ ] Out-of-scope findings: If model preset integration is needed, create follow-up task

## Documentation Requirements

**Must Update:**
- None (dashboard UI is self-documenting through labels and helper text)

**Check If Affected:**
- `AGENTS.md` — Check if planning mode section exists and update if needed

## Completion Criteria

- [ ] Planning model selector visible in initial view of Planning Mode
- [ ] Executor and validator model selectors visible in summary view
- [ ] All three model selections correctly passed to backend API
- [ ] "Use default" option works correctly for all selectors
- [ ] All tests passing
- [ ] Build passes

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-272): complete Step N — description`
- **Bug fixes:** `fix(KB-272): description`
- **Tests:** `test(KB-272): description`

## Do NOT

- Expand scope to include model presets in planning mode (create follow-up task instead)
- Modify the core planning AI behavior or system prompt
- Change existing task creation flow outside of planning mode
- Skip backend validation for model fields
- Use different UI patterns than established in `NewTaskModal` and `ModelSelectorTab`
