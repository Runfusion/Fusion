# FN-1204 Test Effectiveness Audit

_Date: 2026-04-08_

## 1) Executive Summary

**Overall test health: _Good (with targeted high-risk gaps)_**

- Total executed tests across audited packages (`core`, `engine`, `cli`, `dashboard`): **8,188 passing**
- Total assertion calls (`expect(...)`): **18,070**
- Overall pattern: strong coverage depth in `@fusion/core`, strong scenario breadth in `@fusion/engine` and `@fusion/dashboard`, but uneven effectiveness in a few critical modules (especially untested orchestration/runtime files and large dashboard surfaces).

### Key risks

1. **Untested critical runtime path:** `packages/engine/src/runtimes/child-process-worker.ts` (0% coverage, no dedicated test).
2. **Large untested dashboard modules:** `packages/dashboard/src/mission-routes.ts` (1,862 LOC), `MissionInterviewModal.tsx` (1,090 LOC), `AgentGenerationModal.tsx`, `AgentImportModal.tsx`.
3. **Partially-tested high-surface modules:** `packages/dashboard/src/routes.ts` (55.51% lines despite very large route test suite), `packages/cli/src/project-resolver.ts` (30.71% lines), `packages/engine/src/reviewer.ts` (51.28% branch coverage).
4. **Flaky/time-sensitive pressure points:** dashboard retry-path timeout test in `packages/dashboard/src/routes.test.ts:3992-4016` (explicit 30s timeout), heavy timer-driven suites in engine stuck-detector/heartbeat tests.

---

## 2) Quantitative Metrics

## Per-package metrics

| Package | Test Files | Source Files | Test:Source | Tests Passed | Coverage (Lines / Branch / Func) | `it()` | `expect()` | `vi.mock()` |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| `@fusion/core` | 34 | 33 | 1.03 | 1,427 | 88.98 / 87.05 / 92.80 | 1,427 | 3,249 | 1 |
| `@fusion/engine` | 41 | 43 | 0.95 | 1,464 | 79.46 / 82.29 / 84.38 | 1,415 | 2,873 | 55 |
| `@gsxdsm/fusion` (CLI) | 28 | 24 | 1.17 | 522 | 68.48 / 71.70 / 74.90 | 512 | 1,106 | 73 |
| `@fusion/dashboard` | 163 | 156 | 1.04 | 4,775 (+1 skipped) | 73.70 / 84.87 / 65.87 | 4,743 | 10,842 | 174 |

## Test runtime snapshots (latest per-package runs)

- `core`: `Duration 7.32s` (`packages/core`)
- `engine`: `Duration 4.53s` (`packages/engine`, direct vitest run)
- `cli`: `Duration 14.82s` (`packages/cli`)
- `dashboard`: `Duration 31.63s` (`packages/dashboard`)

## Per-file coverage hotspots (lowest-impact areas)

> Full per-file line/branch/function percentages were collected for all audited files from `coverage-final.json`; table below highlights the weakest/high-risk files per package.

### `@fusion/core`

| File | Lines | Branch | Func |
|---|---:|---:|---:|
| `packages/core/src/gh-cli.ts` | 26.51 | 100.00 | 20.00 |
| `packages/core/src/ai-summarize.ts` | 59.53 | 81.81 | 90.90 |

### `@fusion/engine`

| File | Lines | Branch | Func |
|---|---:|---:|---:|
| `packages/engine/src/runtimes/child-process-worker.ts` | 0.00 | 100.00 | 100.00 |
| `packages/engine/src/github.ts` | 12.50 | 100.00 | 0.00 |
| `packages/engine/src/runtimes/child-process-runtime.ts` | 32.36 | 60.00 | 34.61 |
| `packages/engine/src/pr-monitor.ts` | 48.04 | 66.66 | 84.61 |
| `packages/engine/src/pi.ts` | 56.61 | 79.16 | 50.00 |
| `packages/engine/src/reviewer.ts` | 82.48 | 51.28 | 66.66 |

### `@gsxdsm/fusion` (CLI)

