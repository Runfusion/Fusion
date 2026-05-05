# Testing Suite Hardening Bugs

_Started: 2026-05-05_

This is the living bug log for the testing-suite hardening work described in
`docs/testing-suite-quality-prd.md`. Each entry should stay factual: what broke,
why it broke, how it was fixed, and what command verified the fix.

## Open

| ID | Area | Symptom | Root cause | Planned fix | Status |
|---|---|---|---|---|---|
| TSH-007 | Dashboard test runtime/noise | `pnpm test:full` passes but dashboard tests take about 10 minutes locally and emit repeated SQLite experimental warnings plus git default-branch hints. | The suite exercises many SQLite-backed and git-backed paths; Node emits SQLite warnings globally and fixture git repos use default branch initialization. | Consider a follow-up cleanup to quiet expected warnings and split expensive dashboard lanes without reducing coverage. | Open |

## Fixed

| ID | Area | Symptom | Root cause | Fix | Verification |
|---|---|---|---|---|---|
| TSH-001 | Local test selection | `pnpm test` could under-test shared package edits. | Changed-package resolution selected direct changed workspaces but not dependent workspaces that import them. | `scripts/test-changed.mjs` now expands affected packages through the workspace reverse-dependency graph. | `node --test scripts/__tests__/test-changed.test.mjs` and `pnpm test:full` |
| TSH-002 | Local test cache | Cached package passes could hide dirty worktree edits. | Cache keys were based on tracked blob SHAs and did not account for modified or untracked working-tree content. | Dirty affected files now bypass package cache reuse so local edits are exercised before PR. | `node --test scripts/__tests__/test-changed.test.mjs` and `pnpm test:full` |
| TSH-003 | PR CI coverage | PR sharding omitted plugin packages and `@fusion/pi-llama-cpp`. | The CI shard package list was hard-coded instead of derived from the workspace graph. | `scripts/ci-test-shard.mjs` now derives shard candidates from workspace packages with test scripts. | `node --test scripts/__tests__/test-changed.test.mjs scripts/__tests__/test-governance.test.mjs` and `pnpm test:full` |
| TSH-004 | Test governance | Runtime package Vitest configs bypassed shared worker budgeting/isolation conventions. | Configs had drifted independently across Droid, Pi Claude, and Pi Llama packages. | The configs now share the same thread pool sizing and isolation defaults, with a governance test to keep them aligned. | `node --test scripts/__tests__/test-governance.test.mjs` and `pnpm test:full` |
| TSH-005 | Plugin changed-test targeting | Plugin edits still forced the entire suite after package-aware targeting was added. | `shouldForceFullSuite()` treated every `plugins/**` path as broad repo surface area. | Plugin workspace paths are now resolved like package paths, so plugin edits run the relevant plugin tests instead of automatically falling back to all tests. | `node --test scripts/__tests__/test-changed.test.mjs` |
| TSH-006 | Skipped-test inventory | The skipped-test inventory documented the wrong gate ownership for the new and legacy extension suites. | The maintained extension integration lane and legacy exhaustive gate were renamed during implementation, but the inventory text still reflected the earlier split. | `docs/skipped-test-inventory.md` now lists `FUSION_TEST_EXTENSION_INTEGRATION` for the maintained built-extension test and `FUSION_TEST_LEGACY_EXTENSION_INTEGRATION` for the legacy suite. | `git diff --check`, `node --test scripts/__tests__/test-governance.test.mjs`, and `pnpm test:full` |
| TSH-008 | Test isolation | `custom-providers.test.ts` wrote to the real `~/.fusion/settings.json` path during the first local full-suite run. | The test used `os.homedir()` directly instead of a fixture home directory. | `readCustomProviders()` now accepts an injectable home directory, and the test uses a temp HOME fixture that is removed after each case. | `pnpm --filter @fusion/engine test -- src/__tests__/custom-providers.test.ts` (ran the full engine lane: 108 files, 3339 tests) |
