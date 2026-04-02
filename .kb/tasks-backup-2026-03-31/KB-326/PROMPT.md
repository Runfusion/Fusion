# Task: KB-326 - Real-Time Steering Comments During Execution

**Created:** 2026-03-31
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** Investigation into whether steering comments are dynamically picked up by running executors. Requires tracing event flow, understanding agent session lifecycle, and potentially implementing a mechanism to inject mid-execution steering. Blast radius is the executor's agent session management.
**Score:** 5/8 — Blast radius: 1, Pattern novelty: 1, Security: 1, Reversibility: 2

## Mission

Investigate and answer the question: "If an executor is already running, will it pick up steering comments?" 

KB-323 verified that steering comments ARE injected at execution start. This task determines whether NEW steering comments added DURING execution are dynamically delivered to the running agent. If not, implement a mechanism to notify the executor of mid-execution steering comments so the AI can adjust its approach in real-time.

## Dependencies

- **Task:** KB-323 (steering comments injection verified — this builds on that foundation)

## Context to Read First

- `packages/engine/src/executor.ts` — Lines 178-210: `task:updated` event listener (currently only handles pause), Lines 486: `buildExecutionPrompt()` call, Lines 1274-1365: `buildExecutionPrompt()` function
- `packages/core/src/store.ts` — Lines 1558-1620: `addSteeringComment()` method and its event emission
- `packages/engine/src/pi.ts` — `createKbAgent()` and session interface to understand if dynamic prompt injection is possible
- `packages/dashboard/app/components/SteeringTab.tsx` — How steering comments are submitted from UI

## File Scope

- `packages/engine/src/executor.ts` — Modify executor to track and handle mid-execution steering comments
- `packages/engine/src/executor.test.ts` — Add test for real-time steering comment pickup
- `packages/core/src/types.ts` — May need new types for steering comment events

## Steps

### Step 1: Verify Current Behavior

- [ ] Trace the execution flow:
  - `buildExecutionPrompt()` is called ONCE at line 486 before `session.prompt()`
  - The prompt includes steering comments snapshot at that moment
  - The agent session runs until completion with this fixed prompt
- [ ] Confirm the `task:updated` listener (lines 198-210) only handles `task.paused`, NOT steering comments
- [ ] Document finding: **Currently, steering comments added during execution are NOT picked up**
- [ ] Check if the agent session supports dynamic message injection (read `pi.ts` session interface)

### Step 2: Design Real-Time Steering Mechanism

- [ ] Determine viable approach based on agent capabilities:
  - **Option A (Preferred):** If session supports, inject a system message with new steering
  - **Option B:** Store pending steering comments, re-inject at next natural breakpoint (step completion)
  - **Option C:** Document limitation and steer only at start (fallback if others infeasible)
- [ ] Design the mechanism:
  - Track which comments have been "seen" by the executor
  - On `task:updated`, detect if new steering comments exist
  - Inject new comments into the running session OR queue for next opportunity
- [ ] Review approach: must be safe (don't corrupt agent state), timely (user sees effect), and reversible

### Step 3: Implement Real-Time Steering

- [ ] Add tracking for "last seen steering comment ID" in the executor's task context
- [ ] Extend `task:updated` listener to detect steering comment changes:
  - Compare `task.steeringComments` length or last comment ID
  - If new comments exist and task is in-progress, trigger injection
- [ ] Implement injection mechanism:
  - If using Option A (direct injection): add method to session interface or use existing tool-call mechanism
  - If using Option B (queued): store pending comments, inject at next step boundary
- [ ] Update `buildExecutionPrompt` or add helper to format steering comments for injection
- [ ] Add log entry when steering comment is injected: "Steering comment received mid-execution: {summary}"

### Step 4: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Add unit test in `packages/engine/src/executor.test.ts`:
  - Mock a running execution
  - Add steering comment mid-execution
  - Verify the comment is either injected or queued
  - Verify log entry is created
- [ ] Add integration-style test if feasible:
  - Start task execution
  - Add steering comment via store method
  - Verify executor detects and handles the comment
- [ ] Run full test suite: `pnpm test` — must pass
- [ ] Run build: `pnpm build` — must pass

### Step 5: Documentation & Delivery

- [ ] Update relevant documentation:
  - Document the real-time steering behavior in code comments
  - If there's user-facing docs about steering, update to clarify mid-execution steering works
- [ ] Create changeset if this affects published package behavior
- [ ] Out-of-scope findings created as new tasks via `task_create` tool

## Documentation Requirements

**Must Update:**
- Code comments in executor explaining the real-time steering mechanism

**Check If Affected:**
- Any README or docs mentioning steering comments behavior
- Dashboard UI tooltips or help text about steering

## Completion Criteria

- [ ] Current behavior verified (steering NOT picked up mid-execution)
- [ ] Real-time steering mechanism designed and approved
- [ ] Implementation complete with proper tracking and injection
- [ ] All tests passing (new tests + existing suite)
- [ ] Build passes
- [ ] Documentation updated

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-326): complete Step N — description`
- **Bug fixes:** `fix(KB-326): description`
- **Tests:** `test(KB-326): description`

## Do NOT

- Break existing steering comment functionality at execution start
- Add complexity that makes the executor harder to reason about
- Implement a mechanism that could corrupt agent session state
- Skip test coverage for the new behavior
- Change the steering comment storage format (it's working)
