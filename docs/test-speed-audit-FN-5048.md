# FN-5048 Test-Speed Audit

> **Refreshed baseline (2026-06-03):** see `docs/test-speed-baseline-2026-06-03.md` for the U1 machine-readable per-file timing snapshot, refreshed top-10 offenders, and the cold-start/transform-cost probe feeding the U8 vitest-4 gate.

## Scope and method
- Related baseline context:
  - `docs/test-audit-report.md` (prior workspace test audit baseline)
  - `docs/testing-suite-quality-prd.md` (suite quality taxonomy + priorities)
- Commands run (baseline):
  - `pnpm --filter @fusion/core exec vitest run --reporter=verbose --silent=passed-only`
  - `pnpm --filter @fusion/engine exec vitest run --reporter=verbose --silent=passed-only`
  - `pnpm --filter @runfusion/fusion exec vitest run --reporter=verbose --silent=passed-only`
  - `pnpm --filter @fusion/dashboard exec vitest run --reporter=verbose --silent=passed-only`
- Durations were derived from verbose per-test timing logs by aggregating milliseconds per test file and top `describe` groups.
- Classification rubric:
  - `delete`: low-signal/duplicate patterns from AGENTS.md “What NOT to write”.
  - `rewrite`: keep coverage, reduce cost via fake timers/seam narrowing/lighter fixtures/shared harness.
  - `keep`: high-signal regression/integration backstop.

## Baseline run totals
- `@fusion/core`: **26.29s** (pass)
- `@fusion/engine`: **93.29s** (pass)
- `@runfusion/fusion`: **13.90s** (pass)
- `@fusion/dashboard`: **359.52s** (`vitest run` across all dashboard projects; multiple unrelated pre-existing failures surfaced)

## Top offenders by package (baseline)

### @fusion/core (top 10)
| Rank | File | Aggregated runtime | Dominant suite(s) | Class | Proposed action |
|---|---|---:|---|---|---|
| 1 | `src/__tests__/agent-store.test.ts` | 8.47s | AgentStore (100%) | keep | Keep (broad state/store coverage). |
| 2 | `src/__tests__/mission-store.test.ts` | 6.16s | MissionStore (100%) | keep | Keep; prioritize targeted fixture slimming only if needed later. |
| 3 | `src/__tests__/db.test.ts` | 5.64s | Database (~68%) | keep | Keep (real SQLite backstop). |
| 4 | `src/__tests__/test-project.test.ts` | 5.13s | test-project fixture (100%) | rewrite | Evaluate fixture-heavy setup duplication, trim low-value cases. |
| 5 | `src/__tests__/plugin-loader.test.ts` | 3.48s | PluginLoader (100%) | keep | Keep. |
| 6 | `src/__tests__/store-watcher.test.ts` | 1.80s | TaskStore (100%) | rewrite | Replaced slow watch polling waits with FN-2707 fake-timer recipe. |
| 7 | `src/__tests__/run-audit.test.ts` | 2.60s | Run Audit (100%) | keep | Keep. |
| 8 | `src/__tests__/store-comments.test.ts` | 2.58s | TaskStore (100%) | keep | Keep. |
| 9 | `src/__tests__/plugin-store.test.ts` | 2.48s | PluginStore (100%) | keep | Keep. |
| 10 | `src/__tests__/store-create.test.ts` | 2.41s | TaskStore (100%) | keep | Keep. |

