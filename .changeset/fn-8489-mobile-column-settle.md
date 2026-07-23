---
"@runfusion/fusion": patch
---

summary: Mobile board swipes always settle on a single centered column, never between columns.
category: fix
dev: Hardens useColumnScrollSnap settle to nearest/directional column center; keeps CSS proximity snap (no mandatory).
