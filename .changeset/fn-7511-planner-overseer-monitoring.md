---
"@runfusion/fusion": minor
---

summary: Planner oversight now monitors tasks across executor, reviewer, merger, pull-request, and workflow-gate stages.
category: feature
dev: Adds records-only PlannerOverseerMonitor + resolveWatchedStage + OverseerStageObservation in @fusion/engine, gated by resolveEffectivePlannerOversightLevel (off = no observation) and wired into ProjectEngine via a bounded poll. Steering/recovery and UI land in FN-7512/FN-7515+.
