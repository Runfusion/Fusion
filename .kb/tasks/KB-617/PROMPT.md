# Task: KB-617 - Store Modified Files Reference and Add Diff Viewer Tab

**Created:** 2026-03-31
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** This task touches core types, the executor agent, store methods, API routes, and dashboard UI. It requires coordinated changes across multiple packages but follows established patterns.

**Score:** 4/8 — Blast radius: 1 (localized to task metadata), Pattern novelty: 1 (follows existing field patterns), Security: 1 (no new attack surface), Reversibility: 1 (additive only)

## Mission

Track files modified during agent execution and expose them in a new "Changes" tab in the task detail modal. Currently, the dashboard computes modified files on-the-fly via `git diff` in the session-files endpoint. This enhancement captures the file list at task completion time and provides a dedicated UI for viewing file-by-file diffs.

**Why it matters:** Users need visibility into what files were touched by the AI agent without manually running git commands. A persistent record of modified files enables better code review and audit trails.

## Dependencies

- **None**

## Context to Read First

- `packages/core/src/types.ts` — Task type definition and related interfaces
- `packages/core/src/store.ts` — TaskStore class with CRUD operations
- `packages/engine/src/executor.ts` — TaskExecutor that runs agent sessions
- `packages/dashboard/src/routes.ts` — API routes including `/tasks/:id/session-files`
- `packages/dashboard/app/components/TaskDetailModal.tsx` — Modal with tabs for task details
- `packages/dashboard/app/api.ts` — Frontend API client functions

## File Scope

### Core Package
- `packages/core/src/types.ts` — Add `modifiedFiles` field to Task interface
- `packages/core/src/store.ts` — Update row conversion and upsert methods

### Engine Package
- `packages/engine/src/executor.ts` — Capture modified files after agent execution

### Dashboard Package
- `packages/dashboard/src/routes.ts` — Add `/tasks/:id/diff` endpoint
- `packages/dashboard/app/api.ts` — Add `fetchTaskDiff` API function
- `packages/dashboard/app/components/TaskDetailModal.tsx` — Add "Changes" tab
- `packages/dashboard/app/components/TaskChangesTab.tsx` — New component for diff viewer (create this file)

## Steps

### Step 1: Core Types and Store Updates

- [ ] Add `modifiedFiles?: string[]` field to `Task` interface in `packages/core/src/types.ts`
- [ ] Update `rowToTask()` method in `packages/core/src/store.ts` to parse `modifiedFiles` JSON column
- [ ] Update `upsertTask()` method in `packages/core/src/store.ts` to persist `modifiedFiles` as JSON
- [ ] Run core package tests: `pnpm --filter @fusion/core test`

**Artifacts:**
- `packages/core/src/types.ts` (modified)
- `packages/core/src/store.ts` (modified)

### Step 2: Capture Modified Files in Executor

- [ ] In `TaskExecutor.execute()`, after `task_done()` is called and before workflow steps run, capture the list of modified files using `git diff --name-only` against the base branch
- [ ] Store the file list in the task via `store.updateTask(taskId, { modifiedFiles: files })`
- [ ] Handle edge cases: empty diff, missing worktree, git errors (log warning but don't fail the task)
- [ ] Run engine package tests: `pnpm --filter @fusion/engine test`

**Artifacts:**
- `packages/engine/src/executor.ts` (modified)

### Step 3: API Endpoint for Task Diffs

- [ ] Add `GET /tasks/:id/diff` endpoint in `packages/dashboard/src/routes.ts`
- [ ] Endpoint should return `{ files: string[]; diffs: Record<string, { stat: string; patch: string }> }`
- [ ] For each modified file, compute diff using `git diff` against the base branch
- [ ] Handle errors gracefully: return empty diffs for files that can't be diffed
- [ ] Add rate limiting or caching if needed (follow pattern from `session-files` endpoint)

**Artifacts:**
- `packages/dashboard/src/routes.ts` (modified)

### Step 4: Frontend API Client

- [ ] Add `fetchTaskDiff(taskId: string)` function in `packages/dashboard/app/api.ts`
- [ ] Return type: `Promise<{ files: string[]; diffs: Record<string, { stat: string; patch: string }> }>`

**Artifacts:**
- `packages/dashboard/app/api.ts` (modified)

### Step 5: Changes Tab UI Components

- [ ] Create `packages/dashboard/app/components/TaskChangesTab.tsx`:
  - [ ] Props interface: `{ taskId: string; worktree?: string }`
  - [ ] Fetch diff data via `fetchTaskDiff`
  - [ ] Show file list with status indicators (added/modified/deleted)
  - [ ] Click file to expand and view diff patch
  - [ ] Use existing syntax highlighting approach from codebase
  - [ ] Handle loading and error states
  - [ ] Show empty state when no files modified
- [ ] Add `TaskChangesTab` export to component index if needed

**Artifacts:**
- `packages/dashboard/app/components/TaskChangesTab.tsx` (new)

### Step 6: Integrate Changes Tab into Task Detail Modal

- [ ] Import `TaskChangesTab` in `TaskDetailModal.tsx`
- [ ] Add "changes" to `activeTab` union type
- [ ] Add Changes tab button in the tab row (position after "Agent Log")
- [ ] Render `TaskChangesTab` when `activeTab === "changes"`
- [ ] Pass `taskId` and `task.worktree` as props
- [ ] Ensure tab is only shown for tasks in "in-progress", "in-review", or "done" columns

**Artifacts:**
- `packages/dashboard/app/components/TaskDetailModal.tsx` (modified)

### Step 7: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run all package tests: `pnpm test`
- [ ] Build all packages: `pnpm build`
- [ ] Typecheck all packages: `pnpm typecheck`
- [ ] Manual verification: Create a test task, let it modify files, verify Changes tab appears and shows correct diffs

### Step 8: Documentation & Delivery

- [ ] Update `AGENTS.md` if there are agent-facing documentation changes (none expected)
- [ ] Create changeset file for the feature:
  ```bash
  cat > .changeset/add-diff-viewer-tab.md << 'EOF'
  ---
  "@gsxdsm/fusion": minor
  ---

  Add Changes tab to task detail modal showing files modified by the agent and their diffs.
  EOF
  ```

## Documentation Requirements

**Must Update:**
- None (feature is self-documenting via UI)

**Check If Affected:**
- `packages/dashboard/README.md` — Add mention of Changes tab if there's a feature list

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing (`pnpm test`)
- [ ] Build passes (`pnpm build`)
- [ ] Typecheck passes (`pnpm typecheck`)
- [ ] Changes tab visible in task detail modal for tasks with modified files
- [ ] Diff viewer correctly displays file changes with patch content

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-617): complete Step N — description`
- **Bug fixes:** `fix(KB-617): description`
- **Tests:** `test(KB-617): description`

## Do NOT

- Modify the session-files endpoint behavior (keep it as-is for backward compatibility)
- Store full diff content in the database (only store file paths; compute diffs on-demand)
- Show the Changes tab for tasks in "triage" or "todo" columns (no worktree yet)
- Break existing task detail modal functionality
- Skip error handling for git operations (worktrees may be cleaned up)
