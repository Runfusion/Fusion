# FN-1205 System Gap Analysis

Date: 2026-04-08  
Scope: `packages/core`, `packages/engine`, `packages/dashboard`, `packages/cli`, `packages/tui`, `packages/desktop`

## 1) Incomplete & Stub Packages

### Finding 1.1 — `@fusion/tui` is still a stub package (**Medium**)
- Evidence: `packages/tui/src/index.tsx` only renders `Hello from @fusion/tui!` via Ink and has no command routing, task views, or integration points.
- Impact: The workspace includes a TUI package, but it is not usable for real workflows and may be mistaken as production-ready.
- Existing tracking: **FN-1055** is present in task list and describes this exact stub gap.

### Finding 1.2 — `packages/desktop` is implemented, not a placeholder (**Info / correction to preflight assumption**)
- Evidence: `packages/desktop` contains `package.json`, `tsconfig.json`, `vitest.config.ts`, `README.md`, build scripts, and substantial source files (`src/main.ts`, `src/ipc.ts`, `src/menu.ts`, `src/tray.ts`, `src/preload.ts`, renderer components/hooks, etc.).
- Impact: The package is active code, so it should not be categorized as "dist-only placeholder".
- Existing tracking: open desktop initiative tasks **FN-1070** through **FN-1076** exist in task list and indicate staged desktop work; this is now better characterized as incremental feature completion, not missing package scaffolding.

### Finding 1.3 — Engine runtime abstraction is real implementation (**No gap**)
- Evidence: `packages/engine/src/runtimes/in-process-runtime.ts` (~500+ lines), `child-process-runtime.ts` (~500+ lines), and `child-process-worker.ts` include concrete lifecycle logic, event forwarding, health monitoring, and startup/shutdown flows.
- Corroboration: each has dedicated tests (`in-process-runtime.test.ts`, `child-process-runtime.test.ts`).

### Finding 1.4 — IPC layer is real implementation (**No gap**)
- Evidence: `packages/engine/src/ipc/ipc-host.ts`, `ipc-protocol.ts`, and `ipc-worker.ts` implement message contracts, correlation IDs, host/worker command handling, validation, and shutdown/error signaling.
- Corroboration: dedicated tests exist (`ipc-host.test.ts`, `ipc-protocol.test.ts`, `ipc-worker.test.ts`).

## 2) Missing Test Coverage

Method used:
- Recursive scan of `packages/{core,engine,dashboard,cli}/src/**/*.ts`
- Excluded `*.test.ts`, `*.d.ts`, `index.ts`, `types.ts`, `*-types.ts`
- Marked "missing direct test" when neither sibling `<file>.test.ts` nor `__tests__/<file>*.test.*` exists

### Finding 2.1 — Direct file-level gaps by package

| Package | Missing direct test files | Notes |
|---|---:|---|
| core | 1 | `automation.ts` (mostly type/constants) |
| engine | 3 | `agent-tools.ts`, `github.ts`, `runtimes/child-process-worker.ts` |
| dashboard | 8 | `mission-routes.ts`, `script-store.ts`, `subtask-breakdown.ts`, `terminal.ts`, `plugins/{network,splash-screen,status-bar}.ts`, `test-request.ts` |
| cli | 4 | `commands/settings-export.ts`, `commands/settings-import.ts`, `companies-sh-parser.ts`, `runtime/native-patch.ts` |

### Finding 2.2 — Risk triage for key backend files

- **High**
  - `packages/dashboard/src/subtask-breakdown.ts` — AI/session orchestration and persistence interactions; only route-level behavior is exercised.
  - `packages/dashboard/src/terminal.ts` — command validation + process spawning module has no tests and currently appears unused (no imports found), increasing drift risk.
  - `packages/dashboard/src/script-store.ts` — file persistence logic under `~/.pi/fusion/scripts.json` has no direct tests.
- **Medium**
  - `packages/dashboard/src/mission-routes.ts` — no dedicated unit test file, but substantial endpoint coverage exists via `mission-e2e.test.ts`.
  - `packages/engine/src/github.ts` — git remote parsing helper has no direct test despite influencing scheduler GitHub linking behavior.
  - `packages/cli/src/commands/settings-export.ts` and `settings-import.ts` — command handlers are routed in bin tests but lack dedicated behavior-focused tests.
