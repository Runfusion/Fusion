---
"@runfusion/fusion": patch
---

summary: Stop held planning from re-running every few seconds when no planner agent is available.
category: fix
dev: Planning holds now use the executor's principal-hold cooldown (15s doubling to 5min) during planning discovery and log a hold once per distinct reason.
