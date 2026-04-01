# Coverage Gap Analysis

**Generated:** 2026-04-01
**Task:** FN-689

## Files Without Any Tests

Source files that have no corresponding test file (checked both co-located `*.test.ts` and `__tests__/*.test.ts` patterns).

### Core Package (`@fusion/core`)

| File | Lines | Category | Priority | Notes |
|------|-------|----------|----------|-------|
| `agent-store.ts` | 597 | Business Logic | ~~High~~ ✅ | Agent state management store — **covered by FN-704** (62 tests in `agent-store.test.ts`) |
| `automation.ts` | 143 | Types/Constants | Low | Pure type definitions and constant mappings — tested indirectly via `automation-store.test.ts` |
| `mission-types.ts` | 253 | Types/Constants | Low | Type definitions for missions — tested indirectly via `mission-store.test.ts` |
| `types.ts` | 1228 | Types/Constants | Low | Core type definitions — no runtime logic to test |
| `index.ts` | 148 | Barrel/Re-export | Low | Re-export barrel — no logic |

### Engine Package (`@fusion/engine`)

| File | Lines | Category | Priority | Notes |
|------|-------|----------|----------|-------|
| `ipc/ipc-host.ts` | 279 | Infrastructure | **High** | IPC host for child process communication — critical for multi-project |
| `ipc/ipc-worker.ts` | 325 | Infrastructure | **High** | IPC worker for child process communication — critical for multi-project |
| `runtimes/child-process-worker.ts` | 174 | Infrastructure | Medium | Child process entry point — pairs with IPC worker |
| `pi.ts` | 109 | Integration | Medium | Pi integration utilities — external service integration |
| `github.ts` | 37 | Integration | Low | GitHub utility (small helper file) |
| `index.ts` | 17 | Barrel/Re-export | Low | Re-export barrel — no logic |

### CLI Package (`@gsxdsm/fusion`)

| File | Lines | Category | Priority | Notes |
|------|-------|----------|----------|-------|
| `bin.ts` | 786 | Entry Point | **High** | Main CLI entry point with command registration — critical but integration-heavy |
| `commands/backup.ts` | 131 | Command | Medium | Backup CLI command — moderately important |
| `commands/settings-export.ts` | 74 | Command | Medium | Settings export command |
| `commands/settings-import.ts` | 128 | Command | Medium | Settings import command |
| `runtime/native-patch.ts` | 223 | Runtime | Medium | Native module patching — platform-specific logic |

### Dashboard Package (`@fusion/dashboard`)

#### Components Without Tests

| File | Lines | Category | Priority | Notes |
|------|-------|----------|----------|-------|
| `TaskChangesTab.tsx` | 199 | UI Component | **High** | Task file changes display — user-facing feature |
| `ProjectDetectionResults.tsx` | 253 | UI Component | Medium | Project detection results display |
| `SetupProjectForm.tsx` | 225 | UI Component | Medium | Project setup form |
| `SetupWizardModal.tsx` | 217 | UI Component | Medium | First-run wizard modal |
| `ProjectHealthBadge.tsx` | 106 | UI Component | Medium | Project health status badge |
| `FileBrowser.tsx` | 113 | UI Component | Medium | File browser component |
| `ProjectGridSkeleton.tsx` | 80 | UI Component | Low | Loading skeleton — minimal logic |
| `TaskCardBadge.tsx` | 69 | UI Component | Low | Badge display component |
| `WorktreeGroup.tsx` | 59 | UI Component | Low | Worktree grouping component |
| `StepTypeBadge.tsx` | 25 | UI Component | Low | Simple badge — trivial |
| `ToastContainer.tsx` | 18 | UI Component | Low | Toast notifications container — trivial |

#### Hooks Without Tests

