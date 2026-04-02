# Task: KB-145 - Add edit button to task detail modal

**Created:** 2026-03-30
**Size:** S

## Review Level: 2 (Plan and Code)

**Assessment:** Adding inline edit capability to the task detail modal following the existing TaskCard editing pattern. Requires UI state management, input handling, and API integration using existing `updateTask` function.
**Score:** 4/8 — Blast radius: 1, Pattern novelty: 1, Security: 0, Reversibility: 2

## Mission

Add an edit button to the TaskDetailModal header that allows users to edit the task title and description directly in the modal. This mirrors the existing inline editing functionality on TaskCard but adapted for the modal context where there's more space for a better editing experience.

Currently, users can only edit the task specification (prompt) via the Spec tab, but they cannot edit the task title or description from the modal. This creates an inconsistent UX — users should be able to edit basic task metadata from the detail view.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/components/TaskDetailModal.tsx` — the modal component where the edit button will be added
- `packages/dashboard/app/components/TaskCard.tsx` — reference for existing inline editing pattern (lines 76-280, `isEditing` state, `enterEditMode`, `exitEditMode`, `handleSave`)
- `packages/dashboard/app/api.ts` — `updateTask` function for saving changes (line 64-67)
- `packages/dashboard/app/styles.css` — search for `.card-edit-*` classes to understand existing edit styling patterns

## File Scope

- `packages/dashboard/app/components/TaskDetailModal.tsx` — add edit state, button, and inline editing UI
- `packages/dashboard/app/styles.css` — add modal-specific edit styling classes
- `packages/dashboard/app/components/__tests__/TaskDetailModal.test.tsx` — add tests for edit functionality

## Steps

### Step 0: Preflight

- [ ] Required files exist and paths are valid
- [ ] Dependencies satisfied (none required)
- [ ] Review TaskCard editing implementation for pattern reference

### Step 1: Add edit state and handlers to TaskDetailModal

- [ ] Add `isEditing` state (`useState(false)`)
- [ ] Add `editTitle` state initialized from `task.title`
- [ ] Add `editDescription` state initialized from `task.description` 
- [ ] Add `isSaving` state for save operation
- [ ] Add `enterEditMode` callback that sets edit states and focuses title input
- [ ] Add `exitEditMode` callback that resets edit states to original values
- [ ] Add `handleSave` callback that calls `updateTask` with `{ title?, description? }`
- [ ] Add `hasChanges` check comparing edit states to original task values
- [ ] Use `useEffect` to reset edit states when `task.id` changes
- [ ] Import `updateTask` from `../api` (should already be imported for spec editing)

**Artifacts:**
- `packages/dashboard/app/components/TaskDetailModal.tsx` (modified — new state and handlers)

### Step 2: Add edit button and inline editing UI

- [ ] In the modal header (`.modal-header`), add an Edit button (pencil icon or "Edit" text) next to the close button
- [ ] Button should only appear when NOT in edit mode and task is in editable columns (triage, todo — use `EDITABLE_COLUMNS` pattern from TaskCard)
- [ ] When `isEditing` is true, replace the `<h2 className="detail-title">` with:
  - Title input field (text input, auto-focused, placeholder "Task title")
  - Description textarea (auto-resize, placeholder "Task description")
- [ ] Add Save and Cancel buttons visible only in edit mode (place in header or near inputs)
- [ ] Disable Save button when no changes or `isSaving` is true
- [ ] Show "Saving…" text on Save button when `isSaving` is true
- [ ] Hide normal tab content when in edit mode (show only title/desc inputs)
- [ ] Keyboard shortcuts: Escape to cancel, Enter/Ctrl+Enter to save (in title input, Enter saves)

**Artifacts:**
- `packages/dashboard/app/components/TaskDetailModal.tsx` (modified — UI changes)
- `packages/dashboard/app/styles.css` (modified — new `.modal-edit-*` classes for styling inputs and buttons)

### Step 3: Add styling for modal edit mode

- [ ] Add `.modal-edit-input` class for title input styling (similar to `.card-edit-title-input` but adapted for modal width)
- [ ] Add `.modal-edit-textarea` class for description textarea (similar to `.card-edit-desc-textarea`)
- [ ] Add `.modal-edit-actions` class for save/cancel button container
- [ ] Ensure inputs match modal theme (dark background, proper borders, focus states)
- [ ] Ensure edit button in header uses existing button styles (`.btn`, `.btn-sm`)
- [ ] Mobile: inputs should be full-width and touch-friendly

**Artifacts:**
- `packages/dashboard/app/styles.css` (modified — new CSS classes)

### Step 4: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Add test: "shows Edit button in header when task is in triage column"
- [ ] Add test: "shows Edit button in header when task is in todo column"
- [ ] Add test: "does not show Edit button when task is in in-progress column"
- [ ] Add test: "does not show Edit button when already in edit mode"
- [ ] Add test: "entering edit mode shows title input and description textarea"
- [ ] Add test: "clicking Cancel exits edit mode without saving"
- [ ] Add test: "clicking Save calls updateTask with correct parameters"
- [ ] Add test: "Save button is disabled when no changes made"
- [ ] Add test: "Save button shows 'Saving…' during save operation"
- [ ] Add test: "successful save shows toast and exits edit mode"
- [ ] Add test: "failed save shows toast with error and stays in edit mode"
- [ ] Add test: "Escape key exits edit mode"
- [ ] Add test: "Enter in title input triggers save"
- [ ] Run full test suite: `pnpm --filter @kb/dashboard test`
- [ ] Fix all failures
- [ ] Run `pnpm build` and confirm it passes

**Artifacts:**
- `packages/dashboard/app/components/__tests__/TaskDetailModal.test.tsx` (modified — new tests)

### Step 5: Documentation & Delivery

- [ ] Update `packages/dashboard/README.md` — add note that task title and description can be edited from the task detail modal
- [ ] Create changeset file for this feature (minor bump — new user-facing feature)
- [ ] Out-of-scope findings created as new tasks via `task_create` tool if any issues discovered

## Documentation Requirements

**Must Update:**
- `packages/dashboard/README.md` — under Task Management section, note the new edit capability in task modals

**Check If Affected:**
- None

## Completion Criteria

- [ ] All steps complete
- [ ] Edit button appears in modal header for triage/todo tasks
- [ ] Clicking Edit enters edit mode with title input and description textarea
- [ ] Save/Cancel buttons work correctly
- [ ] Changes persist via `updateTask` API
- [ ] All tests passing
- [ ] Documentation updated
- [ ] Changeset file created

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-145): complete Step N — description`
- **Bug fixes:** `fix(KB-145): description`
- **Tests:** `test(KB-145): description`
- **Styles:** `style(KB-145): description`

## Do NOT

- Modify TaskCard editing behavior — keep existing functionality unchanged
- Add edit capability for columns other than triage/todo (in-progress, in-review, done should remain non-editable inline)
- Skip tests for the new edit functionality
- Change the spec editing flow in the Spec tab
- Add backend changes — use existing `updateTask` endpoint
- Commit without the task ID prefix
