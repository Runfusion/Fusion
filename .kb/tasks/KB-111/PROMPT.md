# Task: KB-111 - Don't put cards in a failed state for invalid transition

**Created:** 2026-03-30
**Size:** S

## Review Level: 2 (Plan and Code)

**Assessment:** This is a targeted fix to error handling in the executor. The change is localized to the catch block but affects task state management, requiring careful testing of edge cases.
**Score:** 4/8 — Blast radius: 1, Pattern novelty: 1, Security: 1, Reversibility: 1

## Mission

Fix the executor to handle "Invalid transition" errors gracefully instead of marking tasks as failed. When a task is moved by the user (or another process) while the executor is running, the executor's attempt to move the task to the next column will fail with an "Invalid transition" error. Currently this incorrectly marks the task as "failed" — it should simply log the situation and exit gracefully since the task is already in the desired state.

## Dependencies

- **None**

## Context to Read First

- `packages/core/src/store.ts` — The `moveTask()` method and `VALID_TRANSITIONS` constant that defines allowed transitions
- `packages/engine/src/executor.ts` — The `execute()` method's catch block where errors are handled (around line 510-530)
- `packages/engine/src/executor.test.ts` — Existing executor tests to understand test patterns

## File Scope

- `packages/engine/src/executor.ts` — Modify catch block to handle "Invalid transition" errors
- `packages/engine/src/executor.test.ts` — Add tests for invalid transition handling

## Steps

### Step 1: Analyze Current Error Handling

- [ ] Read the catch block in executor.ts `execute()` method (lines ~510-530)
- [ ] Understand the three current error paths:
  - `depAborted` — dependency added mid-execution
  - `pausedAborted` — task was paused mid-execution  
  - Default — actual execution errors (including invalid transitions)
- [ ] Identify where `status: "failed"` is set and how `Invalid transition` errors reach this path

### Step 2: Implement Invalid Transition Handling

- [ ] Add a fourth error handling branch for "Invalid transition" errors
- [ ] Detect invalid transition by checking `err.message.includes("Invalid transition")`
- [ ] In this case:
  - Log at info level: "Task already moved to '{column}' — skipping transition to '{targetColumn}'"
  - Do NOT set `status: "failed"`
  - Do NOT set `error` field
  - Do call `onComplete?.(task)` if transitioning to in-review (task finished successfully, just already moved)
- [ ] Ensure the `executing.delete(task.id)` still runs in finally block

**Artifacts:**
- `packages/engine/src/executor.ts` (modified)

### Step 3: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Add test: "does not mark task as failed when invalid transition error occurs on completion"
  - Setup: Task in in-progress, agent finishes with task_done=true
  - Mock: `moveTask` to throw "Invalid transition: 'done' → 'in-review'"
  - Assert: `updateTask` not called with `status: "failed"`, `logEntry` called with informative message
- [ ] Add test: "calls onComplete when invalid transition occurs after successful execution"
  - Setup: Task completes but moveTask throws invalid transition
  - Assert: `onComplete` callback is still invoked
- [ ] Run `pnpm test` in engine package — all tests must pass
- [ ] Run `pnpm test` in core package — all tests must pass

**Artifacts:**
- `packages/engine/src/executor.test.ts` (modified)

### Step 4: Documentation & Delivery

- [ ] Add changeset for patch release: `.changeset/fix-invalid-transition-failed.md`
- [ ] Verify no documentation updates needed (internal behavior change, no user-facing docs)
- [ ] Create follow-up task if triage.ts or merger.ts have similar issues (check for patterns where moveTask errors mark tasks as failed)

**Artifacts:**
- `.changeset/fix-invalid-transition-failed.md` (new)

## Documentation Requirements

**Must Update:**
- None — internal error handling fix, no user-facing behavior change

**Check If Affected:**
- `AGENTS.md` — check if error handling patterns are documented (they're not, no change needed)

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Invalid transition errors no longer mark tasks as failed
- [ ] Changeset created

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-111): complete Step N — description`
- **Bug fixes:** `fix(KB-111): description`
- **Tests:** `test(KB-111): description`

## Do NOT

- Expand scope to other error types (keep fix focused on invalid transitions)
- Skip the `finally` block cleanup (must always remove from `executing` set)
- Change the store's moveTask behavior (keep validation, just handle error gracefully)
- Modify dashboard or API routes (executor-only fix)
