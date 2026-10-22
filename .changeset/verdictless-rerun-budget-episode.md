---
"@runfusion/fusion": patch
---

summary: Retry now re-arms a review gate that had stopped after repeated verdict-less crashes.
category: fix
dev: The per-gate verdict-less re-run budget (3 attempts) is scoped to one review episode. A Retry that discharges the gate appends a durable `[verdictless-gate-episode] gate '<id>'` marker and the count restarts from it; automatic lanes never write that marker, so an unattended crash loop is still stopped after three real runs.
