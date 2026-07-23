# Testing Guide

[← Docs index](./README.md)

This guide consolidates the detailed testing guidance moved from `AGENTS.md`.

## The merge gate

CI blocks PRs on exactly four checks (`.github/workflows/pr-checks.yml`): **Lint, Typecheck, Build, Gate**. The Gate job runs the boot smoke (`scripts/boot-smoke.mjs`: CLI `--help` + a real `fn serve` answering `GET /api/health`) and `pnpm test:gate` (static process guards, curated `engine-core`, two PostgreSQL canaries, and the CI-shape test). Everything else — the 4-way shards, the engine slow tier, the dashboard inventory guard — runs NON-BLOCKING in `.github/workflows/full-suite.yml` on push to main.

Gate membership is the explicit allow-list in `packages/engine/vitest.config.ts` (`engine-core` project). Admission requires evidence of value (the test catches real regressions); tests never graduate in by default. A flaky gate test is evicted by deleting its allow-list line — the eviction PR does not need the flaky test to pass. The whole `engine-core` project must stay under ~60s wall-clock.

<!-- FNXC:MergeGatePerformance 2026-07-22-15:35: FN-8497 restores the 8–10s gate band after a 23-file PG integration lane added 17s of serialized database-template work. Keep only the lifecycle and transactional-handoff canaries blocking; the other former members must remain enabled in the non-blocking core test lane and the structural policy test enforces that containment. -->
**PostgreSQL gate policy:** `packages/core`'s `test:pg-gate` intentionally runs only `task-lifecycle-e2e.pg.test.ts` and `handoff-to-review-atomicity.pg.test.ts`, preserving real-backend lifecycle and atomic-handoff canaries. It runs concurrently with `engine-core` after the static guards; the root script waits for **both** lanes and propagates either failure before running CI-shape. Every other former PG gate member remains enabled and discovered by the non-blocking command `pnpm --filter @fusion/core test` (default config: `src/**/*.test.ts`, no PG quarantine exclusions). `scripts/__tests__/engine-vitest-gate-policy.test.mjs` pins the two canaries and fails if any removed member is deleted, undiscoverable, or hidden by the default lane's script/config.

<!-- FNXC:EngineTests 2026-07-08-03:00: FN-7667 decouples the engine-core gate's module graph from full-barrel growth so new feature modules don't silently inflate every gate fork's transform/import cost. -->
**Gate-safe `@fusion/core` barrel:** the `engine-core` project resolves `@fusion/core` to `packages/core/src/index.gate.ts` (a project-scoped `resolve.alias`, not the root map), not the full `packages/core/src/index.ts` barrel. `index.gate.ts` is a byte-for-byte copy of the full barrel minus the `export ... from` statements for modules added to the barrel after the last re-audit baseline — i.e. it re-exports everything the full barrel does except genuinely new, gate-irrelevant feature modules (diffed against the prior baseline commit's barrel, not hand-picked from what gate *test* files import — production modules under test pull in far more of the barrel transitively than their own imports suggest). `engine-default`/`engine-reliability`/`engine-slow` are unaffected and keep resolving the full barrel. `@fusion/engine` is untouched (no gate file imports it). When adding a new barrel module that no gate test needs, mirror the exclusion in `index.gate.ts` rather than letting gate wall-time grow — see the FNXC comment at the top of `index.gate.ts` and `packages/engine/vitest.config.ts`'s `engine-core` project for the audit procedure.

<!-- FNXC:EngineTests 2026-07-08-05:30: FN-7669 pre-bundles the gate-safe @fusion/core barrel to attack the FN-7668-identified import-phase-dominated wall-time cost. -->
**Pre-bundled `@fusion/core` gate bundle:** FN-7668 profiled the gate's dominant wall-time cost as vitest/Vite SSR's **import-phase** — each of the 18 `pool:"forks"` OS processes independently re-resolves+evaluates the barrel closure from scratch with zero cross-fork sharing. `engine-core`'s `@fusion/core` alias now points at a single esbuild-bundled ESM file (`scripts/build-engine-core-gate-bundle.mjs`, entrypoint `packages/core/src/index.gate.ts`, `packages:"external"` so only the first-party closure — 220 files — is inlined) instead of directly at `index.gate.ts`'s source, collapsing 220 per-fork Vite SSR module-loader round-trips into 1 file load per fork. The bundle is **rebuilt fresh on every gate invocation** via the `engine-core` project's `globalSetup` (the builder's own esbuild dependency graph determines what gets bundled — never a hand-maintained file/symbol list, so there is no drift surface), and lives at `packages/core/.gate-bundle/core.mjs` — a gitignored, non-committed artifact placed as a **sibling of `packages/core/node_modules/`, deliberately not nested inside it**: nesting inside `node_modules` triggers Vite's SSR external-dep heuristic (loads the whole bundle via Node's native loader, bypassing Vite's mock-interception pipeline) and silently defeats `vi.mock` for imports nested inside the bundle (see the FNXC comment in the builder script for the full repro/fix). Measured A/B (5 alternating runs each, FN-7669 task docs): median real wall-time −5.5%, import-phase aggregate −14.0%, transform-phase aggregate −25.9%, with full coverage parity (335/335 gate tests, identical per-file counts) — a modest but real, reproducible, zero-downside win. `@fusion/engine` stays on the full (unbundled) barrel: no gate file imports it directly, so bundling it would be zero-benefit churn against the core↔engine circular-import DI. Bundling the `@fusion/engine` relative-import graph (`merger.ts` et al., the untouched remainder of FN-7668's ~430-file closure) is a natural, larger-payoff follow-up, filed separately.

## Weekly signal-per-second baseline

