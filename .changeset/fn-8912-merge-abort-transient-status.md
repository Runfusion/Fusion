---
"@runfusion/fusion": patch
---

summary: Recover timed-out merges without leaving retries blocked by stale merge status.
category: fix
dev: Fences superseded merger status writes and reconciles abort, pump, and stale-sweep status recovery.
