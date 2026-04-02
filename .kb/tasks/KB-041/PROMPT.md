# Task: KB-041 - Add Refine Task Option for Done/In-Review Tasks

**Created:** 2026-03-30
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** This feature spans the core task store, dashboard API, frontend UI, and CLI extension. It introduces a new workflow pattern (creating follow-up refinement tasks) that must integrate cleanly with existing triage and execution flows. Pattern is similar to existing `duplicateTask` but with user-provided feedback context.
**Score:** 5/8 — Blast radius: 1, Pattern novelty: 1, Security: 1, Reversibility: 2

## Mission

Add a "refine task" feature that allows users to provide follow-up comments on tasks that are done or in-review. These comments get triaged into a new follow-up task that references the original and is processed by the execution engine. This enables iterative improvement workflows where completed work needs additional follow-up.

## Dependencies

- **None**

## Context to Read First

- `packages/core/src/store.ts` — TaskStore methods: `duplicateTask`, `createTask`, `updateTask`, `moveTask`
- `packages/core/src/types.ts` — Task type definitions, Column types, VALID_TRANSITIONS
- `packages/dashboard/src/routes.ts` — Existing API endpoints: `/tasks/:id/duplicate`, `/tasks/:id/spec/revise`
- `packages/dashboard/app/api.ts` — Frontend API client functions
- `packages/dashboard/app/components/TaskDetailModal.tsx` — UI for task actions (duplicate, merge, move)
- `packages/cli/src/extension.ts` — Pi extension tools: `kb_task_duplicate` pattern
- `packages/engine/src/triage.ts` — How triage processes tasks and builds prompts

## File Scope

- `packages/core/src/store.ts` — Add `refineTask` method
- `packages/core/src/types.ts` — (read-only, reference for types)
- `packages/dashboard/src/routes.ts` — Add POST `/tasks/:id/refine` endpoint
- `packages/dashboard/app/api.ts` — Add `refineTask` client function
- `packages/dashboard/app/components/TaskDetailModal.tsx` — Add refine UI button and modal
- `packages/cli/src/extension.ts` — Add `kb_task_refine` tool
- `packages/cli/src/commands/task.ts` — Add `runTaskRefine` function and CLI command
- `packages/cli/src/commands/task.test.ts` — Add tests for refine functionality

## Steps

### Step 1: Core TaskStore — Add refineTask Method

- [ ] Add `refineTask(id: string, feedback: string): Promise<Task>` method to TaskStore class in `packages/core/src/store.ts`
- [ ] Method validates original task exists and is in "done" or "in-review" column (throw if not)
- [ ] Creates new task in "triage" column with:
  - Title: `"Refinement: ${original.title || original.id}"`
  - Description: User's feedback text + `\n\nRefines: ${original.id}`
  - Dependencies: `[original.id]` (the refinement depends on the original being complete)
  - Log entry: `"Created as refinement of ${original.id}"`
- [ ] Copies attachments from original task to new task (optional but useful for context)
- [ ] Emits `task:created` event for the new refinement task
- [ ] Run targeted tests: `pnpm test --filter @kb/core -- --run store.test.ts`

**Artifacts:**
- `packages/core/src/store.ts` (modified — add `refineTask` method)

### Step 2: Dashboard API — Add Refine Endpoint

- [ ] Add POST `/tasks/:id/refine` endpoint in `packages/dashboard/src/routes.ts`
- [ ] Request body: `{ feedback: string }` with validation (1-2000 characters)
- [ ] Returns the newly created refinement task
- [ ] Error handling: 404 if task not found, 400 if task not in done/in-review, 400 if feedback invalid
- [ ] Logs the refinement action: `await store.logEntry(id, "Refinement requested", feedback.slice(0, 100))`
- [ ] Run targeted tests: `pnpm test --filter @kb/dashboard -- --run routes.test.ts`

**Artifacts:**
- `packages/dashboard/src/routes.ts` (modified — add refine endpoint)

### Step 3: Dashboard Frontend — Add Refine UI

