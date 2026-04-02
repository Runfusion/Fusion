# Task: KB-267 - Convert Model Selector from Dropdown to Modal Popup

**Created:** 2026-03-31
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** This is a focused UI refactor affecting two components. The pattern is well-established in the codebase (see NewTaskModal, SettingsModal). Low blast radius—only changes the interaction pattern, not the data flow or API.
**Score:** 3/8 — Blast radius: 1, Pattern novelty: 0, Security: 0, Reversibility: 2

## Mission

Convert the model selector interface in QuickEntryBox and InlineCreateCard from a dropdown submenu to a dedicated modal popup. Currently, clicking the "Models" button opens an inline dropdown (`inline-create-model-dropdown`) that renders CustomModelDropdown components for executor and validator selection. This dropdown is cramped, overlays other UI awkwardly, and doesn't match the modal-based patterns used elsewhere in the dashboard (e.g., NewTaskModal, SettingsModal).

The new modal should provide a cleaner, more focused interface for selecting executor and validator models, matching the existing modal design patterns in the codebase.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/components/QuickEntryBox.tsx` — Main quick entry component with model dropdown
- `packages/dashboard/app/components/InlineCreateCard.tsx` — Board view inline creation with model dropdown
- `packages/dashboard/app/components/CustomModelDropdown.tsx` — Reusable model dropdown component (used inside the current dropdown)
- `packages/dashboard/app/components/NewTaskModal.tsx` — Reference for modal pattern with model selection (see `ModelCombobox` usage)
- `packages/dashboard/app/styles.css` — Lines ~2217-2380 contain the dropdown styles to be replaced; lines ~200-250 contain modal overlay/modal styles
- `packages/dashboard/app/components/__tests__/QuickEntryBox.test.tsx` — Existing tests that verify model selection behavior

## File Scope

### Modify:
- `packages/dashboard/app/components/QuickEntryBox.tsx`
- `packages/dashboard/app/components/InlineCreateCard.tsx`
- `packages/dashboard/app/components/__tests__/QuickEntryBox.test.tsx`
- `packages/dashboard/app/components/__tests__/InlineCreateCard.test.tsx`

### Optionally modify (if modal-specific styles needed):
- `packages/dashboard/app/styles.css`

## Steps

### Step 1: Create Model Selector Modal Component

Create a reusable `ModelSelectorModal` component that can be shared between QuickEntryBox and InlineCreateCard.

- [ ] Create new file `packages/dashboard/app/components/ModelSelectorModal.tsx`
- [ ] Modal should accept props:
  - `isOpen: boolean`
  - `onClose: () => void`
  - `models: ModelInfo[]`
  - `executorValue: string` (provider/modelId combined)
  - `validatorValue: string`
  - `onExecutorChange: (value: string) => void`
  - `onValidatorChange: (value: string) => void`
  - `modelsLoading: boolean`
  - `modelsError: string | null`
  - `onRetry?: () => void`
- [ ] Use existing modal structure from `NewTaskModal.tsx`:
  - `modal-overlay` div with `open` class
  - `modal` container with header, body, actions
  - Title: "Select Models"
- [ ] Render two `CustomModelDropdown` components in the modal body:
  - Label: "Executor Model" with helper text "AI model used to implement tasks"
  - Label: "Validator Model" with helper text "AI model used to review code and plans"
- [ ] Add "Cancel" and "Done" buttons in modal actions
  - "Done" simply closes the modal (selections are applied immediately via the dropdowns)
- [ ] Handle Escape key to close modal
- [ ] Add `data-testid` attributes for testing:
  - `model-selector-modal`
  - `model-selector-executor`
  - `model-selector-validator`
  - `model-selector-done`
  - `model-selector-cancel`

**Artifacts:**
- `packages/dashboard/app/components/ModelSelectorModal.tsx` (new)

### Step 2: Update QuickEntryBox

Replace the inline model dropdown with the new modal pattern.

- [ ] Import `ModelSelectorModal` and `ModelInfo` type
- [ ] Replace `showModels` state (boolean for dropdown) with `isModelModalOpen` state
- [ ] Remove `toggleModelsDropdown` function and replace with `openModelModal` / `closeModelModal` functions
- [ ] Remove the entire `showModels && (` dropdown JSX block (the `inline-create-model-dropdown`)
- [ ] Add `<ModelSelectorModal />` component at the end of QuickEntryBox render, controlled by `isModelModalOpen`
- [ ] Update the Models button click handler to open the modal
- [ ] Pass current model selection state and handlers to the modal
- [ ] Keep the model badge display logic on the button (showing selected count)
- [ ] Remove `handleModelDropdownMouseDown` (no longer needed without dropdown)
- [ ] Remove the `onMouseDown` handler from the Models button wrapper div
- [ ] Update test IDs: keep `quick-entry-models-button` intact

**Artifacts:**
- `packages/dashboard/app/components/QuickEntryBox.tsx` (modified)

### Step 3: Update InlineCreateCard

Apply the same modal pattern to InlineCreateCard.

- [ ] Import `ModelSelectorModal` and `ModelInfo` type
- [ ] Replace `showModels` dropdown state with `isModelModalOpen` modal state
- [ ] Remove `toggleModelsDropdown` and `handleModelDropdownMouseDown` functions
- [ ] Remove the entire `showModels && (` dropdown JSX block
- [ ] Add `<ModelSelectorModal />` component controlled by `isModelModalOpen`
- [ ] Update Models button to open modal instead of toggling dropdown
- [ ] Update focus-out cleanup in useEffect: remove `showModels` from dependency array, add `isModelModalOpen`

**Artifacts:**
- `packages/dashboard/app/components/InlineCreateCard.tsx` (modified)

### Step 4: Clean Up Unused Styles (Optional)

Remove or deprecate the now-unused dropdown styles if no other components use them.

- [ ] Check if `inline-create-model-dropdown` and related styles are used anywhere else
- [ ] If unused, remove from `styles.css`:
  - `.inline-create-model-wrap`
  - `.inline-create-model-trigger`
  - `.inline-create-model-dropdown`
  - `.inline-create-model-row`
  - `.inline-create-model-label`
  - `.inline-create-model-select`
  - `.inline-create-model-empty`
  - Related media query styles
- [ ] Keep `.dep-dropdown` styles (still used for dependency selection)

**Artifacts:**
- `packages/dashboard/app/styles.css` (modified)

### Step 5: Update Tests

Update existing tests to work with the new modal pattern.

- [ ] Update `QuickEntryBox.test.tsx`:
  - Change "opens model dropdown when clicking models button" test to verify modal opens
  - Update selector from `.inline-create-model-dropdown` to `[data-testid="model-selector-modal"]`
  - Update model selection test: click dropdown inside modal instead of inline
  - Verify modal closes after clicking "Done"
- [ ] Update `InlineCreateCard.test.tsx` (if model tests exist):
  - Similar updates as QuickEntryBox tests
- [ ] Add new tests for ModelSelectorModal if needed (can be covered via QuickEntryBox tests)

**Artifacts:**
- `packages/dashboard/app/components/__tests__/QuickEntryBox.test.tsx` (modified)
- `packages/dashboard/app/components/__tests__/InlineCreateCard.test.tsx` (modified)

### Step 6: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm test` to verify all dashboard tests pass
- [ ] Specifically verify:
  - QuickEntryBox tests
  - InlineCreateCard tests
  - CustomModelDropdown tests
- [ ] Run `pnpm build` to ensure no TypeScript errors

### Step 7: Documentation & Delivery

- [ ] No documentation updates required (UI behavior change only)
- [ ] Verify the modal closes properly when clicking outside (overlay click)
- [ ] Verify Escape key closes the modal
- [ ] Verify model selections are preserved when reopening the modal
- [ ] If any unexpected edge cases are found during implementation, create follow-up tasks via `task_create` tool

## Documentation Requirements

**Must Update:**
- None (this is a UI behavior change, not a feature addition)

**Check If Affected:**
- `AGENTS.md` — Check if there's any documentation about the model selector dropdown that needs updating

## Completion Criteria

- [ ] Model selector opens as a modal popup instead of a dropdown when clicking the Models button in QuickEntryBox
- [ ] Same behavior in InlineCreateCard
- [ ] Modal displays two CustomModelDropdowns (Executor and Validator) with clear labels
- [ ] Modal closes on Escape key, outside click, or Done button
- [ ] Model selections persist and are shown in the button badge
- [ ] All existing tests pass
- [ ] No console errors or warnings
- [ ] Build passes (`pnpm build`)

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-267): complete Step N — description`
- **Bug fixes:** `fix(KB-267): description`
- **Tests:** `test(KB-267): description`

## Do NOT

- Expand scope beyond the model selector modal conversion
- Change the CustomModelDropdown component itself (it's used elsewhere)
- Modify the API or data structures
- Add new features like model presets or favorites
- Change the dependency dropdown (that's a separate feature)
- Skip test updates for the new modal pattern
