# Task: KB-270 - Improve subtask breakdown UX with drag-and-drop reordering inside

**Created:** 2026-03-31
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** This task adds drag-and-drop reordering to the SubtaskBreakdownModal component. It involves UI interactions, state management for reordering subtasks, and visual feedback during drag operations. The pattern is similar to existing drag behaviors in the Column component but applied to a vertical list within a modal.
**Score:** 4/8 — Blast radius: 1, Pattern novelty: 1, Security: 0, Reversibility: 2

## Mission

Add drag-and-drop reordering to the subtask list within the SubtaskBreakdownModal. Users can drag subtasks up or down to reorder them, which affects the execution order and dependency chain. This improves the UX by allowing users to visually organize subtasks after AI generation without manual editing of dependency fields.

## Dependencies

- **Task:** KB-247 (Subtask breakdown dialog) — The SubtaskBreakdownModal component must exist before adding drag-and-drop to it.

## Context to Read First

- `packages/dashboard/app/components/SubtaskBreakdownModal.tsx` — The target component for drag-and-drop (created by KB-247)
- `packages/dashboard/app/components/Column.tsx` — Reference for existing drag-and-drop patterns (lines 52-142 for drag handlers and CSS classes)
- `packages/dashboard/app/components/TaskCard.tsx` — Reference for drag start/end handlers (lines 260-280)
- `packages/dashboard/app/styles.css` — Existing CSS patterns for drag states (search for `.drag-over`, `.dragging` classes)

## File Scope

### Modified Files
- `packages/dashboard/app/components/SubtaskBreakdownModal.tsx` — Add drag-and-drop handlers and reordering logic
- `packages/dashboard/app/components/SubtaskBreakdownModal.test.tsx` — Add tests for drag-and-drop behavior
- `packages/dashboard/app/styles.css` — Add CSS classes for subtask drag states

## Steps

### Step 1: Add Drag-and-Drop State Management

Add the React state and handlers for drag-and-drop reordering in the SubtaskBreakdownModal component.

- [ ] Add drag state variables:
  - `draggingId: string | null` — The temp ID of the subtask being dragged
  - `dragOverId: string | null` — The temp ID of the subtask being hovered over
  - `dragOverPosition: 'before' | 'after' | null` — Whether to insert before or after the hover target

- [ ] Implement `handleDragStart(subtaskId: string)` handler:
  - Set `draggingId` to the dragged subtask ID
  - Use `e.dataTransfer.setData('text/plain', subtaskId)` for the drag payload
  - Set `e.dataTransfer.effectAllowed = 'move'`

- [ ] Implement `handleDragEnd()` handler:
  - Clear all drag state (draggingId, dragOverId, dragOverPosition)

- [ ] Implement `handleDragOver(e: React.DragEvent, targetId: string)` handler:
  - Prevent default to allow drop
  - Calculate whether mouse is in top or bottom half of the target element
  - Set `dragOverId` to targetId and `dragOverPosition` accordingly

- [ ] Implement `handleDrop(e: React.DragEvent, targetId: string)` handler:
  - Get the dragged subtask ID from `e.dataTransfer.getData('text/plain')`
  - If dropping onto itself, do nothing
  - Reorder the subtasks array: move dragged item to before/after target based on `dragOverPosition`
  - Clear drag state
  - Update the subtasks state with the new order

**Artifacts:**
- `packages/dashboard/app/components/SubtaskBreakdownModal.tsx` (modified — new drag state and handlers)

### Step 2: Add Drag Attributes to Subtask Items

Modify the subtask list rendering to support drag-and-drop.

- [ ] Add `draggable` attribute to each subtask row:
  - Set `draggable={!isCreating}` (disable during creation)
  - Add `onDragStart={() => handleDragStart(subtask.id)}`
  - Add `onDragEnd={handleDragEnd}`
  - Add `onDragOver={(e) => handleDragOver(e, subtask.id)}`
  - Add `onDrop={(e) => handleDrop(e, subtask.id)}`

- [ ] Add visual drag handle to each subtask row:
  - Add a grip/handle icon (use `GripVertical` from lucide-react)
  - Position it on the left side of each subtask row
  - The handle should be the visual indicator that the row is draggable

- [ ] Add conditional CSS classes to subtask rows:
  - Add class `subtask-item-dragging` when `draggingId === subtask.id`
  - Add class `subtask-item-drop-target` when `dragOverId === subtask.id`
  - Add class `subtask-item-drop-before` or `subtask-item-drop-after` based on `dragOverPosition`

**Artifacts:**
- `packages/dashboard/app/components/SubtaskBreakdownModal.tsx` (modified — drag attributes on subtask items)

### Step 3: Add CSS Styles for Drag States

Add CSS classes for visual feedback during drag-and-drop operations.

- [ ] Add `.subtask-item-dragging` styles:
  - Lower opacity (e.g., `opacity: 0.5`)
  - Visual distinction to show the item being moved

