---
"@runfusion/fusion": patch
---

Fix dashboard step progress not advancing during task execution. Two bugs: (1) `fn_task_update` regressed in commit 491097cd6 (FN-3026) to a 1-indexed `step - 1` even though its parameter description and `fn_review_step` both use 0-indexed step numbers, so updates landed on the wrong step and `codeReviewVerdicts`/`stepCheckpoints` keys mismatched between the two tools. (2) Some agent runtimes (notably permanent-agent CEO sessions on the openai-codex transport) skip the bookkeeping `fn_task_update` call entirely, leaving the board stuck at `currentStep: 0`. `fn_review_step` now flips the step to `in-progress` on entry and to `done` on code-review `APPROVE`, so progress reflects real work without depending on the agent's follow-up call.
