---
"@runfusion/fusion": patch
---

summary: A refused spec write now says who refused it, instead of telling the planner to retry the board.
category: fix
dev: `fn_task_prompt_write` returns `PLAN_PROMPT_WRITE_REFUSED` with the reason (`planning-reset-fenced`, `invalid-step-headings`, `prompt-read-back-mismatch`) instead of `STORE_UNAVAILABLE` + retry guidance, reports each refusal to the owning planning attempt, and the unchanged-spec failure sentence names the writer when a refusal happened. Cards stuck on `STUCK_LOOP_EXHAUSTED` that were blocked by their own spec-write guard are now distinguishable from planners that produced no plan.
