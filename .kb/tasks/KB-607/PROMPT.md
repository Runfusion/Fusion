# Task: KB-607 - Send tasks missing directory or prompt back to triage

**Created:** 2026-03-31
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** Simple validation logic with clear boundaries. Adds a check in the scheduler to validate task filesystem state before scheduling.
**Score:** 3/8 — Blast radius: 1, Pattern novelty: 0, Security: 1, Reversibility: 1

## Mission

Add validation to detect tasks that exist in the database but are missing their task directory or PROMPT.md file on disk. When such tasks are found in the "todo" column, automatically move them back to "triage" with a log entry so the AI can regenerate the specification. This handles edge cases where filesystem state and database state become inconsistent (e.g., due to manual deletion, partial archive cleanup, or filesystem errors).

## Dependencies

- **None**

## Context to Read First

- `packages/core/src/store.ts` — TaskStore class, especially `getTask()` and `taskDir()` methods
- `packages/engine/src/scheduler.ts` — Scheduler class, `schedule()` method where task validation happens
- `packages/core/src/types.ts` — Task type definitions and VALID_TRANSITIONS

## File Scope

- `packages/engine/src/scheduler.ts`
- `packages/engine/src/scheduler.test.ts` — add tests for the new validation

## Steps

### Step 1: Add validation method to Scheduler

- [ ] Add private `validateTaskFilesystem(id: string): Promise<{ valid: boolean; reason?: string }>` method to Scheduler class
- [ ] Check if task directory exists at `.fusion/tasks/{id}/`
- [ ] Check if PROMPT.md file exists and has non-empty content
- [ ] Return `{ valid: true }` if both checks pass
- [ ] Return `{ valid: false, reason: "missing directory" }` or `{ valid: false, reason: "missing or empty PROMPT.md" }` if checks fail

**Artifacts:**
- `packages/engine/src/scheduler.ts` (modified)

### Step 2: Integrate validation into scheduling loop

- [ ] In `schedule()` method, after filtering for `column === "todo"` and before checking dependencies, add filesystem validation
- [ ] For each todo task, call `validateTaskFilesystem(task.id)`
- [ ] If invalid, move task back to "triage" using `store.moveTask(task.id, "triage")`
- [ ] Log the reason: `await store.logEntry(task.id, "Task moved to triage — filesystem validation failed", reason)`
- [ ] Skip scheduling for this task (continue to next)
- [ ] Emit `onBlocked` callback if configured (treat as blocked condition)

**Artifacts:**
- `packages/engine/src/scheduler.ts` (modified)

### Step 3: Testing & Verification

- [ ] Add unit test in `scheduler.test.ts` for missing task directory
- [ ] Add unit test for missing or empty PROMPT.md
- [ ] Add unit test for valid task (directory and PROMPT.md exist) — ensure it proceeds normally
- [ ] Mock `existsSync` and `readFile` to simulate filesystem states
- [ ] Verify tasks are moved to "triage" column when validation fails
- [ ] Verify log entries are written with appropriate reasons
- [ ] Run full test suite: `pnpm test`
- [ ] Fix all failures

**Artifacts:**
- `packages/engine/src/scheduler.test.ts` (modified)

### Step 4: Documentation & Delivery

- [ ] Update `AGENTS.md` if there are any scheduler-related docs (check Scheduler section)
- [ ] Create changeset: `fix-missing-task-validation.md`

## Documentation Requirements

**Must Update:**
- `.changeset/fix-missing-task-validation.md` — describe the fix

**Check If Affected:**
- `AGENTS.md` — search for "scheduler" and update if there's a relevant section

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Documentation updated

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-607): complete Step N — description`
- **Bug fixes:** `fix(KB-607): description`
- **Tests:** `test(KB-607): description`

## Do NOT

- Expand scope to validate other task properties (keep focused on directory + PROMPT.md)
- Skip tests
- Modify the store's core task reading logic — validate in scheduler only
- Add UI changes for this validation (scheduler handles it silently)
- Implement auto-retry logic — moving to triage is sufficient
