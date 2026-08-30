---
"@runfusion/fusion": minor
---

summary: Remove the per-task manual plan-approval toggle and shield badges.
category: breaking
dev: Removes Task.requirePlanApproval and create/update API acceptance; resolvePlanApprovalRequired now takes settings only. The project.tasks.require_plan_approval column and migration 0070 remain preserved and inert.
