# Test velocity baseline

> Weekly FN-6612 signal-per-second baseline. Measure and report feedback-loop velocity; do **not** add slow tests or wire this report into blocking PR checks. The merge gate remains the existing thin Lint, Typecheck, Build, and Gate path.

## Latest baseline

- Cycle: **2026-W25**
- Captured at: **2026-06-18T16:12:01.248Z**
- Timing snapshot: `scripts/test-timings.json` captured at **2026-06-03T23:45:49.672Z**
- Quarantine ledger: `scripts/lib/test-quarantine.json`

## Metrics

| Metric | Current | Delta vs previous |
|---|---:|---:|
| Merge gate wall-time (`pnpm test:gate`) | 5.4s | -779ms |
| Boot smoke wall-time (`pnpm smoke:boot`) | 18.1s | -123ms |
| Changed-only test wall-time (`pnpm test`) | 7.2s | -500ms |
| Quarantine / flake count | 0 | -2 |
| Deletion-due quarantines | 0 | n/a |

## Measurement failures

- None recorded.

## Slowest 20 test files

| Rank | File | Package | Duration |
|---:|---|---|---:|
| 1 | `packages/engine/src/__tests__/reliability-interactions/shared-branch-group-lifecycle.test.ts` | @fusion/engine | 13.9s |
| 2 | `packages/core/src/__tests__/agent-store.test.ts` | @fusion/core | 11.6s |
| 3 | `packages/dashboard/src/__tests__/routes-agents.test.ts` | @fusion/dashboard | 11.2s |
| 4 | `packages/core/src/__tests__/mission-store.test.ts` | @fusion/core | 10.7s |
| 5 | `packages/core/src/__tests__/db.test.ts` | @fusion/core | 10.1s |
| 6 | `packages/dashboard/src/__tests__/routes-git.test.ts` | @fusion/dashboard | 9.4s |
| 7 | `packages/engine/src/__tests__/reliability-interactions/branch-group-automerge-precedence.test.ts` | @fusion/engine | 9.0s |
| 8 | `packages/engine/src/__tests__/merger-ai.test.ts` | @fusion/engine | 8.7s |
| 9 | `packages/engine/src/__tests__/reliability-interactions/branch-group-merge-routing.test.ts` | @fusion/engine | 8.4s |
| 10 | `packages/engine/src/__tests__/reliability-interactions/branch-group-promotion-gate.test.ts` | @fusion/engine | 8.4s |
| 11 | `packages/core/src/__tests__/task-documents.test.ts` | @fusion/core | 8.3s |
| 12 | `packages/engine/src/runtimes/__tests__/in-process-runtime.test.ts` | @fusion/engine | 7.8s |
| 13 | `packages/cli/src/__tests__/extension.test.ts` | @runfusion/fusion | 7.0s |
| 14 | `packages/core/src/__tests__/run-audit.test.ts` | @fusion/core | 6.9s |
| 15 | `packages/engine/src/__tests__/reliability-interactions/branch-group-promotion.test.ts` | @fusion/engine | 6.1s |
| 16 | `packages/dashboard/src/__tests__/routes-planning.test.ts` | @fusion/dashboard | 5.6s |
| 17 | `packages/core/src/__tests__/store-merge-queue.test.ts` | @fusion/core | 5.2s |
| 18 | `packages/dashboard/app/components/__tests__/FileEditor.test.tsx` | @fusion/dashboard | 5.1s |
| 19 | `packages/engine/src/__tests__/reliability-interactions/integration-worktree-state.test.ts` | @fusion/engine | 4.9s |
| 20 | `packages/engine/src/__tests__/self-healing-already-merged.real-git.test.ts` | @fusion/engine | 4.9s |

## Quarantine age buckets

| Age bucket | Count |
|---|---:|
| 0-6 days | 0 |
| 7-13 days | 0 |
| deletion due (>=14 days) | 0 |
| unknown/future | 0 |

### Deletion-due entries

| File | Quarantined at | Age (days) |
|---|---:|---:|
| — | — | — |

## Before / after trend

| Row | Captured at | Gate | Boot smoke | `pnpm test` | Quarantine count |
|---|---|---:|---:|---:|---:|
| Previous | 2026-06-18T03:04:28.794Z | 6.2s | 18.2s | 7.7s | 2 |
| Latest | 2026-06-18T16:12:01.248Z | 5.4s | 18.1s | 7.2s | 0 |
| Delta | — | -779ms | -123ms | -500ms | -2 |

_Future weekly rows append to `scripts/test-velocity-history.json`; compare the latest row against the previous row before posting to #leads._

## Post to #leads

```text
FN-6612 weekly test velocity: gate 5.4s (-779ms), boot smoke 18.1s (-123ms), pnpm test 7.2s (-500ms), quarantine ledger 0 (-2). Slowest file: packages/engine/src/__tests__/reliability-interactions/shared-branch-group-lifecycle.test.ts at 13.9s. Deletion-due quarantines: 0.
```

## How to refresh

```bash
pnpm test:velocity -- --measure --write-report
```

Report-only regeneration is cheap and does not run any suite:

```bash
pnpm test:velocity
```
