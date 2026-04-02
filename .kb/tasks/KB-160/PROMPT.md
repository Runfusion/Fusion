# Task: KB-160 - Expand Quick Entry Input When Selected

**Created:** 2026-03-30
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** This is a focused UI enhancement with localized changes to a single component. The pattern is straightforward (expandable textarea) and reversible. No security concerns.
**Score:** 2/8 — Blast radius: 0, Pattern novelty: 1, Security: 0, Reversibility: 1

## Mission

Transform the QuickEntryBox component from a single-line input to an auto-expanding textarea that grows when focused and supports multi-line task descriptions. The expanded input provides more space for users to type detailed task descriptions while maintaining the clean, compact appearance when not in use.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/components/QuickEntryBox.tsx` — Current implementation with single-line input
- `packages/dashboard/app/components/__tests__/QuickEntryBox.test.tsx` — Existing test suite
- `packages/dashboard/app/styles.css` (lines 7450-7485) — Current quick-entry styles
- `packages/dashboard/app/components/Column.tsx` — Parent component that renders QuickEntryBox

## File Scope

- `packages/dashboard/app/components/QuickEntryBox.tsx` (modify)
- `packages/dashboard/app/components/__tests__/QuickEntryBox.test.tsx` (modify)
- `packages/dashboard/app/styles.css` (modify — quick-entry styles section)

## Steps

### Step 1: Implement Expandable Textarea

- [ ] Replace `<input>` with `<textarea>` in QuickEntryBox
- [ ] Add `isExpanded` state controlled by focus/blur events
- [ ] Implement auto-resize logic: height grows with content up to max-height (200px)
- [ ] Modify Enter key handling: submit on Enter, but allow Shift+Enter for newlines when expanded
- [ ] Maintain focus management (keep focus after submit for rapid entry)
- [ ] Add escape key handling to collapse and clear if empty

**Artifacts:**
- `packages/dashboard/app/components/QuickEntryBox.tsx` (modified)

### Step 2: Update CSS for Expanded States

- [ ] Add `.quick-entry-input--expanded` class with increased min-height (80px) and transition
- [ ] Keep collapsed state compact (single line, ~36px height)
- [ ] Add smooth height transition using CSS transitions
- [ ] Ensure textarea has `resize: none` to prevent manual resize handle
- [ ] Update focus styles to work with textarea (remove border-bottom box-shadow approach, use outline)
- [ ] Test mobile appearance (should not zoom on iOS - font-size must stay ≥16px)

**Artifacts:**
- `packages/dashboard/app/styles.css` (modified — quick-entry section)

### Step 3: Update Tests for New Behavior

- [ ] Update existing tests to work with textarea instead of input
- [ ] Add test: input expands on focus
- [ ] Add test: input collapses on blur when empty
- [ ] Add test: Shift+Enter inserts newline when expanded
- [ ] Add test: Enter submits even when expanded (without Shift)
- [ ] Add test: auto-resize increases height with content
- [ ] Ensure all existing test behaviors still pass (submit on Enter, Escape to clear, error handling)

**Artifacts:**
- `packages/dashboard/app/components/__tests__/QuickEntryBox.test.tsx` (modified)

### Step 4: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm test` — all QuickEntryBox tests must pass
- [ ] Run `pnpm build` — dashboard must build without errors
- [ ] Manual verification: Input expands smoothly on focus
- [ ] Manual verification: Multi-line text entry works with Shift+Enter
- [ ] Manual verification: Submit on Enter still works
- [ ] Mobile check: No zoom-on-focus issues (iOS Safari)

### Step 5: Documentation & Delivery

- [ ] Update relevant documentation (none required for this UI change)
- [ ] Out-of-scope findings created as new tasks via `task_create` tool — none expected

## Documentation Requirements

**Must Update:**
- None — this is a self-documenting UI enhancement

**Check If Affected:**
- `AGENTS.md` — No updates needed (no new CLI/extension features)

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Input expands when focused and collapses when blurred (if empty)
- [ ] Multi-line entry works with Shift+Enter
- [ ] No mobile zoom issues on focus

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-160): complete Step N — description`
- **Bug fixes:** `fix(KB-160): description`
- **Tests:** `test(KB-160): description`

## Do NOT

- Change the QuickEntryBox props interface (keep `onCreate` and `addToast` signature)
- Modify Column.tsx or Board.tsx (parent components should need no changes)
- Use external libraries for auto-resize (implement with native scrollHeight)
- Break rapid-entry workflow (keep focus after submit, keep Enter-to-submit)
- Modify placeholder text or loading behavior
