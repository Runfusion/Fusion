# Fusion System Improvements

Generated: 2026-04-08
Task: FN-1161

## Summary

Fusion is functionally rich, but fragility is concentrated in a small number of orchestration-heavy files where persistence, process control, API translation, and recovery logic are tightly coupled. The highest-risk paths are where state is written to multiple backends without a single atomic boundary, and where recovery logic is best-effort rather than explicit/stateful.

The most urgent issues are in task persistence (`TaskStore` dual-write), migration safety (`db.ts` + `db-migrate.ts` partial-apply semantics), and parallel step execution (`StepSessionExecutor` fallback behavior). These can produce split-brain state, hard-to-reconcile migration outcomes, or concurrent git writes to the same worktree.

Operationally, multi-project correctness and runtime lifecycle cleanup are the next tier of risk: several dashboard routes bypass scoped stores, child runtime restart/kill timers are not fully coordinated, and process/timer listeners can leak across repeated startups (observed during `pnpm test` as `MaxListenersExceededWarning`).

## Priority 1: Critical — Risk of Data Loss or Corruption

### 1) Non-atomic dual persistence for task state
- **File(s):** `packages/core/src/store.ts:459-485` (`readTaskJson`), `packages/core/src/store.ts:488-500` (`atomicWriteTaskJson`), `packages/core/src/store.ts:1054-1139` (`moveTask`)
- **Issue:** Task state is written to SQLite (`upsertTask`) and then mirrored to `task.json`. If the filesystem write/rename fails after DB write, the two sources diverge.
- **Impact:** Recovery/fallback paths can read stale `task.json`, causing inconsistent task columns/status/steps and hard-to-debug behavior after partial failures.
- **Suggestion:** Introduce explicit single-source mode for runtime operations (SQLite-only reads/writes), and move JSON mirror writes to an async reconciliation queue with health markers. Add a consistency check endpoint/CLI command that reports DB↔file drift.
- **Estimated effort:** M

### 2) Migration steps can partially apply without rollback journal
- **File(s):** `packages/core/src/db.ts:375-537` (`migrate`, `applyMigration`), `packages/core/src/db-migrate.ts:69-121` (`migrateFromLegacy`)
- **Issue:** `applyMigration()` explicitly avoids transaction wrapping for ALTER paths, and legacy migration catches per-step failures and continues.
- **Impact:** A project can end in a mixed schema/data state with no checkpoint table describing which pieces are authoritative.
- **Suggestion:** Add migration journal tables (`schema_migrations`, `legacy_migration_runs`, per-entity status), require explicit success/failure summary persistence, and add resumable migration commands (`--resume`, `--verify`) before backup cleanup.
- **Estimated effort:** L

### 3) Parallel-step fallback can run multiple steps in the same worktree concurrently
- **File(s):** `packages/engine/src/step-session-executor.ts:776-795` (`executeParallelWave`)
- **Issue:** When per-step worktree creation fails, code currently falls back to `this.options.worktreePath` and still executes the wave concurrently.
- **Impact:** Concurrent step sessions may write to the same git worktree, risking index conflicts, bad cherry-picks, or invalid step outcomes.
- **Suggestion:** On any worktree creation failure, degrade the entire wave to sequential mode (or hard-fail the wave) instead of sharing primary worktree paths concurrently.
- **Estimated effort:** S

## Priority 2: High — Risk of Operational Failure

### 4) Child-process runtime kill/restart lifecycle has timer races
- **File(s):** `packages/engine/src/runtimes/child-process-runtime.ts:347-361` (`killChild`), `packages/engine/src/runtimes/child-process-runtime.ts:436-459` (`handleUnhealthy`)
- **Issue:** Force-kill and restart timers are fire-and-forget and not tracked/cancelled; `this.child` is nulled immediately after scheduling SIGKILL.
- **Impact:** Delayed timer callbacks can target a new child process or run after shutdown transitions, producing restart flapping or accidental kill of replacement workers.
- **Suggestion:** Introduce explicit runtime lifecycle state machine + tracked timer handles. Keep per-child generation IDs so delayed callbacks only act on the intended child.
- **Estimated effort:** M

### 5) Global limit refresh timer leak and dead semaphore path
- **File(s):** `packages/engine/src/project-manager.ts:95-123` (constructor, `refreshGlobalLimit`), `packages/engine/src/project-manager.ts:459-470` (`stopAll`)
- **Issue:** `setInterval` for limit refresh is never cleared; `globalSemaphore` is recreated but never used for admission control.
- **Impact:** Long-lived processes can accumulate timers; intended global coordination is partially implemented and misleading.
- **Suggestion:** Either wire `globalSemaphore` into project run admission or remove it. Store interval handle and clear it in `stopAll()`.
- **Estimated effort:** S

