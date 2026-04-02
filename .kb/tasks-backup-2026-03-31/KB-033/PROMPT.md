# Task: KB-033 - Add inline editing for cards in triage or todo columns

**Created:** 2026-03-30
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** This involves UI component changes with existing API integration. Pattern is similar to InlineCreateCard. Moderate blast radius within TaskCard component but low security/reversibility risk.
**Score:** 5/8 — Blast radius: 1, Pattern novelty: 1, Security: 1, Reversibility: 2

## Mission

Add inline editing capability to task cards in the triage and todo columns. Users should be able to double-click or use an edit action on cards to modify title and description directly on the board, without opening the full task detail modal. This improves the UX for quick edits to tasks that haven't started execution yet.

## Dependencies

- **None**

## Context to Read First

1. `packages/dashboard/app/components/TaskCard.tsx` — Current card display component with drag/drop, click handling
2. `packages/dashboard/app/components/InlineCreateCard.tsx` — Reference implementation for inline editing patterns (blur-to-cancel, auto-resize textarea, dependency selector)
3. `packages/dashboard/app/components/__tests__/TaskCard.test.tsx` — Existing test patterns
4. `packages/dashboard/app/api.ts` — `updateTask()` function signature and usage
5. `packages/dashboard/app/styles.css` — Card styling and inline-create-card patterns to follow
6. `packages/core/src/types.ts` — `Task`, `Column`, and update payload types

## File Scope

- `packages/dashboard/app/components/TaskCard.tsx` — Add edit mode state, inline editing UI, and update handling
- `packages/dashboard/app/components/Column.tsx` — Pass `onUpdateTask` callback to TaskCard
- `packages/dashboard/app/components/Board.tsx` — Wire up update callback from useTasks hook
- `packages/dashboard/app/components/__tests__/TaskCard.test.tsx` — Add tests for edit mode functionality
- `packages/dashboard/app/hooks/useTasks.ts` — Add `updateTask` function if not present (check first)
- `packages/dashboard/app/styles.css` — Add inline edit card styling (follow inline-create-card patterns)

## Steps

### Step 1: Add updateTask to useTasks hook

- [ ] Check `packages/dashboard/app/hooks/useTasks.ts` for existing update/updateTask function
- [ ] If missing, add `updateTask(id: string, updates: { title?: string; description?: string; dependencies?: string[] })` that calls API and updates local state
- [ ] Ensure optimistic updates with rollback on error (follow pattern from moveTask)
- [ ] Add unit tests for the new function in `packages/dashboard/app/hooks/__tests__/useTasks.test.ts` (or create if missing)

**Artifacts:**
- `packages/dashboard/app/hooks/useTasks.ts` (modified)

### Step 2: Implement inline edit mode in TaskCard

- [ ] Add `isEditing` state to TaskCard (default false)
- [ ] Add `editTitle` and `editDescription` state for form fields
- [ ] Add edit button (pencil icon from lucide-react) visible on hover for triage/todo columns only
- [ ] Add double-click handler to enter edit mode (triage/todo only)
- [ ] Create inline edit UI: textarea for description, optional text input for title
- [ ] Follow InlineCreateCard patterns:
  - Auto-resize textarea (height adjusts to content)
  - Blur cancels if no changes, saves if changes present
  - Enter key saves (Shift+Enter for newline in textarea)
  - Escape key cancels
  - Focus management (auto-focus on enter edit mode)
- [ ] Disable edit mode if task has `status` indicating active work (e.g., "planning", "executing", etc.) or `paused` flag
- [ ] Prevent drag during edit mode
- [ ] Show loading state during save

**Artifacts:**
- `packages/dashboard/app/components/TaskCard.tsx` (modified)

### Step 3: Wire up callbacks through component hierarchy

- [ ] Update `TaskCardProps` interface to include `onUpdateTask` callback
- [ ] Update `Column.tsx` to pass `onUpdateTask` prop to TaskCard
- [ ] Update `Board.tsx` to receive `updateTask` from useTasks and pass to Column
- [ ] Verify the update callback propagates correctly through: Board → Column → TaskCard

**Artifacts:**
- `packages/dashboard/app/components/Column.tsx` (modified)
- `packages/dashboard/app/components/Board.tsx` (modified)
- `packages/dashboard/app/App.tsx` (check if wiring needed, modify if so)

### Step 4: Add CSS styling for inline edit mode

- [ ] Add `.card-editing` class styling (similar to `.inline-create-card` but distinct)
- [ ] Style edit textarea to match card seamlessly (transparent bg, no border by default, focus ring)
- [ ] Style edit title input (compact, card-header style)
- [ ] Add edit action button styling (visible on hover, positioned in card-header)
- [ ] Ensure editing card has visual indicator (border color matching column theme)

**Artifacts:**
- `packages/dashboard/app/styles.css` (modified)

### Step 5: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Add unit tests for TaskCard edit mode:
  - Enter edit mode on double-click (triage/todo only)
  - Enter edit mode via edit button
  - Cannot edit in-progress/done columns
  - Cannot edit when agent is active
  - Blur with no changes cancels edit
  - Blur with changes saves
  - Enter key saves
  - Escape key cancels
  - Loading state during save
  - Error toast on failed save
- [ ] Add tests for useTasks updateTask (if added in Step 1)
- [ ] Run full test suite: `pnpm test` (from packages/dashboard)
- [ ] Fix all failures
- [ ] Build passes: `pnpm build` (from root)
- [ ] Manual verification: open dashboard, edit a triage card title/description, verify persistence after refresh

### Step 6: Documentation & Delivery

- [ ] Update `packages/dashboard/README.md` if it documents card interactions (check first, add section if needed)
- [ ] Verify no breaking changes to existing drag-and-drop behavior
- [ ] Create changeset file per project guidelines:
  ```bash
  cat > .changeset/inline-card-editing.md << 'EOF'
  ---
  "@kb/dashboard": patch
  ---
  
  Add inline editing for cards in triage and todo columns. Double-click a card or use the edit button to quickly modify title and description without opening the full detail modal.
  EOF
  ```
- [ ] Out-of-scope findings: If any related tasks discovered (e.g., "need to edit size/reviewLevel inline"), create new tasks via `task_create` tool

## Documentation Requirements

**Must Update:**
- Changeset file as shown above

**Check If Affected:**
- `packages/dashboard/README.md` — add/edit section on "Editing Tasks" if it exists

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing (`pnpm test` in packages/dashboard)
- [ ] Build passes (`pnpm build` from root)
- [ ] Manual verification successful (inline edit → save → refresh → verify persisted)
- [ ] Changeset file included

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-033): complete Step N — description`
- **Bug fixes:** `fix(KB-033): description`
- **Tests:** `test(KB-033): description`

## Do NOT

- Allow inline editing for in-progress, in-review, or done columns (these have worktrees/active work)
- Allow editing while an agent is actively working on the task
- Change the task detail modal behavior (keep as-is for full editing)
- Skip adding tests for new functionality
- Break existing drag-and-drop behavior
- Use `any` types in TypeScript — maintain type safety
- Add dependencies to package.json (use existing lucide-react icons)