| File | Lines | Branch | Func |
|---|---:|---:|---:|
| `packages/cli/src/project-resolver.ts` | 30.71 | 82.14 | 33.33 |
| `packages/cli/src/commands/settings-export.ts` | 0.00 | 0.00 | 0.00 |
| `packages/cli/src/commands/settings-import.ts` | 0.00 | 0.00 | 0.00 |
| `packages/cli/src/runtime/native-patch.ts` | 0.00 | 100.00 | 100.00 |
| `packages/cli/src/bin.ts` | 55.67 | 49.35 | 100.00 |
| `packages/cli/src/commands/git.ts` | 54.85 | 41.79 | 75.00 |

### `@fusion/dashboard` (selected high-risk files)

| File | Lines | Branch | Func |
|---|---:|---:|---:|
| `packages/dashboard/src/mission-routes.ts` | 53.43 | 95.65 | 77.77 |
| `packages/dashboard/src/subtask-breakdown.ts` | 51.08 | 50.00 | 52.17 |
| `packages/dashboard/src/script-store.ts` | 0.00 | 0.00 | 0.00 |
| `packages/dashboard/app/components/MissionInterviewModal.tsx` | 23.82 | 73.33 | 16.66 |
| `packages/dashboard/app/components/AgentImportModal.tsx` | 13.97 | 10.00 | 12.50 |
| `packages/dashboard/app/components/AgentGenerationModal.tsx` | 23.35 | 26.66 | 12.50 |
| `packages/dashboard/app/hooks/useProjectHealth.ts` | 37.23 | 62.50 | 100.00 |
| `packages/dashboard/app/hooks/useFileBrowser.ts` | 0.00 | 0.00 | 0.00 |
| `packages/dashboard/app/hooks/useFileEditor.ts` | 0.00 | 0.00 | 0.00 |
| `packages/dashboard/app/hooks/useBackgroundSessions.ts` | 59.70 | 100.00 | 33.33 |

---

## 3) Test Quality Assessment

## 3.1 Mock density analysis

`mockDensity = vi.mock() / expect()`

| Package | `vi.mock()` | `expect()` | Mock Density |
|---|---:|---:|---:|
| core | 1 | 3,249 | 0.000 |
| engine | 55 | 2,873 | 0.019 |
| cli | 73 | 1,106 | 0.066 |
| dashboard | 174 | 10,842 | 0.016 |

### Files where mocks exceed assertions

- `packages/cli/src/bin.test.ts` — 10 mocks vs 6 assertions (`vi.mock(...)` concentrated at `:55-107`; assertions begin around `:163+`).

## 3.2 Assertion quality audit (10-file sample)

Sampled files (2-3 per package):
- Core: `store.test.ts`, `db-migrate.test.ts`, `central-core.test.ts`
- Engine: `executor.test.ts`, `stuck-task-detector.test.ts`
- CLI: `commands/task.test.ts`, `commands/dashboard.test.ts`
- Dashboard: `routes.test.ts`, `SettingsModal.test.tsx`, `components/__tests__/Column.test.tsx`

Sample assertion distribution (7,009 sampled assertions):
- **State verification:** 4,898 (**69.9%**)
- **Interaction verification:** 599 (**8.5%**)
- **Rendering checks:** 42 (**0.6%**)
- **Error-path assertions:** 1,470 (**21.0%**)

Interpretation:
- Back-end-heavy suites are strong on state and error-path assertions.
- UI rendering assertions exist but are concentrated in component-focused tests (example: `packages/dashboard/app/components/__tests__/Column.test.tsx`).

## 3.3 Edge-case vs happy-path

(Using `describe` / `it` keyword heuristics for `error|fail|invalid|edge|boundary|empty|null|undefined`)

| Package | Total `it()` | Edge-Focused `it()` | Happy-Path `it()` | Edge Ratio |
|---|---:|---:|---:|---:|
| core | 1,427 | 267 | 1,160 | 18.7% |
| engine | 1,415 | 325 | 1,090 | 23.0% |
| cli | 512 | 89 | 423 | 17.4% |
| dashboard | 4,743 | 771 | 3,972 | 16.3% |
| **Total** | **8,097** | **1,452** | **6,645** | **17.9%** |

