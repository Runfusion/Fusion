# Testing Guide

[← Docs index](./README.md)

This guide consolidates the detailed testing guidance moved from `AGENTS.md`.

## The merge gate

CI blocks PRs on exactly four checks (`.github/workflows/pr-checks.yml`): **Lint, Typecheck, Build, Gate**. The Gate job runs the boot smoke (`scripts/boot-smoke.mjs`: CLI `--help` + a real `fn serve` answering `GET /api/health`) and `pnpm test:gate` (the curated `engine-core` vitest project + the CI-shape test). Everything else — the 4-way shards, the engine slow tier, the dashboard inventory guard — runs NON-BLOCKING in `.github/workflows/full-suite.yml` on push to main.

Gate membership is the explicit allow-list in `packages/engine/vitest.config.ts` (`engine-core` project). Admission requires evidence of value (the test catches real regressions); tests never graduate in by default. A flaky gate test is evicted by deleting its allow-list line — the eviction PR does not need the flaky test to pass. The whole `engine-core` project must stay under ~60s wall-clock.

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

Workflow-owned merge/retry/recovery migration guard tests live in
`packages/engine/src/__tests__/workflow-*-deletion.test.ts` and
`packages/engine/src/__tests__/workflow-cutover-matrix.test.ts`. Run the relevant
targeted file when touching `workflow-work-scheduler.ts`,
`workflow-work-processor.ts`, `workflow-recovery-events.ts`, or workflow merge
node capability code.

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
- **Dashboard** is *not* `--shard`-sliced — its `test` script is a chain of many separate
  vitest invocations, so a forwarded `--shard` cannot apply coherently. Instead each leaf
  lane in the chain (enumerated programmatically from `packages/dashboard/package.json` by
  expanding the `pnpm run <name>` graph under `test`) is a separately-weighted schedulable
  unit; a shard runs `pnpm --filter @fusion/dashboard run <lane>` for its assigned lanes.
  Every lane is assigned to exactly one shard. **Lane weight** is the sum of durations of
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

Copy this checklist into a bug-fix task's `## Surface Enumeration` section and make the regression tests prove the invariant across every checked surface. See `AGENTS.md` → **Standing Rule: Fix the Invariant, Not the Repro (FN-5893)** for the enforced planning/review contract.

- [ ] Providers / bridges / execution paths touched by the invariant
- [ ] Desktop + mobile breakpoints / platforms that exercise the behavior
- [ ] Empty / undefined / duplicate / populated data states
- [ ] Shared hooks / components / modules / helpers reusing the logic
