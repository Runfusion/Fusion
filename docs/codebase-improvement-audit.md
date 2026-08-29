# Codebase Improvement Audit

**Generated:** 2026-04-09  
**Task:** FN-1398  
**Scope:** `packages/core`, `packages/engine`, `packages/dashboard`, `packages/cli`  
**Methodology:** Re-validated existing audit findings from FN-1161 (improvements.md), FN-1205 (gap-analysis.md), and FN-1204 (test-audit-report.md) against current code state.

---

## 1. Scope & Methodology

### Files Examined
- **Context files read:** `.fusion/memory/MEMORY.md`, `package.json`, `docs/architecture.md`, `improvements.md`, `docs/gap-analysis.md`, `docs/test-audit-report.md`
- **Core hotspots:** `packages/core/src/store.ts` (3,895 LOC), `packages/engine/src/executor.ts` (3,355 LOC), `packages/dashboard/src/routes.ts` (12,480 LOC), `packages/cli/src/extension.ts` (1,741 LOC)
- **Engine runtime:** `packages/engine/src/runtimes/child-process-runtime.ts`, `packages/engine/src/step-session-executor.ts`, `packages/engine/src/project-manager.ts`, `packages/engine/src/cron-runner.ts`

### Audit Approach
1. Re-checked each finding from prior audits against current code state
2. Assessed whether issues are: **resolved**, **still open**, or **changed scope**
3. Provided concrete evidence (file paths + line numbers)
4. Incorporated memory-informed checks from `.fusion/memory/MEMORY.md`

---

## 2. Baseline Matrix — Re-validated Findings

### 2.1 Priority 1: Critical Issues (from FN-1161)

| # | Finding | Status | Evidence |
|---|---------|--------|----------|
| 1 | **Non-atomic dual persistence for task state** | **Still open** | `store.ts:488-500` (`atomicWriteTaskJson`) still writes SQLite first, then `task.json` as a non-atomic fallback. No reconciliation queue or consistency check endpoint exists. |
| 2 | **Migration steps can partially apply without rollback journal** | **Still open** | `db.ts:375-537` (`applyMigration`) still avoids transaction wrapping for ALTER paths. `db-migrate.ts:69-121` continues to catch per-step failures and continue. No migration journal table. |
| 3 | **Parallel-step fallback can run multiple steps in same worktree concurrently** | **Changed scope** | `step-session-executor.ts:776-795` (`executeParallelWave`) still degrades to sequential on primary worktree when worktree creation fails. However, the fallback is now **sequential** (not parallel), reducing the risk. Original concern was concurrent execution of fallback steps. |

### 2.2 Priority 2: High-Risk Operational Issues (from FN-1161)

| # | Finding | Status | Evidence |
|---|---------|--------|----------|
| 4 | **Child-process runtime kill/restart lifecycle has timer races** | **Partially addressed** | `child-process-runtime.ts:347-361` (`killChild`) now clears `sigkillTimer` immediately. `handleUnhealthy` at line 492+ uses generation tracking (`this.generation`) to prevent delayed callbacks from acting on wrong child. However, `this.child` is still nulled immediately after scheduling SIGKILL, which could cause race if SIGKILL fires before null assignment completes. |
| 5 | **Global limit refresh timer leak** | **Still open** | `project-manager.ts:95-123` still has `setInterval` that is never cleared. `globalSemaphore` is recreated on each refresh but not wired into project admission control. The semaphore is instantiated but never used for actual limiting. |
| 6 | **Multi-project scoping bypass in dashboard mutation routes** | **Partially addressed** | `routes.ts:1422+` (`getScopedStore`) is used in most routes. However, some routes (GitHub import, planning, subtask create) may still use unscoped handlers. Need comprehensive audit of route handlers. |
| 7 | **Realtime channels not uniformly project-scoped** | **Resolved** | All realtime channels are now project-scoped: `/api/tasks/:id/logs/stream` uses `getScopedTaskStore()` for scoped listener attachment; badge WebSocket uses project+task channel keys (`badge:{scopeKey}:{taskId}`) with cross-instance pub/sub carrying `projectId` metadata; terminal WebSocket validates session scope against resolved project. See `server.ts`, `websocket.ts`, `badge-pubsub.ts`, `terminal-service.ts`. |
| 8 | **CLI extension mutates global console for output capture** | **Still open** | `extension.ts:681-696`, `extension.ts:1015-1034` still monkey-patch `console.log/error`. No structured result return pattern implemented. |
| 9 | **Dashboard command lifecycle leaks signal listeners** | **Still open** | `dashboard.ts:30` still registers `process.on("SIGINT")` without paired teardown. No listener registrar utility. `MaxListenersExceededWarning` still observable in test runs. |
| 10 | **AI automation timeout does not cancel underlying work** | **Still open** | `cron-runner.ts:371-439` (`executeAiPromptStep`) uses `Promise.race` with `setTimeout`. The timeout does not abort the running AI session. When timeout fires, the executor continues running until completion or next invocation cleanup. |