## 3.4 Test isolation quality (real DB/runtime vs mocked)

Heuristic classification by file content:

| Package | Real | Hybrid | Mock-only | Neither |
|---|---:|---:|---:|---:|
| core | 13 | 1 | 2 | 18 |
| engine | 1 | 0 | 32 | 8 |
| cli | 0 | 2 | 19 | 7 |
| dashboard | 0 | 0 | 115 | 48 |

Interpretation:
- `core` is strongest on realistic persistence-level testing.
- `engine`, `cli`, and especially `dashboard` rely heavily on mocked environments.

## 3.5 Flaky test indicators

Notable timer/retry/race hotspots:

- **Known flaky path (confirmed):** `packages/dashboard/src/routes.test.ts:3992-4016` (429 retry path with explicit 30s timeout).
- `packages/engine/src/stuck-task-detector.test.ts` (heavy timer simulation)
- `packages/engine/src/agent-heartbeat.test.ts` (timer-heavy heartbeat behavior)
- `packages/cli/src/commands/dashboard.test.ts` (many timeout-driven behavioral checks)

Observed during test runs:
- recurring `MaxListenersExceededWarning` in CLI dashboard test runs
- occasional act warnings in websocket hook tests (`useBadgeWebSocket`) indicating async test fragility risk

---

## 4) Coverage Gap Analysis

## 4.1 Untested source files (refined, non-config)

### Core (1)
- `packages/core/src/automation.ts` (144 LOC)

### Engine (3)
- `packages/engine/src/runtimes/child-process-worker.ts` (175 LOC)
- `packages/engine/src/agent-tools.ts` (88 LOC)
- `packages/engine/src/github.ts` (38 LOC)

### Dashboard (33, top/high-impact shown)
- `packages/dashboard/src/mission-routes.ts` (1,862 LOC)
- `packages/dashboard/app/components/MissionInterviewModal.tsx` (1,090 LOC)
- `packages/dashboard/app/components/AgentGenerationModal.tsx` (434 LOC)
- `packages/dashboard/app/components/AgentImportModal.tsx` (402 LOC)
- `packages/dashboard/src/subtask-breakdown.ts` (379 LOC)
- `packages/dashboard/src/script-store.ts` (75 LOC)
- `packages/dashboard/app/hooks/useAgents.ts` (60 LOC)
- `packages/dashboard/app/hooks/useFileBrowser.ts` (85 LOC)
- `packages/dashboard/app/hooks/useFileEditor.ts` (121 LOC)
- `packages/dashboard/app/hooks/useProjectHealth.ts` (144 LOC)
- `packages/dashboard/app/hooks/useLiveTranscript.ts` (44 LOC)
- `packages/dashboard/app/hooks/useBackgroundSessions.ts` (94 LOC)

### CLI (3)
- `packages/cli/src/runtime/native-patch.ts` (224 LOC)
- `packages/cli/src/commands/settings-import.ts` (121 LOC)
- `packages/cli/src/commands/settings-export.ts` (72 LOC)

## 4.2 Correction to the prelisted “known untested files”

One prelisted item is no longer untested:
- `packages/dashboard/src/ai-session-store.ts` **has** `packages/dashboard/src/ai-session-store.test.ts` (confirmed by file inventory + test content).

## 4.3 Partially-tested files (tests exist, primary surface under-covered)

- `packages/dashboard/src/routes.ts` — 55.51% lines despite very large route test suite (`routes.test.ts`); indicates many route branches still uncovered.
- `packages/engine/src/reviewer.ts` — 51.28% branch coverage with existing reviewer tests; branching paths under-exercised.
- `packages/cli/src/project-resolver.ts` — 30.71% lines / 33.33% functions with tests present.
- `packages/core/src/gh-cli.ts` — 26.51% lines / 20% functions despite `gh-cli.test.ts`; tests mostly cover helper/logic paths rather than process-exec behavior.

## 4.4 Critical path integration coverage status

