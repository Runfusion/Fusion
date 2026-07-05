---
"@runfusion/fusion": minor
---

summary: Emit planner-overseer run-audit events for observations, steering, retries, recovery, confirmations, and escalations.
category: feature
dev: New core emitters (emitOverseerObservation/Steering/RecoveryAttempt/Retry/Confirmation/Escalation) in planner-overseer-events.ts, each mapping its decision-point to the correct intervention action/outcome and delegating to FN-7519's recordPlannerIntervention under the overseer:intervention mutation. Producer call-sites land in FN-7511/FN-7512/FN-7513.
