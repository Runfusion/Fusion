# Task: KB-259 - The sub task button brings up a toast that subtasks will come soon

**Created:** 2026-03-31
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** This task creates a new modal component for manual subtask management with CRUD operations. It requires a new modal following existing patterns, backend API support for batch task creation, and integration with the current subtask button flow. Pattern follows existing modal implementations like NewTaskModal and PlanningModeModal.
**Score:** 4/8 — Blast radius: 1, Pattern novelty: 1, Security: 1, Reversibility: 1

## Mission

Replace the placeholder toast in the subtask button flow with a functional modal that lets users manually create, edit, delete, and reorder subtasks before batch-creating them. When users click the "Subtask" button in QuickEntryBox or InlineCreateCard, they should see a modal where they can break down their task into multiple subtasks, edit each one's title and description, adjust their order (which determines dependencies), and save to create all tasks at once.

## Dependencies

- **Task:** KB-248 (UI buttons already in place — the Subtask button exists and calls `onSubtaskBreakdown`)

## Context to Read First

- `packages/dashboard/app/App.tsx` — Current `handleSubtaskBreakdown` shows toast at line ~163. See how other modals like `PlanningModeModal` are managed (state, handlers, JSX rendering)
- `packages/dashboard/app/components/NewTaskModal.tsx` — Reference for modal structure, form handling, dirty state management, and dirty confirmation on close
- `packages/dashboard/app/components/PlanningModeModal.tsx` — Reference for multi-step modal flow and visual styling patterns
- `packages/dashboard/app/api.ts` — Frontend API patterns, see `createTask` function (lines ~93-107) for task creation API
- `packages/dashboard/src/routes.ts` — Backend route patterns, see task creation endpoints around lines ~1000-1100
- `packages/core/src/types.ts` — Task and TaskCreateInput type definitions for understanding the data structures

## File Scope

### New Files
- `packages/dashboard/app/components/SubtaskEditModal.tsx` — Main modal component for managing subtasks
- `packages/dashboard/app/components/SubtaskEditModal.test.tsx` — Tests for the modal component

### Modified Files
- `packages/dashboard/app/App.tsx` — Replace toast handler with modal state management, add SubtaskEditModal to JSX
- `packages/dashboard/src/routes.ts` — Add `/api/tasks/batch-create` endpoint for creating multiple tasks
- `packages/dashboard/app/api.ts` — Add `createTasksBatch` frontend API function

## Steps

### Step 1: Backend - Add Batch Task Creation API

Add an endpoint to create multiple tasks in one request with proper dependency linking.

