# Task: KB-178 - Proactive Subtask Breakdown for Medium and Large Tasks

**Created:** 2026-03-30
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** This change affects the triage agent's system prompt and specification generation logic, requiring careful testing to ensure the AI correctly suggests subtasks for M/L sized tasks without being overly aggressive.
**Score:** 5/8 — Blast radius: 1, Pattern novelty: 1, Security: 1, Reversibility: 2

## Mission

Enhance the triage agent's system prompt and specification generation to proactively suggest breaking down medium (M) and large (L) sized tasks into subtasks. Currently, subtask breakdown only occurs when the user explicitly checks "Break into subtasks" during task creation. This change will make the AI automatically consider and suggest subtask decomposition for appropriately-sized tasks, improving work granularity and parallelization without requiring explicit user opt-in.

## Dependencies

- **None**

## Context to Read First

- `packages/engine/src/triage.ts` — Core triage logic, system prompt, and `buildSpecificationPrompt` function
- `packages/engine/src/triage.test.ts` — Existing test patterns for triage functionality
- `packages/core/src/types.ts` — Task type definitions including `breakIntoSubtasks` field
- `packages/dashboard/app/components/InlineCreateCard.tsx` — UI for task creation showing the current manual subtask toggle

## File Scope

- `packages/engine/src/triage.ts` — Modify system prompt and `buildSpecificationPrompt` function
- `packages/engine/src/triage.test.ts` — Add tests for new proactive subtask breakdown behavior

## Steps

### Step 1: Update TRIAGE_SYSTEM_PROMPT

Modify the system prompt to include proactive subtask breakdown guidance for M/L tasks.

- [ ] Add new section `## Proactive Subtask Breakdown for M/L Tasks` after the existing `## Triage subtask breakdown` section
- [ ] Document that for tasks assessed as Size M or L, the AI should proactively consider whether subtask breakdown would be beneficial
- [ ] Clarify that even without `breakIntoSubtasks: true`, the AI should suggest splitting when it would improve work organization
- [ ] Keep the existing `breakIntoSubtasks` behavior intact — explicit user request still takes precedence
- [ ] Add guidance that S tasks should generally NOT be split (too small)

**Artifacts:**
- `packages/engine/src/triage.ts` (modified)

### Step 2: Update buildSpecificationPrompt Function

Enhance the specification prompt generation to encourage subtask consideration for M/L tasks.

- [ ] Modify `buildSpecificationPrompt` to always include a "Subtask Consideration" section for tasks without explicit `breakIntoSubtasks` flag
- [ ] For tasks where size is not yet determined (during triage), add instructions for the AI to assess size and consider subtasks if M/L
- [ ] Keep the existing explicit `breakIntoSubtasks` section unchanged — it should still trigger the mandatory breakdown flow
- [ ] Ensure the new section explains that subtask creation is OPTIONAL for M/L tasks unless explicitly requested

**Artifacts:**
- `packages/engine/src/triage.ts` (modified)

### Step 3: Add Tests for Proactive Subtask Behavior

Add comprehensive tests for the new subtask breakdown prompting behavior.

- [ ] Add test verifying that the specification prompt includes subtask guidance for tasks without explicit `breakIntoSubtasks` flag
- [ ] Add test verifying that explicit `breakIntoSubtasks: true` still produces the mandatory breakdown section
- [ ] Add test verifying that the system prompt contains the new proactive subtask breakdown section
- [ ] Test that both modes (proactive suggestion vs. mandatory breakdown) are distinguishable in generated prompts

**Artifacts:**
- `packages/engine/src/triage.test.ts` (modified)

### Step 4: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm test` to ensure all triage tests pass
- [ ] Run `pnpm build` to verify no TypeScript errors
- [ ] Verify the changes don't break existing `breakIntoSubtasks` functionality
- [ ] Check that new test cases cover both explicit and proactive subtask breakdown scenarios

### Step 5: Documentation & Delivery

- [ ] Update `AGENTS.md` if it documents triage behavior (add note about automatic subtask suggestions for M/L tasks)
- [ ] Create changeset file for the minor version bump (new feature: proactive subtask suggestions)
- [ ] Out-of-scope findings created as new tasks via `task_create` tool

## Documentation Requirements

**Must Update:**
- `.changeset/proactive-subtask-breakdown.md` — Changeset describing the new feature

**Check If Affected:**
- `AGENTS.md` — Check if triage behavior is documented; add note about automatic M/L subtask suggestions if present

## Completion Criteria

- [ ] TRIAGE_SYSTEM_PROMPT includes proactive subtask breakdown guidance for M/L tasks
- [ ] `buildSpecificationPrompt` generates appropriate subtask guidance for all task sizes
- [ ] Explicit `breakIntoSubtasks: true` still triggers mandatory subtask creation flow
- [ ] All triage tests pass including new tests for proactive breakdown
- [ ] Build passes without errors
- [ ] Changeset file created

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-178): complete Step N — description`
- **Bug fixes:** `fix(KB-178): description`
- **Tests:** `test(KB-178): description`

## Do NOT

- Remove or modify the existing explicit `breakIntoSubtasks` behavior
- Make subtask breakdown mandatory for all M/L tasks (it should be a suggestion, not required)
- Skip tests for the new proactive breakdown behavior
- Modify dashboard UI or task creation flow (out of scope)
- Change how subtasks are created or tracked (out of scope)
