---
"@runfusion/fusion": patch
---

summary: Prevent repeat task-wedge alerts from flooding operator inboxes.
category: fix
dev: Adds a six-hour durable per-reason cooldown that survives resolve/re-wedge flaps.
