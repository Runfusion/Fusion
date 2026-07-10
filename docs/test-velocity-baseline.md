# Test velocity baseline

> Weekly FN-6612 signal-per-second baseline. Measure and report feedback-loop velocity; do **not** add slow tests or wire this report into blocking PR checks. The merge gate remains the existing thin Lint, Typecheck, Build, and Gate path.

## Latest baseline

- Cycle: **2026-W28**
- Captured at: **2026-07-08T18:17:42.464Z**
- Timing snapshot: `scripts/test-timings.json` captured at **2026-06-27T05:41:42.568Z**
- Quarantine ledger: `scripts/lib/test-quarantine.json`

## Metrics

| Metric | Current | Delta vs previous |
|---|---:|---:|
| Merge gate wall-time (`pnpm test:gate`) | 8.8s | -27.5s |
| Boot smoke wall-time (`pnpm smoke:boot`) | 17.6s | -7.7s |
| Changed-only test wall-time (`pnpm test`) | 1m 01s | +18.0s |
| Quarantine / flake count | 1 | 0 |
| Deletion-due quarantines | 0 | n/a |

## Measurement failures

- None recorded.

## Timing snapshot notes

- No stale or missing timing metadata detected in the rendered slowest-file rows.

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

## Quarantine age buckets

| Age bucket | Count |
|---|---:|
| 0-6 days | 1 |
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
| Previous | 2026-07-08T09:30:50.606Z | 36.3s | 25.3s | 43.4s | 1 |
| Latest | 2026-07-08T18:17:42.464Z | 8.8s | 17.6s | 1m 01s | 1 |
| Delta | — | -27.5s | -7.7s | +18.0s | 0 |

_Future weekly rows append to `scripts/test-velocity-history.json`; compare the latest row against the previous row before posting to #leads._

## Post to #leads

```text
FN-6612 weekly test velocity: gate 8.8s (-27.5s), boot smoke 17.6s (-7.7s), pnpm test 1m 01s (+18.0s), quarantine ledger 1 (0). Slowest file: packages/dashboard/src/__tests__/insights-routes.test.ts at 26.5s. Deletion-due quarantines: 0.
```

## How to refresh

```bash
pnpm test:velocity -- --measure --write-report
```

In measure mode, the script runs a non-measured `pnpm build` preflight before timing `pnpm test:gate`, `pnpm smoke:boot`, or `pnpm test`. The preflight time is setup only and is excluded from lane metrics; if it fails, the Measurement failures section records `Build preflight (pnpm build)` as the reason. Use `--skip-build-preflight` only when the workspace is already built by CI.

Report-only regeneration is cheap and does not run any suite:

```bash
pnpm test:velocity
```
