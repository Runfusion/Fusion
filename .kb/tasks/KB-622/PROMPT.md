# Task: KB-622 - Merge steering and comments into unified comments field

**Created:** 2026-03-31
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** This change affects multiple packages (core, engine, dashboard) and involves database schema migration, API changes, and UI updates. It touches data structures and could impact task execution context injection.
**Score:** 5/8 — Blast radius: 2 (cross-package changes), Pattern novelty: 1 (straightforward merge), Security: 1 (no security implications), Reversibility: 1 (can migrate back if needed)

## Mission

Unify the two separate comment systems (`steeringComments` and `comments`) into a single `comments` field. Currently, steering comments are injected into the AI execution context while regular comments are not. After this change, all comments (from both humans and agents) should be stored in one field and all comments should be injected into the execution context.

Key changes:
- Merge `SteeringComment` and `TaskComment` types into a unified `TaskComment` type with `id`, `text`, `author`, `createdAt`, `updatedAt` fields
- Migrate existing `steeringComments` data to the `comments` field
- Update `buildExecutionPrompt()` to read from `comments` instead of `steeringComments`
- Update all store methods (`addSteeringComment` → `addComment`, `addTaskComment` merge)
- Update API routes and dashboard UI
- Archive entries should preserve comments (already has the field)

## Dependencies

- **None**

## Context to Read First

- `packages/core/src/types.ts` — Current `SteeringComment` and `TaskComment` interfaces
- `packages/core/src/db.ts` — Database schema with `steeringComments` column
- `packages/core/src/store.ts` — Methods `addSteeringComment`, `addTaskComment`, `rowToTask`, `upsertTask`
- `packages/engine/src/executor.ts` — `buildExecutionPrompt()` function that injects steering comments
- `packages/dashboard/src/routes.ts` — `POST /tasks/:id/steer` route
- `packages/dashboard/app/components/SteeringTab.tsx` — UI component for adding steering comments
- `packages/dashboard/app/api.ts` — `addSteeringComment` and comment API functions

## File Scope

### Core Package
- `packages/core/src/types.ts` — Merge comment types, remove `SteeringComment`, update `Task` interface
- `packages/core/src/db.ts` — Add migration to move steeringComments data to comments, drop steeringComments column
- `packages/core/src/store.ts` — Merge comment methods, update rowToTask/upsertTask, migrate data handling

### Engine Package
- `packages/engine/src/executor.ts` — Update `buildExecutionPrompt()` to use `task.comments`

### Dashboard Package
- `packages/dashboard/src/routes.ts` — Update `/tasks/:id/steer` route, merge comment endpoints if needed
- `packages/dashboard/app/api.ts` — Update API functions
- `packages/dashboard/app/components/SteeringTab.tsx` — Update to use unified comments API
- `packages/dashboard/app/components/TaskDetailModal.tsx` — Update comments display

### Tests
- `packages/core/src/store.test.ts` — Update tests for steering comments
- `packages/core/src/db-migrate.test.ts` — Add migration test
- `packages/engine/src/executor.test.ts` — Update execution prompt tests
- `packages/dashboard/app/api.test.ts` — Update API test mocks
- `packages/dashboard/src/routes.test.ts` — Update route tests
- `packages/cli/src/__tests__/task-steer.test.ts` — Update CLI steering tests

## Steps

### Step 1: Type System Updates

- [ ] Remove `SteeringComment` interface from `types.ts`
- [ ] Update `TaskComment` interface to support both "user" and "agent" as author values (keep as string for flexibility)
- [ ] Remove `steeringComments?: SteeringComment[]` from `Task` interface (comments field already exists)
- [ ] Update `ArchivedTaskEntry` to ensure it has comments field (should already exist)
- [ ] Export unified comment types

**Artifacts:**
- `packages/core/src/types.ts` (modified)

### Step 2: Database Migration

- [ ] In `db.ts`, add schema migration (version 3) that:
  - Reads all tasks with `steeringComments` data
  - Migrates steering comments to the `comments` field, preserving `author` as "user" or "agent"
  - Drops the `steeringComments` column after migration
