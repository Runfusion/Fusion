---
"@runfusion/fusion": patch
---

summary: Cards drawn by plugin views and the right dock now use the board's own lane names.
category: fix
dev: Both `renderTaskCard` producers built a `TaskCard` without `taskColumnFlags` despite having the per-task map in scope.
