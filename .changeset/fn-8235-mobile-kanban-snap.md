---
"@runfusion/fusion": patch
---

summary: Mobile Kanban board now magnetically snaps to a single column when you swipe between columns.
category: fix
dev: New app/hooks/useColumnScrollSnap.ts scroll-end snap wired to Board #board; keeps CSS scroll-snap-type: x proximity (no mandatory) to preserve the FN-001 corner-rendering fix.