### 2.3 High-Severity Gap Analysis Findings (from FN-1205)

| # | Finding | Status | Evidence |
|---|---------|--------|----------|
| 11 | **Executor failure transitions can strand tasks in `in-progress`** | **Needs verification** | `executor.ts:1013,1062` have `catch {}` blocks for `git worktree remove`. No visible evidence in current code of tasks being stranded in `in-progress` with `status=failed`. May have been addressed; requires runtime testing to confirm. |
| 12 | **Async EventEmitter listeners lack top-level rejection guards** | **Partially addressed** | `executor.ts` registers async `task:updated` handler without local try/catch. The outer callback has a try/catch at line ~240. However, inner async operations within the handler may still produce unhandled rejections. |
| 13 | **Dashboard lacks React error boundaries** | **Still open** | No `ErrorBoundary` or `react-error-boundary` usage found in `packages/dashboard/app` source. |
| 14 | **Routes error responses/logging inconsistent** | **Still open** | `routes.ts` has ~210 route handlers with varying error handling patterns. Some return `{ error: err.message }`, others return generic fallback text. No standardized error taxonomy. |

### 2.4 Test Coverage Gaps (from FN-1204)

| # | Finding | Status | Evidence |
|---|---------|--------|----------|
| 15 | **`child-process-worker.ts` untested (0% coverage)** | **Still open** | No dedicated test file exists. Module handles IPC protocol and child process lifecycle. |
| 16 | **`mission-routes.ts` untested** | **Partially addressed** | Has `mission-e2e.test.ts` coverage, but line-level coverage is 53.43%. Direct unit tests still missing. |
| 17 | **`useAgents` hook untested** | **Still open** | No matching test file. Used for agent data-fetching with 10-second polling. |
| 18 | **`subtask-breakdown.ts` partially tested** | **Still open** | 51.08% line coverage. AI/session orchestration paths not fully exercised. |
| 19 | **Timer-heavy test suites not stabilized** | **Still open** | Stuck-task-detector tests, heartbeat tests, and dashboard timeout tests still use real delays. `mission-store.test.ts` has confirmed flaky test for timestamp collisions. |

---

## 3. Memory-Informed Checks

Based on `.fusion/memory/MEMORY.md` constraints and pitfalls:

| # | Constraint/Pitfall | Still a Concern? | Notes |
|---|-------------------|------------------|-------|
| M1 | **Checkout leasing semantics** | No | Properly implemented via `checkoutTask`/`releaseTask`. `HeartbeatMonitor.executeHeartbeat()` validates checkout correctly. |
| M2 | **Listener/timer cleanup fragility** | **Yes** | Signal listener leak in `dashboard.ts` (finding #9). Timer leaks in `project-manager.ts` (finding #5). |
| M3 | **SQLite `ORDER BY timestamp DESC` nondeterminism** | **Yes** | No stable tiebreaker (`rowid DESC`) in recent activity queries. Could cause inconsistent ordering. |
| M4 | **Dashboard 429 retry test requires 30s timeout** | **Yes** | `routes.test.ts:3992-4016` still uses explicit 30s timeout. |
| M5 | **Mission store timestamp collision flakiness** | **Yes** | `mission-store.test.ts` has confirmed flaky test when timestamps collide in same millisecond. |
| M6 | **`vi.fn<>` generic syntax fails tsc build** | **No** | Memory correctly documents the cast pattern. No evidence of regressions. |
| M7 | **`--surface-hover` CSS property undefined** | **Yes** | Property used but never defined in theme roots. Components using it get no background. |

---

## 4. Cross-Package Hotspot Analysis

### 4.1 TaskStore Persistence Flow (`store.ts`)

**Current state:**
- `atomicWriteTaskJson()` (line ~488) writes to SQLite via `upsertTask()`, then writes `task.json` for backward compatibility
- Task locks (`withTaskLock`) serialize writes per task
- Config locks (`withConfigLock`) serialize ID allocation
- Watcher polling (1-second interval) detects external changes

**Hotspot risk:**
- Dual-write without atomic guarantee means divergence possible on crash between steps
- Polling-based change detection is latency-bound (1 second)
- No consistency verification mechanism

### 4.2 Executor Reliability Paths (`executor.ts`)

**Current state:**
- TaskExecutor registers listeners for `task:moved`, `task:updated`, `settings:updated`
- Single-session path uses `try/catch` with recovery logic
- Step-session path (`StepSessionExecutor`) handles per-step isolation
- Global pause terminates all active sessions

**Hotspot risk:**
- Async `task:updated` handler has outer try/catch but inner operations may still leak
- Session hot-swap for executor model changes implemented but edge cases untested
- Steering comment injection path tested but production stress untested

### 4.3 Dashboard Route Scoping (`routes.ts`)

**Current state:**
- `getScopedStore()` function (line ~1422) provides project-scoped stores
- Most routes use scoped stores correctly
- 210+ route handlers, mixed error handling quality

**Hotspot risk:**
- Import routes, planning routes, and subtask routes may bypass scoping
- Badge WebSocket not project-scoped
- Error response format varies across handlers

### 4.4 Extension Tool Behavior (`extension.ts`)

**Current state:**
- 28 tool registrations for task operations
- `storeCache` per cwd to avoid re-initialization
- Console monkey-patching for output capture

**Hotspot risk:**
- Global console mutation can interleave logs between concurrent executions
- Cache never closed on shutdown (minor for short-lived sessions)
- Tool output structure not structured (relies on text formatting)

---

## 5. Prioritized Improvement Recommendations

### P0 — Critical (Address Immediately)

| # | Recommendation | Impact | Effort | Packages | Why It Matters Now |
|---|---------------|--------|--------|----------|-------------------|
| P0-1 | **Add global semaphore wiring or remove dead code** | Fixes misleading concurrency control | S | engine | `globalSemaphore` is instantiated but never used. This creates confusion and may cause operators to assume global limiting is active when it isn't. |
| P0-2 | **Fix signal listener leak in dashboard command** | Prevents `MaxListenersExceededWarning` accumulation | S | cli | Listener leak observed in `pnpm test` runs. Affects long-lived processes and test stability. |
| P0-3 | **Add React error boundaries to dashboard** | Prevents full app crash on render exceptions | M | dashboard | No crash containment for UI exceptions. A single component error can take down the entire dashboard view. |

### P1 — High (Address in Next Sprint)

| # | Recommendation | Impact | Effort | Packages | Why It Matters Now |
|---|---------------|--------|--------|----------|-------------------|
| P1-1 | **Address AI automation timeout cancellation** | Prevents resource waste from timed-out runs | M | engine | Timed-out automation steps continue consuming AI resources until natural completion. |
| P1-2 | **Add dedicated tests for `child-process-worker.ts`** | Covers critical IPC/runner isolation path | M | engine | 0% coverage. Child process lifecycle is a critical isolation boundary. |
| P1-3 | **Formalize route error taxonomy** | Improves API debuggability and frontend error handling | M | dashboard | Inconsistent error formats make client-side error handling brittle. |
| P1-4 | **Add `rowid DESC` tiebreaker to `ORDER BY timestamp DESC`** | Prevents non-deterministic ordering | S | core | Can cause inconsistent "latest" activity display. |
| P1-5 | **Scope badge WebSocket subscriptions by project** | Prevents cross-project stale updates | M | dashboard, core | Multi-project correctness risk when nodes subscribe to badge updates. |

### P2 — Medium (Address When Capacity Allows)

| # | Recommendation | Impact | Effort | Packages | Why It Matters Now |
|---|---------------|--------|--------|----------|-------------------|
| P2-1 | **Stabilize timer-heavy test suites** | Reduces flaky test failures | M | engine, dashboard | Explicit 30s timeouts and timestamp collision flakiness reduce CI reliability. |
| P2-2 | **Add tests for `useAgents` hook** | Covers agent polling integration | M | dashboard | High-value hook in agent workflow with no unit tests. |
| P2-3 | **Define `--surface-hover` CSS property in themes** | Fixes missing hover backgrounds | S | dashboard | Components using `var(--surface-hover)` render with no background. |
| P2-4 | **Refactor CLI extension to return structured results** | Eliminates console mutation, improves reliability | M | cli | Concurrent tool execution safe output capture. |
| P2-5 | **Add consistency check CLI command** | Detects SQLite↔filesystem drift | M | core | Helps operators identify and resolve task state divergence. |

---

## 6. Changed Scope Items

The following findings from prior audits have changed in scope or priority:

| # | Original Finding | Change Description |
|---|-----------------|-------------------|
| 3 | **Parallel-step fallback concurrent execution** | Now **sequential** fallback (lower risk). Original concern was concurrent execution; sequential fallback still risky but less so. |
| 4 | **Child-process timer races** | Generation tracking added. Risk reduced but not eliminated. |
| 12 | **Async EventEmitter guards** | Outer try/catch added. Risk reduced but inner async ops may still leak. |
| 16 | **Mission routes untested** | E2E tests exist; unit-level gaps remain. Scope changed from "fully untested" to "partially tested with gaps". |

---

## 7. Suggested Follow-up Tasks

The following concrete task candidates are documented without automatic creation:

| # | Title | Scope | Likely Dependencies |
|---|-------|-------|---------------------|
| F1 | **Wire global semaphore into project admission control** | `project-manager.ts` — use `globalSemaphore` in `addProject()` before launching runtime | None |
| F2 | **Add listener registrar utility for signal lifecycle** | `cli/src/commands/dashboard.ts` — create utility, refactor `process.on` calls, add cleanup | None |
| F3 | **Add React error boundaries to dashboard routes** | `dashboard/app/App.tsx` and key modal components | None |
| F4 | **Add AbortSignal to AI prompt executor** | `cron-runner.ts` — wire abort signal into `aiPromptExecutor` call | F1 (related to executor pattern) |
| F5 | **Test child-process-worker IPC lifecycle** | `packages/engine/src/runtimes/child-process-worker.ts` — add integration tests for command/event handling | None |
| F6 | **Formalize API error taxonomy in routes** | `routes.ts` — define `ApiError` subtypes, apply consistently | None |
| F7 | **Add stable tiebreaker to timestamp queries** | `core/src/central-core.ts`, `core/src/store.ts` — add `rowid DESC` to ORDER BY | None |
| F8 | **Scope badge WebSocket to projectId** | `dashboard/src/server.ts`, `dashboard/app/hooks/useBadgeWebSocket.ts` — pass projectId in subscribe protocol | None |

---

## 8. Summary

**Still-open critical items:** 9  
**Changed-scope items:** 4  
**New concerns from memory:** 3 (timer leaks, CSS undefined, timestamp nondeterminism)  
**Recommended P0 actions:** 3  
**Recommended P1 actions:** 5  
**Recommended P2 actions:** 5

The most urgent work is addressing the dead semaphore code (P0-1), signal listener leaks (P0-2), and missing React error boundaries (P0-3), as these represent either misleading architecture or crash risk. The P1 items represent accumulated technical debt that increases operational complexity and debugging difficulty over time.

---

*Generated by FN-1398 — Codebase Improvement Audit*
