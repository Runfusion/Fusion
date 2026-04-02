# Task: KB-248 - Rather than a checkbox for break into subtasks

**Created:** 2026-03-31
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** This is a UI-only change that replaces the existing "Break into subtasks" checkbox with two explicit action buttons. The "Plan" button opens the existing PlanningModeModal, and the "Subtask" button will eventually trigger the subtask dialog (KB-247). Requires coordination with existing patterns in QuickEntryBox and InlineCreateCard.
**Score:** 4/8 — Blast radius: 1, Pattern novelty: 1, Security: 1, Reversibility: 1

## Mission

Replace the "Break into subtasks" checkbox in the dashboard task creation UI with two explicit buttons:
1. **"Plan"** button — Opens the PlanningModeModal with the entered text pre-filled
2. **"Subtask"** button — Will trigger the subtask breakdown dialog (KB-247 implements the actual dialog)

This change makes the two different "breakdown" workflows explicit and discoverable, rather than hiding them behind a checkbox that users may not understand.

## Dependencies

- **None** — This task provides UI entry points that KB-247 will connect to

## Context to Read First

- `packages/dashboard/app/components/InlineCreateCard.tsx` — Inline card creation with current checkbox (lines ~373-385)
- `packages/dashboard/app/components/QuickEntryBox.tsx` — Quick entry with current checkbox (lines ~347-359)
- `packages/dashboard/app/components/PlanningModeModal.tsx` — Planning mode modal that "Plan" button should open
- `packages/dashboard/app/App.tsx` — See how PlanningModeModal is opened via `handleNewTaskPlanningMode`
- `packages/dashboard/app/components/__tests__/InlineCreateCard.test.tsx` — Current checkbox tests
- `packages/dashboard/app/components/__tests__/QuickEntryBox.test.tsx` — Current checkbox tests

## File Scope

### Modified Files
- `packages/dashboard/app/components/InlineCreateCard.tsx` — Replace checkbox with buttons, add handlers
- `packages/dashboard/app/components/QuickEntryBox.tsx` — Replace checkbox with buttons, add handlers
- `packages/dashboard/app/components/__tests__/InlineCreateCard.test.tsx` — Update tests for new button UI
- `packages/dashboard/app/components/__tests__/QuickEntryBox.test.tsx` — Update tests for new button UI

## Steps

### Step 1: Update InlineCreateCard Component

Replace the "Break into subtasks" checkbox with "Subtask" and "Plan" buttons in the inline create card.

- [ ] Remove the checkbox and `breakIntoSubtasks` state from `InlineCreateCard.tsx`
- [ ] Remove `breakIntoSubtasks` from the submit payload (it will no longer be set here)
- [ ] Add two new buttons in the controls area:
  - "Plan" button with a Lightbulb icon (using `lucide-react`)
  - "Subtask" button with a GitBranch or ListTree icon
- [ ] Style buttons to match existing `btn btn-sm` pattern
- [ ] Update blur-to-cancel logic: remove `breakIntoSubtasks` from the cancel check (focusout handler ~line 195)
- [ ] Add `onPlanningMode?: (initialPlan: string) => void` prop for triggering planning mode
- [ ] Add `onSubtaskBreakdown?: (description: string) => void` prop for triggering subtask dialog
- [ ] Implement handlers:
  - `handlePlanClick` — Opens planning mode with current description (validate description not empty)
  - `handleSubtaskClick` — Opens subtask breakdown with current description (KB-247 will implement dialog)
- [ ] Add visual feedback when buttons are disabled (no description entered)

**Behavior:**
- Clicking "Plan" with no description: show toast "Enter a description first" or disable button
- Clicking "Plan" with description: call `onPlanningMode(description)` and clear the input
- Clicking "Subtask" with no description: show toast or disable button  
- Clicking "Subtask" with description: call `onSubtaskBreakdown(description)` and clear the input
- Enter key still creates a regular task (no breakdown)

**Artifacts:**
- `packages/dashboard/app/components/InlineCreateCard.tsx` (modified)

### Step 2: Update QuickEntryBox Component

Apply the same changes to the QuickEntryBox component.

