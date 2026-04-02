# Task: KB-240 - Move spec area edit button to the top

**Created:** 2026-03-31
**Size:** S

## Review Level: 0 (None)

**Assessment:** Simple UI repositioning of a single button within an existing component. No logic changes, no API changes, no security implications. Pure layout adjustment.
**Score:** 1/8 — Blast radius: 0, Pattern novelty: 0, Security: 0, Reversibility: 1

## Mission

Move the "Edit" button in the spec area of the TaskDetailModal from its current position at the bottom of the spec content to the top of the spec section. This improves UX by making the edit action immediately visible when viewing the specification, rather than requiring the user to scroll to find it.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/components/TaskDetailModal.tsx` — The task detail modal component containing the spec section with the edit button
- `packages/dashboard/app/components/__tests__/TaskDetailModal.test.tsx` — Tests for the task detail modal that may reference the edit button location
- `packages/dashboard/app/styles.css` — Styles for the detail section and spec area

## File Scope

- `packages/dashboard/app/components/TaskDetailModal.tsx` (modified)
- `packages/dashboard/app/components/__tests__/TaskDetailModal.test.tsx` (modified if needed)

## Steps

### Step 1: Move Edit Button to Top of Spec Section

- [ ] Locate the spec section in TaskDetailModal.tsx (around the area with `className="detail-section"` containing the spec content)
- [ ] Find the current edit button placement at the bottom (the `!isEditingSpec` conditional block with `<button className="btn btn-sm" onClick={enterSpecEditMode}>Edit</button>`)
- [ ] Move the edit button to appear BEFORE the spec content (above the `isEditingSpec` ternary or at the start of the section)
- [ ] Ensure the button remains conditionally rendered only when `!isEditingSpec`
- [ ] Maintain consistent styling - use similar layout to SpecEditor.tsx which has its toolbar at the top
- [ ] Remove or adjust the `marginTop: "12px"` inline style as appropriate for top placement

**Artifacts:**
- `packages/dashboard/app/components/TaskDetailModal.tsx` (modified)

### Step 2: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm test` in the dashboard package
- [ ] Verify existing TaskDetailModal tests pass
- [ ] If any tests check for the edit button's DOM position/ordering, update them to reflect the new top placement
- [ ] Build passes: `pnpm build`

### Step 3: Documentation & Delivery

- [ ] Verify the button appears at the top of the spec section in the UI
- [ ] No documentation updates required (UI-only change)

## Completion Criteria

- [ ] Edit button appears at the top of the spec section (above the markdown content)
- [ ] Button is hidden when in edit mode (`isEditingSpec` is true)
- [ ] Button still triggers `enterSpecEditMode` when clicked
- [ ] All tests pass
- [ ] Build passes

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-240): complete Step 1 — move spec edit button to top`
- **Tests:** `test(KB-240): update tests for spec edit button position`

## Do NOT

- Change the button's styling significantly (keep it as `btn btn-sm`)
- Modify the edit mode behavior or the spec editing functionality
- Add new dependencies
- Change the SpecEditor.tsx component (that's a separate component with its own toolbar)
