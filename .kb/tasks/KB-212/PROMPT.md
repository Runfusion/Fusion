# Task: KB-212 - Show Actual Default Model in Agent Log Viewer

**Created:** 2026-03-30
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** Small UI enhancement with limited blast radius. Modifies model display logic in a single component, requires prop drilling through one parent, and updates related tests.
**Score:** 3/8 — Blast radius: 1, Pattern novelty: 0, Security: 0, Reversibility: 2

## Mission

Enhance the Agent Log Viewer in the dashboard to display the actual default model name (e.g., "anthropic/claude-sonnet-4-5") instead of the generic "Using default" text when a task has no per-task model override. This provides users with immediate visibility into which AI model is actually processing their task.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/components/AgentLogViewer.tsx` — The component that displays model info in the agent log header
- `packages/dashboard/app/components/TaskDetailModal.tsx` — Parent component that renders AgentLogViewer and has access to task data
- `packages/dashboard/app/App.tsx` — Root component that fetches global settings including `defaultProvider` and `defaultModelId`
- `packages/core/src/types.ts` — Settings type definition showing `defaultProvider` and `defaultModelId` fields

## File Scope

- `packages/dashboard/app/components/AgentLogViewer.tsx` — Modify to accept and display default model settings
- `packages/dashboard/app/components/TaskDetailModal.tsx` — Pass default model settings from App.tsx down to AgentLogViewer
- `packages/dashboard/app/App.tsx` — Fetch and store default model settings, pass to TaskDetailModal
- `packages/dashboard/app/components/__tests__/AgentLogViewer.test.tsx` — Update tests to verify new behavior

## Steps

### Step 1: Fetch Default Model Settings in App.tsx

- [ ] Add state for `defaultProvider` and `defaultModelId` in `AppInner` component
- [ ] Update the `fetchSettings` useEffect to extract and store these values
- [ ] Pass these values as props to `TaskDetailModal`

**Artifacts:**
- `packages/dashboard/app/App.tsx` (modified)

### Step 2: Update TaskDetailModal Props and Propagate to AgentLogViewer

- [ ] Add `defaultProvider` and `defaultModelId` optional props to `TaskDetailModalProps` interface
- [ ] Pass these values to the `AgentLogViewer` component as `defaultExecutorModel` and `defaultValidatorModel` props (or a combined object)

**Artifacts:**
- `packages/dashboard/app/components/TaskDetailModal.tsx` (modified)

### Step 3: Update AgentLogViewer to Display Actual Default Model

- [ ] Add `defaultExecutorModel?: ModelInfo | null` and `defaultValidatorModel?: ModelInfo | null` props to `AgentLogViewerProps`
- [ ] Modify the model header rendering logic:
  - When `hasExecutorOverride` is true: display the override model (current behavior)
  - When `hasExecutorOverride` is false AND `defaultExecutorModel` is provided: display the default model with a "(default)" suffix
  - When `hasExecutorOverride` is false AND no default is provided: display "Using default" (fallback)
- [ ] Apply same logic for validator model
- [ ] Ensure ProviderIcon is shown for default models too

**Artifacts:**
- `packages/dashboard/app/components/AgentLogViewer.tsx` (modified)

### Step 4: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Update `AgentLogViewer.test.tsx` to test the new behavior:
  - Test that default model is displayed when no override is set and default is provided
  - Test that "Using default" is shown when no override and no default provided
  - Test that override model takes precedence over default
  - Test that ProviderIcon renders for default models
- [ ] Run dashboard tests: `cd packages/dashboard && pnpm test`
- [ ] Fix all failures
- [ ] Build passes: `pnpm build`

### Step 5: Documentation & Delivery

- [ ] Update any relevant documentation about model display in the UI
- [ ] Verify the UI shows actual model names instead of generic "Using default"
- [ ] Out-of-scope findings created as new tasks via `task_create` tool (if any)

## Documentation Requirements

**Must Update:**
- None — this is a self-documenting UI enhancement

**Check If Affected:**
- `AGENTS.md` — Check if model display behavior is documented; update if relevant

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Agent Log Viewer shows actual default model name (e.g., "anthropic/claude-sonnet-4-5 (default)") when task has no override
- [ ] Fallback "Using default" text still appears when no global default is configured
- [ ] Build passes

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-212): complete Step N — description`
- **Bug fixes:** `fix(KB-212): description`
- **Tests:** `test(KB-212): description`

## Do NOT

- Expand task scope to include other model-related UI changes
- Skip tests or rely on manual verification only
- Modify the global settings API or backend behavior
- Change how models are selected or stored — only how they are displayed
- Break existing behavior for tasks with explicit model overrides