- **Low**
  - `packages/cli/src/companies-sh-parser.ts` — thin re-export from `@fusion/core` (actual parser tested in core).
  - `packages/core/src/automation.ts` — static type/preset definitions.
  - dashboard plugin wrappers (`plugins/network.ts`, `plugins/splash-screen.ts`, `plugins/status-bar.ts`) and `test-request.ts` utility.

### Finding 2.3 — Corrections to preflight assumptions

- `packages/dashboard/src/ai-session-store.ts` is **not untested**. It has `ai-session-store.test.ts`.
- However, that test file currently focuses on `listActive`; other methods (`upsert`, `updateThinking`, `recoverStaleSessions`, cleanup paths) have limited direct assertions.

### Finding 2.4 — Dashboard frontend test surface (informational)

- In `packages/dashboard/app`, 124 source `.ts/.tsx` files were scanned.
- 29 files lack direct sibling/`__tests__` matches (examples: `App.tsx`, `useAgents.ts`, `useFileEditor.ts`, `useProjectHealth.ts`, several mission/node modal components).
- This is informational only; deeper frontend test quality/effectiveness belongs to FN-1204.

## 3) Naming & Branding Inconsistencies

### Finding 3.1 — CLI help/output still uses `kb` in user-facing text (**Medium**, already tracked)

Confirmed user-facing examples:
- `packages/cli/src/bin.ts` help: `fn init [opts] Initialize a new kb project in the current directory`
- `packages/cli/src/commands/init.ts`: `Initializing kb project...`, `kb project already initialized`
- `packages/cli/src/commands/project.ts`: `No kb project found ...`, `Run 'kb init' ...`, and several `Usage: kb ...` lines
- `packages/cli/src/commands/dashboard.ts`: header line prints `kb board`
- `packages/cli/src/commands/task.ts`: empty-state hint says `Create one with: kb task create`

Notes:
- Not all matches are inconsistencies. Strings like `KB` as kilobytes, or internal user-agent tokens (`kb-cli/1.0`) are technical/internal.
- This category is broadly covered by existing tasks **FN-1163** and **FN-1216**.

### Finding 3.2 — Pi extension still branded as `KB` tools (**Medium**, likely covered by FN-1216 scope)

In `packages/cli/src/extension.ts`:
- Tool labels remain `KB: Create Task`, `KB: List Tasks`, etc.
- Parameter examples use `KB-001` style IDs.
- Tool names use `kb_*` namespace (`kb_task_create`, `kb_task_update`, ...).

Impact:
- In-chat affordances present mixed branding (`Fusion` in descriptions but `KB` in labels/tool names), which increases cognitive friction.

### Finding 3.3 — Dashboard UI still exposes `kb` text in visible strings (**Medium**, already tracked)

User-visible occurrences include:
- `packages/dashboard/app/components/PrSection.tsx`: `kb is creating/merging...`
- `packages/dashboard/app/components/ProjectDetectionResults.tsx`: `No kb database found - will be initialized`
- `packages/dashboard/app/components/SettingsModal.tsx`: `These settings are shared across all your kb projects`, and text describing merge behavior as `kb` behavior.

### Finding 3.4 — Legacy `kb-*` localStorage keys are pervasive (**Low/intentional technical debt)

Many dashboard files use keys such as `kb-dashboard-view-mode`, `kb-terminal-tabs`, `kb-agent-view`, etc.

Assessment:
- These are not necessarily user-facing inconsistencies.
- Renaming blindly risks preference loss unless key-migration is implemented.
- Treat as migration debt, not cosmetic string cleanup.

## 4) Error Handling & Silent Failures

### Finding 4.1 — Empty `catch {}` blocks exist in engine and dashboard usage code (**Medium**)

Detected with `rg -n 'catch\s*\{\s*\}' packages/*/src/`:

- `packages/engine/src/executor.ts:944` and `:985`
  - Context: best-effort `git worktree remove ... --force` cleanup during transient retry and stuck-kill requeue paths.
  - Risk: if cleanup fails silently, stale worktrees/branches can accumulate and complicate later retries.
- `packages/dashboard/src/usage.ts:227, 511, 536, 587, 707, 1037`
  - Context: credential file reads and PTY process kill attempts in usage collectors.
  - Risk: mostly low/acceptable fallback behavior, but `catch {}` on config/credential reads can hide parse corruption or permission issues and degrade diagnosability.

### Finding 4.2 — Executor failure paths can leave tasks in `in-progress` with `status=failed` (**High**)

In `packages/engine/src/executor.ts` outer catch for single-session path:
- Several error paths set `status: "failed"` and `error` but do **not** move task out of `in-progress`.
- This includes failures during early lifecycle phases (e.g., worktree/session creation) before task reaches `in-review`.