- [ ] Remove the checkbox and `breakIntoSubtasks` state from `QuickEntryBox.tsx`
- [ ] Remove `breakIntoSubtasks` from the submit payload
- [ ] Add the same two buttons with identical styling and icons
- [ ] Update blur/collapse logic: remove `breakIntoSubtasks` from state checks
- [ ] Add `onPlanningMode?: (initialPlan: string) => void` prop
- [ ] Add `onSubtaskBreakdown?: (description: string) => void` prop  
- [ ] Implement the same handlers with identical behavior
- [ ] Ensure keyboard shortcuts still work (Enter to create, Escape to cancel)

**Artifacts:**
- `packages/dashboard/app/components/QuickEntryBox.tsx` (modified)

### Step 3: Wire Up Buttons in App.tsx

Connect the new button callbacks to the existing planning mode flow.

- [ ] Update the `handleBoardQuickCreate` usage in Board component to not pass `breakIntoSubtasks` (it was never passed, but verify)
- [ ] Add handler `handleSubtaskBreakdown` (placeholder for KB-247 integration):
  ```typescript
  const handleSubtaskBreakdown = useCallback((description: string) => {
    // Placeholder for KB-247 integration
    // For now, show a toast indicating this feature is coming
    addToast("Subtask breakdown coming soon! Description: " + description.slice(0, 30) + "...", "info");
  }, [addToast]);
  ```
- [ ] Wire up `onPlanningMode` and `onSubtaskBreakdown` props to both `InlineCreateCard` and `QuickEntryBox` instances
- [ ] Verify that `handleNewTaskPlanningMode` is already available and works with the new buttons

**Board wiring:**
```tsx
<Board
  // ...existing props
  onQuickCreate={handleBoardQuickCreate}
  // Add these:
  onPlanningMode={handleNewTaskPlanningMode}
  onSubtaskBreakdown={handleSubtaskBreakdown}
/>
```

**ListView wiring:**
```tsx
<ListView
  // ...existing props  
  onQuickCreate={handleBoardQuickCreate}
  onPlanningMode={handleNewTaskPlanningMode}
  onSubtaskBreakdown={handleSubtaskBreakdown}
/>
```

**Artifacts:**
- `packages/dashboard/app/App.tsx` (modified)
- `packages/dashboard/app/components/Board.tsx` (modified - add props and pass through to InlineCreateCard)
- `packages/dashboard/app/components/ListView.tsx` (modified - add props and pass through to QuickEntryBox)

### Step 4: Update Tests

Update all tests to reflect the new button-based UI instead of checkbox.

**InlineCreateCard tests:**
- [ ] Remove tests for `breakIntoSubtasks` checkbox
- [ ] Add tests for "Plan" button:
  - Renders with Lightbulb icon
  - Disabled when no description
  - Calls `onPlanningMode` with description when clicked
  - Clears input after triggering planning mode
- [ ] Add tests for "Subtask" button:
  - Renders with appropriate icon
  - Disabled when no description
  - Calls `onSubtaskBreakdown` with description when clicked
  - Clears input after triggering subtask breakdown
- [ ] Verify regular task creation still works via Enter key and Save button

**QuickEntryBox tests:**
- [ ] Remove tests for `breakIntoSubtasks` checkbox (lines ~280-330)
- [ ] Add tests for "Plan" button with same assertions as InlineCreateCard
- [ ] Add tests for "Subtask" button with same assertions
- [ ] Verify keyboard shortcuts still work (Enter creates task, Escape clears)

**Test data-testid attributes to add:**
- `plan-button` — Plan button
- `subtask-button` — Subtask button

**Artifacts:**
- `packages/dashboard/app/components/__tests__/InlineCreateCard.test.tsx` (modified)
- `packages/dashboard/app/components/__tests__/QuickEntryBox.test.tsx` (modified)

### Step 5: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full test suite: `pnpm test`
- [ ] Fix all failures
- [ ] Build passes: `pnpm build`

**Manual verification steps:**
- [ ] Start dashboard: `pnpm dev` in packages/dashboard
- [ ] Test InlineCreateCard (board view):
  - Type in the inline create card
  - Verify "Plan" and "Subtask" buttons appear
  - Click "Plan" — should open PlanningModeModal with text pre-filled
  - Cancel planning mode, type again, click "Subtask" — should show "coming soon" toast
  - Verify Enter key still creates regular task
- [ ] Test QuickEntryBox (list view):
  - Type in quick entry box
  - Verify buttons appear when expanded
  - Click "Plan" — should open PlanningModeModal
  - Verify keyboard shortcuts work

**Artifacts:**
- All test files passing

### Step 6: Documentation & Delivery

- [ ] Update relevant documentation:
  - `AGENTS.md` — Document the new button-based task creation options