Refresh and publish the weekly test velocity baseline with the canonical process in [Weekly test velocity baseline](#weekly-test-velocity-baseline). That workflow measures the merge gate, boot smoke, and changed-only test lanes; appends `scripts/test-velocity-history.json`; and publishes `docs/test-velocity-baseline.md`. Keep the trend flat or net-negative; use its slowest-file and quarantine signals to drive FN-5048 rewrites and deletion-ratchet reviews instead of adding low-signal coverage.

**The gate's blind spot, stated honestly:** typecheck + build + boot smoke + curated suite does not run the union suite a merge creates. Logic regressions outside the curated set land non-blocking by design — that is the accepted trade: the old broad gate caught no recalled real bugs while consuming ~70% of shipping time in flake triage.

## Required workspace gates

Use the narrowest command that exercises the behavior you changed, then broaden before reporting completion.

```bash
pnpm test              # gate suite + changed-only affected tests (bounded; never full-suite)
pnpm test:gate         # the merge gate: curated engine-core suite + CI-shape test
pnpm smoke:boot        # boot smoke: CLI --help + real serve /api/health
pnpm verify:fast       # TEST-FREE: static check:* gates + bootstrap + scoped typecheck/build + CLI build + boot smoke
pnpm test:full         # full workspace suite — explicit opt-in only
pnpm lint              # lint all packages
pnpm build             # build workspace packages (excludes desktop/mobile; skips unchanged plugins safely)
pnpm verify:workspace  # deep opt-in verification: lint -> test:full -> build (NOT the merge gate)
```

<!-- FNXC:TestInfrastructure 2026-06-25-00:00: verify:fast is the opt-in test-free verification path. docs/testing.md observes the broad test gate caught no recalled real bugs while consuming ~70% of shipping time in flake triage; typecheck+build+boot-smoke gives deterministic, flake-free signal without running tests. It changes no default — pnpm test, the merge gate, and CI are untouched; the full suite stays available and runs non-blocking. -->
<!-- FNXC:TestInfrastructure 2026-06-26-00:49: verify:fast must bootstrap missing workspace dist artifacts and build @runfusion/fusion even when the CLI package is not in the changed-package set because package builds and the boot smoke invoke source-checkout wrappers that require dist outputs in fresh worktrees. -->
<!-- FNXC:TestInfrastructure 2026-07-22-12:00: Cheap deterministic policy gates must fail before verify:fast's expensive work. Read canonical package.json pretest commands and invoke their validator entry points directly so test-free verification and the merge gate cannot drift. -->
`pnpm verify:fast` (`scripts/verify-fast.mjs`) is the recommended **test-free verification** command. It first runs the canonical, read-only static validators from root `pretest` — `check-no-nohup`, `check-no-kill-4040`, `check-no-getdatabase`, `check-no-node-only-core-imports-in-dashboard`, `check-pi-versions-pinned`, `check-no-test-timeout-appeasement`, `check-changeset-format`, and `check-routes-modular` — then bootstraps missing/stale workspace dist artifacts, runs **typecheck + build scoped to the changed packages** (reusing the same git-diff / changed-package resolution as `pnpm test`), always builds the `@runfusion/fusion` CLI package required by the source-checkout boot smoke, and runs the existing **boot smoke** once. The static phase invokes each existing validator entry point without update flags, is bounded and fail-fast, and runs **no Vitest or test lane**. It gives deterministic, flake-free signal in seconds, so it is a sound project `testCommand`/verification command when you want non-test verification. With no affected package (root/docs-only diff) it runs static checks, artifact bootstrap, the CLI prerequisite build, and boot smoke. Each step is bounded by the shared `runWithWatchdog` (class `changed`) so a hang fails fast, and it exits nonzero on the first failing step. This is purely additive: it does not change `pnpm test`, the merge gate, or CI, and the full suite stays available (`pnpm test:full`, non-blocking on push to main).

<!-- FNXC:WorkspaceBuild 2026-06-30-00:00: FN-7290 keeps root pnpm build operator-facing while allowing unchanged plugin workspaces to skip their package build only when required dist outputs exist and a git-backed content hash matches the last successful plugin build cache entry. Missing dist, absent entries, changed plugin, declared local workspace-dependency, or root build config/tooling inputs, unavailable git hashes, or cache-version changes must rebuild rather than trust mtimes. -->
`pnpm build` runs `scripts/build-workspace.mjs`: non-plugin workspace packages with build scripts still build on every run (excluding `@fusion/desktop` and `@fusion/mobile`), while plugin packages under `plugins/` and `plugins/examples/` can be skipped when `.fusion/cache/plugin-build-cache.json` records the same content hash as the current plugin package inputs plus declared local workspace-dependency inputs, root TypeScript/pnpm/build-tooling inputs, and all required `dist/` outputs are present. A plugin rebuild is forced for a missing or partial `dist/`, no successful-build cache entry, changed tracked or untracked plugin/dependency/root build inputs, unavailable git content hash, or build-cache version changes. The cache is an optimization only; cache writes are best-effort and a failed package build still makes `pnpm build` exit nonzero with the planned package names.

`pnpm test:full` runs each package's default test script with capped worker fanout (`FUSION_TEST_TOTAL_WORKERS=4 FUSION_TEST_CONCURRENCY=2 pnpm -r --workspace-concurrency=2 test`). Do not casually raise worker counts; dashboard/jsdom and integration-heavy packages destabilize when oversubscribed. Use `VITEST_MAX_WORKERS=<n>` only for targeted package-level investigation.

<!-- FNXC:CustomWorkflowReliability 2026-06-19-00:00: FN-6694 adds an executable custom-workflow reliability release-check lane for QA signoff, but it must stay out of the merge gate so reliability evidence does not inflate every PR's wall-time. -->
Custom workflow reliability release signoff has a dedicated on-demand lane: `pnpm test:workflow-release-check` runs the manifest-listed targeted seams from `scripts/lib/workflow-reliability-release-check.json`, while `--dry-run` validates the manifest and prints planned commands and `--json` emits machine-readable item/seam evidence. This lane is **not** part of the merge gate and should not be added to `test:gate` or the `engine-core` allow-list.

<!-- FNXC:iOSAcceptance 2026-06-18-17:25: Terminal acceptance gates that depend on real mobile Safari must use the credential-driven real-iOS surface runbook instead of treating desktop WebKit or jsdom as evidence. -->
Terminal acceptance tasks that require real mobile Safari should use [`docs/ios-acceptance.md`](./ios-acceptance.md) for the `--check` run-vs-NO-OP probe, credential wiring, and physical/cloud real-iOS evidence workflow.

Agents running verification through `fn_run_verification` are bounded by default: project `verificationCommandTimeoutMs` when set, otherwise 300s for package scope and 900s for workspace scope, with an 1800s hard cap. Marathon invocations such as root `pnpm test`, `pnpm test:full`, `pnpm verify:workspace`, whole-package tests without file filters, and shell repeat loops are soft-capped unless the agent explicitly passes `allowFullSuite: true`; the escape hatch still emits progress heartbeats and respects the hard cap. **Do not pass `allowFullSuite: true` unless absolutely necessary** — it is the main way verification balloons past its budget. Default to a targeted, file-scoped command such as `pnpm --filter @fusion/<pkg> exec vitest run src/path/to/test.ts --silent=passed-only --reporter=dot`; reserve `allowFullSuite` for a genuinely full run with no targetable test set (state the reason), with the thin merge gate (`pnpm test:gate`) as the cross-cutting safety net.

## Fresh-worktree dist bootstrap

`pnpm test` auto-runs `scripts/ensure-test-artifacts.mjs` to rebuild missing/stale dist artifacts. Dashboard and `dependency-graph` package lanes auto-bootstrap too. If you hit opaque `Failed to resolve import "./cli-spawn.js"` (or similar), treat it as bootstrap regression against FN-4605 — don't work around with a manual `pnpm build`.

Public `@fusion/core` exports consumed by runtime tools should include a literal built-dist guard (for example importing `packages/core/dist/index.js`) when package test aliases otherwise resolve `@fusion/core` to source.

## Engine static process guards

<!-- FNXC:EngineProcessRules 2026-06-26-03:58: FN-7056 adds a focused static guard for user-configured command paths. Keep the protected-path registry in the test file, not as a whole-file execSync ban, because engine git plumbing still has legitimate deterministic execSync uses. -->
`packages/engine/src/__tests__/user-configured-command-no-execsync.test.ts` guards user-configured command execution helpers against accidental `execSync` usage or dropped async bounds. Its registry covers verification helpers, `fn_run_verification`, executor configured-command execution, merger post-merge script execution, routine command execution, and the native/bubblewrap/sandbox-exec sandbox backends. Each protected slice must keep the appropriate bounded async safeguard (`timeout`/`timeoutMs`, `maxBuffer`, or `maxLifetimeMs`). The test intentionally slices named function bodies instead of scanning whole files; deterministic git-plumbing `execSync` in merger/self-healing/already-merged/integration/worktree-prune paths and the executor git ancestry check are explicitly out of scope.


## Dashboard Availability & Supervised Mode

<!-- FNXC:DashboardAvailability 2026-06-30-23:20: The dashboard needs a supervised restart mode for long-lived remote access sessions. Planning parse failures now surface as retryable session errors instead of causing process-level exits. -->

When running the dashboard for extended UX review sessions (e.g., Atlas Notes Jony pass via Tailscale Serve), use the `--supervise` flag to prevent unexpected dashboard exits from leaving the Tailscale endpoint returning 502:

```bash
fn dashboard --project atlas-notes --port 4040 --supervise
```

The supervisor runs the dashboard as a child process with **bounded restart attempts** (one initial run plus up to 3 restarts with exponential backoff: 2s → 4s → 8s). Clean exits (SIGINT, SIGTERM, exit 0) propagate without restart. If the child crashes repeatedly, the supervisor gives up after the retry budget and prints actionable diagnostics including the actual restart command and health-check curl.

**Key invariants:**
- Planning sessions that receive non-JSON AI output persist as retryable error state (not process exit)
- `/api/health` remains available during planning session errors
- Remote Tailscale 502 means the local listener on `127.0.0.1:4040` is absent — restart the dashboard
- Check local health: `curl http://127.0.0.1:4040/api/health`

**Process management guardrails still apply:** The supervisor does NOT use `nohup`, shell kill loops, or unbounded retries. It never kills existing processes on port 4040.

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

<!-- FNXC:DashboardStyling 2026-06-19-00:00: FN-6693 promotes the dashboard-wide raw-CSS token-validity guard because jsdom does not resolve custom properties; run `app/__tests__/dashboard-css-token-validity.css.test.ts` with the CSS contract tests when adding component CSS variables or remapping design tokens. -->
The dashboard CSS contract lane includes `app/__tests__/dashboard-css-token-validity.css.test.ts`, which scans raw component/app CSS and fails any `var(--token)` reference that is not defined by CSS, assigned by React inline style, or explicitly allowlisted as runtime-local. Run it with `component-css-no-raw-rgba`, `dashboard-component-color-tokenization`, and `text-token-canonicalization` when touching design-token usage.

<!-- FNXC:CommandCenterTesting 2026-06-18-23:10: FN-6680 proved Command Center mobile chart regressions can pass jsdom because jsdom does not compute flex/grid layout, aspect-ratio, clamp(), min-content shrinking, overflow widths, or resolved heights. -->
<!-- FNXC:CommandCenterTesting 2026-06-19-02:09: FN-6685 added a real emitted-CSS `[data-smoke="command-center-charts"]` fixture so recharts pie/line/empty states are measured in Blink at mobile and desktop breakpoints, including lazy Command Center CSS chunks that index.html does not link directly. -->
Command Center responsive chart fixes need evidence beyond jsdom. Keep the jsdom scroll-owner tests for rule/structure coverage, but pair them with `packages/dashboard/app/components/command-center/__tests__/CommandCenter.mobile-chart-layout.test.ts`, which reads the co-located Command Center CSS files directly and asserts the mobile shrink/height/border rules that real layout depends on. For visible defects, also capture a real browser/device (or headless Chrome/Blink) reproduction with `scrollWidth > clientWidth`, zero/clipped `clientHeight`, or stretch measurements; do not close a Command Center mobile chart bug on jsdom-green assertions alone. The local `pnpm --filter @fusion/dashboard test:browser-smoke --require-browser` lane now includes `[data-smoke="command-center-charts"]` and gates representative Command Center recharts pie, line, and empty states at 390×844 mobile plus desktop viewports for visible SVG/container height, overflow containment, empty-state text, and chart scroll-owner violations.

The shared mobile/tablet overflow-containment net lives at `packages/dashboard/app/__tests__/dashboard-overflow-containment.test.tsx`. It covers board/kanban columns, task-detail modal shell, workflow/simple workflow editors, and Activity Log modal at mobile, tablet, and landscape-phone breakpoints. Run it directly when touching dashboard viewport containment or shared modal/workflow CSS:

```bash
pnpm --filter @fusion/dashboard exec vitest run --project dashboard-app app/__tests__/dashboard-overflow-containment.test.tsx --silent=passed-only --reporter=dot --exclude '**/build-output.test.ts'
```

`pnpm --filter @fusion/dashboard test` runs the curated app/API quality gate through
`packages/dashboard/scripts/run-quality-tests.mjs` (FN-6308). The orchestrator keeps
the historical app/API quality split and the curated/backfill lane boundaries, but
schedules independent lanes with bounded process concurrency instead of chaining every
Vitest launch sequentially. Each lane still runs through
`packages/dashboard/scripts/run-vitest-with-heap.mjs --heap=6144`; do not bypass that
wrapper or recombine the jsdom-heavy app/API projects, because the old combined run
was SIGKILLed by heap pressure under workspace worker budgeting. The top-level
`pretest` artifact bootstrap runs once before the orchestrator; lane subprocesses must
not re-run `scripts/ensure-test-artifacts.mjs`.

<!-- FNXC:TestInfrastructure 2026-06-21-12:21: FN-6854 applies the dashboard heap-runner pattern to the engine affected-package lane because a wide `vitest --changed` fan-out selected hundreds of real-git-heavy engine files and could be OS-SIGKILLed by heap pressure before Vitest returned a verdict. Keep the engine lane isolated, heap-capped, and lower-worker rather than raising concurrency or widening timeouts.

FNXC:TestInfrastructure 2026-06-21-16:28: FN-6877 applies the same changed-mode envelope to the dashboard scoped affected lane because FN-6874 showed App/jsdom changed runs could be OS-OOM-killed even with inbound test concurrency already set to 1. Keep the per-lane watchdog finite and outside the env; the envelope is a heap-pressure guard, not a hang-budget increase.

FNXC:TestInfrastructure 2026-06-25-18:58: FN-7026 caps scoped affected watchdogs below the default 15min workspace verification timeout. A stale comparison base can make `vitest --changed` select thousands of live, git-heavy engine tests; the script watchdog must fail first with diagnostics instead of letting the executor kill root `pnpm test` and restart the whole sweep. -->
When `scripts/test-changed.mjs` runs affected-package `vitest --changed` scopes, `@fusion/engine` and `@fusion/dashboard` are each split out from other scopable packages into their own dedicated memory-envelope run: `NODE_OPTIONS=--max-old-space-size=6144` plus `FUSION_TEST_TOTAL_WORKERS=1`, `FUSION_TEST_CONCURRENCY=1`, and `VITEST_MAX_WORKERS=1`. All other scopable packages remain in the shared non-envelope group, and packages without a Vitest config still fall back to their package `test` scripts. The envelopes use a scoped affected watchdog ceiling below the default workspace verification timeout, so the expected failure mode is a normal Vitest pass/fail or script watchdog timeout, not raw pnpm `SIGKILL` or executor timeout restart. Re-measure with a wide changed selection (for example a dirty `packages/core/src/index.ts` boundary edit for engine, or an App/jsdom-affecting dashboard diff) before changing either envelope.

<!-- FNXC:TestInfrastructure 2026-06-25-14:30: wide `vitest --changed` fan-out guard. The 1-worker envelope above fixed OOM but NOT wall-clock: `vitest --changed <base>` does unbounded transitive graph expansion, so one hub source edit (measured: a `packages/engine/src/self-healing.ts` change selected 8393 matched test entries; just *listing* them took ~79s) runs ~the full suite at one worker and blows past the engine's 15-min per-task verification timeout (`VERIFICATION_TIMEOUT_WORKSPACE_MS=900_000`). The engine then SIGKILLs `pnpm test` mid-run and restarts the task, stacking 15-min timeouts (~9 observed in one task). The fan-out only triggers when a NON-test source file in the package's module graph changes, so the guard keeps the bounded contract: for engine/dashboard, a changed source file in-graph makes the lane run ONLY the directly-changed test files and delegate wider coverage to the merge-gate suite (which runs first in changed mode), mirroring the reverse-dependent blast cap; a test-file-only diff still runs `vitest --changed`. `pnpm test:full` is the explicit full sweep. Implemented via `changedSourceFilesAffectingPackage` in `scripts/test-changed.mjs`; do not "fix" this by raising workers or widening the watchdog. -->
For the heavy envelope packages this lane is additionally bounded against wide `vitest --changed` graph fan-out: when a changed non-test source file falls in the package's own dir or any transitive workspace-dependency dir, the affected lane runs only the directly-changed test file(s) and delegates the rest to the merge-gate suite, so a single hub edit can no longer expand into a near-full suite that exceeds the 15-min verification timeout. Pure test-file changes still run the normal `vitest --changed` scope.

Concurrency knobs:

- `FUSION_DASHBOARD_TEST_CONCURRENCY` controls dashboard quality lane process
  concurrency, defaulting to `2` and hard-capped at `2` to preserve the measured heap
  budget.
- Per-lane heap is fixed at `6144` MiB by the orchestrator. Treat any code change that
  makes this configurable or increases it as risky and re-measure for OOM/SIGKILL before
  landing.
- `FUSION_TEST_TOTAL_WORKERS` / `FUSION_TEST_CONCURRENCY` (or targeted
  `VITEST_MAX_WORKERS`) still bound Vitest thread fan-out inside each process via
  `computeMaxWorkers`; do not raise them casually for dashboard/jsdom runs.

New test files under `app/**` or `src/**` are picked up automatically by the
**backfill lanes** (`dashboard-app-quality-backfill` / `dashboard-api-quality-backfill`),
which include the broad globs and exclude only the files an explicit curated lane
already runs plus the skip-list. You do not need to register a new file by hand for
it to run — the curated-gate hole that silently skipped unenumerated files is closed
(see "Curated-gate completeness" below). Add a file to a curated `qualityApp*`/`qualityApi`
list only when you want it in a specific fast lane rather than the backfill catch-all.

## Curated-gate completeness and the skip-list

The dashboard quality gate is a chain of curated lanes plus two backfill lanes.
Together they must execute **every** `*.test.{ts,tsx}` under `packages/dashboard/app`
and `packages/dashboard/src`, or the file must be on the reviewed skip-list. This is
enforced by a guard (CI job `Dashboard curated-gate guard` in `full-suite.yml`, non-blocking):

```bash
node scripts/check-test-inventory.mjs --dashboard-curated
```

It fails when a dashboard test file is neither executed by a quality project nor
skip-listed. The skip-list lives at `scripts/lib/dashboard-curated-skiplist.json`;
every entry needs a non-empty `reason` (empty reasons are rejected). Skip-list policy:

- A file goes on the skip-list only when it genuinely cannot be gated yet — today
  that is pre-existing-failing orphans (tests that were never executed in CI and
  fail in isolation) and `build-output.test.ts` (runs standalone via `test:build`
  after a Vite build). Each carries a one-line reason.
- <!-- FNXC:DashboardTesting 2026-06-14-08:00: Skip-listed dashboard tests need actionable ownership; placeholder IDs block rescue/delete follow-through, so every non-standalone reason cites a concrete Fusion tracking task. --> Every skip-list `reason` for a pre-existing failing/orphaned test must reference a concrete `FN-NNNN` tracking task; if the test is rescued, remove the entry instead of leaving a tracking placeholder.
- <!-- FNXC:DashboardTesting 2026-06-14-10:27: FN-6445 closes the useChatRooms.test.ts tracking drift from FN-6442: a skip-list entry that is already matched by any quality project is not a genuine ungated orphan and would overstate the orphan count. --> The guard rejects any skip-list entry whose file is already executed by a quality project. Remove the entry instead; the skip-list is only for genuinely non-executed files.
- To remove a file from the skip-list: fix the test, confirm it passes under its
  project, delete the skip-list entry. The backfill lane then executes it.
- The skip-list is shared verbatim with `vitest.config.ts`, which excludes the same
  globs from the backfill projects — one source of truth.

## Test-inventory harness

`scripts/check-test-inventory.mjs` is the standard coverage-superset verification
step. Node stdlib only.

```bash
# Snapshot the executed-test inventory (per package/project, normalized test ids).
node scripts/check-test-inventory.mjs --capture before.json
# ... make a change ...
node scripts/check-test-inventory.mjs --capture after.json
# Fail (exit 1) if any test id present in `before` is missing from `after`.
node scripts/check-test-inventory.mjs --diff before.json after.json
```

The capture spec (which packages/projects to enumerate) lives in
`scripts/lib/test-inventory-spec.json`. The diff lists the exact missing test ids;
a renamed file shows up as a remove (old path) + add (new path), so the rename is
reviewable. New test ids never fail the diff.

## Engine slow tier (non-blocking CI)

The `engine-slow` vitest project (`packages/engine/src/**/*.slow.test.ts`) holds the
long real-git suites. It runs locally via `pnpm --filter @fusion/engine test:slow` and
in CI via the `Engine slow tier` job in `full-suite.yml` (non-blocking, push to main), which uses
`scripts/assert-engine-slow-nonempty.mjs` to **fail if zero tests executed** (so a glob
or config drift that silently empties the tier breaks the run instead of passing vacuously).
The CI job uses `fetch-depth: 0` because these tests run real git operations.

## Quarantine ledger and the deletion ratchet

Flaky tests are quarantined ON SIGHT and deleted on a 2-week clock. This is written policy with minimal mechanics — deliberately no loader module, no automation (see the AGENTS.md standing rule "Flaky Tests Are Quarantined on Sight").

**To quarantine a test** (a test that failed without a corresponding real bug in the change), in one commit:

1. Add an entry to `scripts/lib/test-quarantine.json`:
   `{ "file": "<repo-relative test path>", "reason": "<why + link to the failing run>", "quarantinedAt": "YYYY-MM-DD" }`
2. Add a matching one-line `exclude` entry to that package's vitest config.

**The clock:** an entry expires 14 days after `quarantinedAt`. Whoever touches the suite and finds an expired entry deletes the test file, its ledger entry, and its config exclude (git history is the archive). `scripts/check-test-inventory.mjs --diff` stays deliberately unwired in CI because it would fail on exactly these deletions.

### Quarantine deadline visibility check

Run `pnpm check:quarantine-ledger` to print a soonest-deadline-first summary of `scripts/lib/test-quarantine.json`. The command uses the same 14-day deletion clock (`quarantinedAt + 14d`) as the velocity baseline and reports each entry as expired, near-deadline, healthy, or unknown when `quarantinedAt` is missing/invalid. It is a visibility aid only: default mode exits 0 even when entries are near or expired, preserving the deliberately-unwired policy and leaving rescue-or-delete decisions to maintainers.

Flags:

- `--warn-within=<days>` changes the near-deadline window from the default 5 days.
- `--json` emits the computed rows plus summary counts for machine consumption.
- `--strict` exits 1 when any entry is expired or near-deadline, for opt-in local or project-specific gates only. Do not wire this into `pretest`, `test:gate`, or other default blocking lanes without an explicit policy change.

**Rescue** (before the clock runs out) requires both: evidence the test catches real regressions, and a root-cause fix for the flake. Stabilization passes — widened timeouts, retries, loosened assertions — are appeasement, not rescue, and are banned (for agents especially).

### Vitest timeout-appeasement guard

`scripts/check-no-test-timeout-appeasement.mjs` runs in the fast `pretest`, `pretest:full`, and `test:gate` paths. It scans tracked `packages/**/*.test.*` and `plugins/**/*.test.*` files for per-file or suite-level Vitest timeout bumps, including `vi.setConfig({ testTimeout: ... })`, `vi.setConfig({ hookTimeout: ... })`, and bare `testTimeout:` / `hookTimeout:` properties in test files. It deliberately ignores global `vitest.config.*` timeouts.

Legitimate legacy exceptions must be recorded in `scripts/lib/test-timeout-appeasement-allowlist.json` as `{ "file": "<repo-relative test path>", "reason": "<owning cleanup/quarantine task and rationale>", "allowlistedAt": "YYYY-MM-DD" }`. Allowlisting is temporary: the real fix is to quarantine the flaky test or narrow the slow seam, then remove both the timeout bump and the allowlist entry.

**CLI shared-fixture rescue pattern (FN-6430):** the 2026-06-14 `@runfusion/fusion` quarantine batch passed direct runs but timed out or bled state only under package/workspace load. The rescue fixed the shared isolation seam, not the timeout: sweep stale top-level `fn-test-home-*` roots with a bounded one-level prefix scan, reject inherited `HOME` values that do not live under the current `fusion-test-workers-*` root, recreate/remark the worker root before each `mkdtemp`, reset module/singleton fixture state in the affected suites, close real stores created by research helpers, and narrow slow real-store seams by moving package imports out of timed test bodies. When rescuing a similar CLI batch, prove it with repeated rescued-file runs plus `pnpm --filter @runfusion/fusion test`, audit rescued files for `vi.setConfig`/`testTimeout`/`hookTimeout` appeasement, and keep ledger/config removals in the same commit.

**Non-CLI quarantine sweep pattern (FN-6433):** for engine/core/dashboard batches, first remove quarantine excludes only in temporary local configs and run the exact quarantined files together so suite-load coupling is visible before editing the ledger. Rescue is valid when the grouped package lane proves the invariant now holds (for example, FN-6433 fixed engine cross-file interference by replacing broad `activeSessionRegistry.clear()` cleanup with path-scoped unregistering) or when a prior shared-fixture fix is demonstrated under package load. Delete duplicate/low-value files under the ratchet when another deterministic suite owns the same invariant. Finish by making `scripts/lib/test-quarantine.json` and every package Vitest exclude array converge in one commit, then prove the empty/non-empty state with package lanes, `pnpm test:gate`, `pnpm test`, `pnpm build`, and the bounded temp-leak output from `pnpm test`.

**2026-06-15 rescue batch (FN-6486):** two same-day quarantines were rescued before their 2026-06-29 deletion deadline. `store-concurrent-writes.test.ts` kept its WAL/`transactionImmediate` regression value by making the external lock helper's timed release use synchronous `Atomics.wait` inside the child process, removing event-loop timer scheduling as the load-only flake source without widening retry windows. `extension-task-tools.test.ts` kept its worktree-root task-tool coverage by closing each real `TaskStore` fixture before temp-root removal and using non-hoisted mock cleanup. The reusable pattern is to remove scheduler/resource leaks in the helper or fixture seam, then prove the rescue with repeated exact-file runs plus package lanes, not with timeout bumps, retries, assertion loosening, or worker changes.

**2026-06-17 core cleanup rescue (FN-6600):** a broad `@fusion/core` timeout cluster was accompanied by `fusion-test-workers-*` `ENOTEMPTY`, while the named files passed in isolation and then under the package lane with the broad-run worker budget. The rescue hardened the shared worker-root teardown's bounded `ENOTEMPTY`/`EBUSY` retry window and added explicit cleanup-invariant coverage, then removed the same-day core quarantine entries in ledger/config lockstep after proving the unexcluded package lane. Reusable pattern: when multiple core files fail with a shared worker-root cleanup signature, fix or prove the shared cleanup seam first; only quarantine residual files after the loaded unexcluded core lane still fails without a seam fix.

**2026-06-18 engine isolation rescue (FN-6610):** a full `@fusion/engine` lane reported unrelated expectation drift, vanished-cwd/git-config errors, and SQLite `unable to open database file` failures. The reusable isolation fix is to revalidate the shared test cwd/HOME/worker-root seam at the operation boundary: subprocess wrappers recreate the owned worker root, HOME, and cwd immediately before `git`, direct SQLite setup helpers recreate their redirected `.fusion` parent before `DatabaseSync`, and regression coverage removes the redirect sink/HOME/cwd mid-test before proving `mkdtemp`, SQLite open, and git config all still work. Do not mask this class with retries, worker reductions, or timeout bumps; quarantine only residual files after the shared seam and direct-open parents are proven under package load.

<!-- FNXC:CliTestReliability 2026-06-19-13:32: FN-6734 found the same CLI affected-lane symptom can mix leaked real TaskStore handles, oversized truncation fixtures, and runtime-dist mocking order. Rescue this class by closing stores before fixture cleanup, keeping truncation data deterministic but small, and importing complete built barrels through Vitest before doMock; do not reduce workers, widen timeouts, or add quarantine entries unless the loaded package lane still fails after those seams are proven. -->

**2026-06-19 CLI affected-lane rescue (FN-6734):** a broad `@runfusion/fusion` lane reported default 5s test-body timeouts and `fusion-test-workers-*`/fixture `ENOTEMPTY` cleanup noise while isolated files exposed closeable real-store handles and a runtime-dist mock that was sensitive to package-lane module graph ordering. The rescue closed each real `TaskStore`/`AgentStore` before removing its temp fixture, kept task-list truncation coverage under the default timeout by reducing filler size rather than assertions, and preloaded the built `@fusion/core` barrel with `vi.importActual` before `vi.doMock` so complete dist artifacts exercise the CLI surface while partial stale dist skips cleanly. Prove this class with targeted file runs, `pnpm --filter @runfusion/fusion test`, the timeout-appeasement guard, bounded temp-prefix cleanup output, and the normal workspace gate/build; leave the CLI quarantine array empty when no file is actually quarantined.

<!-- FNXC:EngineTestReliability 2026-06-27-10:05: FN-7119 rescued the 2026-06-26 engine scheduler/reliability quarantine burst by completing local TaskStore fakes for the scheduler heartbeat `updateSettings({ engineLastActiveAt })` write before adjusting any call-count assertions. When a scheduler batch reports zero mock calls or missing audit events after a heartbeat-era scheduler change, first mirror the production store surface in shared fakes and re-run the exact files together under `engine-default` / `engine-reliability`; do not weaken call-count invariants or quarantine ledger/config rows after the fake drift is fixed. -->

<!-- FNXC:TestQuarantine 2026-06-19-14:15: FN-6740 audited the same-day quarantine ledger as a coordinated deletion-ratchet batch. The ledger had 14 entries (3 dashboard, 6 core, 5 CLI) and every entry was mirrored in its package Vitest exclude; keep follow-up rescue/delete work scoped by subsystem so ledger/config edits remain lockstep and do not collide. -->

**2026-06-19 quarantine audit (FN-6740):** the 2026-06-19 ledger batch expires on **2026-07-03**. FN-6740 found no ledger/config half-state and chose no inline rescue/delete. The five CLI files (`extension-goal-tools`, `extension-mission-goal-tools`, `extension-task-tools`, `extension`, `research-extension-tools`) are explicitly deferred to FN-6734's outcome and must not get a duplicate rescue task. Five core files (`activity-analytics`, `db`, `store-create-summarize-deferred-hook`, `vitest-teardown-worker-root-cleanup`, `settings-export`) were rescued by FN-6741 after the loaded `@fusion/core` lane passed with only `store-concurrent-writes` re-quarantined; `settings-export` now closes its `TaskStore` before fixture cleanup. The dashboard files were split by likely root cause: FN-6742 rescued `session-cross-tab` cleanup `ENOTEMPTY` by closing the route/task-store seam before fixture removal; FN-6743 owns the third-repeat QuickEntryBox focus-restoration race after FN-6514/FN-6642; and FN-6744 rescued WorkflowNodeEditor duplicate-merge-seam concurrency by making fragment seam conflicts consult the loaded workflow IR before React Flow canvas nodes finish materializing. Until the remaining dashboard and core follow-ups rescue with root-cause evidence or delete under the ratchet, leave all corresponding ledger entries and package excludes in lockstep.

<!-- FNXC:CoreTests 2026-06-19-14:55: FN-6741 rescued five same-day @fusion/core quarantine entries after proving the broad core lane with only store-concurrent-writes still failing, then removed ledger/config entries in lockstep for the rescued files. Keep this rescue pattern evidence-driven: fix close-order leaks such as TaskStore handles before fixture cleanup, prove the package lane, and do not replace quarantine removal with timeout, retry, or worker-count appeasement.

FNXC:CoreTests 2026-06-19-15:05: Merge verification re-observed store-concurrent-writes failing under broad @fusion/core load with SQLite BEGIN IMMEDIATE lock exhaustion. Keep that single file quarantined until a root-cause fix proves the transient-lock regression under suite load; do not widen SQLite recovery timing to appease the flake. -->

**2026-06-19 core suite-load rescue (FN-6741):** `activity-analytics.test.ts`, `db.test.ts`, `store-create-summarize-deferred-hook.test.ts`, `vitest-teardown-worker-root-cleanup.test.ts`, and `settings-export.test.ts` were rescued before their 2026-07-03 deletion deadline. The key evidence was a loaded `pnpm --filter @fusion/core test` pass across the package after re-quarantining `store-concurrent-writes.test.ts`, with no `ENOTEMPTY`, `EBUSY`, hook timeout, or missed deferred hook in the rescued files. Four files needed no weakening because their regression value still held under load; `settings-export.test.ts` kept its import/export coverage but now closes the real `TaskStore` before removing the fixture root. `store-concurrent-writes.test.ts` remains in the deletion ratchet after merge verification re-observed the broad-lane SQLite lock flake. Required closure evidence for this class is ledger/config convergence, the rescued package lane, the timeout-appeasement guard, `pnpm test:gate`, `pnpm test`, `pnpm typecheck`, and `pnpm build`.

<!-- FNXC:CoreTests 2026-06-20-05:28: FN-6790 proved a loaded @fusion/core ENOENT can come from TaskStore deferred task-created work that writes task.json after close while a fixture removes the root. Rescue this class by making close quiesce active deferred write/hook work and skip late work after closing; prove it with a controlled deferred-summarizer regression, loaded core lane, timeout-appeasement guard, and bounded temp-prefix output, not retries, timeouts, or worker reductions. -->

**2026-06-20 core task-documents rescue (FN-6790):** `packages/core/src/__tests__/task-documents.test.ts` stays loaded and unquarantined. The broad-lane symptom was an `ENOENT` during atomic `task.json` rename; the root-cause class is fire-and-forget `TaskStore` deferred task-created work (title summarization and task-created hook) entering an update after `store.close()` while the fixture root is being removed. The fix tracks active post-summarization write/hook work, makes `close()` mark the store as closing and await active work, and skips late deferred work that has not entered the write phase so intentionally stalled summarizers do not hang teardown. The regression test releases a controlled deferred summarizer only after close and root removal, then asserts the fixture root is not recreated. Closure evidence is targeted file coverage, a loaded `pnpm --filter @fusion/core test` pass, timeout-appeasement guard, bounded `fusion-test-workers-*`/`kb-task-docs-test-*` output, `pnpm test:gate`, `pnpm test`, `pnpm typecheck`, and `pnpm build`; no quarantine ledger/config entries or timeout/worker appeasement are allowed for this file.

<!-- FNXC:CliTests 2026-06-20-10:09: FN-6795 rescued `store-concurrent-writes.test.ts`, `extension-goal-tools.test.ts`, `extension-mission-goal-tools.test.ts`, and `research-extension-tools.test.ts` after targeted and loaded lanes passed, but retained/re-quarantined `extension-task-tools.test.ts`, `extension.test.ts`, and newly observed `bin.test.ts` because the full @runfusion/fusion package lane still produced suite-load-only timeouts. Keep ledger/config lockstep and let the 2026-06-19 residual entries delete on 2026-07-03 unless a fixture-load root cause is fixed; do not widen timeouts, add retries, or change worker budgets. -->

**2026-06-20 residual CLI quarantine triage (FN-6795):** the six `2026-06-19` residual entries were temporarily unexcluded and exercised under targeted and loaded lanes. `store-concurrent-writes.test.ts`, `extension-goal-tools.test.ts`, `extension-mission-goal-tools.test.ts`, and `research-extension-tools.test.ts` were rescued because their direct and package/gate lanes stayed green with no `ENOTEMPTY`, lock exhaustion, or cross-test state drift. The final full `@runfusion/fusion` lane still timed out `extension-task-tools.test.ts`, `extension.test.ts`, and a newly observed `bin.test.ts` case only under package load while the focused rerun passed, so those files remain quarantined in ledger/config lockstep with the original 2026-07-03 deletion deadline for the two 2026-06-19 residuals. Treat future work as a fixture-load root-cause search, not timeout/retry/worker appeasement.

<!-- FNXC:CliTests 2026-06-21-09:58: FN-6839 rescued the retained `bin.test.ts`, `extension-task-tools.test.ts`, and `extension.test.ts` entries by proving the remaining root cause was not a task-created-hook-only skip but unawaited async TaskStore/cache shutdown before temp-root removal. Await cached/direct store closes, prove grouped and full package lanes unexcluded, and keep ledger/config empty for these files unless a new invariant fails. -->

**2026-06-21 retained CLI quarantine rescue (FN-6839):** `bin.test.ts`, `extension-task-tools.test.ts`, and `extension.test.ts` were rescued before their 2026-07-03/2026-07-04 deletion deadlines. The failed prior attempt to skip `task:created` hooks ruled out a hook-only root cause; the real reusable invariant is that `TaskStore.close()` is async and must be awaited for both extension cached stores and direct fixture stores before removing temp roots, otherwise deferred filesystem work and SQLite/WAL handles can survive under loaded `@runfusion/fusion` workers. `closeCachedStores()` now awaits each cached store close, the quarantined fixtures await direct/cached shutdown, and the extension regression test asserts cached shutdown does not resolve before async close settles. The three ledger entries and `packages/cli/vitest.config.ts` excludes were removed in lockstep; the grouped three-file lane and full CLI package lane pass unexcluded with no hook/body timeout, no `ENOTEMPTY`/`EBUSY`, and no timeout/retry/worker appeasement. The broader `pnpm test` command is currently blocked before tests by unrelated line-count guardrail failures tracked by FN-6849, not by these rescued CLI files.

<!-- FNXC:DashboardSessionTests 2026-06-19-16:19: FN-6742 proved dashboard session cross-tab coverage still catches real lock-holder regressions under mutation, but its route-only harness leaked TaskStore-backed `.fusion` cleanup work under a loaded shard. Rescue this class by disposing the API router, stopping scheduled session cleanup, closing stores/databases, and draining bounded check turns before removing the worker fixture; do not widen timeouts, add retries, or reduce worker load. -->

**2026-06-19 dashboard session-cross-tab rescue (FN-6742):** `packages/dashboard/src/__tests__/session-cross-tab.test.ts` was rescued before its 2026-07-03 deletion deadline. The loaded `dashboard-api-quality-backfill` shard reproduced the original `fusion-test-workers-*` `ENOTEMPTY` cleanup failure with the quarantine exclude temporarily removed, while the test's assertions retained value by failing when the expected lock holder was mutated from `tab-a` to `tab-z`. The fix keeps the test unquarantined by disposing the created API router, stopping `AiSessionStore` scheduled cleanup, closing the real `TaskStore`/SQLite handles, hiding route EventEmitter hooks not used by this harness, and draining four bounded check-phase turns before deleting the temp root. The ledger and `packages/dashboard/vitest.config.ts` exclude were updated in lockstep; later loaded runs no longer failed this file, and unrelated dashboard loaded-suite failures are tracked separately rather than weakening this test.

<!-- FNXC:DashboardTests 2026-06-21-12:55: FN-6860 found dashboard quarantine ledger/config drift after earlier rescues: session-cross-tab was still ledger-only, while dev-server-process remained excluded. Treat dashboard rescue closure as a loaded-shard proof plus same-commit ledger/config convergence; stale ledger-only entries should be removed after loaded proof, not re-quarantined.

FNXC:DashboardTests 2026-06-22-18:05: FN-6937 found FN-6860's session-cross-tab ledger-removal claim had not landed at HEAD even though the Vitest exclude was already absent. Confirm the ledger JSON at HEAD before declaring dashboard quarantine cleanup complete, then remove ledger-only stale entries after loaded-shard proof rather than re-adding excludes. -->

**2026-06-21 dashboard quarantine lockstep cleanup (FN-6860):** `packages/dashboard/src/__tests__/dev-server-process.test.ts` and `packages/dashboard/src/__tests__/session-cross-tab.test.ts` were intended to be cleared from the deletion ratchet after repeated `dashboard-api-quality-backfill` loaded-shard runs passed with the excludes removed. `dev-server-process` kept its process-lifecycle regression value by tracking lifecycle generations, disposed state, active stdout/stderr line work, and fallback probe work before close/failure cleanup resolves; its tests now assert duplicate URL detection is suppressed and probe timers are cleared on failure/restart/cleanup. `session-cross-tab` needed no code change in this batch because it was already active in Vitest config, but FN-6937 later found the stale ledger-only entry still present at HEAD. Closure evidence for this class is the grouped rescued-file lane, full `test:quality:api:backfill` runs, ledger/config empty-state convergence, lint, gate, `pnpm test`, and build, with no timeout/retry/worker appeasement.

**2026-06-22 stale ledger-only dashboard cleanup (FN-6937):** `packages/dashboard/src/__tests__/session-cross-tab.test.ts` was already active because `packages/dashboard/vitest.config.ts` had no quarantine exclude. FN-6937 reconfirmed the rescue under the loaded `dashboard-api-quality-backfill` shard, mutation-tested the lock-holder assertion by changing `tab-a` to `tab-z` and observing the expected failure, reverted the mutation, reran the loaded shard cleanly, and then removed the stale ledger-only row from `scripts/lib/test-quarantine.json`. Required closure evidence is ledger/config convergence, no `session-cross-tab` ledger match, the loaded backfill shard, the timeout-appeasement guard, bounded temp-prefix output showing no `kb-session-cross-tab-*` roots, `pnpm lint`, `pnpm test`, and `pnpm build`.

<!-- FNXC:WorkflowNodeEditorTests 2026-06-19-18:24: FN-6744 proved WorkflowNodeEditor duplicate-merge coverage still catches a real product race: the palette can be used after workflow IR loads but before React Flow nodes exist. Rescue this class by checking seam conflicts against the authoritative loaded IR during initial canvas materialization, then prove desktop and mobile conflict surfaces under the loaded dashboard components-b lane; do not add waits, retries, worker reductions, or timeout appeasement. -->

**2026-06-19 dashboard WorkflowNodeEditor rescue (FN-6744):** `packages/dashboard/app/components/__tests__/WorkflowNodeEditor.test.tsx` was rescued before its 2026-07-03 deletion deadline. The original duplicate-merge test passed in isolation but was load-sensitive because `handleInsertFragment` derived existing seams only from transient React Flow nodes; a fast palette click could arrive after `activeWorkflow.ir` loaded but before the canvas nodes materialized, allowing an invalid duplicate merge seam instead of showing the conflict alert. The fix keeps the test unquarantined by treating IR merge nodes as the merge seam and by unioning seams from the loaded IR only during initial canvas materialization, preserving post-load canvas-state semantics. Regression coverage now exercises both desktop and mobile fragment insertion surfaces and asserts the conflict affordance appears without growing the rendered graph. The ledger and `packages/dashboard/vitest.config.ts` exclude were removed in lockstep; targeted file runs, repeated `test:quality:app:components-b`, lint, gate, typecheck, and build are the closure evidence. A broader `@fusion/dashboard test` run currently fails unrelated Command Center ProductivityArea mock drift tracked by FN-6754, so do not re-quarantine WorkflowNodeEditor for that lane.

<!-- FNXC:DashboardTests 2026-06-19-22:14: FN-6753 classified `routes-auth.test.ts` as suite-load coupled rather than a proven low-value flake: it timed out in the broad dashboard API backfill shard, but repeated loaded local shard runs did not isolate a root-cause teardown or probe-spy leak. Keep auth-critical assertions active by moving the file into the curated dashboard API shard and out of the contended backfill glob; do not quarantine, widen timeouts, retry, or reduce worker load without new root-cause evidence. -->

**2026-06-19 dashboard API shard isolation (FN-6753):** `packages/dashboard/src/__tests__/routes-auth.test.ts` is classified as **suite-load coupling**. The observed symptom was a timeout only under the broad `dashboard-api-quality-backfill` shard; five loaded local runs of the isolated shard did not expose a concrete teardown, probe-spy, or product-code root cause. The remedy is shard isolation, not quarantine: keep `routes-auth` in the curated `dashboard-api-quality` include list so authentication coverage stays active, and let `backfillApiExclude` remove it from the broad `src/**/*.test.ts` backfill glob. Use the same pattern for critical route suites that fail only under broad backfill contention after loaded local proof cannot identify an owned fixture seam: preserve coverage in a curated shard, document the classification, and avoid timeout bumps, retries, worker reductions, or ledger entries unless a later loaded run proves a real flaky file that needs the deletion ratchet.

**2026-06-16 rescue (FN-6514):** `packages/dashboard/app/components/__tests__/QuickEntryBox.test.tsx` was rescued before its 2026-06-30 deletion deadline. The file still caught real quick-entry behavior regressions, but it leaked jsdom descriptors for `window.innerWidth`, `window.matchMedia`, `document.visibilityState`, `URL.createObjectURL`, and `URL.revokeObjectURL`; a mobile viewport helper could leave later tests in the same dashboard backfill shard observing `innerWidth=375` and mismatched responsive assertions. The rescue removed the ledger/config quarantine entries in lockstep, captured each original `PropertyDescriptor` at module load, restored those descriptors (or deleted own properties that were originally absent) in `afterEach`, and added a guard test that mutates all rescued globals before asserting they return to their original descriptors. Reusable pattern: any test file that changes jsdom globals with `Object.defineProperty` or spies on replaceable globals must snapshot the original descriptor at the top of the file, restore it in every `afterEach`, and prove the invariant with a guard test; do not use timeout bumps, retries, worker changes, or blanket `vi.restoreAllMocks()` when module mocks depend on stable implementations.

**Gate eviction:** a flake inside the merge gate cannot block all merges while red — it is evicted by removing its line from the `engine-core` allow-list (no quarantine entry needed unless it should also leave the non-blocking tier).

**Gate admission:** the mirror operation — add the test's path to the `engine-core` `include` array in `packages/engine/vitest.config.ts`, citing the evidence of value (a real regression it caught) in the PR. Keep the project under its ~60s wall-clock budget.

**Product-race escalation:** a second quarantine in the same subsystem is a smell that the flake is a real product race, not test noise — look at the product code before deleting (a dashboard flake was "stabilized" three times before being found to be a real race; see `docs/solutions/ui-bugs/skill-autocomplete-highlight-reset-on-swr-revalidation.md`).

## CI shard balancing (duration-weighted)

`scripts/ci-test-shard.mjs` packs the 4 CI shards (`pnpm test:ci:shard --shard N --total 4`,
called from `full-suite.yml`, non-blocking) by **measured duration**, not test-file count, using the
committed `scripts/test-timings.json` snapshot (U1/R4). A package's weight is the sum of
its files' recorded durations; files (or whole packages) absent from the snapshot fall
back to the snapshot's **median per-file duration** so untimed packages weigh
commensurably. Untimed packages are named in a logged warning.

- **Engine** keeps `vitest --shard X/Y` virtual slicing (its `test` is a single vitest
  invocation: `--project=engine-default --project=engine-reliability`); slices are now
  weighted by duration.
- **Dashboard** is *not* `--shard`-sliced — its default `test` script is a bounded
  concurrent lane orchestrator, so a forwarded `--shard` cannot apply coherently. Instead
  each leaf quality lane (enumerated programmatically from `packages/dashboard/package.json`
  and the dashboard quality orchestrator) is a separately-weighted schedulable unit; a shard
  runs `pnpm --filter @fusion/dashboard run <lane>` for its assigned lanes. Every lane is
  assigned to exactly one shard. **Lane weight** is the sum of durations of
  the files the lane's `--project`s execute, derived from the vitest config project
  `include`/`exclude` globs (imported via `tsx`); if the config cannot be imported the
  package duration is apportioned evenly across lanes (logged as `even-apportionment`).
- **Inspect the plan without running it:** `node scripts/ci-test-shard.mjs --dry-run --total 4`
  (optionally `--shard N`) prints the planned `pnpm` commands and per-shard weight totals.
- **Measure per-process startup cost:** `node scripts/ci-test-shard.mjs --cold-start-probe <package-name>`
  runs the package's cheapest test file in isolation and reports `wall − test time` overhead
  (the signal behind the deferred vitest-4 upgrade gate).

### Snapshot staleness policy

The snapshot carries `capturedAt`. If it is older than **30 days**, the planner prints a
prominent warning and proceeds (balance degrades gracefully toward the file-count status
quo, never below it) — it does **not** fail the build. Refresh is **manual/scheduled from
the default branch only**: each CI shard uploads per-shard JSON timing artifacts (U1), and
`node scripts/ci-test-shard.mjs --write-timings` merges them into the snapshot. Download the
shard artifacts into `.timings/` first (the default lookup directory), or pass
`--inputs-dir <path>` to point at wherever they were downloaded. A future
scheduled job can gate on freshness via `node scripts/ci-test-shard.mjs --check-timings-staleness`,
which exits non-zero when the snapshot is missing or older than the 30-day budget.

## Weekly test velocity baseline

FN-6612 tracks feedback-loop velocity as signal-per-second, not as a new blocking gate. Refresh the weekly baseline from a clean worktree with:

```bash
pnpm test:velocity -- --measure --write-report
```

In `--measure` mode, the script first runs a non-measured build preflight (`pnpm build`) so the built CLI and workspace dist artifacts exist before any lane is timed. The preflight duration is setup cost and is excluded from `pnpm test:gate`, `pnpm smoke:boot`, and `pnpm test` history fields; if the preflight fails, the report records `Build preflight (pnpm build)` in Measurement failures instead of fabricating lane times or letting boot smoke appear unavailable. Use `--skip-build-preflight` only in CI or another environment that has already built the workspace.

After the preflight, the script runs `pnpm test:gate`, `pnpm smoke:boot`, and `pnpm test` with bounded async process supervision, then appends the measured row to `scripts/test-velocity-history.json` and rewrites the postable artifact at `docs/test-velocity-baseline.md`. It reads the slowest 20 files from the committed `scripts/test-timings.json` snapshot and the flake/quarantine count plus 14-day deletion-clock buckets directly from `scripts/lib/test-quarantine.json`; do not run the full suite just to populate the slowest-file table.

Use cheap report-only regeneration when measurements already exist:

```bash
pnpm test:velocity
```

Each week, copy the `Post to #leads` block from `docs/test-velocity-baseline.md`. If a measured command fails because the local environment is not ready, keep the failure recorded in the report instead of fabricating a time, then fix or rerun separately as appropriate. Do not wire `pnpm test:velocity`, `test:full`, or any slow-suite expansion into PR checks; the merge gate stays the thin Lint, Typecheck, Build, and Gate path.

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

## Changed-only test cache (`pnpm test`)

`pnpm test` runs `scripts/test-changed.mjs`, which selects only the workspace
packages affected by your branch diff (plus their reverse-dependents) and skips
packages whose content hasn't changed since they last passed. A per-package
pass-cache lives at `node_modules/.cache/fusion/test-cache.json`.

To see which mode a run would pick — and why — without running any tests:
`node scripts/test-changed.mjs --print-mode` prints the
`[test-changed] mode=… reason=… packages=…` decision line and exits.

### What a cache entry's hash covers (dependency-aware invalidation)

Each package's cache hash (`computePackageHash`) folds in, so any of these
changing forces that package to re-run:

- **The package's own tracked files**, hashed via the **working-tree bytes** for
  any file that is dirty (unstaged/uncommitted edits) or untracked-not-ignored,
  and via git's index blob SHA only when the file is fully clean. This means an
  **unstaged edit to a tracked file busts the cache** — no false HIT on a stale
  index blob.
- **Every transitive workspace dependency's own hash.** A change to `@fusion/core`
  invalidates the cache entries of `engine`, `dashboard`, `cli`, and everything
  else that (transitively) depends on it, even when the dependent's own files are
  untouched. This is the R11 correctness fix: a dependent is never cache-skipped
  when a dependency it consumes has changed.
- **Shared inputs folded into *every* package**: `pnpm-lock.yaml`,
  `tsconfig.base.json`, and the shared `packages/core/src/__test-utils__` tree.
  The test-utils tree is imported by nearly every package's vitest config via a
  relative cross-package path, including packages that have **no** `@fusion/core`
  workspace dependency (mobile, droid-cli, pi-\*, and the plugins). Folding it in
  globally (like `tsconfig.base.json`) guarantees an edit there invalidates the
  whole workspace.

The hash carries a version prefix (`HASH_VERSION_PREFIX`). Bumping it (done in U4:
`v1` → `v2`) invalidates every pre-existing entry exactly once; old-format cache
files are discarded gracefully rather than crashed on.

### Escape hatches

If you suspect a stale or wrong cache result (e.g. a flaky test that happened to
pass got cached, or you want to force a clean re-run), bypass the cache:

```bash
pnpm test --no-cache          # bypass cache reads AND writes for this run
FUSION_TEST_NO_CACHE=1 pnpm test
```

`--no-cache` re-runs every selected package without consulting or clearing the
cache file; a subsequent normal `pnpm test` still hits the cache. `pnpm test:full`
already passes `--no-cache` (a full run means full). These flags already exist;
this section documents them.

### TTL rationale (7-day expiry)

Entries older than **7 days** are treated as a MISS even on a hash match
(`CACHE_MAX_AGE_MS`). The TTL is intentionally retained even though dep-aware
hashing makes content-staleness impossible: it guards against **environmental
drift** that the content hash cannot see — toolchain/Node upgrades, OS or native
dependency changes, and other host-level shifts that can change test outcomes
without changing any hashed file. Seven days bounds that blind spot while keeping
the cache useful across a normal work week.

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

Copy this checklist into a bug-fix or UI-affordance add/remove task's `## Surface Enumeration` section and make the implementation tests prove the invariant across every checked surface. This checklist applies to bug-fix tasks and UI-affordance add/remove tasks that add, remove, or restructure icons, buttons, chevrons/arrows, toggles, badges, menu entries, or click targets. See `AGENTS.md` → **Standing Rule: Fix the Invariant, Not the Repro (FN-5893)** for the enforced planning/review contract.

- [ ] Providers / bridges / execution paths touched by the invariant
- [ ] Long-running subprocess or verification-active surfaces when the invariant involves engine liveness, stuck detection, or command execution (`fn_run_verification`, configured commands, timeout/deadline behavior)
- [ ] Desktop + mobile breakpoints / platforms that exercise the behavior
- [ ] Empty / undefined / duplicate / populated data states
- [ ] Shared hooks / components / modules / helpers reusing the logic
- [ ] Every component that renders the affordance (search the codebase for the icon/class/testid, not just the one the user pointed at)
- [ ] Leftover shells after removal — empty buttons, orphaned click targets, now-unused wrappers, dangling aria-labels — are explicitly checked and fixed/hidden

Motivating incident: FN-6115/FN-6118/FN-6123 — a single workflow-row chevron required three tasks to fully remove because the affordance rendered across multiple components and one mobile surface kept an empty `btn-icon` button shell.

### Symptom Verification for bug-class tasks

Bug-class/bug-fix tasks must also include a `## Symptom Verification` section so FN-5893 acceptance proves the original user-visible failure is gone, not merely that a change landed or broad checks are green. Feature/docs/non-bug tasks are not required to carry this section.

Use the exact heading `## Symptom Verification` and include all three required contents:

- [ ] **Original symptom** — what the user/issue reported was broken.
- [ ] **Exact reproduction** — the precise steps, inputs, fixture, or automated repro that triggered the failure.
- [ ] **Assertion it is gone** — final verification reproduces the original failure condition and asserts it no longer occurs via a real automated test.

Symptom-based acceptance is mandatory for bug fixes: reproduce the original failure, prove it is gone, and keep the invariant covered across the `## Surface Enumeration` checklist. Green build/tests alone are insufficient when they do not exercise the reported symptom.
