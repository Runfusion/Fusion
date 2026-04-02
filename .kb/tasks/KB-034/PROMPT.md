# Task: KB-034 - Add a way to archive done tasks

**Created:** 2026-03-30
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** This feature touches core domain types, store methods, CLI commands, API routes, and UI components. The pattern of adding a new column follows existing conventions but requires coordinated changes across multiple packages.
**Score:** 5/8 — Blast radius: 2, Pattern novelty: 1, Security: 1, Reversibility: 1

## Mission

Add an "archived" column to the kanban board that serves as a long-term storage for completed tasks. This keeps the "done" column focused on recently completed work while preserving historical tasks in an accessible but unobtrusive location. Tasks can move: done → archived (to archive) and archived → done (to unarchive).

## Dependencies

- **None**

## Context to Read First

- `packages/core/src/types.ts` — Column type definitions, VALID_TRANSITIONS, COLUMN_LABELS, COLUMN_DESCRIPTIONS
- `packages/core/src/store.ts` — TaskStore class with moveTask and related methods
- `packages/cli/src/commands/task.ts` — CLI task commands implementation
- `packages/dashboard/src/routes.ts` — API routes for task operations
- `packages/dashboard/app/components/Board.tsx` — Main board component that renders columns
- `packages/dashboard/app/components/Column.tsx` — Individual column rendering
- `packages/dashboard/app/api.ts` — Frontend API client
- `packages/core/src/store.test.ts` — Test patterns for store operations

## File Scope

- `packages/core/src/types.ts` — Add "archived" to COLUMNS, VALID_TRANSITIONS, labels, descriptions
- `packages/core/src/store.ts` — Add archiveTask and unarchiveTask methods (or extend moveTask)
- `packages/core/src/index.ts` — Export new types if needed
- `packages/cli/src/commands/task.ts` — Add archive/unarchive CLI commands
- `packages/cli/src/bin.ts` — Register new CLI commands
- `packages/dashboard/src/routes.ts` — Add archive API endpoints
- `packages/dashboard/app/api.ts` — Add archive/unarchive API client functions
- `packages/dashboard/app/components/Board.tsx` — Render archived column (collapsed by default or at end)
- `packages/dashboard/app/components/Column.tsx` — Handle archived column display (no special actions)
- `packages/core/src/store.test.ts` — Add tests for archive functionality
- `packages/dashboard/app/components/__tests__/Board.test.tsx` — Update tests if needed

## Steps

### Step 1: Core Types and Store Methods

- [ ] Add "archived" to COLUMNS array in types.ts
- [ ] Update VALID_TRANSITIONS: done → [archived], archived → [done]
- [ ] Add COLUMN_LABELS entry: archived → "Archived"
- [ ] Add COLUMN_DESCRIPTIONS entry: archived → "Completed and archived"
- [ ] Add archiveTask(id) method to TaskStore (moves done → archived, logs action)
- [ ] Add unarchiveTask(id) method to TaskStore (moves archived → done, logs action)
- [ ] Update Column type to include "archived"
- [ ] Run core package tests

**Artifacts:**
- `packages/core/src/types.ts` (modified)
- `packages/core/src/store.ts` (modified)
- `packages/core/src/index.ts` (modified if needed)

### Step 2: CLI Commands

- [ ] Add `runTaskArchive(id)` function in task.ts (calls store.archiveTask)
- [ ] Add `runTaskUnarchive(id)` function in task.ts (calls store.unarchiveTask)
- [ ] Register `kb task archive <id>` command in bin.ts
- [ ] Register `kb task unarchive <id>` command in bin.ts
- [ ] Update `runTaskList()` to show archived column count (optional, or filter out by default)
- [ ] Test CLI commands locally

**Artifacts:**
- `packages/cli/src/commands/task.ts` (modified)
- `packages/cli/src/bin.ts` (modified)

### Step 3: Dashboard API Routes

- [ ] Add POST `/api/tasks/:id/archive` route in routes.ts
- [ ] Add POST `/api/tasks/:id/unarchive` route in routes.ts
- [ ] Both routes should return the updated task and emit appropriate events
- [ ] Run dashboard server tests

**Artifacts:**
- `packages/dashboard/src/routes.ts` (modified)

### Step 4: Dashboard UI Components

- [ ] Add `archiveTask(id)` function in api.ts
- [ ] Add `unarchiveTask(id)` function in api.ts
- [ ] Update Board.tsx to include "archived" column (render at the end, possibly collapsed by default)
- [ ] Add UI affordance to archive a done task (context menu or button on TaskCard in done column)
- [ ] Add UI affordance to unarchive (button in archived column)
- [ ] Archived column should show tasks but without merge/retry actions (archived tasks are done)
- [ ] Run dashboard component tests

**Artifacts:**
- `packages/dashboard/app/api.ts` (modified)
- `packages/dashboard/app/components/Board.tsx` (modified)
- `packages/dashboard/app/components/TaskCard.tsx` (modified for archive action)

### Step 5: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Add store tests for archiveTask and unarchiveTask in store.test.ts
- [ ] Add tests for valid transitions: done → archived, archived → done
- [ ] Add tests for invalid transitions (e.g., archived → in-progress should fail)
- [ ] Add CLI command tests if test file exists
- [ ] Run full test suite: `pnpm test`
- [ ] Fix all failures
- [ ] Run build: `pnpm build`

### Step 6: Documentation & Delivery

- [ ] Update AGENTS.md if there are column-related guidelines (check if column docs exist)
- [ ] Create changeset: `add-archive-tasks.md` (patch — new feature for @dustinbyrne/kb)
- [ ] Verify CLI help text shows new commands
- [ ] Out-of-scope findings: If any related features (bulk archive, auto-archive after N days) are identified, create follow-up tasks via `task_create` tool

**Artifacts:**
- `.changeset/add-archive-tasks.md` (new)

## Documentation Requirements

**Must Update:**
- `.changeset/add-archive-tasks.md` — Describe the new archive feature

**Check If Affected:**
- `AGENTS.md` — Check if column behavior is documented (likely not, but verify)
- `README.md` — Check if CLI commands are documented

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Documentation updated
- [ ] Changeset created
- [ ] CLI `kb task archive <id>` works from done column
- [ ] CLI `kb task unarchive <id>` works from archived column
- [ ] Dashboard shows archived column with archived tasks
- [ ] Can archive/unarchive via dashboard UI

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-034): complete Step N — description`
- **Bug fixes:** `fix(KB-034): description`
- **Tests:** `test(KB-034): description`
- **Changeset:** Include changeset file in relevant commit

## Do NOT

- Expand scope to include auto-archive schedules or bulk archive operations
- Skip tests for any modified files
- Modify files outside the File Scope without good reason
- Archive tasks from columns other than done (enforced by VALID_TRANSITIONS)
- Allow new tasks to be created directly in archived column
- Commit without the task ID prefix
