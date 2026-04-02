# Task: KB-315 - Add remaining engine module tests

**Created:** 2026-03-31
**Size:** M

## Review Level: 1 (Plan Only)

**Assessment:** This task adds comprehensive test coverage for 4 engine modules. The test patterns are well-established from KB-301, and the changes are isolated to test files with no production code modifications. Tests are fully reversible.
**Score:** 2/8 — Blast radius: 0, Pattern novelty: 0, Security: 0, Reversibility: 2

## Mission

Ensure comprehensive test coverage for 4 critical engine modules: worktree-pool.ts, cron-runner.ts, transient-error-detector.ts, and usage-limit-detector.ts. These tests must match the quality, depth, and pattern standards established by KB-301's scheduler and stuck-task-detector tests. The tests already exist and pass; this task verifies completeness and brings them to the KB-301 standard if any gaps exist.

## Dependencies

- **Task:** KB-301 (test patterns established — reference scheduler.test.ts and stuck-task-detector.test.ts for quality benchmarks)

## Context to Read First

### Reference Test Patterns (KB-301 quality standard)
- `packages/engine/src/scheduler.test.ts` — Reference for comprehensive class testing with mocking
- `packages/engine/src/stuck-task-detector.test.ts` — Reference for timer-based and async testing patterns

### Source Files to Test
- `packages/engine/src/worktree-pool.ts` — Worktree recycling pool management
- `packages/engine/src/cron-runner.ts` — Scheduled task execution engine
- `packages/engine/src/transient-error-detector.ts` — Network error classification
- `packages/engine/src/usage-limit-detector.ts` — API limit detection and pausing

### Existing Test Files
- `packages/engine/src/worktree-pool.test.ts` — Existing tests (verify coverage)
- `packages/engine/src/cron-runner.test.ts` — Existing tests (verify coverage)
- `packages/engine/src/transient-error-detector.test.ts` — Existing tests (verify coverage)
- `packages/engine/src/usage-limit-detector.test.ts` — Existing tests (verify coverage)

### Test Configuration
- `packages/engine/vitest.config.ts` — Vitest configuration
- `packages/engine/package.json` — Test scripts and dependencies

## File Scope

### Test files to verify and potentially enhance:
- `packages/engine/src/worktree-pool.test.ts` (verify/modify)
- `packages/engine/src/cron-runner.test.ts` (verify/modify)
- `packages/engine/src/transient-error-detector.test.ts` (verify/modify)
- `packages/engine/src/usage-limit-detector.test.ts` (verify/modify)

### No changes to:
- Source implementation files (unless tests reveal bugs)
- Any dashboard, core, or CLI packages

## Steps

### Step 1: Audit Existing Test Coverage

Compare each test file against the KB-301 quality standards (scheduler.test.ts, stuck-task-detector.test.ts). Check for:
- Comprehensive function/class coverage
- Edge case handling
- Error path testing
- Proper mocking of dependencies
- Clear test descriptions

- [ ] Review worktree-pool.test.ts coverage gaps against source
- [ ] Review cron-runner.test.ts coverage gaps against source
- [ ] Review transient-error-detector.test.ts coverage gaps
- [ ] Review usage-limit-detector.test.ts coverage gaps
- [ ] Document any missing test scenarios

**Artifacts:**
- Mental inventory of coverage gaps (no file output needed unless gaps found)

### Step 2: Enhance worktree-pool.test.ts (if needed)

Compare against KB-301 patterns. Ensure coverage of:
- WorktreePool class: acquire(), release(), size, has(), drain(), rehydrate(), prepareForTask()
- Utility functions: scanIdleWorktrees(), cleanupOrphanedWorktrees()
- Edge cases: stale entries, missing directories, git command failures
- Error handling: non-fatal failure paths

- [ ] Verify all public methods have tests
- [ ] Verify edge cases (stale entries, missing dirs) are covered
- [ ] Verify git command mocking is proper
- [ ] Add any missing tests to match KB-301 depth
- [ ] Run tests: `cd packages/engine && pnpm test src/worktree-pool.test.ts`

**Artifacts:**
- `packages/engine/src/worktree-pool.test.ts` (modified if gaps found)

### Step 3: Enhance cron-runner.test.ts (if needed)

