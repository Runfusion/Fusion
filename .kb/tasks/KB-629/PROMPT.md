# Task: KB-629 - Add ability to bulk edit model on tasks

**Created:** 2026-03-31
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** This adds a new batch API endpoint and modifies the list view UI. It follows existing patterns from batch-import and batch-status endpoints, so the design is well-established.

**Score:** 4/8 — Blast radius: 2 (list view changes, new API), Pattern novelty: 1 (follows existing batch patterns), Security: 0 (no auth changes), Reversibility: 1 (fully reversible changes)

## Mission

Enable users to efficiently update the AI model configuration for multiple tasks at once through the dashboard list view. This feature allows selecting multiple tasks via checkboxes and applying a new executor and/or validator model to all selected tasks in a single action.

The bulk edit feature integrates seamlessly with the existing list view, appearing as a toolbar when tasks are selected. It uses the same model selection dropdown components already present in the task detail modal, ensuring a consistent user experience.

## Dependencies

- **None**

## Context to Read First

1. `/Users/eclipxe/Projects/kb/packages/dashboard/app/components/ListView.tsx` — The list view component where bulk selection UI will be added
2. `/Users/eclipxe/Projects/kb/packages/dashboard/app/components/CustomModelDropdown.tsx` — The model dropdown component to reuse for bulk editing
3. `/Users/eclipxe/Projects/kb/packages/dashboard/src/routes.ts` — Server routes where the batch update API endpoint will be added
4. `/Users/eclipxe/Projects/kb/packages/dashboard/app/api.ts` — Frontend API client where the batch update function will be added
5. `/Users/eclipxe/Projects/kb/packages/core/src/store.ts` — Task store with `updateTask` method (line 837+)

## File Scope

### Backend (Server API)
- `packages/dashboard/src/routes.ts` — Add `POST /api/tasks/batch-update-models` endpoint

### Frontend (API Client)
- `packages/dashboard/app/api.ts` — Add `batchUpdateTaskModels()` function

### Frontend (UI Components)
- `packages/dashboard/app/components/ListView.tsx` — Add selection checkboxes, bulk toolbar with model dropdowns

### Styles
- `packages/dashboard/app/styles.css` — Add styles for selection checkboxes and bulk toolbar (if CSS changes needed)

### Tests
- `packages/dashboard/src/routes.test.ts` — Add tests for batch update endpoint
- `packages/dashboard/app/components/__tests__/ListView.test.tsx` — Add tests for bulk selection UI

## Steps

### Step 1: Backend API - Batch Update Endpoint

Add a new batch endpoint to efficiently update models on multiple tasks.

