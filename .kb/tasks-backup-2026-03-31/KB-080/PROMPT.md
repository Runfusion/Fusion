# Task: KB-080 - Combined Dropdown and Text Entry Model Filter

**Created:** 2026-03-30
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** This is a UI component refactor that replaces separate filter input + native select with a unified combobox pattern. Changes are localized to ModelSelectorTab but require careful UX handling for keyboard navigation and accessibility.
**Score:** 5/8 — Blast radius: 1, Pattern novelty: 2, Security: 0, Reversibility: 2

## Mission

Replace the separate filter text input and native HTML select dropdown in the ModelSelectorTab with a unified "combobox" component. When the user clicks the dropdown, it opens to show all models with a text input at the top for filtering. The user can type to filter models while the dropdown remains open, then click to select. This provides a cleaner, more intuitive model selection experience.

The component must maintain all existing functionality: provider grouping, "Use default" option, model filtering by provider/name/ID, selection state, keyboard navigation, and accessibility.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/components/ModelSelectorTab.tsx` — The component to modify. Currently uses separate filter inputs and native select elements.
- `packages/dashboard/app/utils/modelFilter.ts` — Existing filter logic that should be reused.
- `packages/dashboard/app/api.ts` — `ModelInfo` interface and `fetchModels()` API.
- `packages/dashboard/app/components/__tests__/ModelSelectorTab.test.tsx` — Existing tests to update/extend.
- `packages/dashboard/app/styles.css` — Search for `.model-selector-*` CSS classes.

## File Scope

- `packages/dashboard/app/components/ModelSelectorTab.tsx` (major refactor)
- `packages/dashboard/app/components/__tests__/ModelSelectorTab.test.tsx` (update tests for new component)
- `packages/dashboard/app/styles.css` (update CSS classes for new combobox pattern)

## Steps

### Step 1: Create Combobox Component

- [ ] Create an internal `ModelCombobox` component within `ModelSelectorTab.tsx` (or separate file if complex)
- [ ] Component props interface:
  - `value: string` (provider/id combo like "anthropic/claude-sonnet-4-5" or "" for default)
  - `onChange: (value: string) => void`
  - `models: ModelInfo[]`
  - `disabled?: boolean`
  - `placeholder?: string`
  - `label: string`
  - `id: string`
- [ ] Combobox UI structure:
  - Trigger button showing current selection (model name or "Use default")
  - Dropdown panel containing:
    - Text input for filtering (at top, auto-focused when opened)
    - Results count indicator
    - Clear button (×) when filter has text
    - Scrollable list of models grouped by provider
    - "Use default" option at top
    - "No results" message when filter matches nothing
- [ ] Keyboard navigation:
  - ArrowDown/ArrowUp to navigate options
  - Enter to select highlighted option
  - Escape to close dropdown
  - Tab to move to next field (close dropdown)
- [ ] Click outside to close dropdown
- [ ] Use existing `filterModels()` utility for filtering logic

**Artifacts:**
- `packages/dashboard/app/components/ModelSelectorTab.tsx` (modified with new combobox component)

### Step 2: Refactor ModelSelectorTab to Use Combobox

- [ ] Remove separate filter state variables (`executorFilter`, `validatorFilter`)
- [ ] Remove `filteredExecutorModels` and `filteredValidatorModels` useMemo hooks
- [ ] Remove `executorModelsByProvider` and `validatorModelsByProvider` useMemo hooks
- [ ] Replace the `<input>` + `<select>` pairs with the new `ModelCombobox` component for both executor and validator
- [ ] Keep the current selection display (the model badges showing current saved values)
- [ ] Keep the "Save" and "Reset" buttons and their handlers
- [ ] Keep all loading, error, and empty states
- [ ] Ensure the combobox is disabled during `isSaving` state

**Artifacts:**
- `packages/dashboard/app/components/ModelSelectorTab.tsx` (refactored to use combobox)

### Step 3: Update CSS Styles

- [ ] Remove or deprecate `.model-selector-filter` related styles (old separate filter input)
- [ ] Add new CSS classes for combobox:
  - `.model-combobox` — container
  - `.model-combobox-trigger` — clickable trigger button
  - `.model-combobox-dropdown` — dropdown panel
  - `.model-combobox-search` — filter input inside dropdown
  - `.model-combobox-list` — scrollable options list
  - `.model-combobox-option` — individual option row
  - `.model-combobox-optgroup` — provider group header
  - `.model-combobox-option--highlighted` — keyboard navigation highlight
  - `.model-combobox-option--selected` — selected state
  - `.model-combobox-no-results` — empty state
- [ ] Match existing visual style (colors from CSS variables, border-radius, etc.)
- [ ] Ensure dropdown has proper z-index and positioning
- [ ] Style the "Use default" option distinctly (muted text)
- [ ] Style provider group headers (muted, uppercase, smaller font)

**Artifacts:**
- `packages/dashboard/app/styles.css` (new combobox styles added)

### Step 4: Update Tests

- [ ] Update existing tests that rely on native `<select>` elements to use new combobox interactions:
  - Replace `screen.getByLabelText()` for selects with combobox trigger
  - Replace `user.selectOptions()` with combobox open + click option pattern
- [ ] Add new tests for combobox behavior:
  - Opening dropdown shows all models
  - Typing in search input filters models
  - Keyboard navigation (arrow keys, enter, escape)
  - Clicking outside closes dropdown
  - Selecting a model updates the value
  - "Use default" option works
- [ ] Ensure `filterModels` utility is still being used correctly
- [ ] All existing test cases must pass with new component

**Artifacts:**
- `packages/dashboard/app/components/__tests__/ModelSelectorTab.test.tsx` (updated tests)

### Step 5: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm test` to verify all tests pass
- [ ] Run `pnpm build` to verify no TypeScript errors
- [ ] Manual verification checklist (test in browser):
  - [ ] Combobox opens when clicked
  - [ ] Filter input is auto-focused when dropdown opens
  - [ ] Typing filters models in real-time
  - [ ] Clear button (×) clears filter
  - [ ] Arrow keys navigate options
  - [ ] Enter selects highlighted option
  - [ ] Escape closes dropdown without selection
  - [ ] Clicking outside closes dropdown
  - [ ] Provider grouping is visually clear
  - [ ] "Use default" option appears at top
  - [ ] Selected model shows in trigger button
  - [ ] Saving persists the selection
  - [ ] Works in both light and dark themes

