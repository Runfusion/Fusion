# Task: KB-060 - Add Model Selection to New Task Creation

**Created:** 2026-03-30
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** This task involves UI changes to the inline create card, API changes to support model fields on task creation, and type changes across the core package. It touches multiple files and requires careful coordination between frontend and backend changes.
**Score:** 5/8 — Blast radius: 2, Pattern novelty: 1, Security: 1, Reversibility: 1

## Mission

Add a disclosure button to the new task creation UI (InlineCreateCard) that allows users to optionally select AI models (executor and validator) before creating a task. This mirrors the model selection capability in the TaskDetailModal's Model tab but makes it accessible during initial task creation. The feature should work in both Board and List views.

When the user clicks the disclosure button, a compact model selection panel appears inline (using a dropdown/popover pattern similar to the existing dependency selector). Users can optionally pick executor and validator models; if left unset, the task uses global defaults (current behavior).

## Dependencies

- **None**

## Context to Read First

- `packages/core/src/types.ts` — TaskCreateInput interface definition
- `packages/dashboard/app/components/InlineCreateCard.tsx` — Current task creation UI with dependency selector pattern
- `packages/dashboard/app/components/ModelSelectorTab.tsx` — Existing model selection UI pattern
- `packages/dashboard/app/api.ts` — API client including fetchModels and createTask
- `packages/dashboard/app/styles.css` — Styling patterns for inline-create and model-selector
- `packages/dashboard/src/routes.ts` — POST /api/tasks route around line 615
- `packages/core/src/store.ts` — createTask method around line 178

## File Scope

- `packages/core/src/types.ts` — Extend TaskCreateInput with model fields
- `packages/core/src/store.ts` — Update createTask to handle model fields
- `packages/dashboard/src/routes.ts` — Update POST /api/tasks to accept model fields
- `packages/dashboard/app/api.ts` — Update createTask function signature
- `packages/dashboard/app/components/InlineCreateCard.tsx` — Add model selection UI
- `packages/dashboard/app/components/Column.tsx` — Pass model state through props
- `packages/dashboard/app/components/Board.tsx` — Pass model state through props
- `packages/dashboard/app/components/ListView.tsx` — Pass model state through props
- `packages/dashboard/app/App.tsx` — Handle model selection in task creation flow
- `packages/dashboard/app/styles.css` — Add styles for inline model selector
- `packages/dashboard/app/components/__tests__/InlineCreateCard.test.tsx` — Add tests for model selection

## Steps

### Step 1: Extend Core Types and Store

- [ ] Add optional model fields to TaskCreateInput in `packages/core/src/types.ts`:
  - `modelProvider?: string`
  - `modelId?: string`
  - `validatorModelProvider?: string`
  - `validatorModelId?: string`
- [ ] Update `createTask` in `packages/core/src/store.ts` to copy model fields from input to new Task object
- [ ] Run core package tests: `pnpm --filter @kb/core test`

**Artifacts:**
- `packages/core/src/types.ts` (modified)
- `packages/core/src/store.ts` (modified)

### Step 2: Update API Layer

- [ ] Update POST /api/tasks route in `packages/dashboard/src/routes.ts` to extract model fields from request body and pass to store.createTask()
- [ ] Update `createTask` function in `packages/dashboard/app/api.ts` to accept and pass model fields
- [ ] Verify API types compile: `pnpm typecheck`

**Artifacts:**
- `packages/dashboard/src/routes.ts` (modified)
- `packages/dashboard/app/api.ts` (modified)

### Step 3: Build Model Selection UI Component

- [ ] Add new state to InlineCreateCard:
  - `showModels`: boolean for disclosure panel visibility
  - `executorProvider`, `executorModelId`: executor selection state
  - `validatorProvider`, `validatorModelId`: validator selection state
- [ ] Add `fetchModels` call on mount to load available models (reuse pattern from ModelSelectorTab)
- [ ] Add disclosure button next to the existing "Deps" button in the footer (use `Brain` or `Bot` icon from lucide-react)
- [ ] Build inline model selector dropdown (similar structure to dep-dropdown but for models):
  - Two select fields: "Executor Model" and "Validator Model"
  - Each select grouped by provider with optgroups
  - "Use default" option at top of each select
  - Current selection badges showing selected models (or "Using default")
