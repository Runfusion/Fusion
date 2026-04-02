# Task: KB-656 - Don't auto expand the quick add view in list view

**Created:** 2026-04-01
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** Simple prop addition to control auto-expand behavior. Low blast radius, standard React pattern.
**Score:** 2/8 — Blast radius: 0, Pattern novelty: 0, Security: 0, Reversibility: 2

## Mission

Prevent the QuickEntryBox component from automatically expanding when focused in the list view. The board view (Column.tsx) should continue to auto-expand as before. This keeps the list view clean and uncluttered while preserving the streamlined board view experience.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/components/QuickEntryBox.tsx` — The quick entry component with auto-expand logic in `handleFocus`
- `packages/dashboard/app/components/ListView.tsx` — Where QuickEntryBox is used in list view
- `packages/dashboard/app/components/Column.tsx` — Where QuickEntryBox is used in board view (should keep auto-expand)
- `packages/dashboard/app/components/__tests__/QuickEntryBox.test.tsx` — Existing tests for the component

## File Scope

- `packages/dashboard/app/components/QuickEntryBox.tsx` (modified — add `autoExpand` prop)
- `packages/dashboard/app/components/ListView.tsx` (modified — pass `autoExpand={false}`)
- `packages/dashboard/app/components/__tests__/QuickEntryBox.test.tsx` (modified — add test for `autoExpand={false}`)

## Steps

### Step 1: Add autoExpand Prop to QuickEntryBox

- [ ] Add optional `autoExpand?: boolean` prop to `QuickEntryBoxProps` interface (default: `true` for backward compatibility)
- [ ] Modify `handleFocus` callback to check `autoExpand` prop before setting `isExpanded(true)`
- [ ] Ensure the component still works correctly when `autoExpand` is true (existing behavior) or false

**Artifacts:**
- `packages/dashboard/app/components/QuickEntryBox.tsx` (modified)

### Step 2: Update ListView to Disable Auto-Expand

- [ ] Pass `autoExpand={false}` prop to the `QuickEntryBox` component in `ListView.tsx`
- [ ] Verify the prop is correctly passed through to the component

**Artifacts:**
- `packages/dashboard/app/components/ListView.tsx` (modified)

### Step 3: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run existing QuickEntryBox tests to ensure backward compatibility (all should pass)
- [ ] Add new test case: `it("does not expand on focus when autoExpand is false")` in QuickEntryBox.test.tsx
- [ ] Verify the new test passes
- [ ] Run full test suite: `pnpm test`
- [ ] Fix all failures
- [ ] Build passes: `pnpm build`

### Step 4: Documentation & Delivery

- [ ] No documentation updates needed (internal component change)
- [ ] Create changeset file for the dashboard package patch

## Completion Criteria

- [ ] QuickEntryBox has new `autoExpand` prop with default `true`
- [ ] ListView passes `autoExpand={false}` to QuickEntryBox
- [ ] Board view (Column.tsx) continues to auto-expand (no changes needed, uses default)
- [ ] All existing tests pass
- [ ] New test for `autoExpand={false}` passes
- [ ] Full test suite passes
- [ ] Build passes

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step 1:** `feat(KB-656): add autoExpand prop to QuickEntryBox`
- **Step 2:** `feat(KB-656): disable auto-expand in list view`
- **Step 3:** `test(KB-656): add test for autoExpand={false}`
- **Step 4:** `chore(KB-656): add changeset for quick entry auto-expand change`

## Do NOT

- Change the default behavior of QuickEntryBox (must remain backward compatible)
- Modify the board view (Column.tsx) behavior
- Add visual expand/collapse buttons (out of scope — that's KB-657)
- Skip tests or rely on manual verification
