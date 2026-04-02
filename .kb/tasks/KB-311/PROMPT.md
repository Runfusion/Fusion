# Task: KB-311 - Reduce the Size of the Id Column in the List View

**Created:** 2026-03-31
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** Simple CSS-only change to tighten the ID column layout. Limited blast radius affecting only the list view table styling. Fully reversible by reverting CSS changes.
**Score:** 3/8 — Blast radius: 1, Pattern novelty: 0, Security: 0, Reversibility: 2

## Mission

Reduce the visual width of the "Id" column in the dashboard's list view table. Currently, the ID column takes up excessive horizontal space relative to the compact task IDs (e.g., "KB-001"). The goal is to make the column more compact while maintaining readability and visual hierarchy.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/components/ListView.tsx` — Understand the ID column structure and CSS classes used
- `packages/dashboard/app/styles.css` — Review current `.list-cell-id` and `.list-header-cell` styles (around lines 3896-4010)
- `packages/dashboard/app/components/__tests__/ListView.test.tsx` — Existing test suite to verify no regressions

## File Scope

- `packages/dashboard/app/styles.css` — Modify CSS rules for `.list-cell-id` and `.list-table th:first-child.list-header-cell`

## Steps

### Step 1: Analyze Current ID Column Sizing

- [ ] Review current `.list-cell-id` styles in `styles.css` (line ~3977)
- [ ] Review header cell styles `.list-table th:first-child.list-header-cell` (line ~3913)
- [ ] Identify the current padding values causing excess width
- [ ] Determine appropriate compact sizing (suggest: reduce horizontal padding, potentially add `width` or `max-width`)

### Step 2: Implement Compact ID Column Styles

- [ ] Update `.list-cell-id` to reduce horizontal padding (suggested: `padding: 12px 4px 12px 16px` or similar)
- [ ] Add `width: auto` or `max-width: 80px` if needed to constrain the column
- [ ] Update `.list-table th:first-child.list-header-cell` to match data cell padding
- [ ] Ensure text remains vertically aligned with other columns
- [ ] Verify `white-space: nowrap` is preserved to prevent ID wrapping

### Step 3: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run dashboard test suite: `pnpm test --filter @kb/dashboard`
- [ ] Verify all existing ListView tests pass
- [ ] Manually verify the ID column appears more compact in the UI
- [ ] Test with various ID lengths (KB-1 through KB-999) to ensure readability
- [ ] Verify the column still sorts correctly when header is clicked
- [ ] Check that column visibility toggle (hide/show columns) still works for ID column
- [ ] Verify responsive behavior at different screen widths

### Step 4: Documentation & Delivery

- [ ] No documentation updates required for this visual tweak
- [ ] Create changeset file for the patch:
  ```bash
  cat > .changeset/reduce-list-id-column-width.md << 'EOF'
  ---
  "@dustinbyrne/kb": patch
  ---

  Reduce the width of the ID column in the dashboard list view for more compact layout.
  EOF
  ```
- [ ] Include changeset in the commit

## Completion Criteria

- [ ] ID column in list view is visibly more compact (reduced horizontal padding/width)
- [ ] All ListView tests pass
- [ ] No visual regressions in column alignment or readability
- [ ] Changeset file created and included in commit

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-311): complete Step N — description`
- **Bug fixes:** `fix(KB-311): description`
- **Tests:** `test(KB-311): description`

## Do NOT

- Expand task scope to other column width adjustments
- Skip tests
- Modify TypeScript/JSX files unless absolutely necessary
- Break table layout or column alignment
- Remove or alter the `white-space: nowrap` property on IDs