- [ ] Include selected models in the submit payload when creating task
- [ ] Handle focus retention using `onMouseDown={(e) => e.preventDefault()}` pattern (like deps dropdown)
- [ ] Prevent blur-to-cancel when model dropdown is open (extend existing dependency tracking logic)

**Artifacts:**
- `packages/dashboard/app/components/InlineCreateCard.tsx` (modified)

### Step 4: Propagate Props Through Component Tree

- [ ] Update `InlineCreateCardProps` to accept `availableModels` as optional prop (to avoid duplicate fetches)
- [ ] Update `ColumnProps` to pass through model-related callbacks
- [ ] Update `BoardProps` to pass through model-related callbacks
- [ ] Update `ListViewProps` to pass through model-related callbacks
- [ ] Update `AppInner` in App.tsx to fetch models once and pass down through the tree
- [ ] Alternatively: have InlineCreateCard fetch models internally (simpler, no prop drilling) — document chosen approach in code comments

**Artifacts:**
- `packages/dashboard/app/components/Column.tsx` (modified)
- `packages/dashboard/app/components/Board.tsx` (modified)
- `packages/dashboard/app/components/ListView.tsx` (modified)
- `packages/dashboard/app/App.tsx` (modified)

### Step 5: Add CSS Styles

- [ ] Add `.inline-create-model-trigger` class for the disclosure button (style like `.dep-trigger`)
- [ ] Add `.inline-create-model-dropdown` class for the dropdown container (style like `.dep-dropdown` but with wider min-width for model selects)
- [ ] Add `.inline-create-model-row` class for each model selector row
- [ ] Add `.inline-create-model-label` class for labels
- [ ] Ensure dropdown z-index is above other elements (z-index: 50 like dep-dropdown)
- [ ] Add responsive styles for mobile (stack selects vertically on narrow screens)

**Artifacts:**
- `packages/dashboard/app/styles.css` (modified)

### Step 6: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Add unit tests to `InlineCreateCard.test.tsx`:
  - Test that model disclosure button opens/closes the dropdown
  - Test that selecting executor model updates state and displays badge
  - Test that selecting validator model updates state and displays badge
  - Test that "Use default" option clears the selection
  - Test that models are included in the submit payload
  - Test that focus is retained when interacting with model dropdown (mouseDown preventDefault)
  - Test that blur-to-cancel is prevented when model dropdown is open
- [ ] Run full test suite: `pnpm test`
- [ ] Fix all failures
- [ ] Build passes: `pnpm build`
- [ ] Manual verification: Create a task with model overrides and verify they appear in the task's Model tab after creation

**Artifacts:**
- `packages/dashboard/app/components/__tests__/InlineCreateCard.test.tsx` (modified)

### Step 7: Documentation & Delivery

- [ ] Create changeset file for the dashboard package improvements:
  ```bash
  cat > .changeset/add-model-selection-task-creation.md << 'EOF'
  ---
  "@dustinbyrne/kb": minor
  ---
  
  Add model selection to new task creation UI. Users can now optionally choose executor and validator AI models when creating tasks from the dashboard board or list view.
  EOF
  ```
- [ ] Update dashboard README.md if there's a features section mentioning task creation
- [ ] Out-of-scope findings: If you discover unrelated issues (e.g., model selector styling bugs), create follow-up tasks via `task_create` tool

**Artifacts:**
- `.changeset/add-model-selection-task-creation.md` (new)

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Model selection works in both Board and List views
- [ ] Tasks created with model overrides show those models in the Model tab
- [ ] UI matches existing design patterns (deps selector as reference)
- [ ] Changeset file included

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-060): complete Step N — description`
- **Bug fixes:** `fix(KB-060): description`
- **Tests:** `test(KB-060): description`

## Do NOT

- Expand task scope to redesign the entire task creation flow
- Skip tests for the new model selection functionality
- Modify files outside the File Scope without good reason
- Commit without the task ID prefix
- Break existing blur-to-cancel behavior when model dropdown is closed
- Remove or change the existing dependency selector functionality
