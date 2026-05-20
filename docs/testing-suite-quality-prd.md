# Testing Suite Quality PRD

_Created: 2026-05-05_

## Summary

> Latest speed-hardening measurements and contributor guardrails: `docs/test-speed-audit-FN-5048.md` and `AGENTS.md` → "Standing Rule: Do Not Add Slow Tests (FN-5048)".

Fusion has a large, useful, but uneven test suite. The suite is strongest where it exercises real SQLite state, git operations, published CLI bundle contracts, route auth/lease semantics, runtime orchestration, and user-visible mobile/native flows. It is weakest where it accumulates high-volume mechanical assertions: field-presence checks, CSS source-string checks, parser/regex matrices, type-shape runtime tests, class-name layout checks, and large mock-heavy component shells.

This PRD defines the work needed to make the suite smaller, more trustworthy, and easier to run correctly. The goal is not to chase a smaller test count for its own sake. The goal is to preserve high-signal regression coverage while cutting tests that lock implementation details or duplicate coverage already provided by better tests.

## Current State

Static inventory from this worktree:

| Area | Source files | Test files | Test cases | Assertions | Test LOC |
|---|---:|---:|---:|---:|---:|
| `packages/dashboard` | 377 | 420 | 10,608 | 26,490 | 244,069 |
| `packages/engine` | 89 | 105 | 3,191 | 7,250 | 83,201 |
| `packages/core` | 88 | 96 | 3,470 | 8,474 | 57,270 |
| `packages/cli` | 57 | 59 | 1,031 | 2,427 | 24,510 |
| Other packages/plugins/scripts | 104 | 92 | 1,004 | 2,046 | 18,123 |

The suite has good infrastructure foundations:

- `pnpm test` runs `scripts/test-changed.mjs`, selecting changed packages and using a cache.
- `pnpm test:full` runs workspace tests with capped worker fanout.
- `pnpm test:locked` exists for cross-worktree contention.
- `pnpm test:isolated` checks temp-directory cleanup.
- Core/dashboard/engine/CLI share test isolation helpers and worker budgeting in most places.
- Dashboard already separates Node server tests from jsdom UI tests.

Key gaps:

- Local changed-test selection does not include reverse dependents.
- The changed-test cache can miss dirty working-tree edits.
- PR CI shards only a hard-coded subset of packages and omits plugin tests and `@fusion/pi-llama-cpp`.
- Coverage is available but not used as a meaningful gate for critical code.
- Several configs do not use shared worker budgeting or isolation.
- Skip inventory is stale.
- The largest files are now hard to reason about and invite low-value additions.

## Goals

1. Keep high-signal tests that guard user-visible behavior, data durability, release artifacts, and concurrency safety.
2. Cut or consolidate low-signal tests that only assert implementation shape.
3. Add missing tests around release-critical and runtime-critical gaps.
4. Make local and CI test commands honest about what they cover.
5. Establish governance so future tests improve signal rather than re-growing mechanical coverage.

## Non-Goals

- Do not rewrite the test framework.
- Do not remove high-value regression tests just because they are long.
- Do not require browser E2E coverage for every UI path.
- Do not make full coverage thresholds block all packages immediately.
- Do not move desktop/mobile into the default root build unless a separate decision is made for platform cost.

## Quality Bar

A test is high-value when it catches a regression a user, release manager, or agent operator would notice:

- state persisted incorrectly,
- task/agent workflow moved to the wrong state,
- user WIP was staged or merged incorrectly,
- published CLI bundle cannot run after npm install,
- auth/lease/security behavior changed,
- mobile/native or desktop flow breaks,
- dashboard feature becomes unreachable,
- process/runtime cleanup fails.

A test is low-value when it mostly asserts:

- one field exists after another test already round-trips the payload,
- a TypeScript type shape at runtime,
- exact CSS declaration text,
- a class name unrelated to behavior,
- every regex/parser permutation with no new behavioral boundary,
- mocked shell wiring already covered by command-specific tests.

## What To Keep

Keep and protect these categories.

### Core

