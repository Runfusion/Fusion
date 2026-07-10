---
"@runfusion/fusion": patch
---

summary: Fix agents needing repeated stop/start because a stopped agent's heartbeat timer was never fully cleared.
category: fix
dev: HeartbeatTriggerScheduler.auditTimerRegistrations now unregisters lingering timers for non-eligible (stopped/paused/disabled) agents, and syncTimerForAgent force-re-arms a stale present timer on a start transition, so a stop/start durably clears the zombie-timer condition instead of deferring to the FN-7645 watchdog repair (FN-7718).
