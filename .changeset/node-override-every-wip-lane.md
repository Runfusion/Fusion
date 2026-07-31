---
"@runfusion/fusion": patch
---

summary: A running task in a board's second WIP lane can no longer have its node override changed mid-flight.
category: fix
dev: `fn_task_update` resolved lanes with `resolveTaskLifecycleColumns` (first match per role); switched to the guard's own `resolveNodeOverrideLanes` (`columnsWithFlag`, every match), now re-exported from `@fusion/core`.
