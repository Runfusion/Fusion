# Task: KB-095 - Hide Done Toggle Also Hides Archived in List View

**Created:** 2026-03-30
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** This is a localized dashboard UI behavior fix in one React component with existing test coverage to extend. Risk is low and reversible, but the toggle is user-facing and must behave consistently across filters, grouped sections, and counts.
**Score:** 2/8 — Blast radius: 1, Pattern novelty: 0, Security: 0, Reversibility: 1

## Mission

Update List View so the existing "Hide Done" toggle treats both `done` and `archived` as hidden completed columns. When enabled, completed work should be consistently excluded from the list experience (rows, grouped sections, counts, and stats), giving users a reliable active-work-only view.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/components/ListView.tsx`
- `packages/dashboard/app/components/__tests__/ListView.test.tsx`
- `packages/core/src/types.ts`
- `packages/dashboard/README.md`

## File Scope

- `packages/dashboard/app/components/ListView.tsx`
- `packages/dashboard/app/components/__tests__/ListView.test.tsx`
- `packages/dashboard/README.md`

## Steps

### Step 0: Preflight

- [ ] Required files and paths exist
- [ ] Dependencies satisfied

### Step 1: Make hide-completed behavior include archived (strict hide)

- [ ] Update `ListView.tsx` filtering so `hideDoneTasks` excludes both `done` and `archived` tasks from `groupedTasks`
- [ ] Apply **strict hide semantics**: when the toggle is active, `done` and `archived` task rows are not shown even if those columns are selected via `selectedColumn`
- [ ] Update section rendering and stats/count logic to match strict hide behavior (hidden totals include done + archived)
- [ ] Keep drop-zone counts consistent for completed columns when hidden (Done and Archived show `0 of N` while toggle is active)
- [ ] Add/adjust tests in `ListView.test.tsx` covering: archived hidden with toggle, combined hidden stats text, done+archived section suppression, done+archived drop-zone `0 of N`, and selected completed column behavior under strict hide
- [ ] Run targeted tests for changed files: `pnpm --filter @kb/dashboard test -- app/components/__tests__/ListView.test.tsx`

**Artifacts:**
- `packages/dashboard/app/components/ListView.tsx` (modified)
- `packages/dashboard/app/components/__tests__/ListView.test.tsx` (modified)

### Step 2: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full test suite: `pnpm test`
- [ ] Fix all failures
- [ ] Build passes: `pnpm build`

### Step 3: Documentation & Delivery

- [ ] Update relevant documentation
- [ ] Out-of-scope findings created as new tasks via `task_create` tool

## Documentation Requirements

**Must Update:**
- `packages/dashboard/README.md` — clarify that in List View, the "Hide Done" control hides both Done and Archived tasks

**Check If Affected:**
- `README.md` — update only if dashboard list filtering behavior is described there

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Documentation updated

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-095): complete Step N — description`
- **Bug fixes:** `fix(KB-095): description`
- **Tests:** `test(KB-095): description`

## Do NOT

- Expand scope beyond List View completed-column filtering behavior
- Skip real automated tests (typecheck/build/manual checks are not substitutes)
- Change board view, API routes, or archive/unarchive backend semantics
- Modify files outside File Scope without good reason
- Add a changeset for this dashboard-only change (published package `@dustinbyrne/kb` is not affected)
- Commit without the task ID prefix