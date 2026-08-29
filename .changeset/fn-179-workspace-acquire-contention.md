---
"@runfusion/fusion": patch
---

summary: Make workspace acquisition waits recoverable and visible.
category: fix
dev: Durable acquire-lease authority, lifecycle release, and a defensive acquire-cache sweep prevent stale claims; two persisted contention-wait fields drive the Waiting badge, preparation avoids the task mutex, startup replays live tasks only, and executor retries planning-lock transport failures.
