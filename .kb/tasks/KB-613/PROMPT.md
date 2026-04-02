# Task: KB-613 - Fix Task Status Updates Not Showing in Dashboard Until Refresh

**Created:** 2026-03-31
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** This is a focused frontend fix in the useTasks hook's event handler. The blast radius is limited to the SSE update handling logic. Pattern is a simple timestamp comparison fix.
**Score:** 2/8 — Blast radius: 0, Pattern novelty: 1, Security: 0, Reversibility: 1

## Mission

Fix a race condition bug in the dashboard's task update handler where status changes from the executor (like "planning" → "executing" → "finalizing") aren't reflected in real-time. Currently, these updates require a page refresh to appear because the timestamp comparison logic incorrectly rejects valid status updates.

The issue: The `handleUpdated` function in `useTasks.ts` uses `columnMovedAt` timestamps to prevent race conditions. However, status updates don't change `columnMovedAt` - they only update `updatedAt`. When a task has recently moved columns (newer `columnMovedAt`), incoming status updates (with older `columnMovedAt` but newer `updatedAt`) are incorrectly rejected as stale.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/hooks/useTasks.ts` — SSE event handlers, particularly `handleUpdated` and `compareTimestamps`
- `packages/dashboard/app/hooks/__tests__/useTasks.test.ts` — existing test patterns for SSE updates

## File Scope

- `packages/dashboard/app/hooks/useTasks.ts` — Fix the timestamp comparison logic in `handleUpdated`
- `packages/dashboard/app/hooks/__tests__/useTasks.test.ts` — Add tests for status update scenarios

## Steps

### Step 1: Fix Timestamp Comparison Logic

- [ ] Modify `handleUpdated` in `useTasks.ts` to use `updatedAt` for general freshness comparison, not just `columnMovedAt`
- [ ] Keep the `columnMovedAt` logic only for column-specific conflict resolution
- [ ] The logic should be:
  1. First compare `updatedAt` to determine which task is newer overall
  2. If `updatedAt` is equal or incoming is newer, accept the update
  3. Only apply column preservation logic when `columnMovedAt` differs AND current column is newer
  4. Status and other non-column fields should always update when `updatedAt` is newer

**Code change location:** Around line 55-80 in `handleUpdated` function.

**Artifacts:**
- `packages/dashboard/app/hooks/useTasks.ts` (modified)

### Step 2: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Add test case: "status updates are applied when updatedAt is newer even if columnMovedAt is older"
- [ ] Add test case: "rapid status updates after column move are not rejected"
- [ ] Run `pnpm test` to verify all tests pass
- [ ] Run `pnpm build` to verify build passes

**Test pattern to follow:** Use the existing race condition tests in `useTasks.test.ts` as a template. Create mock tasks with varying `updatedAt` and `columnMovedAt` combinations.

**Artifacts:**
- `packages/dashboard/app/hooks/__tests__/useTasks.test.ts` (modified)

### Step 3: Documentation & Delivery

- [ ] Update `AGENTS.md` if there are any behavior notes about timestamp handling (check if there's a section on SSE updates)
- [ ] Create changeset for the fix
- [ ] Verify fix works by checking that status badge updates appear immediately in the dashboard

**Artifacts:**
- `.changeset/fix-status-updates.md` (new)

## Documentation Requirements

**Must Update:**
- None required — this is a bug fix that restores expected behavior

**Check If Affected:**
- `AGENTS.md` — Check if there's a section on real-time updates that needs clarification

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Status updates from executor appear immediately without refresh

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-613): complete Step N — description`
- **Bug fixes:** `fix(KB-613): description`
- **Tests:** `test(KB-613): description`

## Do NOT

- Expand task scope beyond the timestamp comparison fix
- Skip tests — this is a race condition fix that requires test coverage
- Modify SSE server-side code — the issue is in the frontend handler
- Change the Task type or store behavior — focus only on the hook's comparison logic
