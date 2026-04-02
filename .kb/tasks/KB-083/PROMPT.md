# Task: KB-083 - Fix the layout of the edit view in the spec editor on a card

**Created:** 2026-03-30
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** This is a focused UI layout fix within a single component. The SpecEditor textarea needs proper CSS to fill available space and handle modal constraints gracefully.
**Score:** 3/8 — Blast radius: 1, Pattern novelty: 0, Security: 0, Reversibility: 2

## Mission

Fix the layout of the SpecEditor component's edit view so that the textarea properly fills the available modal space without overflowing or creating awkward scrolling behavior. Currently, the textarea uses a fixed `rows={20}` attribute but lacks CSS styling to handle the constrained modal viewport, causing layout issues when editing specifications on a card.

## Dependencies

- **None**

## Context to Read First

1. `packages/dashboard/app/components/SpecEditor.tsx` — The component to fix
2. `packages/dashboard/app/components/TaskDetailModal.tsx` — See how SpecEditor is used in the "spec" tab
3. `packages/dashboard/app/styles.css` — Existing CSS patterns for reference
4. `packages/dashboard/app/components/__tests__/SpecEditor.test.tsx` — Existing tests

## File Scope

- `packages/dashboard/app/components/SpecEditor.tsx` (modified)
- `packages/dashboard/app/styles.css` (modified — add spec-editor CSS section)
- `packages/dashboard/app/components/__tests__/SpecEditor.test.tsx` (modified — add layout tests)

## Steps

### Step 1: Add CSS Styles for SpecEditor Layout

- [ ] Add a new CSS section for `.spec-editor` components in `packages/dashboard/app/styles.css`
- [ ] Style `.spec-editor` as a flex column that fills available height
- [ ] Style `.spec-editor-content` to flex and scroll properly within the modal
- [ ] Style `.spec-editor-textarea` to fill available space (width: 100%, min-height, flex: 1)
- [ ] Ensure `.spec-editor-toolbar` stays fixed at top while content scrolls
- [ ] Ensure `.spec-editor-revision` section stays at bottom
- [ ] Add responsive styles for mobile (max-width: 768px)
- [ ] Run `pnpm build` to verify CSS compiles

**Artifacts:**
- `packages/dashboard/app/styles.css` (modified — new spec-editor section)

### Step 2: Update SpecEditor Component

- [ ] Wrap textarea in a flex container that fills available space
- [ ] Replace hardcoded `rows={20}` with CSS-based sizing (use flex: 1)
- [ ] Add CSS classes to all key elements (already partially done, verify completeness)
- [ ] Ensure keyboard hint and revision sections don't overlap with textarea
- [ ] Test manually by opening a task card and switching to Spec tab

**Artifacts:**
- `packages/dashboard/app/components/SpecEditor.tsx` (modified)

### Step 3: Add Layout Tests

- [ ] Add test: "textarea fills available width in edit mode"
- [ ] Add test: "spec-editor-content has correct flex direction"
- [ ] Add test: "toolbar remains visible when content is long"
- [ ] Run SpecEditor tests: `pnpm test -- --run app/components/__tests__/SpecEditor.test.tsx`
- [ ] All tests must pass

**Artifacts:**
- `packages/dashboard/app/components/__tests__/SpecEditor.test.tsx` (modified)

### Step 4: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full test suite: `pnpm test`
- [ ] Build passes: `pnpm build`
- [ ] Manual verification: Open task detail modal → Spec tab → click Edit → verify textarea fills space properly
- [ ] Manual verification: Resize browser window → verify responsive behavior
- [ ] Manual verification: Test with very long spec content → verify scrolling works correctly

### Step 5: Documentation & Delivery

- [ ] Create changeset for the UI fix (patch level)
- [ ] Verify no layout regressions in other modal tabs
- [ ] Out-of-scope findings created as new tasks via `task_create` tool

## Documentation Requirements

**Must Update:**
- None required — this is a bug fix with no user-facing documentation changes

**Check If Affected:**
- `AGENTS.md` — No update needed for this UI fix

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] SpecEditor edit view fills available modal space properly
- [ ] No layout overflow or scrolling issues in the modal
- [ ] Mobile responsive layout works correctly

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-083): complete Step N — description`
- **Bug fixes:** `fix(KB-083): description`
- **Tests:** `test(KB-083): description`
- **Changeset:** Include `.changeset/*.md` in the relevant commit

## Do NOT

- Expand task scope to redesign the entire SpecEditor UI
- Skip tests
- Modify files outside the File Scope without good reason
- Commit without the task ID prefix
- Break existing functionality in other modal tabs
