# Test-Speed Baseline — 2026-06-03 (U1 refresh)

Successor to `docs/test-speed-audit-FN-5048.md`. This baseline is captured from the
machine-readable per-file timing telemetry added in U1 of
`docs/plans/2026-06-03-001-perf-test-suite-speedup-plan.md`. It feeds the U6
(duration-based sharding), U7 (slow-test triage), and U8 (vitest 4.x gate)
decisions.

## Method

- Per-file durations come from vitest's `--reporter=json` output
  (`endTime − startTime` per test file), merged into `scripts/test-timings.json`
  via `node scripts/ci-test-shard.mjs --write-timings`.
- Cold-start overhead comes from `node scripts/ci-test-shard.mjs --cold-start-probe <pkg>`,
  which runs one cheap test file and reports `wallClock − sum(testDurations)`.
- Worker caps were left at defaults (no `FUSION_TEST_*` / `VITEST_MAX_WORKERS`
  overrides), per FN-5048.
- Capture invocations (one per package/lane):
  - `pnpm --filter @fusion/core exec vitest run --silent=passed-only --reporter=dot --reporter=json --outputFile.json=...`
  - `pnpm --filter @fusion/engine exec vitest run ... --project=engine-default --project=engine-reliability`
  - `pnpm --filter @runfusion/fusion exec vitest run ...`
  - dashboard curated lanes via `run-vitest-with-heap.mjs` for
    `dashboard-api-quality` and `dashboard-app-quality-components-a`
    (the dashboard `test` script is a 14-lane chain; two representative lanes
    were captured for the snapshot — a full lane sweep is a follow-up).

Note: per-file durations are summed wall-clock per file; because files run in
parallel, the **sum across files exceeds the run wall-clock**. The per-file
numbers are correct for *relative ranking* (which file is heaviest), which is
what U6/U7 consume. The "run wall-clock" column below is the real elapsed time.

## Per-package run totals (wall-clock, this capture)

| Package | Run wall-clock | Test files | Σ per-file (parallel) | Notes |
|---|---:|---:|---:|---|
| `@fusion/core` | **41.1s** | 264 | 185.2s | default project |
| `@fusion/engine` | **178.7s** | 521 | 273.3s | engine-default + engine-reliability |
| `@runfusion/fusion` (cli) | **48.9s** | 92 | 32.0s | default project |
| `@fusion/dashboard` (api-quality lane) | 46.7s | 58 | — | one curated lane |
| `@fusion/dashboard` (app components-a lane) | 27.6s | 44 | — | one curated lane |

Snapshot (`scripts/test-timings.json`) `capturedAt`: `2026-06-03T23:45:49Z`,
covering 4 packages.

For context, the prior FN-5048 baseline measured core ~26s, engine ~93s,
cli ~14s, dashboard ~360s (full multi-project). These were captured on a
different machine/load; treat the two baselines as independent snapshots, not a
trend line. Engine and core are larger here because the executed test inventory
has grown (engine now 521 files across default+reliability).

## Top-10 slowest files per major package

(Σ per-file wall-clock, bucketed to 100ms in the snapshot.)

### @fusion/core
| File | Σ duration |
|---|---:|
| src/__tests__/agent-store.test.ts | 11.6s |
| src/__tests__/mission-store.test.ts | 10.7s |
| src/__tests__/db.test.ts | 10.1s |
| src/__tests__/task-documents.test.ts | 8.3s |
| src/__tests__/run-audit.test.ts | 6.9s |
| src/__tests__/store-merge-queue.test.ts | 5.2s |
| src/__tests__/mission-integration.test.ts | 4.8s |
| src/__tests__/run-audit.integration.test.ts | 4.6s |
| src/__tests__/plugin-loader.test.ts | 4.5s |
| src/__tests__/mission-factory-parity.integration.test.ts | 4.2s |

### @fusion/engine
| File | Σ duration |
|---|---:|
| src/__tests__/reliability-interactions/shared-branch-group-lifecycle.test.ts | 13.9s |
| src/__tests__/reliability-interactions/branch-group-automerge-precedence.test.ts | 9.0s |
| src/__tests__/merger-ai.test.ts | 8.7s |
| src/__tests__/reliability-interactions/branch-group-merge-routing.test.ts | 8.4s |
| src/__tests__/reliability-interactions/branch-group-promotion-gate.test.ts | 8.4s |
| src/runtimes/__tests__/in-process-runtime.test.ts | 7.8s |
| src/__tests__/reliability-interactions/branch-group-promotion.test.ts | 6.1s |
| src/__tests__/reliability-interactions/integration-worktree-state.test.ts | 4.9s |
| src/__tests__/self-healing-already-merged.real-git.test.ts | 4.9s |
| src/__tests__/branch-conflicts-recovery.test.ts | 4.5s |

