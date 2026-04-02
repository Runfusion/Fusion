# Task: KB-187 - Add Context to Refinement Task Prompts

**Created:** 2026-03-30
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** Focused change to a single method (`refineTask`) in the TaskStore. Low blast radius—only affects how refinement PROMPT.md files are generated. No security implications. Fully reversible by regenerating prompts.

**Score:** 3/8 — Blast radius: 1, Pattern novelty: 0, Security: 0, Reversibility: 2

## Mission

When a refinement task is created from a completed (or in-review) task, the agent executing the refinement currently lacks sufficient context. The PROMPT.md only contains the user's feedback and a reference to the original task ID. The agent needs to understand:
1. What the original task was trying to accomplish
2. What was actually completed (from task log outcomes)
3. Where to find the original task files for reference

Update the `refineTask` method in `TaskStore` to generate a richer PROMPT.md that includes a summary of the original task's purpose, key outcomes from its execution log, and a file path reference to the original task.

## Dependencies

- **None**

## Context to Read First

- `packages/core/src/store.ts` — The `refineTask` method (around line 281) and how PROMPT.md is currently generated for refinements
- `packages/core/src/store.test.ts` — Existing refinement tests (around line 1723) to understand current behavior and test patterns
- `packages/core/src/types.ts` — `Task`, `TaskDetail`, `TaskLogEntry` types to understand available data

## File Scope

- `packages/core/src/store.ts` — Modify `refineTask` method to enhance PROMPT.md generation
- `packages/core/src/store.test.ts` — Update or add tests for the enhanced refinement prompt

## Steps

### Step 1: Enhance Refinement PROMPT.md Generation

- [ ] Modify the `refineTask` method in `packages/core/src/store.ts` to build a richer prompt that includes:
  - **Original Task Context** section with:
    - Original task title and description
    - Path to original task directory (`.fusion/tasks/{original-id}/`)
    - Path to original PROMPT.md (`.fusion/tasks/{original-id}/PROMPT.md`)
  - **Completed Work Summary** section that extracts key outcomes from the source task's `log` array (entries with `outcome` field)
  - **Refinement Request** section with the user's feedback (preserving current behavior)
  - **Refines** reference to the original task ID (preserving current behavior)
- [ ] Ensure the prompt format is clean markdown with clear section headers
- [ ] Keep the existing file copying behavior for attachments intact

**Artifacts:**
- `packages/core/src/store.ts` (modified)

### Step 2: Update Tests

- [ ] Update the existing test "creates PROMPT.md for the refinement" to verify the new enhanced prompt content
- [ ] Add a new test that verifies log outcomes are included when the source task has log entries with outcomes
- [ ] Add a new test that verifies the original task description is included in the prompt
- [ ] Ensure all refinement-related tests continue to pass

**Artifacts:**
- `packages/core/src/store.test.ts` (modified)

### Step 3: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm test` in the `packages/core` directory
- [ ] Verify all refinement-related tests pass
- [ ] Verify no other tests are broken
- [ ] Run `pnpm build` to ensure no TypeScript errors

### Step 4: Documentation & Delivery

- [ ] No documentation updates required (internal implementation change)
- [ ] Out-of-scope findings: None anticipated

## Documentation Requirements

**Must Update:**
- None (internal implementation change)

**Check If Affected:**
- None

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Refinement tasks now include in their PROMPT.md:
  - Original task description and title
  - File paths to original task
  - Summary of completed work from log outcomes
  - User's refinement feedback

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-187): complete Step N — description`
- **Bug fixes:** `fix(KB-187): description`
- **Tests:** `test(KB-187): description`

## Do NOT

- Change the refinement task creation flow or dependencies behavior
- Modify how attachments are copied
- Change the task title format for refinements
- Alter the API signature of `refineTask`
- Include agent.log content (can be very large, not needed for context)
- Include full step-by-step execution details (too verbose, outcomes are sufficient)
