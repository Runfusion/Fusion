# Task: KB-312 - Fix tasks marked done but not moving columns

**Created:** 2026-03-31
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** Straightforward bug fix with localized changes to executor workflow step handling. The fix involves properly persisting workflow step results and ensuring tasks move to the correct column when workflow steps complete or fail.
**Score:** 2/8 — Blast radius: 1, Pattern novelty: 0, Security: 1, Reversibility: 0

## Mission

Fix a bug where tasks with enabled workflow steps are not properly moving columns when workflow steps fail. Currently, when a workflow step fails after the agent calls `task_done()`, the task gets `status: "failed"` but remains stuck in the "in-progress" column instead of moving to "in-review" where the user can see the failure and take action. Additionally, workflow step results are never persisted to the task, making it impossible for the dashboard to display workflow step status.

The fix must:
1. Persist workflow step results to the task's `workflowStepResults` field
2. Move tasks to "in-review" column even when workflow steps fail (so users can see and retry)
3. Clear workflow step results when a task is retried (moved back to "todo" or "in-progress")

## Dependencies

- **None**

## Context to Read First

1. `/Users/eclipxe/Projects/kb/packages/engine/src/executor.ts` — Workflow step execution logic (lines 1014-1200)
2. `/Users/eclipxe/Projects/kb/packages/core/src/store.ts` — Task update and move operations
3. `/Users/eclipxe/Projects/kb/packages/core/src/types.ts` — `WorkflowStepResult` type definition
4. `/Users/eclipxe/Projects/kb/packages/dashboard/src/routes.ts` — Workflow results API endpoint (line 1525-1535)

## File Scope

- `packages/engine/src/executor.ts` — Modify workflow step execution and persistence
- `packages/core/src/store.ts` — Add `workflowStepResults` to `updateTask` parameters
- `packages/core/src/types.ts` — Verify `WorkflowStepResult` type (no changes expected)

## Steps

### Step 1: Add workflowStepResults to updateTask

- [ ] Add `workflowStepResults` parameter to `updateTask` in `packages/core/src/store.ts`
- [ ] Handle both setting and clearing (null) of workflow step results
- [ ] Update the task's `workflowStepResults` field when provided
- [ ] Run targeted tests for changed files: `pnpm test -- packages/core/src/store.test.ts`

**Artifacts:**
- `packages/core/src/store.ts` (modified)

### Step 2: Persist workflow step results in executor

- [ ] Modify `runWorkflowSteps` in `packages/engine/src/executor.ts` to collect results
- [ ] After each workflow step, persist results to task via `updateTask`
- [ ] Include step name, status, output, and timestamps in the result
- [ ] On workflow step failure, persist the failed result before returning false
- [ ] Run targeted tests for changed files: `pnpm test -- packages/engine/src/executor.test.ts`

**Artifacts:**
- `packages/engine/src/executor.ts` (modified)

### Step 3: Fix column movement on workflow step failure

- [ ] In executor.ts, when workflow steps fail, move task to "in-review" instead of just setting status to "failed"
- [ ] Remove the early return that prevents column movement on workflow failure
- [ ] Update error message to indicate workflow step failure in in-review column
- [ ] Run targeted tests for changed files: `pnpm test -- packages/engine/src/executor.test.ts`

**Artifacts:**
- `packages/engine/src/executor.ts` (modified)

### Step 4: Clear workflow results on task retry

- [ ] In `moveTask` in store.ts, when moving from "in-review" back to "todo" or "in-progress", clear `workflowStepResults`
- [ ] This ensures fresh workflow step runs on retry
- [ ] Run targeted tests for changed files: `pnpm test -- packages/core/src/store.test.ts`

**Artifacts:**
- `packages/core/src/store.ts` (modified)

### Step 5: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full test suite: `pnpm test`
- [ ] Fix all failures
- [ ] Build passes: `pnpm build`

### Step 6: Documentation & Delivery

- [ ] Add changeset for the bug fix (patch level): `.changeset/fix-workflow-step-column-movement.md`
- [ ] Out-of-scope findings created as new tasks via `task_create` tool

## Documentation Requirements

**Must Update:**
- No documentation updates required (internal bug fix)

**Check If Affected:**
- `AGENTS.md` — No changes needed

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] When workflow steps pass, task moves to "in-review" with results persisted
- [ ] When workflow steps fail, task still moves to "in-review" with failed results visible
- [ ] Workflow step results are cleared when task is retried

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-312): complete Step N — description`
- **Bug fixes:** `fix(KB-312): description`
- **Tests:** `test(KB-312): description`

## Do NOT

- Expand task scope beyond workflow step column movement fix
- Skip tests
- Modify files outside the File Scope without good reason
- Commit without the task ID prefix
- Change the workflow step execution logic beyond persistence and column movement
