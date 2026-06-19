# Testing Guide

[← Docs index](./README.md)

This guide consolidates the detailed testing guidance moved from `AGENTS.md`.

## The merge gate

CI blocks PRs on exactly four checks (`.github/workflows/pr-checks.yml`): **Lint, Typecheck, Build, Gate**. The Gate job runs the boot smoke (`scripts/boot-smoke.mjs`: CLI `--help` + a real `fn serve` answering `GET /api/health`) and `pnpm test:gate` (the curated `engine-core` vitest project + the CI-shape test). Everything else — the 4-way shards, the engine slow tier, the dashboard inventory guard — runs NON-BLOCKING in `.github/workflows/full-suite.yml` on push to main.

Gate membership is the explicit allow-list in `packages/engine/vitest.config.ts` (`engine-core` project). Admission requires evidence of value (the test catches real regressions); tests never graduate in by default. A flaky gate test is evicted by deleting its allow-list line — the eviction PR does not need the flaky test to pass. The whole `engine-core` project must stay under ~60s wall-clock.

## Weekly signal-per-second baseline

Refresh and publish the test feedback-loop baseline in #leads once per weekly cycle:

```bash
pnpm test:gate  # capture wall-time in ms
pnpm test       # capture wall-time in ms
node scripts/test-feedback-baseline.mjs --record --gate-ms <ms> --test-ms <ms> --print-leads
```

The generated `docs/test-feedback-loop-baseline.md` is the publication artifact: it reports gate wall-time, `pnpm test` wall-time, the slowest 20 test files from `scripts/test-timings.json`, and the current quarantine/flake count from `scripts/lib/test-quarantine.json`. Keep the trend flat or net-negative; use the slowest-file list to drive FN-5048 rewrites and deletion-ratchet reviews instead of adding low-signal coverage.

**The gate's blind spot, stated honestly:** typecheck + build + boot smoke + curated suite does not run the union suite a merge creates. Logic regressions outside the curated set land non-blocking by design — that is the accepted trade: the old broad gate caught no recalled real bugs while consuming ~70% of shipping time in flake triage.

## Required workspace gates

Use the narrowest command that exercises the behavior you changed, then broaden before reporting completion.

```bash
pnpm test              # gate suite + changed-only affected tests (bounded; never full-suite)
pnpm test:gate         # the merge gate: curated engine-core suite + CI-shape test
pnpm smoke:boot        # boot smoke: CLI --help + real serve /api/health
pnpm test:full         # full workspace suite — explicit opt-in only
pnpm lint              # lint all packages
pnpm build             # build workspace packages (excludes desktop/mobile)
pnpm verify:workspace  # deep opt-in verification: lint -> test:full -> build (NOT the merge gate)
```

`pnpm test:full` runs each package's default test script with capped worker fanout (`FUSION_TEST_TOTAL_WORKERS=4 FUSION_TEST_CONCURRENCY=2 pnpm -r --workspace-concurrency=2 test`). Do not casually raise worker counts; dashboard/jsdom and integration-heavy packages destabilize when oversubscribed. Use `VITEST_MAX_WORKERS=<n>` only for targeted package-level investigation.

<!-- FNXC:CustomWorkflowReliability 2026-06-19-00:00: FN-6694 adds an executable custom-workflow reliability release-check lane for QA signoff, but it must stay out of the merge gate so reliability evidence does not inflate every PR's wall-time. -->
Custom workflow reliability release signoff has a dedicated on-demand lane: `pnpm test:workflow-release-check` runs the manifest-listed targeted seams from `scripts/lib/workflow-reliability-release-check.json`, while `--dry-run` validates the manifest and prints planned commands and `--json` emits machine-readable item/seam evidence. This lane is **not** part of the merge gate and should not be added to `test:gate` or the `engine-core` allow-list.

<!-- FNXC:iOSAcceptance 2026-06-18-17:25: Terminal acceptance gates that depend on real mobile Safari must use the credential-driven real-iOS surface runbook instead of treating desktop WebKit or jsdom as evidence. -->
Terminal acceptance tasks that require real mobile Safari should use [`docs/ios-acceptance.md`](./ios-acceptance.md) for the `--check` run-vs-NO-OP probe, credential wiring, and physical/cloud real-iOS evidence workflow.

Agents running verification through `fn_run_verification` are bounded by default: project `verificationCommandTimeoutMs` when set, otherwise 300s for package scope and 900s for workspace scope, with an 1800s hard cap. Marathon invocations such as root `pnpm test`, `pnpm test:full`, `pnpm verify:workspace`, whole-package tests without file filters, and shell repeat loops are soft-capped unless the agent explicitly passes `allowFullSuite: true`; the escape hatch still emits progress heartbeats and respects the hard cap. Prefer targeted commands such as `pnpm --filter @fusion/<pkg> exec vitest run src/path/to/test.ts --silent=passed-only --reporter=dot` before opting into a full run.

