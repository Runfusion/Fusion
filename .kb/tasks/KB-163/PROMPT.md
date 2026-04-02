# Task: KB-163 - Add Model and Dependency Selectors to Board Quick Entry

**Created:** 2026-03-30
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** This change involves modifying shared UI components and their props interfaces across the dashboard. The blast radius spans Column, Board, and App components with potential test impacts.
**Score:** 5/8 — Blast radius: 1, Pattern novelty: 1, Security: 1, Reversibility: 2

## Mission

The list view has a rich inline task creation experience via `InlineCreateCard` with model selectors (executor/validator) and dependency selection. The board view only has a basic `QuickEntryBox` that accepts description text only. Bring the same rich creation capabilities to the board view's triage column inline entry area.

After this change, users creating tasks from the board view will be able to:
- Select executor and validator models (or use defaults)
- Add task dependencies
- Toggle "break into subtasks" option
- Still enjoy the rapid entry experience (Enter to submit, clear on success)

## Dependencies

- **None**

## Context to Read First

1. `packages/dashboard/app/components/InlineCreateCard.tsx` — Reference implementation with model selector, dependency dropdown, and break-into-subtasks toggle
2. `packages/dashboard/app/components/QuickEntryBox.tsx` — Current board quick entry (simple input only)
3. `packages/dashboard/app/components/Column.tsx` — Board column component that renders QuickEntryBox in triage column
4. `packages/dashboard/app/components/Board.tsx` — Board component that passes props to Column
5. `packages/dashboard/app/App.tsx` — Contains `handleQuickCreate` callback that needs enhancement
6. `packages/dashboard/app/components/__tests__/InlineCreateCard.test.tsx` — Test patterns for model/dependency selection
7. `packages/dashboard/app/components/__tests__/QuickEntryBox.test.tsx` — Current quick entry tests

## File Scope

- `packages/dashboard/app/components/QuickEntryBox.tsx` — Extend with model/dependency UI
- `packages/dashboard/app/components/Column.tsx` — Update props to pass full TaskCreateInput
- `packages/dashboard/app/components/Board.tsx` — Update onQuickCreate prop signature
- `packages/dashboard/app/App.tsx` — Update handleQuickCreate to accept TaskCreateInput
- `packages/dashboard/app/styles.css` — Add styles for expanded quick entry controls
- `packages/dashboard/app/components/__tests__/QuickEntryBox.test.tsx` — Update/add tests

## Steps

### Step 1: Update QuickEntryBox with Rich Creation UI

- [ ] Extend `QuickEntryBoxProps` to accept:
  - `tasks: Task[]` (for dependency selection)
  - `onCreate: (input: TaskCreateInput) => Promise<void>` (changed from simple string)
  - `availableModels?: ModelInfo[]` (optional, for model selection)
- [ ] Add internal state for:
  - `dependencies: string[]`
  - `showDeps: boolean`
  - `depSearch: string`
  - `showModels: boolean`
  - `executorProvider/executorModelId`
  - `validatorProvider/validatorModelId`
  - `breakIntoSubtasks: boolean`
  - `isExpanded: boolean` (controls whether selectors are visible)
- [ ] When user starts typing (non-empty input), expand to show selector buttons
- [ ] Add dependency selector button (Link icon) with dropdown (same pattern as InlineCreateCard)
- [ ] Add model selector button (Brain icon) with executor/validator dropdowns
- [ ] Add "break into subtasks" checkbox
- [ ] Submit via Enter creates task with all selected options
- [ ] Clear input and collapse after successful creation
- [ ] Handle Escape to clear and collapse
- [ ] Fetch models internally if `availableModels` prop not provided (reuse pattern from InlineCreateCard)

**Artifacts:**
- `packages/dashboard/app/components/QuickEntryBox.tsx` (modified)

### Step 2: Update Column Component Props

- [ ] Change `onQuickCreate` prop signature from `(description: string) => Promise<void>` to `(input: TaskCreateInput) => Promise<void>`
- [ ] Pass `tasks` prop to QuickEntryBox for dependency selection
- [ ] Pass `allTasks` as `availableModels` source if threaded through, otherwise QuickEntryBox fetches internally

**Artifacts:**
- `packages/dashboard/app/components/Column.tsx` (modified)

### Step 3: Update Board Component Props

- [ ] Change `onQuickCreate` prop signature to match new TaskCreateInput-based callback
- [ ] Ensure `tasks` prop is passed down to Column for dependency selection

**Artifacts:**
- `packages/dashboard/app/components/Board.tsx` (modified)

### Step 4: Update App.tsx Handler

- [ ] Rename `handleQuickCreate` to `handleBoardQuickCreate` for clarity (optional but clearer)
- [ ] Update implementation to accept `TaskCreateInput` and pass to `createTask`
- [ ] Preserve column as "triage" if not specified in input
- [ ] Keep toast notification on success/error

**Artifacts:**
- `packages/dashboard/app/App.tsx` (modified)

### Step 5: Add Required Styles

- [ ] Add CSS classes for expanded quick entry state:
  - `.quick-entry-box.expanded` — Expanded container
  - `.quick-entry-controls` — Container for selector buttons (deps, models)
  - `.quick-entry-dropdown` — Dropdown panels for selectors
  - Reuse existing `.inline-create-*` classes where pattern matches (optional)
- [ ] Ensure responsive layout (controls stack on mobile)
- [ ] Match visual style with InlineCreateCard (buttons, badges, dropdowns)

**Artifacts:**
- `packages/dashboard/app/styles.css` (modified)

### Step 6: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Update `QuickEntryBox.test.tsx`:
  - Update existing tests for new `onCreate` signature
  - Add test: dependency selection appears when typing
  - Add test: model selector appears when typing
  - Add test: break-into-subtasks toggle
  - Add test: submit includes all selected options in TaskCreateInput
  - Add test: dropdowns close on selection
  - Add test: escape clears and collapses
- [ ] Run full test suite: `pnpm test`
- [ ] Fix all failures
- [ ] Build passes: `pnpm build`

### Step 7: Documentation & Delivery

- [ ] No README changes needed (dashboard is internal)
- [ ] Out-of-scope findings: If InlineCreateCard and QuickEntryBox share significant logic, note for future refactoring task
- [ ] Verify no console errors during browser testing

## Documentation Requirements

**Must Update:**
- None (dashboard is internal, no user-facing docs)

**Check If Affected:**
- `AGENTS.md` — Update if dashboard patterns section exists and needs mention of QuickEntryBox capabilities

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Board view triage column shows model selector button
- [ ] Board view triage column shows dependency selector button
- [ ] Board view triage column shows "break into subtasks" toggle
- [ ] Creating a task from board quick entry respects all selected options
- [ ] Existing list view InlineCreateCard still works unchanged
- [ ] Quick entry collapses to simple input when empty

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-163): complete Step N — description`
- **Bug fixes:** `fix(KB-163): description`
- **Tests:** `test(KB-163): description`

## Do NOT

- Expand task scope (don't refactor shared logic between InlineCreateCard and QuickEntryBox — that can be a follow-up task)
- Skip tests
- Modify files outside the File Scope without good reason
- Change the appearance/behavior of InlineCreateCard in list view
- Remove the simple rapid-entry UX — the expanded controls should appear on interaction, not replace the simple input entirely
- Commit without the task ID prefix
