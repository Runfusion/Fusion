---
"@runfusion/fusion": minor
---

summary: Planner oversight now requires confirmation before merge/PR actions and destructive/external side effects.
category: feature
dev: Adds `PlannerActionSideEffectClass` + `PlannerConfirmationRequest` and `classifyPlannerActionSideEffect`/`requiresPlannerConfirmation` (core), extends `decidePlannerRecovery` with an `await_confirmation` action, and adds `requestConfirmation`/`resolveConfirmation` gating to `PlannerRecoveryController` (engine). Merge/PR and destructive/external actions never execute without a recorded approval; bounded recovery (guidance/retry/targeted-fix) is unchanged. UX rendering, human-control safeguards, timeline, and run-audit land in follow-up tasks.
