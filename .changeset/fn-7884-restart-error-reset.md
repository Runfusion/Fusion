---
"@runfusion/fusion": patch
---

summary: Durable agents in error state are cleared and retried automatically on engine restart.
category: fix
dev: New SelfHealingManager.resetDurableAgentErrorStateOnStartup() runs first in runStartupRecovery(): it resets the shared heartbeatErrorRecovery/durableErrorRecovery budget+cooldown, clears lastError, flips eligible error and error-retry-exhausted-parked durable agents to active, re-arms the heartbeat, and emits agent:reset-error-state-on-startup — bypassing the steady-state staleness/cooldown/exhaustion gates while preserving operator-actionable / stale-module / user-paused / error-unrecoverable suppression (FN-7884).
