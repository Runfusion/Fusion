---
"@runfusion/fusion": patch
---

summary: Prevent unavailable task owners from stalling execution and automatically recover nested workflow holds.
category: fix
dev: Check owner availability during admission and share node-instance resolution with periodic recovery.
