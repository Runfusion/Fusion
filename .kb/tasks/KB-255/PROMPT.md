# Task: KB-255 - Task descriptions are being truncated stop doing that

**Created:** 2026-03-31
**Size:** S

## Review Level: 0 (None)

**Assessment:** Simple UI fix to remove character truncation. Low blast radius, no security concerns, easily reversible.
**Score:** 0/8 — Blast radius: 0, Pattern novelty: 0, Security: 0, Reversibility: 0

## Mission

Remove the 60-character truncation limit on task descriptions displayed in the dashboard. When a task has no title, the full description should be shown instead of being cut off with an ellipsis. This affects both the kanban card view (TaskCard) and the list view (ListView).

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/components/TaskCard.tsx` — Lines 425-430 where description truncation occurs in card title display
- `packages/dashboard/app/components/ListView.tsx` — Lines 393-398 where description truncation occurs in list title column
- `packages/dashboard/app/components/__tests__/TaskCard.test.tsx` — Existing tests for TaskCard
- `packages/dashboard/app/components/__tests__/ListView.test.tsx` — Existing tests for ListView

## File Scope

- `packages/dashboard/app/components/TaskCard.tsx` (modify)
- `packages/dashboard/app/components/ListView.tsx` (modify)
- `packages/dashboard/app/components/__tests__/TaskCard.test.tsx` (add test)
- `packages/dashboard/app/components/__tests__/ListView.test.tsx` (add test)

## Steps

### Step 1: Remove Description Truncation in TaskCard

- [ ] Remove the `.slice(0, 60)` and ellipsis logic from the card-title display in TaskCard.tsx
- [ ] The title display should show: `task.title || task.description || task.id` without length limits
- [ ] Verify the change renders full descriptions without truncation

**Artifacts:**
- `packages/dashboard/app/components/TaskCard.tsx` (modified)

### Step 2: Remove Description Truncation in ListView

- [ ] Remove the `.slice(0, 60)` and ellipsis logic from the title column in ListView.tsx
- [ ] The title cell should show: `task.title || task.description` without length limits
- [ ] Verify the change renders full descriptions in list view without truncation

**Artifacts:**
- `packages/dashboard/app/components/ListView.tsx` (modified)

### Step 3: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Add/update tests in TaskCard.test.tsx to verify full description is displayed when no title exists
- [ ] Add/update tests in ListView.test.tsx to verify full description is displayed when no title exists
- [ ] Run `pnpm test` and ensure all tests pass
- [ ] Run `pnpm build` and ensure no TypeScript errors

**Artifacts:**
- `packages/dashboard/app/components/__tests__/TaskCard.test.tsx` (modified)
- `packages/dashboard/app/components/__tests__/ListView.test.tsx` (modified)

### Step 4: Documentation & Delivery

- [ ] Update any relevant comments in the code that reference the 60-character limit
- [ ] Out-of-scope findings created as new tasks via `task_create` tool

## Documentation Requirements

**Must Update:**
- None — this is a bug fix with no user-facing documentation changes needed

**Check If Affected:**
- None

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] No truncation logic remains in TaskCard or ListView title/description display

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-255): complete Step N — description`
- **Bug fixes:** `fix(KB-255): description`
- **Tests:** `test(KB-255): description`

## Do NOT

- Add new truncation limits (the goal is to stop truncating entirely)
- Modify the description field storage or API
- Change how titles are displayed when they exist
- Skip tests
- Create a changeset (this is a dashboard-only change, not affecting the published `@dustinbyrne/kb` package)
