# Task: KB-648 - Increase Test Speed

**Created:** 2026-04-01
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** Test optimization requires modifying vitest configurations and refactoring slow tests while maintaining correctness. Changes are localized to test infrastructure and specific slow tests.
**Score:** 4/8 — Blast radius: 1, Pattern novelty: 1, Security: 0, Reversibility: 2

## Mission

Significantly reduce test suite execution time by optimizing vitest configuration and refactoring slow test patterns. Currently the test suite takes 30+ seconds for core alone, with backup tests contributing ~24 seconds due to artificial delays. Enable parallel file execution where safe and eliminate unnecessary wait patterns.

## Dependencies

- **Task:** KB-637 (Fix Pre-existing Test Failures) — Must complete first to avoid hanging tests masking speed improvements

## Context to Read First

Before making changes, read these files to understand the test structure and speed bottlenecks:

1. `packages/core/vitest.config.ts` - Current vitest configuration with `fileParallelism: false`
2. `packages/core/src/backup.test.ts` - Tests using `waitForNextSecond()` with 1100ms delays
3. `packages/engine/vitest.config.ts` - Same fileParallelism setting
4. `packages/cli/vitest.config.ts` - Same fileParallelism setting
5. `packages/dashboard/vitest.config.ts` - Same fileParallelism setting with jsdom environment

## File Scope

- `packages/core/vitest.config.ts` - Enable parallel file execution
- `packages/core/src/backup.test.ts` - Replace real-time delays with fake timers or timestamp mocking
- `packages/engine/vitest.config.ts` - Enable parallel file execution
- `packages/cli/vitest.config.ts` - Enable parallel file execution
- `packages/dashboard/vitest.config.ts` - Evaluate and enable parallel execution if safe

## Steps

### Step 1: Optimize Backup Tests - Eliminate Real-Time Delays

The backup tests currently use `waitForNextSecond()` which adds 1100ms between operations to ensure unique timestamps. Replace with Vitest fake timers or deterministic timestamp mocking.

- [ ] Read `packages/core/src/backup.test.ts` and identify all `waitForNextSecond()` calls (lines ~42, ~108, ~117, ~143, ~163, ~184, ~205, ~229, ~326)
- [ ] Refactor to use Vitest's `vi.useFakeTimers()` instead of real `setTimeout`
- [ ] Option 1: Use `vi.setSystemTime()` to advance time deterministically between backup creations
- [ ] Option 2: Mock `Date.now()` to return incrementing values
- [ ] Ensure tests still verify correct timestamp ordering in backup listings
- [ ] Remove or deprecate the `waitForNextSecond()` helper function
- [ ] Run backup tests: `cd packages/core && pnpm test -- --run src/backup.test.ts`
- [ ] Verify test duration drops from ~24s to <2s

**Artifacts:**
- `packages/core/src/backup.test.ts` (modified - fake timers instead of real delays)

### Step 2: Enable Parallel File Execution in Core Package

Enable `fileParallelism: true` in core package vitest config. Core tests are mostly unit tests with isolated temp directories, making them safe for parallel execution.

- [ ] Modify `packages/core/vitest.config.ts`
- [ ] Change `fileParallelism: false` to `fileParallelism: true`
- [ ] Keep `maxWorkers` at 16 (or reduce to 8 if resource-constrained)
- [ ] Run core tests: `cd packages/core && pnpm test -- --run`
- [ ] Verify no race conditions in temp directory creation (each test uses unique temp dirs)
- [ ] If any tests fail due to parallelism issues, mark with `concurrency: 1` or fix the isolation issue
- [ ] Verify total core test duration drops significantly (target: <10s from current ~29s)

**Artifacts:**
- `packages/core/vitest.config.ts` (modified - fileParallelism enabled)

### Step 3: Enable Parallel File Execution in Engine Package

Enable parallel execution for engine tests. Most executor tests use mocked git operations and isolated temp paths.