- [ ] Add `POST /api/tasks/batch-create` endpoint in `packages/dashboard/src/routes.ts`:
  - Request body: `{ tasks: Array<{title, description, size?, dependencies?: number[]}> }` where dependencies reference array indices
  - Create tasks sequentially in the order provided
  - Resolve dependency indices to actual task IDs after creation (index 0's ID becomes a dependency for index 2 if tasks[2].dependencies includes 0)
  - Return `{ tasks: Task[] }` with all created tasks
  - All tasks should be created in "triage" column
  - Handle errors: return 400 if dependency indices are invalid, 500 if any creation fails

- [ ] Add TypeScript types in `packages/dashboard/src/routes.ts` (near existing task route types):
  ```typescript
  interface BatchCreateTaskInput {
    title?: string;
    description: string;
    size?: "S" | "M" | "L";
    dependencies?: number[]; // indices of previously created tasks in this batch
  }
  interface BatchCreateRequest {
    tasks: BatchCreateTaskInput[];
  }
  interface BatchCreateResponse {
    tasks: Task[];
  }
  ```

- [ ] Add tests in `packages/dashboard/src/routes.test.ts`:
  - Test creating 3 tasks in one batch
  - Test batch creation with dependencies (task 2 depends on task 0 and 1)
  - Test error case: empty tasks array
  - Test error case: invalid dependency index

**Artifacts:**
- `packages/dashboard/src/routes.ts` (modified - new endpoint)
- `packages/dashboard/src/routes.test.ts` (modified - new tests)

### Step 2: Frontend - Add Batch Create API Function

Add the frontend API client function for batch task creation.

- [ ] Add to `packages/dashboard/app/api.ts`:
  ```typescript
  export interface BatchTaskInput {
    title?: string;
    description: string;
    size?: "S" | "M" | "L";
    dependencies?: number[];
  }
  
  export function createTasksBatch(tasks: BatchTaskInput[]): Promise<Task[]> {
    return api<Task[]>("/tasks/batch-create", {
      method: "POST",
      body: JSON.stringify({ tasks }),
    });
  }
  ```

- [ ] Add test in `packages/dashboard/app/api.test.ts` (if it exists) or verify via integration tests

**Artifacts:**
- `packages/dashboard/app/api.ts` (modified)

### Step 3: Frontend - Create SubtaskEditModal Component

Create the main modal component for managing subtasks with full CRUD operations.

- [ ] Create `packages/dashboard/app/components/SubtaskEditModal.tsx`:

**Props interface:**
```typescript
interface SubtaskEditModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialDescription: string; // The parent task description to break down
  onTasksCreated: (tasks: Task[]) => void; // Callback with created tasks
}

interface SubtaskDraft {
  id: string; // temporary client-side ID like "draft-1"
  title: string;
  description: string;
  size: "S" | "M" | "L";
}
```

**Component requirements:**
- [ ] Modal follows existing patterns (modal-overlay, modal, modal-header, modal-body, modal-actions classes)
- [ ] Header shows "Break into Subtasks" with close button
- [ ] Display parent description at top (non-editable, for reference)
- [ ] Main content: list of subtask drafts, each with:
  - Title input field (required, show validation error if empty)
  - Description textarea (auto-resize like NewTaskModal)
  - Size selector: S / M / L buttons (styled like tabs, default to "M")
  - Drag handle for reordering (visual only for now, can use up/down buttons)
  - Delete button (with confirmation or just remove immediately)
- [ ] "Add Subtask" button at bottom of list — creates new draft with empty fields
- [ ] Keyboard shortcuts: Enter in title moves to next subtask's title (or creates new if at end)
- [ ] Dirty state tracking: confirm before closing if user has made changes

**State management:**
- [ ] `subtasks: SubtaskDraft[]` — array of draft subtasks (start with 2 empty drafts)
- [ ] `isSubmitting: boolean` — loading state during creation
- [ ] `hasDirtyState: boolean` — track if user has edited anything

**Validation:**
- [ ] All subtasks must have non-empty titles
- [ ] Show inline error: "Title is required" for empty titles on attempted save
- [ ] Disable Create button until all titles are filled

**Styling:**
- [ ] Use existing CSS classes: `btn btn-sm`, `btn btn-primary`, `form-group`, etc.
- [ ] Each subtask card should have visual separation (border or background)
- [ ] Number each subtask (1, 2, 3...) to imply dependency order

**Actions:**
- [ ] Cancel button: close modal (with dirty check)
- [ ] Create Tasks button: validate, call `createTasksBatch`, call `onTasksCreated`, close modal
- [ ] Tasks are created with dependencies: each task depends on all previous tasks (simple chain)
  - Task 0: no deps
  - Task 1: depends on [0]
  - Task 2: depends on [0, 1] — etc.

**Artifacts:**
- `packages/dashboard/app/components/SubtaskEditModal.tsx` (new)

### Step 4: Frontend - Integrate Modal in App.tsx

Replace the toast handler with modal state management.

- [ ] In `packages/dashboard/app/App.tsx`:
  - Add state: `const [subtaskModalOpen, setSubtaskModalOpen] = useState(false);`
  - Add state: `const [subtaskInitialDesc, setSubtaskInitialDesc] = useState("");`
  
- [ ] Replace `handleSubtaskBreakdown`:
  ```typescript
  const handleSubtaskBreakdown = useCallback((description: string) => {
    setSubtaskInitialDesc(description);
    setSubtaskModalOpen(true);
  }, []);
  ```

- [ ] Add close handler:
  ```typescript
  const handleSubtaskModalClose = useCallback(() => {
    setSubtaskModalOpen(false);
    setSubtaskInitialDesc("");
  }, []);
  ```

- [ ] Add tasks created handler:
  ```typescript
  const handleSubtasksCreated = useCallback((tasks: Task[]) => {
    addToast(`Created ${tasks.length} subtasks: ${tasks.map(t => t.id).join(", ")}`, "success");
    // Tasks are already created via API, just close modal
    setSubtaskModalOpen(false);
    setSubtaskInitialDesc("");
  }, [addToast]);
  ```

- [ ] Add SubtaskEditModal to JSX (before ToastContainer):
  ```tsx
  {subtaskModalOpen && (
    <SubtaskEditModal
      isOpen={subtaskModalOpen}
      onClose={handleSubtaskModalClose}
      initialDescription={subtaskInitialDesc}
      onTasksCreated={handleSubtasksCreated}
    />
  )}
  ```

- [ ] Import SubtaskEditModal at top of file

**Artifacts:**
- `packages/dashboard/app/App.tsx` (modified)

### Step 5: Frontend - Component Tests

Add comprehensive tests for the SubtaskEditModal component.

- [ ] Create `packages/dashboard/app/components/SubtaskEditModal.test.tsx`:
  - Test modal renders with initial description shown
  - Test modal starts with 2 empty subtask drafts
  - Test "Add Subtask" button adds a new draft
  - Test editing title and description updates state
  - Test size selector changes size
  - Test delete button removes a subtask
  - Test validation: Create button disabled when titles empty
  - Test validation: error shown when trying to save with empty title
  - Test dirty state: closing with changes shows confirmation
  - Test clean state: closing without changes closes immediately
  - Test successful creation calls onTasksCreated and closes
  - Test keyboard: Enter in title field moves focus (optional but nice)

**Test utilities:**
- Mock `createTasksBatch` API call
- Use `vi.fn()` for `onClose` and `onTasksCreated` props
- Use `@testing-library/react` patterns like other modal tests

**Artifacts:**
- `packages/dashboard/app/components/SubtaskEditModal.test.tsx` (new)

### Step 6: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full test suite: `pnpm test`
- [ ] Fix all failures
- [ ] Build passes: `pnpm build`

**Manual verification steps:**
- [ ] Start dashboard: `pnpm dev` in packages/dashboard
- [ ] In QuickEntryBox, type a task description and click "Subtask" button
- [ ] Verify modal opens showing the parent description
- [ ] Verify 2 empty subtask drafts are shown
- [ ] Add a title and description to first subtask
- [ ] Change size to "S"
- [ ] Click "Add Subtask" to add a third subtask
- [ ] Fill in third subtask title
- [ ] Click "Create Tasks" — verify tasks are created with sequential IDs
- [ ] Verify success toast shows created task IDs
- [ ] Verify modal closes
- [ ] Repeat test in InlineCreateCard (board view)
- [ ] Test cancel flow: make edits, click Cancel, verify confirmation dialog appears
- [ ] Test clean cancel: open modal, don't edit, click Cancel, verify closes immediately

**Artifacts:**
- All test files passing

### Step 7: Documentation & Delivery

- [ ] Update relevant documentation:
  - `AGENTS.md` — Document the new subtask breakdown feature (manual version)
- [ ] Create changeset for the feature:
  ```bash
  cat > .changeset/subtask-edit-modal.md << 'EOF'
  ---
  "@dustinbyrne/kb": minor
  ---

  Add subtask breakdown modal for manual task decomposition

  The Subtask button in task creation now opens a modal where users can:
  - Break a task into multiple subtasks
  - Edit each subtask's title, description, and size
  - Add or remove subtasks
  - Create all subtasks at once with proper sequential dependencies
  EOF
  ```

**Artifacts:**
- `AGENTS.md` (modified - if it mentions task creation)
- `.changeset/subtask-edit-modal.md` (new)

## Documentation Requirements

**Must Update:**
- `AGENTS.md` — Add user-facing documentation for the new subtask breakdown feature under the Dashboard section

**Check If Affected:**
- `README.md` — Update if it describes task creation workflows

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing (`pnpm test`)
- [ ] Build passes (`pnpm build`)
- [ ] Subtask button opens modal instead of toast
- [ ] Modal displays parent task description
- [ ] User can add, edit, delete subtasks
- [ ] Size selector works (S/M/L)
- [ ] Validation prevents creating with empty titles
- [ ] Dirty state confirmation works when closing
- [ ] Creating tasks creates all subtasks with sequential dependencies
- [ ] Changeset created for the feature

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-259): complete Step N — description`
- **Bug fixes:** `fix(KB-259): description`
- **Tests:** `test(KB-259): description`

Example commits:
- `feat(KB-259): complete Step 1 — add batch task creation API`
- `feat(KB-259): complete Step 2 — add createTasksBatch frontend API`
- `feat(KB-259): complete Step 3 — create SubtaskEditModal component`
- `feat(KB-259): complete Step 4 — integrate modal in App.tsx`
- `test(KB-259): complete Step 5 — add component tests`
- `feat(KB-259): complete Step 7 — add changeset and documentation`

## Do NOT

- Implement AI-powered subtask generation (that's KB-247)
- Remove or modify the `breakIntoSubtasks` field from types (still used by triage)
- Change the PlanningModeModal (unrelated to this task)
- Skip test coverage for the new components
- Add drag-and-drop reordering in this task (keep it simple with up/down or just add/remove)
- Modify files outside the File Scope without good reason

## Notes for Implementer

### Modal Structure Reference

Follow the pattern from NewTaskModal:
```tsx
<div className="modal-overlay open" onClick={handleClose}>
  <div className="modal modal-lg" onClick={(e) => e.stopPropagation()}>
    <div className="modal-header">...</div>
    <div className="modal-body">...</div>
    <div className="modal-actions">...</div>
  </div>
</div>
```

### Subtask Card Layout

Each subtask should look something like:
```
┌─────────────────────────────────────────┐
│ ☰ 1. [Title Input          ] [×]       │
│    [Description textarea... ]           │
│    Size: [S] [M] [L]                    │
└─────────────────────────────────────────┘
```

### Dependency Strategy

For this manual version, use simple sequential dependencies:
- Task at index 0 has no dependencies
- Task at index n has dependencies on all tasks 0 through n-1

This creates a simple chain where subtasks are completed in order.

### Future Enhancement (KB-247)

When KB-247 is implemented, this modal can be enhanced to:
- Pre-populate with AI-generated subtasks
- Show dependency selector per subtask (not just sequential)
- Show a visual dependency graph
- Add streaming generation state

For now, keep it simple and functional.
