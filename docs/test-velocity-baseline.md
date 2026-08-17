# Test velocity baseline

> Weekly FN-6612 signal-per-second baseline. Measure and report feedback-loop velocity; do **not** add slow tests or wire this report into blocking PR checks. The merge gate remains the existing thin Lint, Typecheck, Build, and Gate path.

## Latest baseline

- Cycle: **2026-W33**
- Captured at: **2026-08-16T06:01:44.671Z**
- Timing snapshot: `scripts/test-timings.json` captured at **2026-08-16T06:04:55.815Z**
- Quarantine ledger: `scripts/lib/test-quarantine.json`

## Metrics

| Metric | Current | Delta vs previous |
|---|---:|---:|
| Merge gate wall-time (`pnpm test:gate`) | 14.0s | +3.0s |
| Boot smoke wall-time (`pnpm smoke:boot`) | 20.4s | -6.3s |
| Changed-only test wall-time (`pnpm test`) | 17.5s | -116ms |
| Quarantine / flake count | 0 | 0 |
| Deletion-due quarantines | 0 | n/a |

## Measurement failures

- None recorded.

## Timing snapshot notes

- No stale or missing timing metadata detected in the rendered slowest-file rows.

## Slowest 20 test files

| Rank | File | Package | Duration |
|---:|---|---|---:|
| 1 | `packages/core/src/__tests__/postgres/schema-applier.test.ts` | @fusion/core | 1m 13s |
| 2 | `packages/dashboard/src/__tests__/task-modal-touch-resize-browser.test.ts` | @fusion/dashboard | 1m 03s |
| 3 | `packages/cli/src/__tests__/extension.test.ts` | @runfusion/fusion | 42.8s |
| 4 | `packages/engine/src/__tests__/lifecycle-column-census.test.ts` | @fusion/engine | 42.4s |
| 5 | `packages/engine/src/__tests__/reliability-interactions/explicit-duplicate-marker-sweep.test.ts` | @fusion/engine | 36.9s |
| 6 | `packages/dashboard/app/components/__tests__/SettingsModal.scheduling-merge.test.tsx` | @fusion/dashboard | 30.2s |
| 7 | `packages/cli/src/__tests__/bin.test.ts` | @runfusion/fusion | 29.3s |
| 8 | `packages/engine/src/__tests__/merger-ai.test.ts` | @fusion/engine | 22.6s |
| 9 | `packages/core/src/__tests__/postgres/startup-factory-integration.test.ts` | @fusion/core | 21.8s |
| 10 | `packages/core/src/__tests__/postgres/sqlite-migrator.test.ts` | @fusion/core | 20.4s |
| 11 | `packages/dashboard/app/components/__tests__/AgentDetailView.advanced-settings.test.tsx` | @fusion/dashboard | 20.3s |
| 12 | `packages/engine/src/__tests__/reliability-interactions/merge-runner-spawn-enoent-prevention.test.ts` | @fusion/engine | 19.3s |
| 13 | `packages/dashboard/app/components/__tests__/SettingsModal.remote-notifications.test.tsx` | @fusion/dashboard | 19.0s |
| 14 | `packages/engine/src/__tests__/reliability-interactions/owning-node-unavailable-interactions.test.ts` | @fusion/engine | 18.4s |
| 15 | `packages/dashboard/app/components/__tests__/SettingsModal.models-auth.test.tsx` | @fusion/dashboard | 18.0s |
| 16 | `packages/dashboard/app/components/__tests__/SettingsModal.generalProject.test.tsx` | @fusion/dashboard | 17.6s |
| 17 | `packages/dashboard/app/components/__tests__/SettingsModal.general.test.tsx` | @fusion/dashboard | 17.5s |
| 18 | `packages/engine/src/__tests__/pi-create-fn-agent.test.ts` | @fusion/engine | 17.5s |
| 19 | `packages/dashboard/app/components/__tests__/TaskDetailModal.rendering.test.tsx` | @fusion/dashboard | 16.6s |
| 20 | `packages/cli/src/commands/dashboard-tui/__tests__/app.test.tsx` | @runfusion/fusion | 15.6s |

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
| Previous | 2026-08-13T01:59:18.032Z | 11.0s | 26.7s | 17.6s | 0 |
| Latest | 2026-08-16T06:01:44.671Z | 14.0s | 20.4s | 17.5s | 0 |
| Delta | — | +3.0s | -6.3s | -116ms | 0 |

_Future weekly rows append to `scripts/test-velocity-history.json`; compare the latest row against the previous row before posting to #leads._

## Post to #leads

```text
FN-6612 weekly test velocity: gate 14.0s (+3.0s), boot smoke 20.4s (-6.3s), pnpm test 17.5s (-116ms), quarantine ledger 0 (0). Slowest file: packages/core/src/__tests__/postgres/schema-applier.test.ts at 1m 13s. Deletion-due quarantines: 0.
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