- [ ] Add `.subtask-item-drop-target` styles:
  - Highlight background to show valid drop target
  - Use existing `--todo` color with reduced opacity for consistency

- [ ] Add `.subtask-item-drop-before` and `.subtask-item-drop-after` styles:
  - Add a visual indicator line (top border for before, bottom border for after)
  - Use 2px solid border with `--todo` color

- [ ] Add `.subtask-drag-handle` styles:
  - Cursor `grab` (and `grabbing` when dragging)
  - Color `--text-dim` by default, brighter on hover
  - Padding for larger touch/click target

**Artifacts:**
- `packages/dashboard/app/styles.css` (modified — new CSS classes for drag states)

### Step 4: Update Dependency Logic After Reordering

When subtasks are reordered, ensure the dependency logic remains valid.

- [ ] After reordering, validate dependencies:
  - Ensure no circular dependencies are created (subtask A depends on B which depends on A)
  - If a dependency becomes invalid due to reordering, show a warning indicator

- [ ] Update the dependency selector options:
  - When showing the dependency dropdown for a subtask, only show subtasks that come BEFORE it in the list
  - This enforces that dependencies can only reference earlier subtasks (preventing cycles)

- [ ] Add visual dependency chain indicator:
  - Show a subtle line or arrow connecting dependent subtasks
  - Update this visual when reordering changes the dependency relationships

**Artifacts:**
- `packages/dashboard/app/components/SubtaskBreakdownModal.tsx` (modified — dependency validation)

### Step 5: Component Tests for Drag-and-Drop

Add comprehensive tests for the drag-and-drop functionality.

- [ ] Test drag start sets correct state:
  - Verify `draggingId` is set when drag starts
  - Verify dataTransfer data is set correctly

- [ ] Test drag over sets position correctly:
  - Verify `dragOverId` and `dragOverPosition` are set based on mouse position
  - Test both 'before' and 'after' positions

- [ ] Test drop reorders subtasks correctly:
  - Setup 3 subtasks (A, B, C)
  - Drag A and drop after C
  - Verify new order is [B, C, A]
  - Drag B and drop before C
  - Verify new order is [C, B, A]

- [ ] Test dropping on self does nothing:
  - Drag a subtask and drop on itself
  - Verify order remains unchanged

- [ ] Test drag end clears state:
  - After drag end, verify all drag state is cleared

- [ ] Test keyboard accessibility (bonus):
  - Add up/down buttons as alternative to drag
  - Test that clicking up button moves subtask up one position

**Artifacts:**
- `packages/dashboard/app/components/SubtaskBreakdownModal.test.tsx` (modified — new drag-and-drop tests)

### Step 6: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run component tests: `pnpm test -- packages/dashboard/app/components/SubtaskBreakdownModal.test.tsx`
- [ ] Run full test suite: `pnpm test`
- [ ] Fix all failures
- [ ] Build passes: `pnpm build`

**Manual verification steps:**
- [ ] Start dashboard: `pnpm dev` in packages/dashboard
- [ ] Open the subtask breakdown modal (via QuickEntryBox subtask button)
- [ ] Verify subtasks are displayed with drag handles
- [ ] Drag a subtask up or down
- [ ] Verify visual feedback during drag (opacity change, drop indicator line)
- [ ] Drop the subtask in a new position
- [ ] Verify the order updates correctly
- [ ] Verify dependency selectors update to reflect new positions
- [ ] Create tasks and verify dependencies are set correctly based on final order

**Artifacts:**
- All test files passing

### Step 7: Documentation & Delivery

- [ ] Update relevant documentation:
  - `AGENTS.md` — Document the drag-and-drop feature for subtask reordering

- [ ] Create changeset for the feature:
  ```bash
  cat > .changeset/subtask-drag-reorder.md << 'EOF'
  ---
  "@dustinbyrne/kb": patch
  ---
  
  Add drag-and-drop reordering to subtask breakdown dialog
  
  Users can now drag subtasks up and down to reorder them before creating,
  which automatically updates the execution order and dependency chain.
  EOF
  ```

- [ ] Out-of-scope findings created as new tasks via `task_create` tool:
  - Any complex dependency chain visualization enhancements
  - Multi-select drag for moving multiple subtasks at once

**Artifacts:**
- `AGENTS.md` (modified)
- `.changeset/subtask-drag-reorder.md` (new)

## Documentation Requirements

**Must Update:**
- `AGENTS.md` — Add user-facing documentation for the subtask drag-and-drop feature

