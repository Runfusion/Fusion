# Task: KB-274 - For items with dependencies consider archived the same as done

**Created:** 2026-03-31
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** Simple pattern change across 3 files to extend existing dependency satisfaction logic. Low blast radius, well-tested area.
**Score:** 2/8 — Blast radius: 0, Pattern novelty: 0, Security: 0, Reversibility: 2

## Mission

Currently, when checking if a task's dependencies are satisfied, the system only considers "done" and "in-review" columns as completed states. Tasks in the "archived" column should also be treated as completed for dependency purposes, since archived tasks are completed work that has been cleaned up from the filesystem.

Update the dependency satisfaction logic to treat "archived" the same as "done" and "in-review" across the scheduler, executor, and dashboard worktree grouping.

## Dependencies

- **None**

## Context to Read First

- `/Users/eclipxe/Projects/kb/packages/engine/src/scheduler.ts` — Lines 380-383 contain the dependency check in `schedule()` method
- `/Users/eclipxe/Projects/kb/packages/engine/src/executor.ts` — Lines 335-338 contain the dependency check in `execute()` method  
- `/Users/eclipxe/Projects/kb/packages/dashboard/app/utils/worktreeGrouping.ts` — Lines 78-84 contain the dependency check in `groupByWorktree()`
- `/Users/eclipxe/Projects/kb/packages/engine/src/scheduler.test.ts` — Existing tests for scheduler dependency handling (lines 400-450)

## File Scope

- `/Users/eclipxe/Projects/kb/packages/engine/src/scheduler.ts` (modify)
- `/Users/eclipxe/Projects/kb/packages/engine/src/executor.ts` (modify)
- `/Users/eclipxe/Projects/kb/packages/dashboard/app/utils/worktreeGrouping.ts` (modify)
- `/Users/eclipxe/Projects/kb/packages/engine/src/scheduler.test.ts` (modify — add test)

## Steps

### Step 1: Update Scheduler Dependency Check

- [ ] Modify `/Users/eclipxe/Projects/kb/packages/engine/src/scheduler.ts` line 383
- [ ] Change: `return dep && dep.column !== "done" && dep.column !== "in-review";`
- [ ] To: `return dep && dep.column !== "done" && dep.column !== "in-review" && dep.column !== "archived";`
- [ ] Update the comment on line 380 to include archived: "Check all deps are satisfied (done, in-review, or archived)"

**Artifacts:**
- `packages/engine/src/scheduler.ts` (modified)

### Step 2: Update Executor Dependency Check

- [ ] Modify `/Users/eclipxe/Projects/kb/packages/engine/src/executor.ts` line 338
- [ ] Change: `return dep && dep.column !== "done" && dep.column !== "in-review";`
- [ ] To: `return dep && dep.column !== "done" && dep.column !== "in-review" && dep.column !== "archived";`

**Artifacts:**
- `packages/engine/src/executor.ts` (modified)

### Step 3: Update Dashboard Worktree Grouping

- [ ] Modify `/Users/eclipxe/Projects/kb/packages/dashboard/app/utils/worktreeGrouping.ts` line 83
- [ ] Change: `return dep && (dep.column === "done" || dep.column === "in-review");`
- [ ] To: `return dep && (dep.column === "done" || dep.column === "in-review" || dep.column === "archived");`

**Artifacts:**
- `packages/dashboard/app/utils/worktreeGrouping.ts` (modified)

### Step 4: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Add test to `/Users/eclipxe/Projects/kb/packages/engine/src/scheduler.test.ts` in the "Scheduler dependency handling" describe block
- [ ] Test case: "allows task to start when explicit dep is archived" — verify a todo task with a dependency in "archived" column gets scheduled
- [ ] Run `pnpm test` — all tests must pass
- [ ] Run `pnpm build` — build must pass

**Artifacts:**
- `packages/engine/src/scheduler.test.ts` (modified — new test added)

### Step 5: Documentation & Delivery

- [ ] Verify no documentation updates needed (this is a behavioral fix, not a feature change)
- [ ] Out-of-scope findings created as new tasks via `task_create` tool if any

## Completion Criteria

- [ ] All 3 files modified to treat "archived" as satisfied dependency state
- [ ] New test added and passing for archived dependency scenario
- [ ] All existing tests passing
- [ ] Build passes

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-274): complete Step N — description`
- **Bug fixes:** `fix(KB-274): description`
- **Tests:** `test(KB-274): description`

## Do NOT

- Expand task scope beyond the 3 specified files
- Skip adding the test case
- Modify behavior for other columns (triage, todo, in-progress)
- Skip tests or rely only on type checking