- [ ] Ensure migration is idempotent (only runs if steeringComments column exists)
- [ ] Add test for migration in `db-migrate.test.ts`

**Artifacts:**
- `packages/core/src/db.ts` (modified)
- `packages/core/src/db-migrate.test.ts` (modified)

### Step 3: Store Layer Updates

- [ ] Update `rowToTask()` in `store.ts`: remove steeringComments parsing, keep comments parsing
- [ ] Update `upsertTask()` in `store.ts`: remove steeringComments column from SQL/params
- [ ] Merge `addSteeringComment()` and `addTaskComment()` into unified `addComment()` method:
  - Keep auto-refinement behavior for user comments on done tasks
  - Support author parameter ("user" | "agent")
- [ ] Update `updateTaskComment()` and `deleteTaskComment()` to work with unified comments
- [ ] Remove `steeringComments` from archive entry creation in `archiveTask()`
- [ ] Update `restoreFromArchive()` to handle comments correctly

**Artifacts:**
- `packages/core/src/store.ts` (modified)

### Step 4: Executor Updates

- [ ] Update `buildExecutionPrompt()` in `executor.ts`:
  - Change `task.steeringComments` to `task.comments`
  - Keep the same injection format (last 10 comments)
  - Update section header from "Steering Comments" to "Comments"
- [ ] Update any executor tests that reference steeringComments

**Artifacts:**
- `packages/engine/src/executor.ts` (modified)

### Step 5: Dashboard API Updates

- [ ] Update `POST /tasks/:id/steer` route in `routes.ts`:
  - Change to call `store.addComment()` instead of `store.addSteeringComment()`
  - Keep same validation and error handling
- [ ] Review `/tasks/:id/comments` routes — may need to merge functionality
- [ ] Ensure all comment endpoints return consistent format

**Artifacts:**
- `packages/dashboard/src/routes.ts` (modified)

### Step 6: Dashboard UI Updates

- [ ] Update `SteeringTab.tsx`:
  - Rename to `CommentsTab.tsx` (or keep name but update internals)
  - Change `task.steeringComments` references to `task.comments`
  - Update API call from `addSteeringComment` to `addComment`
  - Update UI text ("Steering Comments" → "Comments")
- [ ] Update `TaskDetailModal.tsx` to reference comments correctly
- [ ] Update `api.ts`:
  - Rename `addSteeringComment` to `addComment`
  - Update function signature if needed
  - Ensure `fetchTaskComments` returns unified format

**Artifacts:**
- `packages/dashboard/app/components/SteeringTab.tsx` (modified/renamed)
- `packages/dashboard/app/components/TaskDetailModal.tsx` (modified)
- `packages/dashboard/app/api.ts` (modified)

### Step 7: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full test suite: `pnpm test`
- [ ] Fix all test failures
- [ ] Build passes: `pnpm build`
- [ ] Verify migration works by:
  - Creating a task with steering comments before the change
  - Running the new code
  - Confirming comments appear in the unified field

**Artifacts:**
- Test files updated as needed

### Step 8: Documentation & Delivery

- [ ] Create changeset file for the change:
  ```bash
  cat > .changeset/unify-comments.md << 'EOF'
  ---
  "@gsxdsm/fusion": minor
  ---
  
  Unify steeringComments and comments into a single comments field. All comments are now injected into the AI execution context.
  EOF
  ```
- [ ] Update relevant code comments/docs if any mention steeringComments specifically
- [ ] Out-of-scope findings: None expected

**Artifacts:**
- `.changeset/unify-comments.md` (new)

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Database migration successfully moves steeringComments to comments
- [ ] Comments from both agents and humans appear in execution context
- [ ] Dashboard UI shows unified comments
- [ ] Changeset file included

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-622): complete Step N — description`
- **Bug fixes:** `fix(KB-622): description`
- **Tests:** `test(KB-622): description`

## Do NOT

- Expand task scope (don't add new comment features like reactions, threading, etc.)
- Skip the database migration — data must be preserved
- Skip tests — all existing tests must pass
- Modify files outside the File Scope without good reason
- Commit without the task ID prefix
- Keep references to `steeringComments` in any code path