- SQLite initialization, WAL, transaction/savepoint, migration, FTS5, and verification-cache tests in `packages/core/src/__tests__/db.test.ts`.
- Store tests that cover write-lock serialization, SQLite-first reads when blobs are corrupt/missing, dependency/status transitions, archive/unarchive recovery fields, and FN-ticket regressions in `packages/core/src/__tests__/store.test.ts`.
- Agent checkout leasing, conflict, claim, runtime state, and budget tests in `packages/core/src/__tests__/agent-store.test.ts`.
- Environment-sensitive FTS5/SQLite guards such as `packages/core/src/__tests__/fts5-guard.test.ts`.

### Engine

- Executor tests covering worktree recovery, stale refs, pause/resume, model hot-swap, workflow rerun, verification gates, and FN-ticket regressions.
- Restart/recovery integration tests in `packages/engine/src/__tests__/restart.integration.test.ts`.
- Real-git merger staging allowlist tests in `packages/engine/src/__tests__/merger-staging-allowlist.test.ts`.
- Heartbeat scheduler/monitor tests for pause, budget, timer triggers, checkout conflicts, and concurrency.
- Runtime adapter tests that exercise real process lifecycle or IPC semantics.

### Dashboard

- Published-bundle regression guard for static `@fusion/engine` imports in `packages/dashboard/src/__tests__/engine-import-regression.test.ts`.
- Auth and daemon-token integration tests using real `createServer`.
- Remote node sync route contracts, including API key authorization.
- Checkout lease route tests returning user-visible `409 Conflict`.
- Real-ish store/SQLite route tests for insights, tasks, file diffs, and project scoping.
- Hook tests for real race conditions such as stale backend hydration overriding local user choice.
- Product-level mobile feature reachability tests.

### CLI, Desktop, Mobile, Plugins

- CLI bundle-output tests that verify no bare `@fusion/*` imports and validate staged assets.
- Binary smoke tests for isolated no-`package.json` execution, `--help`, dashboard startup on port `0`, and PTY session creation.
- CLI package dependency guards that catch clean-install failures hidden by pnpm hoisting.
- Desktop IPC/bootstrap tests for first-run local/remote flows and shell channels.
- Mobile native behavior tests for deep links, share, push notifications, QR/native-shell boundaries.
- Pi adapter protocol tests for stream lifecycle, spawned flags, internal tool filtering, and MCP config.
- Runtime plugin tests that assert subprocess/output semantics.

## What To Cut Or Consolidate

### P0 Cut Candidates

These should be pruned first because they consume high maintenance time with low regression value.

1. CSS source-string tests that assert exact declarations.
   - Examples: `core-modals-mobile.test.tsx`, `board-mobile.test.tsx`, `mobile-css.test.tsx`, `TodoView.mobile-css.test.ts`.
   - Keep a few token/breakpoint guardrails and replace the rest with browser-level layout smoke tests.

2. Runtime TypeScript shape tests.
   - Example: `packages/plugin-sdk/src/__tests__/index.test.ts`.
   - Keep `definePlugin` identity and real manifest validation behavior. Move type coverage to typecheck or compile-time examples.

3. Redundant API wrapper URL/header tests.
   - Examples: broad wrapper suites in `packages/dashboard/app/__tests__/api-settings.test.ts` and `api-tasks.test.ts`.
   - Keep auth/header/error parsing and streaming edge cases. Consolidate to one happy-path per wrapper family plus route contract tests.

4. Mocked command-router smoke coverage.
   - Example: `packages/cli/src/__tests__/bin.test.ts`.
   - Keep a small representative routing table. Let command-specific tests own behavior.

### P1 Consolidation Candidates

1. Settings field/default assertions across core.
   - Consolidate overlap between settings parity, global settings, and store settings blocks.
   - Keep precedence, migration, and round-trip behavior.

2. Regex/parser/error detector matrices.
   - Examples: context-limit, transient-error, reconcile-step regex, stream parser.
   - Keep provider examples, boundaries, and precedence. Convert linear permutations to compact `it.each`.

3. Plugin example manifest/schema tests.
   - Keep one manifest smoke and real hook/tool behavior per example.
   - Drop repeated static schema assertions already covered by SDK validation.

4. Duplicate desktop integration smoke.
   - Fold the smaller `main.integration.test.ts` checks into the richer `main-integration.test.ts`.

