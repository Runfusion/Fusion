# Task: KB-198 - Add CLI command `kb task delete <id>` to delete tasks from the command line

**Created:** 2026-03-30
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** This is a straightforward CLI command addition that follows established patterns. It adds a single new command with minimal blast radius (one new function, one new CLI case, one new extension tool).
**Score:** 2/8 — Blast radius: 0, Pattern novelty: 0, Security: 1, Reversibility: 1

## Mission

Add a `kb task delete <id>` CLI command that allows users to delete tasks from the command line. This is essential for headless/automation workflows and CI/CD cleanup where users cannot access the dashboard web UI. The command must include a confirmation prompt for safety, with a `--force` flag to skip confirmation for scripting use cases.

## Dependencies

- **Task:** KB-182 (gap analysis completed — this is one of the identified critical missing CLI features)

## Context to Read First

Read these files to understand the existing patterns:

1. **`packages/cli/src/bin.ts`** — CLI command routing and help text. Look at how `kb task duplicate` and `kb task archive` are implemented to follow the same pattern.
2. **`packages/cli/src/commands/task.ts`** — Task command implementations. Look at `runTaskDuplicate()` and `runTaskArchive()` for function patterns, and `runTaskImportGitHubInteractive()` for readline confirmation prompt patterns.
3. **`packages/cli/src/extension.ts`** — Pi extension tools. Look at `kb_task_duplicate` tool registration for the pattern to follow.
4. **`packages/cli/src/commands/task.test.ts`** — Existing test patterns for task commands.
5. **`packages/core/src/store.ts`** — Confirm `deleteTask(id)` method exists and understand its behavior (removes task directory recursively, emits `task:deleted` event).

## File Scope

- `packages/cli/src/bin.ts` — Add `delete` subcommand case, update HELP text
- `packages/cli/src/commands/task.ts` — Implement `runTaskDelete(id, force)` function
- `packages/cli/src/extension.ts` — Add `kb_task_delete` tool registration
- `packages/cli/src/commands/task.test.ts` — Add unit tests for `runTaskDelete`
- `packages/cli/src/__tests__/extension.test.ts` — Add `kb_task_delete` to registration test

## Steps

### Step 1: Implement runTaskDelete() in task.ts

- [ ] Add `runTaskDelete(id: string, force?: boolean)` function in `packages/cli/src/commands/task.ts`
- [ ] Check if task exists first (call `store.getTask(id)` to verify, or handle deleteTask error)
- [ ] If not `force`, prompt user with `Are you sure you want to delete KB-XXX? [y/N]` using `createInterface` from `node:readline/promises`
- [ ] Only proceed on "y" or "yes" response (case-insensitive), exit gracefully on "n" or empty
- [ ] Call `store.deleteTask(id)` to perform deletion
- [ ] Display success message: `✓ Deleted KB-XXX`
- [ ] Handle errors gracefully:
  - Task not found: show `✗ Task KB-XXX not found` and exit code 1
  - Any other errors: show `✗ Failed to delete KB-XXX: {message}` and exit code 1
- [ ] Export the function for use in bin.ts and tests
- [ ] Run targeted tests for changed files

**Artifacts:**
- `packages/cli/src/commands/task.ts` (modified — new function)

### Step 2: Add CLI command routing in bin.ts

- [ ] Import `runTaskDelete` in the dynamic import at the top of `bin.ts`
- [ ] Add `case "delete":` handler in the `task` subcommand switch
- [ ] Parse `--force` flag from args: `const force = args.includes("--force")`
- [ ] Validate that `<id>` argument is provided, show usage if missing
- [ ] Call `await runTaskDelete(id, force)`
- [ ] Update the `HELP` constant to include: `kb task delete <id> [--force]  Delete a task (use --force to skip confirmation)`
- [ ] Run targeted tests for changed files

**Artifacts:**
- `packages/cli/src/bin.ts` (modified — new case, updated HELP)

### Step 3: Add Pi extension tool in extension.ts

- [ ] Register new tool `kb_task_delete` following the `kb_task_duplicate` pattern
- [ ] Parameters: `id` (string, required), `force` (boolean, optional, default false)
- [ ] Description: "Delete a task from the kb board. Requires confirmation unless --force is used."
- [ ] Prompt snippet: "Delete a kb task"
- [ ] Prompt guidelines: 
  - "Use for cleaning up test tasks or tasks created in error"
  - "Tasks are permanently deleted and cannot be recovered"
  - "Use force=true for automation/CI workflows"
- [ ] In execute function: call `store.deleteTask(params.id)`
- [ ] Return success message including deleted task ID
- [ ] Handle errors by throwing with descriptive message
- [ ] Run targeted tests for changed files

**Artifacts:**
- `packages/cli/src/extension.ts` (modified — new tool registration)

### Step 4: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Add unit tests in `packages/cli/src/commands/task.test.ts`:
  - Test `runTaskDelete` deletes task successfully with `force=true`
  - Test confirmation prompt workflow (mock readline)
  - Test `--force` flag skips confirmation
  - Test error handling for non-existent task
  - Test graceful exit on "n" response to prompt
- [ ] Update extension registration test in `packages/cli/src/__tests__/extension.test.ts` to include `kb_task_delete` in expected tools list
- [ ] Run full test suite: `pnpm test`
- [ ] Fix all failures
- [ ] Build passes: `pnpm build`

### Step 5: Documentation & Delivery

- [ ] Create changeset file for the new feature (minor bump for new CLI command):
  ```bash
  cat > .changeset/add-task-delete-command.md << 'EOF'
  ---
  "@dustinbyrne/kb": minor
  ---

  Add `kb task delete <id>` CLI command with confirmation prompt and `--force` flag.
  EOF
  ```
- [ ] Update any relevant CLI documentation if it exists
- [ ] Out-of-scope findings: Create follow-up tasks if any issues discovered during testing

## Documentation Requirements

**Must Update:**
- `packages/cli/src/bin.ts` — Update HELP text to include `kb task delete` command

**Check If Affected:**
- `AGENTS.md` — Update if there's a CLI command reference section

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] `kb task delete KB-001` prompts for confirmation and deletes on "y"
- [ ] `kb task delete KB-001 --force` deletes without prompt
- [ ] `kb task delete KB-999` (non-existent) shows error and exits 1
- [ ] Pi extension tool `kb_task_delete` works via chat agent
- [ ] `pnpm build` passes
- [ ] Changeset file included

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-198): complete Step N — description`
- Example: `feat(KB-198): complete Step 1 — implement runTaskDelete function`
- Example: `feat(KB-198): complete Step 2 — add CLI command routing`
- Example: `feat(KB-198): complete Step 3 — add Pi extension tool`
- Example: `test(KB-198): complete Step 4 — add unit tests`
- Final: `feat(KB-198): add task delete CLI command with --force flag`

## Do NOT

- Delete tasks without confirmation (unless --force is provided)
- Allow deletion of tasks that other tasks depend on (the store handles this, just propagate the error)
- Skip writing tests for the new command
- Modify unrelated CLI commands
- Export `runTaskDelete` from any other module except for test imports
