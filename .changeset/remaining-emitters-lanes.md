---
"@runfusion/fusion": patch
---

summary: Replan and respecify transitions now report the board's own lanes to engine listeners.
category: fix
dev: `updateTaskUnlockedImpl` and the respecify path in `update-task-deps.ts` attach `lanes` to their `task:moved` emits.
