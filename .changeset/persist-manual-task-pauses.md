---
"@runfusion/fusion": patch
---

summary: Persist explicit user intent across manual task pauses so startup recovery cannot reclaim paused work.
category: fix
dev: CLI, dashboard, MCP tool, and mission pause controls now set the durable userPaused latch while automatic holds remain recoverable.
