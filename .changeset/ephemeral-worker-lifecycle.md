---
"@runfusion/fusion": patch
---

Fix two related agent-lifecycle leaks and extract the coordinator into a reusable class.

**Stuck-in-running bug.** `executeHeartbeat`'s governance-skip paths (budget exhausted, budget threshold, global pause, engine paused) called `startRun` first — flipping the agent to `running` — then short-circuited with `skipStateTransition: true`, leaving the agent permanently stuck at `running` with no active run. Removed the `skipStateTransition` flag from those four paths so they flow through the normal `running → active` transition. Added `HeartbeatMonitor.reconcileOrphanedRunningAgents()` on startup to recover any agents already trapped in this state from older versions.

**Ephemeral task-worker pile-up.** Runtime-spawned `executor-FN-XXXX` workers leaked across runtime restarts because the in-memory `taskAgentMap` reset every process and there was no on-disk fallback. A task started in one session and completed in another would orphan its worker; over time hundreds piled up. The startup sweep also only deleted ephemerals in halt states, ignoring the no-`taskId` case that accounted for nearly every zombie. Now: spawn dedup via `findAgentByName` lookup before create, on-disk fallback in completion/error paths, and the startup sweep deletes any ephemeral not bound to an in-progress task.

**`EphemeralWorkerManager` extraction.** The lifecycle logic is now a single class (`packages/engine/src/ephemeral-worker-manager.ts`) owning `taskAgentMap`, `pendingDeletions`, the halt-state listener, and the startup sweep. `InProcessRuntime` shrinks by ~140 lines and delegates via `workerManager.onTaskStart` / `.onTaskComplete` / `.onTaskError` / `.attachStateChangeListener` / `.reconcileOrphaned`. Future runtimes that drive `TaskExecutor` directly inherit the same lifecycle. Durable assigned agents now return to `active` after task completion (was `terminated` in the old contract).