| File | Lines | Category | Priority | Notes |
|------|-------|----------|----------|-------|
| `useProjectHealth.ts` | 143 | Hook | **High** | Project health polling hook — multi-project feature |
| `useFileEditor.ts` | 120 | Hook | Medium | File editor hook (variants `useProjectFileEditor`/`useWorkspaceFileEditor` are tested) |
| `useFileBrowser.ts` | 84 | Hook | Medium | File browser hook (variants `useProjectFileBrowser`/`useWorkspaceFileBrowser` are tested) |

#### Utils Without Tests

| File | Lines | Category | Priority | Notes |
|------|-------|----------|----------|-------|
| `projectDetection.ts` | 146 | Utility | Medium | Project auto-detection logic |

#### Server-Side (`src/`) Without Tests

| File | Lines | Category | Priority | Notes |
|------|-------|----------|----------|-------|
| `mission-routes.ts` | 1137 | API Routes | **High** | Mission API route handlers — large untested file |
| `terminal.ts` | 347 | Service | **High** | Terminal service — complex functionality |
| `subtask-breakdown.ts` | 331 | Service | **High** | AI subtask breakdown service — user-facing feature |
| `sse.ts` | 51 | Service | Medium | Server-Sent Events utility |
| `index.ts` | 5 | Barrel/Re-export | Low | Re-export barrel |

#### Entry Points (Not Testable)

| File | Lines | Notes |
|------|-------|-------|
| `app/main.tsx` | 10 | React DOM entry point — bootstrap code |
| `src/test-request.ts` | 95 | Test utility, not production code |

### Summary by Priority

| Priority | Count | Total Lines |
|----------|-------|-------------|
| **High** | 10 | 4,143 |
| Medium | 15 | 2,693 |
| Low | 12 | 1,726 |

**High-priority untested files** represent the most critical coverage gaps:
1. `dashboard/src/mission-routes.ts` (1,137 lines) — Entire mission API surface untested
2. `cli/src/bin.ts` (786 lines) — CLI entry point with all command registration
3. `core/src/agent-store.ts` (597 lines) — Agent state management with zero coverage
4. `dashboard/src/terminal.ts` (347 lines) — Terminal service
5. `dashboard/src/subtask-breakdown.ts` (331 lines) — Subtask AI breakdown
6. `engine/src/ipc/ipc-worker.ts` (325 lines) — IPC worker
7. `engine/src/ipc/ipc-host.ts` (279 lines) — IPC host
8. `dashboard/app/components/TaskChangesTab.tsx` (199 lines) — File changes UI
9. `dashboard/app/hooks/useProjectHealth.ts` (143 lines) — Health polling hook
10. Engine tests cannot run with coverage due to **OOM** (pre-existing issue)

---

## Low Coverage Areas

Files that have tests but with coverage below thresholds: line coverage < 50%, function coverage < 50%, or branch coverage < 40%.

> **Note:** Engine package numbers are from a partial coverage run (5 of 27 test files) due to OOM. Many engine files show 0% because their tests didn't run in the subset, not because of genuinely low coverage.

### Package-Level Summary

| Package | Files | Line Coverage | Function Coverage | Branch Coverage | Notes |
|---------|-------|--------------|-------------------|-----------------|-------|
| **core** | 21 | **80.6%** | 91.3% | 84.4% | Good overall; agent-store.ts is the main gap |
| **engine** | 30 | **6.0%** ⚠️ | 77.8% | 83.4% | Severely undercounted due to OOM — only 5/27 test files ran |
| **cli** | 14 | **36.2%** | 44.3% | 67.7% | Many commands lack tests; 8 of 18 test files failed |
| **dashboard** | 108 | **70.2%** | 68.9% | 84.6% | Good hooks/components; server-side routes need work |

### Core Package — Low Coverage Files

| File | Lines % | Functions % | Branches % | Priority | Notes |
|------|---------|-------------|------------|----------|-------|
| `gh-cli.ts` | 26.5% | 20% | 100% | Medium | GitHub CLI integration — 4 of 5 functions uncovered |
| `ai-summarize.ts` | 59.5% | 90.9% | 81.8% | Low | Most logic covered, AI integration paths missing |

