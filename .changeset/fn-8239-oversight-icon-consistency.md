---
"@runfusion/fusion": patch
---

summary: The board card overseer eye icon now hides when a task's oversight is off, matching the task detail.
category: fix
dev: TaskCard gates the planner-overseer Eye badge AND the card-header-badges wrapper predicate on the freshly-resolved effectiveOversightLevel (not just the transient snapshot's stale oversightLevel) via a shared showPlannerOverseerStateBadge boolean, so a stale non-off snapshot can no longer show an oversight icon or leave an empty header-badge shell while the Task Detail reads off.
