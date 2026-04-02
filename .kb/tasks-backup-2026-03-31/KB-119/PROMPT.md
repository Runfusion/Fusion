# Task: KB-119 - Fix the styling of the new task dialog

**Created:** 2026-03-30
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** This is a focused CSS/layout fix for the NewTaskModal component. The styling issues are contained to a single modal component with no API changes, no state management changes, and no cross-component dependencies. Low blast radius and easily reversible.
**Score:** 3/8 — Blast radius: 1, Pattern novelty: 1, Security: 0, Reversibility: 1

## Mission

Fix the styling issues in the New Task dialog (NewTaskModal) to improve visual consistency, spacing, and usability. The modal currently has several layout problems that make it feel cramped and inconsistent with other modals in the dashboard.

Key issues to address:
1. **Model selector layout** — The executor/validator rows use flex but lack proper alignment; labels and comboboxes don't line up cleanly
2. **Dependency dropdown z-index** — The dropdown may render under other elements or overflow the modal incorrectly
3. **Form group spacing** — Multiple form groups stack with inconsistent visual separation between sections
4. **Attachment previews** — The inline-create-preview elements may not wrap correctly on smaller modal widths
5. **Checkbox alignment** — The planning mode checkbox label alignment is slightly off
6. **Modal body scroll** — Long content (many dependencies, multiple attachments) doesn't scroll gracefully
7. **Button alignment** — Modal action buttons could be better positioned

## Dependencies

- **None**

## Context to Read First

1. `/Users/eclipxe/Projects/kb/packages/dashboard/app/components/NewTaskModal.tsx` — The modal component that needs styling fixes
2. `/Users/eclipxe/Projects/kb/packages/dashboard/app/components/TaskDetailModal.tsx` — Reference modal with good layout patterns
3. `/Users/eclipxe/Projects/kb/packages/dashboard/app/styles.css` — Review `.new-task-modal`, `.model-combobox*`, `.dep-*`, and `.modal-*` styles
4. `/Users/eclipxe/Projects/kb/packages/dashboard/app/components/__tests__/NewTaskModal.test.tsx` — Understand current test coverage

## File Scope

- `packages/dashboard/app/components/NewTaskModal.tsx` (modify — minimal changes, mostly className adjustments)
- `packages/dashboard/app/styles.css` (modify — add/fix `.new-task-modal*` specific styles)
- `packages/dashboard/app/components/__tests__/NewTaskModal.test.tsx` (verify — ensure tests still pass)

## Steps

### Step 1: Fix Model Selector Layout

- [ ] Improve `.model-select-row` flex alignment — ensure labels and comboboxes align to a consistent grid
- [ ] Add `align-items: center` and ensure consistent gap between label and combobox
- [ ] Fix `.model-select-label` to have consistent width so both "Executor" and "Validator" labels align their comboboxes
- [ ] Ensure `.model-combobox` takes remaining width properly
- [ ] Add proper spacing between the two model rows (currently `margin-bottom: 12px` is on the row, may need adjustment)
- [ ] Run NewTaskModal tests to verify no regressions: `cd packages/dashboard && pnpm test NewTaskModal`

**Artifacts:**
- `packages/dashboard/app/styles.css` (modified — `.model-select-row`, `.model-select-label`)
- `packages/dashboard/app/components/NewTaskModal.tsx` (potentially modified — className adjustments if needed)

### Step 2: Fix Dependency Dropdown and Chips Layout

- [ ] Review `.dep-dropdown` positioning — ensure `z-index` is appropriate (should be above modal content, below modal overlay)
- [ ] Fix dropdown width to match the trigger button or have a sensible min/max width
- [ ] Add proper `max-height` and `overflow-y: auto` to `.dep-dropdown` for long task lists
- [ ] Improve `.selected-deps` container — ensure chips wrap nicely with consistent gap
- [ ] Fix `.dep-chip` styling — ensure remove button is properly sized and aligned
- [ ] Verify dropdown closes when clicking outside (existing behavior should work, but verify after style changes)
- [ ] Run NewTaskModal tests to verify dependency selection still works

**Artifacts:**
- `packages/dashboard/app/styles.css` (modified — `.dep-dropdown`, `.selected-deps`, `.dep-chip`, `.dep-chip-remove`)

