# Task: KB-171 - Add Model and Dependency Buttons to Quick Entry Box

**Created:** 2026-03-30
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** UI enhancement extending QuickEntryBox with model/dependency selection, similar to InlineCreateCard pattern. Changes span component API, parent integrations, and tests. No breaking changes to existing flows.
**Score:** 5/8 — Blast radius: 1, Pattern novelty: 1, Security: 1, Reversibility: 2

## Mission

Extend the QuickEntryBox component to allow users to quickly set AI models and dependencies when creating tasks via the quick entry input. Add two buttons ("Deps" and "Models") that open dropdown panels for selection, similar to the InlineCreateCard component. This provides power-user convenience without requiring the full New Task modal.

## Dependencies

- **Task:** KB-163 (model and dependency selector in inline new task area) — provides the reference implementation pattern in InlineCreateCard.tsx

## Context to Read First

- `packages/dashboard/app/components/QuickEntryBox.tsx` — current simple textarea implementation
- `packages/dashboard/app/components/InlineCreateCard.tsx` — reference implementation for model/dependency dropdowns
- `packages/dashboard/app/components/CustomModelDropdown.tsx` — reusable model selection component
- `packages/dashboard/app/components/Column.tsx` — uses QuickEntryBox in triage column
- `packages/dashboard/app/components/ListView.tsx` — uses QuickEntryBox in list view
- `packages/dashboard/app/App.tsx` — contains `handleQuickCreate` callback

## File Scope

- `packages/dashboard/app/components/QuickEntryBox.tsx` — extend with model/dependency UI
- `packages/dashboard/app/components/Column.tsx` — pass additional props to QuickEntryBox
- `packages/dashboard/app/components/ListView.tsx` — pass additional props to QuickEntryBox
- `packages/dashboard/app/App.tsx` — update `handleQuickCreate` to accept optional params
- `packages/dashboard/app/components/__tests__/QuickEntryBox.test.tsx` — add tests for new functionality
- `packages/dashboard/app/components/__tests__/ListView.test.tsx` — may need updates for new props

## Steps

### Step 1: Extend QuickEntryBox Component API and UI

- [ ] Add optional props to QuickEntryBox interface:
  - `tasks?: Task[]` — available tasks for dependency selection
  - `availableModels?: ModelInfo[]` — available AI models
  - Update `onCreate` signature to accept an object: `(input: QuickCreateInput) => Promise<void>`
  - Define `QuickCreateInput` interface with `description`, optional `dependencies`, optional `modelProvider`/`modelId`, optional `validatorModelProvider`/`validatorModelId`
- [ ] Import required icons: `Brain`, `Link` from `lucide-react`
- [ ] Import `CustomModelDropdown` component
- [ ] Add state for:
  - `showDeps`, `showModels` — dropdown visibility (mutually exclusive)
  - `dependencies: string[]` — selected dependency IDs
  - `depSearch: string` — dependency search filter
  - `executorProvider`/`executorModelId` — executor model selection
  - `validatorProvider`/`validatorModelId` — validator model selection
  - `selectedModelCount` — derived count for button label
- [ ] Add handlers:
  - `toggleDepsDropdown()` — open/close deps panel, close models if opening
  - `toggleModelsDropdown()` — open/close models panel, close deps if opening
  - `toggleDep(id: string)` — add/remove dependency from selection
  - `handleExecutorChange()`/`handleValidatorChange()` — model selection
- [ ] Add UI elements when expanded:
  - Footer toolbar below textarea with buttons: "Deps" (with count if >0), "Models" (with count if >0)
  - Dependency dropdown panel with search input and task list (sorted newest-first)
  - Models dropdown panel with executor and validator model selectors using CustomModelDropdown
- [ ] Update `handleSubmit` to pass all selected options to `onCreate`
- [ ] Update blur-to-cancel logic to NOT cancel if deps or models dropdowns are open
- [ ] Handle edge cases:
  - Prevent focus loss when clicking dropdown items (use `onMouseDown` with `preventDefault`)
  - Close dropdowns on Escape key
  - Truncate long task titles in dependency list
- [ ] Run targeted tests for changed files: `pnpm test -- packages/dashboard/app/components/__tests__/QuickEntryBox.test.tsx`

**Artifacts:**
- `packages/dashboard/app/components/QuickEntryBox.tsx` (modified)

### Step 2: Update Parent Components to Pass New Props

- [ ] Update `Column.tsx`:
  - Check existing props — `ColumnProps` should already have `tasks`, `allTasks` available
  - Pass `tasks={allTasks}` and `availableModels` (may need to thread through from Board)
  - Check if `availableModels` needs to be added to ColumnProps interface
