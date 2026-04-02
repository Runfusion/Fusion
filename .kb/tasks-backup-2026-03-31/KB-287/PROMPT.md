# Task: KB-287 - Don't allow a task to depend on itself

**Created:** 2026-03-31
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** Simple validation rule addition with clear test requirements. Low blast radius - only affects dependency validation logic.
**Score:** 2/8 — Blast radius: 0, Pattern novelty: 1, Security: 0, Reversibility: 1

## Mission

Add validation to prevent tasks from having themselves as a dependency. This validation should be enforced at the store level (`packages/core/src/store.ts`) so that all entry points (CLI, dashboard API, executor tools) are protected consistently. Currently, the `taskAddDep` tool in the executor has this check, but the core store methods (`createTask` and `updateTask`) do not, allowing self-dependencies to be created via API routes or CLI.

## Dependencies

- **None**

## Context to Read First

1. `packages/core/src/store.ts` — Read the `createTask()` method (around line 370-430) and `updateTask()` method (around line 640-730) to understand how dependencies are currently handled
2. `packages/core/src/store.test.ts` — Review existing store tests to understand the testing patterns used
3. `packages/engine/src/executor.ts` — Review the existing self-dependency validation in the `taskAddDep` tool (around line 700-720) for the error message pattern to maintain consistency

## File Scope

- `packages/core/src/store.ts` — Add validation to `createTask()` and `updateTask()`
- `packages/core/src/store.test.ts` — Add unit tests for the new validation

## Steps

### Step 1: Add Self-Dependency Validation to Store

- [ ] In `packages/core/src/store.ts`, modify `createTask()` to validate that `input.dependencies` does not include the task's own ID (which is generated just before this check)
- [ ] In `packages/core/src/store.ts`, modify `updateTask()` to validate that `updates.dependencies` does not include the task's own ID (passed as the `id` parameter)
- [ ] Both validations should throw a clear error: `Error: Task ${id} cannot depend on itself`
- [ ] Run existing store tests to ensure no regressions: `pnpm test -- packages/core/src/store.test.ts`

**Artifacts:**
- `packages/core/src/store.ts` (modified)

### Step 2: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Add test case in `packages/core/src/store.test.ts`: `createTask` should throw when dependencies include self
- [ ] Add test case: `updateTask` should throw when setting dependencies to include self
- [ ] Add test case: `updateTask` should throw when updating dependencies to add self (when task already has other dependencies)
- [ ] Run full test suite: `pnpm test`
- [ ] Fix all failures
- [ ] Build passes: `pnpm build`

**Artifacts:**
- `packages/core/src/store.test.ts` (modified)

### Step 3: Documentation & Delivery

- [ ] Update relevant documentation if there's a doc about task dependencies or API constraints
- [ ] Out-of-scope findings created as new tasks via `task_create` tool

## Documentation Requirements

**Check If Affected:**
- `AGENTS.md` — Check if there's documentation about task dependencies that should mention this constraint

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Documentation updated (if applicable)

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-287): complete Step 1 — add self-dependency validation to store`
- **Bug fixes:** `fix(KB-287): description`
- **Tests:** `test(KB-287): add tests for self-dependency validation`

## Do NOT

- Expand task scope beyond self-dependency validation (circular dependency detection between different tasks is out of scope)
- Skip tests
- Modify files outside the File Scope without good reason
- Commit without the task ID prefix
- Add validation to other places (like API routes) instead of the store - the store is the single source of truth
