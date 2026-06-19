# Test feedback-loop baseline

> Publish this page's latest-cycle summary in #leads each week. The objective is signal-per-second: keep the merge gate thin, keep `pnpm test` flat or faster, and ratchet flaky/low-signal tests toward rescue or deletion.

## Latest #leads summary

- Cycle: **2026-W25** (2026-06-18T02:11:11.998Z)
- Gate suite wall-time: **7.2s** (trend: n/a)
- `pnpm test` wall-time: **36.9s** (trend: n/a)
- Flake/quarantine count: **5** ledger entries across **4** files
- Timing snapshot source: `scripts/test-timings.json` captured at **2026-06-03T23:45:49.672Z**

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

## Trend

| Cycle | Captured at | Gate suite | `pnpm test` | Quarantine entries | Quarantined files |
|---|---|---:|---:|---:|---:|
| 2026-W25 | 2026-06-18T02:11:11.998Z | 7.2s | 36.9s | 5 | 4 |

## Operating rules

- Record a new row weekly with `node scripts/test-feedback-baseline.mjs --record --gate-ms <ms> --test-ms <ms>` after running `pnpm test:gate` and `pnpm test`.
- Use the slowest-file list as the candidate queue for FN-5048 rewrites or deletion-ratchet review; do not add coverage for its own sake.
- Quarantined tests remain on the 14-day rescue-or-delete clock in `scripts/lib/test-quarantine.json`; deleting a low-signal expired test is a valid positive outcome.
