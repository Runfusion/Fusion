# Task: KB-313 - Add Task Comments and Merge Details

**Created:** 2026-03-31
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** This task introduces new domain concepts (task comments vs steering comments) and extends merge tracking with richer metadata. It touches core types, store operations, API routes, and dashboard UI. The pattern is additive but requires careful naming to distinguish from existing steering comments.
**Score:** 5/8 — Blast radius: 1, Pattern novelty: 1, Security: 1, Reversibility: 2

## Mission

Add a general task commenting system that allows users to add arbitrary comments to tasks (distinct from steering comments which are execution feedback). Additionally, capture and display richer merge details when tasks are merged — including commit SHA, files changed, and merge confirmation status. This enables better collaboration and audit trail for completed work.

## Dependencies

- **None**

## Context to Read First

- `packages/core/src/types.ts` — existing `SteeringComment` interface, `MergeResult` interface, `Task` interface
- `packages/core/src/store.ts` — `addSteeringComment()` method and `mergeTask()` method patterns
- `packages/dashboard/src/routes.ts` — existing API route patterns for task operations
- `packages/dashboard/app/api.ts` — frontend API client patterns
- `packages/dashboard/app/components/TaskDetailModal.tsx` — task detail UI structure
- `packages/dashboard/app/components/PrSection.tsx` — PR info display component (similar pattern for merge details)
- `packages/cli/src/commands/task.ts` — CLI command patterns
- `packages/cli/src/bin.ts` — CLI command registration

## File Scope

- `packages/core/src/types.ts`
- `packages/core/src/store.ts`
- `packages/core/src/store.test.ts`
- `packages/dashboard/src/routes.ts`
- `packages/dashboard/src/routes.test.ts`
- `packages/dashboard/app/api.ts`
- `packages/dashboard/app/components/TaskComments.tsx` (new)
- `packages/dashboard/app/components/MergeDetails.tsx` (new)
- `packages/dashboard/app/components/TaskDetailModal.tsx`
- `packages/dashboard/app/components/__tests__/TaskComments.test.tsx` (new)
- `packages/dashboard/app/components/__tests__/MergeDetails.test.tsx` (new)
- `packages/cli/src/commands/task.ts`
- `packages/cli/src/bin.ts`
- `.changeset/*.md`

## Steps

### Step 0: Preflight

- [ ] Required files and paths exist
- [ ] Dependencies satisfied
- [ ] Review existing `SteeringComment` implementation to ensure clear differentiation

### Step 1: Extend Core Types with Task Comments and Merge Details

- [ ] Add new `TaskComment` interface in `packages/core/src/types.ts` with fields: `id`, `text`, `author` (string, not enum), `createdAt`, `updatedAt` (optional for edits)
- [ ] Add `comments?: TaskComment[]` to `Task` interface (distinct from `steeringComments`)
- [ ] Extend `MergeResult` with optional rich merge details: `commitSha?: string`, `filesChanged?: number`, `insertions?: number`, `deletions?: number`, `mergeCommitMessage?: string`, `mergedAt?: string`, `prNumber?: number`
- [ ] Add `mergeDetails?: MergeResult` to `Task` interface to persist merge info on the task
- [ ] Add `TaskCommentInput` interface for creating comments
- [ ] Add/update tests for type validation in `packages/core/src/store.test.ts`
- [ ] Run targeted tests for changed files

**Artifacts:**
- `packages/core/src/types.ts` (modified)
- `packages/core/src/store.test.ts` (modified)

### Step 2: Implement Store Methods for Comments and Merge Detail Persistence

- [ ] Add `addTaskComment(id: string, text: string, author: string): Promise<Task>` method in `packages/core/src/store.ts`
  - Generate unique ID with timestamp + random suffix pattern (same as steering comments)
  - Add to task.comments array
  - Log entry: "Comment added by {author}"
  - Emit `task:updated` event
- [ ] Add `updateTaskComment(id: string, commentId: string, text: string): Promise<Task>` method for editing comments
  - Validate comment exists
  - Update text and set `updatedAt`
  - Log entry: "Comment updated"
- [ ] Add `deleteTaskComment(id: string, commentId: string): Promise<Task>` method
  - Filter out comment from array
  - Log entry: "Comment deleted"
- [ ] Modify `mergeTask()` to capture and store merge details on successful merge
  - Parse git output to get commit SHA (use `git rev-parse HEAD` after merge)
  - Get files changed stats (use `git diff --stat HEAD~1` or similar)
  - Populate merge details and store on task.mergeDetails
- [ ] Add/update store tests for new methods
- [ ] Run targeted tests for changed files

**Artifacts:**
- `packages/core/src/store.ts` (modified)
- `packages/core/src/store.test.ts` (modified)

### Step 3: Add API Routes for Comments

- [ ] Add `POST /api/tasks/:id/comments` route in `packages/dashboard/src/routes.ts`
  - Body: `{ text: string, author?: string }` (author defaults to "user")
  - Returns updated task
- [ ] Add `PATCH /api/tasks/:id/comments/:commentId` route for editing
  - Body: `{ text: string }`
  - Returns updated task
- [ ] Add `DELETE /api/tasks/:id/comments/:commentId` route for deletion
  - Returns updated task
- [ ] Add `GET /api/tasks/:id/comments` route to get just comments (optional, for lazy loading)
  - Returns array of TaskComment