## Fresh-worktree dist bootstrap

`pnpm test` auto-runs `scripts/ensure-test-artifacts.mjs` to rebuild missing/stale dist artifacts. Dashboard and `dependency-graph` package lanes auto-bootstrap too. If you hit opaque `Failed to resolve import "./cli-spawn.js"` (or similar), treat it as bootstrap regression against FN-4605 — don't work around with a manual `pnpm build`.

Public `@fusion/core` exports consumed by runtime tools should include a literal built-dist guard (for example importing `packages/core/dist/index.js`) when package test aliases otherwise resolve `@fusion/core` to source.

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

<!-- FNXC:TestQuarantine 2026-06-19-14:15: FN-6740 audited the same-day quarantine ledger as a coordinated deletion-ratchet batch. The ledger had 14 entries (3 dashboard, 6 core, 5 CLI) and every entry was mirrored in its package Vitest exclude; keep follow-up rescue/delete work scoped by subsystem so ledger/config edits remain lockstep and do not collide. -->

**2026-06-19 quarantine audit (FN-6740):** the 2026-06-19 ledger batch expires on **2026-07-03**. FN-6740 found no ledger/config half-state and chose no inline rescue/delete. The five CLI files (`extension-goal-tools`, `extension-mission-goal-tools`, `extension-task-tools`, `extension`, `research-extension-tools`) are explicitly deferred to FN-6734's outcome and must not get a duplicate rescue task. Five core files (`activity-analytics`, `db`, `store-create-summarize-deferred-hook`, `vitest-teardown-worker-root-cleanup`, `settings-export`) were rescued by FN-6741 after the loaded `@fusion/core` lane passed with only `store-concurrent-writes` re-quarantined; `settings-export` now closes its `TaskStore` before fixture cleanup. The dashboard files are split by likely root cause: FN-6742 owns `session-cross-tab` cleanup `ENOTEMPTY`, FN-6743 owns the third-repeat QuickEntryBox focus-restoration race after FN-6514/FN-6642, and FN-6744 owns WorkflowNodeEditor duplicate-merge-seam concurrency. Until those dashboard and remaining core follow-ups rescue with root-cause evidence or delete under the ratchet, leave all corresponding ledger entries and package excludes in lockstep.

<!-- FNXC:CoreTests 2026-06-19-14:55: FN-6741 rescued five same-day @fusion/core quarantine entries after proving the broad core lane with only store-concurrent-writes still failing, then removed ledger/config entries in lockstep for the rescued files. Keep this rescue pattern evidence-driven: fix close-order leaks such as TaskStore handles before fixture cleanup, prove the package lane, and do not replace quarantine removal with timeout, retry, or worker-count appeasement.

FNXC:CoreTests 2026-06-19-15:05: Merge verification re-observed store-concurrent-writes failing under broad @fusion/core load with SQLite BEGIN IMMEDIATE lock exhaustion. Keep that single file quarantined until a root-cause fix proves the transient-lock regression under suite load; do not widen SQLite recovery timing to appease the flake. -->

**2026-06-19 core suite-load rescue (FN-6741):** `activity-analytics.test.ts`, `db.test.ts`, `store-create-summarize-deferred-hook.test.ts`, `vitest-teardown-worker-root-cleanup.test.ts`, and `settings-export.test.ts` were rescued before their 2026-07-03 deletion deadline. The key evidence was a loaded `pnpm --filter @fusion/core test` pass across the package after re-quarantining `store-concurrent-writes.test.ts`, with no `ENOTEMPTY`, `EBUSY`, hook timeout, or missed deferred hook in the rescued files. Four files needed no weakening because their regression value still held under load; `settings-export.test.ts` kept its import/export coverage but now closes the real `TaskStore` before removing the fixture root. `store-concurrent-writes.test.ts` remains in the deletion ratchet after merge verification re-observed the broad-lane SQLite lock flake. Required closure evidence for this class is ledger/config convergence, the rescued package lane, the timeout-appeasement guard, `pnpm test:gate`, `pnpm test`, `pnpm typecheck`, and `pnpm build`.

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

The script runs `pnpm test:gate`, `pnpm smoke:boot`, and `pnpm test` with bounded async process supervision, then appends the measured row to `scripts/test-velocity-history.json` and rewrites the postable artifact at `docs/test-velocity-baseline.md`. It reads the slowest 20 files from the committed `scripts/test-timings.json` snapshot and the flake/quarantine count plus 14-day deletion-clock buckets directly from `scripts/lib/test-quarantine.json`; do not run the full suite just to populate the slowest-file table.

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
