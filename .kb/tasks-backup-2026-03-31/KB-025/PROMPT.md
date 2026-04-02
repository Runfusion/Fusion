# Task: KB-025 - Add Per-Task Model and Validator Model Selections on Dashboard

**Created:** 2026-03-30
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** This feature touches core types, dashboard UI, and engine execution paths. Model selection affects task execution behavior and cost, requiring careful validation and clear UI indicators.
**Score:** 5/8 — Blast radius: 1 (moderate - affects task execution), Pattern novelty: 1 (follows existing settings pattern), Security: 1 (model selection affects cost but no direct security risk), Reversibility: 2 (fully reversible - unset to use defaults)

## Mission

Add the ability to override the global AI model selection on a per-task basis via the dashboard UI. Users should be able to optionally select different models for the executor agent (task implementation) and validator agent (code review), with a clear indication that defaults are used when not specified.

## Dependencies

- **None**

## Context to Read First

1. `packages/core/src/types.ts` — Task type definition and existing optional fields pattern
2. `packages/dashboard/app/components/TaskDetailModal.tsx` — Tab-based modal UI pattern (Definition, Agent Log, Steering tabs)
3. `packages/dashboard/app/components/SettingsModal.tsx` — Model selector implementation (Model section)
4. `packages/dashboard/app/api.ts` — API functions including `fetchModels` and `updateTask`
5. `packages/dashboard/src/routes.ts` — PATCH /tasks/:id endpoint
6. `packages/engine/src/executor.ts` — How `createKbAgent` is called with defaultProvider/defaultModelId
7. `packages/engine/src/reviewer.ts` — How `reviewStep` is called with model options

## File Scope

- `packages/core/src/types.ts` — Add model override fields to Task interface
- `packages/core/src/store.ts` — Update updateTask to persist model fields
- `packages/dashboard/src/routes.ts` — Extend PATCH endpoint to accept model fields
- `packages/dashboard/app/api.ts` — No changes needed (updateTask already accepts flexible updates)
- `packages/dashboard/app/components/TaskDetailModal.tsx` — Add "Model" tab
- `packages/dashboard/app/components/ModelSelectorTab.tsx` — New component for model selection UI
- `packages/engine/src/executor.ts` — Use per-task model overrides when executing
- `packages/engine/src/reviewer.ts` — Use per-task validator model overrides when reviewing

## Steps

### Step 1: Core Types and Store Updates

- [ ] Add four optional fields to `Task` interface in `packages/core/src/types.ts`:
  - `modelProvider?: string` — Override for executor agent
  - `modelId?: string` — Override for executor agent  
  - `validatorModelProvider?: string` — Override for reviewer agent
  - `validatorModelId?: string` — Override for reviewer agent
- [ ] Update `updateTask` method in `packages/core/src/store.ts` to accept and persist these fields
- [ ] Write unit tests for store update with model fields

**Artifacts:**
- `packages/core/src/types.ts` (modified)
- `packages/core/src/store.ts` (modified)

### Step 2: API Route Updates

- [ ] Extend PATCH `/tasks/:id` endpoint in `packages/dashboard/src/routes.ts` to accept `modelProvider`, `modelId`, `validatorModelProvider`, `validatorModelId`
- [ ] Validate that provided model values are strings (or undefined)
- [ ] Write route tests for model field updates

**Artifacts:**
- `packages/dashboard/src/routes.ts` (modified)

### Step 3: Dashboard UI — Model Selector Tab

- [ ] Create new `ModelSelectorTab.tsx` component in `packages/dashboard/app/components/`
- [ ] Fetch available models via `fetchModels()` API (same pattern as SettingsModal)
- [ ] Display two model selectors:
  - **Executor Model**: "Use default" option + list of available models (grouped by provider)
  - **Validator Model**: "Use default" option + list of available models (grouped by provider)
- [ ] Show current selection state clearly (when using defaults vs custom)
- [ ] Add save/reset buttons — save calls `updateTask()` with model fields, reset clears overrides
- [ ] Handle loading and error states for model fetch
- [ ] Write component tests for ModelSelectorTab

**Artifacts:**
- `packages/dashboard/app/components/ModelSelectorTab.tsx` (new)
- `packages/dashboard/app/components/__tests__/ModelSelectorTab.test.tsx` (new)

### Step 4: Dashboard UI — TaskDetailModal Integration

- [ ] Add "Model" tab to `TaskDetailModal` (between "Steering" and modal actions)
- [ ] Import and render `ModelSelectorTab` component in the Model tab
- [ ] Pass task and addToast props to ModelSelectorTab
- [ ] Write integration tests for the new tab in TaskDetailModal

**Artifacts:**
- `packages/dashboard/app/components/TaskDetailModal.tsx` (modified)

### Step 5: Engine — Use Per-Task Model Overrides in Executor

- [ ] In `packages/engine/src/executor.ts`, before calling `createKbAgent()`:
  - Read task's `modelProvider` and `modelId` fields
  - Use per-task values if both are set, otherwise fall back to `settings.defaultProvider`/`settings.defaultModelId`
- [ ] Pass resolved values to `createKbAgent()` as `defaultProvider` and `defaultModelId`
- [ ] Write tests verifying per-task model selection takes precedence over global settings

**Artifacts:**
- `packages/engine/src/executor.ts` (modified)

### Step 6: Engine — Use Per-Task Validator Model Overrides in Reviewer

- [ ] In `packages/engine/src/executor.ts` `createReviewStepTool()`:
  - When calling `reviewStep()`, pass `task.validatorModelProvider` and `task.validatorModelId` via the options object
- [ ] In `packages/engine/src/reviewer.ts` `reviewStep()`:
  - Use `options.validatorModelProvider`/`options.validatorModelId` if both set
  - Fall back to `options.defaultProvider`/`options.defaultModelId` (existing behavior)
- [ ] Update `ReviewOptions` interface to include validator model fields
- [ ] Write tests verifying per-task validator model selection

**Artifacts:**
- `packages/engine/src/executor.ts` (modified)
- `packages/engine/src/reviewer.ts` (modified)

### Step 7: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full test suite: `pnpm test`
- [ ] Fix all failures
- [ ] Build passes: `pnpm build`
- [ ] Manual verification: Open task detail modal, verify Model tab appears, verify model selection works end-to-end

### Step 8: Documentation & Delivery

- [ ] Update relevant documentation (AGENTS.md) to document per-task model selection feature
- [ ] Verify no out-of-scope findings need new tasks

## Documentation Requirements

**Must Update:**
- `AGENTS.md` — Add section explaining per-task model overrides and how they interact with global settings

**Check If Affected:**
- `README.md` — Update if there's a feature list section

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Documentation updated
- [ ] Per-task model selection works via dashboard UI
- [ ] Validator model selection works via dashboard UI
- [ ] Default models are used when per-task overrides not set
- [ ] UI clearly indicates when using defaults vs custom models

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-025): complete Step N — description`
- **Bug fixes:** `fix(KB-025): description`
- **Tests:** `test(KB-025): description`

## Do NOT

- Expand task scope to include triage model selection (triage should continue using global defaults)
- Skip tests for the new model selection UI
- Modify files outside the File Scope without good reason
- Commit without the task ID prefix
- Remove the global default model settings (they serve as fallback)
- Allow selecting only provider without modelId (both must be set together)