### @fusion/engine (top 10)
| Rank | File | Aggregated runtime | Dominant suite(s) | Class | Proposed action |
|---|---|---:|---|---|---|
| 1 | `src/__tests__/merger-overlap-guard.test.ts` | 31.00s | overlap-aware fallback integration (~74%) | keep | Keep (real-git heavy merge safety). |
| 2 | `src/__tests__/merger-staging-allowlist.test.ts` | 20.41s | staging allowlist (~60%) | keep | Keep (explicitly protected real-git backstop). |
| 3 | `src/__tests__/merger-diff-volume-gate.test.ts` | 13.96s | integration + gate logic | keep | Keep. |
| 4 | `src/__tests__/self-healing-already-merged.real-git.test.ts` | 10.21s | real-git recovery | keep | Keep. |
| 5 | `src/__tests__/merger-autostash-cleanup.test.ts` | 9.79s | sweep* paths | keep | Keep. |
| 6 | `src/__tests__/branch-conflicts-recovery.test.ts` | 9.39s | branch conflict classification | keep | Keep. |
| 7 | `src/__tests__/merger-autostash-orphan-surface.test.ts` | 8.11s | autostash orphan surface | keep | Keep. |
| 8 | `src/__tests__/merger-squash-audit.test.ts` | 7.66s | squash audit | keep | Keep. |
| 9 | `src/__tests__/self-healing-stale-merge-stats.real-git.test.ts` | 7.01s | merge metadata recovery | keep | Keep. |
| 10 | `src/runtimes/__tests__/in-process-runtime.test.ts` | 6.29s | InProcessRuntime (100%) | rewrite | Trim low-value matrix/permutation assertions. |

### @runfusion/fusion (top 10)
| Rank | File | Aggregated runtime | Dominant suite(s) | Class | Proposed action |
|---|---|---:|---|---|---|
| 1 | `src/__tests__/extension.test.ts` | 5.08s | runnable structured-output slice (100%) | rewrite | Trim duplicate wiring cases; preserve env-gated legacy skip. |
| 2 | `src/__tests__/bin.test.ts` | 4.16s | command routing | rewrite | Consolidate repetitive route permutations with `it.each`. |
| 3 | `src/commands/__tests__/init.test.ts` | 3.53s | init command (100%) | keep | Keep. |
| 4 | `src/__tests__/vitest-workspace-resolution.test.ts` | 1.76s | workspace resolution | keep | Keep. |
| 5 | `src/__tests__/extension-task-tools.test.ts` | 1.65s | worktree root resolution | keep | Keep. |
| 6 | `src/commands/dashboard-tui/__tests__/app.test.tsx` | 1.57s | settings view subset | rewrite | Remove low-value display duplicates. |
| 7 | `src/commands/__tests__/chat.test.ts` | 0.84s | chat interactive | keep | Keep. |
| 8 | `src/commands/__tests__/dashboard.test.ts` | 0.80s | dashboard command | keep | Keep. |
| 9 | `src/__tests__/research-extension-tools.test.ts` | 0.71s | research tools | keep | Keep. |
| 10 | `src/commands/__tests__/serve.test.ts` | 0.51s | serve command | keep | Keep. |

### @fusion/dashboard (top 10)
| Rank | File | Aggregated runtime | Dominant suite(s) | Class | Proposed action |
|---|---|---:|---|---|---|
| 1 | `src/__tests__/routes-auth.test.ts` | 93.86s | `GET /auth/status` (~86%) | rewrite | Replace broad matrix with scoped auth-provider assertions and fixture helper. |
| 2 | `app/components/__tests__/SettingsModal.test.tsx` | 89.05s | SettingsModal (100%) | rewrite | Consolidate high-latency waitFor-heavy permutations. |
| 3 | `app/components/__tests__/ChatView.test.tsx` | 24.36s | ChatView (~52%) | rewrite | Replace polling waits with event/fake-timer driven completion. |
| 4 | `src/__tests__/routes-agents.test.ts` | 22.02s → 11.61s (`FN-5870`) | mixed routes | rewrite | Landed under FN-5870: collapsed repetitive workflow-step route permutations into `it.each`, removed a pure field-presence-only template check, and shared app fixtures across mock-isolated describe blocks. |
| 5 | `app/components/__tests__/App.test.tsx` | 20.61s | app shell | rewrite | Reduce mock-the-world wiring cases that duplicate higher-level routes. |
| 6 | `app/components/__tests__/ListView.test.tsx` | 14.68s | bulk selection + list suites | rewrite | Consolidate combinatorial selection cases. |
| 7 | `app/components/__tests__/MissionManager.test.tsx` | 14.22s | MissionManager (100%) | keep/rewrite | Keep FN-tagged behavior; trim duplicate DOM-query shape checks. |
| 8 | `app/components/__tests__/PrCreateModal.test.tsx` | 11.61s | PrCreateModal | rewrite | Consolidate repetitive input permutations. |
| 9 | `app/components/__tests__/AgentPromptsManager.test.tsx` | 9.60s | AgentPromptsManager | rewrite | Convert repetitive cases into compact tables. |
| 10 | `app/components/__tests__/AgentDetailView.settings.test.tsx` | 9.43s | AgentDetailView settings | rewrite | Trim redundant control-shape assertions. |

