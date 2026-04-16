# Engine Package Review: Findings Report

**Reviewed:** `packages/engine/src` (~87K lines, 114 files)  
**Date:** 2026-04-16  
**Task:** FN-1962

## Summary

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 3 |
| Medium | 3 |
| Low | 2 |

### Findings by subsystem

| Area | Findings |
|------|----------|
| TaskExecutor (`executor.ts`) | 1 medium |
| Heartbeat system (`agent-heartbeat.ts`) | 1 medium, 1 low |
| Concurrency (`concurrency.ts`) | 1 medium, 1 low |
| Merge process (`merger.ts`) | 0 |
| Scheduler (`scheduler.ts`) | 1 high, 1 low |
| Step-session / workflow / plugin runner | 0 |
| Remaining subsystems | 2 high |
| Cross-cutting | summarized from above |

---

## 1. TaskExecutor (`executor.ts`)

### Medium

#### M-1 — Executor registers long-lived store listeners but exposes no teardown path
- **File:line:** `packages/engine/src/executor.ts:422-450`, `:462-603`, `:606-623`
- **Description:** `TaskExecutor` attaches three `TaskStore` listeners in the constructor (`task:moved`, `task:updated`, `settings:updated`) but does not expose `stop()`/`dispose()` to unsubscribe them.
- **Impact:** If runtimes are restarted against a shared/external `TaskStore`, stale executor instances can remain listener-reachable and duplicate event handling (double execute triggers, duplicate pause handling, extra steering injections).
- **Suggested fix:** Add explicit teardown (`dispose`) that removes registered listeners; invoke it from runtime shutdown before replacing/recreating an executor.

### Low
- No additional high-confidence correctness defects found in the reviewed execution/recovery/workflow code paths.

---

## 2. Heartbeat System (`agent-heartbeat.ts`)

### Medium

#### M-2 — `agentStartLocks` entries are never removed
- **File:line:** `packages/engine/src/agent-heartbeat.ts:281-286`
- **Description:** `withAgentStartLock()` stores a promise per agent ID in `agentStartLocks`, but never deletes the key after completion.
- **Impact:** Unbounded map growth over time for agents that run at least once; stale promise references retained for process lifetime.
- **Suggested fix:** Wrap lock execution in `try/finally` and delete map entry when the stored promise resolves/rejects and is still current for that agent.

### Low

#### L-1 — Timer registration can occur while scheduler is stopped; `stop()` early return may skip cleanup
- **File:line:** `packages/engine/src/agent-heartbeat.ts:1422-1446`, `:1393-1406`
- **Description:** `registerAgent()` always creates a timer regardless of `running` state. `stop()` returns early when `!running`, so pre-start registered timers can survive an attempted stop.
- **Impact:** Unexpected idle intervals and avoidable timer leakage in non-standard lifecycle ordering.
- **Suggested fix:** Either gate timer creation on `running`, or make `stop()` always clear `timers` regardless of `running` flag.

---

## 3. Concurrency (`concurrency.ts`)

### Medium

#### M-3 — Semaphore `release()` can underflow active count
- **File:line:** `packages/engine/src/concurrency.ts:112-114`
- **Description:** `release()` unconditionally decrements `_active`; a double-release can make `_active` negative.
- **Impact:** Corrupt semaphore state and potential over-admission (more than configured concurrency).
- **Suggested fix:** Guard against underflow (`if (this._active <= 0) return` or throw), and optionally track token ownership for safer release semantics.

### Low

#### L-2 — Missing regression tests for release underflow / double-release
- **File:line:** `packages/engine/src/concurrency.test.ts:4-275`
- **Description:** Existing tests validate priority/FIFO and dynamic limit changes, but no test covers duplicate `release()` behavior.
- **Impact:** Underflow regression can reappear undetected.
- **Suggested fix:** Add explicit tests asserting `activeCount` never drops below zero and that extra releases are rejected or ignored.

---

## 4. Merge Process (`merger.ts`)

### Critical
- None.

### High
- None.

### Medium
- None.

### Low
- No high-confidence defects identified in reviewed merge retry/context-recovery/worktree-cleanup paths.
- `execSync` usage appears confined to short git plumbing; user-configured commands run through async `execAsync`.

---

## 5. Scheduler (`scheduler.ts`)

### High