- [ ] Create changeset for the UI change:
  ```bash
  cat > .changeset/replace-subtasks-checkbox.md << 'EOF'
  ---
  "@dustinbyrne/kb": minor
  ---

  Replace "break into subtasks" checkbox with explicit "Plan" and "Subtask" buttons

  Task creation UI now shows two explicit buttons instead of a checkbox:
  - "Plan" — Opens AI planning mode to refine the task before creation
  - "Subtask" — Opens subtask breakdown dialog (feature coming in next release)
  EOF
  ```

**Artifacts:**
- `AGENTS.md` (modified - if it mentions task creation)
- `.changeset/replace-subtasks-checkbox.md` (new)

## Documentation Requirements

**Must Update:**
- Update test files to match new UI (covered in Step 4)

**Check If Affected:**
- `AGENTS.md` — Update if it documents task creation flow
- `README.md` — Update if it describes the task creation UI

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing (`pnpm test`)
- [ ] Build passes (`pnpm build`)
- [ ] Checkbox removed from both InlineCreateCard and QuickEntryBox
- [ ] "Plan" button opens PlanningModeModal with pre-filled text
- [ ] "Subtask" button triggers callback (placeholder for KB-247)
- [ ] Regular task creation still works (Enter key, Save button)
- [ ] Buttons disable/enable based on whether description is entered
- [ ] Changeset created for the change

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-248): complete Step N — description`
- **Bug fixes:** `fix(KB-248): description`
- **Tests:** `test(KB-248): description`

Example commits:
- `feat(KB-248): complete Step 1 — replace checkbox with Plan/Subtask buttons in InlineCreateCard`
- `feat(KB-248): complete Step 2 — update QuickEntryBox with Plan/Subtask buttons`
- `feat(KB-248): complete Step 3 — wire up button callbacks in App.tsx`
- `test(KB-248): complete Step 4 — update tests for new button UI`
- `feat(KB-248): complete Step 6 — add changeset for UI change`

## Do NOT

- Remove the `breakIntoSubtasks` field from `TaskCreateInput` type (still used by triage agent)
- Change the backend API behavior for `breakIntoSubtasks`
- Modify the PlanningModeModal component (use it as-is)
- Implement the actual subtask breakdown dialog (that's KB-247)
- Skip test coverage for the new buttons
- Use different icon sets between InlineCreateCard and QuickEntryBox (keep consistent)

## Notes for Implementer

### Button Styling

Use existing button classes for consistency:
```tsx
<button className="btn btn-sm" onClick={handlePlanClick} disabled={!description.trim()}>
  <Lightbulb size={12} style={{ verticalAlign: "middle" }} />
  Plan
</button>
<button className="btn btn-sm" onClick={handleSubtaskClick} disabled={!description.trim()}>
  <ListTree size={12} style={{ verticalAlign: "middle" }} />
  Subtask
</button>
```

Alternative icons if ListTree isn't available:
- `GitBranch` — suggests branching/decomposition
- `Layers` — suggests breaking into layers
- `Split` — if available

### Props Interface Changes

**InlineCreateCard new props:**
```typescript
interface InlineCreateCardProps {
  // ...existing props
  onPlanningMode?: (initialPlan: string) => void;
  onSubtaskBreakdown?: (description: string) => void;
}
```

**QuickEntryBox new props:**
```typescript
interface QuickEntryBoxProps {
  // ...existing props
  onPlanningMode?: (initialPlan: string) => void;
  onSubtaskBreakdown?: (description: string) => void;
}
```

### Backward Compatibility

The `breakIntoSubtasks` field in `TaskCreateInput` is NOT being removed — it's still used by the triage agent when processing tasks. This task only changes the UI that users interact with.

### Related Tasks

- **KB-247** — Implements the actual subtask breakdown dialog. After this task (KB-248) is complete, KB-247 will:
  1. Create the `SubtaskBreakdownModal` component
  2. Update `App.tsx` to render the modal
  3. Replace the placeholder `handleSubtaskBreakdown` with actual implementation

### Testing Strategy

Focus tests on:
1. Button rendering (appear when there's content)
2. Button disabled state (when description empty)
3. Click handlers are called with correct description
4. Input is cleared after triggering either mode
5. Regular creation still works (regression test)

Don't test:
- PlanningModeModal behavior (already tested)
- Subtask dialog behavior (KB-247 tests that)
