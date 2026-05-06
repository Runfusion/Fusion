---
"@runfusion/fusion": minor
---

Per-agent setting `runMissedHeartbeatOnStartup` (default off): when enabled, the engine fires a single catch-up heartbeat at server startup if the agent's `lastHeartbeatAt` is older than its configured interval — i.e. a scheduled tick was missed because the server was down.

The check runs in the same startup pass that arms heartbeat timers (`packages/cli/src/commands/dashboard.ts`), so agents whose state isn't `active`/`running` or who have heartbeats disabled never trigger. Catch-up runs use the existing `executeHeartbeat` path with `source="timer"` and `triggerDetail="startup-missed-heartbeat-catchup"` so per-agent serialization, budget enforcement, and missed/recovered tracking continue to apply. UI toggle lives in the agent's Heartbeat Settings tab.
