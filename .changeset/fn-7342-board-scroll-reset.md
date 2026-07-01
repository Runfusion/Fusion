---
"@runfusion/fusion": patch
---

summary: Preserve board column scroll during dashboard refresh and viewport stabilization.
category: fix
dev: Narrows mobile board stabilization so task/workflow refresh and resize events pin document drift without resetting #board.scrollLeft.
