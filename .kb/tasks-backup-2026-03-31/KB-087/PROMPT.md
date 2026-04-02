# Task: KB-087 - Remove created and updated columns from list view

**Created:** 2026-03-30
**Size:** S

## Review Level: 0 (None)

**Assessment:** This is a simple UI cleanup task - removing two columns from a table. No security implications, no new patterns, easily reversible.
**Score:** 1/8 — Blast radius: 0, Pattern novelty: 0, Security: 0, Reversibility: 1

## Mission

Remove the "Created" and "Updated" date columns from the dashboard's list view. These columns clutter the interface and the date information is already available in the task detail modal if needed.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/components/ListView.tsx` — Main component with column definitions and rendering
- `packages/dashboard/app/components/__tests__/ListView.test.tsx` — Tests for the list view

## File Scope

- `packages/dashboard/app/components/ListView.tsx` (modify)
- `packages/dashboard/app/components/__tests__/ListView.test.tsx` (modify)

## Steps

### Step 1: Remove createdAt and updatedAt columns from ListView

- [ ] Remove `createdAt` and `updatedAt` from `ALL_LIST_COLUMNS` array
- [ ] Remove `createdAt` and `updatedAt` from `SortField` type
- [ ] Remove `createdAt` and `updatedAt` entries from `COLUMN_LABELS_MAP`
- [ ] Remove the two header `<th>` cells for "Created" and "Updated"
- [ ] Remove the two data `<td>` cells for `createdAt` and `updatedAt` in the task row
- [ ] Remove `formatDate` function if it's no longer used anywhere
- [ ] Update default `sortField` state from `"createdAt"` to `"id"`

**Artifacts:**
- `packages/dashboard/app/components/ListView.tsx` (modified)

### Step 2: Update tests

- [ ] Remove or update tests that reference "Created" column text
- [ ] Remove or update tests that reference "Updated" column text
- [ ] Remove test "formats dates correctly" (no longer applicable)
- [ ] Update any tests that rely on `createdAt` sorting being the default

**Artifacts:**
- `packages/dashboard/app/components/__tests__/ListView.test.tsx` (modified)

### Step 3: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm test` and fix all failures
- [ ] Run `pnpm build` and ensure clean build
- [ ] Verify list view still renders correctly with remaining columns (ID, Title, Status, Column, Dependencies, Progress)

### Step 4: Documentation & Delivery

- [ ] No documentation changes required (UI only)
- [ ] No out-of-scope findings expected

## Documentation Requirements

**Must Update:**
- None

**Check If Affected:**
- None

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] List view displays without Created/Updated columns
- [ ] Sorting still works on remaining columns

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-087): complete Step N — description`
- **Bug fixes:** `fix(KB-087): description`
- **Tests:** `test(KB-087): description`

## Do NOT

- Expand task scope (don't add new columns or features)
- Skip tests
- Modify files outside the File Scope
- Leave unused imports or dead code
