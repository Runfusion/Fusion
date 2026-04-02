# Task: KB-098 - Auto-save model settings with improved toast and badge feedback

**Created:** 2026-03-30
**Size:** S

## Review Level: 2 (Plan and Code)

**Assessment:** This is a focused UI/UX improvement with limited blast radius. Changes are contained to a single component with existing patterns for API calls and toast notifications. Security impact is minimal (same API endpoints), changes are reversible.
**Score:** 4/8 — Blast radius: 1, Pattern novelty: 1, Security: 1, Reversibility: 1

## Mission

Refactor the ModelSelectorTab component to auto-save model settings immediately when the user changes the dropdown selection, removing the need for a manual Save button. Update toast notifications to specify which model was saved (executor or validator, with model name), and ensure the model badge at the top of each selector reflects the saved state immediately after a successful save.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/components/ModelSelectorTab.tsx` — The component to modify
- `packages/dashboard/app/components/__tests__/ModelSelectorTab.test.tsx` — Existing tests (will need updates)
- `packages/dashboard/app/api.ts` — API functions including `updateTask` and `ModelInfo` type
- `packages/dashboard/app/hooks/useToast.ts` — Toast notification system

## File Scope

- `packages/dashboard/app/components/ModelSelectorTab.tsx` (modified)
- `packages/dashboard/app/components/__tests__/ModelSelectorTab.test.tsx` (modified)

## Steps

### Step 1: Refactor ModelSelectorTab for Auto-save

- [ ] Remove the Save and Reset buttons from the UI
- [ ] Remove `hasChanges` state and its `useEffect` (no longer needed)
- [ ] Remove `isSaving` state and replace with per-selector loading states or keep global `isSaving` to disable inputs during save
- [ ] Modify `handleExecutorChange` to call `updateTask` immediately with the new selection
- [ ] Modify `handleValidatorChange` to call `updateTask` immediately with the new selection
- [ ] On successful save, show specific toast: "Executor model set to {provider}/{modelId}" or "Executor model set to default"
- [ ] On successful save, show specific toast: "Validator model set to {provider}/{modelId}" or "Validator model set to default"
- [ ] Track "saved" values separately from "selected" values so the badge shows the confirmed saved state, not the pending selection
- [ ] Handle errors: on save failure, show error toast and revert the dropdown to the previously saved value

**Implementation notes:**
- Use local state to track the saved values (what's confirmed on the server) separately from current selection
- When `updateTask` succeeds, update both the selection state and saved state
- When `updateTask` fails, revert selection state to saved state and show error toast
- Use `try/catch/finally` pattern consistent with existing `handleSave` function
- Keep the loading state to disable the select during API call to prevent race conditions

**Artifacts:**
- `packages/dashboard/app/components/ModelSelectorTab.tsx` (modified)

### Step 2: Update Tests for Auto-save Behavior

- [ ] Update test "calls updateTask with correct model fields on save" → verify auto-save triggers on select change, not button click
- [ ] Update test "calls updateTask with null to clear models on 'Use default' selection" → verify auto-save clears on "Use default" selection
- [ ] Remove or update test "enables Save button when selections change" (Save button removed)
- [ ] Remove or update test "resets selections to original values when Reset is clicked" (Reset button removed)
- [ ] Update test "disables inputs while saving" → verify select is disabled during API call
- [ ] Update test "shows error toast when save fails" → verify error toast and dropdown reverts to previous value
- [ ] Add new test: shows specific toast message with model name on executor change
- [ ] Add new test: shows specific toast message with model name on validator change
- [ ] Add new test: shows "set to default" toast when selecting "Use default"
- [ ] Add new test: badge updates immediately after successful save
- [ ] Verify all existing tests still pass (except those testing removed buttons)

**Artifacts:**
- `packages/dashboard/app/components/__tests__/ModelSelectorTab.test.tsx` (modified)

### Step 3: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm test` from root to verify all tests pass
- [ ] Fix any failing tests in ModelSelectorTab.test.tsx
- [ ] Verify no regressions in other dashboard tests
- [ ] Run `pnpm typecheck` to ensure no TypeScript errors
- [ ] Run `pnpm build` to ensure production build succeeds

### Step 4: Documentation & Delivery

- [ ] No documentation updates required (UI behavior change only)
- [ ] Out-of-scope findings created as new tasks via `task_create` tool (if any)

## Documentation Requirements

**Must Update:**
- None

**Check If Affected:**
- `AGENTS.md` — Check if model settings UI is documented (update if relevant)

## Completion Criteria

- [ ] Model selection auto-saves immediately on dropdown change (no Save button)
- [ ] Toast messages specify which model type (executor/validator) and name was saved
- [ ] Toast shows "set to default" when clearing a model override
- [ ] Model badge at top of selector reflects the saved state immediately after save
- [ ] On save error, dropdown reverts to previous value and error toast shown
- [ ] Select is disabled during API call to prevent duplicate submissions
- [ ] All tests pass
- [ ] Build passes

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-098): complete Step N — description`
- **Bug fixes:** `fix(KB-098): description`
- **Tests:** `test(KB-098): description`

## Do NOT

- Change the API endpoints or backend behavior
- Modify other components that use model settings (TaskCard, etc.)
- Add debouncing (save immediately on change)
- Change the filter functionality
- Modify the toast notification system itself (just the messages)
- Remove the loading/error states for model list fetching