- [ ] Add `refineTask(id: string, feedback: string): Promise<Task>` function in `packages/dashboard/app/api.ts`
- [ ] In `TaskDetailModal.tsx`, add "Request Refinement" button visible only when task.column is "done" or "in-review"
- [ ] Button opens a modal/dialog with:
  - Textarea for feedback input (max 2000 chars, with counter)
  - Submit and Cancel buttons
  - Description: "Describe what needs to be refined or improved..."
- [ ] On submit: call `refineTask(task.id, feedback)`, show success toast with new task ID, close detail modal
- [ ] On error: show error toast with message
- [ ] Place button in modal actions area near other action buttons
- [ ] Run targeted tests: `pnpm test --filter @kb/dashboard -- --run TaskDetailModal.test.ts`

**Artifacts:**
- `packages/dashboard/app/api.ts` (modified — add refineTask client)
- `packages/dashboard/app/components/TaskDetailModal.tsx` (modified — add UI)

### Step 4: CLI Extension — Add kb_task_refine Tool

- [ ] Add `kb_task_refine` tool in `packages/cli/src/extension.ts`
- [ ] Parameters: `{ id: string, feedback: string }`
- [ ] Calls `store.refineTask(id, feedback)` and returns new task details
- [ ] Include prompt guidelines: "Use when a completed or in-review task needs follow-up work or improvements"
- [ ] Update extension tests if they exist for tool registration

**Artifacts:**
- `packages/cli/src/extension.ts` (modified — add refine tool)

### Step 5: CLI Commands — Add refine Command

- [ ] Add `runTaskRefine(id: string, feedback: string)` function in `packages/cli/src/commands/task.ts`
- [ ] Add CLI command: `kb task refine <id>` that prompts for feedback interactively
- [ ] Support optional `--feedback "text"` flag for non-interactive use
- [ ] Error handling: validate task is done/in-review before proceeding
- [ ] Output: print new task ID, path, and dependency on original
- [ ] Add comprehensive tests in `packages/cli/src/commands/task.test.ts`

**Artifacts:**
- `packages/cli/src/commands/task.ts` (modified — add runTaskRefine)
- `packages/cli/src/commands/task.test.ts` (modified — add tests)

### Step 6: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full test suite: `pnpm test`
- [ ] Verify all new tests pass
- [ ] Build passes: `pnpm build`
- [ ] Manual verification: Create a task, move to done, click "Request Refinement", verify new task created in triage with correct description and dependency

### Step 7: Documentation & Delivery

- [ ] Update `AGENTS.md` — document the new `kb_task_refine` tool if tools are documented there
- [ ] Update `README.md` — add refine feature to feature list
- [ ] Create changeset for the feature: `.changeset/add-refine-task.md`
- [ ] Out-of-scope findings: None expected

**Artifacts:**
- `AGENTS.md` (modified — if applicable)
- `README.md` (modified — feature list)
- `.changeset/add-refine-task.md` (new)

## Documentation Requirements

**Must Update:**
- `README.md` — Add "Refine completed tasks" to the feature list under task management

**Check If Affected:**
- `AGENTS.md` — Check if pi extension tools are documented; add `kb_task_refine` if so

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing (`pnpm test`)
- [ ] Build passes (`pnpm build`)
- [ ] Manual verification successful: can refine a done task, new task appears in triage with feedback text and dependency
- [ ] Documentation updated
- [ ] Changeset created

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-041): complete Step N — description`
- **Bug fixes:** `fix(KB-041): description`
- **Tests:** `test(KB-041): description`

Example commits:
- `feat(KB-041): complete Step 1 — add refineTask method to TaskStore`
- `feat(KB-041): complete Step 2 — add POST /tasks/:id/refine endpoint`
- `feat(KB-041): complete Step 3 — add refine UI to TaskDetailModal`
- `feat(KB-041): complete Step 4 — add kb_task_refine pi tool`
- `feat(KB-041): complete Step 5 — add kb task refine CLI command`

## Do NOT

- Expand scope to include automatic refinement detection (keep it user-initiated)
- Modify the triage agent logic — refinements are processed as normal triage tasks
- Allow refinement of tasks in triage/todo/in-progress (only done/in-review)
- Create circular dependencies (refinement depends on original, never vice versa)
- Skip tests for the new functionality
- Modify worktrees or branches during refinement creation (it's a new task creation only)
