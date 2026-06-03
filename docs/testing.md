# Testing Guide

[← Docs index](./README.md)

This guide consolidates the detailed testing guidance moved from `AGENTS.md`.

## Required workspace gates

Tests are required. Typechecks and manual verification are not substitutes for assertions.

Use the narrowest command that exercises the behavior you changed, then broaden before reporting completion.

```bash
pnpm test              # changed-only workspace tests; falls back to full gate in safety contexts
pnpm test:full         # full workspace quality gate
pnpm lint              # lint all packages
pnpm build             # build workspace packages (excludes desktop/mobile)
pnpm verify:workspace  # canonical pre-merge gate: lint -> test:full -> build
```

`pnpm test:full` runs each package's default test script with capped worker fanout (`FUSION_TEST_TOTAL_WORKERS=4 FUSION_TEST_CONCURRENCY=2 pnpm -r --workspace-concurrency=2 test`). Do not casually raise worker counts; dashboard/jsdom and integration-heavy packages destabilize when oversubscribed. Use `VITEST_MAX_WORKERS=<n>` only for targeted package-level investigation.

## Fresh-worktree dist bootstrap

`pnpm test` auto-runs `scripts/ensure-test-artifacts.mjs` to rebuild missing/stale dist artifacts. Dashboard and `dependency-graph` package lanes auto-bootstrap too. If you hit opaque `Failed to resolve import "./cli-spawn.js"` (or similar), treat it as bootstrap regression against FN-4605 — don't work around with a manual `pnpm build`.

## Dashboard Test Lanes

```bash
pnpm --filter @fusion/dashboard test                # curated app/API quality gate (default)
pnpm --filter @fusion/dashboard test:deep           # exhaustive app + API suite
pnpm --filter @fusion/dashboard test:app            # exhaustive React/jsdom
pnpm --filter @fusion/dashboard test:api            # exhaustive Node API/server
pnpm --filter @fusion/dashboard test:browser-smoke  # local browser CSS/layout smoke
pnpm --filter @fusion/dashboard test:build          # built client output contract
```

Run `test:deep` when changing broad dashboard architecture, shared modal/view infrastructure, or route registration. Run `test:browser-smoke` for layout/responsive/navigation/modal/CSS changes. Run `test:build` for Vite output, lazy-loading, chunking, or client-dist changes.

When adding a new test file under `app/components/__tests__`, also add its basename to `qualityAppTests` in `packages/dashboard/vitest.config.ts` — otherwise the curated gate silently skips it.

## Targeted commands

```bash
pnpm --filter @fusion/core test
pnpm --filter @fusion/engine test
pnpm --filter @runfusion/fusion test
pnpm test:scripts
node --test scripts/__tests__/*.test.mjs
```

For a single Vitest file, use package-local `exec vitest`:

```bash
pnpm --filter @fusion/core exec vitest run src/__tests__/central-db.test.ts --silent=passed-only --reporter=dot
```

## Engine test helper convention

`packages/engine/src/__tests__/executor-test-helpers.ts` defaults both `isUsableTaskWorktree` to `true` and `classifyTaskWorktree` to `{ ok: true }` via a helper-level `worktree-pool` mock. To test failure paths, override with `vi.spyOn(worktreePool, "classifyTaskWorktree").mockResolvedValueOnce({ ok: false, classification: "unregistered", reason: "..." })` (or `isUsableTaskWorktree` for legacy call sites). Production liveness assertions in `executor.ts` are unchanged.

## Before reporting done

- Code changes: affected package tests + any directly relevant browser/build lane.
- Cross-package, shared test infrastructure, or CI changes: `pnpm test:full`.
- Production/bundling-sensitive changes: `pnpm build`.
- Substantial work: `pnpm verify:workspace`.
- If you skip a relevant lane, say why.

## Test file organization

Test for `src/foo.ts` → `src/__tests__/foo.test.ts`. Test for `app/components/Bar.tsx` → `app/components/__tests__/Bar.test.tsx`. `__tests__/` is the standard.

## What NOT to write

Tests should cover behavior a user could notice break, not implementation shape. Don't write:

- **CSS-class permutation tests** — use one `it.each` for the boolean matrix, not one `it` per combination.
- **Field-presence tests** when a payload-roundtrip test already exercises the same field.
- **React.memo tautologies** — testing `React.memo` tests React, not us. Test custom comparators directly, one case.
- **Mock-the-world wiring tests** — if a test mocks 8+ deps just to render a component, shim children with `() => null` or delete and rely on an integration test one level up.
- **Structural CSS assertions** — "tab uses .class-name not inline style". Consolidate into one aggregate layout-contract test per component.

Prefer `it.each` over copy-pasted `it()` blocks. When trimming, keep: first case + opposite case + any precedence/override case.

## What TO keep unconditionally

- Tests linked to an FN-ticket in describe/it names — these guard real regressions.
- Integration tests exercising real SQLite, real worker pool, or spawned processes.
- Lean core/engine unit tests with low mock burden.

## Standing Rule: Do Not Add Slow Tests (FN-5048)

- Default new tests to narrow seams, in-memory fakes, shared harnesses, and targeted assertions.
- For bug-fix regressions, also follow `AGENTS.md` → **Standing Rule: Fix the Invariant, Not the Repro (FN-5893)** so coverage proves the invariant across known surfaces, not just one repro.
- Prefer fake timers over real polling/time waits (FN-2707 pattern: advance timers inside `act(...)`, restore with `afterEach(() => vi.useRealTimers())`).
- Do **not** mask slowness by raising worker/concurrency knobs (`FUSION_TEST_TOTAL_WORKERS`, `FUSION_TEST_CONCURRENCY`, `VITEST_MAX_WORKERS`, workspace concurrency settings).
- Do **not** add net-new real-network calls, real-`setTimeout` polling loops, or mock-the-world component shells when a narrower seam exists.
- Use the canonical taxonomy in **What NOT to write** and **What TO keep unconditionally** when deciding trim vs keep.
- See `docs/test-speed-audit-FN-5048.md` for the measured baseline offender list and optimization priorities.

### Surface Enumeration checklist

Copy this checklist into a bug-fix task's `## Surface Enumeration` section and make the regression tests prove the invariant across every checked surface. See `AGENTS.md` → **Standing Rule: Fix the Invariant, Not the Repro (FN-5893)** for the enforced planning/review contract.

- [ ] Providers / bridges / execution paths touched by the invariant
- [ ] Desktop + mobile breakpoints / platforms that exercise the behavior
- [ ] Empty / undefined / duplicate / populated data states
- [ ] Shared hooks / components / modules / helpers reusing the logic
