---
"@runfusion/fusion": patch
---

summary: Planning, mission, milestone, and onboarding interviews regenerate a question instead of "No active question" errors.
category: fix
dev: submitResponse no longer throws "No active question in session" — refine/comments fall back to a rebuilt running summary and a question-regeneration reprompt continues the interview. Mission/milestone/onboarding interviews mirror the same recovery for live sessions (completed sessions still reject); the Planning modal forwards no-question submissions instead of dead-ending locally.
