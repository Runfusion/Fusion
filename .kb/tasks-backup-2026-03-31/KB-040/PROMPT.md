# Task: KB-040 - Add Toggle to Break Tasks into Subtasks During Creation

**Created:** 2026-03-30
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** This feature touches multiple packages (core types, dashboard UI/API, engine triage) and requires coordinated changes across the stack. The changes are localized but need to be consistent.
**Score:** 5/8 — Blast radius: 2, Pattern novelty: 1, Security: 1, Reversibility: 1

## Mission

Add a toggle option on the dashboard during new task creation that allows users to request the AI triage agent to break the task into subtasks. When enabled, the triage agent will analyze the task and, if appropriate, create child tasks instead of a single large specification. This helps users who have large, complex work items that would benefit from being split into smaller, more manageable pieces.

## Dependencies

- **None**

## Context to Read First

1. `packages/core/src/types.ts` — Task types and TaskCreateInput interface
2. `packages/dashboard/app/components/InlineCreateCard.tsx` — Task creation UI component
3. `packages/dashboard/app/api.ts` — Frontend API client for task creation
4. `packages/dashboard/src/routes.ts` — Backend API route for task creation
5. `packages/engine/src/triage.ts` — Triage agent and specification prompt
6. `packages/core/src/store.ts` — TaskStore.createTask method
7. `packages/dashboard/app/components/__tests__/InlineCreateCard.test.tsx` — Existing tests for reference

## File Scope

- `packages/core/src/types.ts` — Add `breakIntoSubtasks` to TaskCreateInput
- `packages/core/src/store.ts` — Store the flag on task (optional for tracking)
- `packages/dashboard/app/components/InlineCreateCard.tsx` — Add toggle UI
- `packages/dashboard/app/api.ts` — Update createTask API signature
- `packages/dashboard/src/routes.ts` — Accept and pass the new field
- `packages/engine/src/triage.ts` — Update system prompt and buildSpecificationPrompt
- `packages/dashboard/app/components/__tests__/InlineCreateCard.test.tsx` — Add tests for toggle

## Steps

### Step 1: Update Core Types and Store

- [ ] Add optional `breakIntoSubtasks?: boolean` field to `TaskCreateInput` interface in `packages/core/src/types.ts`
- [ ] Add optional `breakIntoSubtasks?: boolean` field to `Task` interface to persist the flag
- [ ] Update `TaskStore.createTask()` in `packages/core/src/store.ts` to accept and store the flag
- [ ] Run core package tests: `pnpm --filter @kb/core test`

**Artifacts:**
- `packages/core/src/types.ts` (modified)
- `packages/core/src/store.ts` (modified)

### Step 2: Update Dashboard Backend API

- [ ] Update POST `/api/tasks` route in `packages/dashboard/src/routes.ts` to accept `breakIntoSubtasks` from request body
- [ ] Pass the flag to `store.createTask()`
- [ ] Add test for the new parameter in `packages/dashboard/src/routes.test.ts` (create if doesn't exist, or add to existing)
- [ ] Run dashboard server tests: `pnpm --filter @kb/dashboard test`

**Artifacts:**
- `packages/dashboard/src/routes.ts` (modified)
- `packages/dashboard/src/routes.test.ts` (modified or created)

### Step 3: Add Toggle to InlineCreateCard UI

- [ ] Add state for `breakIntoSubtasks` toggle in `InlineCreateCard` component
- [ ] Add checkbox/toggle UI element in the footer area (near the Deps button)
- [ ] Update `handleKeyDown` submit handler to include the flag in the submit payload
- [ ] Style the toggle to match existing UI patterns (use existing CSS classes where possible)
- [ ] Ensure the toggle is only visible/active when not submitting

**Artifacts:**
- `packages/dashboard/app/components/InlineCreateCard.tsx` (modified)

### Step 4: Update Frontend API Client

- [ ] Update `createTask` function in `packages/dashboard/app/api.ts` to accept and pass `breakIntoSubtasks` parameter
- [ ] Ensure the parameter flows through to the fetch call

**Artifacts:**
- `packages/dashboard/app/api.ts` (modified)

### Step 5: Update Triage Agent to Handle Subtask Breakdown

- [ ] Update `TRIAGE_SYSTEM_PROMPT` in `packages/engine/src/triage.ts` to include instructions about breaking tasks into subtasks
- [ ] Add guidance: when the task has `breakIntoSubtasks` flag, the agent should analyze if the task is complex enough to warrant splitting, and if so, use the `task_create` tool to create child tasks instead of writing a single PROMPT.md
- [ ] Update `buildSpecificationPrompt()` to include the subtask request flag in the prompt when enabled
- [ ] Ensure the agent knows to set up proper dependencies between child tasks

**Artifacts:**
- `packages/engine/src/triage.ts` (modified)

### Step 6: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full test suite: `pnpm test`
- [ ] Fix all failures
- [ ] Build passes: `pnpm build`
- [ ] Add specific tests in `InlineCreateCard.test.tsx`:
  - Test that toggle appears and can be clicked
  - Test that toggle state is passed to onSubmit
  - Test that toggle defaults to false/off

**Artifacts:**
- `packages/dashboard/app/components/__tests__/InlineCreateCard.test.tsx` (modified)

### Step 7: Documentation & Delivery

- [ ] Update dashboard README or UI help text if there's documentation about task creation
- [ ] Create changeset file for the feature (minor bump for @dustinbyrne/kb)
- [ ] Verify the toggle appears correctly in the UI and the flag flows through the entire system
- [ ] Out-of-scope findings: If the triage agent needs better tools for creating subtasks, create a follow-up task

**Artifacts:**
- `.changeset/add-subtask-toggle.md` (new)

## Documentation Requirements

**Must Update:**
- None (UI is self-documenting via toggle label)

**Check If Affected:**
- `packages/dashboard/README.md` — Add note about subtask creation feature if it exists

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing (`pnpm test`)
- [ ] Build passes (`pnpm build`)
- [ ] Toggle appears in task creation UI
- [ ] Toggle state flows through API to task creation
- [ ] Triage agent receives and respects the flag
- [ ] Changeset created for the feature

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-040): complete Step N — description`
- **Bug fixes:** `fix(KB-040): description`
- **Tests:** `test(KB-040): description`

Example commits:
- `feat(KB-040): complete Step 1 — add breakIntoSubtasks to core types`
- `feat(KB-040): complete Step 3 — add toggle UI to InlineCreateCard`
- `test(KB-040): add tests for subtask toggle`

## Do NOT

- Expand scope to auto-detect when tasks should be broken down (user must explicitly request)
- Change the default behavior (toggle defaults to off)
- Modify the task card display to show subtask relationships (out of scope)
- Add a separate "planning mode" UI (KB-032 covers this)
- Skip tests for the new functionality
- Modify files outside the File Scope without good reason
- Commit without the task ID prefix
