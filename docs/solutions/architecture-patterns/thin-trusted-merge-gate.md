---
title: "Thin trusted merge gate with a flaky-test deletion ratchet"
date: 2026-06-05
category: architecture-patterns
module: ci-test-gate
problem_type: architecture_pattern
component: testing_framework
severity: high
applies_when:
  - "PR test gate failures are flake-dominated — most red runs do not correspond to a real regression in the PR"
  - "No one can recall the last time a gate failure caught a real user-facing bug"
  - "Agents or engineers are appeasing flaky tests (widened timeouts, added retries, loosened assertions)"
  - "Fix-and-rerun cycles dominate PR shipping time over actual coding"
  - "Local default test command escalates to a full-suite run that OOMs dev machines"
tags: [ci, merge-gate, flaky-tests, test-quarantine, deletion-ratchet, vitest, monorepo, developer-experience]
---

# Thin trusted merge gate with a flaky-test deletion ratchet

## Context

The PR test gate had undergone trust collapse: 9 required CI checks (4 duration-balanced test shards at 4–10 min each, an engine slow tier, a dashboard inventory guard) failed mostly for flaky/infra reasons. ~70% of maintainer shipping time went to an agent-fix-and-rerun loop, and no recalled PR test failure had ever caught a real user-facing bug — the gate was pure cost. Worse, agents "stabilized" flakes by widening timeouts and adding retries, draining each test's remaining signal (the suite rotted from the inside). A separate incident compounded the distrust: the fn TUI was SIGKILLing all vitest processes on a broken memory metric, producing silent exit-137 deaths misread as flakiness/OOM (auto memory [claude]). Locally, `pnpm test` escalated to an implicit full recursive run on any shared-infra change — the dev-machine OOM path.

Shipped in Runfusion/Fusion#1453 (origin: `docs/brainstorms/2026-06-04-fast-trusted-test-gate-requirements.md`, plan: `docs/plans/2026-06-04-001-refactor-fast-trusted-test-gate-plan.md`).

## Guidance

The pattern: **thin trusted gate on PRs + demoted non-blocking tier on main + deletion ratchet as written policy**.

**1. Block PRs on a minimal trusted set, and pin that set with a test.** PRs block on exactly Lint, Typecheck, Build, Gate (`.github/workflows/pr-checks.yml`). The CI-shape test (`packages/cli/src/__tests__/ci-workflow.test.ts`) — itself part of the gate — makes drift fail loudly:

```typescript
it("blocks PRs on exactly lint, typecheck, build, and gate", () => {
  expect(Object.keys(workflow.jobs ?? {}).sort()).toEqual(["build", "gate", "lint", "typecheck"]);
});
```

**2. The Gate job = boot smoke + curated allow-list suite.** The boot smoke (`scripts/boot-smoke.mjs`) proves the app actually starts: CLI answers `--help`, a real `fn serve` returns `/api/health` 200 on an ephemeral port (isolated `$HOME`), and shutdown is SIGTERM-verified. The test half is `pnpm test:gate`: a curated `engine-core` vitest project (`packages/engine/vitest.config.ts`) whose membership is an **explicit file-by-file allow-list, not a glob** — 20 files, ~4s wall, ~1,025 tests, selected from committed per-file timing data (`scripts/test-timings.json`) with a determinism criterion (no real-git contention suites, no `*.slow.test.ts`, no shared-state bleed).

**3. Demote everything else to a separate non-blocking workflow.** `full-suite.yml` runs the shards/slow tier/inventory guard on push to main only — a red run there is information, never a merge stopper. A separate workflow file (not `continue-on-error` jobs) keeps a red full-suite run from painting the gate's workflow red. Key the concurrency group by SHA:

```yaml
concurrency:
  group: full-suite-${{ github.sha }}   # ref-keyed + cancel-in-progress would let
  cancel-in-progress: false             # consecutive merges cancel each other's coverage
```

**4. The deletion ratchet is policy with minimal mechanics.** A test that fails without a corresponding real bug is quarantined on sight: a dated entry in `scripts/lib/test-quarantine.json` (`file`, `reason` + failing-run link, `quarantinedAt`) plus a hand-maintained `exclude` line in that package's vitest config, same commit. The entry expires in 14 days — then the test is deleted unless rescued with evidence it catches real regressions plus a root-cause fix. There is deliberately no loader module and no automation; `check-test-inventory.mjs --diff` stays unwired because a snapshot diff guard would fail on exactly the deletions the ratchet performs. Appeasement (timeouts/retries/loosened assertions) is banned outright in `AGENTS.md` — for agents especially.

**5. Remove implicit full-suite escalation from the local default.** `scripts/test-changed.mjs` routes every ambiguous condition to gate mode instead of an implicit full run:

```javascript
if (!comparisonBase) return { mode: "gate", reason: "missing-comparison-base" };
if (!changedFiles) return { mode: "gate", reason: "diff-failed" };
if (changedFiles.length === 0) return { mode: "gate", reason: "no-changes" };
if (isSharedInfraChange(changedFiles)) return { mode: "gate", reason: "shared-infra-changed" };
```

The full suite runs only on explicit opt-in (`--full` / `pnpm test:full`). In changed mode the gate suite runs first, under the isolation guard.

## Why This Matters

- **Red means real.** A gate with a high false-positive rate teaches everyone that red is noise. A gate small enough to curate and cheap enough to evict from restores the only property a merge gate needs.
- **The allow-list solves the eviction chicken-and-egg.** Under a glob, removing a flaky gate test needs a PR that passes the flaky gate. Under an allow-list, eviction is deleting one line — the eviction PR never waits on the flaky test.
- **Policy beats machinery.** This repo's history answered test pain with more test machinery (sharding, isolation checks, lock runners, kill guards). The ratchet is a written rule plus a dated JSON record; automation would let entries accumulate silently.
- **Appeasement is how suites rot.** The ratchet leaves exactly two exits for a flake: deletion or a root-cause rescue. There is no "stabilize it" option — the prior suite was the proof of where that leads.
- **The blind spot is documented, not hidden.** The gate does not run the union suite a merge creates; logic regressions outside the curated set land non-blocking by design (`docs/testing.md`). Stating this honestly beats the illusion of coverage that 9 untrusted jobs provided.

## When to Apply

- Trust collapse indicators (see `applies_when`): flake-dominated reds, zero recalled catches, appeasement loops, fix-and-rerun dominating shipping time, reflexive dismissal of red CI.
- When eviction must be cheap: an explicit allow-list is the right gate shape even for small suites — one flaky gate test poisons the gate for everyone.
- **Counter-case:** a repeatedly "stabilized" flake can be a real product race — see `../ui-bugs/skill-autocomplete-highlight-reset-on-swr-revalidation.md` (a flake "fixed" three times that was a genuine race). The complete triage tree: root cause known → fix the invariant; root cause unknown and no real bug → quarantine → deletion clock; second quarantine in the same subsystem → product-race smell, look before deleting.

## Examples

Before/after CI topology:

```
Before: PR → lint/typecheck/build + 4 test shards (4–10 min, flaky) + slow tier + inventory guard
After:  PR → Lint, Typecheck, Build, Gate (boot smoke + ~4s curated suite)   [blocking]
        main push → full-suite.yml: shards + slow tier + guard               [non-blocking]
```

Operational gotchas discovered while shipping this:

- **A PR in `CONFLICTING` mergeable state runs zero GitHub Actions.** No `pull_request` workflows fire because GitHub cannot build the merge ref — it looks exactly like "CI never started" (no pending checks at all). Fix: merge the base branch; the resulting push triggers normally.
- **Deleting a workflow file crashes tests that `readFileSync` it.** The asserting test fails at `beforeAll`, taking its whole file with it. Rewrite the test in the same PR and convert the absence into an invariant: `expect(() => loadWorkflow("ci.yml")).toThrow()`.
- **Node does not fire `'exit'` on SIGTERM/SIGINT.** A smoke script registering only `process.on("exit", cleanup)` orphans its server child when the CI job is cancelled. Register explicit signal handlers that call cleanup and re-exit with 143/130.
- **A new "always run" mode must be excluded from cache fast paths.** Gate mode initially fell into `test-changed.mjs`'s cache-fresh short-circuit and silently no-opped; the fix treats gate mode as always having work.
- **Smoke-test shutdown verdicts need both halves:** SIGTERM actually delivered AND a clean exit (`code 0`/`SIGTERM`) — otherwise a server that crashes after the health check still prints PASS.

## Related

- `docs/testing.md` ("The merge gate", "Quarantine ledger and the deletion ratchet") and the `AGENTS.md` standing rule — the operative policy text
- `../ui-bugs/skill-autocomplete-highlight-reset-on-swr-revalidation.md` — the complementary triage path: when a flake is a real product race, fix the invariant instead of quarantining
- `../architecture-patterns/i18n-foundation-vite-ink-monorepo-code-split-catalogs.md` — references "CI shard 1/2" as PR-blocking surfaces; post-#1453 those run non-blocking in `full-suite.yml`
- Runfusion/Fusion#1453 (the change), follow-up gaps Runfusion/Fusion#1447–#1452 (untested gate-mode invariants, dist-cache composite action, workflow-loader dedup)
- Open flaky-test issues Runfusion/Fusion#1430, Runfusion/Fusion#1355 — first candidates for the quarantine ledger under the new policy