**Check If Affected:**
- `README.md` — Update if it mentions subtask breakdown
- `packages/dashboard/README.md` — Update dashboard-specific docs

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing (`pnpm test`)
- [ ] Build passes (`pnpm build`)
- [ ] Drag handles visible on each subtask row
- [ ] Dragging a subtask shows visual feedback
- [ ] Dropping updates the subtask order correctly
- [ ] Dependency selectors reflect the new order
- [ ] Creating tasks uses the reordered sequence
- [ ] Documentation updated with changeset

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-270): complete Step N — description`
- **Bug fixes:** `fix(KB-270): description`
- **Tests:** `test(KB-270): description`

Example commits:
- `feat(KB-270): complete Step 1 — add drag state management to SubtaskBreakdownModal`
- `feat(KB-270): complete Step 2 — add drag attributes to subtask items`
- `feat(KB-270): complete Step 3 — add CSS styles for drag states`
- `feat(KB-270): complete Step 4 — update dependency logic after reordering`
- `feat(KB-270): complete Step 5 — add component tests for drag-and-drop`

## Do NOT

- Use external drag-and-drop libraries like react-dnd or @dnd-kit — use native HTML5 drag-and-drop API
- Modify the API or backend for this feature — it's purely a frontend UX enhancement
- Remove existing up/down buttons if they exist — drag-and-drop is additive
- Skip test coverage for the drag-and-drop behavior
- Break accessibility — ensure keyboard alternatives exist
- Allow circular dependencies after reordering — validate and prevent
- Modify files outside the File Scope without good reason

## Notes for Implementer

### Drag-and-Drop Pattern Reference

Follow the existing patterns from Column.tsx and TaskCard.tsx:

```typescript
// From Column.tsx
const handleDragOver = useCallback((e: React.DragEvent) => {
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";
  setDragOver(true);
}, []);

const handleDrop = useCallback(async (e: React.DragEvent) => {
  e.preventDefault();
  setDragOver(false);
  const taskId = e.dataTransfer.getData("text/plain");
  // ... handle the drop
}, [onMoveTask, column]);
```

### Reordering Logic

When reordering subtasks, maintain the array order while preserving other properties:

```typescript
const reorderSubtasks = (subtasks: SubtaskItem[], fromId: string, toId: string, position: 'before' | 'after') => {
  const fromIndex = subtasks.findIndex(s => s.id === fromId);
  const toIndex = subtasks.findIndex(s => s.id === toId);
  
  if (fromIndex === -1 || toIndex === -1) return subtasks;
  
  const newSubtasks = [...subtasks];
  const [moved] = newSubtasks.splice(fromIndex, 1);
  
  let insertIndex = toIndex;
  if (position === 'after' && fromIndex < toIndex) insertIndex--;
  if (position === 'after') insertIndex++;
  
  newSubtasks.splice(insertIndex, 0, moved);
  return newSubtasks;
};
```

### CSS Class Pattern

Follow existing drag-related CSS patterns:

```css
/* From styles.css - reference the drag-over pattern in columns */
.column.drag-over {
  background: rgba(88, 166, 255, 0.1);
  border: 2px dashed var(--todo);
}

/* New classes for subtasks */
.subtask-item.dragging {
  opacity: 0.5;
}

.subtask-item.drop-before::before {
  content: '';
  display: block;
  height: 2px;
  background: var(--todo);
  margin-bottom: 2px;
}

.subtask-item.drop-after::after {
  content: '';
  display: block;
  height: 2px;
  background: var(--todo);
  margin-top: 2px;
}
```

### Keyboard Accessibility

Provide keyboard alternatives for users who can't or prefer not to drag:

```typescript
// Add up/down buttons next to each subtask
<button onClick={() => moveSubtask(index, index - 1)} disabled={index === 0}>
  <ArrowUp size={14} />
</button>
<button onClick={() => moveSubtask(index, index + 1)} disabled={index === subtasks.length - 1}>
  <ArrowDown size={14} />
</button>
```

### Dependency Validation

When reordering, check that dependencies remain valid:

```typescript
const isValidDependencyChain = (subtasks: SubtaskItem[]): boolean => {
  // Dependencies can only reference subtasks that come before
  for (let i = 0; i < subtasks.length; i++) {
    const subtask = subtasks[i];
    for (const depId of subtask.dependsOn) {
      const depIndex = subtasks.findIndex(s => s.id === depId);
      if (depIndex >= i) return false; // Dependency must come before
    }
  }
  return true;
};
```

### Testing Drag-and-Drop in React Testing Library

Use the built-in drag events:

```typescript
const subtask = screen.getByTestId('subtask-1');
const target = screen.getByTestId('subtask-3');

fireEvent.dragStart(subtask);
fireEvent.dragOver(target);
fireEvent.drop(target);
fireEvent.dragEnd(subtask);

expect(screen.getAllByTestId(/subtask-/)).toHaveLength(3);
// Verify order changed
```

### Related Tasks

- **KB-247** — Creates the SubtaskBreakdownModal component. Coordinate to ensure the component structure is stable before adding drag-and-drop.
- This task is purely additive — it doesn't change the subtask breakdown API or data model.