Impact:
- Task is no longer actively executing but remains in an execution column.
- Scheduler generally dispatches from `todo`, so this can behave like a stranded/stuck state requiring manual intervention.

### Finding 4.3 — Async event callbacks without top-level guard can produce unhandled rejections (**High**)

- `packages/engine/src/executor.ts` registers `store.on("task:updated", async (task) => { ... })` with multiple awaited calls but no outer `try/catch` wrapper.
  - Any thrown error inside that callback can become an unhandled rejection on EventEmitter dispatch.
- `packages/cli/src/commands/dashboard.ts` has async settings listeners; one callback awaits `stuckTaskDetector.checkNow()` without a local guard.

Impact:
- Runtime stability risk (process warnings, noisy logs, or crash under strict unhandled-rejection policies).
- Intermittent failures in pause/resume or live-update behavior become harder to trace.

### Finding 4.4 — Routes layer has broad but inconsistent 500 handling (**Medium**)

`packages/dashboard/src/routes.ts` usually wraps endpoints in try/catch, but error response patterns are inconsistent:
- Some endpoints return detailed `{ error: err.message }`.
- Others return generic fallback text (`"Internal server error"`), often without standardized error codes.

Impact:
- Inconsistent API troubleshooting UX for frontend consumers.
- Harder to bucket/retry operational errors programmatically.

Assessment:
- This is not a complete lack of handling (there is substantial try/catch coverage), but a consistency/observability gap.

## 5) Feature Completeness

Classification rubric used:
- **Implemented**: real code + wiring in runtime/API/UI
- **Partial**: meaningful code exists, but key wiring/surfaces are missing
- **Planned**: tracked by tasks, little/no implementation in target layers
- **Missing**: documented but no code and no tracking task found

### Feature status matrix

| Feature | Status | Evidence |
|---|---|---|
| Multi-project core (`CentralCore`) | **Implemented** | `packages/core/src/central-core.ts` + tests (`central-core.test.ts`) + widespread CLI/dashboard usage |
| Multi-project runtime orchestration (`HybridExecutor`) | **Partial** | `packages/engine/src/hybrid-executor.ts` exists, but is not exported from `packages/engine/src/index.ts` and has no observed runtime wiring in CLI/dashboard paths (which currently use `ProjectManager` directly) |
| Mission autopilot | **Implemented** | `packages/engine/src/mission-autopilot.ts`, scheduler integration, mission routes autopilot endpoints, dashboard `MissionManager` controls |
| Workflow step templates | **Implemented** | API routes (`/workflow-step-templates`) + dashboard `WorkflowStepManager` template tab + core templates catalog |
| Plugin system (FN-1111/FN-1113/FN-1114) | **Planned** | No plugin loader/SDK runtime code found in `packages/core/src` or `packages/engine/src`; matching roadmap tasks exist |
| Node management (FN-1078..1081) | **Implemented** | CentralCore node registry/health APIs + engine remote runtime + CLI node commands + dashboard node UI/components |
| Agent companies parser/types | **Implemented** | `companies-sh-parser.ts` and `companies-sh-types.ts` with dedicated tests and CLI import flow |
| Agent self-reflection (FN-1181..1183) | **Partial** | Core `ReflectionStore` + reflection types exist; no engine execution workflow/UI evidence for full feature completion |
| Agent performance ratings (FN-1184..1187) | **Planned/Partial** | Reflection summary primitives exist, but no dedicated ratings service/API/UI found; roadmap tasks still present |
| Agent org chart / chain of command (FN-1164..1167) | **Partial** | Core supports `reportsTo`, `getChainOfCommand`, `getOrgTree`; dashboard currently exposes child/hierarchy views, but dedicated full org-chart product surface appears incremental |
| Agent instructions bundle (FN-1170..1173) | **Partial** | Core `bundleConfig` and bundle file operations exist; engine/dashboard primarily use legacy `instructionsText`/`instructionsPath`, with limited visible bundle-first UX |
| Session persistence & reconnect (FN-1145..1156) | **Partial** | `ai_sessions` persistence + resume flows implemented; no clear `Last-Event-ID` replay / BroadcastChannel cross-tab continuity implementation found |
| Quick chat floating action button (FN-1104) | **Implemented** | `QuickChatFAB` component exists, styled, and mounted in `App.tsx` |

### Notes

