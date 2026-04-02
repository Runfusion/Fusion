# Task: KB-323 - Verify Steering Comments Injection

**Created:** 2026-03-31
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** This is an investigation task to verify an existing feature works end-to-end. The blast radius is limited to tracing data flow and adding verification tests.
**Score:** 2/8 — Blast radius: 0, Pattern novelty: 0, Security: 0, Reversibility: 2

## Mission

Investigate and verify that steering comments are actually being injected into the AI execution context. The steering comments feature was implemented in KB-003, allowing users to add guidance comments from the dashboard that should appear in the executor agent's prompt. This task confirms the feature works end-to-end: from dashboard submission through API, storage, and finally injection into the execution prompt.

## Dependencies

- **None**

## Context to Read First

- `packages/core/src/store.ts` — `addSteeringComment()` method for persistence
- `packages/core/src/types.ts` — `SteeringComment` type definition
- `packages/dashboard/src/routes.ts` — POST `/tasks/:id/steer` endpoint
- `packages/dashboard/app/components/SteeringTab.tsx` — UI for adding comments
- `packages/engine/src/executor.ts` — `buildExecutionPrompt()` where injection happens
- `packages/engine/src/executor.test.ts` — Existing tests for steering comments
- `.fusion/tasks/KB-003/PROMPT.md` — Original steering feature specification

## File Scope

- `packages/engine/src/executor.test.ts` — Add integration-level verification test
- `.fusion/tasks/KB-323/task.json` — Update log with findings

## Steps

### Step 1: Trace the Data Flow

- [ ] Read `addSteeringComment()` in `packages/core/src/store.ts` — verify it:
  - Creates comment with correct structure (id, text, createdAt, author)
  - Appends to `task.steeringComments` array
  - Persists to task.json via `writeTaskJson()`
  - Emits `task:updated` event
- [ ] Verify API endpoint in `packages/dashboard/src/routes.ts`:
  - Route `POST /tasks/:id/steer` exists and calls `store.addSteeringComment()`
  - Returns updated task with steeringComments array
- [ ] Verify dashboard UI in `packages/dashboard/app/components/SteeringTab.tsx`:
  - Calls `addSteeringComment()` API function
  - Updates local state with returned comments
- [ ] Verify `buildExecutionPrompt()` in `packages/engine/src/executor.ts`:
  - Checks `task.steeringComments?.length > 0`
  - Takes last 10 comments via `.slice(-10)`
  - Formats section with header, author, timestamp, and quoted text
  - Includes explanatory header about user feedback

### Step 2: Verify Test Coverage

- [ ] Run existing steering comment tests: `pnpm test --filter @kb/engine -- --testNamePattern="steering"`
- [ ] All tests should pass:
  - "includes Steering Comments section when steeringComments has entries"
  - "formats multiple steering comments correctly"
  - "omits Steering Comments section when steeringComments is empty"
  - "omits Steering Comments section when steeringComments is undefined"
  - "includes only the 10 most recent steering comments"
- [ ] If any tests fail, document the failure and fix if trivial

### Step 3: Add End-to-End Verification Test

- [ ] Add test in `packages/engine/src/executor.test.ts` that verifies:
  - A task with steering comments has those comments appear in the built prompt
  - The prompt includes the explanatory header text
  - The format matches expected output (author badge, timestamp, quoted text)
- [ ] Run the new test and verify it passes

### Step 4: Manual Verification (Optional but Recommended)

- [ ] Check if there's a test task with steering comments in `.fusion/tasks/`
- [ ] If none exists, the test coverage from Step 2 and 3 is sufficient
- [ ] Document findings: whether steering comments flow correctly through the system

### Step 5: Documentation & Delivery

- [ ] Update task.json log with findings:
  - "Steering comments injection verified: [PASS/FAIL]"
  - Brief summary of any issues found (if any)
- [ ] If issues found, create follow-up task(s) via `task_create` tool with specific fixes needed
- [ ] Run full test suite: `pnpm test` — must pass

## Documentation Requirements

**Must Update:**
- `.fusion/tasks/KB-323/task.json` log — document verification results

**Check If Affected:**
- No documentation changes needed if feature works correctly

## Completion Criteria

- [ ] Data flow traced and verified (dashboard → API → store → executor)
- [ ] All existing steering comment tests pass
- [ ] New verification test added and passing
- [ ] Findings documented in task.json log
- [ ] Any issues found are tracked as new tasks

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-323): complete Step N — description`
- **Bug fixes:** `fix(KB-323): description`
- **Tests:** `test(KB-323): description`

## Do NOT

- Modify the steering comments feature implementation (this is verification only)
- Add new UI components or API endpoints
- Skip test verification — this task is about confirming the feature works
- Create issues without specific reproduction steps if problems are found