### @runfusion/fusion (cli)
| File | Σ duration |
|---|---:|
| src/__tests__/extension.test.ts | 7.0s |
| src/commands/__tests__/init.test.ts | 3.4s |
| src/__tests__/bin.test.ts | 3.2s |
| src/__tests__/extension-task-tools.test.ts | 1.7s |
| src/commands/dashboard-tui/__tests__/app.test.tsx | 1.6s |
| src/__tests__/vitest-workspace-resolution.test.ts | 1.4s |
| src/commands/__tests__/chat.test.ts | 1.3s |
| src/__tests__/research-extension-tools.test.ts | 1.1s |
| src/__tests__/extension-github-tracking.test.ts | 0.5s |
| src/commands/__tests__/dashboard.test.ts | 0.5s |

### @fusion/dashboard (captured curated lanes)
| File | Σ duration |
|---|---:|
| src/__tests__/routes-agents.test.ts | 11.2s |
| src/__tests__/routes-git.test.ts | 9.4s |
| src/__tests__/routes-planning.test.ts | 5.6s |
| app/components/__tests__/FileEditor.test.tsx | 5.1s |
| app/components/__tests__/NewTaskModal.test.tsx | 3.4s |
| app/components/__tests__/ChatView.rooms.test.tsx | 2.8s |
| src/__tests__/routes-github.test.ts | 2.8s |
| src/__tests__/setup-routes.test.ts | 2.6s |
| src/__tests__/routes-secrets-sync.test.ts | 2.5s |
| src/__tests__/websocket.test.ts | 2.1s |

## Cold-start / transform-cost probe (U8 gate input)

`overhead = wallClock − sum(per-file test durations)` for a single cheap test file.

| Package | Probe file | Wall | Test time | Overhead |
|---|---|---:|---:|---:|
| `@fusion/engine` | src/__tests__/pi.test.ts | 1843ms | 23ms | **1820ms** |
| `@fusion/core` | src/__tests__/db.test.ts | 13944ms | 12337ms | 1607ms |
| `@fusion/dashboard` | src/__tests__/sse.test.ts | 1349ms | 24ms | **1325ms** |
| `@runfusion/fusion` (cli) | src/__tests__/bin.test.ts | 6292ms | 5354ms | 938ms |

The cleanest signals are engine and dashboard, where the probe file's own test
time is ~24ms so almost all wall-clock is startup: **~1.3–1.8s of fixed
per-process overhead** (vitest boot + transform + collect + worker spawn). The
engine run breakdown confirms this is dominated by transform (~0.8s) and collect
(~1.0s). The core/cli probes auto-selected heavier files (path-length heuristic,
not runtime), so their overhead figure is conservative but consistent (~0.9–1.6s).

## Conclusion — U8 gate signal

Fixed per-process startup/transform overhead is **~1.3–1.8s per vitest
invocation**. In the inner loop (one or two packages) and full per-package runs
this is a small fraction of total wall-clock (engine 178s, core 41s), so it is
**not the top contributor** for those paths. However, the repo runs **~25
separate vitest processes** across packages, plugins, and the dashboard's 14-lane
chain; at ~1.5s each that is **~35–40s of pure cold-start tax aggregated across a
full CI/`test:full` sweep**, paid on every run with no cross-process sharing in
vitest 3.2.

Read against the U8 gate ("is cold-start/transform cost a top contributor
blocking the targets?"): for single-package inner-loop runs, **no** — wall-clock
is dominated by individual heavy integration tests (engine branch-group/real-git
suites, core stores, dashboard route suites), which U7 triage targets. For the
aggregate full-suite/CI path the cold-start tax is **material but second-order**
(~10% of full-suite wall-clock), making the vitest-4 `fsModuleCache` upgrade a
**worthwhile-but-not-urgent** lever — recommend proceeding with U3 (overhead
trim), U5 (config tuning), U6 (duration sharding), and U7 (slow-test triage)
first, then re-evaluating the U8 gate once those land, since they shrink both the
per-process count and the heavy-test tail that currently dominate.
