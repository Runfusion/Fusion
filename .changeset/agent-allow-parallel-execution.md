---
"@fusion/core": minor
"@fusion/engine": minor
"@runfusion/fusion": minor
"@fusion/dashboard": minor
---

Per-agent setting `allowParallelExecution` (default true, permanent agents only): when disabled, an agent's heartbeat runs and task executor sessions serialize — a heartbeat will not start while the agent's bound task has an active executor session, and an executor session will not start while the agent has an active heartbeat run.

Field added to `AgentHeartbeatConfig` in `@fusion/core`. UI toggle surfaces in the agent's Heartbeat Settings tab alongside `runMissedHeartbeatOnStartup`. Engine gating: `TaskExecutor.execute()` defers when the assigned agent has an active heartbeat run; `HeartbeatMonitor` defers a heartbeat when the agent's bound task has an active executor session. After either side completes, the deferred work is re-dispatched.
