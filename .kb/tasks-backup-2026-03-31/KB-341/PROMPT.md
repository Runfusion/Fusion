# Task: KB-341 - Unify Task Comments to Single "Steering" Type

**Created:** 2026-03-31
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** This is a focused refactoring task with limited blast radius. The changes are primarily renaming types and fields for clarity since the system already only supports one comment type.
**Score:** 3/8 — Blast radius: 1, Pattern novelty: 0, Security: 0, Reversibility: 2

## Mission

Unify the task comment system so there is only ONE type of comment. Rename `SteeringComment` to `Comment` and `steeringComments` to `comments` throughout the codebase, updating UI labels from "Steering Comments" to "Comments" for simplicity and clarity.

The system already only supports steering comments — this task formalizes that by removing the "steering" prefix since there's no other comment type to distinguish from.

## Dependencies

- **None**

## Context to Read First

- `packages/core/src/types.ts` — Contains `SteeringComment` interface and its usage in `Task` and `TaskCreateInput`
- `packages/core/src/store.ts` — Contains `addSteeringComment` method and database serialization logic
- `packages/core/src/index.ts` — Exports `SteeringComment` type publicly
- `packages/dashboard/app/components/SteeringTab.tsx` — UI component that displays and adds steering comments
- `packages/dashboard/app/api.ts` — Contains `addSteeringComment` API function
- `packages/dashboard/src/routes.ts` — Server-side API routes that handle the steer endpoint
- `packages/cli/src/commands/task.ts` — Contains `runTaskSteer` CLI command
- `packages/cli/src/extension.ts` — Pi extension tools
- `packages/cli/src/bin.ts` — CLI command registration
- `packages/engine/src/pr-comment-handler.ts` — Uses `addSteeringComment`

## File Scope

- `packages/core/src/types.ts`
- `packages/core/src/store.ts`
- `packages/core/src/index.ts`
- `packages/dashboard/app/components/SteeringTab.tsx`
- `packages/dashboard/app/api.ts`
- `packages/dashboard/src/routes.ts`
- `packages/dashboard/src/routes.test.ts`
- `packages/cli/src/commands/task.ts`
- `packages/cli/src/extension.ts`
- `packages/cli/src/bin.ts`
- `packages/cli/src/__tests__/task-steer.test.ts`
- `packages/engine/src/pr-comment-handler.ts`
- `packages/engine/src/pr-comment-handler.test.ts`
- `packages/dashboard/app/components/__tests__/SteeringTab.test.tsx`

## Steps

### Step 1: Rename Types in Core Package

