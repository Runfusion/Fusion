---
"@runfusion/fusion": patch
---

summary: Prevent workflow task cards from showing later sequential steps active too early.
category: fix
dev: TaskStore now applies step dependency/order guards to in-progress updates as well as done updates.