#### H-1 — Event listeners added in constructor are not removed in `stop()`
- **File:line:** `packages/engine/src/scheduler.ts:132-135`, `:146-150`, `:158-162`, `:171-225`, `:231-269`; stop path `:329-346`
- **Description:** Scheduler registers five `store.on(...)` listeners but `stop()` only clears interval/aux state; it never unsubscribes listeners.
- **Impact:** Stale scheduler instances can continue reacting to store events after stop, causing duplicate side effects and memory retention across runtime restarts.
- **Suggested fix:** Store listener function refs as class fields and unregister all of them in `stop()`.

### Low

#### L-3 — Test coverage gap for listener teardown behavior
- **File:line:** `packages/engine/src/scheduler.test.ts:139-339` and stop invocations around `:499`, `:1662`, `:1764`, `:1774`
- **Description:** Tests verify listener registration and scheduling behavior but do not assert listener unsubscription on `stop()`.
- **Impact:** Lifecycle leaks are not protected by regression tests.
- **Suggested fix:** Add tests asserting `store.off`/`removeListener` calls for each subscribed event during shutdown.

---

## 6. Step-Session Executor, Workflow Steps, Plugin Runner

### Critical
- None.

### High
- None.

### Medium
- None.

### Low
- No high-confidence defects found in reviewed session lifecycle, plugin hook timeout isolation, or cache invalidation paths.

---

## 7. Remaining Subsystems

### High

#### H-2 — InProcessRuntime forwards TaskStore events without unsubscribe on stop
- **File:line:** `packages/engine/src/runtimes/in-process-runtime.ts:869-889`; stop path `:578-693`
- **Description:** `setupEventForwarding()` attaches `task:created`, `task:moved`, `task:updated` listeners to `TaskStore`; `stop()` does not remove them.
- **Impact:** Runtime restart or shared-store scenarios can leave stale forwarding handlers active, duplicating emitted runtime events and retaining stopped runtime objects.
- **Suggested fix:** Keep bound handler refs and unregister in `stop()`.

#### H-3 — HybridExecutor forwards ProjectManager events without cleanup on shutdown
- **File:line:** `packages/engine/src/hybrid-executor.ts:394-427`; shutdown path `:359-382`
- **Description:** `setupEventForwarding()` registers seven `projectManager.on(...)` listeners. `shutdown()` removes CentralCore listeners but not these forwarding listeners.
- **Impact:** Reinitialization can accumulate duplicated forwarding and retained references.
- **Suggested fix:** Track forwarded handlers and call `projectManager.off(...)` (or equivalent) during shutdown.

### Medium
- None.

### Low
- No additional high-confidence defects identified in reviewed cron/pi/reviewer/triage/self-healing/mission/runtime-IPC paths beyond cleanup findings above.

---

## 8. Cross-Cutting Concerns

### Resource Cleanup
- Multiple lifecycle components register listeners without symmetric teardown (`Scheduler`, `InProcessRuntime`, `HybridExecutor`, and `TaskExecutor` constructor listeners).

### Error Handling
- Generally robust try/catch usage and callback isolation patterns observed; no critical uncaught-flow defects identified in reviewed paths.

### Race Conditions
- Semaphore underflow (`concurrency.ts`) can destabilize concurrency accounting under release misuse.

### `execSync` Usage
- No policy violations found in sampled engine hotspots: `execSync` usage appears limited to git plumbing; user-configured operations use async execution.

### Memory Leaks
- Unbounded `agentStartLocks` map in heartbeat monitor.
- Event-listener retention in scheduler/runtime orchestration layers.

### Event Listener Cleanup
- Missing unsubscribe patterns are the dominant architectural issue class in this review.

### Type Safety
- No critical type-safety defects (unsafe cast crashes/null deref) identified in reviewed files.

---

## Recommendations (Prioritized)

1. **Immediate (high):** Implement consistent listener lifecycle management (`on`/`off`) in Scheduler, InProcessRuntime, HybridExecutor, and TaskExecutor.
2. **Near-term (medium):** Harden `AgentSemaphore.release()` against underflow and add regression tests.
3. **Near-term (medium):** Add lock-map cleanup in `HeartbeatMonitor.withAgentStartLock()`.
4. **Quality gates:** Add lifecycle teardown tests for scheduler/runtime listener cleanup to prevent regressions.
