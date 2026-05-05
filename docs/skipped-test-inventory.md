# Skipped Test Inventory

_Last audited: 2026-05-05_

This document tracks intentional skip usage in test suites so stale follow-up backlog items can be retired quickly.

## Current Inventory

Audit commands:

```bash
rg -n "\b(it|test|describe)\.skip\b|\bskipIf\b|createLoopbackIntegrationTest\(" packages plugins scripts --glob "**/*.{test,spec}.{ts,tsx,mjs}"
rg -n "\?\s*it\s*:\s*it\.skip|detectLoopbackBinding|const itPosix" packages plugins scripts --glob "**/*.{test,spec}.{ts,tsx,mjs}"
```

Current results:

1. **Environment-gated integration aliases (loopback gated)**
   - Canonical helper: `packages/dashboard/src/__tests__/loopback-integration-test.ts`
   - Helper consumers:
     - `packages/dashboard/src/server-static-assets.test.ts`
     - `packages/dashboard/src/__tests__/websocket.test.ts`
     - `packages/dashboard/src/__tests__/server-webhook.test.ts`
   - Pattern: suites call `createLoopbackIntegrationTest(scope)` and register integration cases through the returned test function.
   - Rationale: these suites require real loopback binding support (`127.0.0.1`) and are intentionally environment-gated.
   - Auditability: when loopback binding is unavailable, skipped test names include a standardized reason and the suite scope label (`...; scope: <suite scope>`), making coverage gaps explicit in CI/test output.

2. **CLI slow-lane agent export gate**
   - `packages/cli/src/commands/__tests__/agent-export.test.ts`
   - Pattern: `describe.skipIf(!SHOULD_RUN_SLOW_CLI)("agent-export", ...)`
   - Gate: `FUSION_TEST_SLOW_CLI=1` or `FUSION_TEST_SLOW_CLI=true`
   - Rationale: these tests perform real workspace and `AgentStore` round-trips and are kept out of the default CLI unit lane.
   - Replacement owner: the explicit slow lane (`pnpm --filter @runfusion/fusion test:slow-cli`) is responsible for running them when slow CLI coverage is requested.

3. **CLI pi extension integration gate**
   - `packages/cli/src/__tests__/extension-integration.test.ts`
   - Pattern: `describe.skipIf(!SHOULD_RUN_EXTENSION_INTEGRATION)("built fn pi extension integration", ...)`
   - Gate: `FUSION_TEST_EXTENSION_INTEGRATION=1` or `FUSION_TEST_EXTENSION_INTEGRATION=true`
   - Rationale: this built-extension suite requires compiled CLI artifacts, so it is run through the explicit local release lane instead of every unit run.
   - Replacement owner: `pnpm --filter @runfusion/fusion test:extension-integration`.

4. **CLI legacy pi extension gate**
   - `packages/cli/src/__tests__/extension.test.ts`
   - Pattern: `describe.skipIf(!SHOULD_RUN_LEGACY_EXTENSION_INTEGRATION)("fn pi extension (legacy exhaustive suite)", ...)`
   - Gate: `FUSION_TEST_LEGACY_EXTENSION_INTEGRATION=1` or `FUSION_TEST_LEGACY_EXTENSION_INTEGRATION=true`
   - Rationale: this exhaustive suite is intentionally excluded from default and release lanes while it remains useful only for historical debugging.
   - Replacement owner: `packages/cli/src/__tests__/extension-integration.test.ts` owns maintained built-extension coverage.

5. **CLI native binary build gate**
   - `packages/cli/src/__tests__/build-exe-cross.test.ts`
   - Pattern: four `describe.skipIf(!SHOULD_RUN_BUILD_EXE)(...)` suites for single-target, Windows-target, all-target, and default-target binary builds.
   - Gate: `FUSION_TEST_BUILD_EXE=1`, `FUSION_TEST_BUILD_EXE=true`, or `CI=true`
   - Rationale: cross-compiling native binaries is intentionally expensive and belongs in the binary/pre-release lane, not every local unit run.
   - Replacement owner: `packages/cli/src/__tests__/build-exe.test.ts` and bundle-output tests cover the default fast package contract; `build-exe-cross.test.ts` owns full cross-target coverage when the gate is enabled.

6. **POSIX-only shell syntax cases**
   - `packages/engine/src/__tests__/run-verification-command.test.ts`
   - `packages/engine/src/__tests__/verification-utils.test.ts`
   - Pattern: `const itPosix = onPosix ? it : it.skip`
   - Gate: skipped only on `process.platform === "win32"`
   - Rationale: a subset of tests uses POSIX shell syntax (`printf`, pipes, and shell quoting). The implementation still uses Node's portable `shell: true`; these specific fixtures are not portable to `cmd.exe`.
   - Replacement owner: platform-neutral cases in the same suite continue to run on Windows.

7. **Build-output checks are deterministic (no skip gate)**
   - `packages/cli/src/__tests__/bundle-output.test.ts`
   - `packages/dashboard/app/__tests__/build-output.test.ts`
   - Pattern: each suite builds required artifacts in `beforeAll` and then runs chunking/bundle assertions unconditionally.
   - Rationale: clean worktrees and CI environments should execute real output-contract assertions instead of silently skipping when `dist/` is absent.

8. **Skip gate string assertions are not skip markers**
   - `packages/cli/src/__tests__/ci-workflow.test.ts`
   - Pattern: assertions check that CI workflow text contains `describe.skipIf(...)` gate strings.
   - Rationale: this file does not skip tests itself; it verifies the workflow keeps the intentionally gated suites wired.

## Older Follow-up Reconciliation

Previously tracked actionable skip follow-ups are now resolved and should not be treated as open backlog:

- **FN-2085**: wildcard proxy POST body forwarding coverage is active.
- **FN-2076 / FN-2106 / FN-2109**: NewAgentDialog and MissionInterviewModal rollback favorite-toggle regressions are active interaction tests.
- The former engine `executor.test.ts` step-session alias skip is no longer present; ownership now lives in active engine tests.

Searches for those IDs in repository test code and docs now return no active TODO/skip markers tied to unresolved work.

## Policy

When adding a new skip marker, include one of the following:

- a clear environment/build gate explanation, or
- a direct reference to the active test that owns equivalent coverage.

Avoid opening follow-up tasks for intentional gate/alias skips unless behavior coverage is actually missing.