### 6) Multi-project scoping bypass in dashboard mutation routes
- **File(s):** `packages/dashboard/src/routes.ts:1305-1311` (`getScopedStore`), plus unscoped handlers at `3525-3949` (`/github/issues/import`, `/github/issues/batch-import`, `/github/pulls/import`) and `5312-5828` (subtasks/planning create flows)
- **Issue:** Many routes correctly call `getScopedStore(req)`, but several import/planning/subtask endpoints still use root `store` directly.
- **Impact:** Requests with `projectId` can mutate the wrong project store and emit events on unexpected channels.
- **Suggestion:** Add a required `resolveStore(req)` middleware and ban direct outer `store` usage in route handlers via ESLint rule or route wrapper.
- **Estimated effort:** M

### 7) Realtime channels are not uniformly project-scoped
- **File(s):** `packages/dashboard/src/server.ts:134-145` (`/api/events`), `packages/dashboard/src/server.ts:544-644` (`setupBadgeWebSocket`), `packages/dashboard/app/hooks/useTasks.ts:34-108`, `packages/dashboard/app/hooks/useBadgeWebSocket.ts:104`, `packages/dashboard/app/hooks/useAgents.ts:39-50`
- **Issue:** SSE has scoped store support, but badge WS subscriptions are tied to the root store; client hooks also note unfiltered SSE behavior and open independent EventSources.
- **Impact:** Stale/cross-project updates, duplicate sockets, and reconciliation complexity under multi-project usage.
- **Suggestion:** Add `projectId` to badge WS subscribe protocol, normalize all event payloads with explicit project attribution, and centralize one shared app-level SSE/WS transport.
- **Estimated effort:** M

### 8) CLI extension mutates global console for tool output capture
- **File(s):** `packages/cli/src/extension.ts:681-696` (`kb_task_import_github`), `packages/cli/src/extension.ts:1015-1034` (`kb_task_plan`)
- **Issue:** Tools monkey-patch `console.log/error` globally to capture output.
- **Impact:** Concurrent tool executions can interleave logs, lose output, or restore wrong handlers.
- **Suggestion:** Refactor command APIs to return structured results (`{ summary, createdTasks, logs }`) and stop global console mutation.
- **Estimated effort:** S

### 9) Dashboard command lifecycle leaks signal listeners across repeated startups
- **File(s):** `packages/cli/src/commands/dashboard.ts:791-803` (`process.on` handlers)
- **Issue:** SIGINT/SIGTERM listeners are added on each run without paired teardown in test/runtime reuse scenarios.
- **Impact:** Observed in `pnpm test` as repeated `MaxListenersExceededWarning`; indicates lifecycle cleanup fragility.
- **Suggestion:** Use a listener registrar utility and always remove listeners in shutdown paths (or `once` + scoped cleanup).
- **Estimated effort:** S

### 10) AI automation timeout does not cancel underlying work
- **File(s):** `packages/engine/src/cron-runner.ts:371-439` (`executeAiPromptStep`)
- **Issue:** Timeout uses `Promise.race` with `setTimeout` but does not abort the running AI session/executor.
- **Impact:** Timed-out automation steps can keep consuming resources and finish out-of-band.
- **Suggestion:** Add AbortSignal plumbing to `AiPromptExecutor`, cancel timed-out runs explicitly, and clear timeout handles deterministically.
- **Estimated effort:** M

## Priority 3: Medium — Maintainability & Technical Debt

### 11) Oversized orchestration files with mixed responsibilities
- **File(s):** `packages/dashboard/src/routes.ts` (10,037 LOC), `packages/core/src/store.ts` (3,278 LOC), `packages/engine/src/executor.ts` (3,114 LOC), `packages/cli/src/extension.ts` (1,747 LOC)
- **Issue:** API wiring, domain logic, persistence, git operations, and recovery are combined in single files.
- **Impact:** Higher regression risk and slower change velocity; difficult targeted testing.
- **Suggestion:** Extract service boundaries with compatibility facades (e.g., `TaskPersistence`, `TaskTransitions`, `GitOps`, `PlanningRoutes`, `GitRoutes`, `ToolRegistry`).
- **Estimated effort:** L

### 12) CLI dispatch is a giant manual switch tree
- **File(s):** `packages/cli/src/bin.ts:267-900` (`main` command dispatch)
- **Issue:** 70+ case branches with repeated usage checks and `process.exit` branches.
- **Impact:** Easy to introduce inconsistent UX/error behavior; hard to verify command coverage.
- **Suggestion:** Move to declarative command table with argument schemas + shared runner/error mapping.
- **Estimated effort:** M

