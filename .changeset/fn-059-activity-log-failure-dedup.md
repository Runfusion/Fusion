---
"@runfusion/fusion": patch
---

summary: Prevent duplicate Task Failed entries after subsequent task updates.
category: fix
dev: Records failure activity only on a non-failed-to-failed task transition.
