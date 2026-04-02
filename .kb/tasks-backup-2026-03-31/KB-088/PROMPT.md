# Task: KB-088 - Fix "failed" status showing on dashboard for non-failed tasks

**Created:** 2026-03-30
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** Simple fix with clear blast radius - modifying the `moveTask` function in the store to clear `status` and `error` fields when moving from "in-progress" to reset columns ("todo" or "triage"). Pattern is already established in the codebase for "done" column.
**Score:** 2/8 — Blast radius: 0, Pattern novelty: 0, Security: 1, Reversibility: 1

## Mission

Fix a bug where tasks that previously failed during execution continue to show "failed" status on dashboard cards even after being moved to "todo" or "triage" columns for retry. The root cause is that `moveTask` clears the `status` field only when moving to "done", but not when moving from "in-progress" back to "todo" or "triage" for rework.

When a task fails:
1. Executor sets `status: "failed"` and `error: "message"` on the task
2. Task stays in "in-progress" column
3. User moves task to "todo" (via drag-drop) to retry
4. `moveTask` does NOT clear `status` or `error` fields
5. Dashboard continues showing red "failed" badge even though task is ready for re-execution

The retry endpoint (`POST /tasks/:id/retry`) already handles this correctly by explicitly clearing status/error before moving. The fix extends this behavior to manual moves from "in-progress" to reset columns.

## Dependencies

- **None**

## Context to Read First

- `packages/core/src/store.ts` — The `moveTask` function (lines 385-418) that handles column transitions and already clears transient fields when moving to "done"
- `packages/dashboard/app/components/TaskCard.tsx` — Shows how `isFailed = task.status === "failed"` is used to display failed badge styling
- `packages/dashboard/src/routes.ts` — The retry endpoint (around line 252) that demonstrates the correct pattern for clearing status/error

## File Scope

- `packages/core/src/store.ts` — Modify `moveTask` function to clear status/error when moving from "in-progress" to "todo" or "triage"
- `packages/core/src/store.test.ts` — Add tests for the new behavior

## Steps

### Step 1: Fix moveTask to clear status/error on in-progress exit

- [ ] Modify `moveTask` in `packages/core/src/store.ts` to clear `status` and `error` fields when moving FROM "in-progress" TO "todo" or "triage"
- [ ] Follow the existing pattern used for "done" column (lines 403-408)
- [ ] Also clear `worktree` and `blockedBy` when moving from in-progress to these reset columns (consistent with moving to done)
- [ ] Run existing store tests to ensure no regressions

**Artifacts:**
- `packages/core/src/store.ts` (modified)

### Step 2: Add test coverage for the fix

- [ ] Add test case: moving from "in-progress" to "todo" clears `status` and `error` fields
- [ ] Add test case: moving from "in-progress" to "triage" clears `status` and `error` fields
- [ ] Add test case: moving from "in-progress" to "done" still works (already covered but verify)
- [ ] Add test case: moving from "todo" to "in-progress" does NOT clear status (should preserve any existing status)
- [ ] Run new and existing tests

**Artifacts:**
- `packages/core/src/store.test.ts` (modified)

### Step 3: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full test suite: `pnpm test`
- [ ] Build all packages: `pnpm build`
- [ ] Verify no TypeScript errors

### Step 4: Documentation & Delivery

- [ ] Create changeset file for the fix (patch bump to `@dustinbyrne/kb` as this affects published package behavior)
- [ ] Verify no out-of-scope findings

## Documentation Requirements

**Must Update:**
- None — this is a bug fix with expected behavior

**Check If Affected:**
- `AGENTS.md` — Check if task state management is documented and update if the "failed" status behavior is described

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Changeset file created
- [ ] Moving a failed task from "in-progress" to "todo" or "triage" clears the failed status badge on dashboard

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-088): complete Step N — description`
- **Bug fixes:** `fix(KB-088): description`
- **Tests:** `test(KB-088): description`

## Do NOT

- Modify dashboard UI code — the fix belongs in the store layer
- Change how the retry endpoint works — it's already correct
- Clear status when moving between non-in-progress columns (e.g., "triage" → "todo") — preserve existing behavior
- Modify the Task type definition — no type changes needed
- Add migration logic for existing tasks — only fix the behavior going forward
