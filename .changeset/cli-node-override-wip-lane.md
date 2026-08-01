---
"@runfusion/fusion": patch
---

summary: Fix the node-override guard not blocking mid-flight changes on boards with a renamed WIP lane.
category: fix
dev: `fn_task_update` called `validateNodeOverrideChange` without options, so `wipColumns` fell back to the literal `{"in-progress"}` and the running-task check never fired on a renamed board. It now resolves the task's own WIP and COMPLETE lanes via `resolveTaskLifecycleColumns`.
