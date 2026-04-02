# Task: KB-074 - Add Quick Entry Box and New Task Dialog

**Created:** 2026-03-30
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** This involves UI component refactoring, new modal creation, and state flow changes. Medium blast radius in dashboard components. Well-understood patterns from existing code.
**Score:** 5/8 — Blast radius: 1, Pattern novelty: 1, Security: 1, Reversibility: 2

## Mission

Replace the current "New Task" flow with a two-tier creation experience:

1. **Quick Entry Box**: A minimal input field always visible in the Triage column that creates tasks immediately on Enter (no Save button, no extra steps). It should feel like adding a task to a todo list — type and go.

2. **New Task Dialog**: The "+ New Task" button opens a modal with full task creation options including model selection, planning mode toggle, dependencies, description, and attachments.

This separates the quick capture flow (for rapid idea entry) from the deliberate creation flow (for tasks needing specific configuration).

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/components/InlineCreateCard.tsx` — Current inline creation UI (complex, has Save button, deps selector, images)
- `packages/dashboard/app/components/Column.tsx` — Column component that hosts the New Task button and inline creation
- `packages/dashboard/app/components/TaskDetailModal.tsx` — Modal pattern to follow (tabs, ModelSelectorTab usage)
- `packages/dashboard/app/components/ModelSelectorTab.tsx` — Model selection UI already built
- `packages/dashboard/app/components/Board.tsx` — Board state management for `isCreating` flow
- `packages/dashboard/app/components/App.tsx` — App-level state handlers
- `packages/dashboard/app/api.ts` — `createTask()` API and `fetchModels()`
- `packages/dashboard/app/styles.css` — Existing `.inline-create-*` styles to adapt
- `packages/core/src/types.ts` — `TaskCreateInput`, `ThinkingLevel`, `Settings` types

## File Scope

- `packages/dashboard/app/components/QuickEntryBox.tsx` (new)
- `packages/dashboard/app/components/NewTaskModal.tsx` (new)
- `packages/dashboard/app/components/Column.tsx` (modify)
- `packages/dashboard/app/components/Board.tsx` (modify)
- `packages/dashboard/app/components/App.tsx` (modify)
- `packages/dashboard/app/components/__tests__/QuickEntryBox.test.tsx` (new)
- `packages/dashboard/app/components/__tests__/NewTaskModal.test.tsx` (new)
- `packages/dashboard/app/components/__tests__/InlineCreateCard.test.tsx` (delete or update if needed)
- `packages/dashboard/app/styles.css` (modify — add `.quick-entry-*` styles, modify `.column-body` for always-visible placement)

## Steps

### Step 1: Create QuickEntryBox Component

Build a minimal, always-visible task input for the Triage column.

- [ ] Create `QuickEntryBox.tsx` with a single text input (not textarea for maximum simplicity)
- [ ] Input placeholder: "Add a task..." or "What needs to be done?"
- [ ] Creates task immediately on Enter key (no shift+enter behavior — single line only)
- [ ] Shows brief "Creating..." state while API call is in flight
- [ ] Clears input and stays focused after successful creation (ready for next entry)
- [ ] Uses existing `createTask()` API with just `{ description, column: "triage" }`
- [ ] No dependencies, no attachments, no model settings — pure quick capture
- [ ] Error handling: shows toast via `addToast` prop, keeps input content on failure for retry
- [ ] Keyboard: Escape clears input if non-empty (but doesn't cancel/blur, just clears)

**Props interface:**
```typescript
interface QuickEntryBoxProps {
  onCreate: (description: string) => Promise<void>;
  addToast: (message: string, type?: ToastType) => void;
}
```

**Artifacts:**
- `packages/dashboard/app/components/QuickEntryBox.tsx` (new)
- `packages/dashboard/app/components/__tests__/QuickEntryBox.test.tsx` (new)

### Step 2: Create NewTaskModal Component

Build a full-featured task creation dialog opened by the "+ New Task" button.

- [ ] Create `NewTaskModal.tsx` following the `TaskDetailModal` modal pattern
- [ ] Modal title: "New Task"
- [ ] Form fields:
  - Title (optional text input)
  - Description (textarea, required — primary input)
  - Dependencies selector (re-use pattern from `InlineCreateCard` or `TaskDetailModal`)
  - Model selection (Executor + Validator) — re-use `ModelSelectorTab` logic or embed simplified version
  - "Enable planning mode" toggle checkbox (sets `requirePlanApproval` concept on the task itself via settings or new field)
- [ ] Attachments support: drag-drop zone + paste support (re-use from `InlineCreateCard`)
- [ ] "Create Task" button at bottom (primary action)
- [ ] Cancel/close button (X in header)
- [ ] Escape key closes modal (with confirm if dirty)
- [ ] Creates task via `createTask()` then immediately calls `updateTask()` if model settings or planning mode need to be set
- [ ] After creation: closes modal, shows success toast, task appears in Triage

**Props interface:**
```typescript
interface NewTaskModalProps {
  isOpen: boolean;
  onClose: () => void;
  tasks: Task[]; // for dependency selection
  onCreateTask: (input: TaskCreateInput) => Promise<Task>;
  addToast: (message: string, type?: ToastType) => void;
}
```

**Artifacts:**
- `packages/dashboard/app/components/NewTaskModal.tsx` (new)
- `packages/dashboard/app/components/__tests__/NewTaskModal.test.tsx` (new)

### Step 3: Update Column Component

Replace the current conditional `InlineCreateCard` rendering with the new quick entry pattern.

- [ ] Always render `QuickEntryBox` at the top of the Triage column body (before task list)
- [ ] Keep the "+ New Task" button in the column header (unchanged position)
- [ ] Remove `isCreating`, `onCancelCreate`, `onCreateTask` props from Column — no longer needed for inline creation
- [ ] The "+ New Task" button now calls `onNewTask` which should open the modal (handled in Board/App)
- [ ] Remove all `InlineCreateCard` import and usage from Column
- [ ] Ensure column body has padding/gap to accommodate quick entry box nicely

**Artifacts:**
- `packages/dashboard/app/components/Column.tsx` (modified)

### Step 4: Update Board Component

Update state management to support the new flow.

- [ ] Remove `isCreating`, `onCancelCreate` props from Board (no longer needed)
- [ ] Keep `onNewTask` prop — it now opens the modal instead of triggering inline creation
- [ ] Update Column props in the triage section: remove `isCreating`, `onCancelCreate`, `onCreateTask`, keep `onNewTask`
- [ ] Ensure `onNewTask` callback is still wired through to the header button in Triage column

**Artifacts:**
- `packages/dashboard/app/components/Board.tsx` (modified)

### Step 5: Update App Component

Integrate the NewTaskModal and wire up the quick entry creation flow.

- [ ] Add `newTaskModalOpen` state (separate from `isCreating` which can be removed)
- [ ] Add `handleNewTaskOpen` callback that opens the modal (replaces old `handleCreateOpen`)
- [ ] Add `handleQuickCreate` callback for QuickEntryBox — creates task with minimal data
- [ ] Add `handleModalCreate` callback for NewTaskModal — handles full task creation with all options
- [ ] Render `NewTaskModal` when `newTaskModalOpen` is true
- [ ] Pass appropriate props to Board: `onNewTask: handleNewTaskOpen`
- [ ] Remove `isCreating`, `onCancelCreate`, `handleCancelCreate` state and handlers
- [ ] Update ListView props similarly if it also uses the old inline creation pattern

**Artifacts:**
- `packages/dashboard/app/components/App.tsx` (modified)

### Step 6: Add CSS Styles

Add minimal styles following existing patterns.

- [ ] Add `.quick-entry-box` styles: single row input, subtle border, matches existing form aesthetics
- [ ] Add `.quick-entry-input` styles: transparent bg, no border (clean look), focus state with `--todo` color
- [ ] Add `.new-task-modal` styles (or use existing `.modal` classes — prefer reusing existing modal patterns)
- [ ] Ensure quick entry box sits nicely at top of Triage column without excessive padding
- [ ] Update `.column-body` if needed to handle always-visible quick entry
- [ ] Remove or deprecate `.inline-create-*` styles (can keep if still used elsewhere, otherwise clean up)

**Artifacts:**
- `packages/dashboard/app/styles.css` (modified)

### Step 7: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Write tests for `QuickEntryBox`:
  - Creates task on Enter key
  - Shows loading state during creation
  - Clears input after successful creation
  - Shows error toast on failure, keeps input content
  - Escape clears non-empty input
- [ ] Write tests for `NewTaskModal`:
  - Renders all form fields when open
  - Creates task with all provided data on submit
  - Calls onClose after successful creation
  - Shows error toast on creation failure
  - Model selections are passed correctly
  - Dependencies are passed correctly
- [ ] Update `Column.test.tsx` if it tests the old inline creation flow
- [ ] Update `Board.test.tsx` if it tests `isCreating` behavior
- [ ] Run full test suite: `pnpm test`
- [ ] Fix all failures
- [ ] Build passes: `pnpm build`

### Step 8: Documentation & Delivery

- [ ] Update `packages/dashboard/README.md` if it documents the task creation flow
- [ ] Remove or update references to `InlineCreateCard` in component docs/comments
- [ ] Out-of-scope findings: If planning mode toggle needs backend support, create follow-up task
- [ ] Out-of-scope findings: If `requirePlanApproval` per-task is not yet supported, note in task comment

## Documentation Requirements

**Must Update:**
- Any README or docs mentioning the old "New Task" flow

**Check If Affected:**
- `AGENTS.md` — if it describes dashboard UI patterns
- `packages/dashboard/README.md` — user-facing docs about task creation

## Completion Criteria

- [ ] Quick entry box is always visible in Triage column
- [ ] Typing in quick entry + Enter creates a task immediately
- [ ] New Task button opens modal with full options
- [ ] Modal creates tasks with all specified settings (models, deps, etc.)
- [ ] All tests passing
- [ ] Build passes
- [ ] No references to `InlineCreateCard` remain in active code paths

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-074): complete Step N — description`
- **Bug fixes:** `fix(KB-074): description`
- **Tests:** `test(KB-074): description`

## Do NOT

- Keep the old complex InlineCreateCard flow alongside the new flow — fully replace it
- Add quick entry to columns other than Triage (only Triage needs raw capture)
- Skip tests for the new components
- Break the model selection UI — reuse existing patterns
- Skip error handling — network failures should show toasts and preserve user input
