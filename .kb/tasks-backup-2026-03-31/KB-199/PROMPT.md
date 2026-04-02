# Task: KB-199 - Add CLI command `kb task retry <id>` to retry failed tasks

**Created:** 2026-03-30
**Size:** S

## Review Level: 2 (Plan and Code)

**Assessment:** Small, well-defined CLI feature that follows existing patterns in the codebase. The retry logic is straightforward using existing store methods, but requires careful handling of edge cases (task not found, not failed).
**Score:** 4/8 — Blast radius: 1, Pattern novelty: 1, Security: 1, Reversibility: 1

## Mission

Add a `kb task retry <id>` command to the CLI that allows users to retry failed tasks directly from the command line. This addresses the gap where failed tasks currently require the dashboard web UI to recover, blocking automated workflows and frustrating CLI-first users.

The command validates the task is in failed state, clears the error status, moves it back to the todo column, and logs the action for audit purposes.

## Dependencies

- **Task:** KB-182 — Dashboard vs CLI gap analysis (completed — this is a subtask)

## Context to Read First

These files establish the patterns to follow:

1. **`packages/cli/src/commands/task.ts`** — Existing task command implementations (e.g., `runTaskPause`, `runTaskUnpause`, `runTaskArchive`)
2. **`packages/cli/src/bin.ts`** — CLI routing and help text (see existing command switch cases)
3. **`packages/cli/src/extension.ts`** — Pi extension tool patterns (e.g., `kb_task_pause`, `kb_task_archive`)
4. **`packages/core/src/store.ts`** — Store methods: `getTask()`, `updateTask()`, `moveTask()`, `logEntry()`

## File Scope

- `packages/cli/src/commands/task.ts` — Add `runTaskRetry()` function
- `packages/cli/src/bin.ts` — Add command routing for `task retry`
- `packages/cli/src/extension.ts` — Add `kb_task_retry` tool
- `packages/cli/src/commands/task.test.ts` — Add tests for retry command

## Steps

### Step 1: Implement `runTaskRetry()` in task.ts

- [ ] Add `runTaskRetry(id: string)` function to `packages/cli/src/commands/task.ts`
- [ ] Get store instance and fetch task via `store.getTask(id)`
- [ ] Validate task exists — if not, throw clear error "Task {id} not found"
- [ ] Validate `task.status === 'failed'` — if not, throw error "Task {id} is not failed (status: {status})"
- [ ] Call `store.updateTask(id, { status: null, error: null })` to clear failure state
- [ ] Call `store.moveTask(id, 'todo')` to move task back to todo column
- [ ] Call `store.logEntry(id, "Retry requested from CLI", "Task reset to todo for retry")`
- [ ] Print success message: "✓ Retried {id} → todo (failure state cleared)"
- [ ] Add export for `runTaskRetry`

**Artifacts:**
- `packages/cli/src/commands/task.ts` (modified)

### Step 2: Wire up CLI command in bin.ts

- [ ] Import `runTaskRetry` from `./commands/task.js`
- [ ] Add case for `retry` in the `task` subcommand switch statement
- [ ] Parse task ID from `args[2]`
- [ ] Validate ID is provided — if not, print "Usage: kb task retry <id>" and exit 1
- [ ] Call `await runTaskRetry(id)`
- [ ] Add `"kb task retry <id>  Retry a failed task (clears error, moves to todo)"` to HELP text

**Artifacts:**
- `packages/cli/src/bin.ts` (modified)

### Step 3: Add Pi extension tool

- [ ] Register `kb_task_retry` tool in `packages/cli/src/extension.ts`
- [ ] Include `label`, `description`, `promptSnippet`, `promptGuidelines`
- [ ] Parameters: `{ id: Type.String({ description: "Task ID to retry (e.g. KB-001). Must be in 'failed' state." }) }`
- [ ] Execute: call `runTaskRetry`, return success message with task state
- [ ] Handle errors gracefully and return descriptive error messages

**Artifacts:**
- `packages/cli/src/extension.ts` (modified)

### Step 4: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Add unit tests in `packages/cli/src/commands/task.test.ts`:
  - Test successful retry: mocks task with `status: 'failed'`, verifies `updateTask`, `moveTask`, and `logEntry` called
  - Test task not found: verifies error thrown with "Task {id} not found"
  - Test task not failed: verifies error thrown with status in message
  - Test success output format matches expected pattern
- [ ] Run `pnpm test` — all tests must pass
- [ ] Build passes: `pnpm build`
- [ ] Manual verification:
  - Create a task, simulate failure (set status='failed'), run `kb task retry <id>`
  - Verify task moved to todo, status cleared, log entry added

**Artifacts:**
- `packages/cli/src/commands/task.test.ts` (modified)

### Step 5: Documentation & Delivery

- [ ] No README updates needed (CLI help text is self-documenting)
- [ ] Verify HELP text is accurate
- [ ] Create changeset file per project guidelines:
    ```bash
    cat > .changeset/add-retry-cli-command.md << 'EOF'
    ---
    "@dustinbyrne/kb": minor
    ---

    Add `kb task retry <id>` CLI command to retry failed tasks from command line
    EOF
    ```
- [ ] Include changeset in final commit

**Artifacts:**
- `.changeset/add-retry-cli-command.md` (new)

## Documentation Requirements

**Must Update:**
- `packages/cli/src/bin.ts` — Add to HELP text

**Check If Affected:**
- None (CLI is self-documenting via help)

## Completion Criteria

- [ ] All steps complete
- [ ] `kb task retry <id>` works end-to-end
- [ ] Pi extension tool `kb_task_retry` works in chat
- [ ] All tests passing
- [ ] Build passes
- [ ] Changeset included

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-199): complete Step N — description`
- **Bug fixes:** `fix(KB-199): description`
- **Tests:** `test(KB-199): description`

**Suggested commits:**
1. `feat(KB-199): implement runTaskRetry() function`
2. `feat(KB-199): wire up CLI command and help text`
3. `feat(KB-199): add kb_task_retry extension tool`
4. `test(KB-199): add retry command tests`
5. `feat(KB-199): add changeset for retry CLI command`

## Do NOT

- Expand scope beyond retry functionality
- Skip tests
- Modify files outside the File Scope without good reason
- Commit without the task ID prefix
- Change dashboard API or web UI (this is CLI-only)
- Add retry logic for non-failed states (must strictly check `status === 'failed'`)
