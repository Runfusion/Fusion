# Task: KB-105 - Auto-generate task title from description when empty

**Created:** 2026-03-30
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** This is a focused change affecting task creation logic. Low blast radius — only touches the store's createTask method. Pattern is straightforward (extract first N words from description). No security concerns. Fully reversible — tasks created before this change are unaffected.

**Score:** 2/8 — Blast radius: 0, Pattern novelty: 0, Security: 1, Reversibility: 1

## Mission

When tasks are created without an explicit title, auto-generate a title from the task description. This ensures all tasks have meaningful titles for display in the dashboard, CLI output, and when using the `worktreeNaming: "task-title"` setting.

Currently, tasks can be created with `title: undefined`, which results in:
- Dashboard cards showing only the task ID
- CLI `kb task list` showing incomplete information
- Worktree naming falling back to raw description at the point of worktree creation

The fix: in `TaskStore.createTask()`, when `input.title` is not provided or empty, generate a concise title from the first 8-10 words of the description.

## Dependencies

- **None**

## Context to Read First

- `packages/core/src/store.ts` — TaskStore class, especially `createTask()` method (lines 180-220)
- `packages/core/src/types.ts` — Task and TaskCreateInput interfaces
- `packages/core/src/store.test.ts` — Existing tests for task creation
- `packages/engine/src/executor.ts` — Worktree naming logic (lines 320-340) — understand current fallback behavior

## File Scope

- `packages/core/src/store.ts` — Modify `createTask()` to generate title from description
- `packages/core/src/store.test.ts` — Add tests for title generation

## Steps

### Step 1: Implement Title Generation in createTask

- [ ] Add helper function to extract first N words from a string (max ~50 chars)
- [ ] Modify `createTask()` to generate title when `input.title` is empty/falsy
- [ ] Use first 8-10 words of description, capped at ~50 characters
- [ ] Handle edge cases: very short descriptions, descriptions with only special chars
- [ ] Ensure generated title is stored in task.json (not just for worktree naming)

**Artifacts:**
- `packages/core/src/store.ts` (modified)

### Step 2: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Add test: "generates title from description when title is not provided"
- [ ] Add test: "generates title from description when title is empty string"
- [ ] Add test: "uses provided title when available (does not override)"
- [ ] Add test: "handles very long descriptions gracefully (truncates to ~50 chars)"
- [ ] Add test: "handles short descriptions (less than 3 words)"
- [ ] Run full test suite: `pnpm test`
- [ ] Run build: `pnpm build`
- [ ] Fix all failures

**Artifacts:**
- `packages/core/src/store.test.ts` (modified)

### Step 3: Documentation & Delivery

- [ ] Update AGENTS.md section on worktree naming to clarify that tasks without titles auto-generate from description
- [ ] Create changeset file for the patch release
- [ ] Verify no duplicate tasks exist for this work

**Artifacts:**
- `.changeset/auto-generate-task-title.md` (new)
- `AGENTS.md` (modified if needed)

## Documentation Requirements

**Must Update:**
- `.changeset/auto-generate-task-title.md` — Describe the auto-title generation feature

**Check If Affected:**
- `AGENTS.md` — Check if worktree naming docs need clarification about title generation

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Tasks created without titles now have auto-generated titles in task.json
- [ ] Dashboard displays meaningful titles for all tasks
- [ ] Worktree naming "task-title" mode uses the generated title (since it's now persisted)

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-105): complete Step N — description`
- **Bug fixes:** `fix(KB-105): description`
- **Tests:** `test(KB-105): description`

## Do NOT

- Modify the executor worktree naming fallback logic (it's defensive and should remain)
- Generate titles for existing tasks (only affects new task creation)
- Use AI/LLM to generate titles — keep it simple (first N words)
- Change the worktree naming behavior for "random" or "task-id" modes
- Break backward compatibility for tasks created before this change