- [ ] Ensure all routes use task lock for consistency
- [ ] Add route tests in `packages/dashboard/src/routes.test.ts`
- [ ] Run targeted tests for changed files

**Artifacts:**
- `packages/dashboard/src/routes.ts` (modified)
- `packages/dashboard/src/routes.test.ts` (modified)

### Step 4: Create Dashboard UI Components

- [ ] Create `packages/dashboard/app/components/TaskComments.tsx`
  - Display list of comments with author, timestamp, and text
  - Show edit/delete buttons for user's own comments
  - Add comment input form at bottom
  - Use existing styling patterns (cards, buttons, typography)
  - Handle empty state gracefully
- [ ] Create `packages/dashboard/app/components/MergeDetails.tsx`
  - Display merge information when task.column === "done" and task.mergeDetails exists
  - Show: commit SHA (short), files changed count, insertions/deletions, merge timestamp, PR number if applicable
  - Link to commit if possible
  - Show merge success/failure status
- [ ] Add tests for both components in `packages/dashboard/app/components/__tests__/`
- [ ] Integrate TaskComments component into TaskDetailModal (new tab or section)
- [ ] Integrate MergeDetails component into TaskDetailModal (show when in done column)
- [ ] Update TaskDetailModal tests
- [ ] Run targeted tests for changed files

**Artifacts:**
- `packages/dashboard/app/components/TaskComments.tsx` (new)
- `packages/dashboard/app/components/MergeDetails.tsx` (new)
- `packages/dashboard/app/components/__tests__/TaskComments.test.tsx` (new)
- `packages/dashboard/app/components/__tests__/MergeDetails.test.tsx` (new)
- `packages/dashboard/app/components/TaskDetailModal.tsx` (modified)
- `packages/dashboard/app/components/__tests__/TaskDetailModal.test.tsx` (modified)

### Step 5: Add Frontend API Client Methods

- [ ] Add `addTaskComment(id: string, text: string, author?: string): Promise<Task>` in `packages/dashboard/app/api.ts`
- [ ] Add `updateTaskComment(id: string, commentId: string, text: string): Promise<Task>`
- [ ] Add `deleteTaskComment(id: string, commentId: string): Promise<Task>`
- [ ] Add `fetchTaskComments(id: string): Promise<TaskComment[]>`
- [ ] Add tests in `packages/dashboard/app/api.test.ts`
- [ ] Run targeted tests for changed files

**Artifacts:**
- `packages/dashboard/app/api.ts` (modified)
- `packages/dashboard/app/api.test.ts` (modified)

### Step 6: Add CLI Commands for Task Comments

- [ ] Add `comment` subcommand to task command in `packages/cli/src/bin.ts`
  - `fn task comment <id> [message]` — add comment (prompts if message omitted)
  - Support `--author` flag (defaults to current user or "user")
- [ ] Implement `runTaskComment(id: string, text: string, author?: string)` in `packages/cli/src/commands/task.ts`
  - Use store.addTaskComment()
  - Print confirmation with comment ID
- [ ] Add `fn task comments <id>` subcommand to list comments
  - Show author, timestamp, and text for each comment
- [ ] Add tests in `packages/cli/src/commands/task.test.ts`
- [ ] Run targeted tests for changed files

**Artifacts:**
- `packages/cli/src/bin.ts` (modified)
- `packages/cli/src/commands/task.ts` (modified)
- `packages/cli/src/commands/task.test.ts` (modified)

### Step 7: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run targeted tests while implementing:
  - `pnpm --filter @kb/core test -- src/store.test.ts`
  - `pnpm --filter @kb/dashboard test -- src/routes.test.ts app/components/__tests__/TaskComments.test.tsx app/components/__tests__/MergeDetails.test.tsx`
  - `pnpm --filter @dustinbyrne/kb test -- src/commands/task.test.ts`
- [ ] Run full test suite: `pnpm test`
- [ ] Fix all failures
- [ ] Build passes: `pnpm build`

### Step 8: Documentation & Delivery

- [ ] Create changeset for `@dustinbyrne/kb` describing new task comments and merge details features
- [ ] Update README.md with documentation on:
  - How to add comments to tasks via CLI and dashboard
  - How merge details are captured and displayed
  - Difference between steering comments and task comments
- [ ] Out-of-scope findings created as new tasks via `task_create` tool

**Artifacts:**
- `.changeset/add-task-comments-and-merge-details.md` (new)
- `README.md` (modified)

## Documentation Requirements

**Must Update:**
- `README.md` — document task comments feature and merge details display
- `.changeset/*.md` — add release note for published package behavior change

**Check If Affected:**
- `packages/cli/README.md` — if CLI commands need separate documentation
- `packages/dashboard/README.md` — if dashboard features need separate documentation

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Documentation updated
- [ ] Task comments can be added/viewed/edited/deleted via both CLI and dashboard
- [ ] Merge details are captured and displayed for merged tasks
- [ ] Changeset file created

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-313): complete Step N — description`
- **Bug fixes:** `fix(KB-313): description`
- **Tests:** `test(KB-313): description`

## Do NOT

- Expand task scope beyond task comments and merge details
- Skip tests
- Modify files outside the File Scope without good reason
- Commit without the task ID prefix
- Confuse task comments with steering comments (they serve different purposes)
- Break existing steering comment functionality
