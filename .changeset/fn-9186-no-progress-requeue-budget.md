---
"@runfusion/fusion": patch
---

summary: Bound self-healing retries for failed no-progress tasks.
category: fix
dev: Uses persisted retry budget and exponential backoff before terminal operator parking.