### Step 3: Improve Form Spacing and Visual Hierarchy

- [ ] Add subtle visual separation between major form sections (Title, Description, Dependencies, Model Config, Attachments)
- [ ] Consider adding a light border or increased padding between form groups
- [ ] Fix `.new-task-modal .modal-body` padding to be consistent with other modals (currently `16px 20px`, verify this matches)
- [ ] Ensure the description textarea auto-resizes smoothly without causing layout shift
- [ ] Add proper spacing below the checkbox for planning mode and its helper text
- [ ] Ensure small/helper text ("You can also paste images or drag & drop", "No models available...") has consistent styling
- [ ] Run NewTaskModal tests

**Artifacts:**
- `packages/dashboard/app/styles.css` (modified — `.new-task-modal` section, `.form-group` spacing adjustments)

### Step 4: Fix Attachment Previews Layout

- [ ] Improve `.inline-create-previews` container — ensure flex wrapping works correctly
- [ ] Fix `.inline-create-preview` sizing — ensure consistent 48x48px squares that don't stretch
- [ ] Verify remove button (`.inline-create-preview-remove`) is positioned correctly within preview
- [ ] Ensure previews don't overflow the modal width when many images are attached
- [ ] Add `max-height` with scroll if needed for many attachments
- [ ] Run NewTaskModal tests

**Artifacts:**
- `packages/dashboard/app/styles.css` (modified — `.inline-create-previews`, `.inline-create-preview`)

### Step 5: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full dashboard test suite: `cd packages/dashboard && pnpm test`
- [ ] Verify all NewTaskModal tests pass
- [ ] Build the dashboard: `cd packages/dashboard && pnpm build`
- [ ] Manual visual verification checklist:
  - [ ] Modal opens without visual glitches
  - [ ] Title field appears at top with proper spacing
  - [ ] Description textarea auto-resizes smoothly
  - [ ] Model selectors (Executor/Validator) align in a clean grid
  - [ ] Model combobox dropdown opens and displays properly without overflow issues
  - [ ] Dependency dropdown opens, shows tasks, and can be selected
  - [ ] Selected dependency chips display in a clean row with proper remove buttons
  - [ ] Planning mode checkbox aligns with its label
  - [ ] Attachment previews show as square thumbnails in a wrapping grid
  - [ ] Cancel and Create Task buttons align properly at bottom
  - [ ] Modal is scrollable when content is long (test with many dependencies + attachments)
  - [ ] No console errors or warnings

### Step 6: Documentation & Delivery

- [ ] Update any inline comments in NewTaskModal.tsx if layout structure changed significantly
- [ ] Create changeset for the styling fix: `cat > .changeset/fix-new-task-modal-styling.md << 'EOF'
---
"@dustinbyrne/kb": patch
---

Fix New Task dialog styling — improved model selector alignment, dependency dropdown layout, form spacing, and attachment preview grid.
EOF`
- [ ] Out-of-scope findings: If you discover functional issues with the modal (not just styling), create new tasks via `task_create` tool

## Documentation Requirements

**Must Update:**
- None required — this is a visual fix

**Check If Affected:**
- `packages/dashboard/README.md` — check if there's documentation about creating tasks that might need updates

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Styling matches dashboard design standards (consistent with TaskDetailModal and PlanningModeModal)
- [ ] No visual regressions in other modals that share CSS classes
- [ ] Changeset created

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-119): complete Step N — description`
- **Bug fixes:** `fix(KB-119): description`
- **Tests:** `test(KB-119): description`

Example commits:
- `feat(KB-119): complete Step 1 — fix model selector row alignment`
- `feat(KB-119): complete Step 2 — improve dependency dropdown and chips layout`
- `feat(KB-119): complete Step 3 — improve form spacing and visual hierarchy`
- `feat(KB-119): complete Step 4 — fix attachment previews layout`

## Do NOT

- Expand task scope to redesign the entire modal or add new features
- Skip the test verification step
- Modify the task creation logic, API calls, or state management — this is strictly a styling/CSS fix
- Change the modal's behavior (opening, closing, dirty state detection) — only visual changes
- Break existing test assertions unless the test is checking for invalid layout behavior
- Use `!important` in CSS to override styles — use proper specificity instead
- Modify files outside the File Scope without good reason