The core package has **strong overall coverage** (80.6% lines). The main gap is `agent-store.ts` (0% — completely untested) and `gh-cli.ts` (26.5% — mostly untested integration code).

### CLI Package — Low Coverage Files

| File | Lines % | Functions % | Branches % | Priority | Notes |
|------|---------|-------------|------------|----------|-------|
| `commands/task.ts` | 17.1% | 40% | 45.2% | **High** | Largest command file with most CLI functionality |
| `project-resolver.ts` | 28.3% | 33.3% | 80.3% | **High** | Project resolution logic — critical for multi-project |
| `commands/dashboard.ts` | 30.0% | 9.1% | 47.6% | Medium | Dashboard launch/management commands |
| `extension.ts` | 56.3% | 44.8% | 70.7% | Medium | Pi extension — many tools have low function coverage |
| `commands/project.ts` | 48.3% | 50% | 40.9% | Medium | Project management commands |
| `project-context.ts` | 56.4% | 60% | 76.2% | Low | Project context resolution |
| `commands/mission.ts` | 52.2% | 55.6% | 66.0% | Low | Mission CLI commands |

**Key finding:** The `commands/task.ts` file (1,486 lines) has only 17% line coverage despite being the primary user-facing CLI surface. Many task subcommands are completely untested.

### Dashboard Package — Low Coverage Files

#### Server-Side (API routes and services)

| File | Lines % | Functions % | Branches % | Priority | Notes |
|------|---------|-------------|------------|----------|-------|
| `server.ts` | 28.7% | 40% | 43.8% | **High** | Main server setup — much initialization untested |
| `mission-routes.ts` | 37.0% | 57.1% | 84.9% | **High** | Mission API routes — large file, partial coverage |
| `terminal.ts` | 36.6% | 11.1% | 100% | **High** | Terminal service — 8 of 9 functions untested |
| `planning.ts` | 42.1% | 63.3% | 84.2% | Medium | AI planning service |
| `routes.ts` | 47.1% | 74.1% | 92.7% | Medium | Main route handlers — many endpoints lack tests |
| `subtask-breakdown.ts` | 50.6% | 47.4% | 50% | Medium | AI subtask service |

#### Frontend Components

| File | Lines % | Functions % | Branches % | Priority | Notes |
|------|---------|-------------|------------|----------|-------|
| `NewTaskModal.tsx` | 47.1% | **12.9%** | 56.6% | **High** | Complex modal with many untested interactions |
| `SettingsModal.tsx` | 63.2% | **39.7%** | 81.9% | Medium | Large settings modal — many sections untested |
| `PlanningModeModal.tsx` | 82.0% | **46.7%** | 80.7% | Low | Planning modal — some functions untested |
| `SetupWizardModal.tsx` | 66.9% | 25% | **12.5%** | Medium | Wizard modal — very low branch coverage |
| `TaskCardBadge.tsx` | 38% | 50% | 100% | Low | Badge component — small file |
| `WorktreeGroup.tsx` | 12.5% | 0% | 100% | Low | Worktree grouping — small file |

#### Frontend Hooks

| File | Lines % | Functions % | Branches % | Priority | Notes |
|------|---------|-------------|------------|----------|-------|
| `useProjectHealth.ts` | 37.2% | 100% | 62.5% | Medium | Health hook — has function calls but low execution |
| `useActivityLog.ts` | 74.4% | 100% | 92.3% | Low | Activity log hook |

### Engine Package — Known Coverage Data

> ⚠️ The engine package cannot run all tests with coverage enabled due to a pre-existing OOM issue. Tests consistently crash with "heap limit Allocation failed" even with `--max-old-space-size=8192`. The following is based on a partial run of 5 test files.

