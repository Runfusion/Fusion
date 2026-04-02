# Task: KB-183 - Use CustomModelDropdown in Settings for Model Selection

**Created:** 2026-03-30
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** Straightforward UI consolidation task. Replace native select with existing CustomModelDropdown component. Well-tested component with established patterns.
**Score:** 3/8 — Blast radius: 1 (isolated to Settings modal), Pattern novelty: 0 (using existing component), Security: 0 (no security impact), Reversibility: 2 (easy to revert to native select)

## Mission

Replace the current native HTML `<select>` element for default model selection in the Settings modal with the `CustomModelDropdown` component. This provides a consistent user experience between the settings page and the model cards, with integrated search/filtering, provider icons, and a unified dropdown interface.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/components/SettingsModal.tsx` — Current settings modal implementation with native select in "model" section
- `packages/dashboard/app/components/CustomModelDropdown.tsx` — The consolidated dropdown component to use
- `packages/dashboard/app/components/__tests__/SettingsModal.test.tsx` — Existing tests that will need updates
- `packages/dashboard/app/components/__tests__/CustomModelDropdown.test.tsx` — Reference for how CustomModelDropdown is tested

## File Scope

- `packages/dashboard/app/components/SettingsModal.tsx` — Replace model selection UI
- `packages/dashboard/app/components/__tests__/SettingsModal.test.tsx` — Update tests for CustomModelDropdown integration

## Steps

### Step 1: Replace Model Selector in SettingsModal

- [ ] Remove `modelFilter` state and `filterModels` import from SettingsModal
- [ ] Import `CustomModelDropdown` component
- [ ] Replace the filter input + native `<select>` with `CustomModelDropdown` in the "model" section
- [ ] Keep the same value format (`provider/modelId` or empty string for default)
- [ ] Ensure `onChange` handler updates `defaultProvider` and `defaultModelId` in form state
- [ ] Verify `modelsLoading` and empty states are handled correctly
- [ ] Keep the "Thinking Effort" dropdown behavior (only show for reasoning models)
- [ ] Run targeted tests for SettingsModal

**Artifacts:**
- `packages/dashboard/app/components/SettingsModal.tsx` (modified)

### Step 2: Update SettingsModal Tests

- [ ] Update tests that reference `getByLabelText("Default Model")` as a SELECT element
- [ ] Replace filter input tests with CustomModelDropdown interaction patterns (see ModelSelectorTab.test.tsx for reference)
- [ ] Update test for selecting a model to use click + dropdown interaction
- [ ] Update test for "Use default" option to use CustomModelDropdown pattern
- [ ] Ensure tests for model filtering use the dropdown's search input
- [ ] Verify all existing test cases still pass with new component
- [ ] Run targeted tests for SettingsModal

**Artifacts:**
- `packages/dashboard/app/components/__tests__/SettingsModal.test.tsx` (modified)

### Step 3: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full test suite: `pnpm test`
- [ ] Fix all failures
- [ ] Build passes: `pnpm build`
- [ ] Manually verify in dashboard:
  - Open Settings → Model section
  - Verify CustomModelDropdown renders with provider icons
  - Test opening dropdown and filtering models
  - Test selecting a model and saving
  - Test "Use default" option clears selection
  - Verify Thinking Effort dropdown shows only for reasoning models

### Step 4: Documentation & Delivery

- [ ] No documentation updates required (this is an internal UI improvement)
- [ ] Out-of-scope findings created as new tasks via `task_create` tool if any

## Documentation Requirements

**Must Update:**
- None

**Check If Affected:**
- None

## Completion Criteria

- [ ] CustomModelDropdown is used for default model selection in Settings
- [ ] All SettingsModal tests pass
- [ ] Full test suite passes
- [ ] Manual verification confirms consistent UX with model cards

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-183): complete Step N — description`
- **Bug fixes:** `fix(KB-183): description`
- **Tests:** `test(KB-183): description`

## Do NOT

- Modify CustomModelDropdown component itself (use it as-is)
- Change the model selection behavior or data format
- Remove the "Thinking Effort" dropdown logic
- Skip or delete existing tests — update them to work with new component
- Modify CSS (styles already exist for model-combobox)