- [ ] Modify `packages/engine/vitest.config.ts`
- [ ] Change `fileParallelism: false` to `fileParallelism: true`
- [ ] Run engine tests: `cd packages/engine && pnpm test -- --run`
- [ ] Watch for the hanging test mentioned in KB-637 - if still present, note that KB-637 must complete first
- [ ] Verify no worktree path collisions between parallel tests
- [ ] If any tests fail due to shared state, fix the isolation or use `sequential()` for those specific tests

**Artifacts:**
- `packages/engine/vitest.config.ts` (modified - fileParallelism enabled)

### Step 4: Enable Parallel File Execution in CLI Package

Enable parallel execution for CLI tests.

- [ ] Modify `packages/cli/vitest.config.ts`
- [ ] Change `fileParallelism: false` to `fileParallelism: true`
- [ ] Run CLI tests: `cd packages/cli && pnpm test -- --run`
- [ ] Verify tests pass without cross-test interference

**Artifacts:**
- `packages/cli/vitest.config.ts` (modified - fileParallelism enabled)

### Step 5: Evaluate Dashboard Test Parallelism

Dashboard tests use jsdom environment and may have more complex setup. Evaluate if parallel execution is safe.

- [ ] Review `packages/dashboard/vitest.config.ts`
- [ ] Check for any shared global state in dashboard tests (React context, singletons)
- [ ] Attempt enabling `fileParallelism: true`
- [ ] Run dashboard tests: `cd packages/dashboard && pnpm test -- --run`
- [ ] If tests fail due to shared state, document which tests need sequential execution and use `describe.sequential()` or `test.sequential()`
- [ ] If too many issues, keep `fileParallelism: false` for dashboard but document the reason

**Artifacts:**
- `packages/dashboard/vitest.config.ts` (modified or unchanged with documentation comment)

### Step 6: Testing & Verification

Run full test suite to verify all optimizations work together and total suite time is significantly reduced.

- [ ] Run full test suite: `pnpm test`
- [ ] Record before/after durations for each package
- [ ] Verify core package tests complete in <10s (was ~29s)
- [ ] Verify backup tests specifically complete in <2s (was ~24s)
- [ ] Verify total suite time is reduced by at least 30%
- [ ] Run with coverage to ensure no test behavior changes: `pnpm test:coverage`
- [ ] Ensure all tests still pass (except known failures from KB-637 if not yet completed)

### Step 7: Documentation & Delivery

Document the performance improvements for future reference.

- [ ] Create changeset: `increase-test-speed-kb-648.md` (patch level - internal improvement)
- [ ] Update `AGENTS.md` Testing section with a note about `fileParallelism` and fake timers for timestamp-dependent tests
- [ ] Document any tests that must remain sequential and why

## Documentation Requirements

**Must Update:**
- `AGENTS.md` — Add brief note about test optimization patterns:
  - Use fake timers (`vi.useFakeTimers()`, `vi.setSystemTime()`) instead of real `setTimeout` for timestamp-dependent tests
  - Default to `fileParallelism: true` in vitest configs; use `test.sequential()` for tests that truly need isolation

**Check If Affected:**
- `packages/core/src/backup.test.ts` — Update comments if fake timer approach differs significantly from old pattern

## Completion Criteria

- [ ] All backup tests use fake timers instead of real 1100ms delays
- [ ] Core package tests run with `fileParallelism: true`
- [ ] Engine package tests run with `fileParallelism: true`
- [ ] CLI package tests run with `fileParallelism: true`
- [ ] Dashboard tests either run in parallel or have documented reason for sequential execution
- [ ] Total test suite execution time reduced by at least 30% (target: core <10s, total suite <60s)
- [ ] All tests pass (except any pre-existing failures from KB-637)
- [ ] Changeset created
- [ ] AGENTS.md updated with optimization patterns

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-648): complete Step N — description`
- **Bug fixes:** `fix(KB-648): description`
- **Tests:** `test(KB-648): description`

## Do NOT

- Skip tests or mark as `.skip()` to improve speed - actually optimize the test code
- Reduce test coverage or remove assertions to speed up tests
- Enable parallelism if it causes flaky tests - fix isolation issues first
- Use real delays (setTimeout, sleep) in new tests - always prefer fake timers
- Change production code behavior solely to make tests faster - only change test code and config
