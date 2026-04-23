---
"@runfusion/fusion": patch
---

Harden agent lifecycle around closed tasks and heartbeat defaults.

- `HeartbeatMonitor.executeHeartbeat()` now exits before session creation when the resolved task is done/archived (reason `task_closed`) and clears the stale `agent.taskId` linkage so the guard isn't re-tripped on every tick.
- `HeartbeatTriggerScheduler.watchAssignments()` skips callback dispatch when the assigned task is already closed (when a `taskStore` is wired in).
- `POST /api/agents/:id/runs` performs the same preflight check and returns 409 with a structured error naming the task id + column, keeping the existing active-run 409 precedence.
- `AgentStore.createAgent()` now persists `runtimeConfig.heartbeatIntervalMs` (default 1h) on non-ephemeral agents so the dashboard's freshness signal matches the scheduler's effective cadence instead of depending on whether the user ever opened the heartbeat dropdown. Exports a new `DEFAULT_AGENT_HEARTBEAT_INTERVAL_MS` constant.
