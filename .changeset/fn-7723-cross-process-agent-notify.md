---
"@runfusion/fusion": patch
---

summary: The engine now reacts to CLI `fn agent stop`/`start` promptly instead of waiting up to a minute for the audit sweep.
category: fix
dev: AgentStore gains opt-in cross-process change detection (fs.watch + poll fallback, modeled on TaskStore) that re-emits the existing agent:updated/agent:stateChanged events in the engine process when another process (the fn CLI) mutates an agent row, so HeartbeatTriggerScheduler's listeners fire without waiting for the 60s auditTimerRegistrations sweep. The audit sweep is retained as the durable backstop (FN-7723, follow-up from FN-7718).
