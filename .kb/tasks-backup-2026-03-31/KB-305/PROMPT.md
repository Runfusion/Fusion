# Task: KB-305 - Convert Quick Entry Model Selector to Modal Popup

**Created:** 2026-03-31
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** Limited blast radius affecting only the QuickEntryBox component UI pattern. No security implications. Fully reversible by reverting the component changes.
**Score:** 3/8 — Blast radius: 1, Pattern novelty: 1, Security: 0, Reversibility: 1

## Mission

Convert the model selector in QuickEntryBox from an inline dropdown submenu to a modal popup dialog, following the existing modal patterns in the dashboard (like SubtaskBreakdownModal and PlanningModeModal). This improves the UX by providing more space for model selection and consistent interaction patterns across the application.

## Dependencies

- **None**

## Context to Read First

1. `packages/dashboard/app/components/QuickEntryBox.tsx` — Current implementation with inline model dropdown (`showModels` state, `inline-create-model-dropdown` CSS class)
2. `packages/dashboard/app/components/SubtaskBreakdownModal.tsx` — Reference modal implementation showing the pattern to follow
3. `packages/dashboard/app/App.tsx` — See how `isPlanningOpen`/`isSubtaskOpen` state and `handleNewTaskPlanningMode`/`handleSubtaskBreakdown` callbacks work
4. `packages/dashboard/app/components/__tests__/QuickEntryBox.test.tsx` — Existing tests that need updating
5. `packages/dashboard/app/styles.css` — Search for `.inline-create-model-dropdown` and `.modal-overlay` classes

## File Scope

- `packages/dashboard/app/components/ModelSelectorModal.tsx` (new)
- `packages/dashboard/app/components/QuickEntryBox.tsx` (modify)
- `packages/dashboard/app/App.tsx` (modify)
- `packages/dashboard/app/components/__tests__/QuickEntryBox.test.tsx` (modify)
- `packages/dashboard/app/components/__tests__/ModelSelectorModal.test.tsx` (new)

## Steps

### Step 1: Create ModelSelectorModal Component

- [ ] Create `ModelSelectorModal.tsx` following the pattern from `SubtaskBreakdownModal.tsx`
- [ ] Props interface: `isOpen`, `onClose`, `onSave`, `initialExecutorProvider`, `initialExecutorModelId`, `initialValidatorProvider`, `initialValidatorModelId`, `availableModels`
- [ ] Use `modal-overlay open` and `modal modal-lg` CSS classes for the modal structure
- [ ] Include modal header with title "Select Models" and close button
- [ ] Body contains two rows: Executor Model and Validator Model, each using `CustomModelDropdown`
- [ ] Footer has "Cancel" and "Save" buttons
- [ ] Handle Escape key to close modal
- [ ] Clicking overlay closes modal (calls `onClose` without saving)
- [ ] Clicking Save calls `onSave` with selected provider/model IDs

**Artifacts:**
- `packages/dashboard/app/components/ModelSelectorModal.tsx` (new)

### Step 2: Update QuickEntryBox to Open Modal

- [ ] Remove `showModels` state and `toggleModelsDropdown` function
- [ ] Remove the inline model dropdown JSX (the `showModels && (...)` block)
- [ ] Remove `handleModelDropdownMouseDown` function
- [ ] Remove `loadModels` function (model loading handled by parent/App)
- [ ] Add new prop: `onOpenModelSelector: (currentSelection: ModelSelection) => void` where `ModelSelection = { executorProvider?, executorModelId?, validatorProvider?, validatorModelId? }`
- [ ] Update the "Models" button to call `onOpenModelSelector` with current selections instead of toggling dropdown
- [ ] Add new prop: `onModelsSelected: (selection: ModelSelection) => void` to receive selections back from modal
- [ ] Update `resetForm` to clear model state (already done, verify it works)
- [ ] Update `handleSubmit` to use the model state (already done, verify it works)
- [ ] Keep the model badge display showing selected model count
- [ ] Remove the `modelsLoading`, `modelsError`, `loadedModels` state (models now passed via props from App)
- [ ] Add `availableModels` as required prop (no longer fetched internally)

**Artifacts:**
- `packages/dashboard/app/components/QuickEntryBox.tsx` (modified)

### Step 3: Update App.tsx for Modal State Management

- [ ] Add state: `const [isModelSelectorOpen, setIsModelSelectorOpen] = useState(false)`
- [ ] Add state: `const [pendingModelSelection, setPendingModelSelection] = useState<ModelSelection | null>(null)`
- [ ] Add callback: `handleOpenModelSelector` that stores current selection and opens modal
- [ ] Add callback: `handleModelSelectorSave` that updates state and closes modal
- [ ] Add callback: `handleModelSelectorClose` that just closes modal
- [ ] Import and render `ModelSelectorModal` with appropriate props
- [ ] Pass `onOpenModelSelector` and `availableModels` to `QuickEntryBox` components (there are 3 locations in Board, ListView, and inline usage)
- [ ] Ensure `availableModels` is already fetched in App.tsx (it is, via `fetchAuthStatus` and stored in state)

**Artifacts:**
- `packages/dashboard/app/App.tsx` (modified)

### Step 4: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Update `QuickEntryBox.test.tsx`:
  - Remove tests for inline dropdown behavior (`opens model dropdown when clicking models button`)
  - Add tests for modal trigger: `calls onOpenModelSelector when Models button clicked`
  - Update model selection tests to work with the new callback pattern
  - Verify model count badge still shows correctly
- [ ] Create `ModelSelectorModal.test.tsx`:
  - Test modal renders when `isOpen=true`
  - Test modal doesn't render when `isOpen=false`
  - Test selecting executor model calls onSave with correct values
  - Test selecting validator model calls onSave with correct values
  - Test Cancel button calls onClose without saving
  - Test Escape key closes modal
  - Test overlay click closes modal
- [ ] Run full test suite: `pnpm test`
- [ ] Fix all failures
- [ ] Build passes: `pnpm build`

**Artifacts:**
- `packages/dashboard/app/components/__tests__/QuickEntryBox.test.tsx` (modified)
- `packages/dashboard/app/components/__tests__/ModelSelectorModal.test.tsx` (new)

### Step 5: Documentation & Delivery

- [ ] No documentation updates needed (UI behavior change, not a feature addition)
- [ ] Create changeset for the UI improvement:
```bash
cat > .changeset/model-selector-modal.md << 'EOF'
---
"@dustinbyrne/kb": patch
---

Convert quick entry model selector from inline dropdown to modal popup for better UX
EOF
```

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Model selector opens as modal when clicking "Models" button in QuickEntryBox
- [ ] Modal shows both Executor and Validator model selection
- [ ] Selected models are saved back to the task creation form
- [ ] Cancel/close without saving preserves previous selection
- [ ] Build passes

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-305): complete Step N — description`
- **Bug fixes:** `fix(KB-305): description`
- **Tests:** `test(KB-305): description`

## Do NOT

- Modify the InlineCreateCard component (different component, out of scope)
- Change how CustomModelDropdown works (use it as-is)
- Change the visual styling beyond what's necessary for the modal pattern
- Add new features to the model selector (keep same functionality, just change presentation)
- Remove the model preset button from InlineCreateCard (that's a separate component)