## Prioritized execution plan
1. **Dashboard SettingsModal + ChatView targeted rewrites** (largest projected wall-clock gain).
2. **Dashboard routes-auth focused narrowing** (`GET /auth/status` hotspot).
3. **CLI bin/extension test consolidation** (`it.each` + duplicate route-case reductions).
4. **Core watcher fake-timer rewrite** (`store-watcher.test.ts`).

## Keep-safe exclusions explicitly honored
- No edits to reliability-interaction tests under `packages/engine/src/__tests__/reliability-interactions/**`.
- No deletion of FN-tagged regression tests.
- No concurrency/worker-cap changes.

## Post-change results (Step 5 re-measure)
- Re-ran the same per-package verbose commands after landed trims/rewrites.
- Post-change totals:
  - `@fusion/core`: **23.08s** (pass)
  - `@fusion/engine`: **76.66s** (pass)
  - `@runfusion/fusion`: **9.40s** (pass)
  - `@fusion/dashboard`: **335.40s** (`vitest run` failed with broad pre-existing suite issues unrelated to FN-5048 edits)

### Targeted outcome checks for FN-5048 edits
- `packages/core/src/__tests__/store-watcher.test.ts` (`rewrite`): retained per-test harness and fake-timerized watch-active polling tests (`vi.useFakeTimers` before `watch`, `advanceTimersByTimeAsync` driving cycles); sampled isolated file runtime now ~1.8s total with watch-active cases no longer incurring 1–3s interval waits.
- `packages/cli/src/__tests__/bin.test.ts` (`rewrite`/`trim`): redundant route permutations consolidated with `it.each`; CLI suite passes.
- `AGENTS.md` standing rule added and cross-linked from this audit to prevent reintroduction of slow-test patterns.

### Acceptance note
- Edited files classified as `rewrite`/`delete` were retained with measurable local pass behavior in their packages.
- `@fusion/core` no-regression gate satisfied after harness correction (baseline **26.29s** → post-change **23.08s**).
- Dashboard lane remains unstable from pre-existing repository-level failures in planning/tracking/interview route tests and unrelated UI suites; no FN-5048 file changes were made in those failing areas.

## FN-5074 follow-up results
- Isolated re-measure after targeted rewrites (same command family used in FN-5074 preflight):
  - `routes-auth.test.ts`: **94.53s → 15.76s** (164 tests)
  - `routes-agents.test.ts`: **9.72s → 10.58s** in FN-5074, then **12.66s → 11.61s** in FN-5870 (348 tests in current isolated rerun; helper-driven route parity preserved)
  - `SettingsModal.test.tsx`: **43.40s → 48.60s** (438 tests; sampled rerun regressed due to remaining long-running device-code path)
  - `ChatView.test.tsx`: **12.53s → 14.66s** (390 tests; sampled rerun modestly higher while preserving coverage)
- FN-5074 preserved FN-tagged coverage and frozen-button assertions; all four files pass in isolation and full verification gates remained green in task execution.

## Notes
- Dashboard `vitest run` baseline and post-change measurements both surfaced broad failing suites outside this task’s implementation scope; timing evidence is still captured from the same command family.
- Standing prevention rule: see `AGENTS.md` → **Standing Rule: Do Not Add Slow Tests (FN-5048)**.
