# Task: KB-234 - Double Click on Spec to Edit

**Created:** 2026-03-31
**Size:** S

## Review Level: 0 (None)

**Assessment:** Simple UI enhancement adding double-click interaction to SpecEditor. Follows established pattern from TaskCard. Low blast radius, no security implications, easily reversible.
**Score:** 1/8 — Blast radius: 0, Pattern novelty: 1, Security: 0, Reversibility: 0

## Mission

Add a double-click interaction to the SpecEditor component's view mode that allows users to quickly enter edit mode. This matches the interaction pattern already established in TaskCard (where double-clicking enters inline edit mode) and provides a faster path for users who want to modify the task specification without clicking the Edit button in the toolbar.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/components/SpecEditor.tsx` — The spec editor component with View/Edit toggle modes
- `packages/dashboard/app/components/TaskCard.tsx` — Reference implementation of double-click-to-edit (see `handleDoubleClick` and `enterEditMode`)

## File Scope

- `packages/dashboard/app/components/SpecEditor.tsx` (modify)
- `packages/dashboard/app/components/__tests__/SpecEditor.test.tsx` (modify — add new tests)
- `packages/dashboard/app/styles.css` (modify — add cursor styling for spec editor)

## Steps

### Step 1: Add Double-Click Handler to SpecEditor

- [ ] Add `onDoubleClick` handler to the markdown view container (`.markdown-body` div) in SpecEditor
- [ ] Double-click should only work when `readOnly` is false and not already in edit mode
- [ ] Stop propagation to prevent parent handlers from firing
- [ ] Enter edit mode on double-click (same behavior as clicking the Edit button)
- [ ] Add CSS cursor style using scoped selector: `.spec-editor:not(.spec-editor-readonly) .markdown-body { cursor: pointer; }`

**Artifacts:**
- `packages/dashboard/app/components/SpecEditor.tsx` (modified)
- `packages/dashboard/app/styles.css` (modified)

### Step 2: Add Tests to Existing SpecEditor Test File

- [ ] Open existing test file `packages/dashboard/app/components/__tests__/SpecEditor.test.tsx`
- [ ] Add test: double-click enters edit mode when not in readOnly mode
- [ ] Add test: double-click does nothing when `readOnly` is true
- [ ] Add test: double-click does nothing when already in edit mode
- [ ] Add test: Escape key cancels edit mode (this gap exists in current tests)
- [ ] Run tests and ensure all pass

**Artifacts:**
- `packages/dashboard/app/components/__tests__/SpecEditor.test.tsx` (modified)

### Step 3: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full test suite: `pnpm test`
- [ ] Verify SpecEditor tests pass
- [ ] Verify no regressions in dashboard tests
- [ ] Build passes: `pnpm build`

### Step 4: Documentation & Delivery

- [ ] No documentation updates needed (UI behavior is self-discoverable)
- [ ] No changeset needed (UI enhancement, not user-facing CLI feature)
- [ ] Out-of-scope findings created as new tasks via `task_create` tool if any

## Documentation Requirements

**Must Update:**
- None

**Check If Affected:**
- None

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Double-click on spec view enters edit mode
- [ ] Feature works in TaskDetailModal's Spec tab

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-234): complete Step N — description`
- **Bug fixes:** `fix(KB-234): description`
- **Tests:** `test(KB-234): description`

## Do NOT

- Expand task scope (no other components, no planning mode integration)
- Skip tests
- Modify files outside the File Scope
- Add complex features (save on blur, autosave, etc.)
- Commit without the task ID prefix