- [ ] In `packages/core/src/types.ts`:
  - Rename `SteeringComment` interface to `Comment`
  - Rename `steeringComments` field to `comments` in `Task` interface
  - Note: `ArchivedTaskEntry` intentionally does NOT include comments (they're excluded during archive)
- [ ] In `packages/core/src/store.ts`:
  - Rename `addSteeringComment` method to `addComment`
  - Update internal references from `steeringComments` to `comments`
  - Update database column mapping in `rowToTask` and `upsertTask` methods
- [ ] In `packages/core/src/index.ts`:
  - Update the export from `SteeringComment` to `Comment`

**Artifacts:**
- `packages/core/src/types.ts` (modified)
- `packages/core/src/store.ts` (modified)
- `packages/core/src/index.ts` (modified)

### Step 2: Update Dashboard UI Components and API

- [ ] In `packages/dashboard/app/components/SteeringTab.tsx`:
  - Update `task.steeringComments` references to `task.comments`
  - Change UI label from "Steering Comments" to "Comments"
  - Change placeholder from "Add a steering comment..." to "Add a comment..."
  - Change button text from "Add Steering Comment" to "Add Comment"
  - Change toast message from "Steering comment added" to "Comment added"
- [ ] In `packages/dashboard/app/api.ts`:
  - Rename `addSteeringComment` function to `addComment`
  - Update the API endpoint from `/tasks/${id}/steer` to `/tasks/${id}/comments`
- [ ] In `packages/dashboard/src/routes.ts`:
  - Update the server-side route handler from `/tasks/:id/steer` to `/tasks/:id/comments`
  - Update method call from `addSteeringComment` to `addComment`

**Artifacts:**
- `packages/dashboard/app/components/SteeringTab.tsx` (modified)
- `packages/dashboard/app/api.ts` (modified)
- `packages/dashboard/src/routes.ts` (modified)

### Step 3: Update CLI Commands

- [ ] In `packages/cli/src/commands/task.ts`:
  - Rename `runTaskSteer` function to `runTaskComment`
  - Update CLI output from "Steering comment added" to "Comment added"
- [ ] In `packages/cli/src/bin.ts`:
  - Update command registration: rename `task steer` to `task comment`
  - Keep `task steer` as an alias for backward compatibility if the CLI framework supports it
- [ ] In `packages/cli/src/extension.ts`:
  - Check for any references to "steering" and update to "comment"

**Artifacts:**
- `packages/cli/src/commands/task.ts` (modified)
- `packages/cli/src/bin.ts` (modified)

### Step 4: Update Engine PR Comment Handler

- [ ] In `packages/engine/src/pr-comment-handler.ts`:
  - Update `addSteeringComment` call to `addComment`
- [ ] In `packages/engine/src/pr-comment-handler.test.ts`:
  - Update mocks and assertions for the renamed method

**Artifacts:**
- `packages/engine/src/pr-comment-handler.ts` (modified)
- `packages/engine/src/pr-comment-handler.test.ts` (modified)

### Step 5: Update Tests

- [ ] In `packages/cli/src/__tests__/task-steer.test.ts`:
  - Rename test file to `task-comment.test.ts` if desired (or keep existing name)
  - Update test descriptions and mocks for the renamed function
  - Update assertions checking for "steering" in output
- [ ] In `packages/dashboard/src/routes.test.ts`:
  - Update tests for the `/tasks/:id/steer` endpoint to `/tasks/:id/comments`
- [ ] In `packages/dashboard/app/components/__tests__/SteeringTab.test.tsx`:
  - Update test selectors and assertions for new UI labels
- [ ] Run core package tests: `pnpm --filter @fusion/core test`
- [ ] Run CLI tests: `pnpm --filter @fusion/cli test`
- [ ] Run dashboard tests: `pnpm --filter @fusion/dashboard test`
- [ ] Run engine tests: `pnpm --filter @fusion/engine test`

**Artifacts:**
- `packages/cli/src/__tests__/task-steer.test.ts` (modified, optionally renamed)
- `packages/dashboard/src/routes.test.ts` (modified)
- `packages/dashboard/app/components/__tests__/SteeringTab.test.tsx` (modified)

### Step 6: Database Migration Considerations

- [ ] The database uses JSON columns for comments — the field rename is handled in code, not schema
- [ ] Existing `steeringComments` data in SQLite JSON columns will be read/written via the renamed field in `rowToTask` and `upsertTask`
- [ ] Verify the JSON serialization in `toJson(task.comments || [])` works correctly
- [ ] Note: `ArchivedTaskEntry` intentionally excludes comments — archived tasks don't restore comments

**Artifacts:**
- No migration needed — JSON column structure unchanged

### Step 7: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full test suite: `pnpm test`
- [ ] Build all packages: `pnpm build`
- [ ] Verify the dashboard renders the Comments tab correctly
- [ ] Verify the CLI `kb task comment` command works (with `steer` alias if implemented)
- [ ] Typecheck passes for all modified files

**Artifacts:**
- All tests passing
- Build successful

### Step 8: Documentation & Delivery

- [ ] Create changeset file: `.changeset/unify-comments.md`
- [ ] Verify no references to "steering comment" remain in user-facing strings
- [ ] Update any internal documentation if needed

**Artifacts:**
- `.changeset/unify-comments.md` (new)

## Documentation Requirements

**Must Update:**
- `.changeset/unify-comments.md` — Document the breaking change for the CLI command rename (if applicable)

**Check If Affected:**
- `AGENTS.md` — Search for any references to "steering" and update if found

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing (`pnpm test`)
- [ ] Build passes (`pnpm build`)
- [ ] No references to `SteeringComment` type remain (now `Comment`)
- [ ] No references to `steeringComments` field remain (now `comments`)
- [ ] UI labels say "Comments" not "Steering Comments"
- [ ] Changeset file created

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-341): complete Step N — description`
- **Bug fixes:** `fix(KB-341): description`
- **Tests:** `test(KB-341): description`

## Do NOT

- Expand scope to add new comment features (likes, replies, etc.)
- Skip tests or update tests without running them
- Modify files outside the File Scope without good reason
- Commit without the task ID prefix
- Add a database migration — the JSON column structure is unchanged
- Add comments to `ArchivedTaskEntry` — they're intentionally excluded
