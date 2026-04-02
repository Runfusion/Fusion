# Task: KB-239 - Fix inline-editor models selector rendering below card boundary

**Created:** 2026-03-31
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** CSS-only fix for dropdown z-index and overflow clipping. Well-understood problem with established pattern. Low risk, easily reversible.
**Score:** 2/8 — Blast radius: 0, Pattern novelty: 0, Security: 0, Reversibility: 2

## Mission

Fix the model selector dropdown in the inline editor (`QuickEntryBox` and `InlineCreateCard` components) that renders below the card boundary, causing it to be cut off and push the card layout to the side. The dropdown should render fully visible above all other UI elements without clipping.

## Dependencies

- **None**

## Context to Read First

1. `packages/dashboard/app/styles.css` — Review current CSS for:
   - `.inline-create-model-dropdown` (line ~2303) - currently has `z-index: 50`
   - `.model-combobox-dropdown` (line ~4958) - has `z-index: 100`
   - `.column` (line ~396) - has `overflow: hidden`
   - `.column-body` (line ~480) - has `overflow-x: hidden; overflow-y: auto`
   - `.dep-dropdown` (line ~2230) - has `z-index: 200` (reference for proper z-index)
   - `.quick-entry-model-wrap` (line ~8136) - already has `position: relative`

2. `packages/dashboard/app/components/QuickEntryBox.tsx` — Uses `inline-create-model-dropdown` class for model selector panel

3. `packages/dashboard/app/components/InlineCreateCard.tsx` — Same dropdown structure as QuickEntryBox

4. `packages/dashboard/app/components/CustomModelDropdown.tsx` — The nested dropdown component with `model-combobox-dropdown` class

## File Scope

- `packages/dashboard/app/styles.css` — Modify z-index value only

## Steps

### Step 1: Fix Dropdown z-index

- [ ] Increase `.inline-create-model-dropdown` z-index from `50` to `500` (must be higher than `.dep-dropdown`'s 200 to ensure proper stacking)
- [ ] Verify `.inline-create-model-wrap` has `position: relative` (establishes positioning context)
- [ ] Verify `.quick-entry-model-wrap` has `position: relative` (already exists at line ~8136)

**Artifacts:**
- `packages/dashboard/app/styles.css` (modified)

### Step 2: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full test suite: `pnpm test`
- [ ] Verify all existing tests pass
- [ ] Build passes: `pnpm build`
- [ ] Manual verification: Model selector dropdown in QuickEntryBox renders without clipping

### Step 3: Documentation & Delivery

- [ ] No documentation updates required (CSS fix only)
- [ ] Out-of-scope findings created as new tasks via `task_create` tool if any

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Model selector dropdown in QuickEntryBox renders fully without clipping
- [ ] Model selector dropdown in InlineCreateCard renders fully without clipping

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-239): complete Step N — description`
- **Bug fixes:** `fix(KB-239): description`
- **Tests:** `test(KB-239): description`

## Do NOT

- Modify React component logic (this is a pure CSS fix)
- Remove overflow properties from `.column` or `.column-body` (would break layout)
- Use `position: fixed` with JavaScript calculations (overkill for this issue)
- Add new dependencies
- Skip tests
- Expand task scope beyond the dropdown clipping issue
