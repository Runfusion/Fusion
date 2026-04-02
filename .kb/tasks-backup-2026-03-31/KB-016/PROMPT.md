# Task: KB-016 - Add ability to duplicate a task (sends back to triage from any state)

**Created:** 2026-03-30
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** This feature touches multiple layers (core store, CLI, API, dashboard) but follows established patterns. No security implications or irreversible operations.
**Score:** 4/8 — Blast radius: 1, Pattern novelty: 1, Security: 0, Reversibility: 2

## Mission

Add a "duplicate task" feature that creates a copy of an existing task with a new ID, placing it in triage for re-specification. This is useful when a task needs to be re-done, split, or used as a template. The duplicated task preserves the title and description but starts fresh in triage without worktree, steps, or execution state.

## Dependencies

- **None**

## Context to Read First

- `packages/core/src/store.ts` — TaskStore class with `createTask`, `deleteTask`, `updateTask` methods
- `packages/core/src/types.ts` — Task type definition and TaskCreateInput interface
- `packages/core/src/store.test.ts` — Test patterns for TaskStore methods
- `packages/cli/src/commands/task.ts` — CLI task command implementations
- `packages/cli/src/bin.ts` — CLI argument parsing and routing
- `packages/dashboard/src/routes.ts` — API route handlers
- `packages/dashboard/app/api.ts` — Frontend API client functions

## File Scope

- `packages/core/src/store.ts` — add `duplicateTask` method
- `packages/core/src/index.ts` — export new method if needed
- `packages/cli/src/commands/task.ts` — add `runTaskDuplicate` function
- `packages/cli/src/bin.ts` — add `kb task duplicate <id>` command
- `packages/dashboard/src/routes.ts` — add POST /tasks/:id/duplicate route
- `packages/dashboard/app/api.ts` — add `duplicateTask` API client function
- `packages/core/src/store.test.ts` — add tests for duplicateTask
- `packages/cli/src/commands/task.test.ts` — add tests for duplicate CLI command
- `packages/dashboard/src/routes.test.ts` — add tests for duplicate API endpoint

## Steps

### Step 1: Core Store Implementation

- [ ] Add `duplicateTask(id: string): Promise<Task>` method to TaskStore in `packages/core/src/store.ts`
- [ ] Method reads source task via `getTask`, allocates new ID via `allocateId()`
- [ ] Creates new task with: title copied, description copied with appended note `(Duplicated from {source-id})`, column set to "triage"
- [ ] Copies source PROMPT.md content to new task's PROMPT.md (the AI will re-specify it in triage)
- [ ] Resets execution state: no steps, currentStep: 0, no worktree, no status, no blockedBy, no baseBranch, no paused
- [ ] Does NOT copy dependencies (fresh task should be independently specified)
- [ ] Does NOT copy attachments (can be re-attached if needed)
- [ ] Does NOT copy steeringComments or agent logs
- [ ] Adds log entry: "Duplicated from {source-id}"
- [ ] Emits `task:created` event for the new task
- [ ] Run targeted tests for changed files

**Artifacts:**
- `packages/core/src/store.ts` (modified)

### Step 2: CLI Implementation

- [ ] Add `runTaskDuplicate(id: string)` function in `packages/cli/src/commands/task.ts`
- [ ] Function calls `store.duplicateTask(id)` and prints confirmation with new task ID
- [ ] Add `case "duplicate":` in `packages/cli/src/bin.ts` under task subcommands
- [ ] Parse args: `kb task duplicate <id>`
- [ ] Show error if ID not provided
- [ ] Print success message: `✓ Duplicated {source-id} → {new-id}`
- [ ] Run targeted tests for changed files

**Artifacts:**
- `packages/cli/src/commands/task.ts` (modified)
- `packages/cli/src/bin.ts` (modified)

### Step 3: Dashboard API Implementation

- [ ] Add POST `/tasks/:id/duplicate` route in `packages/dashboard/src/routes.ts`
- [ ] Route calls `store.duplicateTask(req.params.id)` and returns 201 with new task
- [ ] Handle 404 if source task not found
- [ ] Add `duplicateTask(id: string): Promise<Task>` function in `packages/dashboard/app/api.ts`
- [ ] Run targeted tests for changed files

**Artifacts:**
- `packages/dashboard/src/routes.ts` (modified)
- `packages/dashboard/app/api.ts` (modified)

### Step 4: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Add unit tests for `duplicateTask` in `packages/core/src/store.test.ts`
  - Test duplicates from each column (triage, todo, in-progress, in-review, done)
  - Test that new task is always in triage
  - Test that description includes source reference
  - Test that execution state is reset (no steps, no worktree, etc.)
  - Test that dependencies are not copied
  - Test that event is emitted
- [ ] Add CLI tests in `packages/cli/src/commands/task.test.ts` for duplicate command
- [ ] Add API tests in `packages/dashboard/src/routes.test.ts` for duplicate endpoint
- [ ] Run full test suite: `pnpm test`
- [ ] Fix all failures
- [ ] Build passes: `pnpm build`

**Artifacts:**
- `packages/core/src/store.test.ts` (modified)
- `packages/cli/src/commands/task.test.ts` (modified)
- `packages/dashboard/src/routes.test.ts` (modified)

### Step 5: Documentation & Delivery

- [ ] Update CLI help text in `packages/cli/src/bin.ts` to include `kb task duplicate <id>`
- [ ] Create changeset file for the new feature (minor bump):
  ```bash
  cat > .changeset/add-task-duplicate.md << 'EOF'
  ---
  "@dustinbyrne/kb": minor
  ---
  
  Add `kb task duplicate` command to create a copy of any task in triage.
  EOF
  ```
- [ ] Out-of-scope findings created as new tasks via `task_create` tool:
  - Dashboard UI button for duplicate (can be added later via KB-014 or similar task editing work)

## Documentation Requirements

**Must Update:**
- `packages/cli/src/bin.ts` — add `duplicate <id>` to task subcommand list in HELP text

**Check If Affected:**
- `AGENTS.md` — check if task lifecycle documentation needs updating

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Documentation updated
- [ ] Changeset file created

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-016): complete Step N — description`
- **Bug fixes:** `fix(KB-016): description`
- **Tests:** `test(KB-016): description`

## Do NOT

- Modify the original task when duplicating (it's a copy, not a move)
- Copy worktree, branch, or any execution state to the duplicate
- Copy dependencies (let triage determine them fresh)
- Copy attachments or steering comments
- Allow duplicate from a non-existent task ID (must 404)
- Modify dashboard UI components (API only — UI can be added separately)