- **SQLite migration paths:** covered (`packages/core/src/migration.test.ts:329-363`, `db-migrate.test.ts`)
- **Agent lifecycle/restart recovery:** covered (`packages/engine/src/restart.integration.test.ts:717+`, `resumeOrphaned` scenarios)
- **Task state transitions:** covered primarily via `packages/core/src/store.test.ts`
- **Merge conflict resolution:** covered in merger tests (`packages/engine/src/merger.test.ts:975+`, conflict categorization/retry logic)
- **WebSocket reconnection:** hook-level reconnection covered (`packages/dashboard/app/hooks/__tests__/useBadgeWebSocket.test.ts:154`), but no full end-to-end websocket reconnection integration test combining server + client state freshness logic.

## 4.5 Memory pitfall cross-reference

From `.fusion/memory.md` testing pitfalls:

- **Engine pool setting must remain threads** — config currently reflects this (`packages/engine/vitest.config.ts:10`), but there is no dedicated regression test guarding accidental config drift.
- **Dashboard 429 retry test requires 30s timeout** — still covered (`packages/dashboard/src/routes.test.ts:3992-4016`).
- **Build-before-test/workspace hydration pitfalls** — operationally reproducible; not represented by explicit dedicated regression tests as standalone safeguards.

---

## 5) Strengths

1. **Core package depth is excellent**: strong DB/store/migration coverage and many realistic persistence-level tests.
2. **Engine scenario breadth is strong**: restart, scheduler, merge, semaphore, stuck-task logic, and runtime abstractions are broadly exercised.
3. **Dashboard test volume is high**: route coverage breadth and many UI/unit tests protect core workflows.
4. **Edge-path testing exists in every package**: 17.9% edge-focused `it()` across audited suites.
5. **Mock density is generally controlled** outside CLI bootstrapping tests.

---

## 6) Recommendations (ranked)

1. **Add dedicated tests for `child-process-worker.ts` and child-process runtime lifecycle** (highest engine isolation risk).
2. **Split and test `mission-routes.ts` by feature area**; add integration coverage for mission autopilot + route error handling.
3. **Add tests for untested dashboard hooks/components in task/agent workflows** (`useAgents`, `useProjectHealth`, `useFileBrowser`, `useFileEditor`, `MissionInterviewModal`, `AgentImportModal`, `AgentGenerationModal`).
4. **Add focused tests for `core/src/automation.ts`** to complement `automation-store` coverage.
5. **Increase branch coverage in `engine/reviewer.ts` and `cli/project-resolver.ts`** by testing fallback/error branches explicitly.
6. **Add end-to-end websocket reconnection + freshness tests** (server event + client merge behavior), not just hook-unit reconnection.
7. **Stabilize timer-heavy suites** by reducing reliance on real delays where feasible and consolidating fake-timer patterns.
8. **Add regression guard for engine vitest pool configuration** (`pool: "threads"`) to prevent accidental VM pool regressions.

---

## 7) Follow-up Tasks

Created from this audit:

- [ ] `FN-1279` — Add engine child-process runtime regression coverage (`child-process-worker.ts`, runtime lifecycle + IPC behavior).
- [ ] `FN-1280` — Add focused tests for `packages/core/src/automation.ts` schedule/validation/error paths.
- [ ] `FN-1281` — Close major dashboard route/service coverage gaps (`mission-routes.ts`, `subtask-breakdown.ts`, `script-store.ts`).
- [ ] `FN-1282` — Add tests for untested dashboard agent workflow hooks/components (`useAgents`, `useProjectHealth`, file hooks, agent modals, mission interview modal).
- [ ] `FN-1283` — Improve CLI test effectiveness (`settings-import.ts`, `settings-export.ts`, `project-resolver.ts`, `bin.ts` fallback paths).

---

# FN-1675 Roadmap Regression Test Coverage

_Date: 2026-04-16_

## Summary

Added comprehensive regression test coverage for the standalone roadmap feature set across core persistence, dashboard API routes, and frontend hook/component layers.

## Coverage Matrix

### Core Persistence (`packages/core/src/`)

