# Task: KB-282 - Remove the limit of 1000 characters for description

**Created:** 2026-03-31
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** This is a straightforward constraint removal task with minimal blast radius. Only one validation block needs removal in a single file.
**Score:** 2/8 — Blast radius: 0, Pattern novelty: 0, Security: 1, Reversibility: 1

## Mission

Remove the 1000 character limit enforcement on the `description` field for the subtask breakdown feature. The limit is currently hardcoded in the `/subtasks/start-streaming` endpoint and rejects descriptions longer than 1000 characters with a 400 error. This constraint is unnecessary and prevents users from breaking down complex tasks with detailed descriptions.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/src/routes.ts` — Review lines 4010-4025 to understand the current validation logic for the `/subtasks/start-streaming` endpoint
- `packages/dashboard/src/routes.test.ts` — Check for any tests that may be validating this limit (lines 370-470 cover subtask endpoints)

## File Scope

- `packages/dashboard/src/routes.ts` — Remove the 1000 character limit validation block

## Steps

### Step 1: Remove the Description Length Validation

- [ ] Remove the `if (description.length > 1000)` validation block (lines 4017-4020) from the `/subtasks/start-streaming` endpoint in `packages/dashboard/src/routes.ts`
- [ ] Keep the required field validation (`if (!description || typeof description !== "string")`) intact
- [ ] Run targeted tests for changed files

**Artifacts:**
- `packages/dashboard/src/routes.ts` (modified)

### Step 2: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full test suite: `pnpm test`
- [ ] Fix all failures
- [ ] Build passes: `pnpm build`

### Step 3: Documentation & Delivery

- [ ] Create changeset file for the change (patch level - user-facing improvement)
- [ ] Out-of-scope findings created as new tasks via `task_create` tool

## Documentation Requirements

**Check If Affected:**
- `AGENTS.md` — Check if any skill references mention the 1000 character limit (unlikely, but verify)

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Changeset created

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-282): complete Step N — description`
- **Bug fixes:** `fix(KB-282): description`
- **Tests:** `test(KB-282): description`

## Do NOT

- Expand task scope (the planning endpoint's 500 char limit on `initialPlan` is intentionally separate)
- Skip tests
- Modify files outside the File Scope without good reason
- Commit without the task ID prefix