- No **Missing** features (documented with no code and no tracking task) were found in the sampled set.
- Several areas are clearly in "in-progress productization": architecture exists in core layers, but integration depth and UX completeness vary.

## 6) Architectural Concerns

### Finding 6.1 — Very large "god files" increase change risk (**Medium–High**)

Current sizes:
- `packages/dashboard/src/routes.ts`: **10,343** lines
- `packages/core/src/store.ts`: **3,278** lines
- `packages/engine/src/executor.ts`: **3,172** lines

Assessment:
- All three are actively maintained and internally sectioned, but they still represent broad responsibility concentration.
- `routes.ts` is the highest-risk hotspot due to mixed concerns (task APIs, missions, agents, files, integrations, settings, automation, node/project routes).

### Finding 6.2 — localStorage footprint remains broad in dashboard app (**Medium**, already tracked)

- 18 app files reference `localStorage` (127 call sites), including `App.tsx`, mission/planning/subtask modals, task creation components, and multiple hooks.
- Includes UX-state persistence (reasonable) and legacy key namespace coupling (`kb-*`).

Cross-reference:
- Existing tasks **FN-1201** and **FN-1202** already target server-vs-client persistence boundaries.

### Finding 6.3 — Duplication in GitHub remote parsing logic across packages (**Medium**)

- `packages/core/src/gh-cli.ts` implements `parseRepoFromRemote()` + gh execution wrappers.
- `packages/engine/src/github.ts` separately implements similar `parseGitHubRemote()` and `getCurrentGitHubRepo()` logic.

Impact:
- Risk of drift in URL parsing behavior and edge-case handling between scheduler/engine and core CLI helpers.

### Finding 6.4 — Layering is healthy: no core → engine/dashboard circular import leak (**Good / no gap**)

- No imports from `@fusion/engine` or `@fusion/dashboard` were found under `packages/core/src`.
- This preserves intended package dependency direction.

### Finding 6.5 — Dashboard lacks explicit React error boundaries (**High**)

- No `ErrorBoundary`/`componentDidCatch`/`react-error-boundary` usage found in `packages/dashboard/app` source.
- A runtime exception in a top-level render subtree can take down the entire dashboard view instead of degrading gracefully.

## 7) Summary & Follow-up

### Gap counts by audit dimension

| Dimension | Gap count | Notes |
|---|---:|---|
| 1. Incomplete & Stub Packages | 1 | `@fusion/tui` remains stub (desktop/runtime/ipc are implemented) |
| 2. Missing Test Coverage | 16 (direct file-level gaps) | Concentrated in dashboard/cli utility layers |
| 3. Naming & Branding | 4 | User-facing `kb` strings remain across CLI, extension, dashboard |
| 4. Error Handling & Silent Failures | 4 | Includes two high-severity runtime reliability issues |
| 5. Feature Completeness | 7 (partial/planned) | Mostly integration depth gaps, not zero-code absences |
| 6. Architectural Concerns | 4 | Monolith pressure, duplication, missing React error boundaries |

### Severity distribution (using task rubric)

- **Critical:** 0
- **High:** 5
- **Medium:** 12
- **Low:** 3

High-severity items center on runtime stability (task lifecycle correctness, unhandled async failures, crash containment) rather than security/data-exfiltration risk.

### Top 5 impactful untracked gaps selected for follow-up

1. **Executor failure transitions can strand tasks in `in-progress`** (Section 4.2, High)  
   Follow-up: **FN-1284**
2. **Async EventEmitter listeners lack top-level rejection guards** (Section 4.3, High)  
   Follow-up: **FN-1285**
3. **Dashboard lacks React error boundaries** (Section 6.5, High)  
   Follow-up: **FN-1286**
4. **Routes error responses/logging are inconsistent** (Section 4.4, Medium)  
   Follow-up: **FN-1287**
5. **GitHub remote parsing logic duplicated across core/engine** (Section 6.3, Medium)  
   Follow-up: **FN-1288**

### Exclusions applied to avoid duplicate follow-up tasks

Per task instructions, no new tasks were created for gaps already tracked by:
- FN-1055 (TUI stub)
- FN-1070..FN-1076 (desktop)
- FN-1111/FN-1113/FN-1114 (plugin system)
- FN-1163/FN-1216 (kb→fn/fusion naming)
- FN-1201/FN-1202 (localStorage boundary)
- FN-1203 (App.tsx splitting)
- FN-1204 (test effectiveness deep dive)
- FN-1161 (fragility review)