5. Huge component suite structural assertions.
   - Split and prune `TaskDetailModal.test.tsx`, `App.test.tsx`, `GitManagerModal.test.tsx`, `ModelOnboardingModal.test.tsx`, `AgentDetailView.test.tsx`.
   - Keep behavior paths; cut class-name/layout internals unless they guard a documented regression.

## What To Add

### P0 Additions

1. Reverse-dependent changed-test selection.
   - If `@fusion/core` changes, run core plus engine, dashboard, CLI, plugin-sdk, and packages importing it.
   - If dashboard or engine changes, run CLI because CLI aliases those source entries for bundle tests.

2. Dirty-worktree cache safety.
   - Disable the changed-test cache when affected files are dirty, or include working-tree content in package hashes.
   - `pnpm test` must not report cached success for files that have never been tested.

3. CI package coverage parity.
   - Generate CI shard package lists from workspace packages with `test` scripts.
   - Include plugin packages and `@fusion/pi-llama-cpp`, or run a dedicated plugin test lane.

4. Critical release/tarball contract test.
   - Add an `npm pack --dry-run` or equivalent assertion for `@runfusion/fusion`.
   - Required contents: `dist/bin.js`, `dist/client/**`, `dist/pi-claude-cli/**`, `dist/droid-cli/**`, `dist/plugins/**`, and `skill/**`.
   - Excluded contents: standalone binary outputs and unnecessary runtime build artifacts.

5. Browser-level dashboard smoke lane.
   - Cover mobile nav, header overflow, one modal, board/list switch, and footer/input behavior.
   - This should use a real browser because jsdom cannot prove layout overflow or fixed-position behavior.

### P1 Additions

1. Critical coverage lane.
   - Add `coverage:critical` for targeted files from `docs/test-audit-report.md`, not the entire recursive workspace.
   - Initial targets: engine runtime/verification utilities, CLI project resolver/settings import-export, dashboard mission/import/generation routes/components, core `gh-cli`/summary utilities.

2. Engine runtime/process tests.
   - Add direct tests for `verification-utils.ts`, especially process-group timeout, abort, and buffer overflow behavior.
   - Add direct tests for `custom-providers.ts` malformed/missing settings and valid arrays.
   - Add a small adapter test for `task-completion.ts` dependency lookup failures.
   - Add SQLite adapter constructor selection coverage if release binaries depend on it.

3. Dashboard route-store integration contracts.
   - Add real `TaskStore`/SQLite route-store passes for tasks, settings, nodes, and project scoping.
   - Reduce fake-store route tests where equivalent real-store tests exist.

4. Frontend/backend API contract tests.
   - For important wrappers, call exported frontend API functions against an in-process route server.
   - This replaces separate fetch-string and route-mock assertions.

5. Accessibility smoke.
   - Add role/focus/escape coverage for major modals and command surfaces.

6. Pi/plugin integration repairs.
   - Replace stale gated CLI pi extension integration with a smaller current integration test against the built extension entry.
   - Add a bundled plugin loader integration test that verifies dashboard view/runtime metadata registration.
   - Add `pi-llama-cpp` tests for unreachable/malformed server responses and model listing.

7. Desktop/mobile build smoke lanes.
   - Add non-default CI lanes for desktop build and mobile sync/build smoke.
   - Keep them outside fast PR checks unless changed-file detection selects those packages.

## Run Model

### Local Development

Use the narrowest command that honestly covers the changed surface.

| Situation | Command |
|---|---|
| Package-local change | `pnpm --filter <package> test` |
| Dirty worktree using changed-test path | `pnpm test --no-cache` |
| Shared core/engine/dashboard/CLI change | `pnpm test:full` |
| Multiple worktrees or resource contention | `pnpm test:locked` |
| Isolation audit | `pnpm test:isolated` |
| Dashboard bundle/client-dist change | `pnpm --filter @fusion/dashboard test:build` |
| Published CLI/release-sensitive change | `pnpm --filter @runfusion/fusion test && pnpm --filter @runfusion/fusion test:pre-release && pnpm build` |
| Extension behavior changed | `pnpm --filter @runfusion/fusion test:extension-integration` after repairing stale integration |
| Desktop change | `pnpm --filter @fusion/desktop test typecheck build` |
| Mobile change | `pnpm --filter @fusion/mobile test typecheck` plus relevant Capacitor sync/build lane |

### PR CI

Target state:

