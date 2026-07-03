# Test feedback-loop baseline

> Publish this page's latest-cycle summary in #leads each week. The objective is signal-per-second: keep the merge gate thin, keep `pnpm test` flat or faster, and ratchet flaky/low-signal tests toward rescue or deletion.

## Latest #leads summary

- Cycle: **2026-W27** (2026-07-03T08:47:02.631Z)
- Gate suite wall-time: **9.5s** (trend: +2.3s)
- `pnpm test` wall-time: **43.9s** (trend: +7.0s)
- Flake/quarantine count: **0** ledger entries across **0** files
- Timing snapshot source: `scripts/test-timings.json` captured at **2026-06-27T05:41:42.568Z**
- Notes: FN-7463 refresh: pnpm test:gate 9514ms; pnpm test 43865ms; quarantine ledger 0 entries; FN-5048 candidate packages/dashboard/src/__tests__/insights-routes.test.ts (slowest current snapshot at 26500ms).

## Slowest 20 test files

| Rank | File | Package | Duration |
|---:|---|---|---:|
| 1 | `packages/dashboard/src/__tests__/insights-routes.test.ts` | @fusion/dashboard | 26.5s |
| 2 | `packages/engine/src/runtimes/__tests__/in-process-runtime.test.ts` | @fusion/engine | 24.7s |
| 3 | `packages/dashboard/src/__tests__/workflow-routes.test.ts` | @fusion/dashboard | 22.0s |
| 4 | `packages/core/src/__tests__/db.test.ts` | @fusion/core | 21.2s |
| 5 | `packages/dashboard/app/components/__tests__/GitManagerModal.test.tsx` | @fusion/dashboard | 16.9s |
| 6 | `packages/core/src/__tests__/mission-store.test.ts` | @fusion/core | 16.0s |
| 7 | `packages/cli/src/__tests__/extension.test.ts` | @runfusion/fusion | 15.7s |
| 8 | `packages/dashboard/app/components/__tests__/AgentPromptsManager.test.tsx` | @fusion/dashboard | 14.8s |
| 9 | `packages/dashboard/app/components/__tests__/App.test.tsx` | @fusion/dashboard | 14.6s |
| 10 | `packages/dashboard/app/components/__tests__/TaskDetailModal.inline-editing-and-integrations.test.tsx` | @fusion/dashboard | 14.1s |
| 11 | `packages/dashboard/app/components/__tests__/TaskDetailModal.rendering.test.tsx` | @fusion/dashboard | 13.7s |
| 12 | `packages/dashboard/src/__tests__/routes-auth.test.ts` | @fusion/dashboard | 13.6s |
| 13 | `packages/core/src/__tests__/agent-store.test.ts` | @fusion/core | 13.4s |
| 14 | `packages/engine/src/__tests__/workspace-merger-idempotency.test.ts` | @fusion/engine | 12.7s |
| 15 | `packages/engine/src/__tests__/self-healing-workspace.test.ts` | @fusion/engine | 11.8s |
| 16 | `packages/engine/src/__tests__/pr-response-run.test.ts` | @fusion/engine | 11.6s |
| 17 | `packages/dashboard/app/components/__tests__/ListView.test.tsx` | @fusion/dashboard | 11.3s |
| 18 | `plugins/fusion-plugin-compound-engineering/src/__tests__/sync.test.ts` | @fusion-plugin-examples/compound-engineering | 11.0s |
| 19 | `packages/dashboard/app/components/__tests__/AgentDetailView.settings.test.tsx` | @fusion/dashboard | 10.7s |
| 20 | `packages/dashboard/app/components/__tests__/SecretsView.test.tsx` | @fusion/dashboard | 10.7s |

## Trend

| Cycle | Captured at | Gate suite | `pnpm test` | Quarantine entries | Quarantined files |
|---|---|---:|---:|---:|---:|
| 2026-W25 | 2026-06-18T02:11:11.998Z | 7.2s | 36.9s | 5 | 4 |
| 2026-W27 | 2026-07-03T08:47:02.631Z | 9.5s | 43.9s | 0 | 0 |

## Operating rules

- Record a new row weekly with `node scripts/test-feedback-baseline.mjs --record --gate-ms <ms> --test-ms <ms>` after running `pnpm test:gate` and `pnpm test`.
- Use the slowest-file list as the candidate queue for FN-5048 rewrites or deletion-ratchet review; do not add coverage for its own sake.
- Quarantined tests remain on the 14-day rescue-or-delete clock in `scripts/lib/test-quarantine.json`; deleting a low-signal expired test is a valid positive outcome.