### 13) Error handling policy is inconsistent and frequently best-effort
- **File(s):** `packages/dashboard/src/routes.ts` (289 `catch` occurrences), `packages/engine/src/executor.ts` (73), `packages/engine/src/merger.ts` (36), `packages/core/src/db-migrate.ts:69-121`
- **Issue:** Frequent silent catches and warning-only branches without structured error classes.
- **Impact:** Operational failures are harder to classify/retry/alert; behavior differs by module.
- **Suggestion:** Introduce shared error taxonomy (`UserInput`, `RetryableInfra`, `InvariantViolation`) and mandatory structured logging fields (`area`, `operation`, `retryable`, `cleanupAttempted`).
- **Estimated effort:** M

### 14) Event payload typing is weak at SSE boundaries
- **File(s):** `packages/dashboard/src/sse.ts:47-109`
- **Issue:** SSE handlers are predominantly `any`-typed payloads.
- **Impact:** Runtime-only breakage for payload shape drift; weaker refactor safety.
- **Suggestion:** Define shared event contracts in `@fusion/core` and type SSE/WS emitters and client handlers against those contracts.
- **Estimated effort:** S

## Priority 4: Low — Nice-to-Have Improvements

### 15) Add disposal for cached TaskStore instances in extension
- **File(s):** `packages/cli/src/extension.ts:34-42` (`storeCache`/`getStore`), `packages/cli/src/extension.ts:1737-1746` (`session_shutdown`)
- **Issue:** Session shutdown clears cache keys but does not `close()` each cached `TaskStore` DB handle.
- **Impact:** Usually minor for short-lived sessions, but can keep descriptors open longer than needed.
- **Suggestion:** Iterate cached stores on shutdown and call `store.close()` before clearing the map.
- **Estimated effort:** S

### 16) Formalize route-level validation schemas
- **File(s):** `packages/dashboard/src/routes.ts` (many manual `if (!field || typeof field !== ...)` blocks)
- **Issue:** Validation logic is repetitive and hand-rolled per endpoint.
- **Impact:** Subtle behavior drift across similar routes and harder API contract evolution.
- **Suggestion:** Adopt shared schema validation middleware (e.g., Zod/TypeBox) and generate request/response typings from one source.
- **Estimated effort:** M

## Cross-Cutting Themes

1. **Split-brain state risk from hybrid persistence:** runtime writes often touch SQLite + filesystem mirrors without a single transactional boundary.
2. **Best-effort recovery over explicit state machines:** many critical cleanup/retry paths rely on ad-hoc catches/timers instead of explicit lifecycle ownership.
3. **Project-context propagation is incomplete:** most routes are scoped correctly, but exceptions create high-severity multi-project correctness risk.
4. **Operational side effects are under-tested:** signal handlers, timers, and child-process restart behavior are not comprehensively asserted.
5. **Complexity concentration in a few mega-files:** defects and regressions cluster in the same hotspots (`routes.ts`, `store.ts`, `executor.ts`).

## Test Coverage Gaps

- **No direct tests for `useAgents` hook:** `packages/dashboard/app/hooks/useAgents.ts` has no matching test file.
- **Missing project-scoping assertions for import/planning routes:** route tests exist (`packages/dashboard/src/routes.test.ts` around lines `3603+`, `5679+`) but do not exercise `projectId` behavior for `/github/issues/import`, `/github/issues/batch-import`, `/github/pulls/import`, `/planning/*`, `/subtasks/*`.
- **Child runtime lifecycle edge cases are lightly tested:** `packages/engine/src/runtimes/child-process-runtime.test.ts` currently validates basic status/getter behavior, but not restart timer race conditions (`killChild` + `handleUnhealthy`).
- **Parallel-step failure path lacks coverage:** `packages/engine/src/step-session-executor.test.ts` focuses on parsing/planning utilities; it does not test worktree-creation-failure behavior inside `executeParallelWave`.
- **Process listener cleanup is not asserted:** CLI dashboard tests surfaced `MaxListenersExceededWarning`, but tests do not currently fail on listener leaks.

## Appendix: Key Metrics

- **Largest source files reviewed:**
  - `packages/dashboard/src/routes.ts` — **10,037** lines
  - `packages/core/src/store.ts` — **3,278** lines
  - `packages/engine/src/executor.ts` — **3,114** lines
  - `packages/cli/src/extension.ts` — **1,747** lines
- **Complexity signals:**
  - Route handlers in `routes.ts`: **210**
  - Tool registrations in `extension.ts`: **28**
  - `execSync` usage in `routes.ts`: **69**
  - `catch` occurrences in `routes.ts`: **289**
- **Large tests (complexity proxy):**
  - `packages/engine/src/executor.test.ts` — 8,659 lines
  - `packages/dashboard/src/routes.test.ts` — 8,277 lines
  - `packages/core/src/store.test.ts` — 5,991 lines
- **Full test run result:** `pnpm test` passed; however, repeated `MaxListenersExceededWarning` occurred during CLI dashboard tests, indicating listener lifecycle debt.