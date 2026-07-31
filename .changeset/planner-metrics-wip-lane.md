---
"@runfusion/fusion": patch
---

summary: Fix frozen active-runtime metrics for tasks on boards with a renamed execution column.
category: fix
dev: `formatTaskPlannerChatMetrics` gained a `wipColumns` option and `chat.ts`'s `fn_task_planner_get_task_metrics` tool resolves it from the task's own workflow via `wipColumnsForTask`. Previously `activeRuntimeMs` added the live tail since `executionStartedAt` only when `task.column === "in-progress"`, so on a renamed board it reported whatever `cumulativeActiveMs` held from the last completed segment. `createTaskPlannerMetricsTool` is exported so the resolver side of the seam is testable.