### Step 6: Documentation & Delivery

- [ ] Update component comments if needed explaining the combobox pattern
- [ ] Create changeset file for the UI improvement:
  ```bash
  cat > .changeset/combined-model-dropdown.md << 'EOF'
  ---
  "@dustinbyrne/kb": patch
  ---
  
  Improved model selector UX with combined dropdown and text entry for easier filtering and selection.
  EOF
  ```
- [ ] Verify no out-of-scope changes were made

## Documentation Requirements

**Must Update:**
- None (code is self-documenting with clear component structure)

**Check If Affected:**
- Any dashboard user documentation mentioning model selection (unlikely at this stage)

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing (`pnpm test`)
- [ ] Build passes (`pnpm build`)
- [ ] Combobox works identically for both executor and validator model selection
- [ ] No visual regressions in other parts of the dashboard
- [ ] Accessibility maintained (keyboard navigation, ARIA labels where appropriate)

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-080): complete Step N — description`
- **Bug fixes:** `fix(KB-080): description`
- **Tests:** `test(KB-080): description`

Example commits:
- `feat(KB-080): complete Step 1 — create combobox component`
- `feat(KB-080): complete Step 2 — refactor ModelSelectorTab to use combobox`
- `feat(KB-080): complete Step 3 — add combobox CSS styles`
- `test(KB-080): update tests for combobox component`
- `feat(KB-080): complete Step 5 — all tests passing`

## Do NOT

- Install external UI libraries (create the combobox using native React/DOM)
- Change the `ModelInfo` interface or API responses
- Modify `filterModels()` utility (reuse it as-is)
- Remove or change the "Model Configuration" tab structure in TaskDetailModal
- Change how model overrides are saved/loaded (only the UI changes)
- Add animations that slow down the interaction
- Change the filter algorithm behavior (keep multi-word AND logic)
- Break KB-081 (ensure the component structure allows for future icon additions)

## Implementation Notes

### Combobox Pattern Details

The combobox should follow this interaction pattern:

1. **Closed State:** Shows a button/trigger displaying current selection (model name) or "Use default"

2. **Open State:** Dropdown appears below trigger with:
   - Search input at top (auto-focused, placeholder: "Filter models…")
   - Results count (e.g., "3 models")
   - Clear button (×) when filter has text
   - Scrollable list:
     - "Use default" at top (always visible)
     - Provider groups with headers ("anthropic", "openai", etc.)
     - Model names under each provider
   - "No models match 'filter'" message when empty

3. **Filtering:** As user types in search input, `filterModels()` is called and list updates in real-time

4. **Selection:** Clicking an option or pressing Enter on highlighted option:
   - Sets the value ("provider/modelId" format)
   - Calls `onChange`
   - Closes dropdown

5. **Keyboard Navigation:**
   - ArrowDown: Open dropdown (if closed) or move highlight down
   - ArrowUp: Move highlight up
   - Enter: Select highlighted option
   - Escape: Close dropdown without selection
   - Tab: Close dropdown, move focus

### Reference Implementation Approach

Look at the existing `dep-dropdown` pattern in InlineCreateCard for similar dropdown behavior:
- `dep-dropdown` CSS class for dropdown container
- `dep-dropdown-search` for search input
- `dep-dropdown-item` for selectable items
- Position absolute below trigger

### State Management

Keep combobox state internal to the component:
- `isOpen: boolean` — dropdown visibility
- `highlightedIndex: number` — for keyboard navigation
- `localFilter: string` — search text (only while dropdown is open)

When dropdown closes, reset `localFilter` to empty string.

### Data Flow

```
ModelSelectorTab (task.modelProvider, task.modelId)
  ↓
ModelCombobox value="anthropic/claude-sonnet-4-5"
  ↓ (user selects)
onChange("openai/gpt-4o")
  ↓
ModelSelectorTab setExecutorProvider/ModelId
  ↓ (user clicks Save)
updateTask API call
```