**Files with confirmed good coverage** (from partial run):
- `concurrency.ts` — 100% lines, 100% functions, 100% branches
- `logger.ts` — 100% lines, 100% functions, 100% branches
- `agent-heartbeat.ts` — 93.6% lines, 100% functions, 91.7% branches
- `notifier.ts` — 96.5% lines, 92.9% functions, 87.5% branches
- `worktree-names.ts` — 85.2% lines, 66.7% functions, 90.9% branches

**Files that have tests but couldn't be measured** (OOM prevented coverage collection):
- `executor.ts` (1,885 lines) — Core task executor
- `merger.ts` (1,275 lines) — Git merge logic
- `scheduler.ts` (611 lines) — Task scheduler
- `triage.ts` (1,205 lines) — Task specification
- `reviewer.ts` (344 lines) — Code/spec reviewer
- `cron-runner.ts` (407 lines) — Cron schedule runner
- `worktree-pool.ts` (215 lines) — Git worktree pool
- `stuck-task-detector.ts` (223 lines) — Stuck task detection
- `pr-monitor.ts` (298 lines) — PR monitoring
- `pr-comment-handler.ts` (190 lines) — PR comment handling

---

## Pre-Existing Test Failures

The following test failures were observed during coverage collection and are **not** caused by this task's changes:

### Core Package (4 failures)

1. **`db-migrate.test.ts`** — 3 failures in legacy migration tests:
   - "migrates task.json files to tasks table" — `expected undefined to be defined`
   - "skips invalid task.json files" — `expected undefined to be defined`
   - "preserves all task fields through migration" — `Cannot read properties of undefined`
   - **Root cause:** Likely database schema drift — `db.prepare().get()` returns undefined

2. **`store.test.ts`** — 1 failure:
   - "adds log entry for the action" — comment log entry assertion fails
   - **Root cause:** `addComment` implementation may have changed log format

### CLI Package (8 test files failed, 111 test failures)

- Multiple failures in `task.test.ts`, `project.test.ts`, `dashboard.test.ts` due to project resolution / TaskStore initialization errors
- **Root cause:** Tests depend on runtime initialization that may require additional mocking

### Dashboard Package (select failures)

- Some component tests had intermittent failures related to mock setup
- SSE and websocket tests have timing-sensitive assertions

### Engine Package

- All tests OOM when run together (with or without coverage)
- Individual test files pass when run in isolation
- **Root cause:** Memory leak in test infrastructure or test cleanup — pre-existing issue

---

## Top 10 Priority Files Needing Coverage Improvement

Ranked by combination of file size, criticality, and current coverage:

| Rank | Package | File | Lines | Current Coverage | Why Critical |
|------|---------|------|-------|-----------------|-------------|
| 1 | dashboard | `src/mission-routes.ts` | 1,137 | 37% lines | Entire mission API — user-facing |
| 2 | cli | `commands/task.ts` | 1,486 | 17% lines | Primary CLI interface — most used commands |
| 3 | core | `agent-store.ts` | 597 | 0% lines | Agent state management — zero tests |
| 4 | dashboard | `src/terminal.ts` | 347 | 37% lines | Terminal service — 8/9 functions untested |
| 5 | dashboard | `src/server.ts` | 559 | 29% lines | Server initialization — critical path |
| 6 | engine | `ipc/ipc-host.ts` | 279 | 0% (no test) | IPC host — multi-project critical |
| 7 | engine | `ipc/ipc-worker.ts` | 325 | 0% (no test) | IPC worker — multi-project critical |
| 8 | cli | `project-resolver.ts` | 915 | 28% lines | Project resolution — multi-project |
| 9 | dashboard | `src/subtask-breakdown.ts` | 331 | 51% lines | AI subtask feature |
| 10 | dashboard | `NewTaskModal.tsx` | 954 | 47% lines, 13% funcs | Complex modal — many untested paths |
