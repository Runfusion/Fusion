---
"@runfusion/fusion": patch
---

summary: Fix engine restarts stranding replan-loop tasks in To Do by clearing their needs-replan signal.
category: fix
dev: The KTD-8 legacy-adoption table now maps `needs-replan` to `preserve` instead of `resume-graph`; it is a live graph signal written by the plan-replan seam and consumed by triage todo-rediscovery, not un-migrated legacy state.
