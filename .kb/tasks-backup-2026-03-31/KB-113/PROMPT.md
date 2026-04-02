# Task: KB-113 - Fix the layout of the edit view in the spec editor on a card

**Created:** 2026-03-30
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** This is a focused UI layout fix within the task detail modal. The SpecEditor component needs its parent container to provide proper flex constraints so the textarea fills available vertical space.
**Score:** 3/8 — Blast radius: 1, Pattern novelty: 0, Security: 0, Reversibility: 2

## Mission

Fix the layout of the SpecEditor component's edit view when displayed inside a task card's detail modal. Currently, the textarea does not properly fill the available vertical space in the modal because the parent `.detail-section` container lacks proper flex constraints. The edit view should fill the available height between the tabs and the modal bottom, with proper scrolling behavior.

## Dependencies

- **None**

## Context to Read First

1. `packages/dashboard/app/components/SpecEditor.tsx` — The editor component (already has proper CSS classes)
2. `packages/dashboard/app/components/TaskDetailModal.tsx` — See how SpecEditor is rendered in the spec tab (line ~450)
3. `packages/dashboard/app/styles.css` — Check `.detail-section`, `.detail-body`, and `.spec-editor` CSS rules
4. `packages/dashboard/app/components/__tests__/SpecEditor.test.tsx` — Existing tests

## File Scope

- `packages/dashboard/app/components/TaskDetailModal.tsx` (modified — add wrapper class for spec tab)
- `packages/dashboard/app/styles.css` (modified — add `.detail-section--spec` styles)

## Steps

### Step 1: Add CSS for Spec Tab Layout

- [ ] Add `.detail-section--spec` class in `packages/dashboard/app/styles.css`
- [ ] Style it with `display: flex`, `flex-direction: column`, `flex: 1`, `min-height: 0`
- [ ] Ensure it fills available space within `.detail-body` flex container
- [ ] Add responsive styles for mobile (max-width: 768px)
- [ ] Run `pnpm build` to verify CSS compiles

**Artifacts:**
- `packages/dashboard/app/styles.css` (modified — new `.detail-section--spec` section near other detail-section styles)

### Step 2: Update TaskDetailModal Spec Tab

- [ ] Change the spec tab wrapper from `<div className="detail-section">` to `<div className="detail-section detail-section--spec">`
- [ ] Verify no other tabs are affected (definition, activity, agent-log, steering, model, files)
- [ ] Ensure the SpecEditor props remain unchanged

**Artifacts:**
- `packages/dashboard/app/components/TaskDetailModal.tsx` (modified — single className change)

### Step 3: Verify SpecEditor CSS is Correct

- [ ] Confirm `.spec-editor` has `display: flex`, `flex-direction: column`, `height: 100%`
- [ ] Confirm `.spec-editor-content` has `flex: 1`, `min-height: 0`, `overflow-y: auto`
- [ ] Confirm `.spec-editor-textarea` has `width: 100%`, `min-height: 200px`, `flex: 1`, `resize: none`
- [ ] If any CSS is missing, add it to the spec-editor section in styles.css

**Artifacts:**
- `packages/dashboard/app/styles.css` (verify existing spec-editor styles)

### Step 4: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full test suite: `pnpm test`
- [ ] Build passes: `pnpm build`
- [ ] Manual verification: Open task detail modal → Spec tab → click Edit → verify textarea fills vertical space
- [ ] Manual verification: Type/paste long content → verify textarea grows and scrolls correctly
- [ ] Manual verification: Resize browser window → verify layout adapts correctly
- [ ] Manual verification: Test on mobile viewport (≤768px) → verify responsive layout works
- [ ] Verify no layout regressions in other modal tabs

### Step 5: Documentation & Delivery

- [ ] Create changeset for the UI fix (patch level)
- [ ] Out-of-scope findings created as new tasks via `task_create` tool

## Documentation Requirements

**Must Update:**
- None required — this is a bug fix with no user-facing documentation changes

**Check If Affected:**
- `AGENTS.md` — No update needed for this UI fix

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] SpecEditor edit view fills available vertical space in the modal
- [ ] Textarea properly sizes to fill space between tabs and bottom of modal
- [ ] Scrolling works correctly for long content
- [ ] Mobile responsive layout works correctly
- [ ] No layout regressions in other modal tabs

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-113): complete Step N — description`
- **Bug fixes:** `fix(KB-113): description`
- **Changeset:** Include `.changeset/*.md` in the relevant commit

## Do NOT

- Expand task scope to redesign the entire SpecEditor UI
- Skip tests
- Modify files outside the File Scope without good reason
- Commit without the task ID prefix
- Break existing functionality in other modal tabs
- Add unnecessary complexity to the layout