Ensure comprehensive coverage of:
- CronRunner class lifecycle: start(), stop(), tick()
- Pause handling: globalPause, enginePaused
- Re-entrance guards: ticking flag behavior
- Schedule execution: legacy command mode, multi-step mode
- In-flight tracking: concurrent run prevention
- Error handling: command failures, timeouts, recordRun failures
- Output truncation: large output handling
- Mid-tick pause detection

- [ ] Verify start/stop/tick lifecycle coverage
- [ ] Verify pause condition handling (globalPause, enginePaused)
- [ ] Verify re-entrance guard prevents overlapping ticks
- [ ] Verify both legacy and multi-step execution modes
- [ ] Verify in-flight tracking prevents concurrent runs
- [ ] Verify timeout handling with different step-level vs schedule-level timeouts
- [ ] Add any missing tests to match KB-301 depth
- [ ] Run tests: `cd packages/engine && pnpm test src/cron-runner.test.ts`

**Artifacts:**
- `packages/engine/src/cron-runner.test.ts` (modified if gaps found)

### Step 4: Enhance transient-error-detector.test.ts (if needed)

Ensure coverage of:
- isTransientError(): all pattern matches, case insensitivity
- classifyError(): usage-limit vs transient vs permanent classification
- TRANSIENT_ERROR_PATTERNS: exported array validation
- Edge cases: empty strings, null/undefined, non-string inputs
- Cross-boundary: ensure usage limit patterns take priority

- [ ] Verify all TRANSIENT_ERROR_PATTERNS have test cases
- [ ] Verify case-insensitive matching is tested
- [ ] Verify classifyError priority (usage-limit > transient > permanent)
- [ ] Verify edge cases (empty, null, undefined, non-string)
- [ ] Add any missing tests to match KB-301 depth
- [ ] Run tests: `cd packages/engine && pnpm test src/transient-error-detector.test.ts`

**Artifacts:**
- `packages/engine/src/transient-error-detector.test.ts` (modified if gaps found)

### Step 5: Enhance usage-limit-detector.test.ts (if needed)

Ensure coverage of:
- isUsageLimitError(): all pattern matches, case insensitivity
- USAGE_LIMIT_PATTERNS: rate limits, quotas, billing, overloaded
- Negative cases: transient server errors should NOT match
- checkSessionError(): throws when session.state.error is set
- UsageLimitPauser: idempotency, re-trigger after external reset, logging

- [ ] Verify all USAGE_LIMIT_PATTERNS have test cases
- [ ] Verify transient errors are correctly excluded
- [ ] Verify checkSessionError throws correctly
- [ ] Verify UsageLimitPauser idempotency (multiple calls = one pause)
- [ ] Verify UsageLimitPauser re-triggers after external globalPause=false
- [ ] Verify UsageLimitPauser logs to task via store.logEntry
- [ ] Add any missing tests to match KB-301 depth
- [ ] Run tests: `cd packages/engine && pnpm test src/usage-limit-detector.test.ts`

**Artifacts:**
- `packages/engine/src/usage-limit-detector.test.ts` (modified if gaps found)

### Step 6: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full engine test suite: `cd packages/engine && pnpm test`
- [ ] Verify all 4 test files pass
- [ ] Verify total test count (currently 568) — should not decrease
- [ ] Verify no test timeouts or flakiness
- [ ] Run 3 times to check for flaky tests

### Step 7: Documentation & Delivery

- [ ] Update engine package README if test section needs changes
- [ ] Verify all tests have descriptive names following KB-301 pattern
- [ ] Out-of-scope findings created as new tasks via `task_create` tool

## Documentation Requirements

**Must Update:**
- None expected (tests are self-documenting)

**Check If Affected:**
- `packages/engine/README.md` — Add testing section if missing

## Completion Criteria

- [ ] All 4 test files pass individually
- [ ] Full engine test suite passes: `pnpm test` exits with code 0
- [ ] Test coverage matches or exceeds KB-301 quality standard
- [ ] No test failures, timeouts, or flakiness
- [ ] No implementation changes unless bugs discovered (file separate tasks)

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `test(KB-315): verify Step N — module tests comprehensive`
- **Test additions:** `test(KB-315): add tests for module — description`
- **Test fixes:** `test(KB-315): fix test — description`

## Do NOT

- Modify source implementation files unless tests reveal actual bugs (file separate tasks for bugs)
- Skip tests or reduce coverage
- Add trivial always-pass tests
- Modify files outside the File Scope without good reason
- Commit without the task ID prefix
- Disable existing tests
