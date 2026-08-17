---
title: "Merge-gate W33 wall-time regression: controlled re-measure"
date: 2026-08-16
category: developer-experience
module: scripts/run-static-gate-checks.mjs
problem_type: performance_investigation
applies_when: "A weekly velocity row reports a merge-gate wall-time spike and the team needs to distinguish a gate regression from a one-sample anomaly without weakening blocking coverage."
symptoms:
  - "A single `pnpm test:gate` sample exceeds the 9–11 second healthy band."
  - "Boot smoke and changed-only measurements do not show a matching slowdown."
root_cause: single_sample_measurement_variance
resolution_type: documented_measurement_protocol
severity: low
related_components:
  - package.json
  - scripts/run-static-gate-checks.mjs
  - scripts/__tests__/engine-vitest-gate-policy.test.mjs
  - packages/engine/vitest.config.ts
  - packages/core/src/__test-utils__/pg-test-harness.ts
  - packages/core/src/index.gate.ts
tags: [merge-gate, performance, test-velocity, vitest, postgres, fn-9122]
---

# Merge-gate W33 wall-time regression: controlled re-measure

## Problem

The W33 velocity row captured at `2026-08-16T06:01:44.671Z` reported `pnpm test:gate` at **14.0s**, versus **11.0s** in the preceding row. Boot smoke improved by 6.3s and changed-only improved by 116ms, so the one gate sample warranted investigation. The gate's composition documentation was also stale: it claimed 22 engine-core files and 12/14 validators while the actual gate had 21 files and 15 validators.

## Controlled measurement

FN-9122 used a built task worktree on Darwin 25.1.0 arm64 (28 CPUs, 256 GiB RAM), Node v26.3.0, and pnpm 10.33.0. Process checks found no concurrent Vitest, build, boot-smoke, or `fn serve` process. A priming run was discarded, then samples were serialized.

| Run | Pre-sample load (1/5/15m) | Gate wall time |
|---|---|---:|
| Warm 1 | 7.76 / 6.89 / 6.07 | 9.5s |
| Warm 2 | 7.75 / 6.92 / 6.10 | 9.3s |
| Warm 3 | 8.27 / 7.07 / 6.16 | 9.9s |
| Cold (removed transform cache and core gate bundle) | 8.59 / 7.20 / 6.22 | 10.9s |
| Post-ledger warm 1 | 5.32 / 5.81 / 5.90 | 10.1s |
| Post-ledger warm 2 | 7.19 / 6.21 / 6.04 | 9.5s |
| Post-ledger warm 3 | 7.53 / 6.33 / 6.08 | 9.0s |

The initial warm min/median/max was **9.3s / 9.5s / 9.9s**; the post-repair warm min/median/max was **9.0s / 9.5s / 10.1s**. Both medians are below 11.0s. W33 is therefore a **single-sample measurement anomaly**, not a reproduced gate regression.

## Coverage-parity baseline

The gate actually runs 15 static validators, 21 explicit engine-core files containing **432 tests**, two PG canaries, four unit-gate files, and CI-shape after successful concurrent lanes. `project-engine.test.ts` was removed from engine-core by FN-8937 (`0fbeba50d1`), so this is one fewer engine-core file than the W32 baseline. The policy contract now pins the 15-validator ordered inventory and its cardinality, and the corresponding static-runner and verify-fast test inventories match it.

## Attribution

| Phase | Warm timing |
|---|---:|
| Static validator fan-out | 2.0s |
| Engine-core | 5.3s |
| PG gate | 3.5s |
| Unit gate | 5.5s |
| CI-shape | 0.7s |
| Direct core gate-bundle rebuild | 0.2s |

The concurrent test critical path was the unchanged unit-gate lane, not engine-core or PostgreSQL. The gate bundle had 411 metafile inputs and was 4,188,513 bytes; its rebuild did not explain a three-second change. Individual static checks showed `check-inert-sync-lane-conversions` at 1.7s, `check-capacity-pool-id` at 1.4s, and `check-no-getdatabase` at 1.3s; the newly admitted `check-cli-runtime-routing.mjs` (FN-9096, `1d3f6c198c`) took 0.1s and remained inside the 2.0s concurrent fan-out.

The PG harness rewrite (`0935e27902`) was not the critical lane. The historical gate-safe barrel mirrors were also not implicated: engine-core remained 5.1–5.3s and the builder itself took 0.2s.

## Decision

Do not change a runtime gate seam on a single weekly measurement. For a future merge-gate spike:

1. Run a passing `pnpm build` preflight in the task worktree.
2. Record host facts, relevant-process absence, and pre-sample load.
3. Discard one priming run, then collect at least three serialized warm `pnpm test:gate` samples.
4. Treat the regression as reproduced only when the warm median exceeds **11.0s**.
5. Measure static, engine-core, PG, unit, and CI-shape lanes before changing code. Preserve 15/21/2/4/CI-shape coverage parity and never buy time by weakening signal.

## Precedents

- **FN-7666** (`845fad2aa4`) established that organic full-barrel growth can inflate every engine-core fork; the gate-safe barrel remains the evidence-backed protection.
- **FN-7667** retained the exclusion policy without narrowing to hand-picked symbols; this investigation kept that policy because the barrel was not the W33 seam.
- **FN-7669** supplied the rebuild-every-run core bundle; **FN-7670** and **FN-7673** closed the engine relative-import bundling lever after no benefit and a measured regression.
- **FN-8497** (`9002fca9de`) kept only high-value PG canaries and made test lanes concurrent; **`c15c78fee`** created the PostgreSQL gate lane that was explicitly measured here.
- **FN-8783/FN-8789** established the warm-cache healthy band and transform-cache policy used for comparison.
- **FN-8937** (`0fbeba50d1`) removed, rather than admitted, an engine-core file in the measurement window; **FN-9096** (`1d3f6c198c`) added the inexpensive static validator.
