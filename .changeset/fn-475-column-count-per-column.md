---
"@runfusion/fusion": patch
---

summary: Each board column header now shows its own task count instead of the board-wide total.
category: fix
dev: Board.tsx resolves the header badge per column via the new exported `resolveColumnBadgeTotal` helper and passes it as an explicit `totalTaskCount` prop; `currentTasksTotal` was removed from all three pagination spread branches in both the aggregate and selected-workflow views. A complete lane outside search keeps its exact `completedCounts` server total.
