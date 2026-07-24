---
"@runfusion/fusion": patch
---

summary: Refining a plan with no active question now generates a fresh question instead of erroring.
category: fix
dev: submitResponse no longer throws "No active question in session" — refine/comments fall back to a rebuilt running summary and a new question-regeneration reprompt (`formatQuestionRegenerationForAgent`) continues the interview; the Planning modal forwards no-question submissions instead of dead-ending locally.
