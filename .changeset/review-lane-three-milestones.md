---
"@runfusion/fusion": minor
---

summary: Coding (Ideas) V2 review lane is now Code Review, Documentation, then merge.
category: feature
dev: Removes the separate deterministic `verification` optional group and the `completion-summary` node from `builtin:coding-ideas-v2`. Code Review runs lint/test/build itself via an appended prompt section (the shared reviewer prompt is untouched, so `builtin:coding` and `builtin:coding-ideas` keep their reviewer) and must quote command output as verdict evidence. Documentation moves after the review, becomes `gateMode: "advisory"` and `toolMode: "readonly"`, no longer writes repository files, and absorbs the card summary via `fn_task_done(summary=...)`. Repository documentation is the executor's judgement during implementation, where it is reviewed with the code it documents. Net effect: two fewer model calls per card and one blocking gate instead of four.
