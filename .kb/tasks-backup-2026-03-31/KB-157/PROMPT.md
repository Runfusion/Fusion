# Task: KB-157 - Handle Transient Connection Failures Without Marking Tasks Failed

**Created:** 2026-03-30
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** This change affects core task execution error handling and requires careful classification of transient vs permanent failures. The fix involves creating a new error classification pattern and modifying the executor's catch block logic.
**Score:** 5/8 — Blast radius: 1, Pattern novelty: 1, Security: 1, Reversibility: 2

## Mission

Implement smarter error handling for transient network failures during AI agent execution. When the pi-coding-agent encounters connection errors like "upstream connect error or disconnect/reset before headers" that mention retries were attempted, the task should be moved back to "todo" for later retry rather than being marked as "failed". This prevents tasks from being incorrectly marked as failed due to temporary infrastructure issues that resolve quickly.

## Dependencies

- **None**

## Context to Read First

- `packages/engine/src/executor.ts` — Main task execution logic, specifically the `execute()` method's catch block error handling (lines ~350-420)
- `packages/engine/src/usage-limit-detector.ts` — Existing error classification patterns that distinguish usage limits from other errors
- `packages/engine/src/pi.ts` — Agent session creation showing retry configuration (`maxRetries: 3`)
- `packages/core/src/types.ts` — Task type definitions including `status` and `error` fields

## File Scope

- `packages/engine/src/transient-error-detector.ts` (new)
- `packages/engine/src/transient-error-detector.test.ts` (new)
- `packages/engine/src/executor.ts` — Modify catch block to use transient error detection
- `packages/engine/src/index.ts` — Export new detector module

## Steps

### Step 1: Create Transient Error Detector Module

Create a new error classification module following the pattern of `usage-limit-detector.ts`.

- [ ] Create `packages/engine/src/transient-error-detector.ts` with:
  - `TRANSIENT_ERROR_PATTERNS` array of RegExp patterns matching:
    - `upstream connect error`
    - `disconnect/reset before headers`
    - `retried and the latest reset reason`
    - `remote connection failure`
    - `transport failure reason`
    - `delayed connect error`
    - `Connection refused`
    - `connection reset`
    - `timeout` (with connection context)
    - `ECONNREFUSED`
    - `ETIMEDOUT`
    - `socket hang up`
  - `isTransientError(errorMessage: string): boolean` function that tests all patterns case-insensitively
  - `classifyError(errorMessage: string): 'transient' | 'usage-limit' | 'permanent'` that can delegate to `isUsageLimitError` for usage limits, then `isTransientError`, defaulting to 'permanent'
- [ ] Add comprehensive JSDoc comments explaining when transient errors occur (network blips, proxy hiccups, temporary service unavailability)
- [ ] Run `pnpm test` in the engine package to ensure no regressions

**Artifacts:**
- `packages/engine/src/transient-error-detector.ts` (new)

### Step 2: Add Unit Tests for Transient Error Detector

- [ ] Create `packages/engine/src/transient-error-detector.test.ts` with tests for:
  - Each pattern matching expected error messages
  - The full "upstream connect error or disconnect/reset before headers. retried and the latest reset reason: remote connection failure, transport failure reason: delayed connect error: Connection refused" message
  - Case insensitivity verification
  - Edge cases: empty strings, null/undefined handling, partial matches
  - Classification function returning correct categories
- [ ] Ensure all tests pass with `pnpm test`

**Artifacts:**
- `packages/engine/src/transient-error-detector.test.ts` (new)

### Step 3: Modify Executor Error Handling

Modify the catch block in `packages/engine/src/executor.ts` to handle transient errors differently.

- [ ] Import `isTransientError` from the new module
- [ ] In the catch block of `execute()` method (around line 350+), add a new conditional branch:
  - After the `pausedAborted` check and `Invalid transition` check
  - Before the final `else` that marks as failed
  - Add: `else if (isTransientError(err.message))` that:
    - Logs the transient error with context: "Transient connection error detected — task will retry later"
    - Calls `await this.store.logEntry(task.id, \`Transient error: \${err.message}\`)`
    - Moves task to "todo" instead of marking failed: `await this.store.moveTask(task.id, "todo")`
    - Does NOT call `this.options.onError?.(task, err)` (since this isn't a true failure)
- [ ] Ensure the error message is truncated if longer than 500 chars before storing
- [ ] Run targeted tests for executor.test.ts to verify changes

**Artifacts:**
- `packages/engine/src/executor.ts` (modified)

### Step 4: Export New Module and Verify Integration

- [ ] Add export for `isTransientError`, `classifyError`, and `TRANSIENT_ERROR_PATTERNS` to `packages/engine/src/index.ts`
- [ ] Run full engine package build: `pnpm build` in `packages/engine`
- [ ] Run full engine package tests: `pnpm test` in `packages/engine`

**Artifacts:**
- `packages/engine/src/index.ts` (modified)

### Step 5: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full test suite: `pnpm test` from workspace root
- [ ] Run full build: `pnpm build` from workspace root
- [ ] Run typecheck: `pnpm typecheck` from workspace root
- [ ] Fix all failures

### Step 6: Documentation & Delivery

- [ ] Update `AGENTS.md` error handling section to document transient error behavior
- [ ] Create changeset file for the engine package changes
- [ ] Out-of-scope findings: None expected for this task

## Documentation Requirements

**Must Update:**
- `AGENTS.md` — Add section under error handling explaining:
  - Transient connection errors (upstream connect, disconnect/reset, connection refused) move tasks back to "todo" for retry
  - Contrast with usage limit errors (trigger global pause) and permanent failures (mark task failed)

**Check If Affected:**
- `packages/engine/README.md` — Update if there's an error handling section

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing (`pnpm test` passes)
- [ ] Build passes (`pnpm build` passes)
- [ ] Typecheck passes (`pnpm typecheck` passes)
- [ ] Transient errors move tasks to "todo" instead of marking as "failed"
- [ ] Task errors are properly logged for debugging
- [ ] Documentation updated

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-157): complete Step N — description`
- **Bug fixes:** `fix(KB-157): description`
- **Tests:** `test(KB-157): description`

## Do NOT

- Mark tasks as failed for transient connection errors
- Trigger global pause for transient errors (unlike usage limit errors)
- Retry immediately within the executor (let the scheduler handle retry timing)
- Change the pi-coding-agent retry configuration (we handle this at kb layer)
- Modify the `usage-limit-detector.ts` to handle transient errors (keep concerns separate)
- Lose the original error message when logging (preserve full context)
