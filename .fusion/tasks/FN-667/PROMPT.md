# Task: FN-667 - Fix Model Selector Dropdown Z-Index

**Created:** 2026-04-01
**Size:** S

## Review Level: 0 (None)

**Assessment:** Simple CSS z-index adjustment to fix rendering order. No logic changes, no API changes, no security implications. Easily reversible.
**Score:** 1/8 — Blast radius: 0, Pattern novelty: 0, Security: 1, Reversibility: 0

## Mission

Fix the model selector dropdown in the Task Detail Modal so it renders above the board instead of being obscured behind it. The dropdown currently has `z-index: 100` which conflicts with the modal overlay's `z-index: 100`, causing it to appear behind board elements when opened.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/styles.css` — Search for `.model-combobox-dropdown` to understand current styling (line ~6063)
- `packages/dashboard/app/components/CustomModelDropdown.tsx` — The dropdown component that uses these styles
- `packages/dashboard/app/components/TaskDetailModal.tsx` — Where the Model selector tab is rendered inside a modal

## File Scope

- `packages/dashboard/app/styles.css` — Modify one CSS property

## Steps

### Step 1: Update Z-Index Value

- [ ] Locate `.model-combobox-dropdown` in `packages/dashboard/app/styles.css` (around line 6063)
- [ ] Change `z-index: 100` to `z-index: 500` (higher than modal-overlay's 100)
- [ ] Verify the dropdown still has proper `position: absolute` (should already be set)

**Artifacts:**
- `packages/dashboard/app/styles.css` (modified)

### Step 2: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run all dashboard tests: `pnpm test -- packages/dashboard`
- [ ] Verify all tests pass
- [ ] Build passes: `pnpm build`

### Step 3: Documentation & Delivery

- [ ] No documentation updates needed (CSS-only fix)
- [ ] Create changeset for the patch release:
  ```bash
  cat > .changeset/fix-model-dropdown-zindex.md << 'EOF'
  ---
  "@gsxdsm/fusion": patch
  ---

  Fix model selector dropdown z-index so it renders above the board in task detail modal.
  EOF
  ```

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Changeset file created

## Git Commit Convention

- **Step completion:** `feat(FN-667): complete Step 1 — increase model dropdown z-index to 500`
- **Changeset:** `feat(FN-667): add changeset for model dropdown z-index fix`

## Do NOT

- Add JavaScript/TypeScript changes (CSS-only fix)
- Modify the CustomModelDropdown component logic
- Change modal-overlay or board z-index values (unnecessary)
- Skip tests