| Test File | Tests | Coverage Areas |
|-----------|-------|---------------|
| `roadmap-store.test.ts` | 86 | CRUD operations, reorder (milestone/feature), cross-milestone move, hierarchy operations, export/handoff, **persistence re-instantiation**, **negative ordering tests** |
| `roadmap-ordering.test.ts` | 14 | Pure ordering helpers, deterministic tie-breaker resolution, **boundary tests (negative/NaN/Infinity targetOrderIndex)**, **contiguous orderIndex verification** |
| `roadmap-handoff.test.ts` | 20 | Handoff mapping functions, source lineage preservation, deterministic ordering |

**Key additions:**
- Persistence re-instantiation tests verifying data survives database close/reopen
- Boundary tests for `targetOrderIndex` clamping (negative, NaN, Infinity)
- Negative tests for roadmapId/fromMilestoneId mismatches
- Explicit contiguous orderIndex assertions for all reorder/move operations

### Dashboard Routes (`packages/dashboard/src/`)

| Test File | Tests | Coverage Areas |
|-----------|-------|---------------|
| `roadmap-routes.routes.test.ts` | 30 | CRUD endpoints, reorder/move, suggestions (mocked), handoff, project scoping, **validation error (400) tests** |
| `roadmap-suggestions.test.ts` | 65 | Input validation, AI output normalization, failure behavior |

**Key additions:**
- 400 validation error tests for roadmap/milestone/feature creation
- 400 validation error tests for reorder payloads

### Dashboard Hooks (`packages/dashboard/app/hooks/`)

| Test File | Tests | Coverage Areas |
|-----------|-------|---------------|
| `useRoadmaps.test.ts` | 52 | State management, CRUD, reorder/move with optimistic updates, rollback on failure, **handoff/fetch**, **stale async guard**, **no-op suppression** |

**Key additions:**
- Handoff/fetch tests (fetchHandoff, clearHandoff, project-context clearing)
- Stale async response rejection for handoff fetches
- No-op suppression tests for reorder/move operations

### Dashboard API Wrapper (`packages/dashboard/app/`)

| Test File | Tests | Coverage Areas |
|-----------|-------|---------------|
| `api.test.ts` | 14 (roadmap-specific) | Roadmap API wrappers, 204 void handling, projectId propagation, reorder/move/suggestion/handoff endpoints |

## Test Quality Notes

- **Persistence tests** use isolated temp directories with proper cleanup
- **Stale async guard** tests use version-ref pattern matching `useTasks` patterns
- **No-op suppression** prevents unnecessary API calls for no-position-change operations
- **Validation tests** cover both happy-path and error-path assertions
- **Boundary tests** cover edge cases (negative, NaN, Infinity indices)

## Files Modified

### Core (`packages/core/src/`)
- `roadmap-store.test.ts` — +349 lines (persistence, negative ordering, listFeatureTaskPlanningHandoffs, getMissionPlanningHandoff)
- `roadmap-ordering.test.ts` — +4 tests (boundary conditions)

### Dashboard Routes (`packages/dashboard/src/`)
- `roadmap-routes.routes.test.ts` — +65 lines (400 validation tests)

### Dashboard Hooks (`packages/dashboard/app/hooks/`)
- `useRoadmaps.ts` — Fixed stale closure bug (use `projectIdRef.current`)
- `useRoadmaps.test.ts` — +313 lines (handoff tests, no-op suppression tests)

## Test Execution

```bash
# Core roadmap tests
pnpm --filter @fusion/core exec vitest run src/roadmap-store.test.ts src/roadmap-ordering.test.ts src/roadmap-handoff.test.ts

# Dashboard route tests
pnpm --filter @fusion/dashboard exec vitest run src/roadmap-routes.routes.test.ts src/roadmap-suggestions.test.ts

# Dashboard hook tests
pnpm --filter @fusion/dashboard exec vitest run app/hooks/__tests__/useRoadmaps.test.ts

# All roadmap tests (combined)
pnpm --filter @fusion/core exec vitest run src/roadmap
pnpm --filter @fusion/dashboard exec vitest run src/roadmap app/api.test.ts -t roadmap
```

## Coverage Verification

All 120 core roadmap tests pass, 95 dashboard route/suggestion tests pass, 52 hook tests pass.
