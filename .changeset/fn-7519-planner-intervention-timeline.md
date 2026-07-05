---
"@runfusion/fusion": minor
---

summary: Add a task-detail planner-overseer intervention timeline (stage, reason, action, outcome, attempts, links).
category: feature
dev: New core `PlannerInterventionEntry` model + `recordPlannerIntervention`/`getPlannerInterventionTimeline` helpers persisting via the run-audit store under the `overseer:intervention` mutation, plus a `PlannerInterventionTimeline` component rendered in the task-detail Planner Oversight cluster. Emission call-sites land in FN-7520.
