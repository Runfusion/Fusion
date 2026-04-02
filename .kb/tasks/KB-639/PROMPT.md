# Task: KB-639 - Add Dismiss Warning to Planning Mode Dialog

**Created:** 2026-04-01
**Size:** S

## Review Level: 0 (None)

**Assessment:** This is a focused UI enhancement that mirrors an existing pattern from SubtaskBreakdownModal. No architectural changes or complex logic involved.
**Score:** 2/8 — Blast radius: 0, Pattern novelty: 0, Security: 0, Reversibility: 2

## Mission

Add a confirmation warning when users attempt to dismiss the Planning Mode dialog with unsaved progress. The SubtaskBreakdownModal already implements this pattern - users see "Close subtask breakdown? Unsaved changes will be lost." when closing with pending changes. The PlanningModeModal should provide the same protection, but currently only shows this warning on Escape key press (lines 170-174), not when clicking the X button or clicking the overlay.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/components/SubtaskBreakdownModal.tsx` — Reference implementation showing the `handleClose` function with dirty state checking and confirm dialog (lines 120-135)
- `packages/dashboard/app/components/PlanningModeModal.tsx` — Target file. Note:
  - Escape key handler already has confirmation logic (lines 170-174)
  - `handleCancel` function (lines 213-232) lacks this check
  - X button and overlay click both call `handleCancel` directly without warning

## File Scope

- `packages/dashboard/app/components/PlanningModeModal.tsx` (modified)
- `packages/dashboard/app/components/PlanningModeModal.test.tsx` (modified — add/update tests)

## Steps

### Step 0: Preflight

- [ ] Required files exist and are readable
- [ ] Dependencies satisfied

### Step 1: Add Progress Tracking State and Update handleCancel

- [ ] Add a `hasProgress` state (or similar) to track when user has made planning progress
- [ ] Set `hasProgress` to `true` when:
  - Planning session starts (question or summary view entered)
  - User submits any response
  - User edits the summary
- [ ] Update `handleCancel` to check `hasProgress` and show confirm dialog:
  - Message: "Are you sure you want to close? Your planning progress will be lost."
  - Only call `onClose()` if confirmed or no progress exists
- [ ] Keep the existing Escape key handler behavior consistent (it can use the same `hasProgress` check)

**Artifacts:**
- `packages/dashboard/app/components/PlanningModeModal.tsx` (modified)

### Step 2: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm test` to verify existing tests pass
- [ ] Update or add tests in `PlanningModeModal.test.tsx` to verify:
  - Clicking X button with progress shows confirmation
  - Clicking overlay with progress shows confirmation
  - No confirmation shown when no progress made (initial state)
  - No confirmation shown after task is created
- [ ] Run full test suite: `pnpm test`
- [ ] Fix all failures
- [ ] Build passes: `pnpm build`

### Step 3: Documentation & Delivery

- [ ] Verify no documentation updates needed (internal UI behavior change)
- [ ] Out-of-scope findings created as new tasks via `task_create` tool if any

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Build passes

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-639): complete Step N — description`
- **Bug fixes:** `fix(KB-639): description`
- **Tests:** `test(KB-639): description`

## Do NOT

- Expand task scope beyond the dismiss warning
- Skip tests
- Modify SubtaskBreakdownModal (reference only)
- Change the planning logic or question flow
- Add new dependencies
