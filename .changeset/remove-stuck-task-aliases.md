---
"@runfusion/fusion": patch
---

summary: Remove stale taskStuck package exports and build/test aliases after deleting the dashboard helper.
category: fix
dev: "Cleans dashboard and dependency-graph configuration so no published export, Vite/Vitest alias, or TypeScript path points at the removed app/utils/taskStuck module."
