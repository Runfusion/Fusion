---
"@runfusion/fusion": patch
---

summary: Wait for task store secret database handles to close before cleanup.
category: fix
dev: Awaits the async secrets store close path during TaskStore shutdown to avoid teardown races.
