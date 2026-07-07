---
"@runfusion/fusion": patch
---

summary: Fix agents on long heartbeat intervals silently going stale for hours.
category: fix
dev: HeartbeatTriggerScheduler timer audit now re-arms non-advancing long-interval registrations (stale lastHeartbeatAt with a live timer entry), not just missing ones (FN-7645).
