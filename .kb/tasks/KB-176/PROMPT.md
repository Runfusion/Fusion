# Task: KB-176 - Add Completion Summary Section to Task Definition Tab

**Created:** 2026-03-30
**Size:** M

## Review Level: 1 (Plan Only)

**Assessment:** This is a UI enhancement with a new data field. The change is localized to the dashboard components and executor system prompt. No complex logic or security implications.
**Score:** 3/8 — Blast radius: 1, Pattern novelty: 1, Security: 0, Reversibility: 1

## Mission

Add a new "Summary" section at the top of the Definition tab that displays what was changed/fixed when a task is in the "done" column. This gives users a quick overview of the work completed without reading the full PROMPT.md or activity log.

The implementation requires:
1. Adding a `summary` field to the Task type to store completion summaries
2. Displaying the summary in the Definition tab for done tasks
3. Updating the executor system prompt to instruct the AI to generate a summary when completing tasks

## Dependencies

- **None**

## Context to Read First

- `packages/core/src/types.ts` — Task interface definition
- `packages/core/src/store.ts` — TaskStore updateTask method signature
- `packages/dashboard/app/components/TaskDetailModal.tsx` — Definition tab rendering
- `packages/dashboard/app/styles.css` — Dashboard styling patterns
- `packages/engine/src/executor.ts` — System prompt and task_done tool

## File Scope

- `packages/core/src/types.ts` — Add `summary?: string` to Task interface
- `packages/core/src/store.ts` — Add `summary` to updateTask parameters
- `packages/dashboard/app/components/TaskDetailModal.tsx` — Add Summary section UI
- `packages/dashboard/app/api.ts` — Add `summary` to updateTask type (if needed)
- `packages/dashboard/app/styles.css` — Add styling for summary section
- `packages/engine/src/executor.ts` — Update system prompt and task_done tool
- `packages/engine/src/executor.test.ts` — Add/update tests for summary functionality

## Steps

### Step 1: Add Summary Field to Task Type and Store

- [ ] Add `summary?: string` field to the `Task` interface in `packages/core/src/types.ts`
- [ ] Add `summary?: string | null` parameter to `updateTask()` method in `packages/core/src/store.ts`
- [ ] Handle null/undefined summary in updateTask (set to undefined when null)
- [ ] Verify TypeScript compiles without errors

**Artifacts:**
- `packages/core/src/types.ts` (modified)
- `packages/core/src/store.ts` (modified)

### Step 2: Add Summary Section to Definition Tab

- [ ] In `TaskDetailModal.tsx`, add a new summary section at the top of the Definition tab content (before the markdown prompt)
- [ ] Only render the summary section when `task.column === "done"` AND `task.summary` exists
- [ ] Use a styled container with class `detail-summary` for the section
- [ ] Display the summary with proper markdown rendering (use ReactMarkdown with remarkGfm)
- [ ] Add a heading "Summary" above the content

**Artifacts:**
- `packages/dashboard/app/components/TaskDetailModal.tsx` (modified)

### Step 3: Add CSS Styling for Summary Section

- [ ] Add `.detail-summary` class to `packages/dashboard/app/styles.css`
- [ ] Style should match existing detail sections (similar to `.detail-section`)
- [ ] Add visual distinction for done tasks (subtle success-colored border or background)
- [ ] Ensure proper padding, margins, and typography

**Artifacts:**
- `packages/dashboard/app/styles.css` (modified)

### Step 4: Update Executor System Prompt and task_done Tool

- [ ] Update the `EXECUTOR_SYSTEM_PROMPT` in `packages/engine/src/executor.ts` to include instructions for generating a summary
- [ ] Add instructions at the end of the prompt (in the "Completion" section) to generate a brief summary when calling `task_done()`
- [ ] Update the `createTaskDoneTool()` method to accept an optional `summary` parameter
- [ ] The summary parameter schema should be: `summary?: string` with description "Optional summary of what was changed/fixed and what was verified"
- [ ] When `task_done` is called with a summary, save it to the task via `store.updateTask(taskId, { summary: params.summary })`
- [ ] Update the tool return message to confirm when a summary was saved

**Artifacts:**
- `packages/engine/src/executor.ts` (modified)

### Step 5: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Add test in `executor.test.ts` to verify `task_done` accepts and saves summary parameter
- [ ] Verify existing executor tests still pass
- [ ] Run `pnpm test` in packages/dashboard to verify TaskDetailModal tests pass
- [ ] Build passes: `pnpm build`
- [ ] TypeScript type checking passes

### Step 6: Documentation & Delivery

- [ ] Create changeset file: `.changeset/add-completion-summary.md`
- [ ] Test manually by viewing a done task (if any exist) or creating a test scenario
- [ ] Out-of-scope findings created as new tasks via `task_create` tool

## Documentation Requirements

**Must Update:**
- No external documentation updates required (internal feature)

**Check If Affected:**
- `AGENTS.md` — Check if task completion guidelines need updating

## Completion Criteria

- [ ] Summary field exists in Task type and can be persisted to task.json
- [ ] Definition tab displays summary section at top for done tasks with summary data
- [ ] Executor system prompt instructs AI to generate completion summaries
- [ ] `task_done()` tool accepts optional summary parameter and saves it
- [ ] All tests passing
- [ ] Build passes
- [ ] Changeset created

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-176): complete Step N — description`
- **Bug fixes:** `fix(KB-176): description`
- **Tests:** `test(KB-176): description`

## Do NOT

- Expand task scope beyond the Definition tab summary section
- Modify other tabs (Activity, Agent Log, etc.)
- Skip tests or type checking
- Break backward compatibility with existing task.json files
- Add summary editing UI (read-only display only)
