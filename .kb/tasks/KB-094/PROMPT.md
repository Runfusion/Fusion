# Task: KB-094 - Polish GitHub Import Modal UI

**Created:** 2026-03-30
**Size:** M

## Review Level: 1 (Plan Only)

**Assessment:** This is a contained UI/UX improvement limited to the dashboard import modal and its tests. Risk is moderate because the modal has several state branches (remote detection, loading, imported issues, preview), but behavior changes are reversible and isolated.
**Score:** 3/8 — Blast radius: 1, Pattern novelty: 1, Security: 0, Reversibility: 1

## Mission

Improve the dashboard “Import from GitHub” dialog so it looks polished, readable, and modern without changing GitHub import business logic. The modal already works, but visual hierarchy and spacing are weak; this task should improve structure and state clarity (loading/empty/error/selected/imported) while preserving existing behavior (`handleRemoteChange`, `handleLoad`, `handleImport`, imported issue detection via `Source: https://github.com/.../issues/...`, and current API calls).

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/components/GitHubImportModal.tsx` — current modal structure, state management, and import flow
- `packages/dashboard/app/styles.css` — base modal/form styles and `/* === GitHub Import Modal === */` section
- `packages/dashboard/app/components/__tests__/GitHubImportModal.test.tsx` — behavioral coverage to preserve
- `packages/dashboard/app/components/__tests__/App.test.tsx` — modal open/close smoke tests
- `README.md` — “Dashboard Import” section documenting the current modal workflow

## File Scope

- `packages/dashboard/app/components/GitHubImportModal.tsx`
- `packages/dashboard/app/styles.css`
- `packages/dashboard/app/components/__tests__/GitHubImportModal.test.tsx`
- `packages/dashboard/app/components/__tests__/App.test.tsx` (only if selector text changes require updates)
- `README.md`

## Steps

### Step 0: Preflight

- [ ] Required files and paths exist
- [ ] Dependencies satisfied

### Step 1: Redesign modal layout and visual hierarchy

- [ ] Refactor `GitHubImportModal.tsx` into clearly separated sections (repository source, filters/actions, results list, preview) with semantic headings/helper text where appropriate
- [ ] Keep all current interaction logic intact: remote auto-selection for single remote, dropdown for multiple remotes, disabled Load/Import button rules, and imported issue locking
- [ ] Improve presentation for loading/empty/error states so each is visually distinct and easy to scan
- [ ] Update `styles.css` GitHub import styles for better spacing rhythm, section separation, issue-row affordances, and responsive behavior on narrow widths using existing theme tokens (`var(--*)`)
- [ ] Run targeted tests for changed files

**Artifacts:**
- `packages/dashboard/app/components/GitHubImportModal.tsx` (modified)
- `packages/dashboard/app/styles.css` (modified)

### Step 2: Update and extend UI tests for the new modal contract

- [ ] Update existing `GitHubImportModal.test.tsx` assertions to match intentional UI structure/copy updates while preserving behavior checks (remote states, fetch/import flow, imported badges, error rendering)
- [ ] Add tests for newly introduced visual/semantic structure (at least two assertions tied to new sections or state containers)
- [ ] Keep `App.test.tsx` modal open/close tests passing; adjust only if updated modal text requires selector updates
- [ ] Run targeted tests for changed files

**Artifacts:**
- `packages/dashboard/app/components/__tests__/GitHubImportModal.test.tsx` (modified)
- `packages/dashboard/app/components/__tests__/App.test.tsx` (modified, if needed)

### Step 3: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run targeted dashboard tests first: `pnpm --filter @kb/dashboard test -- GitHubImportModal.test.tsx App.test.tsx`
- [ ] Run full test suite: `pnpm test`
- [ ] Fix all failures
- [ ] Build passes: `pnpm build`

### Step 4: Documentation & Delivery

- [ ] Update relevant documentation
- [ ] Out-of-scope findings created as new tasks via `task_create` tool

## Documentation Requirements

**Must Update:**
- `README.md` — update “Dashboard Import” bullets to match the polished modal flow and terminology (remote detection/selection, optional labels, issue selection, imported indicators)

**Check If Affected:**
- `packages/dashboard/README.md` — update only if the dashboard-specific modal behavior description is now outdated

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Documentation updated

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-094): complete Step N — description`
- **Bug fixes:** `fix(KB-094): description`
- **Tests:** `test(KB-094): description`

## Do NOT

- Expand task scope into backend GitHub route changes or rate-limit/authentication logic
- Skip tests
- Modify files outside the File Scope without good reason
- Commit without the task ID prefix
- Remove existing safeguards (already-imported detection, disabled controls during loading/import, no-remotes guard)
- Introduce hardcoded colors/styles that bypass dashboard theme tokens