- [ ] Add `POST /api/tasks/batch-update-models` route in `routes.ts`
  - Accept `taskIds: string[]`, `modelProvider?: string | null`, `modelId?: string | null`, `validatorModelProvider?: string | null`, `validatorModelId?: string | null`
  - Validate that at least one model field is being updated
  - Validate that all `taskIds` exist (return 404 if any don't)
  - Validate model field pairs (both provider and modelId must be provided together or neither)
  - Use `Promise.all()` to update all tasks in parallel via `store.updateTask()`
  - Return `{ updated: Task[], count: number }`
  - Log errors for individual task failures but continue with others
  - Wrap in try/catch with appropriate HTTP status codes (400 for validation, 404 for missing tasks, 500 for server errors)

**Artifacts:**
- `packages/dashboard/src/routes.ts` (modified) — New batch endpoint added

### Step 2: Frontend API Client - Batch Update Function

Add the frontend API client function for the batch update endpoint.

- [ ] Add `batchUpdateTaskModels()` function in `packages/dashboard/app/api.ts`
  - Accept `taskIds: string[]`, `modelProvider?: string | null`, `modelId?: string | null`, `validatorModelProvider?: string | null`, `validatorModelId?: string | null`
  - POST to `/api/tasks/batch-update-models`
  - Return `Promise<{ updated: Task[]; count: number }>`
  - Follow existing error handling patterns in `api.ts`

**Artifacts:**
- `packages/dashboard/app/api.ts` (modified) — New `batchUpdateTaskModels()` function added

### Step 3: List View - Selection State and UI

Add checkbox selection capability to the list view table.

- [ ] Add selection state to `ListView` component
  - `selectedTaskIds: Set<string>` state
  - `isSelectAll: boolean` state for header checkbox
  - Persist selection in localStorage with key `kb-dashboard-selected-tasks`

- [ ] Add checkbox column to table header
  - Add "Select All" checkbox in header row (leftmost column)
  - Header checkbox shows indeterminate state when some (but not all) tasks selected
  - Clicking header checkbox toggles all visible tasks

- [ ] Add checkboxes to each task row
  - Checkbox in leftmost cell of each row
  - Clicking row still opens detail modal (don't prevent this)
  - Clicking checkbox directly toggles selection (stop propagation)
  - Disabled for archived tasks (can't bulk edit archived)

- [ ] Add selection count display
  - Show "N selected" indicator when tasks are selected
  - Add "Clear selection" button

**Artifacts:**
- `packages/dashboard/app/components/ListView.tsx` (modified) — Selection UI added

### Step 4: List View - Bulk Edit Toolbar

Add the bulk edit toolbar with model dropdowns.

- [ ] Add bulk edit toolbar component
  - Appears at top of list when `selectedTaskIds.size > 0`
  - Shows "Bulk Edit Models" label
  - Two `CustomModelDropdown` components: "Executor Model" and "Validator Model"
  - Default value for both is empty string ("No change")
  - "Apply" button to execute the update
  - Disabled state while applying

- [ ] Handle apply action
  - On click, call `batchUpdateTaskModels()` with:
    - `taskIds: Array.from(selectedTaskIds)`
    - Model fields (only include if user selected a value, not "No change")
    - Pass `null` to clear model override (if "Use default" selected)
  - Clear selection on success
  - Show toast: "Updated N tasks" on success, error message on failure
  - Re-fetch tasks via `onRefreshTasks` callback (add this prop if needed)

- [ ] Add CSS classes for styling
  - `.bulk-edit-toolbar` — Toolbar container
  - `.bulk-edit-dropdown` — Model dropdown container
  - `.bulk-edit-apply-btn` — Apply button

**Artifacts:**
- `packages/dashboard/app/components/ListView.tsx` (modified) — Bulk edit toolbar added

### Step 5: Testing & Verification

Write comprehensive tests for the batch update functionality.

- [ ] Add server route tests in `routes.test.ts`
  - Test successful batch update with all model fields
  - Test partial update (only executor, only validator)
  - Test clearing models (passing null)
  - Test validation error (invalid model pair)
  - Test 404 when task doesn't exist
  - Test empty taskIds array (400 error)
  - Test no model fields provided (400 error)

- [ ] Add ListView component tests
  - Test checkbox selection/deselection
  - Test "Select All" functionality
  - Test bulk toolbar appears when tasks selected
  - Test model dropdowns in bulk toolbar
  - Test apply action calls API correctly
  - Test clearing selection

- [ ] Run full test suite
  - `pnpm test` passes with zero failures
  - Fix any test failures

**Artifacts:**
- `packages/dashboard/src/routes.test.ts` (modified) — Batch endpoint tests added
- `packages/dashboard/app/components/__tests__/ListView.test.tsx` (modified) — Bulk UI tests added

### Step 6: Documentation & Delivery

- [ ] Update relevant documentation
  - Add entry to dashboard README or AGENTS.md describing bulk model editing feature
  - Document the new API endpoint if there's an API documentation file

- [ ] Create changeset for the feature
  - `feat(KB-629): add bulk model editing to dashboard list view`

- [ ] Out-of-scope findings (create new tasks if found):
  - Any performance issues with large task lists during selection
  - Missing bulk operations for other task fields (future enhancement)

**Artifacts:**
- `.changeset/add-bulk-model-edit.md` (new) — Changeset file

## Documentation Requirements

**Must Update:**
- `packages/dashboard/README.md` — Add section on bulk model editing feature

**Check If Affected:**
- `packages/dashboard/AGENTS.md` — Update if there are agent-specific instructions
- Any API documentation files

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing (`pnpm test`)
- [ ] Build passes (`pnpm build`)
- [ ] Documentation updated
- [ ] Changeset created

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-629): complete Step N — description`
  - Example: `feat(KB-629): complete Step 1 — add batch update API endpoint`
  - Example: `feat(KB-629): complete Step 3 — add selection UI to list view`
- **Bug fixes:** `fix(KB-629): description`
- **Tests:** `test(KB-629): description`

## Do NOT

- Modify model preset functionality
- Add bulk editing to board view (out of scope for this task)
- Modify the task detail modal model selector
- Add bulk editing for other fields (title, description, etc.) — focus only on model editing
- Change the existing `updateTask` single-task endpoint
- Skip tests for edge cases (empty selection, invalid model pairs)