1. Install and build once per shard where needed.
2. Run lint and typecheck.
3. Run deterministic test shards generated from all workspace packages with `test` scripts.
4. Split dashboard into separate lanes:
   - dashboard app/jsdom,
   - dashboard server/routes,
   - dashboard slow process/WebSocket/browser smoke.
5. Run plugin package tests.
6. Run `@fusion/pi-llama-cpp` tests.
7. Run `coverage:critical` only on critical target files.

### Release CI

Target state:

1. Run `pnpm verify:workspace`.
2. Run CLI pre-release tests and binary build smoke.
3. Run tarball contract test.
4. Run plugin loader integration.
5. Use the repository release script for real releases: `pnpm release --yes`.

## Governance Rules

1. New tests should cover observable behavior, not implementation shape.
2. New CSS tests should prefer rendered/computed behavior over CSS source text.
3. New parser/regex coverage should be table-driven and limited to representative boundaries.
4. New high-volume tests must name the regression or user-visible contract they protect.
5. Tests tied to FN-ticket regressions are kept unless a better test explicitly replaces them.
6. Every package with a `test` script must either use shared worker budgeting and isolation or be explicitly allowlisted with a reason.
7. Skip markers must be documented in `docs/skipped-test-inventory.md` with an environment gate or replacement coverage owner.
8. Large suites should not grow further; new behavior areas get focused files under `__tests__/`.

## Success Metrics

Within one cleanup cycle:

- Reduce dashboard test LOC by at least 15% without removing listed high-value categories.
- Reduce top five largest test files by moving or pruning at least 20% of their structural assertions.
- CI shards include every workspace package with a `test` script.
- `pnpm test` is dirty-worktree safe.
- `docs/skipped-test-inventory.md` matches current skip/gate usage.
- `coverage:critical` exists with thresholds for selected critical files.
- Browser smoke lane covers the primary dashboard layout risks.

Longer term:

- Keep total test LOC growth below source LOC growth.
- Keep new skipped tests at zero unless they are environment-gated and documented.
- Track flake rate for process/WebSocket/browser lanes separately from deterministic unit lanes.

## Implementation Plan

### Phase 1: Make Test Runs Honest

- Fix changed-test reverse dependency selection.
- Make changed-test cache dirty-worktree safe.
- Generate CI test shards from workspace package metadata.
- Add plugin and `pi-llama-cpp` tests to PR coverage.
- Apply shared worker budgeting/isolation to `droid-cli`, `pi-claude-cli`, and `pi-llama-cpp`.
- Refresh skipped-test inventory.

### Phase 2: Add Missing High-Value Coverage

- Add CLI tarball contract test.
- Add critical engine runtime/process tests.
- Add dashboard browser smoke lane.
- Add route-store integration contracts for tasks/settings/nodes/project scoping.
- Repair CLI pi extension integration.
- Add bundled plugin loader integration.

### Phase 3: Prune Low-Value Coverage

- Cut CSS source-string assertions and replace with browser/computed smoke.
- Consolidate dashboard API wrapper tests.
- Consolidate core settings field/default checks.
- Consolidate parser/regex matrices.
- Trim runtime type-shape tests from plugin SDK.
- Merge duplicate desktop integration smoke.

### Phase 4: Enforce Governance

- Add governance test for test package config consistency.
- Add `coverage:critical`.
- Document run lanes in contributor docs.
- Require PRs adding broad test files to identify the behavior contract they protect.

## Risks

- Pruning can accidentally remove real regression coverage if done mechanically. Mitigation: only cut tests after mapping each to a better owner or identifying it as implementation-shape coverage.
- Browser smoke adds CI cost. Mitigation: keep the lane tiny and targeted.
- Reverse-dependent changed-test selection will run more tests locally. Mitigation: make the behavior explicit and preserve `--filter` escape hatches for expert use.
- Coverage thresholds can create churn if applied globally. Mitigation: start with critical files only.

## Open Questions

- Should dashboard browser smoke use Playwright in CI, or the existing in-app/browser tooling only for local verification?
- Should process/WebSocket tests be tagged in filenames or moved into separate `__tests__/slow/` directories?
- What minimum critical coverage thresholds should apply initially per package?
- Should plugin examples be treated as product tests, documentation tests, or both?

