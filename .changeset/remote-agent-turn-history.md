---
"@runfusion/fusion": minor
---

summary: Show collected turn history for a remote agent session, with prompts, responses, work time and file patches.
category: feature
dev: New RemoteAgentTurns component reads the existing paginated GET /external-sessions/:id/turns. Null telemetry renders as unavailable rather than zero; stored patches are never replaced with a working-tree diff.
