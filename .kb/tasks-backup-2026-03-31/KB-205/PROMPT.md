# Task: KB-205 - Increase Max Test Concurrency

**Created:** 2026-03-30
**Size:** S

## Review Level: 0 (None)

**Assessment:** Simple configuration change across 4 identical vitest config files. No logic changes, no API changes, no security implications. Easily reversible by reverting the default value.
**Score:** 1/8 — Blast radius: 0, Pattern novelty: 0, Security: 1, Reversibility: 0

## Mission

Increase the default maximum test concurrency (maxWorkers) in all Vitest configuration files from 8 to 16 workers. This allows test suites to better utilize modern multi-core development machines and CI runners, reducing overall test execution time. The change maintains the existing environment variable override (VITEST_MAX_WORKERS) for flexibility in different environments.

## Dependencies

- **None**

## Context to Read First

- `packages/core/vitest.config.ts` — Current maxWorkers = 8
- `packages/cli/vitest.config.ts` — Current maxWorkers = 8
- `packages/dashboard/vitest.config.ts` — Current maxWorkers = 8
- `packages/engine/vitest.config.ts` — Current maxWorkers = 8

## File Scope

- `packages/core/vitest.config.ts`
- `packages/cli/vitest.config.ts`
- `packages/dashboard/vitest.config.ts`
- `packages/engine/vitest.config.ts`

## Steps

### Step 1: Update Vitest Configurations

Update all 4 vitest config files to increase the default maxWorkers from 8 to 16.

- [ ] Change `packages/core/vitest.config.ts`: Update default from "8" to "16"
- [ ] Change `packages/cli/vitest.config.ts`: Update default from "8" to "16"
- [ ] Change `packages/dashboard/vitest.config.ts`: Update default from "8" to "16"
- [ ] Change `packages/engine/vitest.config.ts`: Update default from "8" to "16"

**Artifacts:**
- `packages/core/vitest.config.ts` (modified)
- `packages/cli/vitest.config.ts` (modified)
- `packages/dashboard/vitest.config.ts` (modified)
- `packages/engine/vitest.config.ts` (modified)

### Step 2: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm test` to verify all tests pass with increased concurrency
- [ ] Run `pnpm build` to ensure builds still pass
- [ ] Verify no test flakiness introduced by higher parallelism

### Step 3: Documentation & Delivery

- [ ] No documentation updates required (internal configuration change)

## Completion Criteria

- [ ] All 4 vitest.config.ts files updated with maxWorkers default of 16
- [ ] All tests passing
- [ ] Build passes

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-205): complete Step N — description`
- **Bug fixes:** `fix(KB-205): description`
- **Tests:** `test(KB-205): description`

## Do NOT

- Expand task scope
- Skip tests
- Modify files outside the File Scope without good reason
- Commit without the task ID prefix
- Change the environment variable name (keep VITEST_MAX_WORKERS)
- Modify fileParallelism setting (keep as false)
- Change any other test configuration options
