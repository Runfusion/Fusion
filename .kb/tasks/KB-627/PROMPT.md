# Task: KB-627 - Convert Quick Entry Model Button to Modal

**Created:** 2026-03-31
**Size:** S

## Review Level: 0 (None)

**Assessment:** Focused UI change replacing an inline dropdown with a modal. Well-understood pattern with existing modal implementations in the codebase. No security implications, easily reversible.
**Score:** 2/8 — Blast radius: 0, Pattern novelty: 0, Security: 1, Reversibility: 1

## Mission

Replace the inline model selection dropdown in QuickEntryBox with a dedicated modal dialog. The modal will provide a cleaner, more focused interface for selecting executor and validator models during quick task creation, matching the pattern used by PlanningModeModal and SubtaskBreakdownModal.

## Dependencies

- **None**

## Context to Read First

1. `/Users/eclipxe/Projects/kb/packages/dashboard/app/components/QuickEntryBox.tsx` — The component to modify; currently shows inline dropdown when `showModels` is true
2. `/Users/eclipxe/Projects/kb/packages/dashboard/app/components/SubtaskBreakdownModal.tsx` — Reference modal implementation showing the pattern: `modal-overlay`, `modal`, `modal-header`, `modal-close`, Escape key handling
3. `/Users/eclipxe/Projects/kb/packages/dashboard/app/components/CustomModelDropdown.tsx` — The dropdown component used for model selection
4. `/Users/eclipxe/Projects/kb/packages/dashboard/app/components/__tests__/QuickEntryBox.test.tsx` — Existing tests that will need updates
5. `/Users/eclipxe/Projects/kb/packages/dashboard/app/styles.css` — Contains modal CSS classes: `.modal-overlay`, `.modal`, `.modal-header`, `.modal-close`

## File Scope

- `packages/dashboard/app/components/QuickEntryBox.tsx` (modified)
- `packages/dashboard/app/components/ModelSelectionModal.tsx` (new)
- `packages/dashboard/app/components/__tests__/QuickEntryBox.test.tsx` (modified)
- `packages/dashboard/app/components/__tests__/ModelSelectionModal.test.tsx` (new)

## Steps

### Step 1: Create ModelSelectionModal Component

- [ ] Create `ModelSelectionModal.tsx` following the pattern from `SubtaskBreakdownModal.tsx`
- [ ] Props interface: `isOpen`, `onClose`, `models`, `executorValue`, `validatorValue`, `onExecutorChange`, `onValidatorChange`, `modelsLoading`, `modelsError`, `onRetry`
- [ ] Use `modal-overlay`, `modal`, `modal-header` CSS classes
- [ ] Include Close button (X icon) and Escape key handling
- [ ] Reuse `CustomModelDropdown` for executor and validator selection
- [ ] Show loading state when `modelsLoading` is true
- [ ] Show error state with retry button when `modelsError` is set
- [ ] Display model badges showing current selection

**Artifacts:**
- `packages/dashboard/app/components/ModelSelectionModal.tsx` (new)

### Step 2: Update QuickEntryBox to Use Modal

- [ ] Import `ModelSelectionModal` component
- [ ] Add `isModelModalOpen` state (replace or repurpose `showModels` state)
- [ ] Modify model button click handler to open modal instead of toggling dropdown
- [ ] Remove inline dropdown JSX (the `showModels && (...)` block)
- [ ] Add `ModelSelectionModal` component at the end of the QuickEntryBox render
- [ ] Wire up all modal props: models, selection values, change handlers, loading/error states
- [ ] Ensure `onClose` handler properly closes the modal
- [ ] Keep the model button badge logic (showing "1 model" / "2 models" / "Models")

**Artifacts:**
- `packages/dashboard/app/components/QuickEntryBox.tsx` (modified)

### Step 3: Testing & Verification

- [ ] Create `ModelSelectionModal.test.tsx` with tests:
  - Renders when isOpen is true, null when false
  - Shows loading state when modelsLoading is true
  - Shows error state with retry button when modelsError is set
  - Renders CustomModelDropdown for executor and validator
  - Calls onClose when clicking close button
  - Calls onClose when pressing Escape key
  - Calls onExecutorChange/onValidatorChange when selections change
  - Calls onRetry when clicking retry button in error state
- [ ] Update `QuickEntryBox.test.tsx`:
  - Remove tests for inline dropdown behavior
  - Add test: clicking model button opens modal
  - Add test: modal receives correct props (models, loading state, etc.)
  - Ensure existing model selection payload tests still pass
- [ ] Run all tests: `pnpm test`
- [ ] Fix any failures

**Artifacts:**
- `packages/dashboard/app/components/__tests__/ModelSelectionModal.test.tsx` (new)
- `packages/dashboard/app/components/__tests__/QuickEntryBox.test.tsx` (modified)

### Step 4: Documentation & Delivery

- [ ] Update component documentation if there's a README for dashboard components
- [ ] Verify modal styling matches existing modals (overlay, positioning, close button)
- [ ] Test manually: focus quick entry, click Models button, verify modal opens
- [ ] Test model selection in modal, confirm it applies to task creation
- [ ] Out-of-scope: If preset button needs modal treatment, create follow-up task via `task_create` tool

**Artifacts:**
- Any documentation updates (if applicable)

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Model selection works via modal (not inline dropdown)
- [ ] Code follows existing patterns from SubtaskBreakdownModal
- [ ] No regressions in QuickEntryBox functionality

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-627): complete Step N — description`
- **Bug fixes:** `fix(KB-627): description`
- **Tests:** `test(KB-627): description`

## Do NOT

- Change the appearance or behavior of the model button itself (keep the same trigger)
- Modify the CustomModelDropdown component
- Change how models are fetched or the API
- Alter the task creation payload structure
- Remove the preset button functionality
- Break existing keyboard shortcuts (Enter to submit, Escape to cancel)
