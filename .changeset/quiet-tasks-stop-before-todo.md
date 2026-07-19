---
"@runfusion/fusion": patch
---

summary: Stop active task processing before a user move to Todo becomes visible.
category: fix
dev: User-driven in-progress-to-Todo transitions now await every executor cancellation surface before persistence.
