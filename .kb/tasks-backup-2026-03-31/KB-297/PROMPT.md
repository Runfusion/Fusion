# Task: KB-297 - Auto-create refinement task when steering comment added to done task

**Created:** 2026-03-31
**Size:** S

## Review Level: 2 (Plan and Code)

**Assessment:** Small blast radius affecting only the `addSteeringComment` method; leverages existing `refineTask` pattern with clear implementation path.
**Score:** 4/8 — Blast radius: 1, Pattern novelty: 1, Security: 1, Reversibility: 1

## Mission

When a user adds a steering comment to a task that is already in the "done" column, automatically create a refinement task with the steering comment text as the feedback. This enables a natural workflow where users can provide post-completion feedback that immediately spawns a follow-up refinement task.

Currently, steering comments on done tasks are just recorded but require manual action to create a refinement. This change automates that step, improving the feedback-to-action loop.

## Dependencies

- **None**

## Context to Read First

- `packages/core/src/store.ts` — Read `addSteeringComment` method (around line 1580) and `refineTask` method (around line 390) to understand current implementation
- `packages/core/src/store.test.ts` — Read existing steering comment tests (around line 1021) and refineTask tests (around line 1888) for test patterns

## File Scope

- `packages/core/src/store.ts` — Modify `addSteeringComment` method
- `packages/core/src/store.test.ts` — Add tests for new auto-refinement behavior

## Steps

### Step 1: Implement Auto-Refinement in addSteeringComment

- [ ] Modify `addSteeringComment` method in `packages/core/src/store.ts` to check if task is in "done" column
- [ ] If task.column === "done", automatically call `this.refineTask(id, text)` after adding the comment
- [ ] The refinement task should be created with the steering comment text as the feedback
- [ ] Ensure the steering comment is still added to the original task (preserve existing behavior)
- [ ] Handle any errors from refineTask gracefully (log but don't fail the steering comment addition)

**Artifacts:**
- `packages/core/src/store.ts` (modified)

### Step 2: Add Unit Tests

- [ ] Add test: "creates refinement task when steering comment added to done task"
- [ ] Add test: "does not create refinement when steering comment added to non-done task (triage)"
- [ ] Add test: "does not create refinement when steering comment added to non-done task (in-progress)"
- [ ] Add test: "does not create refinement when steering comment added to non-done task (in-review)"
- [ ] Add test: "steering comment is still added to original task even when refinement is created"
- [ ] Add test: "refinement task has correct dependency on original done task"
- [ ] Verify all existing tests still pass

**Artifacts:**
- `packages/core/src/store.test.ts` (modified)

### Step 3: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm test` — all tests must pass
- [ ] Run `pnpm build` — build must succeed with no errors

### Step 4: Documentation & Delivery

- [ ] Verify no documentation updates needed (behavior is intuitive and matches user expectation)
- [ ] Create changeset file for the minor version bump (new feature)

## Documentation Requirements

**Must Update:**
- None — this is an intuitive behavioral improvement that matches user expectations

**Check If Affected:**
- None

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Changeset file created

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-297): complete Step N — description`
- **Bug fixes:** `fix(KB-297): description`
- **Tests:** `test(KB-297): description`

## Do NOT

- Change the signature of `addSteeringComment` (maintain backward compatibility)
- Skip tests for the new auto-refinement behavior
- Modify the `refineTask` method itself (use it as-is)
- Add UI changes (this is backend-only behavior)
- Create circular dependencies or modify dependency logic
