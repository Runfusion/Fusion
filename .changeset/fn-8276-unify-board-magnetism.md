---
"@runfusion/fusion": patch
---

summary: Mobile Kanban swipes now settle on exactly one column with no stuck-between-columns state.
category: fix
dev: useColumnScrollSnap suspends native scroll-snap (inline scroll-snap-type:none) during a user pan and restores the x proximity baseline after its JS scroll-end snap, unifying the two magnetism systems from FN-8235; never uses x mandatory (FN-001).
