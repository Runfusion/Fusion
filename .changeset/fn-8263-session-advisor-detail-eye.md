---
"@runfusion/fusion": patch
---

summary: The task-detail oversight eye icon now reflects the session advisor's on/off state even when planner oversight is off.
category: fix
dev: TaskDetailModal surfaces and lights the detail-oversight-menu-trigger Eye whenever effectiveSessionAdvisorEnabled (resolveTaskSessionAdvisorEnabled: task override / project sessionAdvisorEnabledByDefault / workflow plannerOverseerAdvisorEnabled) is true, independent of the lifecycle oversight level, and repaints on toggle at both breakpoints.