- [ ] Update `ListView.tsx`:
  - Add `tasks` prop to QuickEntryBox (it's already available as `tasks`)
  - Thread `availableModels` through from App.tsx (may need new prop)
- [ ] Update `App.tsx`:
  - Fetch available models at app level (similar to how other data is fetched)
  - Pass `availableModels` down to Board and ListView
  - Update `handleQuickCreate` to accept optional `dependencies`, `modelProvider`, `modelId`, `validatorModelProvider`, `validatorModelId` and pass to `createTask` call
- [ ] Run targeted tests:
  - `pnpm test -- packages/dashboard/app/components/__tests__/Column.test.tsx`
  - `pnpm test -- packages/dashboard/app/components/__tests__/ListView.test.tsx`

**Artifacts:**
- `packages/dashboard/app/components/Column.tsx` (modified)
- `packages/dashboard/app/components/ListView.tsx` (modified)
- `packages/dashboard/app/App.tsx` (modified)

### Step 3: Update and Add Tests

- [ ] Update `QuickEntryBox.test.tsx`:
  - Add tests for dependency dropdown opening/closing
  - Add tests for model dropdown opening/closing
  - Add tests for selecting/unselecting dependencies
  - Add tests for selecting executor and validator models
  - Add tests that verify `onCreate` receives all selected options
  - Add tests for dropdown mutual exclusivity (opening one closes the other)
  - Add tests for blur behavior (doesn't cancel when dropdowns open)
  - Mock `CustomModelDropdown` and `fetchModels` as needed
- [ ] Update `ListView.test.tsx` if needed:
  - Ensure tests pass with new QuickEntryBox props
  - Mock available models data
- [ ] Run full test suite for dashboard:
  - `pnpm test -- packages/dashboard`

**Artifacts:**
- `packages/dashboard/app/components/__tests__/QuickEntryBox.test.tsx` (modified)
- `packages/dashboard/app/components/__tests__/ListView.test.tsx` (modified if needed)

### Step 4: Styling and Polish

- [ ] Add CSS classes for new elements (following existing naming conventions):
  - `quick-entry-footer` — toolbar container
  - `quick-entry-controls` — left-side buttons area
  - `quick-entry-dep-trigger`, `quick-entry-model-trigger` — buttons
  - `quick-entry-dep-dropdown`, `quick-entry-model-dropdown` — dropdown panels
  - Match styling from InlineCreateCard (`.inline-create-footer`, `.dep-dropdown`, etc.)
- [ ] Ensure dropdowns are positioned correctly (below the textarea, above other content)
- [ ] Ensure mobile responsiveness (dropdowns should not overflow viewport)
- [ ] Verify dark/light theme compatibility

**Artifacts:**
- `packages/dashboard/app/App.css` (modified — add new CSS rules)

### Step 5: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full test suite: `pnpm test`
- [ ] Verify build passes: `pnpm build`
- [ ] Manual verification checklist:
  - [ ] Focus quick entry box in triage column → expands → shows Deps/Models buttons
  - [ ] Click Deps button → dropdown opens with task list
  - [ ] Search filters dependencies correctly
  - [ ] Select/unselect dependencies updates button label ("1 deps", "2 deps")
  - [ ] Click Models button → dropdown opens with executor/validator selectors
  - [ ] Select models updates button label ("1 models", "2 models")
  - [ ] Press Enter → creates task with selected options
  - [ ] Same functionality works in ListView quick entry area
  - [ ] Blur with dropdowns open does NOT cancel
  - [ ] Escape closes dropdowns then collapses box

### Step 6: Documentation & Delivery

- [ ] Update any relevant documentation (check for QuickEntryBox mentions)
- [ ] Out-of-scope findings (if any) created as new tasks via `task_create` tool

## Documentation Requirements

**Must Update:**
- None — this is a UI enhancement that follows existing patterns

**Check If Affected:**
- `packages/dashboard/README.md` — check if component documentation exists, update if so

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] QuickEntryBox shows Deps and Models buttons when expanded
- [ ] Dependency dropdown lists tasks with search/filter capability
- [ ] Models dropdown shows executor and validator model selectors
- [ ] Selected options are passed to task creation API
- [ ] Both Column (triage) and ListView quick entry areas support new features
- [ ] No regressions in existing quick entry functionality

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-171): complete Step N — description`
- **Bug fixes:** `fix(KB-171): description`
- **Tests:** `test(KB-171): description`

## Do NOT

- Expand task scope (e.g., don't add breakIntoSubtasks toggle — that's separate)
- Change the basic quick entry flow (keep Enter to submit, Escape to cancel)
- Skip tests for the new functionality
- Modify files outside the File Scope without good reason
- Break existing QuickEntryBox consumers (maintain backward compatibility via optional props)
- Commit without the task ID prefix
