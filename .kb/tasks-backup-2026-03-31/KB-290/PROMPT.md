# Task: KB-290 - Fix task_create to explicitly set column to triage

**Created:** 2026-03-31
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** This is a straightforward bug fix with a single code change and corresponding test. The blast radius is limited to the executor's task_create tool. Pattern is standard (explicit parameter passing). Fully reversible by reverting the change.
**Score:** 2/8 — Blast radius: 0, Pattern novelty: 0, Security: 1, Reversibility: 1

## Mission

Fix the executor agent's `task_create` tool to explicitly set `column: "triage"` when creating tasks. While the store currently defaults to "triage", the explicit parameter ensures tasks created during execution always land in triage for proper specification by the AI, matching the behavior of the triage agent's task_create tool.

## Dependencies

- **None**

## Context to Read First

- `packages/engine/src/executor.ts` — Contains the `createTaskCreateTool` method that needs fixing
- `packages/engine/src/triage.ts` — Reference implementation (line ~791 shows explicit `column: "triage"`)
- `packages/core/src/store.ts` — The `createTask` method defaults column to "triage" but we want explicit passing

## File Scope

- `packages/engine/src/executor.ts` (modify `createTaskCreateTool` method)
- `packages/engine/src/executor.test.ts` (add test for column assignment)

## Steps

### Step 1: Fix Executor's task_create Tool

- [ ] Modify `createTaskCreateTool()` in `packages/engine/src/executor.ts` to explicitly pass `column: "triage"` when calling `store.createTask()`
- [ ] Verify the change matches the pattern used in triage.ts

**Current code (around line 675):**
```typescript
const task = await store.createTask({
  description: params.description,
  dependencies: params.dependencies,
});
```

**Should become:**
```typescript
const task = await store.createTask({
  description: params.description,
  dependencies: params.dependencies,
  column: "triage",
});
```

**Artifacts:**
- `packages/engine/src/executor.ts` (modified)

### Step 2: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm test -- --run packages/engine` to verify existing tests pass
- [ ] Verify no regressions in task creation flow

**Artifacts:**
- Test results showing all executor tests passing

### Step 3: Documentation & Delivery

- [ ] Create changeset file for the fix (patch level - bug fix)
- [ ] No documentation updates needed (behavior already described in tool description)

**Artifacts:**
- `.changeset/fix-task-create-column.md` (new)

## Documentation Requirements

**Must Update:**
- None (tool description already says "The task goes into triage")

**Check If Affected:**
- `AGENTS.md` — No changes needed, behavior matches documented expectation

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Executor's `task_create` tool explicitly passes `column: "triage"`
- [ ] Changeset created

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-290): complete Step N — description`
- **Bug fixes:** `fix(KB-290): description`
- **Tests:** `test(KB-290): description`

## Do NOT

- Expand task scope beyond the executor's task_create tool
- Modify the store's default behavior (defaulting to triage is correct)
- Skip running tests
- Modify files outside the File Scope without good reason
- Commit without the task ID prefix
