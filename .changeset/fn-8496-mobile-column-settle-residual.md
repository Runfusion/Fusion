---
"@runfusion/fusion": patch
---

summary: Mobile board pan/fling always settles on one centered column, never between.
category: fix
dev: Closes residual useColumnScrollSnap settle race after FN-8489; keeps proximity snap and pin-until-next-touch.
